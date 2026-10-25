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
 * A registry lookup is read-only and runs before the Git lease. Unlike the
 * reconciliation itself, it can safely be abandoned when its resolver stalls:
 * a late resolver result is never allowed to start a Git or journal operation.
 */
async function resolveWithinDeadline(
  workspaceId: string,
  resolveWorkspace: (workspaceId: string) => Promise<GitTransferReconciliationContext | null>,
  timeoutMs: number,
): Promise<GitTransferReconciliationContext | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Git transfer registry lookup timed out.')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(() => resolveWorkspace(workspaceId)), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  options: { limit?: number; afterWorkspaceId?: string; resolveTimeoutMs?: number } = {},
): Promise<GitTransferRecoveryBatch> {
  const limit = options.limit ?? 50;
  const resolveTimeoutMs = options.resolveTimeoutMs ?? 10_000;
  if (
    !Number.isSafeInteger(resolveTimeoutMs) ||
    resolveTimeoutMs < 100 ||
    resolveTimeoutMs > 60_000
  ) {
    throw new Error('Invalid Git transfer registry lookup deadline.');
  }
  // Validate before any resolver or journal mutation.
  const page = journal.listUnresolvedWorkspaces(limit, options.afterWorkspaceId);
  const outcomes: GitTransferRecoveryOutcome[] = [];

  for (const workspaceId of page.workspaceIds) {
    let context: GitTransferReconciliationContext | null;
    try {
      context = await resolveWithinDeadline(workspaceId, resolveWorkspace, resolveTimeoutMs);
    } catch {
      // Registry outages must not erase durable intents or stop other workspaces.
      outcomes.push({ workspaceId, status: 'blocked' });
      continue;
    }

    if (!context) {
      outcomes.push({ workspaceId, status: 'unavailable' });
      continue;
    }

    try {
      // Treat registry results as a runtime trust boundary, not just a TS type.
      // A malformed or throwing identity must not abort the entire sweep.
      // The journal and workspace must match the server-discovered entry.
      if (context.journal !== journal || context.identity?.workspaceId !== workspaceId) {
        throw new Error('Recovery resolver returned a foreign workspace or journal.');
      }
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
