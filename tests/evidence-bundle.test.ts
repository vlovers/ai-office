import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeEvidenceBundle } from '../src/server/evidence-bundle.js';

it('captures additions, edits, deletions and a deterministic evidence digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-office-evidence-bundle-'));
  try {
    const workspace = join(dir, 'workspace');
    const destinationRoot = join(dir, 'bundles');
    await mkdir(workspace);
    await mkdir(destinationRoot);
    await writeFile(join(workspace, 'updated.txt'), 'approved changes');
    await writeFile(join(workspace, 'new.txt'), 'addition');
    const bundle = await materializeEvidenceBundle({
      workspacePath: workspace,
      destinationRoot,
      files: [
        { path: 'updated.txt', status: 'M' },
        { path: 'new.txt', status: '??' },
        { path: 'deleted.txt', status: 'D' },
      ],
      evidenceRevision: 'a'.repeat(64),
      verifyRevision: async () => 'a'.repeat(64),
    });
    expect((await readFile(join(bundle.path, 'updated.txt'))).toString()).toBe('approved changes');
    expect(bundle.manifest.entries[2]?.sha256).toBeNull();
    expect(bundle.manifest.entries[2]?.status).toBe('D');
    expect(bundle.manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(join(bundle.path, 'manifest.json'), 'utf8'))).toEqual(
      bundle.manifest,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects changed revisions, symlinks and an unsafe destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-office-evidence-unsafe-'));
  try {
    const workspace = join(dir, 'workspace');
    const destinationRoot = join(dir, 'bundles');
    await mkdir(workspace);
    await mkdir(destinationRoot);
    await writeFile(join(workspace, 'real.txt'), 'hello');
    await symlink('real.txt', join(workspace, 'link.txt'));
    const input = {
      workspacePath: workspace,
      destinationRoot,
      evidenceRevision: 'a'.repeat(64),
      verifyRevision: async () => 'a'.repeat(64),
    };
    await expect(
      materializeEvidenceBundle({ ...input, files: [{ path: 'link.txt', status: '??' }] }),
    ).rejects.toThrow();
    await expect(
      materializeEvidenceBundle({
        ...input,
        files: [{ path: 'real.txt', status: 'M' }],
        verifyRevision: async () => 'b'.repeat(64),
      }),
    ).rejects.toThrow();
    await symlink(destinationRoot, join(dir, 'bundles-link'));
    await expect(
      materializeEvidenceBundle({
        ...input,
        destinationRoot: join(dir, 'bundles-link'),
        files: [{ path: 'real.txt', status: 'M' }],
      }),
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
