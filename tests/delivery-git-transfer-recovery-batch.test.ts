import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { recoverUnresolvedGitTransfers } from '../src/server/delivery-git-transfer-recovery-batch.js';
import type { GitTransferReconciliationContext } from '../src/server/delivery-git-transfer-reconciliation.js';
import {
  DeliveryGitTransferJournal,
  type DeliveryGitTransferIdentity,
} from '../src/server/delivery-git-transfer-journal.js';
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-recovery-batch-')));
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
  const identity = (workspaceId: string): DeliveryGitTransferIdentity => ({
    workspaceId,
    operationKey: publicationKey(plan),
    destination: plan.destination,
    branch,
    headSha,
    baseSha,
  });
  const fetcher = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (init.method !== 'GET') throw new Error('Remote writes are forbidden.');
    const isBase = url.endsWith('/main');
    return new Response(
      JSON.stringify({
        ref: 'refs/heads/' + (isBase ? 'main' : branch),
        object: { type: 'commit', sha: isBase ? baseSha : headSha },
      }),
      { status: 200 },
    );
  });
  const contextFor = (
    workspaceId: string,
    targetJournal = journal,
  ): GitTransferReconciliationContext => {
    const owner = identity(workspaceId);
    return {
      journal: targetJournal,
      identity: owner,
      plan,
      refreshReviewed: async () => ({
        plan,
        identity: owner,
        repository,
        worktree: repository,
      }),
      repository,
      worktree: repository,
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
    repository,
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
      expect(t.fetcher).toHaveBeenCalledTimes(2);
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
        expect(t.fetcher).toHaveBeenCalledTimes(2);
      } finally {
        reopened.close();
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
});
