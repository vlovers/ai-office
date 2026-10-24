import {
  decidePublication,
  publicationKey,
  type PublicationReceipt,
} from './delivery-publication-idempotency.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';

/**
 * Read-only coordinator. No reservation, Git operation, or network access is
 * permitted until the caller has acquired an exclusive workspace write lease.
 */
export type PublicationReadiness =
  | { status: 'blocked'; reason: string }
  | { status: 'requires-lease'; operationKey: string }
  | { status: 'already-published'; pullRequestUrl: string };

export function publicationReadiness(
  plan: DeliveryPublicationPlan,
  receipt: PublicationReceipt | null,
): PublicationReadiness {
  const decision = decidePublication(plan, receipt);
  if (decision.action === 'blocked') return { status: 'blocked', reason: decision.reason };
  if (decision.action === 'reuse') {
    return { status: 'already-published', pullRequestUrl: decision.pullRequestUrl };
  }
  return { status: 'requires-lease', operationKey: decision.key };
}

/**
 * A lease holder must re-read the review and regenerate the plan before
 * reserving the operation. The two snapshots must be exactly identical.
 */
export function validateLeasedPublication(
  expectedKey: string,
  currentPlan: DeliveryPublicationPlan,
): { valid: true } | { valid: false; reason: string } {
  if (!currentPlan.allowed) return { valid: false, reason: currentPlan.reason };
  if (publicationKey(currentPlan) !== expectedKey) {
    return { valid: false, reason: 'Publication snapshot changed while acquiring the lease.' };
  }
  return { valid: true };
}
