import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'vitest';
import * as prettier from 'prettier';

it('reports exact Prettier diffs for delivery test files', async () => {
  for (const name of [
    'tests/delivery-approved-github-publication.test.ts',
    'tests/delivery-publication-sqlite-integrity.test.ts',
  ]) {
    const path = resolve(name);
    const source = readFileSync(path, 'utf8');
    const config = (await prettier.resolveConfig(path)) ?? {};
    const formatted = await prettier.format(source, { ...config, filepath: path });
    if (formatted === source) continue;
    const directory = mkdtempSync(join(tmpdir(), 'ai-office-format-diagnostic-'));
    try {
      const formattedPath = join(directory, 'formatted.ts');
      writeFileSync(formattedPath, formatted);
      const diff = spawnSync('diff', ['-u', path, formattedPath], { encoding: 'utf8' });
      console.log('PRETTIER_DIFF_BEGIN ' + name + '\n' + diff.stdout + '\nPRETTIER_DIFF_END ' + name);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
