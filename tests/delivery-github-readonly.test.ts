import { describe, expect, it, vi } from 'vitest';
import {
  listAllGitHubPullRequests,
  parseGitHubPullRequest,
} from '../src/server/delivery-github-readonly.js';

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const repo = { full_name: 'vlovers/ai-office' };
const candidate = {
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, repo },
  base: { ref: 'main', repo },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('read-only GitHub PR discovery', () => {
  it('reads every page of open and closed PRs from the exact approved repository', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      expect(url).toContain('https://api.github.com/repos/vlovers/ai-office/pulls?');
      const parsed = new URL(url);
      expect(parsed.searchParams.get('state')).toBe('all');
      expect(parsed.searchParams.get('per_page')).toBe('2');
      const page = Number(parsed.searchParams.get('page'));
      return page === 1
        ? json([
            candidate,
            { ...candidate, html_url: 'https://github.com/vlovers/ai-office/pull/124' },
          ])
        : json([{ ...candidate, state: 'closed' }]);
    });
    const result = await listAllGitHubPullRequests(plan, { fetcher, perPage: 2 });
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[2]?.state).toBe('closed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses only server-provided credentials and does not include them in errors', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer server-secret');
      return json({ message: 'server-secret' }, 403);
    });
    await expect(
      listAllGitHubPullRequests(plan, { fetcher, token: 'server-secret' }),
    ).rejects.toThrow('HTTP 403');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects missing repository identities rather than guessing them', () => {
    expect(() =>
      parseGitHubPullRequest({
        ...candidate,
        head: { ref: plan.branch },
      }),
    ).toThrow('branch identity');
    expect(() =>
      parseGitHubPullRequest({
        ...candidate,
        head: { ref: plan.branch, repo: { full_name: 42 } },
      }),
    ).toThrow('repository identity');
  });

  it('rejects malformed and truncated responses without returning partial results', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const page = new URL(url).searchParams.get('page');
      return page === '1' ? json([candidate, candidate]) : json({ incomplete: true });
    });
    await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 2 })).rejects.toThrow(
      'Invalid GitHub PR listing page',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses partial HTTP 206 responses even when the body looks valid', async () => {
    const fetcher = vi.fn(async () => json([candidate], 206));
    await expect(listAllGitHubPullRequests(plan, { fetcher })).rejects.toThrow('HTTP 206');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects redirects to an unexpected endpoint', async () => {
    const fetcher = vi.fn(async () => {
      const response = json([candidate]);
      Object.defineProperty(response, 'url', { value: 'https://attacker.invalid/pulls' });
      return response;
    });
    await expect(listAllGitHubPullRequests(plan, { fetcher })).rejects.toThrow('redirected');
  });

  it('rejects a listing that cannot be exhausted within the page limit', async () => {
    const fetcher = vi.fn(async () => json([candidate]));
    await expect(
      listAllGitHubPullRequests(plan, { fetcher, perPage: 1, maxPages: 2 }),
    ).rejects.toThrow('safe pagination limit');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('follows an explicit next Link even when GitHub returns a short page', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) {
        const next = new URL(url);
        next.searchParams.set('page', '2');
        return new Response(JSON.stringify([candidate]), {
          status: 200,
          headers: { link: '<' + next.toString() + '>; rel="next"' },
        });
      }
      return json([{ ...candidate, html_url: 'https://github.com/vlovers/ai-office/pull/124' }]);
    });
    const result = await listAllGitHubPullRequests(plan, { fetcher, perPage: 5 });
    expect(result.candidates).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['cross-origin', 'https://attacker.invalid/pulls?page=2'],
    [
      'skipped page',
      'https://api.github.com/repos/vlovers/ai-office/pulls?state=all&per_page=5&page=3',
    ],
    [
      'different repository',
      'https://api.github.com/repos/foreign/repo/pulls?state=all&per_page=5&page=2',
    ],
  ])('rejects a malicious pagination next link: %s', async (_label, next) => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify([candidate]), {
          status: 200,
          headers: { link: '<' + next + '>; rel="next"' },
        }),
    );
    await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 5 })).rejects.toThrow(
      'pagination',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('fails closed when a short first page links to a rate-limited second page', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get('page') === '2') {
        return json({ message: 'rate limited' }, 429);
      }
      const next = new URL(url);
      next.searchParams.set('page', '2');
      return new Response(JSON.stringify([candidate]), {
        status: 200,
        headers: { link: '<' + next.toString() + '>; rel="next"' },
      });
    });
    await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 5 })).rejects.toThrow(
      'HTTP 429',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects untrusted destinations before any request', async () => {
    const fetcher = vi.fn();
    await expect(
      listAllGitHubPullRequests({ ...plan, destination: 'https://evil.invalid/repo' }, { fetcher }),
    ).rejects.toThrow('Untrusted');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid page sizes and credentials before any request', async () => {
    const fetcher = vi.fn();
    await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 101 })).rejects.toThrow(
      'page size',
    );
    await expect(
      listAllGitHubPullRequests(plan, { fetcher, token: 'bad\ncredential' }),
    ).rejects.toThrow('credential');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
