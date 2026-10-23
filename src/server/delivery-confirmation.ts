import type { DeliveryPreflight } from './delivery-preflight.js';

/**
 * A pure confirmation contract, not a publication capability.
 * No network, Git subprocess, credential handling or side effects.
 * Any future publisher must re-read the workspace and remote state under a
 * write lease before performing an operation; this only validates intent.
 */
export type DeliveryConfirmation = {
  revision: string;
  branch: string;
  owner: string;
  repository: string;
  acknowledged: true;
};

export type DeliveryConfirmationResult =
  | { valid: true; destination: string }
  | { valid: false; reason: string };

export function validateDeliveryConfirmation(
  preflight: DeliveryPreflight,
  confirmation: DeliveryConfirmation,
): DeliveryConfirmationResult {
  if (preflight.status !== 'manual-review' || preflight.checks.some((check) => !check.ok)) {
    return { valid: false, reason: 'Delivery preflight is blocked.' };
  }
  if (!preflight.revision || !preflight.remote) {
    return { valid: false, reason: 'Delivery revision or remote is unavailable.' };
  }
  if (confirmation.acknowledged !== true) {
    return { valid: false, reason: 'Explicit operator acknowledgement is required.' };
  }
  if (
    confirmation.revision !== preflight.revision ||
    confirmation.branch !== preflight.branch ||
    confirmation.owner !== preflight.remote.owner ||
    confirmation.repository !== preflight.remote.repository
  ) {
    return { valid: false, reason: 'Delivery intent no longer matches the reviewed snapshot.' };
  }
  return {
    valid: true,
    destination: `https://github.com/${preflight.remote.owner}/${preflight.remote.repository}`,
  };
}
