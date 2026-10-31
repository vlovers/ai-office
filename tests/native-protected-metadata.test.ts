import { expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertProtectedMetadataUnchanged,
  captureProtectedMetadata,
  verifyNativeIsolation,
} from '../src/server/providers/native-isolation.js';

async function withProtectedFiles(
  run: (paths: { root: string; file: string; link: string; alternate: string }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-metadata-')));
  const file = join(root, 'protected.txt');
  const alternate = join(root, 'alternate.txt');
  const link = join(root, 'protected-link');
  try {
    await writeFile(file, 'SAME_CANARY');
    await writeFile(alternate, 'SAME_CANARY');
    await symlink(file, link);
    await run({ root, file, link, alternate });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('accepts unchanged protected file and symlink metadata', async () => {
  await withProtectedFiles(async ({ file, link }) => {
    const snapshot = await captureProtectedMetadata([file, link]);
    await expect(assertProtectedMetadataUnchanged(snapshot)).resolves.toBeUndefined();
  });
});

it('rejects a permission-only mutation with identical protected bytes', async () => {
  await withProtectedFiles(async ({ file }) => {
    const snapshot = await captureProtectedMetadata([file]);
    const before = await lstat(file);
    await chmod(file, (before.mode & 0o777) ^ 0o100);
    expect(await readFile(file, 'utf8')).toBe('SAME_CANARY');
    await expect(assertProtectedMetadataUnchanged(snapshot)).rejects.toThrow(
      'Sandbox modified protected filesystem metadata.',
    );
  });
});

it('rejects a symlink retarget to a byte-identical alternate file', async () => {
  await withProtectedFiles(async ({ file, link, alternate }) => {
    const snapshot = await captureProtectedMetadata([file, link]);
    await rm(link);
    await symlink(alternate, link);
    expect(await readFile(link, 'utf8')).toBe('SAME_CANARY');
    await expect(assertProtectedMetadataUnchanged(snapshot)).rejects.toThrow(
      'Sandbox modified protected filesystem metadata.',
    );
  });
});

it('rejects atomic replacement by a byte-identical inode', async () => {
  await withProtectedFiles(async ({ file, alternate }) => {
    const snapshot = await captureProtectedMetadata([file]);
    await rename(alternate, file);
    expect(await readFile(file, 'utf8')).toBe('SAME_CANARY');
    await expect(assertProtectedMetadataUnchanged(snapshot)).rejects.toThrow(
      'Sandbox modified protected filesystem metadata.',
    );
  });
});

it('rejects timestamp tampering without changing protected bytes', async () => {
  await withProtectedFiles(async ({ file }) => {
    const snapshot = await captureProtectedMetadata([file]);
    const old = new Date('2001-01-01T00:00:00.000Z');
    await utimes(file, old, old);
    expect(await readFile(file, 'utf8')).toBe('SAME_CANARY');
    await expect(assertProtectedMetadataUnchanged(snapshot)).rejects.toThrow(
      'Sandbox modified protected filesystem metadata.',
    );
  });
});

const native = it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux');

native(
  'fails closed when a fake native sandbox chmods a protected file and reports denial',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-metadata-fake-')));
    const fake = join(root, 'fake-sandbox.sh');
    try {
      await writeFile(
        fake,
        `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] || exit 9
shift
if [ "$1" = "/bin/cat" ]; then
  case "$2" in
    */allowed.txt) printf 'READ_ALLOWED\\n'; exit 0 ;;
    */.env) chmod 0400 "$2"; touch "${root}/metadata-mutated"; exit 7 ;;
  esac
fi
exit 7
`,
      );
      await chmod(fake, 0o700);
      await expect(verifyNativeIsolation(fake)).rejects.toThrow(
        'Native sandbox capability verification failed.',
      );
      expect(await readFile(join(root, 'metadata-mutated'), 'utf8')).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
