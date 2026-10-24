import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { DeliveryPublicationApprovalLedger } from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { publishReceiptedLocallyAttestedOperatorDraftViaGitHub } from '../src/server/delivery-publication-github-commit.js';

const { acquireLocks, repositoryLeaseDirectories, attestLocalReviewedGitState } = vi.hoisted(
  () => ({
    acquireLocks: vi.fn(),
    repositoryLeaseDirectories: vi.fn(),
    attestLocalReviewedGitState: vi.fn(),
  }),
);
vi.mock('../src/server/lock.js', () => ({ acquireLocks }));
vi.mock('../src/server/repositories.js', () => ({ repositoryLeaseDirectories }));
vi.mock('../src/server/delivery-local-git-attestation.js', () => ({
  attestLocalReviewedGitState,
}));

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const commits = {
  operationKey: publicationKey(plan),
  headCommitSha: '1'.repeat(40),
  baseCommitSha: '2'.repeat(40),
};
const operator = { operatorId: 'operator-1', sessionId: 'session-1' };
const identity = {
  workspaceId: 'workspace-1',
  operationKey: commits.operationKey,
  destination: plan.destination,
  branch: plan.branch,
  headSha: commits.headCommitSha,
  baseSha: commits.baseCommitSha,
};
const repo = { full_name: 'vlovers/ai-office' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup() {
  const db = new DatabaseSync(':memory:');
  const journal = new DeliveryJournal(db);
  const transferJournal = new DeliveryGitTransferJournal(db);
  const ledger = new DeliveryPublicationApprovalLedger(db);
  const approvalId = ledger.issue({ workspaceId: 'workspace-1', operator, plan, commits });
  const context = {
    journal,
    transferJournal,
    workspaceId: 'workspace-1',
    repository: { path: '/repo', gitDir: '/repo/.git' },
    workspaceGitDir: '/repo/worktree/.git',
    localReview: {
      worktree: { path: '/repo/worktree', gitDir: '/repo/worktree/.git' },
      workspaceGitDir: '/repo/worktree/.git',
    },
    plan,
    refreshPlan: async () => plan,
    approval: commits,
  };
  const authorization = { ledger, approvalId, operator };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      return json(
        {
          number: 123,
          html_url: 'https://github.com/vlovers/ai-office/pull/123',
          draft: true,
          state: 'open',
          head: { ref: plan.branch, sha: commits.headCommitSha, repo },
          base: { ref: 'main', sha: commits.baseCommitSha, repo },
        },
        201,
      );
    }
    if (url.includes('/git/ref/heads/')) {
      const branch = url.endsWith('/main') ? 'main' : plan.branch;
      return json({
        ref: `refs/heads/${branch}`,
        object: {
          type: 'commit',
          sha: branch === 'main' ? commits.baseCommitSha : commits.headCommitSha,
        },
      });
    }
    throw new Error('Unexpected GitHub request.');
  });
  const options = {
    token: 'test-token',
    title: 'Receipted draft',
    confirmation: { ...commits, action: 'create-draft-pr' as const },
    fetcher,
  };
  return { db, journal, transferJournal, ledger, context, authorization, fetcher, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
  acquireLocks.mockResolvedValue(async () => undefined);
  attestLocalReviewedGitState.mockResolvedValue({});
});

describe('commit and push receipt gate in Draft PR publication', () => {
  it('blocks missing receipts before remote GET, approval consumption or POST', async () => {
    const t = setup();
    try {
      await expect(
        publishReceiptedLocallyAttestedOperatorDraftViaGitHub(
          t.context,
          t.options,
          t.authorization,
        ),
      ).rejects.toThrow('missing');
      expect(t.fetcher).not.toHaveBeenCalled();
      expect(t.journal.get('workspace-1')).toBeNull();
    } finally {
      t.db.close();
    }
  });

  it('requires both confirmed receipts and creates one Draft PR only', async () => {
    const t = setup();
    try {
      t.transferJournal.begin('commit', identity);
      t.transferJournal.confirmVerified('commit', identity, identity.headSha);
      t.transferJournal.begin('push', identity);
      await expect(
        publishReceiptedLocallyAttestedOperatorDraftViaGitHub(
          t.context,
          t.options,
          t.authorization,
        ),
      ).rejects.toThrow('not confirmed');
      expect(t.fetcher).not.toHaveBeenCalled();
      t.transferJournal.confirmVerified('push', identity, identity.headSha);
      const result = await publishReceiptedLocallyAttestedOperatorDraftViaGitHub(
        t.context,
        t.options,
        t.authorization,
      );
      expect(result.state).toBe('published');
      expect(t.fetcher.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'GET', 'POST']);
      expect(attestLocalReviewedGitState).toHaveBeenCalledTimes(2);
    } finally {
      t.db.close();
    }
  });

  it('rejects a forged or changed receipt identity without remote traffic', async () => {
    const t = setup();
    try {
      t.transferJournal.begin('commit', { ...identity, headSha: '3'.repeat(40) });
      t.transferJournal.confirmVerified(
        'commit',
        { ...identity, headSha: '3'.repeat(40) },
        '3'.repeat(40),
      );
      await expect(
        publishReceiptedLocallyAttestedOperatorDraftViaGitHub(
          t.context,
          t.options,
          t.authorization,
        ),
      ).rejects.toThrow('belongs to another operation');
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.db.close();
    }
  });

  it('does not consume approval when remote GitHub attestation fails', async () => {
    const t = setup();
    try {
      t.transferJournal.begin('commit', identity);
      t.transferJournal.confirmVerified('commit', identity, identity.headSha);
      t.transferJournal.begin('push', identity);
      t.transferJournal.confirmVerified('push', identity, identity.headSha);
      const failing = vi.fn(async () => json({ message: 'rate limited' }, 429));
      await expect(
        publishReceiptedLocallyAttestedOperatorDraftViaGitHub(
          t.context,
          { ...t.options, fetcher: failing },
          t.authorization,
        ),
      ).rejects.toThrow('HTTP 429');
      expect(t.journal.get('workspace-1')).toBeNull();
      t.ledger.assertPending(t.authorization.approvalId, {
        workspaceId: 'workspace-1',
        operator,
        plan,
        commits,
      });
    } finally {
      t.db.close();
    }
  });
});
