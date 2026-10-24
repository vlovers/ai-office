import { realpath } from 'node:fs/promises';
import { parseGitHubRemote } from '../shared/github-remote.js';
import type { ApprovedCommitSnapshot } from './delivery-github-ref-attestation.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';
import { git, revalidateRepository } from './repositories.js';

export type LocalPublicationWorktree = {
  path: string;
  gitDir: string;
};

export type LocalGitReview = {
  repository: LocalPublicationWorktree;
  worktree: LocalPublicationWorktree;
  workspaceGitDir: string;
  commits: ApprovedCommitSnapshot;
};

export type VerifiedLocalGitReview = ApprovedCommitSnapshot & {
  worktreePath: string;
  gitDir: string;
  remote: string;
  branch: string;
};

function commitSha(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function assertReview(
  plan: DeliveryPublicationPlan,
  review: LocalGitReview,
): asserts plan is Extract<DeliveryPublicationPlan, { allowed: true }> {
  if (!plan.allowed) throw new Error('Local Git review has a blocked publication plan.');
  if (
    review.commits.operationKey !== publicationKey(plan) ||
    !commitSha(review.commits.headCommitSha) ||
    !commitSha(review.commits.baseCommitSha) ||
    review.commits.headCommitSha.length !== review.commits.baseCommitSha.length
  ) {
    throw new Error('Local Git review does not match approved commits.');
  }
  if (
    !/^ai-office\/[0-9a-f]{8}-[0-9a-f-]{27}$/.test(plan.branch) ||
    plan.baseBranch !== 'main'
  ) {
    throw new Error('Local Git review requires a managed branch and main base.');
  }
  if (
    !review.repository?.path ||
    !review.repository?.gitDir ||
    !review.worktree?.path ||
    !review.worktree?.gitDir ||
    review.worktree.gitDir !== review.workspaceGitDir
  ) {
    throw new Error('Local Git worktree identity does not match the workspace.');
  }
}

/**
 * Read-only local Git attestation. MUST run inside the shared repository lease
 * immediately before remote SHA attestation and journal reservation.
 *
 * This verifies the worktree, clean index, branch, commit pair and destination,
 * but does NOT authenticate the operator or authorize commit/push.
 * A non-cooperating external Git process can still mutate refs; callers must
 * also attest remote refs and validate the final GitHub PR receipt.
 */
export async function attestLocalReviewedGitState(
  plan: DeliveryPublicationPlan,
  review: LocalGitReview,
): Promise<VerifiedLocalGitReview> {
  assertReview(plan, review);
  const verifiedRepository = await revalidateRepository(review.repository);
  const verified = await revalidateRepository(review.worktree);
  if (
    verifiedRepository.path !== review.repository.path ||
    verifiedRepository.gitDir !== review.repository.gitDir ||
    verified.path !== review.worktree.path ||
    verified.gitDir !== review.workspaceGitDir
  ) {
    throw new Error('Local Git worktree identity changed after review.');
  }

  const run = async (path: string, args: string[]): Promise<string> => {
    try {
      return await git(path, args);
    } catch {
      // Git stderr can contain credential-bearing remotes. Never surface it.
      throw new Error('Local Git attestation command failed.');
    }
  };

  const workspaceGit = async (args: string[]) => run(verified.path, args);
  const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  let repositoryCommon: string;
  let workspaceCommon: string;
  try {
    repositoryCommon = await realpath((await run(verifiedRepository.path, commonArgs)).trim());
    workspaceCommon = await realpath((await workspaceGit(commonArgs)).trim());
  } catch {
    throw new Error('Local Git common directory could not be verified.');
  }
  if (repositoryCommon !== workspaceCommon) {
    throw new Error('Local Git worktree belongs to a different repository.');
  }

  const status = async () =>
    workspaceGit([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]);
  const head = async () =>
    (await workspaceGit(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const branch = async () =>
    (await workspaceGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  const base = async () =>
    (
      await workspaceGit([
        'rev-parse',
        '--verify',
        `refs/heads/${plan.baseBranch}^{commit}`,
      ])
    ).trim();
  const remote = async () =>
    (await workspaceGit(['remote', 'get-url', 'origin'])).trim();

  if (await status()) throw new Error('Local Git worktree or index is not clean.');
  if ((await branch()) !== plan.branch) {
    throw new Error('Local Git branch changed since operator review.');
  }
  if ((await head()) !== review.commits.headCommitSha) {
    throw new Error('Local Git HEAD differs from the reviewed commit.');
  }
  if ((await base()) !== review.commits.baseCommitSha) {
    throw new Error('Local Git base branch differs from the reviewed commit.');
  }

  const origin = parseGitHubRemote(await remote());
  if (!origin || origin.url !== plan.destination) {
    throw new Error('Local Git origin does not match the approved destination.');
  }

  // Detect cooperative or incidental mutation during the read-only checks.
  // These final checks are still protected by the caller's shared Git lease.
  const finalOrigin = parseGitHubRemote(await remote());
  if (
    (await status()) ||
    (await branch()) !== plan.branch ||
    (await head()) !== review.commits.headCommitSha ||
    (await base()) !== review.commits.baseCommitSha ||
    !finalOrigin ||
    finalOrigin.url !== origin.url
  ) {
    throw new Error('Local Git state changed during attestation.');
  }

  return {
    ...review.commits,
    worktreePath: verified.path,
    gitDir: verified.gitDir,
    remote: origin.url,
    branch: plan.branch,
  };
}
