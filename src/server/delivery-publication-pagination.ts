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
  verifyStablePages = false,
): Promise<{ complete: true; candidates: RemoteDraftCandidate[] }> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new Error('Invalid GitHub PR pagination limit.');
  }
  // A single offset-paginated traversal can silently miss a PR when a
  // concurrent insert or deletion shifts later pages without repeating a URL.
  // Re-read multi-page inventories and compare the ordered security-relevant
  // identities. This is not an atomic GitHub snapshot, but any observed drift
  // must block publication rather than be treated as negative duplicate proof.
  const collectPass = async (): Promise<{
    candidates: RemoteDraftCandidate[];
    pages: number;
  }> => {
    const candidates: RemoteDraftCandidate[] = [];
    const seenPullRequestUrls = new Set<string>();
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
        (!Number.isSafeInteger(result.nextPage) || result.nextPage !== currentPage + 1)
      ) {
        throw new Error('GitHub PR listing returned an invalid next page.');
      }
      for (const candidate of result.candidates) {
        if (
          !candidate ||
          typeof candidate.html_url !== 'string' ||
          seenPullRequestUrls.has(candidate.html_url)
        ) {
          throw new Error('GitHub PR inventory contains a duplicate or invalid PR identity.');
        }
        seenPullRequestUrls.add(candidate.html_url);
        candidates.push(candidate);
      }
      if (candidates.length > 100_000) {
        throw new Error('GitHub PR listing exceeded the safe result limit.');
      }
      page = result.nextPage;
    }
    return { candidates, pages: count };
  };

  const first = await collectPass();
  if (verifyStablePages && first.pages > 1) {
    const fingerprint = (candidate: RemoteDraftCandidate): string =>
      JSON.stringify([
        candidate.html_url,
        candidate.draft,
        candidate.state,
        candidate.head.ref,
        candidate.head.repo?.full_name,
        candidate.base.ref,
        candidate.base.repo?.full_name,
      ]);
    // Freeze the first-pass evidence before the second traversal. A mutable
    // injected adapter must not be able to rewrite both sides of the check.
    const firstFingerprints = first.candidates.map(fingerprint);
    const second = await collectPass();
    if (
      first.pages !== second.pages ||
      first.candidates.length !== second.candidates.length ||
      firstFingerprints.some(
        (value, index) => value !== fingerprint(second.candidates[index]!),
      )
    ) {
      throw new Error('GitHub PR pagination changed during inventory; publication blocked.');
    }
  }
  return { complete: true, candidates: first.candidates };
}
