import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createReviewerSourceCandidate } from '../src/server/reviewer-source.js';

it('captures a bounded full source candidate without authorizing Reviewer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-reviewer-source-'));
  const workspace = join(root, 'repo');
  const destinationRoot = join(root, 'snapshots');
  try {
    await mkdir(workspace);
    await mkdir(destinationRoot);
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    await writeFile(join(workspace, 'README.md'), 'original');
    execFileSync('git', ['add', 'README.md'], { cwd: workspace });
    await writeFile(join(workspace, 'README.md'), 'modified');
    await writeFile(join(workspace, 'new.txt'), 'untracked');
    const revision = 'a'.repeat(64);
    const result = await createReviewerSourceCandidate({
      workspace,
      destinationRoot,
      revision,
      verifyRevision: async () => revision,
    });
    expect(await readFile(join(result.directory, 'README.md'), 'utf8')).toBe('modified');
    expect(await readFile(join(result.directory, 'new.txt'), 'utf8')).toBe('untracked');
    expect(result.manifest.files).toHaveLength(2);
    expect(result.manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    await chmod(result.directory, 0o700);
    await rm(result.directory, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('fails closed on linked source, secrets, and changed revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-reviewer-source-unsafe-'));
  const workspace = join(root, 'repo');
  const destinationRoot = join(root, 'snapshots');
  try {
    await mkdir(workspace);
    await mkdir(destinationRoot);
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    await writeFile(join(workspace, 'README.md'), 'safe');
    execFileSync('git', ['add', 'README.md'], { cwd: workspace });
    const revision = 'a'.repeat(64);
    const options = {
      workspace,
      destinationRoot,
      revision,
      verifyRevision: async () => revision,
    };
    await symlink('README.md', join(workspace, 'link.txt'));
    await expect(createReviewerSourceCandidate(options)).rejects.toThrow();
    await rm(join(workspace, 'link.txt'));
    await writeFile(join(workspace, '.env'), 'secret');
    await expect(createReviewerSourceCandidate(options)).rejects.toThrow();
    await rm(join(workspace, '.env'));
    await expect(
      createReviewerSourceCandidate({
        ...options,
        verifyRevision: async () => 'b'.repeat(64),
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
