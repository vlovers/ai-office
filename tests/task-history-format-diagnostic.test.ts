import { readFileSync } from 'node:fs';
import * as prettier from 'prettier';
import { describe, it } from 'vitest';

describe('temporary task history formatting diagnostic', () => {
  it('shows the exact first Prettier mismatch', async () => {
    const path = new URL('../src/web/task-history.tsx', import.meta.url).pathname;
    const actual = readFileSync(path, 'utf8');
    const expected = await prettier.format(actual, {
      ...(await prettier.resolveConfig(path)),
      filepath: path,
    });
    if (actual === expected) return;
    let offset = 0;
    while (offset < actual.length && actual[offset] === expected[offset]) offset++;
    throw new Error(
      `First formatting mismatch at offset ${offset}\nActual: ${JSON.stringify(actual.slice(Math.max(0, offset - 120), offset + 350))}\nExpected: ${JSON.stringify(expected.slice(Math.max(0, offset - 120), offset + 350))}`,
    );
  });
});
