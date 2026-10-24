import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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

const { attestLocalReviewedGitState } = vi.hoisted(() => ({
  attestLocalReviewedGitState: vi.fn(async () => ({})),
}));
vi.mock('../src/server/delivery-local-git-attestation.js', () => ({
  attestLocalReviewedGitState,
}));

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main' as const,
  revision: 'a'.repeat(64),
  draft: true as const,
};
const headSha = '1'.repeat(40);
const baseSha = '2'.repeat(40);
const repo = { full_name: 'vlovers/ai-office' };
const receipt = {
  number: 123,
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, sha: headSha, repo },
  base: { ref: 'main', sha: baseSha, repo },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-session-draft-'));
  const path = join(root, 'repo');
  execFileSync('git', ['init', '-q', path]);
  const gitDir = realpathSync(join(path, '.git'));
  const db = new DatabaseSync(join(root, 'delivery.sqlite'));
  const sessions = new DeliverySessions(db, () => 10_000);
  sessions.setOperator('operator-1', true);
  sessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', true);
  const ticket = sessions.issueEnrollment('operator-1');
  const { token } = sessions.exchangeEnrollment(ticket);
  const operator = sessions.authorize(token, 'workspace-1', 'approve:draft-pr');
  const workspace = {
    workspaceId: 'workspace-1',
    repository: { path, gitDir },
    worktree: { path, gitDir },
    plan,
    headSha,
    baseSha,
  };
  const commits = {
    operationKey: publicationKey(plan),
    headCommitSha: headSha,
    baseCommitSha: baseSha,
  };
  const approvals = new DeliveryPublicationApprovalLedger(db, () => 10_000);
  const approvalId = approvals.issue({
    workspaceId: 'workspace-1',
    operator,
    plan,
    commits,
  });
  const transfers = new DeliveryGitTransferJournal(db);
  const identity = {
    workspaceId: 'workspace-1',
    operationKey: commits.operationKey,
    destination: plan.destination,
    branch: plan.branch,
    headSha,
    baseSha,
  };
  for (const stage of ['commit', 'push'] as const) {
    transfers.begin(stage, identity);
    transfers.confirmVerified(stage, identity, headSha);
  }
  const fetcher = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (init.method === 'POST') return json(receipt, 201);
    if (url.includes('/git/ref/heads/')) {
      const branch = url.endsWith('/main') ? 'main' : plan.branch;
      return json({
        ref: 'refs/heads/' + branch,
        object: { type: 'commit', sha: branch === 'main' ? baseSha : headSha },
      });
    }
    if (url.includes('/pulls?')) return json([]);
    if (url.endsWith('/pulls/123')) return json(receipt);
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
    db,
    sessions,
    approvals,
    transfers,
    fetcher,
    context,
    journal: new DeliveryJournal(db),
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('session-bound approved GitHub Draft PR executor (server only)', () => {
  it('attests both refs, inventories PRs, atomically reserves and verifies detail after one POST', async () => {
    const t = setup();
    try {
      const result = await createSessionBoundGitHubDraft(t.context());
      expect(result.status).toBe('published');
      expect(t.journal.get('workspace-1')?.pullRequestUrl).toBe(receipt.html_url);
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
      expect(t.fetcher.mock.calls.some((call) => call[0].endsWith('/pulls/123'))).toBe(true);
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('rejects revoked session/grant before GitHub access or reservation', async () => {
    const t = setup();
    try {
      t.sessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', false);
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow();
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('requires verified commit and push receipts before any GitHub call', async () => {
    const t = setup();
    try {
      t.db.prepare("DELETE FROM delivery_git_transfers WHERE stage='push'").run();
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow();
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('rejects a changed trusted registry snapshot without remote traffic', async () => {
    const t = setup();
    try {
      await expect(
        createSessionBoundGitHubDraft({
          ...t.context(),
          refreshWorkspace: async () => ({
            ...t.context().workspace,
            headSha: '3'.repeat(40),
          }),
        }),
      ).rejects.toThrow('changed since operator review');
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.close();
    }
  });

  it('does not consume approval or reserve on GitHub inventory 429', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) =>
        url.includes('/pulls?') ? json({ message: 'rate limited' }, 429) : original(url, init),
      );
      await expect(createSessionBoundGitHubDraft(t.context())).rejects.toThrow('inventory failed');
      expect(t.journal.get('workspace-1')).toBeNull();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('never repeats an ambiguous POST and requires independently verified PR detail', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') throw new Error('GitHub timeout');
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.includes('/pulls?')) return json([receipt]);
        if (url.endsWith('/pulls/123')) {
          return json({ ...receipt, head: { ...receipt.head, sha: '3'.repeat(40) } });
        }
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      t.fetcher.mockImplementation(async (url, init) => {
        if (url.includes('/pulls?')) return json([receipt]);
        return original(url, init);
      });
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('published');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('refuses the POST when operator permission is revoked at the final adapter gate', async () => {
    const t = setup();
    try {
      const original = t.context();
      const result = await createSessionBoundGitHubDraft({
        ...original,
        write: {
          ...original.write,
          authorizeBeforePost: () => {
            t.sessions.setGrant('operator-1', 'workspace-1', 'approve:draft-pr', false);
          },
        },
      });
      expect(result.status).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(0);
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
    } finally {
      t.close();
    }
  });

  it('treats invalid post-write PR detail as uncertain, not published', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) =>
        url.endsWith('/pulls/123')
          ? json({ ...receipt, base: { ...receipt.base, sha: '4'.repeat(40) } })
          : original(url, init),
      );
      expect((await createSessionBoundGitHubDraft(t.context())).status).toBe('uncertain');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.close();
    }
  });
});
