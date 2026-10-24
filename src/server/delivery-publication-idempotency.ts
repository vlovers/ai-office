import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';

/**
 * Stable operation identity for a future lease-protected publisher.
 * This module performs no Git, network or persistence operations.
 */
export type PublicationReceipt = {
  revision: string;
  branch: string;
  destination: string;
  baseBranch: string;
  draft: true;
  pullRequestUrl: string;
};

export type PublicationDecision =
  | { action: 'blocked'; reason: string }
  | { action: 'create'; key: string }
  | { action: 'reuse'; key: string; pullRequestUrl: string };

export function publicationKey(plan: Extract<DeliveryPublicationPlan, { allowed: true }>) {
  return JSON.stringify([
    plan.destination,
    plan.branch,
    plan.baseBranch,
    plan.revision,
    plan.draft,
  ]);
}

export function decidePublication(
  plan: DeliveryPublicationPlan,
  previous: PublicationReceipt | null,
): PublicationDecision {
  if (!plan.allowed) return { action: 'blocked', reason: plan.reason };
  const key = publicationKey(plan);
  if (!previous) return { action: 'create', key };
  if (
    previous.destination !== plan.destination ||
    previous.branch !== plan.branch ||
    previous.baseBranch !== plan.baseBranch
  ) {
    return { action: 'blocked', reason: 'Existing publication targets a different destination.' };
  }
  if (previous.revision !== plan.revision)
    return { action: 'blocked', reason: 'Workspace has changed since the previous publication.' };
  if (previous.draft !== true)
    return { action: 'blocked', reason: 'Existing publication is not a draft.' };
  const expectedPrefix = `${plan.destination}/pull/`;
  if (
    !previous.pullRequestUrl.startsWith(expectedPrefix) ||
    !/^[1-9][0-9]*$/.test(previous.pullRequestUrl.slice(expectedPrefix.length))
  )
    return { action: 'blocked', reason: 'Existing pull request URL is not trusted.' };
  return { action: 'reuse', key, pullRequestUrl: previous.pullRequestUrl };
}
