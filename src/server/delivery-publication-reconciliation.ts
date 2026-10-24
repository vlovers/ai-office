import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import { validatePublicationReceipt } from './delivery-publication-receipt.js';

export type RemoteDraftCandidate = {
  html_url: string;
  draft: boolean;
  state: string;
  head: { ref: string };
  base: { ref: string };
};

export type ReconciliationResult =
  | { status: 'confirmed'; pullRequestUrl: string }
  | { status: 'unresolved'; reason: string };

/**
 * Read-only reconciliation of an uncertain remote write. A missing result is
 * NOT evidence that GitHub did not create a PR. Never auto-retry a push/POST.
 * The caller must fetch all open and closed PRs for the exact destination.
 */
export function reconcilePublicationCandidates(
  plan: DeliveryPublicationPlan,
  candidates: readonly RemoteDraftCandidate[],
): ReconciliationResult {
  if (!plan.allowed) return { status: 'unresolved', reason: plan.reason };
  const matching = candidates.filter(
    (candidate) =>
      candidate.head.ref === plan.branch &&
      candidate.base.ref === plan.baseBranch,
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
  const candidate = matching[0]!;
  if (candidate.state !== 'open') {
    return { status: 'unresolved', reason: 'Remote PR is not open; manual review required.' };
  }
  try {
    return { status: 'confirmed', pullRequestUrl: validatePublicationReceipt(plan, candidate) };
  } catch {
    return { status: 'unresolved', reason: 'Remote PR receipt failed identity verification.' };
  }
}
