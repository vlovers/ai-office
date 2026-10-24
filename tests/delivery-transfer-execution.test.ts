import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { DeliveryTransferApprovalLedger } from '../src/server/delivery-transfer-approval.js';
import { executeAuthorizedTransferStage } from '../src/server/delivery-transfer-execution.js';

const { acquireLocks, repositoryLeaseDirectories } = vi.hoisted(() => ({
  acquireLocks: vi.fn(),
  repositoryLeaseDirectories: vi.fn(),
}));
vi.mock('../src/server/lock.js', () => ({ acquireLocks }));
vi.mock('../src/server/repositories.js', () => ({ repositoryLeaseDirectories }));

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const operator = { operatorId: 'operator-1', sessionId: 'session-1' };
const identity = {
  workspaceId: 'workspace-1',
  operationKey: publicationKey(plan),
  destination: plan.destination,
  branch: plan.branch,
  headSha: '1'.repeat(40),
  baseSha: '2'.repeat(40),
};

function setup(stage: 'commit' | 'push' = 'commit') {
  const db = new DatabaseSync(':memory:');
  const transferJournal = new DeliveryGitTransferJournal(db);
  const approvalLedger = new DeliveryTransferApprovalLedger(db, () => 1000);
  const binding = { stage, identity, operator };
  const approvalId = approvalLedger.issue(binding);
  const verifyLocalGitState = vi.fn(async () => undefined);
  const performOnce = vi.fn(async () => undefined);
  const verifyReceiptReadOnly = vi.fn(async () => identity.headSha);
  const context = {
    repository: { path: '/repo', gitDir: '/repo/.git' },
    workspaceGitDir: '/repo/worktree/.git',
    plan,
    refreshPlan: async () => plan,
    transferJournal,
    approvalLedger,
    approvalId,
    binding,
    verifyLocalGitState,
    performOnce,
    verifyReceiptReadOnly,
  };
  return {
    db,
    context,
    transferJournal,
    approvalLedger,
    verifyLocalGitState,
    performOnce,
    verifyReceiptReadOnly,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryLeaseDirectories.mockResolvedValue(['/repo/.git']);
  acquireLocks.mockResolvedValue(async () => undefined);
});

describe('leased one-use Git transfer execution', () => {
  it('attests, consumes, reserves, performs once and independently confirms a commit', async () => {
    const t = setup();
    try {
      const receipt = await executeAuthorizedTransferStage(t.context);
      expect(receipt.state).toBe('confirmed');
      expect(receipt.receiptSha).toBe(identity.headSha);
      expect(t.verifyLocalGitState).toHaveBeenCalledTimes(1);
      expect(t.performOnce).toHaveBeenCalledTimes(1);
      expect(t.verifyReceiptReadOnly).toHaveBeenCalledTimes(1);
      expect(() =>
        t.approvalLedger.assertPending(t.context.approvalId, t.context.binding),
      ).toThrow();
      await expect(executeAuthorizedTransferStage(t.context)).rejects.toThrow();
      expect(t.performOnce).toHaveBeenCalledTimes(1);
    } finally {
      t.db.close();
    }
  });

  it('refuses push without independently confirmed matching commit', async () => {
    const t = setup('push');
    try {
      await expect(executeAuthorizedTransferStage(t.context)).rejects.toThrow('missing');
      expect(t.performOnce).not.toHaveBeenCalled();
      t.approvalLedger.assertPending(t.context.approvalId, t.context.binding);
      t.transferJournal.begin('commit', identity);
      t.transferJournal.confirmVerified('commit', identity, identity.headSha);
      const receipt = await executeAuthorizedTransferStage(t.context);
      expect(receipt.stage).toBe('push');
      expect(receipt.state).toBe('confirmed');
      expect(t.performOnce).toHaveBeenCalledTimes(1);
    } finally {
      t.db.close();
    }
  });

  it('preserves uncertainty after an external timeout and never replays', async () => {
    const t = setup();
    try {
      t.performOnce.mockRejectedValueOnce(new Error('GitHub HTTP 429'));
      await expect(executeAuthorizedTransferStage(t.context)).rejects.toThrow('429');
      expect(t.transferJournal.get(identity.workspaceId, 'commit')?.state).toBe('uncertain');
      expect(t.verifyReceiptReadOnly).not.toHaveBeenCalled();
      await expect(executeAuthorizedTransferStage(t.context)).rejects.toThrow();
      expect(t.performOnce).toHaveBeenCalledTimes(1);
    } finally {
      t.db.close();
    }
  });

  it('treats a wrong read-only SHA as uncertain, not a successful transfer', async () => {
    const t = setup();
    try {
      t.verifyReceiptReadOnly.mockResolvedValueOnce('3'.repeat(40));
      await expect(executeAuthorizedTransferStage(t.context)).rejects.toThrow('does not match');
      expect(t.transferJournal.get(identity.workspaceId, 'commit')?.state).toBe('uncertain');
      expect(t.performOnce).toHaveBeenCalledTimes(1);
      await expect(executeAuthorizedTransferStage(t.context)).rejects.toThrow();
      expect(t.performOnce).toHaveBeenCalledTimes(1);
    } finally {
      t.db.close();
    }
  });

  it('rejects stale leased snapshots before consuming approval or writing', async () => {
    const t = setup();
    try {
      const changed = { ...plan, revision: 'b'.repeat(64) };
      await expect(
        executeAuthorizedTransferStage({
          ...t.context,
          refreshPlan: async () => changed,
        }),
      ).rejects.toThrow('snapshot changed');
      expect(t.performOnce).not.toHaveBeenCalled();
      expect(t.transferJournal.get(identity.workspaceId, 'commit')).toBeNull();
      t.approvalLedger.assertPending(t.context.approvalId, t.context.binding);
    } finally {
      t.db.close();
    }
  });

  it('rejects failed local review before any stage intent or external operation', async () => {
    const t = setup();
    try {
      t.verifyLocalGitState.mockRejectedValueOnce(new Error('worktree dirty'));
      await expect(executeAuthorizedTransferStage(t.context)).rejects.toThrow('worktree dirty');
      expect(t.transferJournal.get(identity.workspaceId, 'commit')).toBeNull();
      expect(t.performOnce).not.toHaveBeenCalled();
      t.approvalLedger.assertPending(t.context.approvalId, t.context.binding);
    } finally {
      t.db.close();
    }
  });
});
