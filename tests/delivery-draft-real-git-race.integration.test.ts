import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createSessionBoundGitHubDraft } from '../src/server/delivery-approved-github-publication.js';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { DeliveryPublicationApprovalLedger } from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { withDeliveryRepositoryLease } from '../src/server/delivery-publication-lease.js';
import { repositoryLeaseDirectories } from '../src/server/repositories.js';
import { DeliverySessions } from '../src/server/delivery-sessions.js';

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-draft-git-race-')));
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
  const db = new DatabaseSync(join(root, 'delivery.sqlite'));
  const sessions = new DeliverySessions(db, () => 10_000);
  sessions.setOperator('operator-1', true);
  sessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', true);
  const { token } = sessions.exchangeEnrollment(sessions.issueEnrollment('operator-1'));
  const operator = sessions.authorize(token, 'workspace-1', 'approve:draft-pr');
  const workspace = {
    workspaceId: 'workspace-1',
    repository,
    worktree: repository,
    plan,
    headSha,
    baseSha,
  };
  const commits = {
    operationKey: publicationKey(plan),
    headCommitSha: headSha,
    baseCommitSha: baseSha,
  };
  const approvalId = new DeliveryPublicationApprovalLedger(db, () => 10_000).issue({
    workspaceId: 'workspace-1',
    operator,
    plan,
    commits,
  });
  const identity = {
    workspaceId: 'workspace-1',
    operationKey: commits.operationKey,
    destination: plan.destination,
    branch,
    headSha,
    baseSha,
  };
  const transfers = new DeliveryGitTransferJournal(db);
  transfers.begin('commit', identity);
  transfers.confirmVerified('commit', identity, headSha);
  transfers.begin('push', identity);
  transfers.confirmVerified('push', identity, headSha);
  const receipt = {
    number: 123,
    html_url: 'https://github.com/vlovers/ai-office/pull/123',
    draft: true,
    state: 'open',
    head: { ref: branch, sha: headSha, repo: { full_name: 'vlovers/ai-office' } },
    base: { ref: 'main', sha: baseSha, repo: { full_name: 'vlovers/ai-office' } },
  };
  let posted = false;
  const fetcher = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (init.method === 'POST') {
      posted = true;
      return Response.json(receipt, { status: 201 });
    }
    if (url.includes('/git/ref/heads/')) {
      const ref = url.endsWith('/main') ? 'main' : branch;
      return Response.json({
        ref: 'refs/heads/' + ref,
        object: { type: 'commit', sha: ref === 'main' ? baseSha : headSha },
      });
    }
    if (url.includes('/pulls?')) return Response.json(posted ? [receipt] : []);
    if (url.endsWith('/pulls/123')) return Response.json(receipt);
    throw new Error('Unexpected GitHub request.');
  });
  const context = () => ({
    sessions,
    sessionToken: token,
    workspace,
    refreshWorkspace: async () => workspace,
    approvalId,
    write: { token: 'server-owned-write-token', title: 'Reviewed draft', fetcher },
  });
  return {
    root,
    path,
    dbPath: join(root, 'delivery.sqlite'),
    fetcher,
    context,
    journal: new DeliveryJournal(db),
    receipt,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Execute the real session-bound publisher in an independent Node process.
 * The fake GitHub transport records that POST was entered, optionally records
 * an accepted remote write outside the Git worktree, and SIGKILLs the worker
 * before a response or local publication receipt can be persisted.
 */
async function killPublisherAtPost(
  t: ReturnType<typeof setup>,
  accepted: boolean,
): Promise<{ entered: string; acceptedPath: string }> {
  const entered = join(t.root, 'post-entered');
  const acceptedPath = join(t.root, 'remote-accepted');
  const context = t.context();
  const payload = JSON.stringify({
    dbPath: t.dbPath,
    workspace: context.workspace,
    sessionToken: context.sessionToken,
    approvalId: context.approvalId,
    entered,
    acceptedPath,
    accepted,
    receipt: t.receipt,
  });
  const script = [
    "import { writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    "import { DeliverySessions } from './src/server/delivery-sessions.ts';",
    "import { createSessionBoundGitHubDraft } from './src/server/delivery-approved-github-publication.ts';",
    'const input = JSON.parse(process.argv[1]);',
    'const db = new DatabaseSync(input.dbPath);',
    'const sessions = new DeliverySessions(db, () => 10_000);',
    'const fetcher = async (url, init) => {',
    "  if (init.method === 'POST') {",
    "    writeFileSync(input.entered, 'entered');",
    "    if (input.accepted) writeFileSync(input.acceptedPath, 'accepted');",
    "    process.kill(process.pid, 'SIGKILL');",
    "    throw new Error('Unreachable after SIGKILL');",
    '  }',
    "  if (url.includes('/git/ref/heads/')) {",
    "    const ref = url.endsWith('/main') ? 'main' : input.workspace.plan.branch;",
    '    return Response.json({',
    "      ref: 'refs/heads/' + ref,",
    "      object: { type: 'commit', sha: ref === 'main' ? input.workspace.baseSha : input.workspace.headSha },",
    '    });',
    '  }',
    "  if (url.includes('/pulls?')) return Response.json([]);",
    "  throw new Error('Unexpected pre-POST GitHub request');",
    '};',
    'await createSessionBoundGitHubDraft({',
    '  sessions, sessionToken: input.sessionToken, workspace: input.workspace,',
    '  refreshWorkspace: async () => input.workspace, approvalId: input.approvalId,',
    "  write: { token: 'server-owned-write-token', title: 'Reviewed draft', fetcher },",
    '});',
    'process.exitCode = 12;',
  ].join('\n');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, payload],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 },
  );
  expect(child.signal, child.stderr).toBe('SIGKILL');
  expect(existsSync(entered), child.stderr).toBe(true);
  expect(existsSync(acceptedPath)).toBe(accepted);
  // A killed worker deliberately leaves the shared OS-local Git lease behind.
  // The real application MUST fail closed rather than steal a possibly live
  // lock. Simulate explicit operator recovery only for this verified-dead
  // test child and these unique temporary Git directories.
  const repository = context.workspace.repository;
  const workspaceGitDir = context.workspace.worktree.gitDir;
  await expect(
    withDeliveryRepositoryLease(repository, workspaceGitDir, async () => undefined),
  ).rejects.toThrow('Resource is locked');
  const lockRoot = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
  const directories = await repositoryLeaseDirectories(repository, workspaceGitDir);
  const leases = directories.map((directory) =>
    join(lockRoot, createHash('sha256').update(directory).digest('hex')),
  );
  // Validate every owner before removing any test-owned lease.
  for (const lease of leases) {
    const owner = JSON.parse(readFileSync(join(lease, 'owner.json'), 'utf8')) as {
      pid: number;
      detail: string;
    };
    expect(owner.pid).toBe(child.pid);
    expect(owner.detail).toBe('AI Office delivery publication/recovery');
  }
  for (const lease of leases) rmSync(lease, { recursive: true, force: true });
  return { entered, acceptedPath };
}

describe('real Git Draft PR late-mutation integration', () => {
  it.each(['worktree', 'origin'] as const)(
    'does not consume approval when %s changes during the remote PR inventory',
    async (mutation) => {
      const t = setup();
      const original = t.fetcher.getMockImplementation()!;
      const dirtyPath = join(t.path, 'inventory-untracked.txt');
      const setOrigin = (remote: string) =>
        execFileSync('git', ['-C', t.path, 'remote', 'set-url', 'origin', remote]);
      let inventoryReads = 0;
      try {
        t.fetcher.mockImplementation(async (url, init) => {
          if (url.includes('/pulls?') && ++inventoryReads === 1) {
            if (mutation === 'worktree') {
              writeFileSync(dirtyPath, 'external process changed the worktree\\n');
            } else {
              setOrigin('git@github.com:foreign/repo.git');
            }
          }
          return original(url, init);
        });
        await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow();
        expect(t.journal.get('workspace-1')).toBeNull();
        expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
        if (mutation === 'worktree') {
          rmSync(dirtyPath);
        } else {
          setOrigin('git@github.com:vlovers/ai-office.git');
        }
        expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
        expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      } finally {
        t.close();
      }
    },
  );

  it('does not consume approval when trusted registry changes during PR inventory', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    let drift = false;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.includes('/pulls?')) drift = true;
        return original(url, init);
      });
      const reviewedWorkspace = t.context().workspace;
      const context = () => ({
        ...t.context(),
        refreshWorkspace: async () =>
          drift ? { ...reviewedWorkspace, headSha: 'f'.repeat(40) } : reviewedWorkspace,
      });
      await expect(createSessionBoundGitHubDraft(context())).rejects.toThrow();
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
      drift = false;
      t.fetcher.mockImplementation(original);
      expect((await createSessionBoundGitHubDraft(context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('blocks the only POST after a non-cooperating Git write during final ref GET', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    const dirtyPath = join(t.path, 'late-untracked.txt');
    let baseReads = 0;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.endsWith('/git/ref/heads/main') && ++baseReads === 2) {
          writeFileSync(dirtyPath, 'late local mutation\n');
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(baseReads).toBe(2);
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
      rmSync(dirtyPath);
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('recovers a completed POST only after restoring real Git state and fresh PR GET', async () => {
    const t = setup();
    const original = t.fetcher.getMockImplementation()!;
    const dirtyPath = join(t.path, 'late-untracked.txt');
    let detailReads = 0;
    try {
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.endsWith('/pulls/123') && ++detailReads === 1) {
          writeFileSync(dirtyPath, 'late local mutation\n');
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      rmSync(dirtyPath);
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(detailReads).toBe(2);
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(t.receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });
  it.each([
    { accepted: false, rateLimited: false, expected: 'uncertain' },
    { accepted: true, rateLimited: false, expected: 'published' },
    { accepted: true, rateLimited: true, expected: 'published' },
  ] as const)(
    'recovers SIGKILL at POST (accepted=$accepted, HTTP 429=$rateLimited) without retry',
    async ({ accepted, rateLimited, expected }) => {
      const t = setup();
      let restartedDb: DatabaseSync | undefined;
      try {
        await killPublisherAtPost(t, accepted);
        expect(t.journal.get('workspace-1')?.state).toBe('reserved');
        // New SQLite connection and session service simulate a fresh server.
        restartedDb = new DatabaseSync(t.dbPath);
        const restartedJournal = new DeliveryJournal(restartedDb);
        const restartedSessions = new DeliverySessions(restartedDb, () => 10_000);
        expect(restartedJournal.get('workspace-1')?.state).toBe('reserved');
        const original = t.fetcher.getMockImplementation()!;
        let inventories = 0;
        const restartFetcher = vi.fn(async (url: string, init: RequestInit) => {
          if (init.method === 'POST') throw new Error('Restart must never POST.');
          if (url.includes('/pulls?')) {
            inventories++;
            if (rateLimited && inventories === 1) {
              return Response.json({ message: 'rate limited' }, { status: 429 });
            }
            return Response.json(accepted ? [t.receipt] : []);
          }
          return original(url, init);
        });
        const restartContext = () => ({
          ...t.context(),
          sessions: restartedSessions,
          write: { ...t.context().write, fetcher: restartFetcher },
        });
        const first = await createSessionBoundGitHubDraft(restartContext());
        expect(first.status).toBe(rateLimited ? 'uncertain' : expected);
        expect(restartedJournal.get('workspace-1')?.state).toBe(
          rateLimited ? 'uncertain' : expected,
        );
        const second = await createSessionBoundGitHubDraft(restartContext());
        expect(second.status).toBe(expected);
        expect(restartedJournal.get('workspace-1')?.state).toBe(expected);
        expect(restartedJournal.get('workspace-1')?.pullRequestUrl).toBe(
          accepted ? t.receipt.html_url : null,
        );
        expect(restartFetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
        expect(restartFetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(
          0,
        );
        expect(t.fetcher).not.toHaveBeenCalled();
      } finally {
        restartedDb?.close();
        t.close();
      }
    },
  );

  it('does not adopt a recovered POST while another PR reuses its managed branch', async () => {
    const t = setup();
    let restartedDb: DatabaseSync | undefined;
    try {
      await killPublisherAtPost(t, true);
      restartedDb = new DatabaseSync(t.dbPath);
      const restartedJournal = new DeliveryJournal(restartedDb);
      const restartedSessions = new DeliverySessions(restartedDb, () => 10_000);
      const original = t.fetcher.getMockImplementation()!;
      let conflict = true;
      const restartFetcher = vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === 'POST') throw new Error('Duplicate POST is forbidden.');
        if (url.includes('/pulls?')) {
          return Response.json(
            conflict
              ? [
                  t.receipt,
                  {
                    ...t.receipt,
                    number: 456,
                    html_url: 'https://github.com/vlovers/ai-office/pull/456',
                    base: { ...t.receipt.base, ref: 'develop' },
                  },
                ]
              : [t.receipt],
          );
        }
        return original(url, init);
      });
      const context = () => ({
        ...t.context(),
        sessions: restartedSessions,
        write: { ...t.context().write, fetcher: restartFetcher },
      });
      expect((await createSessionBoundGitHubDraft(context())).status).toBe('uncertain');
      expect(restartedJournal.get('workspace-1')?.state).toBe('uncertain');
      expect(restartedJournal.get('workspace-1')?.pullRequestUrl).toBeNull();
      conflict = false;
      expect((await createSessionBoundGitHubDraft(context())).status).toBe('published');
      expect(restartedJournal.get('workspace-1')?.pullRequestUrl).toBe(t.receipt.html_url);
      expect(restartFetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      restartedDb?.close();
      t.close();
    }
  });

  it('rejects revoked grants and dirty Git after killed POST', async () => {
    const t = setup();
    let restartedDb: DatabaseSync | undefined;
    const dirty = join(t.path, 'post-crash-untracked.txt');
    try {
      await killPublisherAtPost(t, true);
      restartedDb = new DatabaseSync(t.dbPath);
      const restartedJournal = new DeliveryJournal(restartedDb);
      const restartedSessions = new DeliverySessions(restartedDb, () => 10_000);
      const original = t.fetcher.getMockImplementation()!;
      const restartFetcher = vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === 'POST') throw new Error('Duplicate POST is forbidden.');
        if (url.includes('/pulls?')) return Response.json([t.receipt]);
        return original(url, init);
      });
      const context = () => ({
        ...t.context(),
        sessions: restartedSessions,
        write: { ...t.context().write, fetcher: restartFetcher },
      });
      restartedSessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', false);
      await expect(createSessionBoundGitHubDraft(context())).rejects.toThrow();
      expect(restartFetcher).not.toHaveBeenCalled();
      expect(restartedJournal.get('workspace-1')?.state).toBe('reserved');
      restartedSessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', true);
      writeFileSync(dirty, 'external worktree mutation');
      await expect(createSessionBoundGitHubDraft(context())).rejects.toThrow();
      expect(restartFetcher).not.toHaveBeenCalled();
      expect(restartedJournal.get('workspace-1')?.state).toBe('reserved');
      rmSync(dirty);
      expect((await createSessionBoundGitHubDraft(context())).status).toBe('published');
      expect(restartedJournal.get('workspace-1')?.pullRequestUrl).toBe(t.receipt.html_url);
      expect(restartFetcher.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    } finally {
      restartedDb?.close();
      t.close();
    }
  });
});
