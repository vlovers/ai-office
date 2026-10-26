import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { recoverUnresolvedGitTransfers } from '../src/server/delivery-git-transfer-recovery-batch.js';
import type { GitTransferReconciliationContext } from '../src/server/delivery-git-transfer-reconciliation.js';
import {
  DeliveryGitTransferJournal,
  type DeliveryGitTransferIdentity,
} from '../src/server/delivery-git-transfer-journal.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { withDeliveryRepositoryLease } from '../src/server/delivery-publication-lease.js';

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-recovery-batch-')));
  const dbPath = join(root, 'state.sqlite');
  const db = new DatabaseSync(dbPath);
  const journal = new DeliveryGitTransferJournal(db);
  type WorkspaceFixture = {
    identity: DeliveryGitTransferIdentity;
    plan: {
      allowed: true;
      destination: string;
      branch: string;
      baseBranch: 'main';
      revision: string;
      draft: true;
    };
    repository: { path: string; gitDir: string };
    baseSha: string;
    headSha: string;
  };
  const workspaces = new Map<string, WorkspaceFixture>();

  // Separate workspaces own distinct reviewed branches and Git repositories.
  // Reusing a single destination/branch would violate the durable ownership
  // invariant and must be tested explicitly as a legacy conflict instead.
  const workspace = (workspaceId: string): WorkspaceFixture => {
    const existing = workspaces.get(workspaceId);
    if (existing) return existing;
    const path = join(root, `repo-${workspaceId}`);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
    const uuidPrefix = workspaceId.charCodeAt(0).toString(16).padStart(8, '0');
    const branch = `ai-office/${uuidPrefix}-1234-1234-1234-123456789abc`;
    const destination = `https://github.com/vlovers/ai-office-${workspaceId}`;
    const plan = {
      allowed: true as const,
      destination,
      branch,
      baseBranch: 'main' as const,
      revision: 'a'.repeat(64),
      draft: true as const,
    };
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
    git('remote', 'add', 'origin', `git@github.com:vlovers/ai-office-${workspaceId}.git`);
    const repository = { path, gitDir: realpathSync(join(path, '.git')) };
    const identity = {
      workspaceId,
      operationKey: publicationKey(plan),
      destination,
      branch,
      headSha,
      baseSha,
    };
    const fixture = { identity, plan, repository, baseSha, headSha };
    workspaces.set(workspaceId, fixture);
    return fixture;
  };
  const identity = (workspaceId: string): DeliveryGitTransferIdentity =>
    workspace(workspaceId).identity;
  const fetcher = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (init.method !== 'GET') throw new Error('Remote writes are forbidden.');
    const target = [...workspaces.values()].find((item) =>
      url.startsWith(
        `https://api.github.com/repos/vlovers/ai-office-${item.identity.workspaceId}/git/ref/heads/`,
      ),
    );
    if (!target) throw new Error('Unknown test GitHub destination.');
    const isBase = url.endsWith('/main');
    return new Response(
      JSON.stringify({
        ref: 'refs/heads/' + (isBase ? 'main' : target.identity.branch),
        object: { type: 'commit', sha: isBase ? target.baseSha : target.headSha },
      }),
      { status: 200 },
    );
  });
  const contextFor = (
    workspaceId: string,
    targetJournal = journal,
  ): GitTransferReconciliationContext => {
    const target = workspace(workspaceId);
    return {
      journal: targetJournal,
      identity: target.identity,
      plan: target.plan,
      refreshReviewed: async () => ({
        plan: target.plan,
        identity: target.identity,
        repository: target.repository,
        worktree: target.repository,
      }),
      repository: target.repository,
      worktree: target.repository,
      authorize: () => {},
      remote: { fetcher },
    };
  };
  return {
    root,
    db,
    dbPath,
    journal,
    identity,
    fetcher,
    repository: workspace('a').repository,
    contextFor,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('bounded Git transfer recovery across workspaces', () => {
  it('discovers each workspace once and paginates without starving blocked entries', async () => {
    const t = setup();
    try {
      for (const name of ['a', 'b', 'c']) {
        t.journal.begin('commit', t.identity(name));
      }
      const first = await recoverUnresolvedGitTransfers(
        t.journal,
        async (id) => (id === 'a' ? null : t.contextFor(id)),
        { limit: 2 },
      );
      expect(first.outcomes.map((item) => [item.workspaceId, item.status])).toEqual([
        ['a', 'unavailable'],
        ['b', 'reconciled'],
      ]);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBe('b');
      const second = await recoverUnresolvedGitTransfers(
        t.journal,
        async (id) => t.contextFor(id),
        { limit: 2, afterWorkspaceId: first.nextCursor! },
      );
      expect(second.outcomes.map((item) => item.workspaceId)).toEqual(['c']);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
      expect(t.journal.get('c', 'commit')?.state).toBe('confirmed');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('isolates legacy branch collisions without starving independent workspaces', async () => {
    const t = setup();
    try {
      const owner = t.identity('a');
      t.journal.begin('commit', owner);
      // Simulate a pre-trigger database. Keep both conflicting rows intact.
      t.db.exec('DROP TRIGGER delivery_git_transfers_exclusive_insert');
      t.journal.begin('commit', { ...owner, workspaceId: 'b' });
      t.journal.begin('commit', t.identity('c'));

      const result = await recoverUnresolvedGitTransfers(t.journal, async (id) => t.contextFor(id));
      expect(result.outcomes).toMatchObject([
        { workspaceId: 'a', status: 'blocked' },
        { workspaceId: 'b', status: 'blocked' },
        { workspaceId: 'c', status: 'reconciled', result: { status: 'commit-confirmed' } },
      ]);
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.journal.get('b', 'commit')?.state).toBe('intent');
      expect(t.journal.get('c', 'commit')?.state).toBe('confirmed');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('deduplicates commit and push stages and verifies only GET receipts', async () => {
    const t = setup();
    try {
      const owner = t.identity('a');
      t.journal.begin('commit', owner);
      t.journal.confirmVerified('commit', owner, owner.headSha);
      t.journal.begin('push', owner);
      const resolve = vi.fn(async (id: string) => t.contextFor(id));
      const result = await recoverUnresolvedGitTransfers(t.journal, resolve);
      expect(resolve).toHaveBeenCalledOnce();
      expect(result.outcomes).toMatchObject([
        { workspaceId: 'a', status: 'reconciled', result: { status: 'ready' } },
      ]);
      expect(t.journal.get('a', 'push')?.receiptSha).toBe(owner.headSha);
      expect(t.fetcher).toHaveBeenCalledTimes(3);
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
      expect((await recoverUnresolvedGitTransfers(t.journal, resolve)).outcomes).toEqual([]);
    } finally {
      t.close();
    }
  });

  it('does not mutate intents for missing or throwing registry resolvers', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity('a'));
      t.journal.begin('commit', t.identity('b'));
      const result = await recoverUnresolvedGitTransfers(t.journal, async (id) => {
        if (id === 'a') throw new Error('registry offline');
        return null;
      });
      expect(result.outcomes).toEqual([
        { workspaceId: 'a', status: 'blocked' },
        { workspaceId: 'b', status: 'unavailable' },
      ]);
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.journal.get('b', 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('rejects a resolver that swaps the workspace or SQLite journal', async () => {
    const t = setup();
    const other = new DatabaseSync(':memory:');
    try {
      t.journal.begin('commit', t.identity('a'));
      t.journal.begin('commit', t.identity('b'));
      const foreignJournal = new DeliveryGitTransferJournal(other);
      const result = await recoverUnresolvedGitTransfers(t.journal, async (id) =>
        id === 'a' ? t.contextFor('b') : t.contextFor(id, foreignJournal),
      );
      expect(result.outcomes).toEqual([
        { workspaceId: 'a', status: 'blocked' },
        { workspaceId: 'b', status: 'blocked' },
      ]);
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.journal.get('b', 'commit')?.state).toBe('intent');
    } finally {
      other.close();
      t.close();
    }
  });

  it('isolates malformed and throwing registry bindings without aborting later recovery', async () => {
    const t = setup();
    try {
      for (const id of ['a', 'b', 'c', 'd']) {
        t.journal.begin('commit', t.identity(id));
      }
      const throwingBinding = Object.defineProperty({}, 'journal', {
        get: () => {
          throw new Error('registry object corrupted');
        },
      });
      const result = await recoverUnresolvedGitTransfers(t.journal, async (id) => {
        if (id === 'a') return {} as GitTransferReconciliationContext;
        if (id === 'b') {
          const invalid = { journal: t.journal, identity: null };
          return invalid as unknown as GitTransferReconciliationContext;
        }
        if (id === 'c') return throwingBinding as GitTransferReconciliationContext;
        return t.contextFor(id);
      });
      expect(result.outcomes).toMatchObject([
        { workspaceId: 'a', status: 'blocked' },
        { workspaceId: 'b', status: 'blocked' },
        { workspaceId: 'c', status: 'blocked' },
        { workspaceId: 'd', status: 'reconciled', result: { status: 'commit-confirmed' } },
      ]);
      for (const id of ['a', 'b', 'c']) {
        expect(t.journal.get(id, 'commit')?.state).toBe('intent');
      }
      expect(t.journal.get('d', 'commit')?.state).toBe('confirmed');
    } finally {
      t.close();
    }
  });

  it('isolates authorization failures without stopping later workspaces', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity('a'));
      t.journal.begin('commit', t.identity('b'));
      const result = await recoverUnresolvedGitTransfers(t.journal, async (id) => ({
        ...t.contextFor(id),
        authorize: () => {
          if (id === 'a') throw new Error('revoked');
        },
      }));
      expect(result.outcomes.map((item) => item.status)).toEqual(['blocked', 'reconciled']);
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
    } finally {
      t.close();
    }
  });

  it('retains uncertain push state after HTTP 429 and continues recovery', async () => {
    const t = setup();
    try {
      const owner = t.identity('a');
      t.journal.begin('commit', owner);
      t.journal.confirmVerified('commit', owner, owner.headSha);
      t.journal.begin('push', owner);
      t.journal.begin('commit', t.identity('b'));
      t.fetcher.mockImplementation(async () => new Response('{}', { status: 429 }));
      const result = await recoverUnresolvedGitTransfers(t.journal, async (id) => t.contextFor(id));
      expect(result.outcomes).toMatchObject([
        { workspaceId: 'a', status: 'reconciled', result: { status: 'blocked', stage: 'push' } },
        { workspaceId: 'b', status: 'reconciled', result: { status: 'commit-confirmed' } },
      ]);
      expect(t.journal.get('a', 'push')?.state).toBe('uncertain');
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
      expect(t.fetcher).toHaveBeenCalledOnce();
    } finally {
      t.close();
    }
  });

  it('refuses recovery while another publisher owns the shared Git lease', async () => {
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
      t.journal.begin('commit', t.identity('a'));
      const holder = withDeliveryRepositoryLease(t.repository, t.repository.gitDir, async () => {
        acquired();
        await gate;
      });
      await ready;
      const result = await recoverUnresolvedGitTransfers(t.journal, async (id) => t.contextFor(id));
      expect(result.outcomes).toEqual([{ workspaceId: 'a', status: 'blocked' }]);
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      release();
      await holder;
      const recovered = await recoverUnresolvedGitTransfers(t.journal, async (id) =>
        t.contextFor(id),
      );
      expect(recovered.outcomes).toMatchObject([
        { workspaceId: 'a', status: 'reconciled', result: { status: 'commit-confirmed' } },
      ]);
    } finally {
      release();
      t.close();
    }
  });

  it('recovers across SQLite close/reopen without another remote write', async () => {
    const t = setup();
    try {
      const owner = t.identity('a');
      t.journal.begin('commit', owner);
      t.journal.confirmVerified('commit', owner, owner.headSha);
      t.journal.begin('push', owner);
      const reopened = new DatabaseSync(t.dbPath);
      try {
        const journal = new DeliveryGitTransferJournal(reopened);
        const result = await recoverUnresolvedGitTransfers(journal, async (id) =>
          t.contextFor(id, journal),
        );
        expect(result.outcomes).toMatchObject([
          { workspaceId: 'a', status: 'reconciled', result: { status: 'ready' } },
        ]);
        expect(journal.get('a', 'push')?.state).toBe('confirmed');
        expect(t.fetcher).toHaveBeenCalledTimes(3);
      } finally {
        reopened.close();
      }
    } finally {
      t.close();
    }
  });

  it('reconciles a stale WAL backup of a completed push without replaying remote writes', async () => {
    const t = setup();
    const snapshotPath = join(t.root, 'stale-transfer-snapshot.sqlite');
    try {
      t.db.exec('PRAGMA journal_mode=WAL');
      const owner = t.identity('a');
      t.journal.begin('commit', owner);
      t.journal.confirmVerified('commit', owner, owner.headSha);
      t.journal.begin('push', owner);

      await backup(t.db, snapshotPath);
      t.journal.confirmVerified('push', owner, owner.headSha);
      expect(t.journal.get('a', 'push')?.state).toBe('confirmed');

      const restored = new DatabaseSync(snapshotPath);
      try {
        const journal = new DeliveryGitTransferJournal(restored);
        expect(journal.get('a', 'push')?.state).toBe('intent');
        const result = await recoverUnresolvedGitTransfers(journal, async (id) =>
          t.contextFor(id, journal),
        );
        expect(result.outcomes).toMatchObject([
          { workspaceId: 'a', status: 'reconciled', result: { status: 'ready' } },
        ]);
        expect(journal.get('a', 'push')).toMatchObject({
          state: 'confirmed',
          receiptSha: owner.headSha,
        });
        expect(t.fetcher).toHaveBeenCalledTimes(3);
        expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
        const resumed = await recoverUnresolvedGitTransfers(journal, async (id) =>
          t.contextFor(id, journal),
        );
        expect(resumed.outcomes).toEqual([]);
      } finally {
        restored.close();
      }
    } finally {
      t.close();
    }
  });

  it('keeps a restored WAL push uncertain after a GitHub rate limit until GET recovery', async () => {
    const t = setup();
    const snapshotPath = join(t.root, 'rate-limited-transfer-snapshot.sqlite');
    try {
      t.db.exec('PRAGMA journal_mode=WAL');
      const owner = t.identity('a');
      t.journal.begin('commit', owner);
      t.journal.confirmVerified('commit', owner, owner.headSha);
      t.journal.begin('push', owner);
      await backup(t.db, snapshotPath);

      const restored = new DatabaseSync(snapshotPath);
      try {
        const journal = new DeliveryGitTransferJournal(restored);
        t.fetcher.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
        const blocked = await recoverUnresolvedGitTransfers(journal, async (id) =>
          t.contextFor(id, journal),
        );
        expect(blocked.outcomes).toMatchObject([
          { workspaceId: 'a', status: 'reconciled', result: { status: 'blocked', stage: 'push' } },
        ]);
        expect(journal.get('a', 'push')?.state).toBe('uncertain');
        expect(t.fetcher).toHaveBeenCalledOnce();

        const recovered = await recoverUnresolvedGitTransfers(journal, async (id) =>
          t.contextFor(id, journal),
        );
        expect(recovered.outcomes).toMatchObject([
          { workspaceId: 'a', status: 'reconciled', result: { status: 'ready' } },
        ]);
        expect(journal.get('a', 'push')).toMatchObject({
          state: 'confirmed',
          receiptSha: owner.headSha,
        });
        expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
      } finally {
        restored.close();
      }
    } finally {
      t.close();
    }
  });

  it('rejects invalid bounds before calling the resolver or touching durable state', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity('a'));
      const resolve = vi.fn(async (id: string) => t.contextFor(id));
      for (const limit of [0, 101, -1, 1.5, Number.NaN]) {
        await expect(recoverUnresolvedGitTransfers(t.journal, resolve, { limit })).rejects.toThrow(
          'batch limit',
        );
      }
      await expect(
        recoverUnresolvedGitTransfers(t.journal, resolve, { afterWorkspaceId: '' }),
      ).rejects.toThrow('cursor');
      expect(resolve).not.toHaveBeenCalled();
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });
  it('bounds a stalled registry resolver and still recovers the next workspace', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity('a'));
      t.journal.begin('commit', t.identity('b'));
      const resolver = vi.fn(async (id: string) =>
        id === 'a'
          ? new Promise<GitTransferReconciliationContext | null>(() => undefined)
          : t.contextFor(id),
      );
      const result = await recoverUnresolvedGitTransfers(t.journal, resolver, {
        resolveTimeoutMs: 100,
      });
      expect(result.outcomes).toMatchObject([
        { workspaceId: 'a', status: 'blocked' },
        { workspaceId: 'b', status: 'reconciled', result: { status: 'commit-confirmed' } },
      ]);
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('does not start reconciliation when a timed-out registry lookup resolves late', async () => {
    const t = setup();
    let complete!: (context: GitTransferReconciliationContext) => void;
    const pending = new Promise<GitTransferReconciliationContext>((resolve) => {
      complete = resolve;
    });
    try {
      t.journal.begin('commit', t.identity('a'));
      const result = await recoverUnresolvedGitTransfers(t.journal, async () => pending, {
        resolveTimeoutMs: 100,
      });
      expect(result.outcomes).toEqual([{ workspaceId: 'a', status: 'blocked' }]);
      complete(t.contextFor('a'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('rejects invalid registry deadlines before any lookup or journal mutation', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity('a'));
      const resolver = vi.fn(async (id: string) => t.contextFor(id));
      for (const resolveTimeoutMs of [0, 99, 60_001, -1, 1.5, Number.NaN, Infinity]) {
        await expect(
          recoverUnresolvedGitTransfers(t.journal, resolver, { resolveTimeoutMs }),
        ).rejects.toThrow('registry lookup deadline');
      }
      expect(resolver).not.toHaveBeenCalled();
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('accepts the maximum bounded resolver deadline without altering existing semantics', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity('a'));
      const result = await recoverUnresolvedGitTransfers(
        t.journal,
        async (id) => t.contextFor(id),
        { resolveTimeoutMs: 60_000 },
      );
      expect(result.outcomes).toMatchObject([
        { workspaceId: 'a', status: 'reconciled', result: { status: 'commit-confirmed' } },
      ]);
      expect(t.journal.get('a', 'commit')?.state).toBe('confirmed');
    } finally {
      t.close();
    }
  });
  it('isolates a stalled in-lease registry refresh and recovers the next workspace', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity('a'));
      t.journal.begin('commit', t.identity('b'));
      const result = await recoverUnresolvedGitTransfers(t.journal, async (id) => {
        const context = t.contextFor(id);
        return id === 'a'
          ? {
              ...context,
              refreshDeadlineMs: 100,
              refreshReviewed: async () => new Promise<never>(() => undefined),
            }
          : context;
      });
      expect(result.outcomes).toMatchObject([
        { workspaceId: 'a', status: 'blocked' },
        { workspaceId: 'b', status: 'reconciled', result: { status: 'commit-confirmed' } },
      ]);
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('does not let a late registry refresh confirm an earlier timed-out workspace', async () => {
    const t = setup();
    let finish!: (
      value: Awaited<ReturnType<GitTransferReconciliationContext['refreshReviewed']>>,
    ) => void;
    const pending = new Promise<
      Awaited<ReturnType<GitTransferReconciliationContext['refreshReviewed']>>
    >((resolve) => {
      finish = resolve;
    });
    try {
      t.journal.begin('commit', t.identity('a'));
      t.journal.begin('commit', t.identity('b'));
      const result = await recoverUnresolvedGitTransfers(t.journal, async (id) => {
        const context = t.contextFor(id);
        return id === 'a'
          ? { ...context, refreshDeadlineMs: 100, refreshReviewed: () => pending }
          : context;
      });
      expect(result.outcomes.map((item) => item.status)).toEqual(['blocked', 'reconciled']);
      const context = t.contextFor('a');
      finish(await context.refreshReviewed());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
    } finally {
      t.close();
    }
  });

  it('stops before the first workspace on operator cancellation and resumes without skipping it', async () => {
    const t = setup();
    const controller = new AbortController();
    try {
      t.journal.begin('commit', t.identity('a'));
      t.journal.begin('commit', t.identity('b'));
      controller.abort();
      const resolver = vi.fn(async (id: string) => t.contextFor(id));
      const stopped = await recoverUnresolvedGitTransfers(t.journal, resolver, {
        signal: controller.signal,
      });
      expect(stopped).toMatchObject({
        outcomes: [],
        nextCursor: null,
        hasMore: true,
        stopReason: 'aborted',
      });
      expect(resolver).not.toHaveBeenCalled();
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      const resumed = await recoverUnresolvedGitTransfers(t.journal, resolver, {
        afterWorkspaceId: stopped.nextCursor ?? undefined,
      });
      expect(resumed.outcomes.map((item) => item.workspaceId)).toEqual(['a', 'b']);
      expect(resumed.stopReason).toBeNull();
    } finally {
      t.close();
    }
  });

  it('cancels a stalled registry resolver and ignores its late successful binding', async () => {
    const t = setup();
    const controller = new AbortController();
    let finish!: (value: GitTransferReconciliationContext) => void;
    const pending = new Promise<GitTransferReconciliationContext>((resolve) => {
      finish = resolve;
    });
    try {
      t.journal.begin('commit', t.identity('a'));
      const resolver = vi.fn(async () => pending);
      const attempt = recoverUnresolvedGitTransfers(t.journal, resolver, {
        signal: controller.signal,
        resolveTimeoutMs: 60_000,
      });
      await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
      controller.abort();
      const stopped = await attempt;
      expect(stopped).toMatchObject({
        outcomes: [],
        nextCursor: null,
        hasMore: true,
        stopReason: 'aborted',
      });
      finish(t.contextFor('a'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('stops on a monotonic budget without skipping the unresolved next workspace', async () => {
    const t = setup();
    let fakeNow = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);
    try {
      for (const id of ['a', 'b', 'c']) t.journal.begin('commit', t.identity(id));
      const resolver = vi.fn(async (id: string) => {
        if (id === 'b') fakeNow = 250;
        return t.contextFor(id);
      });
      const stopped = await recoverUnresolvedGitTransfers(t.journal, resolver, {
        batchBudgetMs: 200,
      });
      expect(stopped).toMatchObject({
        nextCursor: 'a',
        hasMore: true,
        stopReason: 'budget-exhausted',
      });
      expect(stopped.outcomes).toMatchObject([{ workspaceId: 'a', status: 'reconciled' }]);
      expect(t.journal.get('a', 'commit')?.state).toBe('confirmed');
      expect(t.journal.get('b', 'commit')?.state).toBe('intent');
      expect(t.journal.get('c', 'commit')?.state).toBe('intent');
      clock.mockRestore();
      const resumed = await recoverUnresolvedGitTransfers(
        t.journal,
        async (id) => t.contextFor(id),
        { afterWorkspaceId: stopped.nextCursor! },
      );
      expect(resumed.outcomes.map((item) => item.workspaceId)).toEqual(['b', 'c']);
      expect(resumed.stopReason).toBeNull();
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
      expect(t.journal.get('c', 'commit')?.state).toBe('confirmed');
    } finally {
      clock.mockRestore();
      t.close();
    }
  });

  it('bounds a never-settling resolver by the overall batch budget', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity('a'));
      const resolver = vi.fn(
        async () => new Promise<GitTransferReconciliationContext>(() => undefined),
      );
      const stopped = await recoverUnresolvedGitTransfers(t.journal, resolver, {
        resolveTimeoutMs: 60_000,
        batchBudgetMs: 100,
      });
      expect(stopped).toMatchObject({
        outcomes: [],
        nextCursor: null,
        hasMore: true,
        stopReason: 'budget-exhausted',
      });
      expect(resolver).toHaveBeenCalledOnce();
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('propagates cancellation into a pending remote GET and preserves the next cursor', async () => {
    const t = setup();
    const controller = new AbortController();
    try {
      const owner = t.identity('a');
      t.journal.begin('commit', owner);
      t.journal.confirmVerified('commit', owner, owner.headSha);
      t.journal.begin('push', owner);
      t.journal.begin('commit', t.identity('b'));
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async () => new Promise<Response>(() => undefined));
      const attempt = recoverUnresolvedGitTransfers(t.journal, async (id) => t.contextFor(id), {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(t.fetcher).toHaveBeenCalledOnce());
      controller.abort();
      const stopped = await attempt;
      expect(stopped).toMatchObject({
        nextCursor: null,
        hasMore: true,
        stopReason: 'aborted',
        outcomes: [
          {
            workspaceId: 'a',
            status: 'reconciled',
            result: { status: 'blocked', stage: 'push' },
          },
        ],
      });
      expect(t.journal.get('a', 'push')?.state).toBe('uncertain');
      expect(t.journal.get('a', 'push')?.receiptSha).toBeNull();
      expect(t.journal.get('b', 'commit')?.state).toBe('intent');
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
      t.fetcher.mockImplementation(original);
      const resumed = await recoverUnresolvedGitTransfers(
        t.journal,
        async (id) => t.contextFor(id),
        { afterWorkspaceId: stopped.nextCursor ?? undefined },
      );
      expect(resumed.outcomes.map((item) => item.workspaceId)).toEqual(['a', 'b']);
      expect(t.journal.get('a', 'push')?.state).toBe('confirmed');
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      t.close();
    }
  });

  it('keeps the cursor before a workspace cancelled by its trusted remote signal', async () => {
    const t = setup();
    const controller = new AbortController();
    try {
      const owner = t.identity('a');
      t.journal.begin('commit', owner);
      t.journal.confirmVerified('commit', owner, owner.headSha);
      t.journal.begin('push', owner);
      t.journal.begin('commit', t.identity('b'));
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (_url, init) => {
        expect(init.method).toBe('GET');
        controller.abort();
        return new Promise<Response>(() => undefined);
      });
      const stopped = await recoverUnresolvedGitTransfers(t.journal, async (id) => {
        const context = t.contextFor(id);
        return id === 'a'
          ? { ...context, remote: { ...context.remote, signal: controller.signal } }
          : context;
      });
      expect(stopped).toMatchObject({
        nextCursor: null,
        hasMore: true,
        stopReason: 'aborted',
        outcomes: [
          {
            workspaceId: 'a',
            status: 'reconciled',
            result: { status: 'blocked', stage: 'push' },
          },
        ],
      });
      expect(t.journal.get('a', 'push')?.state).toBe('uncertain');
      expect(t.journal.get('b', 'commit')?.state).toBe('intent');
      t.fetcher.mockImplementation(original);
      const resumed = await recoverUnresolvedGitTransfers(
        t.journal,
        async (id) => t.contextFor(id),
        { afterWorkspaceId: stopped.nextCursor ?? undefined },
      );
      expect(resumed.outcomes.map((item) => item.workspaceId)).toEqual(['a', 'b']);
      expect(t.journal.get('a', 'push')?.state).toBe('confirmed');
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      t.close();
    }
  });

  it('revisits an uncertain push when the batch budget expires inside the Git lease', async () => {
    const t = setup();
    let fakeNow = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);
    try {
      const owner = t.identity('a');
      t.journal.begin('commit', owner);
      t.journal.confirmVerified('commit', owner, owner.headSha);
      t.journal.begin('push', owner);
      t.journal.begin('commit', t.identity('b'));
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (_url, init) => {
        expect(init.method).toBe('GET');
        fakeNow = 250;
        return new Response('{}', { status: 429 });
      });
      const stopped = await recoverUnresolvedGitTransfers(
        t.journal,
        async (id) => t.contextFor(id),
        { batchBudgetMs: 200 },
      );
      expect(stopped).toMatchObject({
        nextCursor: null,
        hasMore: true,
        stopReason: 'budget-exhausted',
        outcomes: [
          {
            workspaceId: 'a',
            status: 'reconciled',
            result: { status: 'blocked', stage: 'push' },
          },
        ],
      });
      expect(t.journal.get('a', 'push')?.state).toBe('uncertain');
      expect(t.journal.get('b', 'commit')?.state).toBe('intent');
      clock.mockRestore();
      t.fetcher.mockImplementation(original);
      const resumed = await recoverUnresolvedGitTransfers(
        t.journal,
        async (id) => t.contextFor(id),
        { afterWorkspaceId: stopped.nextCursor ?? undefined },
      );
      expect(resumed.outcomes.map((item) => item.workspaceId)).toEqual(['a', 'b']);
      expect(t.journal.get('a', 'push')?.state).toBe('confirmed');
      expect(t.journal.get('b', 'commit')?.state).toBe('confirmed');
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      clock.mockRestore();
      t.close();
    }
  });

  it('rejects invalid batch budgets before registry reads or journal mutation', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity('a'));
      const resolver = vi.fn(async (id: string) => t.contextFor(id));
      for (const batchBudgetMs of [0, 99, 600_001, -1, 1.5, Number.NaN, Infinity]) {
        await expect(
          recoverUnresolvedGitTransfers(t.journal, resolver, { batchBudgetMs }),
        ).rejects.toThrow('recovery batch budget');
      }
      expect(resolver).not.toHaveBeenCalled();
      expect(t.journal.get('a', 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });
});
