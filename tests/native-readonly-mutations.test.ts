import { expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyNativeIsolation } from '../src/server/providers/native-isolation.js';

const native = it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux');

// A denied exit is not evidence if the sandbox performed the mutation first.
// Each fixture permits exactly one normally forbidden operation, then exits 7.
for (const [label, operation, mutation] of [
  ['unlink', '/bin/rm', '/bin/rm "$2"'],
  ['rename', '/bin/mv', '/bin/mv "$2" "$3"'],
  ['chmod', '/bin/chmod', '/bin/chmod "$2" "$3"'],
  ['mkdir', '/bin/mkdir', '/bin/mkdir "$2"'],
] as const) {
  native(
    `rejects a masked read-only ${label} mutation despite a nonzero sandbox exit`,
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-namespace-denial-')));
      const fake = join(root, 'fake-sandbox.sh');
      const marker = join(root, 'mutated');
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
if [ "$1" = "${operation}" ]; then
  ${mutation} || exit 8
  printf 'yes' > "${marker}"
fi
exit 7
`,
        );
        await chmod(fake, 0o700);
        await expect(verifyNativeIsolation(fake)).rejects.toThrow('capability verification failed');
        expect(await readFile(marker, 'utf8')).toBe('yes');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
}
