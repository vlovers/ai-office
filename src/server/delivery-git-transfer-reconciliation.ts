import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import {
  attestGitHubCommitRefs,
  type GitHubRefOptions,
} from './delivery-github-ref-attestation.js';
import {
  DeliveryGitTransferJournal,
  type DeliveryGitTransferEntry,
  type DeliveryGitTransferIdentity,
} from './delivery-git-transfer-journal.js';
import { attestLocalReviewedGitState } from './delivery-local-git-attestation.js';
import { withDeliveryRepositoryLease } from './delivery-publication-lease.js';

type RepositoryIdentity = { path: string; gitDir: string };
type AllowedPlan = Extract<DeliveryPublicationPlan, { allowed: true }>;

export type GitTransferReconciliationContext = {
  journal: DeliveryGitTransferJournal;
  identity: DeliveryGitTransferIdentity;
  plan: AllowedPlan;
  /** Re-read the full trusted registry binding while holding the Git lease. */
  refreshReviewed: () => Promise<{
    plan: DeliveryPublicationPlan;
    identity: DeliveryGitTransferIdentity;
    repository: RepositoryIdentity;
    worktree: RepositoryIdentity;
  }>;
  repository: RepositoryIdentity;
  worktree: RepositoryIdentity;
  /** Trusted synchronous session/grant check, not browser-supplied code. */
  authorize: () => void;
  /** Server-owned read-only GitHub credential and transport. */
  remote: GitHubRefOptions;
  /** Bounds both remote GETs, even when an injected transport ignores abort. */
  remoteDeadlineMs?: number;
  /** Bounds each read-only registry refresh while the shared Git lease is held. */
  refreshDeadlineMs?: number;
};

type Receipts = {
  commit: DeliveryGitTransferEntry | null;
  push: DeliveryGitTransferEntry | null;
};

export type GitTransferReconciliationResult =
  | (Receipts & { status: 'no-intent' | 'commit-confirmed' | 'ready' })
  | (Receipts & { status: 'blocked'; stage: 'commit' | 'push' });

function assertSynchronousAuthorization(authorize: () => void): void {
  const result: unknown = authorize();
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error('Git transfer authorization must be synchronous.');
  }
}

async function attestRemoteWithinDeadline(
  plan: AllowedPlan,
  identity: DeliveryGitTransferIdentity,
  options: GitHubRefOptions,
  deadlineMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 60_000) {
    throw new Error('Invalid Git transfer reconciliation deadline.');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectExternalAbort: ((reason: Error) => void) | undefined;
  // An injected fetcher may ignore AbortSignal. Cancellation must therefore
  // reject the attestation race itself, not merely signal the transport.
  const externalAbort = new Promise<never>((_resolve, reject) => {
    rejectExternalAbort = reject;
  });
  const abort = () => {
    controller.abort();
    rejectExternalAbort?.(new Error('Git transfer reconciliation aborted.'));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    // Covers aborts that raced with listener registration.
    if (options.signal?.aborted) abort();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Git transfer reconciliation timed out.'));
      }, deadlineMs);
    });
    await Promise.race([
      attestGitHubCommitRefs(
        plan,
        {
          operationKey: identity.operationKey,
          headCommitSha: identity.headSha,
          baseCommitSha: identity.baseSha,
        },
        { ...options, signal: controller.signal },
      ),
      deadline,
      externalAbort,
    ]);
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new Error('Git transfer reconciliation aborted.');
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * A registry refresh is a read-only trust check. Bound it independently of
 * GitHub GETs: a hung registry must not hold the shared Git lease forever.
 * Late results are ignored and can never authorize a journal transition.
 */
async function refreshReviewedWithinDeadline(
  context: GitTransferReconciliationContext,
  deadlineMs: number,
): Promise<Awaited<ReturnType<GitTransferReconciliationContext['refreshReviewed']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(new Error('Git transfer registry refresh aborted.'));
  context.remote.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (context.remote.signal?.aborted) onAbort();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Git transfer registry refresh timed out.')),
        deadlineMs,
      );
    });
    const reviewed = await Promise.race([
      Promise.resolve().then(() => {
        if (context.remote.signal?.aborted) {
          throw new Error('Git transfer registry refresh aborted.');
        }
        return context.refreshReviewed();
      }),
      deadline,
      aborted,
    ]);
    if (context.remote.signal?.aborted) {
      throw new Error('Git transfer registry refresh aborted.');
    }
    return reviewed;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    context.remote.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Reconcile existing commit/push intents using only local Git reads and exact
 * remote ref GETs. No commit, push, PR POST, retry or new intent is possible.
 *
 * The shared repository/worktree lease protects every state transition.
 * A crash or ambiguous result leaves the existing intent uncertain. Missing
 * intents are NEVER fabricated from a matching local or remote SHA.
 *
 * Caller must supply the trusted registry snapshot, session check and
 * server-owned GitHub transport; do not expose this through an HTTP route.
 */
export async function reconcileGitTransferReceipts(
  context: GitTransferReconciliationContext,
): Promise<GitTransferReconciliationResult> {
  const { identity, plan, journal } = context;
  if (
    !plan.allowed ||
    identity.operationKey !== publicationKey(plan) ||
    identity.destination !== plan.destination ||
    identity.branch !== plan.branch
  ) {
    throw new Error('Git transfer reconciliation differs from the reviewed operation.');
  }
  const deadlineMs = context.remoteDeadlineMs ?? 15_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 60_000) {
    throw new Error('Invalid Git transfer reconciliation deadline.');
  }
  const refreshDeadlineMs = context.refreshDeadlineMs ?? 10_000;
  if (
    !Number.isSafeInteger(refreshDeadlineMs) ||
    refreshDeadlineMs < 100 ||
    refreshDeadlineMs > 60_000
  ) {
    throw new Error('Invalid Git transfer registry refresh deadline.');
  }
  const assertFreshPlan = async (): Promise<void> => {
    const reviewed = await refreshReviewedWithinDeadline(context, refreshDeadlineMs);
    const refreshed = reviewed.plan;
    const owner = reviewed.identity;
    if (
      !refreshed.allowed ||
      publicationKey(refreshed) !== identity.operationKey ||
      owner.workspaceId !== identity.workspaceId ||
      owner.operationKey !== identity.operationKey ||
      owner.destination !== identity.destination ||
      owner.branch !== identity.branch ||
      owner.headSha !== identity.headSha ||
      owner.baseSha !== identity.baseSha ||
      reviewed.repository.path !== context.repository.path ||
      reviewed.repository.gitDir !== context.repository.gitDir ||
      reviewed.worktree.path !== context.worktree.path ||
      reviewed.worktree.gitDir !== context.worktree.gitDir
    ) {
      throw new Error('Reviewed Git transfer registry binding changed during reconciliation.');
    }
  };
  const assertNotAborted = (): void => {
    if (context.remote.signal?.aborted) {
      throw new Error('Git transfer reconciliation aborted.');
    }
  };
  assertSynchronousAuthorization(context.authorize);
  assertNotAborted();
  return withDeliveryRepositoryLease(
    context.repository,
    context.worktree.gitDir,
    async (): Promise<GitTransferReconciliationResult> => {
      assertSynchronousAuthorization(context.authorize);
      await assertFreshPlan();
      assertSynchronousAuthorization(context.authorize);
      assertNotAborted();
      const current = (): Receipts => ({
        commit: journal.get(identity.workspaceId, 'commit'),
        push: journal.get(identity.workspaceId, 'push'),
      });
      const existing = current();
      if (!existing.commit && !existing.push) {
        return { status: 'no-intent', ...existing };
      }
      if (existing.commit) journal.assertOwned('commit', identity);
      if (existing.push) journal.assertOwned('push', identity);
      // Legacy databases may contain conflicting owners from before the
      // atomic SQLite triggers. Do not mutate or attest either owner until
      // the conflict has been investigated.
      journal.assertExclusiveOwnership(identity);
      if (
        existing.commit?.state === 'confirmed' &&
        existing.commit.receiptSha !== identity.headSha
      ) {
        throw new Error('Confirmed commit receipt conflicts with the reviewed head.');
      }
      if (existing.push) {
        if (
          existing.commit?.state !== 'confirmed' ||
          existing.commit.receiptSha !== identity.headSha
        ) {
          throw new Error('Push intent exists without an independently confirmed commit receipt.');
        }
        if (existing.push.state === 'confirmed' && existing.push.receiptSha !== identity.headSha) {
          throw new Error('Confirmed push receipt conflicts with the reviewed head.');
        }
      }
      // Do not globally recover other workspaces or infer that a missing
      // remote ref authorizes another push.
      if (existing.commit) journal.recoverWorkspace('commit', identity);
      if (existing.push) journal.recoverWorkspace('push', identity);

      try {
        await attestLocalReviewedGitState(plan, {
          repository: context.repository,
          worktree: context.worktree,
          workspaceGitDir: context.worktree.gitDir,
          commits: {
            operationKey: identity.operationKey,
            headCommitSha: identity.headSha,
            baseCommitSha: identity.baseSha,
          },
        });
        assertSynchronousAuthorization(context.authorize);
        await assertFreshPlan();
        assertSynchronousAuthorization(context.authorize);
        assertNotAborted();
        // Recheck after async Git and registry reads: a legacy conflict may
        // have appeared while the lease was held by this process.
        journal.assertExclusiveOwnership(identity);
        journal.confirmVerified('commit', identity, identity.headSha);
      } catch {
        return { status: 'blocked', stage: 'commit', ...current() };
      }
      if (!existing.push) return { status: 'commit-confirmed', ...current() };

      try {
        assertSynchronousAuthorization(context.authorize);
        await attestRemoteWithinDeadline(plan, identity, context.remote, deadlineMs);
        assertSynchronousAuthorization(context.authorize);
        await assertFreshPlan();
        assertSynchronousAuthorization(context.authorize);
        assertNotAborted();
        journal.assertExclusiveOwnership(identity);
        journal.confirmVerified('push', identity, identity.headSha);
      } catch {
        return { status: 'blocked', stage: 'push', ...current() };
      }
      return { status: 'ready', ...current() };
    },
  );
}
