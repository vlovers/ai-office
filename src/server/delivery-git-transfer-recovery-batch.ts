import type { DeliveryGitTransferJournal } from './delivery-git-transfer-journal.js';
import {
  reconcileGitTransferReceipts,
  type GitTransferReconciliationContext,
  type GitTransferReconciliationResult,
} from './delivery-git-transfer-reconciliation.js';

export type GitTransferRecoveryOutcome =
  | { workspaceId: string; status: 'reconciled'; result: GitTransferReconciliationResult }
  | { workspaceId: string; status: 'unavailable' | 'blocked' };

export type GitTransferRecoveryBatch = {
  outcomes: GitTransferRecoveryOutcome[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * A bounded, operator-initiated recovery sweep. Discovery is read-only; each
 * individual reconciliation acquires the same Git lease as publication.
 *
 * The resolver MUST read the trusted server registry and return a context
 * with a live synchronous authorization check. It must never accept a browser
 * supplied identity, repository path, token, or authorization callback.
 *
 * No new intent, Git mutation, GitHub POST, or retry is performed here.
 * A missing workspace is reported but never removed from the journal.
 */
export async function recoverUnresolvedGitTransfers(
  journal: DeliveryGitTransferJournal,
  resolveWorkspace: (workspaceId: string) => Promise<GitTransferReconciliationContext | null>,
  options: { limit?: number; afterWorkspaceId?: string } = {},
): Promise<GitTransferRecoveryBatch> {
  const limit = options.limit ?? 50;
  // Validate before any resolver or journal mutation.
  const page = journal.listUnresolvedWorkspaces(limit, options.afterWorkspaceId);
  const outcomes: GitTransferRecoveryOutcome[] = [];

  for (const workspaceId of page.workspaceIds) {
    let context: GitTransferReconciliationContext | null;
    try {
      context = await resolveWorkspace(workspaceId);
    } catch {
      // Registry outages must not erase durable intents or stop other workspaces.
      outcomes.push({ workspaceId, status: 'blocked' });
      continue;
    }

    if (!context) {
      outcomes.push({ workspaceId, status: 'unavailable' });
      continue;
    }

    // The journal and identity must be exactly those discovered by the server.
    // A resolver cannot swap in another database or reconcile another workspace.
    if (context.journal !== journal || context.identity.workspaceId !== workspaceId) {
      outcomes.push({ workspaceId, status: 'blocked' });
      continue;
    }

    try {
      const result = await reconcileGitTransferReceipts(context);
      outcomes.push({ workspaceId, status: 'reconciled', result });
    } catch {
      // Authorization failure, lock contention, stale registry and corrupt
      // receipts are fail-closed. Other workspaces can still be inspected.
      outcomes.push({ workspaceId, status: 'blocked' });
    }
  }

  return {
    outcomes,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}
