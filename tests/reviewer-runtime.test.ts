import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createReviewerSourceCandidate,
  verifyReviewerSourceCandidate,
} from '../src/server/reviewer-source.js';
import {
  stageReviewerGitContext,
  removeReviewerGitContext,
  verifyReviewerGitContext,
} from '../src/server/reviewer-runtime.js';

it('creates a remote-free clean Git context from an approved source candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-runtime-'));
  const workspace = join(root, 'repo');
  const sources = join(root, 'sources');
  const runtimes = join(root, 'runtimes');
  try {
    await mkdir(workspace);
    await mkdir(sources);
    await mkdir(runtimes);
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    await writeFile(join(workspace, 'README.md'), 'reviewable');
    execFileSync('git', ['add', 'README.md'], { cwd: workspace });
    const revision = 'a'.repeat(64);
    const snapshot = await createReviewerSourceCandidate({
      workspace,
      destinationRoot: sources,
      revision,
      verifyRevision: async () => revision,
    });
    const runtime = await stageReviewerGitContext({
      sourceDirectory: snapshot.directory,
      manifest: snapshot.manifest,
      destinationRoot: runtimes,
      verifyRevision: async () => revision,
    });
    const run = (args: string[]) =>
      execFileSync('git', args, { cwd: runtime.directory }).toString().trim();
    expect(run(['remote'])).toBe('');
    expect(run(['status', '--porcelain'])).toBe('');
    expect(run(['rev-parse', 'HEAD'])).toBe(runtime.commit);
    const verifyInput = {
      destinationRoot: runtimes,
      directory: runtime.directory,
      commit: runtime.commit,
      manifest: snapshot.manifest,
    };
    expect(await verifyReviewerGitContext(verifyInput)).toBe(true);
    const gitConfigPath = join(runtime.directory, '.git', 'config');
    const gitConfig = await readFile(gitConfigPath, 'utf8');
    await writeFile(gitConfigPath, gitConfig + '\n[core]\nfsmonitor = evil\n');
    expect(await verifyReviewerGitContext(verifyInput)).toBe(false);
    await writeFile(gitConfigPath, gitConfig);
    expect(await verifyReviewerGitContext(verifyInput)).toBe(true);
    await writeFile(join(runtime.directory, 'README.md'), 'tampered');
    expect(await verifyReviewerGitContext(verifyInput)).toBe(false);
    await writeFile(join(runtime.directory, 'README.md'), 'reviewable');
    expect(await verifyReviewerGitContext(verifyInput)).toBe(true);
    expect(await readFile(join(runtime.directory, 'README.md'), 'utf8')).toBe('reviewable');
    expect(await verifyReviewerSourceCandidate(snapshot.directory, snapshot.manifest)).toBe(true);
    await removeReviewerGitContext(runtimes, runtime.directory);
    await chmod(snapshot.directory, 0o700);
    await rm(snapshot.directory, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses staging when source integrity, symlinks or revision changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-runtime-unsafe-'));
  const workspace = join(root, 'repo');
  const sources = join(root, 'sources');
  const runtimes = join(root, 'runtimes');
  try {
    await mkdir(workspace);
    await mkdir(sources);
    await mkdir(runtimes);
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    await writeFile(join(workspace, 'README.md'), 'reviewable');
    execFileSync('git', ['add', 'README.md'], { cwd: workspace });
    const revision = 'a'.repeat(64);
    const snapshot = await createReviewerSourceCandidate({
      workspace,
      destinationRoot: sources,
      revision,
      verifyRevision: async () => revision,
    });
    const input = {
      sourceDirectory: snapshot.directory,
      manifest: snapshot.manifest,
      destinationRoot: runtimes,
      verifyRevision: async () => 'b'.repeat(64),
    };
    await expect(stageReviewerGitContext(input)).rejects.toThrow();
    await chmod(snapshot.directory, 0o700);
    await chmod(join(snapshot.directory, 'README.md'), 0o600);
    await rm(join(snapshot.directory, 'README.md'));
    await symlink('source-manifest.json', join(snapshot.directory, 'README.md'));
    await expect(
      stageReviewerGitContext({ ...input, verifyRevision: async () => revision }),
    ).rejects.toThrow();
    await rm(join(snapshot.directory, 'README.md'));
    await rm(snapshot.directory, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
