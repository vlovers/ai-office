import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import {
  validatePublicationReceipt,
  type GitHubDraftReceipt,
} from './delivery-publication-receipt.js';

export type RemoteDraftCandidate = GitHubDraftReceipt;
export type ReconciliationResult =
  | { status: 'confirmed'; pullRequestUrl: string }
  | { status: 'unresolved'; reason: string };

/**
 * Read-only reconciliation after an ambiguous write. The caller must supply
 * a complete (not paginated/truncated) snapshot of open AND closed PRs.
 * An absent match never authorizes an automatic retry.
 */
export function reconcilePublicationCandidates(
  plan: DeliveryPublicationPlan,
  candidates: readonly RemoteDraftCandidate[],
): ReconciliationResult {
  if (!plan.allowed) return { status: 'unresolved', reason: plan.reason };
  const matching = candidates.filter(
    ({ head, base }) => head.ref === plan.branch && base.ref === plan.baseBranch,
  );
  if (matching.length !== 1) {
    return {
      status: 'unresolved',
      reason:
        matching.length === 0
          ? 'No matching remote PR found; absence does not authorize retry.'
          : 'Multiple remote PRs match; manual reconciliation required.',
    };
  }
  try {
    return {
      status: 'confirmed',
      pullRequestUrl: validatePublicationReceipt(plan, matching[0]!),
    };
  } catch {
    return { status: 'unresolved', reason: 'Remote PR receipt failed identity verification.' };
  }
}
