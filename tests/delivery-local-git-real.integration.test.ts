import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attestLocalReviewedGitState } from '../src/server/delivery-local-git-attestation.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';

const branch = 'ai-office/12345678-1234-1234-1234-123456789abc';
const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch,
  baseBranch: 'main' as const,
  revision: 'a'.repeat(64),
  draft: true as const,
};

function setupGit() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-real-git-review-')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'AI Office Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(path, 'README.md'), 'base\n');
    git('add', 'README.md');
    git('commit', '-qm', 'base');
    const baseCommitSha = git('rev-parse', 'HEAD');
    git('switch', '-q', '-c', branch);
    writeFileSync(join(path, 'README.md'), 'reviewed head\n');
    git('add', 'README.md');
    git('commit', '-qm', 'reviewed');
    const headCommitSha = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', 'git@github.com:vlovers/ai-office.git');
    const gitDir = realpathSync(join(path, '.git'));
    const worktree = { path, gitDir };
    const review = {
      repository: worktree,
      worktree,
      workspaceGitDir: gitDir,
      commits: {
        operationKey: publicationKey(plan),
        headCommitSha,
        baseCommitSha,
      },
    };
    return { path, git, review, close: () => rmSync(path, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

describe('real Git reviewed-snapshot integration', () => {
  it('attests an actual clean managed branch and exact reviewed commits', async () => {
    const t = setupGit();
    try {
      const result = await attestLocalReviewedGitState(plan, t.review);
      expect(result).toMatchObject({
        ...t.review.commits,
        branch,
        remote: plan.destination,
        worktreePath: t.path,
      });
    } finally {
      t.close();
    }
  });

  it('rejects a dirty worktree after a successful real Git attestation', async () => {
    const t = setupGit();
    try {
      await attestLocalReviewedGitState(plan, t.review);
      writeFileSync(join(t.path, 'untracked.txt'), 'unreviewed\n');
      await expect(attestLocalReviewedGitState(plan, t.review)).rejects.toThrow('not clean');
    } finally {
      t.close();
    }
  });

  it('rejects a moved local base commit even when the reviewed head is unchanged', async () => {
    const t = setupGit();
    try {
      t.git('switch', '-q', 'main');
      writeFileSync(join(t.path, 'base-moved.txt'), 'new base\n');
      t.git('add', 'base-moved.txt');
      t.git('commit', '-qm', 'move base');
      t.git('switch', '-q', branch);
      await expect(attestLocalReviewedGitState(plan, t.review)).rejects.toThrow(
        'base branch differs',
      );
    } finally {
      t.close();
    }
  });

  it('rejects an actual origin change without making remote requests', async () => {
    const t = setupGit();
    try {
      t.git('remote', 'set-url', 'origin', 'git@github.com:foreign/repository.git');
      await expect(attestLocalReviewedGitState(plan, t.review)).rejects.toThrow(
        'origin does not match',
      );
    } finally {
      t.close();
    }
  });
});
