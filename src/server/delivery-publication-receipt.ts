import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';

export type GitHubDraftReceipt = {
  html_url: string;
  draft: boolean;
  state: string;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } | null };
};

/**
 * GitHub may return a PR from a fork with the same head branch name.
 * Validate both repository identities, branch refs and the canonical URL
 * before writing a durable receipt. A missing/deleted repo fails closed.
 */
export function validatePublicationReceipt(
  plan: DeliveryPublicationPlan,
  response: GitHubDraftReceipt,
): string {
  if (!plan.allowed) throw new Error('Publication plan is blocked.');
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(
    plan.destination,
  );
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new Error('Untrusted publication destination.');
  }
  const fullName = `${match[1]}/${match[2]}`;
  if (
    response.draft !== true ||
    response.state !== 'open' ||
    response.head.ref !== plan.branch ||
    response.base.ref !== plan.baseBranch ||
    response.head.repo?.full_name !== fullName ||
    response.base.repo?.full_name !== fullName
  ) {
    throw new Error('GitHub pull request does not match the approved publication plan.');
  }
  const url = `${plan.destination}/pull/`;
  if (
    !response.html_url.startsWith(url) ||
    !/^[1-9][0-9]*$/.test(response.html_url.slice(url.length))
  ) {
    throw new Error('GitHub pull request URL does not match the approved destination.');
  }
  return response.html_url;
}
