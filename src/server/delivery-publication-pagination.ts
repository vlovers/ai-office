import type { RemoteDraftCandidate } from './delivery-publication-reconciliation.js';

export type RemotePullRequestPage = {
  candidates: RemoteDraftCandidate[];
  nextPage: number | null;
};

/**
 * Exhaust a verified repository's open AND closed PR listing.
 * The injected adapter must use the approved destination and must never
 * silently filter out closed or draft PRs. Partial results are not returned.
 */
export async function collectRemotePullRequests(
  fetchPage: (page: number) => Promise<RemotePullRequestPage>,
  maxPages = 100,
): Promise<{ complete: true; candidates: RemoteDraftCandidate[] }> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new Error('Invalid GitHub PR pagination limit.');
  }
  const candidates: RemoteDraftCandidate[] = [];
  let page: number | null = 1;
  let count = 0;
  while (page !== null) {
    if (++count > maxPages) {
      throw new Error('GitHub PR listing exceeded the safe pagination limit.');
    }
    const currentPage: number = page;
    const result: RemotePullRequestPage = await fetchPage(currentPage);
    if (!result || !Array.isArray(result.candidates) || result.candidates.length > 100) {
      throw new Error('GitHub PR listing returned an invalid page.');
    }
    if (
      result.nextPage !== null &&
      (!Number.isSafeInteger(result.nextPage) || result.nextPage <= currentPage)
    ) {
      throw new Error('GitHub PR listing returned an invalid next page.');
    }
    candidates.push(...result.candidates);
    if (candidates.length > 100_000) {
      throw new Error('GitHub PR listing exceeded the safe result limit.');
    }
    page = result.nextPage;
  }
  return { complete: true, candidates };
}
