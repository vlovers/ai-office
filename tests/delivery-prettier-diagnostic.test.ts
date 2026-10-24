import { readFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { describe, it } from 'vitest';

describe('temporary formatting diagnostics', () => {
  it('prints the exact expected formatter output', async () => {
    const path = 'tests/delivery-approved-transfer-reservation.test.ts';
    const source = readFileSync(path, 'utf8');
    const config = await resolveConfig(path);
    const expected = await format(source, { ...config, filepath: path });
    if (source !== expected) {
      console.log('PRETTIER_EXPECTED_BEGIN\n' + expected + '\nPRETTIER_EXPECTED_END');
    }
  });
});
