import { afterEach, expect, it, vi } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  assertPrivateDirectory,
  ensureLeaseRoot,
  ResourceLockedError,
  UnsafeLockDirectoryError,
} from '../src/server/lock.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
async function parent() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-lock-')));
  roots.push(root);
  return root;
}
const mode = async (path: string) => (await lstat(path)).mode & 0o777;

it('creates a private lease root and accepts it again without modification', async () => {
  const root = join(await parent(), 'leases');
  await ensureLeaseRoot(root);
  expect(await mode(root)).toBe(0o700);
  await ensureLeaseRoot(root);
  const release = await acquireLock(join(root, 'lease'), 'test');
  await release();
});

it('rejects world-writable and group-accessible directories without modifying them', async () => {
  const base = await parent();
  for (const [name, bits] of [
    ['world', 0o777],
    ['group', 0o750],
    ['other-read', 0o704],
  ] as const) {
    const root = join(base, name);
    await mkdir(root);
    await chmod(root, bits);
    await expect(assertPrivateDirectory(root)).rejects.toBeInstanceOf(UnsafeLockDirectoryError);
    await expect(ensureLeaseRoot(root)).rejects.toBeInstanceOf(UnsafeLockDirectoryError);
    await expect(acquireLock(join(root, 'lease'), 'test')).rejects.toBeInstanceOf(
      UnsafeLockDirectoryError,
    );
    expect(await mode(root)).toBe(bits); // never repaired
    expect(await readdir(root)).toEqual([]); // no lease created inside
  }
});

it('rejects a symlink at the lease-root path even when it targets a private directory', async () => {
  const base = await parent();
  const target = join(base, 'target');
  await mkdir(target, { mode: 0o700 });
  const link = join(base, 'link');
  await symlink(target, link);
  await expect(ensureLeaseRoot(link)).rejects.toBeInstanceOf(UnsafeLockDirectoryError);
  await expect(acquireLock(join(link, 'lease'), 'test')).rejects.toBeInstanceOf(
    UnsafeLockDirectoryError,
  );
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readdir(target)).toEqual([]);
});

it('rejects unexpected filesystem objects and leaves them intact', async () => {
  const base = await parent();
  const file = join(base, 'file');
  await writeFile(file, 'not a directory', { mode: 0o600 });
  await expect(ensureLeaseRoot(file)).rejects.toBeInstanceOf(UnsafeLockDirectoryError);
  expect(await readFile(file, 'utf8')).toBe('not a directory');
});

it('fails closed when ownership cannot be established', async () => {
  const root = join(await parent(), 'leases');
  await ensureLeaseRoot(root);
  // Simulated foreign owner (chown needs root): the directory's uid no longer matches.
  vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
  await expect(acquireLock(join(root, 'lease'), 'test')).rejects.toBeInstanceOf(
    UnsafeLockDirectoryError,
  );
  expect(await readdir(root)).toEqual([]);
});

it.skipIf(process.getuid?.() === 0)('fails closed when the path cannot be inspected', async () => {
  const base = await parent();
  const sealed = join(base, 'sealed');
  await mkdir(join(sealed, 'leases'), { recursive: true, mode: 0o700 });
  await chmod(sealed, 0o000);
  try {
    await expect(ensureLeaseRoot(join(sealed, 'leases'))).rejects.toBeInstanceOf(
      UnsafeLockDirectoryError,
    );
  } finally {
    await chmod(sealed, 0o700);
  }
});

it('keeps existing legitimate leases and grants a contested lease to exactly one caller', async () => {
  const root = await ensureLeaseRoot(join(await parent(), 'leases'));
  const lease = join(root, 'lease');
  const release = await acquireLock(lease, 'holder');
  const owner = await readFile(join(lease, 'owner.json'), 'utf8');
  await expect(acquireLock(lease, 'intruder')).rejects.toBeInstanceOf(ResourceLockedError);
  expect(await readFile(join(lease, 'owner.json'), 'utf8')).toBe(owner);
  await release();

  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) => acquireLock(lease, `racer ${index}`)),
  );
  const winners = results.filter((result) => result.status === 'fulfilled');
  expect(winners).toHaveLength(1);
  expect(
    results.filter(
      (result) => result.status === 'rejected' && result.reason instanceof ResourceLockedError,
    ),
  ).toHaveLength(11);
  await (winners[0] as PromiseFulfilledResult<() => Promise<void>>).value();
});
