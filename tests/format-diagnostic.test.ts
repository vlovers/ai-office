import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { format, resolveConfig } from 'prettier';

it('prints temporary exact formatting diagnostics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-office-prettier-diagnostic-'));
  try {
    for (const path of [
      'src/server/delivery-github-readonly.ts',
      'tests/delivery-github-readonly.test.ts',
    ]) {
      const original = readFileSync(path, 'utf8');
      const formatted = await format(original, {
        ...(await resolveConfig(path)),
        filepath: path,
      });
      const oldPath = join(directory, 'original');
      const newPath = join(directory, 'formatted');
      writeFileSync(oldPath, original);
      writeFileSync(newPath, formatted);
      const diff = spawnSync('diff', ['-u', oldPath, newPath], { encoding: 'utf8' });
      process.stdout.write('FORMAT DIFF ' + path + '\n' + diff.stdout + '\n');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
