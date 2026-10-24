import {
  createCommitAttestedGitHubDraft,
  validateGitHubDraftWrite,
  type GitHubDraftWriteOptions,
} from './delivery-github-draft-write.js';
import {
  listAllGitHubPullRequests,
  type ReadOnlyGitHubOptions,
} from './delivery-github-readonly.js';
import {
  DeliveryPublicationApprovalLedger,
  type TrustedDeliveryOperator,
} from './delivery-publication-approval.js';
import type { ApprovedCommitSnapshot } from './delivery-github-ref-attestation.js';
import {
  attestLocalReviewedGitState,
  type LocalGitReview,
} from './delivery-local-git-attestation.js';
import {
  publishCommitAttestedDraft,
  reconcileCommitAttestedDraft,
  type DeliveryPublicationContext,
} from './delivery-publication-service.js';

/**
 * Server-only integration. Never expose this directly as an HTTP handler.
 * The confirmation must come from the server's verified operator-approval
 * record, not from arbitrary browser JSON.
 *
 * No local commit or push is performed. Both reviewed commits MUST already
 * exist at the expected GitHub refs, as checked inside the shared lease.
 */
export function publishCommitAttestedDraftViaGitHub(
  context: DeliveryPublicationContext & {
    approval: ApprovedCommitSnapshot;
    /** Trusted local verification hook; never source it from HTTP JSON. */
    verifyLocalGitState?: (
      plan: Extract<DeliveryPublicationContext['plan'], { allowed: true }>,
    ) => Promise<void>;
    /** Server-owned authorization hook; never bind to untrusted HTTP input. */
    authorizeBeforeReserve?: (
      plan: Extract<DeliveryPublicationContext['plan'], { allowed: true }>,
    ) => Promise<void> | void;
  },
  options: GitHubDraftWriteOptions,
) {
  // Fail before lock, remote GET or SQLite reservation on missing authorization.
  validateGitHubDraftWrite(context.plan, context.approval, options);
  return publishCommitAttestedDraft({
    ...context,
    gitHubRefOptions: {
      token: options.token,
      fetcher: options.fetcher,
      signal: options.signal,
    },
    createDraft: (plan, attestation) => createCommitAttestedGitHubDraft(plan, attestation, options),
  });
}

/**
 * Read-only, commit-pinned recovery of a possibly successful POST.
 * Requires complete GitHub PR discovery AND a fresh PR-detail SHA check.
 * No automatic second POST, including when no matching PR is found.
 */
export function reconcileCommitAttestedDraftViaGitHub(
  context: DeliveryPublicationContext & { approval: ApprovedCommitSnapshot },
  options: ReadOnlyGitHubOptions = {},
) {
  return reconcileCommitAttestedDraft({
    ...context,
    gitHubRefOptions: {
      token: options.token,
      fetcher: options.fetcher,
      signal: options.signal,
    },
    listAllRemoteDrafts: (plan) => listAllGitHubPullRequests(plan, options),
  });
}

/**
 * Server-only authorized entrypoint. The ledger approval must have been
 * issued after independently authenticated operator review and local Git
 * verification. It is bound to the operator session, workspace, plan and
 * both exact commits, and consumed atomically under the shared Git lease.
 *
 * This does not register an HTTP route or grant browser-provided identities
 * any authority. An uncertain POST must still be reconciled read-only.
 */
export function publishOperatorAuthorizedDraftViaGitHub(
  context: DeliveryPublicationContext & { approval: ApprovedCommitSnapshot },
  options: GitHubDraftWriteOptions,
  authorization: {
    ledger: DeliveryPublicationApprovalLedger;
    approvalId: string;
    operator: TrustedDeliveryOperator;
  },
) {
  const binding = {
    workspaceId: context.workspaceId,
    operator: authorization.operator,
    plan: context.plan,
    commits: context.approval,
  };
  // Fail closed before lock acquisition or even GitHub GET.
  validateGitHubDraftWrite(context.plan, context.approval, options);
  authorization.ledger.assertPending(authorization.approvalId, binding);
  return publishCommitAttestedDraftViaGitHub(
    {
      ...context,
      authorizeBeforeReserve: (currentPlan) =>
        authorization.ledger.consume(authorization.approvalId, {
          ...binding,
          plan: currentPlan,
        }),
    },
    options,
  );
}

/**
 * Complete server-only review composition: one-use operator approval,
 * independently verified local worktree, remote commit SHA attestation,
 * durable journal reservation and exactly one Draft PR POST.
 *
 * Authentication and commit/push approvals must still be established by a
 * separate trusted server layer. This function is NOT an HTTP endpoint.
 */
export function publishLocallyAttestedOperatorDraftViaGitHub(
  context: DeliveryPublicationContext & {
    approval: ApprovedCommitSnapshot;
    /** Trusted local verification hook; never source it from HTTP JSON. */
    verifyLocalGitState?: (
      plan: Extract<DeliveryPublicationContext['plan'], { allowed: true }>,
    ) => Promise<void>;
    localReview: Omit<LocalGitReview, 'commits' | 'repository'>;
  },
  options: GitHubDraftWriteOptions,
  authorization: {
    ledger: DeliveryPublicationApprovalLedger;
    approvalId: string;
    operator: TrustedDeliveryOperator;
  },
) {
  validateGitHubDraftWrite(context.plan, context.approval, options);
  if (context.localReview.workspaceGitDir !== context.workspaceGitDir) {
    throw new Error('Local review workspace identity does not match the publication lease.');
  }
  return publishOperatorAuthorizedDraftViaGitHub(
    {
      ...context,
      verifyLocalGitState: async (plan) => {
        await attestLocalReviewedGitState(plan, {
          ...context.localReview,
          repository: context.repository,
          commits: context.approval,
        });
      },
    },
    options,
    authorization,
  );
}
