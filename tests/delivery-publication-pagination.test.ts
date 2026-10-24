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
        : { candidates: [{ ...candidate, state: 'closed' }], nextPage: null },
    );
    const result = await collectRemotePullRequests(fetchPage);
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(2);
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
        async (page) => ({ candidates: [candidate], nextPage: page + 1 }),
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
