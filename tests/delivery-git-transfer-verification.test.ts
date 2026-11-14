import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import {
  verifyDeliveryCommitReceiptLocally,
  verifyDeliveryPushReceiptViaGitHub,
} from '../src/server/delivery-git-transfer-verification.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';

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
const approval = {
  operationKey: publicationKey(plan),
  headCommitSha: '1'.repeat(40),
  baseCommitSha: '2'.repeat(40),
};
const identity = {
  workspaceId: 'workspace-1',
  operationKey: approval.operationKey,
  destination: plan.destination,
  branch: plan.branch,
  headSha: approval.headCommitSha,
  baseSha: approval.baseCommitSha,
};

function setup() {
  const db = new DatabaseSync(':memory:');
  const journal = new DeliveryGitTransferJournal(db);
  const context = {
    journal,
    identity,
    repository: { path: '/repo', gitDir: '/repo/.git' },
    workspaceGitDir: '/repo/worktree/.git',
    plan,
    approval,
  };
  const localReview = {
    worktree: { path: '/repo/worktree', gitDir: '/repo/worktree/.git' },
    workspaceGitDir: '/repo/worktree/.git',
  };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== 'GET') throw new Error('Unexpected write');
    const branch = url.endsWith('/main') ? 'main' : plan.branch;
    return new Response(
      JSON.stringify({
        ref: `refs/heads/${branch}`,
        object: {
          type: 'commit',
          sha: branch === 'main' ? approval.baseCommitSha : approval.headCommitSha,
        },
      }),
      { status: 200 },
    );
  });
  return { db, journal, context, localReview, fetcher };
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
  acquireLocks.mockResolvedValue(async () => undefined);
  attestLocalReviewedGitState.mockResolvedValue({ ...approval });
});

describe('read-only commit and push receipt verification', () => {
  it('attests local commit and both remote refs without issuing any GitHub write', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      const commit = await verifyDeliveryCommitReceiptLocally({
        ...t.context,
        localReview: t.localReview,
      });
      expect(commit.state).toBe('confirmed');
      t.journal.begin('push', identity);
      const push = await verifyDeliveryPushReceiptViaGitHub(t.context, {
        fetcher: t.fetcher,
      });
      expect(push.state).toBe('confirmed');
      expect(t.fetcher.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'GET', 'GET']);
      expect(t.journal.assertReadyForDraft(identity)).toBeUndefined();
    } finally {
      t.db.close();
    }
  });

  it('preserves an uncertain push after GitHub 429 and allows GET-only reconciliation', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      t.journal.confirmVerified('commit', identity, identity.headSha);
      t.journal.begin('push', identity);
      t.journal.recoverWorkspace('push', identity);
      const rateLimited = vi.fn(async () => new Response('rate limited', { status: 429 }));
      await expect(
        verifyDeliveryPushReceiptViaGitHub(t.context, { fetcher: rateLimited }),
      ).rejects.toThrow('HTTP 429');
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('uncertain');
      await verifyDeliveryPushReceiptViaGitHub(t.context, { fetcher: t.fetcher });
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('confirmed');
      expect(rateLimited).toHaveBeenCalledTimes(1);
    } finally {
      t.db.close();
    }
  });

  it('rejects moved refs and malformed GitHub evidence without confirming push', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      t.journal.confirmVerified('commit', identity, identity.headSha);
      t.journal.begin('push', identity);
      const badRef = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ref: `refs/heads/${plan.branch}`,
              object: { type: 'commit', sha: '3'.repeat(40) },
            }),
            { status: 200 },
          ),
      );
      await expect(
        verifyDeliveryPushReceiptViaGitHub(t.context, { fetcher: badRef }),
      ).rejects.toThrow('head branch moved');
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('intent');
      const malformed = vi.fn(async () => new Response('{}', { status: 200 }));
      await expect(
        verifyDeliveryPushReceiptViaGitHub(t.context, { fetcher: malformed }),
      ).rejects.toThrow('Invalid GitHub commit ref response');
      expect(t.journal.get('workspace-1', 'push')?.state).toBe('intent');
    } finally {
      t.db.close();
    }
  });

  it('blocks stale review identity before local verification or network traffic', async () => {
    const t = setup();
    try {
      t.journal.begin('commit', identity);
      await expect(
        verifyDeliveryCommitReceiptLocally({
          ...t.context,
          identity: { ...identity, headSha: '4'.repeat(40) },
          localReview: t.localReview,
        }),
      ).rejects.toThrow('differs from the reviewed');
      await expect(
        verifyDeliveryPushReceiptViaGitHub(
          { ...t.context, identity: { ...identity, branch: 'main' } },
          { fetcher: t.fetcher },
        ),
      ).rejects.toThrow('differs from the reviewed');
      expect(attestLocalReviewedGitState).not.toHaveBeenCalled();
      expect(t.fetcher).not.toHaveBeenCalled();
    } finally {
      t.db.close();
    }
  });
});
