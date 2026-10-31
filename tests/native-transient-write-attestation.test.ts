import { expect, it } from 'vitest';
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertProtectedMetadataUnchanged,
  captureProtectedMetadata,
  verifyNativeIsolation,
} from '../src/server/providers/native-isolation.js';

async function withDirectory(run: (root: string, nested: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-transient-')));
  const nested = join(root, 'nested');
  try {
    await mkdir(nested);
    await run(root, nested);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('accepts unchanged protected directory identity and timestamps', async () => {
  await withDirectory(async (root, nested) => {
    const before = await captureProtectedMetadata([root, nested]);
    await expect(assertProtectedMetadataUnchanged(before)).resolves.toBeUndefined();
  });
});

it('detects a transient create/remove even when no file survives', async () => {
  await withDirectory(async (root, nested) => {
    const before = await captureProtectedMetadata([root, nested]);
    // Ensure distinguishable timestamps on filesystems with millisecond precision.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const transient = join(nested, 'forbidden-temporary');
    await writeFile(transient, 'temporary');
    await rm(transient);
    await expect(readFile(transient)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(nested)).ino).toBe(before[1]!.ino);
    await expect(assertProtectedMetadataUnchanged(before)).rejects.toThrow(
      'Sandbox modified protected filesystem metadata.',
    );
  });
});

it('detects a transient nested directory creation after cleanup', async () => {
  await withDirectory(async (root, nested) => {
    const before = await captureProtectedMetadata([root, nested]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const transient = join(nested, '.hidden-escape');
    await mkdir(transient);
    await rm(transient, { recursive: true });
    await expect(readFile(transient)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(assertProtectedMetadataUnchanged(before)).rejects.toThrow(
      'Sandbox modified protected filesystem metadata.',
    );
  });
});

const native = it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux');

native(
  'fails closed when a fake sandbox creates and removes a forbidden file before reporting denial',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-transient-fake-')));
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
  esac
fi
if [ "$1" = "/usr/bin/touch" ]; then
  case "$2" in
    */write-escape)
      : > "$2"
      rm -f "$2"
      : > "${root}/attempted"
      exit 7 ;;
  esac
fi
exit 7
`,
      );
      await chmod(fake, 0o700);
      await expect(verifyNativeIsolation(fake)).rejects.toThrow(
        'Native sandbox capability verification failed.',
      );
      expect(await readFile(join(root, 'attempted'), 'utf8')).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
