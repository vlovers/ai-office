import { mkdir, writeFile, rm, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from './errors.js';

export class ResourceLockedError extends AppError {
  constructor() {
    super(
      409,
      'Resource is locked. Verify the previous AI Office/Codex processes and local lease before retrying.',
    );
  }
}
export class UnsafeLockDirectoryError extends AppError {
  constructor() {
    super(
      409,
      'Lease directory is not a private directory owned by this user. Inspect it manually; AI Office did not modify it.',
    );
  }
}

/** Fixed OS-local root so TMPDIR differences cannot bypass another process's lease. */
export function leaseRoot() {
  return join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
}

/**
 * Fail closed unless `directory` is a real directory (not a symlink), owned by
 * this user and inaccessible to group/other. Never repairs or deletes anything.
 * The descriptor is opened with O_NOFOLLOW and compared with the lstat result,
 * so a path swapped between the two checks is rejected.
 */
export async function assertPrivateDirectory(directory: string) {
  const uid = process.getuid?.();
  let handle;
  try {
    const link = await lstat(directory);
    if (!link.isDirectory() || link.isSymbolicLink()) throw new UnsafeLockDirectoryError();
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const info = await handle.stat();
    if (
      !info.isDirectory() ||
      info.ino !== link.ino ||
      info.dev !== link.dev ||
      (uid !== undefined && info.uid !== uid) ||
      (info.mode & 0o077) !== 0
    )
      throw new UnsafeLockDirectoryError();
  } catch (error) {
    if (error instanceof UnsafeLockDirectoryError) throw error;
    throw new UnsafeLockDirectoryError();
  } finally {
    await handle?.close();
  }
}

/** Create the lease root if absent (0700), then verify it. Existing paths are never modified. */
export async function ensureLeaseRoot(root = leaseRoot()) {
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new UnsafeLockDirectoryError();
  }
  await assertPrivateDirectory(root);
  return root;
}

// OS-local lease shared by all AI Office instances. Unknown/stale leases fail closed.
// We do not steal leases after a crash: the user must verify old processes have exited.
export async function acquireLock(directory: string, detail: string) {
  // The parent must be private before a lease inside it means anything.
  await assertPrivateDirectory(dirname(directory));
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new ResourceLockedError();
  }
  try {
    await writeFile(
      join(directory, 'owner.json'),
      JSON.stringify({ pid: process.pid, detail, at: new Date().toISOString() }),
      { mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(directory, { recursive: true, force: true });
}

// Acquire in deterministic order; a partial acquisition is released, never stolen.
export async function acquireLocks(directories: string[], detail: string) {
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const directory of [...new Set(directories)].sort())
      releases.push(await acquireLock(directory, detail));
  } catch (error) {
    for (const release of releases.reverse()) await release();
    throw error;
  }
  return async () => {
    for (const release of releases.reverse()) await release();
  };
}
