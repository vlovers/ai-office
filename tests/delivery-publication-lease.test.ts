import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withPublicationLease } from '../src/server/delivery-publication-lease.js';

const { acquireLocks, repositoryLeaseDirectories } = vi.hoisted(() => ({
  acquireLocks: vi.fn(),
  repositoryLeaseDirectories: vi.fn(),
}));
vi.mock('../src/server/lock.js', () => ({ acquireLocks }));
vi.mock('../src/server/repositories.js', () => ({ repositoryLeaseDirectories }));

describe('publication lease entrypoint', () => {
  it('holds the lease during action and releases it on success', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
    acquireLocks.mockResolvedValue(release);
    const action = vi.fn().mockResolvedValue('published');
    const plan = {
      allowed: true as const,
      destination: 'https://github.com/vlovers/ai-office',
      branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
      baseBranch: 'main',
      revision: 'a'.repeat(64),
      draft: true as const,
    };
    const { publicationKey } = await import('../src/server/delivery-publication-idempotency.js');
    expect(
      await withPublicationLease(
        { path: '/repo', gitDir: '/repo/.git' },
        '/repo/worktree',
        { status: 'requires-lease', operationKey: publicationKey(plan) },
        async () => plan,
        action,
      ),
    ).toBe('published');
    const lockRoot = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
    const lockName = createHash('sha256').update('/repo/.git').digest('hex');
    expect(acquireLocks).toHaveBeenCalledWith(
      [join(lockRoot, lockName)],
      'AI Office delivery publication',
    );
    expect(action).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases lease and refuses the action when review changed', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
    acquireLocks.mockResolvedValue(release);
    const action = vi.fn();
    await expect(
      withPublicationLease(
        { path: '/repo', gitDir: '/repo/.git' },
        '/repo/worktree',
        { status: 'requires-lease', operationKey: 'stale' },
        async () => ({
          allowed: true,
          destination: 'https://github.com/vlovers/ai-office',
          branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
          baseBranch: 'main',
          revision: 'a'.repeat(64),
          draft: true,
        }),
        action,
      ),
    ).rejects.toThrow('Publication snapshot changed');
    expect(action).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
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
