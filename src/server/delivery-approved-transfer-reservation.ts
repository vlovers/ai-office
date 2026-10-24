import { realpath } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import {
  DeliveryGitTransferJournal,
  type DeliveryGitTransferEntry,
} from './delivery-git-transfer-journal.js';
import {
  DeliveryTransferApprovalLedger,
  type DeliveryTransferApprovalBinding,
} from './delivery-transfer-approval.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import { withDeliveryRepositoryLease } from './delivery-publication-lease.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import { git, revalidateRepository } from './repositories.js';

type RepositoryIdentity = { path: string; gitDir: string };

export type ApprovedTransferReservation = {
  db: DatabaseSync;
  approvalId: string;
  binding: DeliveryTransferApprovalBinding;
  plan: DeliveryPublicationPlan;
  repository: RepositoryIdentity;
  worktree: RepositoryIdentity;
  /** Trusted server-only callback: independently verify the reviewed snapshot. */
  verifySnapshot: () => Promise<void>;
  /** Synchronous live authorization, rechecked inside the intent transaction. */
  authorizeBeforeReserve?: () => void;
  now?: () => number;
};

function assertPlanMatchesBinding(context: ApprovedTransferReservation): void {
  const { plan, binding } = context;
  const identity = binding.identity;
  if (
    !plan.allowed ||
    identity.operationKey !== publicationKey(plan) ||
    identity.destination !== plan.destination ||
    identity.branch !== plan.branch ||
    plan.baseBranch !== 'main' ||
    identity.headSha.length !== identity.baseSha.length
  ) {
    throw new Error('Git transfer intent differs from the reviewed publication plan.');
  }
}

async function assertRegisteredWorktree(
  repository: RepositoryIdentity,
  worktree: RepositoryIdentity,
): Promise<void> {
  const currentRepository = await revalidateRepository(repository);
  const currentWorktree = await revalidateRepository(worktree);
  if (
    currentRepository.path !== repository.path ||
    currentRepository.gitDir !== repository.gitDir ||
    currentWorktree.path !== worktree.path ||
    currentWorktree.gitDir !== worktree.gitDir
  ) {
    throw new Error('Git transfer worktree identity changed before reservation.');
  }
  const args = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  const repositoryCommon = await realpath((await git(repository.path, args)).trim());
  const worktreeCommon = await realpath((await git(worktree.path, args)).trim());
  if (repositoryCommon !== worktreeCommon) {
    throw new Error('Git transfer worktree belongs to another repository.');
  }
}

/**
 * The lease holder's atomic persistence step. Keep both ledgers on the SAME
 * SQLite connection; never call an external operation before this commits.
 * This function does not acquire a lease and must only be called by trusted
 * server code already holding the common-repository lease.
 */
export function reserveApprovedTransferIntentAtomically(
  db: DatabaseSync,
  approvalId: string,
  binding: DeliveryTransferApprovalBinding,
  now?: () => number,
  authorizeBeforeReserve?: () => void,
): DeliveryGitTransferEntry {
  const approvals = new DeliveryTransferApprovalLedger(db, now);
  const journal = new DeliveryGitTransferJournal(db);
  // Keep the monotonic clock watermark if the intent transaction rolls back.
  approvals.assertPending(approvalId, binding);
  db.exec('BEGIN IMMEDIATE');
  try {
    const authorization: unknown = authorizeBeforeReserve?.();
    if (authorization && typeof (authorization as { then?: unknown }).then === 'function') {
      // A void callback can accidentally be async in TypeScript. Never proceed
      // before such a check finishes, or leave a rejection unhandled.
      void Promise.resolve(authorization).catch(() => undefined);
      throw new Error('Git transfer authorization must be synchronous.');
    }
    approvals.consume(approvalId, binding);
    const intent = journal.begin(binding.stage, binding.identity);
    db.exec('COMMIT');
    return intent;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Server-only composition point: shared Git lease + reviewed snapshot +
 * one-use operator approval + durable transfer intent.
 *
 * Approval consumption and intent reservation use ONE SQLite connection and
 * BEGIN IMMEDIATE, so either BOTH persist or NEITHER persists. A crash after
 * commit leaves an intent that cannot be blindly replayed. A failed snapshot,
 * foreign worktree, duplicate intent or missing confirmed commit blocks writes.
 *
 * This does not authenticate operators, commit, push or expose an HTTP route.
 * The caller MUST supply a trusted session binding and a concrete, read-only
 * snapshot verifier. No external write may occur inside verifySnapshot.
 */
export async function reserveApprovedDeliveryGitTransfer(
  context: ApprovedTransferReservation,
): Promise<DeliveryGitTransferEntry> {
  assertPlanMatchesBinding(context);
  const { db, binding, repository, worktree, approvalId } = context;
  return withDeliveryRepositoryLease(repository, worktree.gitDir, async () => {
    await assertRegisteredWorktree(repository, worktree);
    await context.verifySnapshot();
    await assertRegisteredWorktree(repository, worktree);
    return reserveApprovedTransferIntentAtomically(
      db,
      approvalId,
      binding,
      context.now,
      context.authorizeBeforeReserve,
    );
  });
}
