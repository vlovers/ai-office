import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import {
  attestLocalReviewedGitState,
  type LocalGitReview,
} from '../src/server/delivery-local-git-attestation.js';

const { git, revalidateRepository } = vi.hoisted(() => ({
  git: vi.fn(),
  revalidateRepository: vi.fn(),
}));
vi.mock('../src/server/repositories.js', () => ({ git, revalidateRepository }));

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const worktree = { path: '/repo/worktree', gitDir: '/repo/.git/worktrees/office' };
const review: LocalGitReview = {
  worktree,
  workspaceGitDir: worktree.gitDir,
  commits: {
    operationKey: publicationKey(plan),
    headCommitSha: '1'.repeat(40),
    baseCommitSha: '2'.repeat(40),
  },
};

type GitReply = {
  status: string;
  branch: string;
  head: string;
  base: string;
  remote: string;
};

let replies: GitReply;
let calls: string[];

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  replies = {
    status: '',
    branch: plan.branch,
    head: review.commits.headCommitSha,
    base: review.commits.baseCommitSha,
    remote: 'git@github.com:vlovers/ai-office.git',
  };
  revalidateRepository.mockResolvedValue({
    ...worktree,
    name: 'worktree',
  });
  git.mockImplementation(async (_path: string, args: string[]) => {
    const command = args.join(' ');
    calls.push(command);
    if (args[0] === 'status') return replies.status;
    if (args[0] === 'symbolic-ref') return replies.branch + '\n';
    if (args[0] === 'remote') return replies.remote + '\n';
    if (args[0] === 'rev-parse' && args[2] === 'HEAD^{commit}') {
      return replies.head + '\n';
    }
    if (args[0] === 'rev-parse' && args[2] === 'refs/heads/main^{commit}') {
      return replies.base + '\n';
    }
    throw new Error('Unexpected Git command.');
  });
});

describe('lease-scoped local Git attestation', () => {
  it('attests clean worktree, exact commits and credential-free SSH origin', async () => {
    const result = await attestLocalReviewedGitState(plan, review);
    expect(result).toMatchObject({
      ...review.commits,
      branch: plan.branch,
      remote: plan.destination,
      worktreePath: worktree.path,
      gitDir: worktree.gitDir,
    });
    expect(revalidateRepository).toHaveBeenCalledWith(worktree);
    expect(calls.filter((call) => call.startsWith('status '))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('rev-parse '))).toHaveLength(4);
  });

  it('accepts a canonical HTTPS origin without network or remote writes', async () => {
    replies.remote = plan.destination + '.git';
    await expect(attestLocalReviewedGitState(plan, review)).resolves.toBeDefined();
    expect(calls.every((call) => !/push|fetch|commit|reset/.test(call))).toBe(true);
  });

  it('rejects uncommitted and untracked changes before inspecting refs', async () => {
    for (const status of [' M src/file.ts\0', '?? new-file\0', 'A  staged.ts\0']) {
      replies.status = status;
      await expect(attestLocalReviewedGitState(plan, review)).rejects.toThrow(
        'not clean',
      );
      expect(calls).toHaveLength(1);
      calls = [];
    }
  });

  it('rejects detached or changed branches', async () => {
    replies.branch = 'main';
    await expect(attestLocalReviewedGitState(plan, review)).rejects.toThrow(
      'branch changed',
    );
  });

  it('rejects stale head or base commit snapshots', async () => {
    replies.head = '3'.repeat(40);
    await expect(attestLocalReviewedGitState(plan, review)).rejects.toThrow(
      'HEAD differs',
    );
    replies.head = review.commits.headCommitSha;
    replies.base = '4'.repeat(40);
    await expect(attestLocalReviewedGitState(plan, review)).rejects.toThrow(
      'base branch differs',
    );
  });

  it('rejects credential-bearing, foreign and malformed origins', async () => {
    for (const remote of [
      'https://token@github.com/vlovers/ai-office',
      'https://github.com/attacker/ai-office',
      'https://evil.example/vlovers/ai-office',
      'file:///repo',
    ]) {
      replies.remote = remote;
      await expect(attestLocalReviewedGitState(plan, review)).rejects.toThrow(
        'origin does not match',
      );
    }
  });

  it('rejects changed workspace Git directory identity', async () => {
    revalidateRepository.mockResolvedValueOnce({
      ...worktree,
      gitDir: '/other/.git',
    });
    await expect(attestLocalReviewedGitState(plan, review)).rejects.toThrow(
      'identity changed',
    );
    expect(git).not.toHaveBeenCalled();
  });

  it('rejects a foreign workspace Git directory before any Git command', async () => {
    await expect(
      attestLocalReviewedGitState(plan, {
        ...review,
        workspaceGitDir: '/other/.git',
      }),
    ).rejects.toThrow('identity does not match');
    expect(revalidateRepository).not.toHaveBeenCalled();
  });

  it('rejects a stale publication operation before any Git command', async () => {
    await expect(
      attestLocalReviewedGitState(plan, {
        ...review,
        commits: { ...review.commits, operationKey: 'wrong' },
      }),
    ).rejects.toThrow('does not match approved commits');
    expect(revalidateRepository).not.toHaveBeenCalled();
  });

  it('rejects a blocked plan and unmanaged branch', async () => {
    await expect(
      attestLocalReviewedGitState({ allowed: false, reason: 'blocked' }, review),
    ).rejects.toThrow('blocked publication');
    await expect(
      attestLocalReviewedGitState({ ...plan, branch: 'main' }, review),
    ).rejects.toThrow();
    expect(git).not.toHaveBeenCalled();
  });

  it('rejects an external branch mutation detected on the second pass', async () => {
    let count = 0;
    git.mockImplementation(async (_path: string, args: string[]) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'symbolic-ref') {
        count++;
        return count === 1 ? plan.branch : 'main';
      }
      if (args[0] === 'remote') return replies.remote;
      if (args[2] === 'HEAD^{commit}') return replies.head;
      return replies.base;
    });
    await expect(attestLocalReviewedGitState(plan, review)).rejects.toThrow(
      'changed during attestation',
    );
  });

  it('fails closed and does not leak Git stderr', async () => {
    git.mockRejectedValueOnce(new Error('fatal: token=super-secret'));
    await expect(attestLocalReviewedGitState(plan, review)).rejects.toThrow(
      'Local Git attestation command failed.',
    );
  });
});
