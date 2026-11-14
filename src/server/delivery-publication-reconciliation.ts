import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import {
  validatePublicationReceipt,
  type GitHubDraftReceipt,
} from './delivery-publication-receipt.js';

export type RemoteDraftCandidate = GitHubDraftReceipt;
export type ReconciliationResult =
  { status: 'confirmed'; pullRequestUrl: string } | { status: 'unresolved'; reason: string };

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
  const matching = candidates.filter((candidate) => {
    const sameHead = candidate.head.ref === plan.branch;
    const sameBase = candidate.base.ref === plan.baseBranch;
    return sameHead && sameBase;
  });
  if (matching.length !== 1) {
    return {
      status: 'unresolved',
      reason:
        matching.length === 0
          ? 'No matching remote PR found; absence does not authorize retry.'
          : 'Multiple remote PRs match; manual reconciliation required.',
    };
  }
  // A second PR using the same managed head, even with another base or
  // repository, is an ownership conflict. Preflight refuses this shape before
  // the POST; recovery must not silently adopt one receipt while ignoring the
  // other. Closed PRs count too: inventory is deliberately state=all.
  if (
    candidates.some((candidate) => candidate !== matching[0] && candidate.head.ref === plan.branch)
  ) {
    return {
      status: 'unresolved',
      reason: 'Conflicting remote PRs reuse the managed head; manual reconciliation required.',
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
