import type { DatabaseSync } from 'node:sqlite';
import { reserveApprovedPublicationAtomically } from './delivery-approved-publication-reservation.js';
import {
  createDraftPublication,
  type DraftPublicationContext,
  type DraftPublicationResult,
} from './delivery-draft-pr-orchestration.js';
import { DeliveryJournal } from './delivery-journal.js';
import type { PublicationApprovalBinding } from './delivery-publication-approval.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';

type AllowedPlan = Extract<DeliveryPublicationPlan, { allowed: true }>;

export type ApprovedDraftPublicationContext = Omit<
  DraftPublicationContext,
  'journal' | 'reserveApproved' | 'verifySnapshot' | 'verifyBeforeReserve' | 'verifyRemoteReceipt'
> & {
  db: DatabaseSync;
  approvalId: string;
  binding: PublicationApprovalBinding;
  /** Trusted server-side verification of the exact reviewed head/base snapshot. */
  verifyApprovedSnapshot: (plan: AllowedPlan, binding: PublicationApprovalBinding) => Promise<void>;
  /** Required post-inventory local/registry check before consuming one-use approval. */
  verifyBeforeReserve: (plan: AllowedPlan) => Promise<void>;
  /** Required independent PR-detail/commit-SHA verification before accepting any receipt. */
  verifyRemoteReceipt: (plan: AllowedPlan, url: string) => Promise<void>;
  /** Must check the operator's live session and grant synchronously inside SQLite. */
  authorizeBeforeReserve: () => void;
  now?: () => number;
};

/**
 * Authenticated server-only composition point. This is NOT an HTTP endpoint.
 *
 * The Draft PR orchestrator holds the shared Git lease while it refreshes the
 * plan, verifies the reviewed snapshot, enumerates the complete remote PR
 * inventory and calls reserveApproved. Approval consumption and journal
 * reservation commit together on one SQLite connection before the external
 * createDraft call. An interrupted write is reconciled, never blindly retried.
 *
 * A trusted caller must provide a genuine operator-bound approval, a snapshot
 * verifier, live authorization and a single-attempt GitHub adapter. Do not
 * expose this function through an unreviewed browser route.
 */
export async function createApprovedDraftPublication(
  context: ApprovedDraftPublicationContext,
): Promise<DraftPublicationResult> {
  const { db, binding, workspaceId, initialPlan } = context;
  // A trusted approval is not enough: never accept inventory-only PR receipts
  // or consume approval after asynchronous inventory without final attestation.
  if (
    typeof context.verifyBeforeReserve !== 'function' ||
    typeof context.verifyRemoteReceipt !== 'function'
  ) {
    throw new Error('Approved Draft publication requires final snapshot and PR detail verification.');
  }
  if (!binding.plan.allowed) {
    throw new Error('Publication approval differs from the reviewed workspace.');
  }
  const approvedKey = publicationKey(binding.plan);
  if (
    binding.workspaceId !== workspaceId ||
    binding.commits.operationKey !== approvedKey ||
    approvedKey !== publicationKey(initialPlan)
  ) {
    throw new Error('Publication approval differs from the reviewed workspace.');
  }
  const assertBinding = (plan: AllowedPlan): void => {
    if (publicationKey(plan) !== approvedKey) {
      throw new Error('Refreshed publication plan differs from approved operation.');
    }
  };
  // Even receipt reuse and read-only reconciliation require a live session.
  // The atomic reservation independently repeats this check inside SQLite.
  const authorization: unknown = context.authorizeBeforeReserve();
  if (authorization && typeof (authorization as { then?: unknown }).then === 'function') {
    void Promise.resolve(authorization).catch(() => undefined);
    throw new Error('Publication authorization must be synchronous.');
  }
  return createDraftPublication({
    workspaceId,
    repository: context.repository,
    workspaceGitDir: context.workspaceGitDir,
    journal: new DeliveryJournal(db),
    initialPlan,
    refreshPlan: context.refreshPlan,
    listRemote: context.listRemote,
    createDraft: context.createDraft,
    verifyRemoteReceipt: context.verifyRemoteReceipt,
    verifyBeforeReserve: context.verifyBeforeReserve,
    verifySnapshot: async (plan) => {
      assertBinding(plan);
      await context.verifyApprovedSnapshot(plan, binding);
    },
    reserveApproved: (plan) => {
      assertBinding(plan);
      return reserveApprovedPublicationAtomically(
        db,
        context.approvalId,
        binding,
        context.authorizeBeforeReserve,
        context.now,
      );
    },
  });
}
