import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_JSON_LIMITS,
  readBoundedGitHubJson,
} from '../src/server/delivery-github-json-boundary.js';
import { listAllGitHubPullRequests } from '../src/server/delivery-github-readonly.js';
import {
  attestGitHubCommitRefs,
  readGitHubDraftCommitReceipt,
} from '../src/server/delivery-github-ref-attestation.js';
import { createCommitAttestedGitHubDraft } from '../src/server/delivery-github-draft-write.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const approved = {
  operationKey: publicationKey(plan),
  headCommitSha: '1'.repeat(40),
  baseCommitSha: '2'.repeat(40),
};
const attested = {
  ...approved,
  repository: 'vlovers/ai-office',
  branch: plan.branch,
  baseBranch: plan.baseBranch,
};

describe('bounded GitHub JSON response parsing', () => {
  it('accepts a valid body at the exact byte limit', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(200) });
    const result = await readBoundedGitHubJson(new Response(body), Buffer.byteLength(body));
    expect(result).toEqual({ data: 'x'.repeat(200) });
  });

  it('rejects actual oversized bodies regardless of Content-Length', async () => {
    await expect(
      readBoundedGitHubJson(new Response(JSON.stringify({ data: 'x'.repeat(300) })), 32),
    ).rejects.toThrow('safe size limit');
  });

  it('rejects declared oversize without reading the response body', async () => {
    const response = new Response('{}', { headers: { 'Content-Length': '10000000' } });
    await expect(readBoundedGitHubJson(response, 128)).rejects.toThrow('safe size limit');
    expect(response.bodyUsed).toBe(false);
  });

  it('rejects missing bodies, malformed headers and invalid limits', async () => {
    await expect(readBoundedGitHubJson(new Response('{}'), 0)).rejects.toThrow('limit');
    await expect(readBoundedGitHubJson(new Response(null), 10)).rejects.toThrow('Missing');
    await expect(
      readBoundedGitHubJson(new Response('{}', { headers: { 'Content-Length': 'oops' } }), 100),
    ).rejects.toThrow('safe size limit');
  });

  it('does not echo malformed JSON or invalid UTF-8 in errors', async () => {
    await expect(
      readBoundedGitHubJson(new Response(new Uint8Array([0xff])), 128),
    ).rejects.toThrow('Invalid GitHub JSON response body');
    let message = '';
    try {
      await readBoundedGitHubJson(new Response('{"secret":"server-secret",'), 128);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('Invalid GitHub JSON response body');
    expect(message).not.toContain('server-secret');
  });

  it('stops reading an endless stream as soon as the byte cap is crossed', async () => {
    let pulls = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(128));
        },
      }),
    );
    await expect(readBoundedGitHubJson(response, 256)).rejects.toThrow('safe size limit');
    expect(pulls).toBeLessThan(10);
  });

  it('rejects oversized listing pages without returning partial inventory', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(GITHUB_JSON_LIMITS.listing + 1)));
    await expect(listAllGitHubPullRequests(plan, { fetcher })).rejects.toThrow('safe size limit');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects oversized ref evidence before requesting the base branch', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(GITHUB_JSON_LIMITS.refs + 1)));
    await expect(attestGitHubCommitRefs(plan, approved, { fetcher })).rejects.toThrow(
      'safe size limit',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects oversized PR details during read-only reconciliation', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(GITHUB_JSON_LIMITS.detail + 1)));
    const url = 'https://github.com/vlovers/ai-office/pull/123';
    await expect(readGitHubDraftCommitReceipt(plan, url, { fetcher })).rejects.toThrow(
      'safe size limit',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects an oversized Draft POST receipt without retrying the remote write', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      return new Response('x'.repeat(GITHUB_JSON_LIMITS.draft + 1), { status: 201 });
    });
    await expect(
      createCommitAttestedGitHubDraft(plan, attested, {
        token: 'server-owned-token',
        title: 'Reviewed draft',
        confirmation: { ...approved, action: 'create-draft-pr' },
        fetcher,
      }),
    ).rejects.toThrow('safe size limit');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
