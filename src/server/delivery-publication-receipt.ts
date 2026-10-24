import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';

/**
 * Reject a GitHub response unless it names the exact approved destination,
 * managed head, base and draft state. This must run before journal.publish().
 */
export function validatePublicationReceipt(
  plan: DeliveryPublicationPlan,
  response: {
    html_url: string;
    draft: boolean;
    head: { ref: string };
    base: { ref: string };
  },
): string {
  if (!plan.allowed) throw new Error('Publication plan is blocked.');
  const destination = new URL(plan.destination);
  if (
    destination.protocol !== 'https:' ||
    destination.hostname !== 'github.com' ||
    destination.username ||
    destination.password ||
    destination.search ||
    destination.hash ||
    destination.pathname.split('/').filter(Boolean).length !== 2
  ) {
    throw new Error('Untrusted publication destination.');
  }
  const expected = plan.destination.replace(/\/$/, '');
  if (
    response.draft !== true ||
    response.head.ref !== plan.branch ||
    response.base.ref !== plan.baseBranch
  ) {
    throw new Error('GitHub pull request does not match the approved publication plan.');
  }
  const match = /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(
    response.html_url,
  );
  if (!match || `https://github.com/${match[1]}/${match[2]}` !== expected) {
    throw new Error('GitHub pull request URL does not match the approved destination.');
  }
  return response.html_url;
}
