import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { DeliveryPublicationApprovalLedger } from '../src/server/delivery-publication-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { publishLocallyAttestedOperatorDraftViaGitHub } from '../src/server/delivery-publication-github-commit.js';

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
const repo = { full_name: 'vlovers/ai-office' };
const receipt = {
  number: 123,
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, sha: commits.headCommitSha, repo },
  base: { ref: 'main', sha: commits.baseCommitSha, repo },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup() {
  const db = new DatabaseSync(':memory:');
  const journal = new DeliveryJournal(db);
  const ledger = new DeliveryPublicationApprovalLedger(db);
  const approvalId = ledger.issue({ workspaceId: 'workspace-1', operator, plan, commits });
  const context = {
    journal,
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
    if (init.method === 'POST') return json(receipt, 201);
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
    title: 'Locally verified draft',
    confirmation: { ...commits, action: 'create-draft-pr' as const },
    fetcher,
  };
  return { db, journal, ledger, context, authorization, fetcher, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
  acquireLocks.mockResolvedValue(async () => undefined);
  attestLocalReviewedGitState.mockResolvedValue({});
});

describe('local Git and durable operator approval publication composition', () => {
  it('attests local Git before remote refs, consumes approval and publishes once', async () => {
    const t = setup();
    try {
      const result = await publishLocallyAttestedOperatorDraftViaGitHub(
        t.context,
        t.options,
        t.authorization,
      );
      expect(result.state).toBe('published');
      expect(attestLocalReviewedGitState).toHaveBeenCalledWith(plan, {
        ...t.context.localReview,
        repository: t.context.repository,
        commits,
      });
      expect(t.fetcher.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'GET', 'POST']);
      expect(() =>
        t.ledger.assertPending(t.authorization.approvalId, {
          workspaceId: 'workspace-1',
          operator,
          plan,
          commits,
        }),
      ).toThrow('no longer valid');
      expect(acquireLocks).toHaveBeenCalledOnce();
    } finally {
      t.db.close();
    }
  });

  it('rejects dirty local Git before any remote GET or journal reservation', async () => {
    const t = setup();
    try {
      attestLocalReviewedGitState.mockRejectedValueOnce(new Error('dirty worktree'));
      await expect(
        publishLocallyAttestedOperatorDraftViaGitHub(t.context, t.options, t.authorization),
      ).rejects.toThrow('dirty worktree');
      expect(t.fetcher).not.toHaveBeenCalled();
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

  it('rejects mismatched workspace identity before acquiring a lease', () => {
    const t = setup();
    try {
      expect(() =>
        publishLocallyAttestedOperatorDraftViaGitHub(
          {
            ...t.context,
            localReview: { ...t.context.localReview, workspaceGitDir: '/other/.git' },
          },
          t.options,
          t.authorization,
        ),
      ).toThrow('workspace identity');
      expect(acquireLocks).not.toHaveBeenCalled();
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.db.close();
    }
  });

  it('rejects an unapproved operator before local Git or GitHub requests', () => {
    const t = setup();
    try {
      expect(() =>
        publishLocallyAttestedOperatorDraftViaGitHub(t.context, t.options, {
          ...t.authorization,
          operator: { ...operator, sessionId: 'untrusted-session' },
        }),
      ).toThrow();
      expect(attestLocalReviewedGitState).not.toHaveBeenCalled();
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.db.close();
    }
  });

  it('keeps approval pending when remote refs are stale after local review', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'GET') {
          return json({
            ref: `refs/heads/${plan.branch}`,
            object: { type: 'commit', sha: '3'.repeat(40) },
          });
        }
        return original(url, init);
      });
      await expect(
        publishLocallyAttestedOperatorDraftViaGitHub(t.context, t.options, t.authorization),
      ).rejects.toThrow('head branch moved');
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

  it('never retries an ambiguous POST after consuming one-use approval', async () => {
    const t = setup();
    try {
      const original = t.fetcher.getMockImplementation()!;
      t.fetcher.mockImplementation(async (url, init) => {
        if (init.method === 'POST') throw new Error('network timeout');
        return original(url, init);
      });
      await expect(
        publishLocallyAttestedOperatorDraftViaGitHub(t.context, t.options, t.authorization),
      ).rejects.toThrow('network timeout');
      expect(t.journal.get('workspace-1')?.state).toBe('uncertain');
      expect(() =>
        publishLocallyAttestedOperatorDraftViaGitHub(t.context, t.options, t.authorization),
      ).toThrow();
      expect(t.fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
    } finally {
      t.db.close();
    }
  });
});
