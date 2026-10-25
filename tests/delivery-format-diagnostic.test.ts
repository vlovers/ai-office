import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'prettier';
import { it } from 'vitest';

it('temporary formatting diagnostic for Draft PR integration tests', async () => {
  const target = 'tests/delivery-approved-github-publication.test.ts';
  const original = readFileSync(target, 'utf8');
  const formatted = await format(original, { filepath: target });
  const root = mkdtempSync(join(tmpdir(), 'delivery-format-diff-'));
  try {
    const expected = join(root, 'expected.ts');
    writeFileSync(expected, formatted);
    try {
      execFileSync('diff', ['-u', target, expected], { encoding: 'utf8' });
    } catch (error) {
      const output = (error as { stdout?: string }).stdout ?? '';
      console.log('EXACT_PRETTIER_DIFF_START\n' + output + '\nEXACT_PRETTIER_DIFF_END');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
