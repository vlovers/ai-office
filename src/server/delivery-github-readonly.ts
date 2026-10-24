import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import type { GitHubDraftReceipt } from './delivery-publication-receipt.js';
import { collectRemotePullRequests } from './delivery-publication-pagination.js';

type AllowedPlan = Extract<DeliveryPublicationPlan, { allowed: true }>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

type ReadOnlyGitHubOptions = {
  fetcher?: Fetcher;
  /** Server-side credential only. Never forward browser-provided tokens. */
  token?: string;
  perPage?: number;
  maxPages?: number;
  signal?: AbortSignal;
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
    const response = await fetcher(url.toString(), {
      method: 'GET',
      redirect: 'error',
      headers,
      signal: options.signal,
    });
    if (response.redirected || (response.url && response.url !== url.toString())) {
      throw new Error('GitHub PR listing redirected outside the approved request.');
    }
    if (!response.ok) {
      // Never include response body or credential in thrown errors.
      throw new Error(`GitHub PR listing failed with HTTP ${response.status}.`);
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || payload.length > perPage) {
      throw new Error('Invalid GitHub PR listing page.');
    }
    const candidates = payload.map(parseGitHubPullRequest);
    return {
      candidates,
      nextPage: candidates.length === perPage ? page + 1 : null,
    };
  }, options.maxPages);
}
