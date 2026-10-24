import type { DatabaseSync } from 'node:sqlite';
import { reserveApprovedTransferIntentAtomically } from './delivery-approved-transfer-reservation.js';
import {
  DeliveryGitTransferJournal,
  type DeliveryGitTransferIdentity,
} from './delivery-git-transfer-journal.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import { withPublicationLease } from './delivery-publication-lease.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import {
  DeliveryTransferApprovalLedger,
  type DeliveryTransferApprovalBinding,
} from './delivery-transfer-approval.js';

type AllowedPlan = Extract<DeliveryPublicationPlan, { allowed: true }>;

export type AuthorizedTransferContext = {
  /** Both approval and transfer journal MUST share this exact SQLite connection. */
  db: DatabaseSync;
  now?: () => number;
  repository: { path: string; gitDir: string };
  workspaceGitDir: string;
  plan: DeliveryPublicationPlan;
  refreshPlan: () => Promise<DeliveryPublicationPlan>;
  approvalId: string;
  binding: DeliveryTransferApprovalBinding;
  /**
   * Trusted server-owned independent review attestation. Must check the exact
   * workspace, worktree, head/base SHAs and clean snapshot under the Git lease.
   * Never implement this by trusting request JSON.
   */
  verifyLocalGitState: (plan: AllowedPlan, identity: DeliveryGitTransferIdentity) => Promise<void>;
  /**
   * Exactly one external commit OR push. Must be a trusted server adapter;
   * never call this function from a browser or an unauthenticated HTTP route.
   */
  performOnce: () => Promise<void>;
  /** Independently verify the local commit or remote ref, read-only. */
  verifyReceiptReadOnly: () => Promise<string>;
};

/**
 * Server-only composition: shared Git lease -> refreshed review -> approval
 * consumption -> durable stage intent -> one external attempt -> read-only
 * verification -> exact SHA receipt. Any ambiguous outcome stays uncertain.
 *
 * A caller must authenticate the operator before issuing the approval and
 * must not retry this function after a crash or external timeout. This module
 * deliberately registers no HTTP route and does not contain a Git executor.
 */
export async function executeAuthorizedTransferStage(context: AuthorizedTransferContext) {
  const { binding, plan } = context;
  if (!plan.allowed) throw new Error('Blocked Git transfer publication plan.');
  const key = publicationKey(plan);
  if (
    binding.identity.operationKey !== key ||
    binding.identity.destination !== plan.destination ||
    binding.identity.branch !== plan.branch
  ) {
    throw new Error('Git transfer identity does not match the reviewed publication plan.');
  }

  const approvals = new DeliveryTransferApprovalLedger(context.db, context.now);
  const transferJournal = new DeliveryGitTransferJournal(context.db);
  // Reject invalid or expired approvals before any Git lease or remote access.
  approvals.assertPending(context.approvalId, binding);
  return withPublicationLease(
    context.repository,
    context.workspaceGitDir,
    { status: 'requires-lease', operationKey: key },
    context.refreshPlan,
    async (currentPlan) => {
      // The plan is re-read while holding the common-repository lease.
      if (
        binding.identity.destination !== currentPlan.destination ||
        binding.identity.branch !== currentPlan.branch
      ) {
        throw new Error('Git transfer destination changed during lease acquisition.');
      }
      await context.verifyLocalGitState(currentPlan, binding.identity);
      if (transferJournal.get(binding.identity.workspaceId, binding.stage)) {
        throw new Error('Git transfer stage already has a durable intent; reconcile before retry.');
      }
      if (binding.stage === 'push') {
        transferJournal.assertConfirmed('commit', binding.identity);
      }
      // Consume approval and reserve the intent in one BEGIN IMMEDIATE
      // transaction on the same SQLite connection. A crash can no longer
      // persist only the consumed approval without its durable intent.
      reserveApprovedTransferIntentAtomically(context.db, context.approvalId, binding, context.now);
      try {
        await context.performOnce();
        const verifiedSha = await context.verifyReceiptReadOnly();
        return transferJournal.confirmVerified(binding.stage, binding.identity, verifiedSha);
      } catch (error) {
        // A timeout or malformed receipt is never evidence of failure.
        transferJournal.markUncertain(binding.stage, binding.identity);
        throw error;
      }
    },
  );
}
