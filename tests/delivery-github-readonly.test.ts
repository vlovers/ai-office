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
      const closed = {
        ...candidate,
        state: 'closed',
        html_url: 'https://github.com/vlovers/ai-office/pull/125',
      };
      return page === 1
        ? json([
            candidate,
            { ...candidate, html_url: 'https://github.com/vlovers/ai-office/pull/124' },
          ])
        : json([closed]);
    });
    const result = await listAllGitHubPullRequests(plan, { fetcher, perPage: 2 });
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[2]?.state).toBe('closed');
    expect(fetcher).toHaveBeenCalledTimes(4);
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

  it.each([
    ['mismatched PR number', { ...candidate, number: 124 }],
    ['string PR number', { ...candidate, number: '123' }],
    ['zero PR number', { ...candidate, number: 0 }],
    [
      'noncanonical numeric alias',
      { ...candidate, number: 123, html_url: 'https://github.com/vlovers/ai-office/pull/0123' },
    ],
  ])('rejects inconsistent listing identity: %s', async (_label, malformed) => {
    const fetcher = vi.fn(async () => json([malformed]));
    await expect(listAllGitHubPullRequests(plan, { fetcher })).rejects.toThrow(
      'Invalid GitHub PR number or URL identity',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts a canonical PR number matching its URL in a complete inventory', async () => {
    const fetcher = vi.fn(async () => json([{ ...candidate, number: 123 }]));
    const result = await listAllGitHubPullRequests(plan, { fetcher });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.html_url).toBe(candidate.html_url);
  });

  it('rejects malformed and truncated responses without returning partial results', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const page = new URL(url).searchParams.get('page');
      const unrelated = {
        ...candidate,
        html_url: 'https://github.com/vlovers/ai-office/pull/124',
      };
      return page === '1' ? json([candidate, unrelated]) : json({ incomplete: true });
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
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      const item = {
        ...candidate,
        html_url: `https://github.com/vlovers/ai-office/pull/${page + 122}`,
      };
      return json([item]);
    });
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
    expect(fetcher).toHaveBeenCalledTimes(4);
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

  it('honors consistent next/last and first/prev/last links across pages', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const current = new URL(url);
      const page = Number(current.searchParams.get('page'));
      const linked = (targetPage: number, relation: string) => {
        const target = new URL(url);
        target.searchParams.set('page', String(targetPage));
        return `<${target.toString()}>; rel="${relation}"`;
      };
      const second = {
        ...candidate,
        html_url: 'https://github.com/vlovers/ai-office/pull/124',
      };
      return new Response(JSON.stringify([page === 1 ? candidate : second]), {
        status: 200,
        headers: {
          link:
            page === 1
              ? [linked(2, 'next'), linked(2, 'last')].join(', ')
              : [linked(1, 'first'), linked(1, 'prev'), linked(2, 'last')].join(', '),
        },
      });
    });
    const result = await listAllGitHubPullRequests(plan, { fetcher, perPage: 5 });
    expect(result.candidates).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects a last-page hint beyond the current page without a next link', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const last = new URL(url);
      last.searchParams.set('page', '3');
      return new Response(JSON.stringify([candidate]), {
        status: 200,
        headers: { link: `<${last.toString()}>; rel="last"` },
      });
    });
    await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 5 })).rejects.toThrow(
      'pagination Link header is incomplete',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects duplicate pagination relations even when the links agree', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const next = new URL(url);
      next.searchParams.set('page', '2');
      const item = `<${next.toString()}>; rel="next"`;
      return new Response(JSON.stringify([candidate]), {
        status: 200,
        headers: { link: [item, item].join(', ') },
      });
    });
    await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 5 })).rejects.toThrow(
      'Duplicate GitHub PR pagination relation',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects inconsistent first, previous and last pagination relations', async () => {
    for (const [relation, targetPage] of [
      ['first', 2],
      ['prev', 3],
      ['last', 0],
    ] as const) {
      const fetcher = vi.fn(async (url: string) => {
        const target = new URL(url);
        target.searchParams.set('page', String(targetPage));
        return new Response(JSON.stringify([candidate]), {
          status: 200,
          headers: { link: `<${target.toString()}>; rel="${relation}"` },
        });
      });
      await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 5 })).rejects.toThrow(
        'inconsistent page',
      );
      expect(fetcher).toHaveBeenCalledOnce();
    }
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

  it('bounds a stalled GitHub listing body without returning partial inventory', async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        new ReadableStream({
          pull: () => new Promise<void>(() => undefined),
        }),
        { status: 200 },
      );
    });
    await expect(listAllGitHubPullRequests(plan, { fetcher, timeoutMs: 100 })).rejects.toThrow(
      'GitHub request timed out',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('bounds the entire paginated inventory rather than renewing the timeout per page', async () => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) {
        elapsed = 90;
        return json([candidate]);
      }
      elapsed = 150;
      return json([]);
    });
    try {
      await expect(
        listAllGitHubPullRequests(plan, {
          fetcher,
          perPage: 1,
          inventoryDeadlineMs: 200,
        }),
      ).rejects.toThrow('inventory deadline exceeded');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('returns complete multi-page inventory while the total budget remains valid', async () => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      elapsed += 20;
      return json(page === 1 ? [candidate] : []);
    });
    try {
      const result = await listAllGitHubPullRequests(plan, {
        fetcher,
        perPage: 1,
        inventoryDeadlineMs: 200,
      });
      expect(result.complete).toBe(true);
      expect(result.candidates).toEqual([candidate]);
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects a shifted multi-page inventory even when each pass has no duplicate URL', async () => {
    let firstPageReads = 0;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) {
        firstPageReads += 1;
        return json([
          firstPageReads === 1
            ? candidate
            : { ...candidate, html_url: 'https://github.com/vlovers/ai-office/pull/124' },
        ]);
      }
      return json([]);
    });
    await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 1 })).rejects.toThrow(
      'pagination changed during inventory',
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
  });

  it('rejects a changed PR state between pagination passes', async () => {
    let firstPageReads = 0;
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) {
        firstPageReads += 1;
        return json([{ ...candidate, state: firstPageReads === 1 ? 'open' : 'closed' }]);
      }
      return json([]);
    });
    await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 1 })).rejects.toThrow(
      'pagination changed during inventory',
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('fails closed on a rate limit during the second inventory pass', async () => {
    let firstPageReads = 0;
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) {
        firstPageReads += 1;
        if (firstPageReads === 2) return json({ message: 'rate limit' }, 429);
        return json([candidate]);
      }
      return json([]);
    });
    await expect(listAllGitHubPullRequests(plan, { fetcher, perPage: 1 })).rejects.toThrow(
      'HTTP 429',
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not renew the total deadline for the pagination verification pass', async () => {
    let elapsed = 0;
    let firstPageReads = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) {
        firstPageReads += 1;
        elapsed = firstPageReads === 1 ? 20 : 180;
        return json([candidate]);
      }
      elapsed = firstPageReads === 1 ? 100 : 205;
      return json([]);
    });
    try {
      await expect(
        listAllGitHubPullRequests(plan, {
          fetcher,
          perPage: 1,
          inventoryDeadlineMs: 200,
        }),
      ).rejects.toThrow('inventory deadline exceeded');
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects invalid total inventory deadlines before contacting GitHub', async () => {
    const fetcher = vi.fn();
    for (const inventoryDeadlineMs of [0, 99, 60_001, -1, 1.5, Number.NaN, Infinity]) {
      await expect(
        listAllGitHubPullRequests(plan, { fetcher, inventoryDeadlineMs }),
      ).rejects.toThrow('Invalid GitHub PR inventory deadline');
    }
    expect(fetcher).not.toHaveBeenCalled();
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
