import { describe, expect, it, vi } from 'vitest';
import { collectRemotePullRequests } from '../src/server/delivery-publication-pagination.js';

const candidate = {
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: {
    ref: 'ai-office/12345678-1234-1234-1234-123456789abc',
    repo: { full_name: 'vlovers/ai-office' },
  },
  base: { ref: 'main', repo: { full_name: 'vlovers/ai-office' } },
};

describe('complete read-only GitHub PR pagination', () => {
  it('collects all pages before marking a listing complete', async () => {
    const fetchPage = vi.fn(async (page: number) =>
      page === 1
        ? { candidates: [candidate], nextPage: 2 }
        : {
            candidates: [
              {
                ...candidate,
                html_url: 'https://github.com/vlovers/ai-office/pull/124',
                state: 'closed',
              },
            ],
            nextPage: null,
          },
    );
    const result = await collectRemotePullRequests(fetchPage);
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('verifies stable multi-page PR identities in a second complete traversal', async () => {
    const fetchPage = vi.fn(async (page: number) =>
      page === 1
        ? { candidates: [candidate], nextPage: 2 }
        : {
            candidates: [
              { ...candidate, html_url: 'https://github.com/vlovers/ai-office/pull/124' },
            ],
            nextPage: null,
          },
    );
    const result = await collectRemotePullRequests(fetchPage, 100, true);
    expect(result.candidates).toHaveLength(2);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 2, 1, 2]);
  });

  it('refuses a page shift without any duplicate within either traversal', async () => {
    let pass = 0;
    const fetchPage = vi.fn(async (page: number) => {
      if (page === 1) pass += 1;
      return page === 1
        ? {
            candidates: [
              {
                ...candidate,
                html_url: `https://github.com/vlovers/ai-office/pull/${pass === 1 ? 123 : 125}`,
              },
            ],
            nextPage: 2,
          }
        : {
            candidates: [
              { ...candidate, html_url: 'https://github.com/vlovers/ai-office/pull/124' },
            ],
            nextPage: null,
          };
    });
    await expect(collectRemotePullRequests(fetchPage, 100, true)).rejects.toThrow(
      'pagination changed during inventory',
    );
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it('detects an injected adapter mutating first-pass evidence during verification', async () => {
    const mutable = { ...candidate };
    let pass = 0;
    const fetchPage = vi.fn(async (page: number) => {
      if (page === 1) {
        pass += 1;
        if (pass === 2) {
          mutable.html_url = 'https://github.com/vlovers/ai-office/pull/125';
        }
        return { candidates: [mutable], nextPage: 2 };
      }
      return {
        candidates: [{ ...candidate, html_url: 'https://github.com/vlovers/ai-office/pull/124' }],
        nextPage: null,
      };
    });
    await expect(collectRemotePullRequests(fetchPage, 100, true)).rejects.toThrow(
      'pagination changed during inventory',
    );
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it('does not return a first-pass inventory when the verification traversal fails', async () => {
    let firstPageReads = 0;
    const fetchPage = vi.fn(async (page: number) => {
      if (page === 1) {
        firstPageReads += 1;
        if (firstPageReads === 2) throw new Error('GitHub HTTP 429');
        return { candidates: [candidate], nextPage: 2 };
      }
      return { candidates: [], nextPage: null };
    });
    await expect(collectRemotePullRequests(fetchPage, 100, true)).rejects.toThrow(
      'GitHub HTTP 429',
    );
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 2, 1]);
  });

  it('rejects repeated PR URLs even if their state changes between pages', async () => {
    const fetchPage = vi.fn(async (page: number) =>
      page === 1
        ? { candidates: [candidate], nextPage: 2 }
        : { candidates: [{ ...candidate, state: 'closed' }], nextPage: null },
    );
    await expect(collectRemotePullRequests(fetchPage)).rejects.toThrow(
      'duplicate or invalid PR identity',
    );
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('does not return a partial listing after a remote error', async () => {
    const fetchPage = vi.fn(async (page: number) => {
      if (page === 2) throw new Error('rate limited');
      return { candidates: [candidate], nextPage: 2 };
    });
    await expect(collectRemotePullRequests(fetchPage)).rejects.toThrow('rate limited');
  });

  it('refuses pagination cycles and non-forward progress', async () => {
    await expect(
      collectRemotePullRequests(async () => ({
        candidates: [candidate],
        nextPage: 1,
      })),
    ).rejects.toThrow('invalid next page');
  });

  it('rejects a skipped page rather than declaring a truncated listing complete', async () => {
    const fetchPage = vi.fn(async () => ({ candidates: [candidate], nextPage: 3 }));
    await expect(collectRemotePullRequests(fetchPage)).rejects.toThrow('invalid next page');
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('refuses a listing that exceeds the configured safe page limit', async () => {
    await expect(
      collectRemotePullRequests(
        async (page) => ({
          candidates: [
            {
              ...candidate,
              html_url: `https://github.com/vlovers/ai-office/pull/${page + 122}`,
            },
          ],
          nextPage: page + 1,
        }),
        2,
      ),
    ).rejects.toThrow('safe pagination limit');
  });

  it('refuses malformed remote responses', async () => {
    await expect(
      collectRemotePullRequests(
        async () =>
          ({
            candidates: null,
            nextPage: null,
          }) as never,
      ),
    ).rejects.toThrow('invalid page');
  });

  it('refuses invalid pagination bounds before contacting GitHub', async () => {
    const fetchPage = vi.fn();
    await expect(collectRemotePullRequests(fetchPage, 0)).rejects.toThrow('limit');
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
