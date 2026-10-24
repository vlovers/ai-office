import type { DeliveryPreflight } from './delivery-preflight.js';
import {
  validateDeliveryConfirmation,
  type DeliveryConfirmation,
} from './delivery-confirmation.js';

/**
 * Pure, fail-closed publication policy. The returned plan is informational:
 * a publisher must revalidate the review under an exclusive write lease.
 */
export type DeliveryPublicationPlan =
  | {
      allowed: true;
      destination: string;
      branch: string;
      baseBranch: string;
      revision: string;
      draft: true;
    }
  | { allowed: false; reason: string };

const safeBranch = (value: string) =>
  value.length <= 200 &&
  /^ai-office\/[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value) &&
  !value.includes('..') &&
  !value.endsWith('.lock');

export function planDeliveryPublication(
  preflight: DeliveryPreflight,
  confirmation: DeliveryConfirmation,
  baseBranch: string,
): DeliveryPublicationPlan {
  const validated = validateDeliveryConfirmation(preflight, confirmation);
  if (!validated.valid) return { allowed: false, reason: validated.reason };
  if (!safeBranch(preflight.branch))
    return { allowed: false, reason: 'Workspace branch is not a managed AI Office branch.' };
  if (baseBranch !== 'main')
    return { allowed: false, reason: 'Only main is supported as a delivery target.' };
  if (!/^[a-f0-9]{64}$/.test(preflight.revision!))
    return { allowed: false, reason: 'Review revision must be a SHA-256 fingerprint.' };
  return {
    allowed: true,
    destination: validated.destination,
    branch: preflight.branch,
    baseBranch,
    revision: preflight.revision!,
    draft: true,
  };
}
