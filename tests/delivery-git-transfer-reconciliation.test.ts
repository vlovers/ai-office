import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  reconcileGitTransferReceipts,
  type GitTransferReconciliationContext,
} from '../src/server/delivery-git-transfer-reconciliation.js';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { withDeliveryRepositoryLease } from '../src/server/delivery-publication-lease.js';

const branch = 'ai-office/12345678-1234-1234-1234-123456789abc';
const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch,
  baseBranch: 'main' as const,
  revision: 'a'.repeat(64),
  draft: true as const,
};

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-transfer-reconcile-')));
  const path = join(root, 'repo');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  git('config', 'user.name', 'AI Office Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(path, 'README.md'), 'base\n');
  git('add', 'README.md');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', branch);
  writeFileSync(join(path, 'README.md'), 'reviewed\n');
  git('add', 'README.md');
  git('commit', '-qm', 'reviewed');
  const headSha = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', 'git@github.com:vlovers/ai-office.git');
  const repository = { path, gitDir: realpathSync(join(path, '.git')) };
  const dbPath = join(root, 'state.sqlite');
  const db = new DatabaseSync(dbPath);
  const journal = new DeliveryGitTransferJournal(db);
  const identity = {
    workspaceId: 'workspace-1',
    operationKey: publicationKey(plan),
    destination: plan.destination,
    branch,
    headSha,
    baseSha,
  };
  const fetcher = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (init.method !== 'GET') throw new Error('No remote write is permitted.');
    const ref = url.endsWith('/main') ? 'main' : branch;
    return new Response(
      JSON.stringify({
        ref: 'refs/heads/' + ref,
        object: { type: 'commit', sha: ref === 'main' ? baseSha : headSha },
      }),
      { status: 200 },
    );
  });
  const authorize = vi.fn(() => {});
  const context: GitTransferReconciliationContext = {
    journal,
    identity,
    plan,
    refreshReviewed: vi.fn(async () => ({ plan, identity, repository, worktree: repository })),
    repository,
    worktree: repository,
    authorize,
    remote: { fetcher },
  };
  return {
    root,
    db,
    dbPath,
    git,
    journal,
    identity,
    fetcher,
    authorize,
    context,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('read-only commit/push receipt reconciliation', () => {
  it('never creates a missing intent, even when the reviewed Git state exists', async () => {
    const t = setup();
    try {
      const result = await reconcileGitTransferReceipts(t.context);
      expect(result.status).toBe('no-intent');
      expect(result.commit).toBeNull();
      expect(result.push).toBeNull();
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('confirms a durable commit intent from real Git without inventing a push', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      const result = await reconcileGitTransferReceipts(t.context);
      expect(result.status).toBe('commit-confirmed');
      expect(result.commit?.receiptSha).toBe(t.identity.headSha);
      expect(result.push).toBeNull();
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(() => t.journal.begin('commit', t.identity)).toThrow('already exists');
    } finally {
      t.close();
    }
  });

  it('recovers both stages only after exact local and remote SHA verification', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      const result = await reconcileGitTransferReceipts(t.context);
      expect(result.status).toBe('ready');
      expect(result.commit?.state).toBe('confirmed');
      expect(result.push?.receiptSha).toBe(t.identity.headSha);
      expect(t.fetcher).toHaveBeenCalledTimes(2);
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('ready');
      expect(() => t.journal.begin('push', t.identity)).toThrow('already exists');
    } finally {
      t.close();
    }
  });

  it.each([403, 429, 500])(
    'leaves an ambiguous push uncertain on GitHub HTTP %i',
    async (status) => {
      const t = setup();
      try {
        t.journal.begin('commit', t.identity);
        t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
        t.journal.begin('push', t.identity);
        t.fetcher.mockImplementation(async () => new Response('{}', { status }));
        const result = await reconcileGitTransferReceipts(t.context);
        expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
        expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
        expect(t.fetcher).toHaveBeenCalledOnce();
      } finally {
        t.close();
      }
    },
  );

  it('rejects a moved remote head without confirming the push', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      t.fetcher.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              ref: 'refs/heads/' + branch,
              object: { type: 'commit', sha: 'f'.repeat(40) },
            }),
            { status: 200 },
          ),
      );
      expect(await reconcileGitTransferReceipts(t.context)).toMatchObject({
        status: 'blocked',
        stage: 'push',
      });
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      expect(t.fetcher).toHaveBeenCalledOnce();
    } finally {
      t.close();
    }
  });

  it('bounds a hung remote GET and never retries or fabricates a receipt', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      t.fetcher.mockImplementation(async () => new Promise<Response>(() => undefined));
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        remoteDeadlineMs: 100,
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      expect(t.fetcher).toHaveBeenCalledOnce();
    } finally {
      t.close();
    }
  });

  it('keeps a timed-out push uncertain after SQLite restart and recovers only by GET', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      t.fetcher.mockImplementation(async () => new Promise<Response>(() => undefined));
      expect(
        await reconcileGitTransferReceipts({ ...t.context, remoteDeadlineMs: 100 }),
      ).toMatchObject({ status: 'blocked', stage: 'push' });
      const reopened = new DatabaseSync(t.dbPath);
      try {
        const journal = new DeliveryGitTransferJournal(reopened);
        expect(journal.get('workspace-1', 'push')?.state).toBe('uncertain');
        const calls: string[] = [];
        const result = await reconcileGitTransferReceipts({
          ...t.context,
          journal,
          remote: {
            fetcher: async (url, init) => {
              calls.push(url);
              expect(init.method).toBe('GET');
              const ref = url.endsWith('/main') ? 'main' : branch;
              return Response.json({
                ref: 'refs/heads/' + ref,
                object: {
                  type: 'commit',
                  sha: ref === 'main' ? t.identity.baseSha : t.identity.headSha,
                },
              });
            },
          },
        });
        expect(result.status).toBe('ready');
        expect(journal.get('workspace-1', 'push')?.receiptSha).toBe(t.identity.headSha);
        expect(calls).toHaveLength(2);
      } finally {
        reopened.close();
      }
    } finally {
      t.close();
    }
  });

  it('does not confirm a commit when the local worktree is dirty or origin changed', async () => {
    for (const mutate of [
      (t: ReturnType<typeof setup>) => writeFileSync(join(t.context.worktree.path, 'dirty'), 'x'),
      (t: ReturnType<typeof setup>) =>
        t.git('remote', 'set-url', 'origin', 'git@github.com:foreign/repo.git'),
    ]) {
      const t = setup();
      try {
        t.journal.begin('commit', t.identity);
        mutate(t);
        const result = await reconcileGitTransferReceipts(t.context);
        expect(result).toMatchObject({ status: 'blocked', stage: 'commit' });
        expect(t.journal.get('workspace-1', 'commit')?.state).toBe('uncertain');
        expect(t.fetcher).not.toHaveBeenCalled();
      } finally {
        t.close();
      }
    }
  });

  it('does not confirm a commit if an external Git change occurs during final registry refresh', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      let refreshes = 0;
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshReviewed: async () => {
          if (++refreshes === 2) {
            writeFileSync(join(t.context.worktree.path, 'late-untracked.txt'), 'changed');
          }
          return {
            plan,
            identity: t.identity,
            repository: t.context.repository,
            worktree: t.context.worktree,
          };
        },
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'commit' });
      expect(refreshes).toBe(2);
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('uncertain');
      expect(t.journal.get('workspace-1', 'commit')?.receiptSha).toBeNull();
      expect(t.fetcher).not.toHaveBeenCalled();
      rmSync(join(t.context.worktree.path, 'late-untracked.txt'));
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('commit-confirmed');
    } finally {
      t.close();
    }
  });

  it('does not confirm a push if an external Git change occurs during GitHub GET', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.endsWith('/main')) {
          writeFileSync(join(t.context.worktree.path, 'late-untracked.txt'), 'changed');
        }
        return original(url, init);
      });
      const result = await reconcileGitTransferReceipts(t.context);
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('confirmed');
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      expect(t.journal.get('workspace-1', 'push')?.receiptSha).toBeNull();
      expect(t.fetcher).toHaveBeenCalledTimes(2);
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
      rmSync(join(t.context.worktree.path, 'late-untracked.txt'));
      // Restore the normal transport: the injected callback would otherwise
      // recreate the dirty worktree on every reconciliation attempt.
      t.fetcher.mockImplementation(original);
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('ready');
      expect(t.journal.get('workspace-1', 'push')?.receiptSha).toBe(t.identity.headSha);
    } finally {
      t.close();
    }
  });

  it('does not confirm a push when Git origin changes during final registry refresh', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      let refreshes = 0;
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshReviewed: async () => {
          if (++refreshes === 3) {
            t.git('remote', 'set-url', 'origin', 'git@github.com:foreign/repo.git');
          }
          return {
            plan,
            identity: t.identity,
            repository: t.context.repository,
            worktree: t.context.worktree,
          };
        },
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(refreshes).toBe(3);
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      expect(t.journal.get('workspace-1', 'push')?.receiptSha).toBeNull();
      expect(t.fetcher).toHaveBeenCalledTimes(2);
      t.git('remote', 'set-url', 'origin', 'git@github.com:vlovers/ai-office.git');
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('ready');
    } finally {
      t.close();
    }
  });

  it('rejects a foreign transfer identity before changing any durable row', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      await expect(
        reconcileGitTransferReceipts({
          ...t.context,
          identity: { ...t.identity, headSha: 'f'.repeat(40) },
        }),
      ).rejects.toThrow('registry binding changed');
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('blocks an asynchronous or revoked authorization before journal mutation', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      await expect(
        reconcileGitTransferReceipts({
          ...t.context,
          authorize: (() => Promise.resolve()) as unknown as () => void,
        }),
      ).rejects.toThrow('synchronous');
      await expect(
        reconcileGitTransferReceipts({
          ...t.context,
          authorize: () => {
            throw new Error('revoked');
          },
        }),
      ).rejects.toThrow('revoked');
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('fails closed when authorization is revoked during remote reads', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      let authorized = true;
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        authorized = false;
        return original(url, init);
      });
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        authorize: () => {
          if (!authorized) throw new Error('revoked');
        },
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
    } finally {
      t.close();
    }
  });

  it('preserves unresolved receipts across SQLite close/reopen without another push', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      t.fetcher.mockImplementation(async () => new Response('{}', { status: 429 }));
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('blocked');
      const db2 = new DatabaseSync(t.dbPath);
      try {
        const restored = new DeliveryGitTransferJournal(db2);
        expect(restored.get('workspace-1', 'push')?.state).toBe('uncertain');
        const result = await reconcileGitTransferReceipts({
          ...t.context,
          journal: restored,
          remote: {
            fetcher: async (url, init) => {
              const ref = url.endsWith('/main') ? 'main' : branch;
              expect(init.method).toBe('GET');
              return new Response(
                JSON.stringify({
                  ref: 'refs/heads/' + ref,
                  object: {
                    type: 'commit',
                    sha: ref === 'main' ? t.identity.baseSha : t.identity.headSha,
                  },
                }),
                { status: 200 },
              );
            },
          },
        });
        expect(result.status).toBe('ready');
        expect(restored.get('workspace-1', 'push')?.state).toBe('confirmed');
      } finally {
        db2.close();
      }
    } finally {
      t.close();
    }
  });

  it('cannot reconcile while the shared repository lease is held', async () => {
    const t = setup();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    try {
      t.journal.begin('commit', t.identity);
      const holder = withDeliveryRepositoryLease(
        t.context.repository,
        t.context.worktree.gitDir,
        async () => {
          acquired();
          await gate;
        },
      );
      await ready;
      await expect(reconcileGitTransferReceipts(t.context)).rejects.toThrow('Resource is locked');
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
      release();
      await holder;
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('commit-confirmed');
    } finally {
      release();
      t.close();
    }
  });

  it('rejects a changed registry operation before journal mutation', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      const refreshReviewed = vi.fn(async () => ({
        plan: { ...plan, revision: 'b'.repeat(64) },
        identity: t.identity,
        repository: t.context.repository,
        worktree: t.context.worktree,
      }));
      await expect(reconcileGitTransferReceipts({ ...t.context, refreshReviewed })).rejects.toThrow(
        'binding changed',
      );
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(refreshReviewed).toHaveBeenCalledOnce();
    } finally {
      t.close();
    }
  });

  it('blocks commit confirmation on registry drift during Git reads', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      let checks = 0;
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshReviewed: async () => ({
          plan: ++checks === 1 ? plan : { ...plan, revision: 'b'.repeat(64) },
          identity: t.identity,
          repository: t.context.repository,
          worktree: t.context.worktree,
        }),
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'commit' });
      expect(checks).toBe(2);
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('uncertain');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('does not confirm a push if the reviewed registry changes during remote GETs', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      let checks = 0;
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshReviewed: async () => ({
          plan: ++checks <= 2 ? plan : { ...plan, revision: 'b'.repeat(64) },
          identity: t.identity,
          repository: t.context.repository,
          worktree: t.context.worktree,
        }),
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(checks).toBe(3);
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('confirmed');
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      expect(t.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      t.close();
    }
  });

  it('rejects push intent when its commit receipt was invalidated', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      // Simulate a pre-upgrade journal written before monotonic SQL guards.
      t.db.exec('DROP TRIGGER delivery_git_transfers_monotonic_receipt');
      t.db
        .prepare(
          "UPDATE delivery_git_transfers SET state='uncertain', receipt_sha=NULL WHERE workspace_id=? AND stage='commit'",
        )
        .run(t.identity.workspaceId);
      await expect(reconcileGitTransferReceipts(t.context)).rejects.toThrow(
        'independently confirmed commit receipt',
      );
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('intent');
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('uncertain');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('rejects a corrupted confirmed commit SHA before recovery or GitHub reads', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      // Preserve an intentionally corrupted legacy receipt for reconciliation tests.
      t.db.exec('DROP TRIGGER delivery_git_transfers_monotonic_receipt');
      t.db
        .prepare(
          "UPDATE delivery_git_transfers SET receipt_sha=? WHERE workspace_id=? AND stage='commit'",
        )
        .run('f'.repeat(40), t.identity.workspaceId);
      await expect(reconcileGitTransferReceipts(t.context)).rejects.toThrow(
        'Confirmed commit receipt conflicts',
      );
      expect(t.journal.get('workspace-1', 'commit')?.receiptSha).toBe('f'.repeat(40));
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('rejects a corrupted confirmed push SHA before any recovery mutation', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      t.journal.confirmVerified('push', t.identity, t.identity.headSha);
      // Preserve an intentionally corrupted legacy receipt for reconciliation tests.
      t.db.exec('DROP TRIGGER delivery_git_transfers_monotonic_receipt');
      t.db
        .prepare(
          "UPDATE delivery_git_transfers SET receipt_sha=? WHERE workspace_id=? AND stage='push'",
        )
        .run('f'.repeat(40), t.identity.workspaceId);
      await expect(reconcileGitTransferReceipts(t.context)).rejects.toThrow(
        'Confirmed push receipt conflicts',
      );
      expect(t.journal.get('workspace-1', 'push')?.receiptSha).toBe('f'.repeat(40));
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('blocks a moved remote base and preserves the uncertain push intent', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      t.fetcher.mockImplementation(async (url, init) => {
        expect(init.method).toBe('GET');
        const base = url.endsWith('/main');
        return new Response(
          JSON.stringify({
            ref: 'refs/heads/' + (base ? 'main' : branch),
            object: {
              type: 'commit',
              sha: base ? 'f'.repeat(40) : t.identity.headSha,
            },
          }),
          { status: 200 },
        );
      });
      expect(await reconcileGitTransferReceipts(t.context)).toMatchObject({
        status: 'blocked',
        stage: 'push',
      });
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      expect(t.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      t.close();
    }
  });

  it('blocks malformed remote JSON without treating it as an absent ref', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      t.fetcher.mockImplementation(async () => new Response('{broken', { status: 200 }));
      expect(await reconcileGitTransferReceipts(t.context)).toMatchObject({
        status: 'blocked',
        stage: 'push',
      });
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      expect(t.fetcher).toHaveBeenCalledOnce();
    } finally {
      t.close();
    }
  });

  it('keeps push uncertain across transient GitHub API failures and retries with GET only', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      const original = t.fetcher.getMockImplementation()!;
      for (const status of [401, 403, 404, 429, 500, 502, 503]) {
        t.fetcher.mockImplementation(async (_url, init) => {
          expect(init.method).toBe('GET');
          return new Response('unavailable', { status });
        });
        expect(await reconcileGitTransferReceipts(t.context)).toMatchObject({
          status: 'blocked',
          stage: 'push',
        });
        expect(t.journal.get(t.identity.workspaceId, 'push')).toMatchObject({
          state: 'uncertain',
          receiptSha: null,
        });
      }
      t.fetcher.mockImplementation(original);
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('ready');
      expect(t.journal.get(t.identity.workspaceId, 'push')).toMatchObject({
        state: 'confirmed',
        receiptSha: t.identity.headSha,
      });
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      t.close();
    }
  });

  it('retains uncertainty after network exceptions and recovers through read-only GETs', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      const original = t.fetcher.getMockImplementation()!;
      for (const error of [
        new TypeError('fetch failed'),
        new Error('ECONNRESET'),
        new Error('DNS lookup failed'),
      ]) {
        t.fetcher.mockImplementation(async (_url, init) => {
          expect(init.method).toBe('GET');
          throw error;
        });
        expect(await reconcileGitTransferReceipts(t.context)).toMatchObject({
          status: 'blocked',
          stage: 'push',
        });
        expect(t.journal.get(t.identity.workspaceId, 'push')).toMatchObject({
          state: 'uncertain',
          receiptSha: null,
        });
      }
      t.fetcher.mockImplementation(original);
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('ready');
      expect(t.journal.get(t.identity.workspaceId, 'push')).toMatchObject({
        state: 'confirmed',
        receiptSha: t.identity.headSha,
      });
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      t.close();
    }
  });

  it('never adopts a remote ref after GitHub returns a successful but malformed receipt', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      const original = t.fetcher.getMockImplementation()!;
      const malformed = [
        { ref: 'refs/heads/' + branch, object: { type: 'tag', sha: t.identity.headSha } },
        { ref: 'refs/heads/foreign', object: { type: 'commit', sha: t.identity.headSha } },
        { ref: 'refs/heads/' + branch, object: { type: 'commit', sha: 'f'.repeat(40) } },
        { ref: 'refs/heads/' + branch, object: { type: 'commit' } },
      ];
      for (const payload of malformed) {
        t.fetcher.mockImplementation(async (_url, init) => {
          expect(init.method).toBe('GET');
          return Response.json(payload);
        });
        expect(await reconcileGitTransferReceipts(t.context)).toMatchObject({
          status: 'blocked',
          stage: 'push',
        });
        expect(t.journal.get(t.identity.workspaceId, 'push')).toMatchObject({
          state: 'uncertain',
          receiptSha: null,
        });
      }
      t.fetcher.mockImplementation(original);
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('ready');
      expect(t.journal.get(t.identity.workspaceId, 'push')?.receiptSha).toBe(t.identity.headSha);
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      t.close();
    }
  });

  it('rejects a swapped worktree registry binding before touching an intent', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      await expect(
        reconcileGitTransferReceipts({
          ...t.context,
          refreshReviewed: async () => ({
            plan,
            identity: t.identity,
            repository: t.context.repository,
            worktree: { ...t.context.worktree, gitDir: t.context.worktree.gitDir + '-other' },
          }),
        }),
      ).rejects.toThrow('binding changed');
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('does not confirm a push when reviewed head SHA changes during remote reads', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      let checks = 0;
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshReviewed: async () => ({
          plan,
          identity: ++checks <= 2 ? t.identity : { ...t.identity, headSha: 'f'.repeat(40) },
          repository: t.context.repository,
          worktree: t.context.worktree,
        }),
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(checks).toBe(3);
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      expect(t.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      t.close();
    }
  });
  it('bounds a hung first registry refresh and releases the shared Git lease', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      await expect(
        reconcileGitTransferReceipts({
          ...t.context,
          refreshDeadlineMs: 100,
          refreshReviewed: async () => new Promise<never>(() => undefined),
        }),
      ).rejects.toThrow('registry refresh timed out');
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('commit-confirmed');
    } finally {
      t.close();
    }
  });

  it('leaves a commit uncertain if the registry hangs after local Git attestation', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      let refreshes = 0;
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshDeadlineMs: 100,
        refreshReviewed: async () => {
          if (++refreshes === 1) {
            return {
              plan,
              identity: t.identity,
              repository: t.context.repository,
              worktree: t.context.worktree,
            };
          }
          return new Promise<never>(() => undefined);
        },
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'commit' });
      expect(refreshes).toBe(2);
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('uncertain');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('never confirms a push if the final registry refresh stalls after GitHub GETs', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      let refreshes = 0;
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshDeadlineMs: 100,
        refreshReviewed: async () => {
          if (++refreshes <= 2) {
            return {
              plan,
              identity: t.identity,
              repository: t.context.repository,
              worktree: t.context.worktree,
            };
          }
          return new Promise<never>(() => undefined);
        },
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(refreshes).toBe(3);
      expect(t.fetcher).toHaveBeenCalledTimes(2);
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
    } finally {
      t.close();
    }
  });

  it('aborts a hung registry refresh and ignores a late successful result', async () => {
    const t = setup();
    const controller = new AbortController();
    let finish!: (value: Awaited<ReturnType<typeof t.context.refreshReviewed>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof t.context.refreshReviewed>>>(
      (resolve) => {
        finish = resolve;
      },
    );
    try {
      t.journal.begin('commit', t.identity);
      const attempt = reconcileGitTransferReceipts({
        ...t.context,
        remote: { ...t.context.remote, signal: controller.signal },
        refreshDeadlineMs: 1000,
        refreshReviewed: () => pending,
      });
      controller.abort();
      await expect(attempt).rejects.toThrow('aborted');
      finish({
        plan,
        identity: t.identity,
        repository: t.context.repository,
        worktree: t.context.worktree,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
      expect((await reconcileGitTransferReceipts(t.context)).status).toBe('commit-confirmed');
    } finally {
      t.close();
    }
  });

  it('rejects invalid registry refresh deadlines before touching durable state', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      const refreshReviewed = vi.fn(t.context.refreshReviewed);
      for (const refreshDeadlineMs of [0, 99, 60_001, -1, 1.5, Number.NaN, Infinity]) {
        await expect(
          reconcileGitTransferReceipts({
            ...t.context,
            refreshReviewed,
            refreshDeadlineMs,
          }),
        ).rejects.toThrow('registry refresh deadline');
      }
      expect(refreshReviewed).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('rejects a pre-upgrade foreign branch owner before touching the pending intent', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.db.exec('DROP TRIGGER delivery_git_transfers_exclusive_insert');
      t.journal.begin('commit', {
        ...t.identity,
        workspaceId: 'legacy-foreign',
        operationKey: 'independent-reviewed-operation',
      });

      await expect(reconcileGitTransferReceipts(t.context)).rejects.toThrow('another workspace');
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('rejects a pre-upgrade operation-key collision across repositories and branches', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.db.exec('DROP TRIGGER delivery_git_transfers_exclusive_insert');
      t.journal.begin('commit', {
        ...t.identity,
        workspaceId: 'legacy-foreign',
        destination: 'https://github.com/foreign/repository',
        branch: 'ai-office/22345678-1234-1234-1234-123456789abc',
      });

      await expect(reconcileGitTransferReceipts(t.context)).rejects.toThrow('another workspace');
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('does not confirm a commit if a legacy owner appears during local attestation', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      let refreshCount = 0;
      const refreshReviewed = vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount === 2) {
          t.db.exec('DROP TRIGGER delivery_git_transfers_exclusive_insert');
          t.journal.begin('commit', {
            ...t.identity,
            workspaceId: 'legacy-foreign',
            operationKey: 'independent-reviewed-operation',
          });
        }
        return {
          plan,
          identity: t.identity,
          repository: t.context.repository,
          worktree: t.context.worktree,
        };
      });

      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshReviewed,
      });
      expect(result).toMatchObject({ status: 'blocked', stage: 'commit' });
      expect(t.journal.get('workspace-1', 'commit')?.state).toBe('uncertain');
      expect(t.journal.get('workspace-1', 'commit')?.receiptSha).toBeNull();
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('does not confirm a push if a legacy owner appears during GitHub GETs', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      t.journal.begin('push', t.identity);
      const original = t.fetcher.getMockImplementation()!;
      let inserted = false;
      t.fetcher.mockImplementation(async (url, init) => {
        if (!inserted) {
          inserted = true;
          t.db.exec('DROP TRIGGER delivery_git_transfers_exclusive_insert');
          t.journal.begin('commit', {
            ...t.identity,
            workspaceId: 'legacy-foreign',
            operationKey: 'independent-reviewed-operation',
          });
        }
        return original(url, init);
      });

      const result = await reconcileGitTransferReceipts(t.context);
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      expect(t.journal.get('workspace-1', 'push')?.receiptSha).toBeNull();
      expect(t.fetcher).toHaveBeenCalledTimes(2);
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      t.close();
    }
  });
});
