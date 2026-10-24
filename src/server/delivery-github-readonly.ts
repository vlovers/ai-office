import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import type { GitHubDraftReceipt } from './delivery-publication-receipt.js';
import { collectRemotePullRequests } from './delivery-publication-pagination.js';
import { withGitHubRequestDeadline } from './delivery-github-request-deadline.js';

type AllowedPlan = Extract<DeliveryPublicationPlan, { allowed: true }>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export type ReadOnlyGitHubOptions = {
  fetcher?: Fetcher;
  /** Server-side credential only. Never forward browser-provided tokens. */
  token?: string;
  perPage?: number;
  maxPages?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRepository(value: unknown): { full_name: string } | null {
  if (value === null) return null;
  if (!record(value) || typeof value.full_name !== 'string') {
    throw new Error('Invalid GitHub PR repository identity.');
  }
  return { full_name: value.full_name };
}

function parseRef(value: unknown): GitHubDraftReceipt['head'] {
  if (!record(value) || typeof value.ref !== 'string' || !('repo' in value)) {
    throw new Error('Invalid GitHub PR branch identity.');
  }
  return { ref: value.ref, repo: parseRepository(value.repo) };
}

/**
 * Parse only the fields required by the security boundary. Never coerce
 * missing/invalid GitHub fields into an apparently valid PR receipt.
 */
export function parseGitHubPullRequest(value: unknown): GitHubDraftReceipt {
  if (
    !record(value) ||
    typeof value.html_url !== 'string' ||
    typeof value.draft !== 'boolean' ||
    (value.state !== 'open' && value.state !== 'closed')
  ) {
    throw new Error('Invalid GitHub PR listing entry.');
  }
  return {
    html_url: value.html_url,
    draft: value.draft,
    state: value.state,
    head: parseRef(value.head),
    base: parseRef(value.base),
  };
}

/**
 * Prefer GitHub's explicit pagination evidence over response length. A short
 * page can still have a next link; ignoring it would silently omit PRs and
 * could make a duplicate publication look safe.
 */
function nextGitHubPage(
  link: string | null,
  requestedUrl: URL,
  page: number,
  fullPage: boolean,
): number | null {
  if (link === null) return fullPage ? page + 1 : null;
  const seen = new Set<string>();
  let next: number | null = null;
  let last: number | null = null;
  for (const segment of link.split(',')) {
    const match = /^<([^<>]+)>;\s*rel="(next|prev|first|last)"$/.exec(segment.trim());
    if (!match) throw new Error('Invalid GitHub PR pagination Link header.');
    const relation = match[2]!;
    if (seen.has(relation)) throw new Error('Duplicate GitHub PR pagination relation.');
    seen.add(relation);
    let target: URL;
    try {
      target = new URL(match[1]!);
    } catch {
      throw new Error('Invalid GitHub PR pagination URL.');
    }
    if (
      target.origin !== requestedUrl.origin ||
      target.pathname !== requestedUrl.pathname ||
      target.hash !== '' ||
      target.username !== '' ||
      target.password !== '' ||
      target.searchParams.size !== 3 ||
      target.searchParams.get('state') !== 'all' ||
      target.searchParams.get('per_page') !== requestedUrl.searchParams.get('per_page')
    ) {
      throw new Error('GitHub PR pagination escaped the approved repository.');
    }
    const targetPage = Number(target.searchParams.get('page'));
    if (
      !Number.isSafeInteger(targetPage) ||
      targetPage < 1 ||
      (relation === 'next' && targetPage !== page + 1) ||
      (relation === 'prev' && targetPage !== page - 1) ||
      (relation === 'first' && targetPage !== 1) ||
      (relation === 'last' && targetPage < page)
    ) {
      throw new Error('GitHub PR pagination returned an inconsistent page.');
    }
    if (relation === 'next') next = targetPage;
    if (relation === 'last') last = targetPage;
  }
  // A last-page hint beyond the current page without a next link would
  // silently truncate the remote inventory and could hide duplicate PRs.
  if (last !== null && (last > page) !== (next !== null)) {
    throw new Error('GitHub PR pagination Link header is incomplete.');
  }
  if (next !== null && last !== null && last < next) {
    throw new Error('GitHub PR pagination Link header is inconsistent.');
  }
  return next;
}

/**
 * Read-only GitHub REST adapter. Requests the approved repository only,
 * includes open and closed PRs, exhausts pagination and fails closed on
 * redirects, rate limits, malformed JSON and interrupted responses.
 *
 * It cannot create, push, merge or delete anything. The caller must hold
 * the shared publication lease and use a server-owned GitHub credential.
 */
export async function listAllGitHubPullRequests(
  plan: AllowedPlan,
  options: ReadOnlyGitHubOptions = {},
): Promise<{ complete: true; candidates: GitHubDraftReceipt[] }> {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(
    plan.destination,
  );
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new Error('Untrusted GitHub PR listing destination.');
  }
  const perPage = options.perPage ?? 100;
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new Error('Invalid GitHub PR listing page size.');
  }
  if (options.token !== undefined && (!options.token || /\s/.test(options.token))) {
    throw new Error('Invalid server-side GitHub credential.');
  }
  const fetcher: Fetcher = options.fetcher ?? globalThis.fetch;
  return collectRemotePullRequests(async (page) => {
    const url = new URL(`https://api.github.com/repos/${match[1]}/${match[2]}/pulls`);
    url.searchParams.set('state', 'all');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const { response, payload } = await withGitHubRequestDeadline(
      async (signal) => {
        const response = await fetcher(url.toString(), {
          method: 'GET',
          redirect: 'error',
          headers,
          signal,
        });
        if (response.redirected || (response.url && response.url !== url.toString())) {
          throw new Error('GitHub PR listing redirected outside the approved request.');
        }
        if (response.status !== 200) {
          // Never include response body or credential in thrown errors.
          throw new Error(`GitHub PR listing failed with HTTP ${response.status}.`);
        }
        return { response, payload: (await response.json()) as unknown };
      },
      { signal: options.signal, timeoutMs: options.timeoutMs },
    );
    if (!Array.isArray(payload) || payload.length > perPage) {
      throw new Error('Invalid GitHub PR listing page.');
    }
    const candidates = payload.map(parseGitHubPullRequest);
    return {
      candidates,
      nextPage: nextGitHubPage(
        response.headers.get('link'),
        url,
        page,
        candidates.length === perPage,
      ),
    };
  }, options.maxPages);
}
