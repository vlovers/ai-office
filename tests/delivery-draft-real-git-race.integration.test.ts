import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createSessionBoundGitHubDraft } from '../src/server/delivery-approved-github-publication.js';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { DeliveryPublicationApprovalLedger } from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
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
    path,
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

describe('real Git Draft PR late-mutation integration', () => {
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
});
