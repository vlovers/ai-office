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
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw new Error('Git transfer reconciliation aborted.');
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
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
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
  const assertFreshPlan = async (): Promise<void> => {
    const reviewed = await context.refreshReviewed();
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
  assertSynchronousAuthorization(context.authorize);
  return withDeliveryRepositoryLease(
    context.repository,
    context.worktree.gitDir,
    async (): Promise<GitTransferReconciliationResult> => {
      assertSynchronousAuthorization(context.authorize);
      await assertFreshPlan();
      assertSynchronousAuthorization(context.authorize);
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
        journal.confirmVerified('push', identity, identity.headSha);
      } catch {
        return { status: 'blocked', stage: 'push', ...current() };
      }
      return { status: 'ready', ...current() };
    },
  );
}
