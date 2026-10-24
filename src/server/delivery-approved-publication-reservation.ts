import type { DatabaseSync } from 'node:sqlite';
import { DeliveryJournal, type DeliveryJournalEntry } from './delivery-journal.js';
import {
  DeliveryPublicationApprovalLedger,
  type PublicationApprovalBinding,
} from './delivery-publication-approval.js';

/**
 * Atomic, server-only publication intent boundary.
 *
 * The approval and journal MUST share this SQLite connection. Caller holds
 * the repository lease, has independently verified the reviewed Git snapshot,
 * and supplies live authorization as a synchronous callback. This function
 * does not create a PR or enable any remote-write endpoint.
 */
export function reserveApprovedPublicationAtomically(
  db: DatabaseSync,
  approvalId: string,
  binding: PublicationApprovalBinding,
  authorizeBeforeReserve: () => void,
  now?: () => number,
): DeliveryJournalEntry {
  const approvals = new DeliveryPublicationApprovalLedger(db, now);
  const journal = new DeliveryJournal(db);
  // Validate and advance the monotonic clock outside the rollback boundary.
  approvals.assertPending(approvalId, binding);
  db.exec('BEGIN IMMEDIATE');
  try {
    const authorization: unknown = authorizeBeforeReserve();
    if (authorization && typeof (authorization as { then?: unknown }).then === 'function') {
      void Promise.resolve(authorization).catch(() => undefined);
      throw new Error('Publication authorization must be synchronous.');
    }
    approvals.consume(approvalId, binding);
    if (!binding.plan.allowed) throw new Error('Blocked publication cannot be reserved.');
    const entry = journal.reserve(binding.workspaceId, JSON.stringify([
      binding.plan.destination,
      binding.plan.branch,
      binding.plan.baseBranch,
      binding.plan.revision,
      binding.plan.draft,
    ]));
    db.exec('COMMIT');
    return entry;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
