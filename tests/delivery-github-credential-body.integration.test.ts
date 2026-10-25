import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DeliveryGitHubCredentials,
  type DeliveryReadCredential,
} from '../src/server/delivery-github-credentials.js';
import { GITHUB_JSON_LIMITS } from '../src/server/delivery-github-json-boundary.js';
import { listAllGitHubPullRequests } from '../src/server/delivery-github-readonly.js';

const repository = 'vlovers/ai-office';
const token = `github_pat_TEST_${'A'.repeat(25)}`;
const prefix = `https://api.github.com/repos/${repository}`;
const refUrl = `${prefix}/git/ref/heads/main`;
const listUrl = `${prefix}/pulls?state=all&per_page=100&page=1`;
const detailUrl = `${prefix}/pulls/123`;

function credential(): DeliveryReadCredential {
  return {
    id: 'body-test-version',
    token,
    repository,
    expiresAt: 60_000,
    permissions: { contents: 'read', pullRequests: 'read' },
  };
}

async function request(
  url: string,
  transport: (url: string, init: RequestInit) => Promise<Response>,
): Promise<Response> {
  const db = new DatabaseSync(':memory:');
  try {
    const manager = new DeliveryGitHubCredentials(
      db,
      async () => credential(),
      transport,
      () => 1000,
    );
    return await manager.readOnlyFetcher(repository, ['main'])(url, { method: 'GET' });
  } finally {
    db.close();
  }
}

function oversizedStream(size: number, cancel?: () => Promise<void>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(size));
      },
      cancel,
    }),
  );
}

describe('credential-scoped GitHub response boundary', () => {
  it('accepts complete PR listings larger than 1 MiB', async () => {
    const payload = [{ description: 'x'.repeat(1_200_000) }];
    const response = await request(listUrl, async () => Response.json(payload));
    expect(await response.json()).toEqual(payload);
  });

  it('validates a large authenticated PR inventory end to end', async () => {
    const plan = {
      allowed: true as const,
      destination: `https://github.com/${repository}`,
      branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
      baseBranch: 'main',
      revision: 'a'.repeat(64),
      draft: true as const,
    };
    const candidate = {
      html_url: `https://github.com/${repository}/pull/123`,
      draft: true,
      state: 'open',
      head: { ref: plan.branch, repo: { full_name: repository } },
      base: { ref: 'main', repo: { full_name: repository } },
      description: 'x'.repeat(1_200_000),
    };
    const db = new DatabaseSync(':memory:');
    try {
      const manager = new DeliveryGitHubCredentials(
        db,
        async () => credential(),
        async () => Response.json([candidate]),
        () => 1000,
      );
      const result = await listAllGitHubPullRequests(plan, {
        fetcher: manager.readOnlyFetcher(repository, ['main', plan.branch]),
      });
      expect(result.complete).toBe(true);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.html_url).toBe(candidate.html_url);
    } finally {
      db.close();
    }
  });

  it('rejects a listing larger than 8 MiB without returning partial inventory', async () => {
    await expect(
      request(listUrl, async () => oversizedStream(GITHUB_JSON_LIMITS.listing + 1)),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('enforces the smaller 256 KiB ref limit independently of the listing limit', async () => {
    await expect(
      request(refUrl, async () => oversizedStream(GITHUB_JSON_LIMITS.refs + 1)),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('enforces the 1 MiB PR detail limit independently of the listing limit', async () => {
    await expect(
      request(detailUrl, async () => oversizedStream(GITHUB_JSON_LIMITS.detail + 1)),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('counts actual bytes even when Content-Length understates the body', async () => {
    await expect(
      request(refUrl, async () =>
        new Response('x'.repeat(GITHUB_JSON_LIMITS.refs + 1), {
          headers: { 'Content-Length': '2' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('rejects a declared oversized body without consuming it', async () => {
    const response = new Response('{}', {
      headers: { 'Content-Length': String(GITHUB_JSON_LIMITS.refs + 1) },
    });
    await expect(request(refUrl, async () => response)).rejects.toMatchObject({ statusCode: 503 });
    expect(response.bodyUsed).toBe(false);
  });

  it('rejects invalid UTF-8 without exposing remote bytes', async () => {
    await expect(
      request(refUrl, async () => new Response(new Uint8Array([0xff, 0xfe]))),
    ).rejects.toThrow('Delivery service unavailable.');
  });

  it('does not await a hostile stream cancellation after an oversized response', async () => {
    let cancelled = false;
    await expect(
      request(refUrl, async () =>
        oversizedStream(GITHUB_JSON_LIMITS.refs + 1, () => {
          cancelled = true;
          return new Promise<void>(() => undefined);
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(cancelled).toBe(true);
  });

  it('does not await a hostile stream cancellation after HTTP 429', async () => {
    let cancelled = false;
    await expect(
      request(refUrl, async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([123, 125]));
            },
            cancel() {
              cancelled = true;
              return new Promise<void>(() => undefined);
            },
          }),
          { status: 429 },
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(cancelled).toBe(true);
  });

  it('rejects credential echoes in large otherwise valid JSON without leaking them', async () => {
    let message = '';
    try {
      await request(listUrl, async () =>
        Response.json({ description: 'x'.repeat(1_200_000), credential: token }),
      );
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('Delivery service unavailable.');
    expect(message).not.toContain(token);
  });
});
