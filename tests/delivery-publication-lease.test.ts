import { describe, expect, it, vi } from 'vitest';
import { withPublicationLease } from '../src/server/delivery-publication-lease.js';

describe('publication lease entrypoint', () => {
  it('rejects blocked publication without calling refresh or publisher', async () => {
    const refresh = vi.fn();
    const publish = vi.fn();
    await expect(
      withPublicationLease(
        { path: '/unused', gitDir: '/unused/.git' },
        '/unused/worktree',
        { status: 'blocked', reason: 'Review stale' },
        refresh,
        publish,
      ),
    ).rejects.toThrow('Publication does not require a new lease.');
    expect(refresh).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects already-published state without performing Git operations', async () => {
    const publish = vi.fn();
    await expect(
      withPublicationLease(
        { path: '/unused', gitDir: '/unused/.git' },
        '/unused/worktree',
        { status: 'already-published', pullRequestUrl: 'https://github.com/a/b/pull/1' },
        vi.fn(),
        publish,
      ),
    ).rejects.toThrow('Publication does not require a new lease.');
    expect(publish).not.toHaveBeenCalled();
  });
});
