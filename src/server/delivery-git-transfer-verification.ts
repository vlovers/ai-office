import {
  attestGitHubCommitRefs,
  type ApprovedCommitSnapshot,
  type GitHubRefOptions,
} from './delivery-github-ref-attestation.js';
import {
  attestLocalReviewedGitState,
  type LocalGitReview,
} from './delivery-local-git-attestation.js';
import {
  verifyDeliveryGitTransfer,
  type DeliveryGitTransferIdentity,
  type DeliveryGitTransferJournal,
} from './delivery-git-transfer-journal.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';

type RepositoryIdentity = { path: string; gitDir: string };

export type DeliveryTransferVerificationContext = {
  journal: DeliveryGitTransferJournal;
  identity: DeliveryGitTransferIdentity;
  repository: RepositoryIdentity;
  workspaceGitDir: string;
  plan: DeliveryPublicationPlan;
  approval: ApprovedCommitSnapshot;
};

function assertReviewedIdentity(context: DeliveryTransferVerificationContext): void {
  const { plan, identity, approval } = context;
  if (
    !plan.allowed ||
    identity.operationKey !== publicationKey(plan) ||
    identity.operationKey !== approval.operationKey ||
    identity.destination !== plan.destination ||
    identity.branch !== plan.branch ||
    identity.headSha !== approval.headCommitSha ||
    identity.baseSha !== approval.baseCommitSha
  ) {
    throw new Error('Git transfer verification differs from the reviewed publication snapshot.');
  }
}

/**
 * Re-read the exact local commit and clean worktree under the shared Git lease
 * before recording a durable commit receipt. No commit command is executed.
 */
export async function verifyDeliveryCommitReceiptLocally(
  context: DeliveryTransferVerificationContext & {
    localReview: Omit<LocalGitReview, 'repository' | 'commits'>;
  },
) {
  assertReviewedIdentity(context);
  if (context.localReview.workspaceGitDir !== context.workspaceGitDir) {
    throw new Error('Commit receipt worktree differs from the workspace lease.');
  }
  return verifyDeliveryGitTransfer({ ...context, stage: 'commit' }, async () => {
    const verified = await attestLocalReviewedGitState(context.plan, {
      ...context.localReview,
      repository: context.repository,
      commits: context.approval,
    });
    return verified.headCommitSha;
  });
}

/**
 * GET-only remote push reconciliation. Verify exact head AND base GitHub refs
 * with strict repository, object type, redirect, status and SHA checks before
 * persisting the push receipt. Never infer success from a timeout or 429.
 */
export async function verifyDeliveryPushReceiptViaGitHub(
  context: DeliveryTransferVerificationContext,
  options: GitHubRefOptions = {},
) {
  assertReviewedIdentity(context);
  return verifyDeliveryGitTransfer({ ...context, stage: 'push' }, async () => {
    const attested = await attestGitHubCommitRefs(context.plan, context.approval, options);
    return attested.headCommitSha;
  });
}
