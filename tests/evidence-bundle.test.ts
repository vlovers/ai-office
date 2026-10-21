import { expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  materializeEvidenceBundle,
  removeEvidenceBundle,
  verifyEvidenceBundle,
} from '../src/server/evidence-bundle.js';

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
    expect(await verifyEvidenceBundle(bundle.path, bundle.manifest)).toBe(true);
    await removeEvidenceBundle(destinationRoot, bundle.path);
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

it('detects tampering and safely removes read-only evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-office-evidence-tamper-'));
  try {
    const workspace = join(dir, 'source');
    const destinationRoot = join(dir, 'bundles');
    await mkdir(workspace);
    await mkdir(destinationRoot);
    await writeFile(join(workspace, 'change.txt'), 'approved');
    const result = await materializeEvidenceBundle({
      workspacePath: workspace,
      destinationRoot,
      files: [{ path: 'change.txt', status: 'M' }],
      evidenceRevision: 'a'.repeat(64),
      verifyRevision: async () => 'a'.repeat(64),
    });
    expect(await verifyEvidenceBundle(result.path, result.manifest)).toBe(true);
    await chmod(join(result.path, 'change.txt'), 0o600);
    await writeFile(join(result.path, 'change.txt'), 'tampered');
    expect(await verifyEvidenceBundle(result.path, result.manifest)).toBe(false);
    await expect(removeEvidenceBundle(destinationRoot, workspace)).rejects.toThrow();
    await removeEvidenceBundle(destinationRoot, result.path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects extra unapproved files and manifest identity substitution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-bundle-extra-'));
  try {
    const workspace = join(root, 'source');
    const destinationRoot = join(root, 'bundles');
    await mkdir(workspace);
    await mkdir(destinationRoot);
    await writeFile(join(workspace, 'approved.txt'), 'approved');
    const bundle = await materializeEvidenceBundle({
      workspacePath: workspace,
      destinationRoot,
      files: [{ path: 'approved.txt', status: 'M' }],
      evidenceRevision: 'a'.repeat(64),
      verifyRevision: async () => 'a'.repeat(64),
    });
    expect(await verifyEvidenceBundle(bundle.path, bundle.manifest)).toBe(true);
    const wrongIdentity = { ...bundle.manifest, id: 'different' };
    expect(await verifyEvidenceBundle(bundle.path, wrongIdentity)).toBe(false);
    await chmod(bundle.path, 0o700);
    await writeFile(join(bundle.path, 'unapproved.txt'), 'unapproved');
    expect(await verifyEvidenceBundle(bundle.path, bundle.manifest)).toBe(false);
    await removeEvidenceBundle(destinationRoot, bundle.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects unmanifested empty directories and tampered file metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-bundle-dir-'));
  try {
    const workspace = join(root, 'workspace');
    const destinationRoot = join(root, 'bundles');
    await mkdir(workspace);
    await mkdir(destinationRoot);
    await writeFile(join(workspace, 'file.txt'), 'original');
    const bundle = await materializeEvidenceBundle({
      workspacePath: workspace,
      destinationRoot,
      files: [{ path: 'file.txt', status: 'M' }],
      evidenceRevision: 'a'.repeat(64),
      verifyRevision: async () => 'a'.repeat(64),
    });
    expect(await verifyEvidenceBundle(bundle.path, bundle.manifest)).toBe(true);
    await chmod(bundle.path, 0o700);
    await mkdir(join(bundle.path, 'empty-unapproved'));
    expect(await verifyEvidenceBundle(bundle.path, bundle.manifest)).toBe(false);
    await removeEvidenceBundle(destinationRoot, bundle.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('cleans nested sealed directories after a failed or completed capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-office-evidence-nested-'));
  try {
    const workspace = join(root, 'workspace');
    const destinationRoot = join(root, 'bundles');
    await mkdir(join(workspace, 'nested'), { recursive: true });
    await mkdir(destinationRoot);
    await writeFile(join(workspace, 'nested', 'file.txt'), 'approved');
    const bundle = await materializeEvidenceBundle({
      workspacePath: workspace,
      destinationRoot,
      files: [{ path: 'nested/file.txt', status: 'M' }],
      evidenceRevision: 'a'.repeat(64),
      verifyRevision: async () => 'a'.repeat(64),
    });
    await chmod(join(bundle.path, 'nested'), 0o500);
    await removeEvidenceBundle(destinationRoot, bundle.path);
    await removeEvidenceBundle(destinationRoot, bundle.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
