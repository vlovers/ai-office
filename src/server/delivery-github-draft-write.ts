import { publicationKey } from './delivery-publication-idempotency.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import {
  validateAttestedDraftReceipt,
  type ApprovedCommitSnapshot,
  type AttestedGitRefs,
  type GitHubCommitReceipt,
} from './delivery-github-ref-attestation.js';
import { parseGitHubPullRequest } from './delivery-github-readonly.js';
import { withGitHubRequestDeadline } from './delivery-github-request-deadline.js';
import { GITHUB_JSON_LIMITS, readBoundedGitHubJson } from './delivery-github-json-boundary.js';

type AllowedPlan = Extract<DeliveryPublicationPlan, { allowed: true }>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * This object must be issued by a server-side operator confirmation flow.
 * It is NOT itself proof of authorization and must never be copied directly
 * from untrusted HTTP input. There is deliberately no HTTP route here.
 */
export type ConfirmedDraftWrite = ApprovedCommitSnapshot & {
  action: 'create-draft-pr';
};

export type GitHubDraftWriteOptions = {
  /** Required server-owned, least-privilege GitHub credential. */
  token: string;
  title: string;
  body?: string;
  confirmation: ConfirmedDraftWrite;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Trusted synchronous live-authorization gate at the last possible point before POST. */
  authorizeBeforePost?: () => void;
};

function expectedRepository(plan: AllowedPlan): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(
    plan.destination,
  );
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new Error('Untrusted GitHub draft publication destination.');
  }
  return `${match[1]}/${match[2]}`;
}

function validCommitSha(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

/**
 * Check configuration BEFORE reserving a durable operation. A malformed
 * credential or missing approval must never leave a spurious uncertain entry.
 */
export function validateGitHubDraftWrite(
  plan: DeliveryPublicationPlan,
  approval: ApprovedCommitSnapshot,
  options: GitHubDraftWriteOptions,
): string {
  if (!plan.allowed) throw new Error('Publication plan is blocked.');
  const repository = expectedRepository(plan);
  if (
    approval.operationKey !== publicationKey(plan) ||
    !validCommitSha(approval.headCommitSha) ||
    !validCommitSha(approval.baseCommitSha) ||
    approval.headCommitSha.length !== approval.baseCommitSha.length
  ) {
    throw new Error('Invalid approved Git commit snapshot.');
  }
  if (
    options.confirmation?.action !== 'create-draft-pr' ||
    options.confirmation.operationKey !== approval.operationKey ||
    options.confirmation.headCommitSha !== approval.headCommitSha ||
    options.confirmation.baseCommitSha !== approval.baseCommitSha
  ) {
    throw new Error('Explicit server-side draft publication confirmation is required.');
  }
  if (typeof options.token !== 'string' || !options.token || /\s/.test(options.token)) {
    throw new Error('Valid server-side GitHub credentials are required.');
  }
  // Reject configuration errors and already-cancelled attempts BEFORE the
  // approval and SQLite journal are atomically reserved. After reservation,
  // even a failed POST must remain uncertain and cannot be replayed.
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 60_000)
  ) {
    throw new Error('Invalid GitHub draft write deadline.');
  }
  if (options.fetcher !== undefined && typeof options.fetcher !== 'function') {
    throw new Error('Invalid GitHub draft write transport.');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new Error('Invalid GitHub draft write abort signal.');
  }
  if (
    options.authorizeBeforePost !== undefined &&
    typeof options.authorizeBeforePost !== 'function'
  ) {
    throw new Error('Invalid GitHub draft write authorization hook.');
  }
  if (options.signal?.aborted) {
    throw new Error('GitHub draft write aborted before reservation.');
  }
  if (
    typeof options.title !== 'string' ||
    options.title.trim().length < 1 ||
    options.title.length > 256 ||
    /[\x00-\x1f\x7f]/.test(options.title)
  ) {
    throw new Error('Invalid draft pull request title.');
  }
  if (
    options.body !== undefined &&
    (typeof options.body !== 'string' || options.body.length > 65536)
  ) {
    throw new Error('Invalid draft pull request body.');
  }
  return repository;
}

/**
 * One single authenticated GitHub POST. No retries, redirects, alternate
 * hosts, force pushes, merges, or credential persistence. The caller MUST
 * hold the shared Git lease, have already attested both remote commit refs,
 * and have reserved the journal before calling this adapter.
 */
export async function createCommitAttestedGitHubDraft(
  plan: AllowedPlan,
  attestation: AttestedGitRefs,
  options: GitHubDraftWriteOptions,
): Promise<GitHubCommitReceipt> {
  const repository = validateGitHubDraftWrite(plan, attestation, options);
  if (
    attestation.repository !== repository ||
    attestation.branch !== plan.branch ||
    attestation.baseBranch !== plan.baseBranch
  ) {
    throw new Error('GitHub draft publication attestation does not match the destination.');
  }
  const url = `https://api.github.com/repos/${repository}/pulls`;
  const body: unknown = await withGitHubRequestDeadline(
    async (signal) => {
      const authorization: unknown = options.authorizeBeforePost?.();
      if (authorization && typeof (authorization as { then?: unknown }).then === 'function') {
        void Promise.resolve(authorization).catch(() => undefined);
        throw new Error('Draft PR authorization must be synchronous.');
      }
      const response = await (options.fetcher ?? globalThis.fetch)(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: options.title,
          body: options.body ?? '',
          head: plan.branch,
          base: plan.baseBranch,
          draft: true,
          maintainer_can_modify: false,
        }),
      });
      if (response.redirected || (response.url && response.url !== url)) {
        throw new Error('GitHub draft publication request was redirected.');
      }
      if (response.status !== 201) {
        // Do not inspect/echo the response body: it can contain untrusted content.
        throw new Error(
          `GitHub draft publication returned HTTP ${response.status}; outcome uncertain.`,
        );
      }
      return readBoundedGitHubJson(response, GITHUB_JSON_LIMITS.draft);
    },
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Invalid GitHub draft publication response.');
  }
  const raw = body as Record<string, unknown>;
  const candidate = parseGitHubPullRequest(raw);
  const head = raw.head as Record<string, unknown>;
  const base = raw.base as Record<string, unknown>;
  if (
    !Number.isSafeInteger(raw.number) ||
    (raw.number as number) <= 0 ||
    candidate.html_url !== `https://github.com/${repository}/pull/${raw.number}` ||
    typeof head.sha !== 'string' ||
    typeof base.sha !== 'string' ||
    !validCommitSha(head.sha) ||
    !validCommitSha(base.sha)
  ) {
    throw new Error('Invalid GitHub draft publication commit receipt.');
  }
  const receipt: GitHubCommitReceipt = {
    ...candidate,
    head: { ...candidate.head, sha: head.sha },
    base: { ...candidate.base, sha: base.sha },
  };
  validateAttestedDraftReceipt(plan, attestation, receipt);
  return receipt;
}
