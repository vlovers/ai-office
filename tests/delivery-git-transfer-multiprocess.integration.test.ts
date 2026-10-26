import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { reconcileGitTransferReceipts } from '../src/server/delivery-git-transfer-reconciliation.js';
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-transfer-crash-')));
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
    workspaceId: 'workspace-crash',
    operationKey: publicationKey(plan),
    destination: plan.destination,
    branch,
    headSha,
    baseSha,
  };
  const fetcher = vi.fn(async () => {
    throw new Error('Commit-only recovery must not call GitHub.');
  });
  const context = {
    journal,
    identity,
    plan,
    repository,
    worktree: repository,
    refreshReviewed: async () => ({
      plan,
      identity,
      repository,
      worktree: repository,
    }),
    authorize: () => {},
    remote: { fetcher },
  };
  const args = [
    dbPath,
    identity.workspaceId,
    identity.operationKey,
    identity.destination,
    identity.branch,
    identity.headSha,
    identity.baseSha,
  ];
  return {
    root,
    db,
    dbPath,
    journal,
    identity,
    context,
    repository,
    args,
    fetcher,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const insert = [
  'INSERT INTO delivery_git_transfers',
  '(workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha)',
  "VALUES (?, 'commit', ?, ?, ?, ?, ?, 'intent', NULL)",
].join(' ');

function crashDuringIntent(args: string[], commit: boolean) {
  const script = [
    "const {DatabaseSync}=require('node:sqlite');",
    'const db=new DatabaseSync(process.argv[1]);',
    "db.exec('BEGIN IMMEDIATE');",
    'db.prepare(process.argv[8]).run(...process.argv.slice(2,8));',
    "if(process.argv[9]==='commit')db.exec('COMMIT');",
    "process.kill(process.pid,'SIGKILL');",
  ].join(' ');
  return spawnSync(
    process.execPath,
    ['-e', script, ...args, insert, commit ? 'commit' : 'rollback'],
    { encoding: 'utf8', timeout: 5000 },
  );
}

const insertPush = [
  'INSERT INTO delivery_git_transfers',
  '(workspace_id, stage, operation_key, destination, branch, head_sha, base_sha, state, receipt_sha)',
  "VALUES (?, 'push', ?, ?, ?, ?, ?, 'intent', NULL)",
].join(' ');

/** Crash an independent SQLite writer at either side of the push-intent commit. */
function crashDuringPush(args: string[], commit: boolean) {
  const script = [
    "const {DatabaseSync}=require('node:sqlite');",
    'const db=new DatabaseSync(process.argv[1]);',
    "db.exec('BEGIN IMMEDIATE');",
    'db.prepare(process.argv[8]).run(...process.argv.slice(2,8));',
    "if(process.argv[9]==='commit')db.exec('COMMIT');",
    "process.kill(process.pid,'SIGKILL');",
  ].join(' ');
  return spawnSync(
    process.execPath,
    ['-e', script, ...args, insertPush, commit ? 'commit' : 'rollback'],
    { encoding: 'utf8', timeout: 5000 },
  );
}

describe('multi-process durable Git transfer crash boundaries', () => {
  it('rolls back a killed SQLite writer before COMMIT without fabricating a receipt', () => {
    const t = setup();
    try {
      const killed = crashDuringIntent(t.args, false);
      expect(killed.signal).toBe('SIGKILL');
      expect(t.journal.get(t.identity.workspaceId, 'commit')).toBeNull();
      expect(t.journal.listUnresolvedWorkspaces(10).workspaceIds).toEqual([]);
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('recovers a committed intent after SIGKILL using local Git reads only', async () => {
    const t = setup();
    try {
      const killed = crashDuringIntent(t.args, true);
      expect(killed.signal).toBe('SIGKILL');
      expect(t.journal.get(t.identity.workspaceId, 'commit')?.state).toBe('intent');
      const reopened = new DatabaseSync(t.dbPath);
      try {
        const journal = new DeliveryGitTransferJournal(reopened);
        const result = await reconcileGitTransferReceipts({ ...t.context, journal });
        expect(result.status).toBe('commit-confirmed');
        expect(journal.get(t.identity.workspaceId, 'commit')).toMatchObject({
          state: 'confirmed',
          receiptSha: t.identity.headSha,
        });
        expect(t.fetcher).not.toHaveBeenCalled();
      } finally {
        reopened.close();
      }
    } finally {
      t.close();
    }
  });

  it('rolls back an interrupted push reservation without damaging the confirmed commit', () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      const killed = crashDuringPush(t.args, false);
      expect(killed.signal).toBe('SIGKILL');
      expect(t.journal.get(t.identity.workspaceId, 'push')).toBeNull();
      expect(t.journal.assertConfirmed('commit', t.identity).receiptSha).toBe(t.identity.headSha);
      expect(t.journal.listUnresolvedWorkspaces(10).workspaceIds).toEqual([]);
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('recovers a SIGKILL-persisted push intent using exact remote GETs without replay', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      const killed = crashDuringPush(t.args, true);
      expect(killed.signal).toBe('SIGKILL');
      expect(t.journal.get(t.identity.workspaceId, 'push')).toMatchObject({
        state: 'intent',
        receiptSha: null,
      });

      const reopened = new DatabaseSync(t.dbPath);
      try {
        const journal = new DeliveryGitTransferJournal(reopened);
        const remote = vi.fn(async (url: string, init: RequestInit) => {
          expect(init.method).toBe('GET');
          const isBase = url.endsWith('/main');
          return Response.json({
            ref: 'refs/heads/' + (isBase ? 'main' : t.identity.branch),
            object: {
              type: 'commit',
              sha: isBase ? t.identity.baseSha : t.identity.headSha,
            },
          });
        });
        const context = { ...t.context, journal, remote: { fetcher: remote } };
        expect((await reconcileGitTransferReceipts(context)).status).toBe('ready');
        expect(journal.get(t.identity.workspaceId, 'push')).toMatchObject({
          state: 'confirmed',
          receiptSha: t.identity.headSha,
        });
        expect(remote).toHaveBeenCalledTimes(3);
        expect(() => journal.begin('push', t.identity)).toThrow('already exists');
        expect((await reconcileGitTransferReceipts(context)).status).toBe('ready');
        expect(remote).toHaveBeenCalledTimes(6);
      } finally {
        reopened.close();
      }
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('preserves an uncertain crashed push on a moved GitHub head until verified', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', t.identity);
      t.journal.confirmVerified('commit', t.identity, t.identity.headSha);
      expect(crashDuringPush(t.args, true).signal).toBe('SIGKILL');
      const reopened = new DatabaseSync(t.dbPath);
      try {
        const journal = new DeliveryGitTransferJournal(reopened);
        let headSha = 'f'.repeat(40);
        const remote = vi.fn(async (url: string, init: RequestInit) => {
          expect(init.method).toBe('GET');
          const isBase = url.endsWith('/main');
          return Response.json({
            ref: 'refs/heads/' + (isBase ? 'main' : t.identity.branch),
            object: {
              type: 'commit',
              sha: isBase ? t.identity.baseSha : headSha,
            },
          });
        });
        const context = { ...t.context, journal, remote: { fetcher: remote } };
        expect(await reconcileGitTransferReceipts(context)).toMatchObject({
          status: 'blocked',
          stage: 'push',
        });
        expect(journal.get(t.identity.workspaceId, 'push')).toMatchObject({
          state: 'uncertain',
          receiptSha: null,
        });
        expect(remote).toHaveBeenCalledOnce();
        expect(() => journal.begin('push', t.identity)).toThrow('already exists');

        headSha = t.identity.headSha;
        expect((await reconcileGitTransferReceipts(context)).status).toBe('ready');
        expect(journal.get(t.identity.workspaceId, 'push')).toMatchObject({
          state: 'confirmed',
          receiptSha: t.identity.headSha,
        });
        expect(remote).toHaveBeenCalledTimes(4);
      } finally {
        reopened.close();
      }
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('rejects duplicate intents from independent processes through the real journal API', () => {
    const t = setup();
    try {
      expect(crashDuringIntent(t.args, true).signal).toBe('SIGKILL');
      const script = [
        "import { DatabaseSync } from 'node:sqlite';",
        "import { DeliveryGitTransferJournal } from './src/server/delivery-git-transfer-journal.ts';",
        'const db=new DatabaseSync(process.argv[1]);',
        'const identity=JSON.parse(process.argv[2]);',
        "try { new DeliveryGitTransferJournal(db).begin('commit',identity); process.exit(0); }",
        "catch(error) { process.exit(String(error).includes('already exists') ? 42 : 43); }",
      ].join(' ');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const replay = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            script,
            t.dbPath,
            JSON.stringify(t.identity),
          ],
          { encoding: 'utf8', timeout: 5000 },
        );
        expect(replay.status).toBe(42);
      }
      expect(t.journal.get(t.identity.workspaceId, 'commit')).toMatchObject({
        state: 'intent',
        receiptSha: null,
      });
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('fails closed when a separate SQLite process contends with an active writer', () => {
    const t = setup();
    try {
      t.db.exec('BEGIN IMMEDIATE');
      const script = [
        "const {DatabaseSync}=require('node:sqlite');",
        'const db=new DatabaseSync(process.argv[1]);',
        "db.exec('PRAGMA busy_timeout=50');",
        'try { db.prepare(process.argv[8]).run(...process.argv.slice(2,8)); process.exit(0); }',
        'catch(error) { process.exit(/locked|busy/i.test(String(error)) ? 42 : 43); }',
      ].join(' ');
      const contender = spawnSync(process.execPath, ['-e', script, ...t.args, insert], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(contender.status).toBe(42);
      t.db.exec('ROLLBACK');
      expect(t.journal.get(t.identity.workspaceId, 'commit')).toBeNull();
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      if (t.db.isTransaction) t.db.exec('ROLLBACK');
      t.close();
    }
  });

  it('serializes independent Node processes through the real repository lease', async () => {
    const t = setup();
    const script = [
      "import { withDeliveryRepositoryLease } from './src/server/delivery-publication-lease.ts';",
      'const repo={path:process.argv[1],gitDir:process.argv[2]};',
      'try { await withDeliveryRepositoryLease(repo,repo.gitDir,async()=>{}); process.exit(0); }',
      "catch(error) { process.exit(String(error).includes('Resource is locked') ? 42 : 43); }",
    ].join(' ');
    const contender = () =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          t.repository.path,
          t.repository.gitDir,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
    try {
      await withDeliveryRepositoryLease(t.repository, t.repository.gitDir, async () => {
        const blocked = contender();
        expect(blocked.status).toBe(42);
        expect(t.journal.get(t.identity.workspaceId, 'commit')).toBeNull();
      });
      const released = contender();
      expect(released.status).toBe(0);
      expect(t.journal.get(t.identity.workspaceId, 'commit')).toBeNull();
    } finally {
      t.close();
    }
  });
});
