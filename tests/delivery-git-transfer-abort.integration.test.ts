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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-transfer-abort-')));
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
  const db = new DatabaseSync(join(root, 'state.sqlite'));
  const journal = new DeliveryGitTransferJournal(db);
  const identity = {
    workspaceId: 'workspace-abort',
    operationKey: publicationKey(plan),
    destination: plan.destination,
    branch,
    headSha,
    baseSha,
  };
  const controller = new AbortController();
  const responseFor = (url: string) => {
    const isBase = url.endsWith('/main');
    return new Response(
      JSON.stringify({
        ref: 'refs/heads/' + (isBase ? 'main' : branch),
        object: { type: 'commit', sha: isBase ? baseSha : headSha },
      }),
      { status: 200 },
    );
  };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== 'GET') throw new Error('Remote writes are forbidden.');
    return responseFor(url);
  });
  const context: GitTransferReconciliationContext = {
    journal,
    identity,
    plan,
    refreshReviewed: async () => ({ plan, identity, repository, worktree: repository }),
    repository,
    worktree: repository,
    authorize: () => {},
    remote: { fetcher, signal: controller.signal },
  };
  const beginPush = () => {
    journal.begin('commit', identity);
    journal.confirmVerified('commit', identity, identity.headSha);
    journal.begin('push', identity);
  };
  return {
    root,
    db,
    journal,
    identity,
    controller,
    responseFor,
    fetcher,
    context,
    beginPush,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('abort-safe read-only Git transfer reconciliation', () => {
  it('rejects a pre-aborted recovery without changing an existing intent', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.controller.abort();
      await expect(reconcileGitTransferReceipts(t.context)).rejects.toThrow('aborted');
      expect(t.journal.get(t.identity.workspaceId, 'commit')?.state).toBe('intent');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('blocks commit receipt when aborted during registry refresh', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      let refreshes = 0;
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshReviewed: async () => {
          if (++refreshes === 2) t.controller.abort();
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
      expect(t.journal.get(t.identity.workspaceId, 'commit')?.state).toBe('uncertain');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('never confirms a push when an in-flight fetch ignores external cancellation', async () => {
    const t = setup();
    try {
      t.beginPush();
      let release!: (response: Response) => void;
      let started!: () => void;
      const pending = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      t.fetcher.mockImplementation(async (_url, init) => {
        expect(init.method).toBe('GET');
        started();
        return pending;
      });
      const running = reconcileGitTransferReceipts(t.context);
      await entered;
      t.controller.abort();
      release(
        t.responseFor('https://api.github.com/repos/vlovers/ai-office/git/ref/heads/' + branch),
      );
      const result = await running;
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(t.journal.get(t.identity.workspaceId, 'push')?.state).toBe('uncertain');
      // A custom transport may complete an already-started GET after abort.
      // This is safe only because no receipt or remote write is allowed.
      expect(t.fetcher.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      t.close();
    }
  });

  it('blocks cancellation during the second GitHub GET', async () => {
    const t = setup();
    try {
      t.beginPush();
      t.fetcher.mockImplementation(async (url, init) => {
        expect(init.method).toBe('GET');
        if (url.endsWith('/main')) t.controller.abort();
        return t.responseFor(url);
      });
      const result = await reconcileGitTransferReceipts(t.context);
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(t.journal.get(t.identity.workspaceId, 'push')?.receiptSha).toBeNull();
      expect(t.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      t.close();
    }
  });

  it('blocks push receipt when aborted during final registry refresh', async () => {
    const t = setup();
    try {
      t.beginPush();
      let refreshes = 0;
      const result = await reconcileGitTransferReceipts({
        ...t.context,
        refreshReviewed: async () => {
          if (++refreshes === 3) t.controller.abort();
          return {
            plan,
            identity: t.identity,
            repository: t.context.repository,
            worktree: t.context.worktree,
          };
        },
      });
      expect(refreshes).toBe(3);
      expect(t.fetcher).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ status: 'blocked', stage: 'push' });
      expect(t.journal.get(t.identity.workspaceId, 'commit')?.state).toBe('confirmed');
      expect(t.journal.get(t.identity.workspaceId, 'push')?.state).toBe('uncertain');
    } finally {
      t.close();
    }
  });

  it('cannot turn an aborted push into a second intent or automatic retry', async () => {
    const t = setup();
    try {
      t.beginPush();
      t.fetcher.mockImplementation(async (url) => {
        t.controller.abort();
        return t.responseFor(url);
      });
      expect(await reconcileGitTransferReceipts(t.context)).toMatchObject({
        status: 'blocked',
        stage: 'push',
      });
      expect(() => t.journal.begin('push', t.identity)).toThrow('already exists');
      const readsBeforeRetry = t.fetcher.mock.calls.length;
      await expect(reconcileGitTransferReceipts(t.context)).rejects.toThrow('aborted');
      expect(t.journal.get(t.identity.workspaceId, 'push')?.state).toBe('uncertain');
      expect(t.fetcher).toHaveBeenCalledTimes(readsBeforeRetry);
      expect(t.fetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      t.close();
    }
  });
});
