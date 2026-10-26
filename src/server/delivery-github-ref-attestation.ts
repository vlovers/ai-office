import { parseGitHubPullRequest } from './delivery-github-readonly.js';
import { withGitHubRequestDeadline } from './delivery-github-request-deadline.js';
import { GITHUB_JSON_LIMITS, readBoundedGitHubJson } from './delivery-github-json-boundary.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import {
  validatePublicationReceipt,
  type GitHubDraftReceipt,
} from './delivery-publication-receipt.js';

type AllowedPlan = Extract<DeliveryPublicationPlan, { allowed: true }>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export type ApprovedCommitSnapshot = {
  /** Stable, operator-confirmed publication identity from the reviewed plan. */
  operationKey: string;
  /** Exact reviewed local Git HEAD, not the SHA-256 review fingerprint. */
  headCommitSha: string;
  /** Exact reviewed destination base commit. */
  baseCommitSha: string;
};

export type AttestedGitRefs = ApprovedCommitSnapshot & {
  repository: string;
  branch: string;
  baseBranch: string;
};

export type GitHubCommitReceipt = GitHubDraftReceipt & {
  head: GitHubDraftReceipt['head'] & { sha: string };
  base: GitHubDraftReceipt['base'] & { sha: string };
};

export type GitHubRefOptions = {
  /** Server-owned token only; never take credentials from a browser payload. */
  token?: string;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function validCommitSha(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function expectedRepository(plan: AllowedPlan): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(
    plan.destination,
  );
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new Error('Untrusted GitHub commit attestation destination.');
  }
  return `${match[1]}/${match[2]}`;
}

function verifyApproval(plan: AllowedPlan, approval: ApprovedCommitSnapshot): void {
  if (approval.operationKey !== publicationKey(plan)) {
    throw new Error('Approved commit snapshot does not match the publication operation.');
  }
  if (
    !validCommitSha(approval.headCommitSha) ||
    !validCommitSha(approval.baseCommitSha) ||
    approval.headCommitSha.length !== approval.baseCommitSha.length
  ) {
    throw new Error('Invalid approved Git commit SHA.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fetch a GitHub ref without following redirects or trusting partial JSON.
 * A missing ref, stale SHA, tag or API error always blocks remote writes.
 */
async function fetchExactCommitRef(
  repository: string,
  branch: string,
  options: GitHubRefOptions,
): Promise<string> {
  const url = new URL(
    `https://api.github.com/repos/${repository}/git/ref/heads/${branch
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
  );
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const body: unknown = await withGitHubRequestDeadline(
    async (signal) => {
      const response = await (options.fetcher ?? globalThis.fetch)(url.toString(), {
        method: 'GET',
        redirect: 'error',
        headers,
        signal,
      });
      if (response.redirected || (response.url && response.url !== url.toString())) {
        throw new Error('GitHub commit ref request was redirected.');
      }
      if (response.status !== 200) {
        throw new Error(`GitHub commit ref request failed with HTTP ${response.status}.`);
      }
      return readBoundedGitHubJson(response, GITHUB_JSON_LIMITS.refs);
    },
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
  if (
    !isRecord(body) ||
    body.ref !== `refs/heads/${branch}` ||
    !isRecord(body.object) ||
    body.object.type !== 'commit' ||
    typeof body.object.sha !== 'string' ||
    !validCommitSha(body.object.sha)
  ) {
    throw new Error('Invalid GitHub commit ref response.');
  }
  return body.object.sha;
}

/**
 * Read-only remote attestation. Call while holding the shared repository lease,
 * immediately before the approved remote write. Recheck the PR receipt after
 * CREATE as a separate TOCTOU defense. This does NOT approve a commit itself:
 * the snapshot must originate from the reviewed, locally verified Git state.
 */
export async function attestGitHubCommitRefs(
  plan: DeliveryPublicationPlan,
  approval: ApprovedCommitSnapshot,
  options: GitHubRefOptions = {},
): Promise<AttestedGitRefs> {
  if (!plan.allowed) throw new Error('Publication plan is blocked.');
  verifyApproval(plan, approval);
  const repository = expectedRepository(plan);
  if (options.token !== undefined && (!options.token || /\s/.test(options.token))) {
    throw new Error('Invalid server-side GitHub credential.');
  }
  // One outer deadline bounds the head/base/head sequence, including body
  // parsing. A concurrent writer may move the managed head while the base
  // request is pending. Re-read it after the base rather than authorizing a
  // POST from a head snapshot that was already stale during attestation.
  // This is a fail-closed TOCTOU reduction, not an atomic GitHub snapshot.
  // The outer AbortSignal also prevents late responses from starting a
  // subsequent GET after the attestation has timed out.
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Invalid GitHub commit ref attestation deadline.');
  }
  return withGitHubRequestDeadline(
    async (signal) => {
      const boundedOptions = { ...options, signal, timeoutMs };
      const headCommitSha = await fetchExactCommitRef(repository, plan.branch, boundedOptions);
      if (headCommitSha !== approval.headCommitSha) {
        throw new Error('GitHub head branch moved since operator review.');
      }
      const baseCommitSha = await fetchExactCommitRef(repository, plan.baseBranch, boundedOptions);
      if (baseCommitSha !== approval.baseCommitSha) {
        throw new Error('GitHub base branch moved since operator review.');
      }
      const confirmedHeadSha = await fetchExactCommitRef(repository, plan.branch, boundedOptions);
      if (confirmedHeadSha !== approval.headCommitSha) {
        throw new Error('GitHub head branch moved during remote attestation.');
      }
      return {
        ...approval,
        repository,
        branch: plan.branch,
        baseBranch: plan.baseBranch,
      };
    },
    { signal: options.signal, timeoutMs },
  );
}

/**
 * Re-read a reconciled PR by its canonical number and obtain immutable commit
 * identities from a fresh GitHub GET. A PR list entry alone is insufficient
 * to recover a commit-pinned ambiguous write.
 */
export async function readGitHubDraftCommitReceipt(
  plan: DeliveryPublicationPlan,
  pullRequestUrl: string,
  options: GitHubRefOptions = {},
): Promise<GitHubCommitReceipt> {
  if (!plan.allowed) throw new Error('Publication plan is blocked.');
  const repository = expectedRepository(plan);
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9]\d*)$/.exec(
      pullRequestUrl,
    );
  if (!match || `${match[1]}/${match[2]}` !== repository) {
    throw new Error('Untrusted GitHub draft PR detail URL.');
  }
  if (options.token !== undefined && (!options.token || /\s/.test(options.token))) {
    throw new Error('Invalid server-side GitHub credential.');
  }
  const url = new URL(`https://api.github.com/repos/${repository}/pulls/${match[3]}`);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const body: unknown = await withGitHubRequestDeadline(
    async (signal) => {
      const response = await (options.fetcher ?? globalThis.fetch)(url.toString(), {
        method: 'GET',
        redirect: 'error',
        headers,
        signal,
      });
      if (response.redirected || (response.url && response.url !== url.toString())) {
        throw new Error('GitHub draft PR detail request was redirected.');
      }
      if (response.status !== 200) {
        throw new Error(`GitHub draft PR detail request failed with HTTP ${response.status}.`);
      }
      return readBoundedGitHubJson(response, GITHUB_JSON_LIMITS.detail);
    },
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
  if (
    !isRecord(body) ||
    body.number !== Number(match[3]) ||
    !isRecord(body.head) ||
    !isRecord(body.base) ||
    typeof body.head.sha !== 'string' ||
    typeof body.base.sha !== 'string' ||
    !validCommitSha(body.head.sha) ||
    !validCommitSha(body.base.sha)
  ) {
    throw new Error('Invalid GitHub draft PR commit details.');
  }
  const parsed = parseGitHubPullRequest(body);
  // The API route's numeric identity and the returned HTML identity must
  // agree. Otherwise a successful GET could confirm an unrelated PR.
  if (parsed.html_url !== pullRequestUrl) {
    throw new Error('GitHub draft PR detail URL differs from the requested receipt.');
  }
  const receipt: GitHubCommitReceipt = {
    ...parsed,
    head: { ...parsed.head, sha: body.head.sha },
    base: { ...parsed.base, sha: body.base.sha },
  };
  validatePublicationReceipt(plan, receipt);
  return receipt;
}

/**
 * Verify GitHub's POST response against the same immutable commit snapshot.
 * A mismatch means the remote outcome is uncertain, never safe to retry.
 */
export function validateAttestedDraftReceipt(
  plan: DeliveryPublicationPlan,
  attestation: AttestedGitRefs,
  receipt: GitHubCommitReceipt,
): string {
  if (!plan.allowed) throw new Error('Publication plan is blocked.');
  verifyApproval(plan, attestation);
  if (
    attestation.repository !== expectedRepository(plan) ||
    attestation.branch !== plan.branch ||
    attestation.baseBranch !== plan.baseBranch ||
    receipt.head.sha !== attestation.headCommitSha ||
    receipt.base.sha !== attestation.baseCommitSha
  ) {
    throw new Error('GitHub draft PR commit identity changed during publication.');
  }
  return validatePublicationReceipt(plan, receipt);
}
