import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'prettier';
import { it } from 'vitest';

it('prints formatter differences for the workflow checkpoint batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-office-format-'));
  try {
    for (const path of ['src/web/workflow-board.tsx', 'tests/browser-workflow-restart.ts']) {
      const original = readFileSync(path, 'utf8');
      const formatted = await format(original, {
        filepath: path,
        singleQuote: true,
        trailingComma: 'all',
        printWidth: 100,
      });
      writeFileSync(join(dir, 'before'), original);
      writeFileSync(join(dir, 'after'), formatted);
      try {
        execFileSync('diff', ['-u', join(dir, 'before'), join(dir, 'after')], {
          encoding: 'utf8',
        });
      } catch (cause) {
        console.log('FORMAT-DIFF-BEGIN', path);
        console.log((cause as { stdout?: string }).stdout);
        console.log('FORMAT-DIFF-END', path);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
