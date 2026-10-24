import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { reserveApprovedDeliveryGitTransfer } from '../src/server/delivery-approved-transfer-reservation.js';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { attestLocalReviewedGitState } from '../src/server/delivery-local-git-attestation.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { withDeliveryRepositoryLease } from '../src/server/delivery-publication-lease.js';
import { DeliveryTransferApprovalLedger } from '../src/server/delivery-transfer-approval.js';
import { recoverDeliveryWorkspaceWithTransfers } from '../src/server/delivery-workspace-recovery.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';

const branch = 'ai-office/12345678-1234-1234-1234-123456789abc';
const destination = 'https://github.com/vlovers/ai-office';
const now = () => 1000;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-approved-transfer-')));
  const path = join(root, 'repo');
  const run = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', path]);
  run('config', 'user.name', 'AI Office Test');
  run('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(path, 'README'), 'initial\n');
  run('add', 'README');
  run('commit', '-qm', 'initial');
  const baseSha = run('rev-parse', 'HEAD');
  run('checkout', '-qb', branch);
  writeFileSync(join(path, 'README'), 'reviewed\n');
  run('add', 'README');
  run('commit', '-qm', 'reviewed');
  const headSha = run('rev-parse', 'HEAD');
  run('remote', 'add', 'origin', destination);
  const repository = { path, gitDir: realpathSync(join(path, '.git')) };
  const plan = {
    allowed: true as const,
    destination,
    branch,
    baseBranch: 'main',
    revision: 'f'.repeat(64),
    draft: true as const,
  };
  const binding = {
    stage: 'commit' as const,
    operator: { operatorId: 'operator-1', sessionId: 'session-1' },
    identity: {
      workspaceId: 'workspace-1',
      operationKey: publicationKey(plan),
      destination,
      branch,
      headSha,
      baseSha,
    },
  };
  const dbPath = join(root, 'delivery.sqlite');
  const db = new DatabaseSync(dbPath);
  const approvals = new DeliveryTransferApprovalLedger(db, now);
  const transfers = new DeliveryGitTransferJournal(db);
  const verifySnapshot = async () => {
    await attestLocalReviewedGitState(plan, {
      repository,
      worktree: repository,
      workspaceGitDir: repository.gitDir,
      commits: {
        operationKey: binding.identity.operationKey,
        headCommitSha: headSha,
        baseCommitSha: baseSha,
      },
    });
  };
  const context = {
    db,
    binding,
    plan,
    repository,
    worktree: repository,
    verifySnapshot,
    now,
  };
  return {
    root,
    run,
    db,
    dbPath,
    approvals,
    transfers,
    binding,
    context,
    repository,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('approved Git transfer intent reservation', () => {
  it('atomically reserves reviewed Git transfer intent under a shared lease', async () => {
    const t = fixture();
    try {
      const approvalId = t.approvals.issue(t.binding);
      const intent = await reserveApprovedDeliveryGitTransfer({ ...t.context, approvalId });
      expect(intent.state).toBe('intent');
      expect(intent.stage).toBe('commit');
      expect(() => t.approvals.assertPending(approvalId, t.binding)).toThrow();
      const duplicate = reserveApprovedDeliveryGitTransfer({ ...t.context, approvalId });
      await expect(duplicate).rejects.toThrow();
      expect(t.transfers.get('workspace-1', 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('rejects a dirty snapshot before consuming approval or writing a journal row', async () => {
    const t = fixture();
    try {
      const approvalId = t.approvals.issue(t.binding);
      writeFileSync(join(t.repository.path, 'unreviewed.txt'), 'unexpected\n');
      await expect(
        reserveApprovedDeliveryGitTransfer({ ...t.context, approvalId }),
      ).rejects.toThrow('not clean');
      t.approvals.assertPending(approvalId, t.binding);
      expect(t.transfers.get('workspace-1', 'commit')).toBeNull();
      rmSync(join(t.repository.path, 'unreviewed.txt'));
      const resumed = await reserveApprovedDeliveryGitTransfer({ ...t.context, approvalId });
      expect(resumed.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('rolls back approval consumption when a duplicate intent is rejected', async () => {
    const t = fixture();
    try {
      const first = t.approvals.issue(t.binding);
      await reserveApprovedDeliveryGitTransfer({ ...t.context, approvalId: first });
      const second = t.approvals.issue(t.binding);
      await expect(
        reserveApprovedDeliveryGitTransfer({ ...t.context, approvalId: second }),
      ).rejects.toThrow('already exists');
      t.approvals.assertPending(second, t.binding);
      expect(t.transfers.get('workspace-1', 'commit')?.state).toBe('intent');
    } finally {
      t.close();
    }
  });

  it('requires a confirmed commit before reserving push', async () => {
    const t = fixture();
    try {
      const pushBinding = { ...t.binding, stage: 'push' as const };
      const pushApproval = t.approvals.issue(pushBinding);
      await expect(
        reserveApprovedDeliveryGitTransfer({
          ...t.context,
          binding: pushBinding,
          approvalId: pushApproval,
        }),
      ).rejects.toThrow('missing');
      t.approvals.assertPending(pushApproval, pushBinding);
      const commitApproval = t.approvals.issue(t.binding);
      await reserveApprovedDeliveryGitTransfer({ ...t.context, approvalId: commitApproval });
      t.transfers.confirmVerified('commit', t.binding.identity, t.binding.identity.headSha);
      const push = await reserveApprovedDeliveryGitTransfer({
        ...t.context,
        binding: pushBinding,
        approvalId: pushApproval,
      });
      expect(push.stage).toBe('push');
      expect(push.state).toBe('intent');
      expect(() => t.approvals.assertPending(pushApproval, pushBinding)).toThrow();
    } finally {
      t.close();
    }
  });

  it('rejects forged plans, foreign worktrees and competing leases', async () => {
    const t = fixture();
    const foreign = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-foreign-')));
    let releaseHeld!: () => void;
    let notifyHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      notifyHeld = resolve;
    });
    try {
      execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', foreign]);
      const foreignWorktree = { path: foreign, gitDir: realpathSync(join(foreign, '.git')) };
      const approvalId = t.approvals.issue(t.binding);
      await expect(
        reserveApprovedDeliveryGitTransfer({
          ...t.context,
          approvalId,
          plan: { ...t.context.plan, destination: 'https://github.com/other/repo' },
        }),
      ).rejects.toThrow('differs from the reviewed');
      await expect(
        reserveApprovedDeliveryGitTransfer({
          ...t.context,
          approvalId,
          worktree: foreignWorktree,
        }),
      ).rejects.toThrow('belongs to another repository');
      const holder = withDeliveryRepositoryLease(t.repository, t.repository.gitDir, async () => {
        notifyHeld();
        await held;
      });
      await acquired;
      try {
        await expect(
          reserveApprovedDeliveryGitTransfer({ ...t.context, approvalId }),
        ).rejects.toThrow('Resource is locked');
      } finally {
        releaseHeld();
        await holder;
      }
      t.approvals.assertPending(approvalId, t.binding);
      expect(t.transfers.get('workspace-1', 'commit')).toBeNull();
    } finally {
      releaseHeld();
      rmSync(foreign, { recursive: true, force: true });
      t.close();
    }
  });

  it('survives SQLite restart, recovers interrupted intent and never replays it', async () => {
    const t = fixture();
    try {
      const approvalId = t.approvals.issue(t.binding);
      await reserveApprovedDeliveryGitTransfer({ ...t.context, approvalId });
      t.db.close();
      const reopened = new DatabaseSync(t.dbPath);
      try {
        const approvals = new DeliveryTransferApprovalLedger(reopened, now);
        const transfers = new DeliveryGitTransferJournal(reopened);
        const journal = new DeliveryJournal(reopened);
        const recovered = await recoverDeliveryWorkspaceWithTransfers({
          journal,
          transferJournal: transfers,
          transferIdentity: t.binding.identity,
          workspaceId: t.binding.identity.workspaceId,
          operationKey: t.binding.identity.operationKey,
          repository: t.repository,
          worktree: t.repository,
        });
        expect(recovered.commit?.state).toBe('uncertain');
        expect(recovered.push).toBeNull();
        expect(recovered.publication).toBeNull();
        expect(() => approvals.assertPending(approvalId, t.binding)).toThrow();
        const newApproval = approvals.issue(t.binding);
        await expect(
          reserveApprovedDeliveryGitTransfer({
            ...t.context,
            db: reopened,
            approvalId: newApproval,
          }),
        ).rejects.toThrow('already exists');
        approvals.assertPending(newApproval, t.binding);
        expect(transfers.get('workspace-1', 'commit')?.state).toBe('uncertain');
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
});
