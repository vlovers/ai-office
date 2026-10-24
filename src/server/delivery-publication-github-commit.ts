import {
  createCommitAttestedGitHubDraft,
  validateGitHubDraftWrite,
  type GitHubDraftWriteOptions,
} from './delivery-github-draft-write.js';
import {
  listAllGitHubPullRequests,
  type ReadOnlyGitHubOptions,
} from './delivery-github-readonly.js';
import type { ApprovedCommitSnapshot } from './delivery-github-ref-attestation.js';
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
  context: DeliveryPublicationContext & { approval: ApprovedCommitSnapshot },
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
