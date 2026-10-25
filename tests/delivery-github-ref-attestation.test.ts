import { describe, expect, it, vi } from 'vitest';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import {
  attestGitHubCommitRefs,
  readGitHubDraftCommitReceipt,
  validateAttestedDraftReceipt,
  type ApprovedCommitSnapshot,
} from '../src/server/delivery-github-ref-attestation.js';

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const headCommitSha = '1'.repeat(40);
const baseCommitSha = '2'.repeat(40);
const approval: ApprovedCommitSnapshot = {
  operationKey: publicationKey(plan),
  headCommitSha,
  baseCommitSha,
};
const repo = { full_name: 'vlovers/ai-office' };
const receipt = {
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  state: 'open',
  draft: true,
  head: { ref: plan.branch, sha: headCommitSha, repo },
  base: { ref: 'main', sha: baseCommitSha, repo },
};

function refBody(branch: string, sha: string) {
  return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockRefs(
  head: unknown = refBody(plan.branch, headCommitSha),
  base: unknown = refBody(plan.baseBranch, baseCommitSha),
) {
  const fetcher = vi.fn(async (input: string, init: RequestInit) => {
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(input).toMatch(
      /^https:\/\/api\.github\.com\/repos\/vlovers\/ai-office\/git\/ref\/heads\//,
    );
    if (input.endsWith('/main')) return jsonResponse(base);
    return jsonResponse(head);
  });
  return fetcher;
}

describe('GitHub immutable ref attestation', () => {
  it('verifies both reviewed remote commit SHAs with GET-only requests', async () => {
    const fetcher = mockRefs();
    const attestation = await attestGitHubCommitRefs(plan, approval, {
      fetcher,
      token: 'server-owned-token',
    });
    expect(attestation).toEqual({
      ...approval,
      repository: 'vlovers/ai-office',
      branch: plan.branch,
      baseBranch: 'main',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1].headers).toMatchObject({
      Authorization: 'Bearer server-owned-token',
    });
    expect(validateAttestedDraftReceipt(plan, attestation, receipt)).toBe(receipt.html_url);
  });

  it('blocks stale head before reading the base ref', async () => {
    const fetcher = mockRefs(refBody(plan.branch, '3'.repeat(40)));
    await expect(attestGitHubCommitRefs(plan, approval, { fetcher })).rejects.toThrow(
      'head branch moved',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('blocks stale base after reading both refs', async () => {
    const fetcher = mockRefs(undefined, refBody('main', '4'.repeat(40)));
    await expect(attestGitHubCommitRefs(plan, approval, { fetcher })).rejects.toThrow(
      'base branch moved',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong branch ref', refBody('other', headCommitSha)],
    [
      'tag object',
      { ref: `refs/heads/${plan.branch}`, object: { type: 'tag', sha: headCommitSha } },
    ],
    ['missing object', { ref: `refs/heads/${plan.branch}` }],
    ['invalid SHA', refBody(plan.branch, 'not-a-commit')],
    ['array payload', []],
    ['null payload', null],
  ])('rejects malformed GitHub ref evidence: %s', async (_label, body) => {
    const fetcher = mockRefs(body);
    await expect(attestGitHubCommitRefs(plan, approval, { fetcher })).rejects.toThrow(
      'Invalid GitHub commit ref response',
    );
  });

  it.each([401, 403, 404, 429, 500])('blocks GitHub API status %i', async (status) => {
    const fetcher = vi.fn(async () => jsonResponse({ message: 'unavailable' }, status));
    await expect(attestGitHubCommitRefs(plan, approval, { fetcher })).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects redirects and refuses to follow untrusted URLs', async () => {
    const fetcher = vi.fn(async () => {
      const response = jsonResponse(refBody(plan.branch, headCommitSha));
      Object.defineProperty(response, 'url', { value: 'https://evil.example/refs' });
      return response;
    });
    await expect(attestGitHubCommitRefs(plan, approval, { fetcher })).rejects.toThrow('redirected');
  });

  it('blocks an unapproved operation before any remote read', async () => {
    const fetcher = mockRefs();
    await expect(
      attestGitHubCommitRefs(plan, { ...approval, operationKey: 'stale' }, { fetcher }),
    ).rejects.toThrow('does not match');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed SHA, mixed hash algorithms and invalid credentials', async () => {
    const fetcher = mockRefs();
    for (const bad of [
      { ...approval, headCommitSha: 'not-a-sha' },
      { ...approval, baseCommitSha: '2'.repeat(64) },
    ]) {
      await expect(attestGitHubCommitRefs(plan, bad, { fetcher })).rejects.toThrow(
        'Invalid approved Git commit SHA',
      );
    }
    await expect(
      attestGitHubCommitRefs(plan, approval, { fetcher, token: 'has spaces' }),
    ).rejects.toThrow('Invalid server-side GitHub credential');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks disabled plans and noncanonical destinations without GET requests', async () => {
    const fetcher = mockRefs();
    await expect(
      attestGitHubCommitRefs({ allowed: false, reason: 'stale' }, approval, { fetcher }),
    ).rejects.toThrow('blocked');
    const spoofed = { ...plan, destination: 'https://github.com/owner/repo?redirect=1' };
    await expect(
      attestGitHubCommitRefs(
        spoofed,
        { ...approval, operationKey: publicationKey(spoofed) },
        { fetcher },
      ),
    ).rejects.toThrow('Untrusted GitHub commit attestation destination');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a PR whose remote head/base commit changed after attestation', async () => {
    const attestation = await attestGitHubCommitRefs(plan, approval, { fetcher: mockRefs() });
    for (const changed of [
      { ...receipt, head: { ...receipt.head, sha: '3'.repeat(40) } },
      { ...receipt, base: { ...receipt.base, sha: '4'.repeat(40) } },
    ]) {
      expect(() => validateAttestedDraftReceipt(plan, attestation, changed)).toThrow(
        'commit identity changed',
      );
    }
  });

  it('rejects a foreign, non-draft, closed or noncanonical PR after attestation', async () => {
    const attestation = await attestGitHubCommitRefs(plan, approval, { fetcher: mockRefs() });
    for (const changed of [
      { ...receipt, draft: false },
      { ...receipt, state: 'closed' },
      { ...receipt, html_url: 'https://github.com/attacker/repo/pull/123' },
      { ...receipt, head: { ...receipt.head, repo: { full_name: 'attacker/fork' } } },
    ]) {
      expect(() => validateAttestedDraftReceipt(plan, attestation, changed)).toThrow();
    }
  });
  it('reads an exact PR detail with SHA, number, branch and repository verification', async () => {
    const fetcher = vi.fn(async (input: string, init: RequestInit) => {
      expect(input).toBe('https://api.github.com/repos/vlovers/ai-office/pulls/123');
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      return jsonResponse({ ...receipt, number: 123 });
    });
    const detail = await readGitHubDraftCommitReceipt(plan, receipt.html_url, { fetcher });
    expect(detail.head.sha).toBe(headCommitSha);
    expect(detail.base.sha).toBe(baseCommitSha);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing head SHA', { ...receipt, number: 123, head: { ref: plan.branch, repo } }],
    ['wrong PR number', { ...receipt, number: 124 }],
    [
      'wrong repository',
      { ...receipt, number: 123, base: { ...receipt.base, repo: { full_name: 'other/repo' } } },
    ],
    ['closed PR', { ...receipt, number: 123, state: 'closed' }],
    ['non-draft PR', { ...receipt, number: 123, draft: false }],
    ['invalid SHA', { ...receipt, number: 123, head: { ...receipt.head, sha: 'bad' } }],
  ])('rejects untrusted PR detail evidence: %s', async (_label, detail) => {
    const fetcher = vi.fn(async () => jsonResponse(detail));
    await expect(
      readGitHubDraftCommitReceipt(plan, receipt.html_url, { fetcher }),
    ).rejects.toThrow();
  });

  it.each([401, 403, 404, 429, 500])('blocks PR detail HTTP %i', async (status) => {
    const fetcher = vi.fn(async () => jsonResponse({ message: 'unavailable' }, status));
    await expect(readGitHubDraftCommitReceipt(plan, receipt.html_url, { fetcher })).rejects.toThrow(
      `HTTP ${status}`,
    );
  });

  it('rejects untrusted PR detail URLs and credentials before any GET', async () => {
    const fetcher = vi.fn();
    await expect(
      readGitHubDraftCommitReceipt(plan, 'https://github.com/attacker/repo/pull/123', {
        fetcher,
      }),
    ).rejects.toThrow('Untrusted');
    await expect(
      readGitHubDraftCommitReceipt(plan, receipt.html_url + '?redirect=1', { fetcher }),
    ).rejects.toThrow('Untrusted');
    await expect(
      readGitHubDraftCommitReceipt(plan, receipt.html_url, { fetcher, token: 'bad token' }),
    ).rejects.toThrow('Invalid server-side');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed on a stalled GitHub ref request before reading the base', async () => {
    const fetcher = vi.fn(async () => new Promise<Response>(() => undefined));
    await expect(
      attestGitHubCommitRefs(plan, approval, { fetcher, timeoutMs: 100 }),
    ).rejects.toThrow('GitHub request timed out');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('bounds PR detail response parsing after an ambiguous publication', async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        new ReadableStream({
          pull: () => new Promise<void>(() => undefined),
        }),
        { status: 200 },
      );
    });
    await expect(
      readGitHubDraftCommitReceipt(plan, receipt.html_url, { fetcher, timeoutMs: 100 }),
    ).rejects.toThrow('GitHub request timed out');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects redirected PR detail requests', async () => {
    const fetcher = vi.fn(async () => {
      const response = jsonResponse({ ...receipt, number: 123 });
      Object.defineProperty(response, 'url', { value: 'https://evil.example/pull/123' });
      return response;
    });
    await expect(readGitHubDraftCommitReceipt(plan, receipt.html_url, { fetcher })).rejects.toThrow(
      'redirected',
    );
  });
});
