import type { DeliveryGitTransferJournal } from './delivery-git-transfer-journal.js';
import {
  reconcileGitTransferReceipts,
  type GitTransferReconciliationContext,
  type GitTransferReconciliationResult,
} from './delivery-git-transfer-reconciliation.js';

export type GitTransferRecoveryOutcome =
  | { workspaceId: string; status: 'reconciled'; result: GitTransferReconciliationResult }
  | { workspaceId: string; status: 'unavailable' | 'blocked' };

export type GitTransferRecoveryStopReason = 'aborted' | 'budget-exhausted';

export type GitTransferRecoveryBatch = {
  outcomes: GitTransferRecoveryOutcome[];
  nextCursor: string | null;
  hasMore: boolean;
  /** A stopped batch returns a resumable cursor without skipping unvisited workspaces. */
  stopReason: GitTransferRecoveryStopReason | null;
};

class RecoveryBatchInterrupted extends Error {
  constructor(readonly reason: GitTransferRecoveryStopReason) {
    super('Git transfer recovery batch ' + reason + '.');
  }
}

/**
 * A registry lookup is read-only and runs before the Git lease. Unlike the
 * reconciliation itself, it can safely be abandoned when its resolver stalls:
 * a late resolver result is never allowed to start a Git or journal operation.
 */
async function resolveWithinDeadline(
  workspaceId: string,
  resolveWorkspace: (workspaceId: string) => Promise<GitTransferReconciliationContext | null>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  batchDeadline: boolean,
): Promise<GitTransferReconciliationContext | null> {
  if (signal?.aborted) throw new RecoveryBatchInterrupted('aborted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          batchDeadline
            ? new RecoveryBatchInterrupted('budget-exhausted')
            : new Error('Git transfer registry lookup timed out.'),
        ),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RecoveryBatchInterrupted('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    const resolved = await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new RecoveryBatchInterrupted('aborted');
        return resolveWorkspace(workspaceId);
      }),
      deadline,
      aborted,
    ]);
    if (signal?.aborted) throw new RecoveryBatchInterrupted('aborted');
    return resolved;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
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
  options: {
    limit?: number;
    afterWorkspaceId?: string;
    resolveTimeoutMs?: number;
    /** Soft monotonic budget: never abandon reconciliation while it holds a Git lease. */
    batchBudgetMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<GitTransferRecoveryBatch> {
  const limit = options.limit ?? 50;
  const resolveTimeoutMs = options.resolveTimeoutMs ?? 10_000;
  const batchBudgetMs = options.batchBudgetMs ?? 60_000;
  if (
    !Number.isSafeInteger(resolveTimeoutMs) ||
    resolveTimeoutMs < 100 ||
    resolveTimeoutMs > 60_000
  ) {
    throw new Error('Invalid Git transfer registry lookup deadline.');
  }
  if (!Number.isSafeInteger(batchBudgetMs) || batchBudgetMs < 100 || batchBudgetMs > 600_000) {
    throw new Error('Invalid Git transfer recovery batch budget.');
  }
  // Validate the page before invoking any resolver or touching journal state.
  const page = journal.listUnresolvedWorkspaces(limit, options.afterWorkspaceId);
  const outcomes: GitTransferRecoveryOutcome[] = [];
  let lastProcessed: string | undefined;
  const startedAt = performance.now();
  const remainingBudget = () => Math.floor(batchBudgetMs - (performance.now() - startedAt));
  const stopped = (reason: GitTransferRecoveryStopReason): GitTransferRecoveryBatch => ({
    outcomes,
    nextCursor: lastProcessed ?? options.afterWorkspaceId ?? null,
    hasMore: true,
    stopReason: reason,
  });

  for (const workspaceId of page.workspaceIds) {
    if (options.signal?.aborted) return stopped('aborted');
    const remaining = remainingBudget();
    if (remaining <= 0) return stopped('budget-exhausted');

    let context: GitTransferReconciliationContext | null;
    try {
      context = await resolveWithinDeadline(
        workspaceId,
        resolveWorkspace,
        Math.min(resolveTimeoutMs, remaining),
        options.signal,
        remaining <= resolveTimeoutMs,
      );
    } catch (error) {
      if (error instanceof RecoveryBatchInterrupted) return stopped(error.reason);
      if (options.signal?.aborted) return stopped('aborted');
      if (remainingBudget() <= 0) return stopped('budget-exhausted');
      // A workspace-specific registry outage does not starve later workspaces.
      outcomes.push({ workspaceId, status: 'blocked' });
      lastProcessed = workspaceId;
      continue;
    }
    // A resolver can settle exactly as cancellation or the batch deadline
    // arrives. Never start an in-lease reconciliation using that stale result.
    if (options.signal?.aborted) return stopped('aborted');
    if (remainingBudget() <= 0) return stopped('budget-exhausted');

    if (!context) {
      outcomes.push({ workspaceId, status: 'unavailable' });
      lastProcessed = workspaceId;
      continue;
    }

    try {
      // Treat registry results as a runtime trust boundary, not just a TS type.
      // The journal and workspace must match the server-discovered entry.
      if (context.journal !== journal || context.identity?.workspaceId !== workspaceId) {
        throw new Error('Recovery resolver returned a foreign workspace or journal.');
      }
      // Forward operator cancellation into the read-only in-lease operation.
      // Never race the whole reconciliation against a batch timeout: doing so
      // would release control while a Git lease or journal write is still active.
      const signal =
        options.signal && context.remote.signal
          ? AbortSignal.any([options.signal, context.remote.signal])
          : (options.signal ?? context.remote.signal);
      const result = await reconcileGitTransferReceipts({
        ...context,
        remote: { ...context.remote, signal },
      });
      outcomes.push({ workspaceId, status: 'reconciled', result });
    } catch {
      // Revoked grants, lock contention and corrupt receipts are fail-closed.
      outcomes.push({ workspaceId, status: 'blocked' });
    }
    // An aborted in-lease attempt may have left this workspace uncertain.
    // Report its outcome, but do not advance the resume cursor past it.
    if (options.signal?.aborted) return stopped('aborted');
    lastProcessed = workspaceId;
  }

  return {
    outcomes,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    stopReason: null,
  };
}
