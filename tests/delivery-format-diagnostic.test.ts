import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';

it('reports exact Prettier differences without changing the working tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-format-diff-'));
  try {
    for (const path of [
      'docs/DELIVERY_PRODUCTION_CHECKLIST.md',
      'tests/delivery-git-transfer-ownership.test.ts',
    ]) {
      const original = readFileSync(path, 'utf8');
      const formatted = execFileSync('node_modules/.bin/prettier', ['--stdin-filepath', path], {
        input: original,
        encoding: 'utf8',
      });
      if (original === formatted) continue;
      const before = join(root, 'before');
      const after = join(root, 'after');
      writeFileSync(before, original);
      writeFileSync(after, formatted);
      const diff = spawnSync('diff', ['-u', before, after], { encoding: 'utf8' });
      process.stdout.write(`FORMAT_DIAGNOSTIC ${path}\n${diff.stdout}\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
