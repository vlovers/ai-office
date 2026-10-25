import { readFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { expect, it } from 'vitest';

it('emits canonical formatter output for the crash test', async () => {
  const path = 'tests/delivery-draft-real-git-race.integration.test.ts';
  const source = readFileSync(path, 'utf8');
  const formatted = await format(source, { ...(await resolveConfig(path)), filepath: path });
  expect(formatted.length).toBeGreaterThan(100);
  console.log('FORMAT_PROBE_START:' + Buffer.from(formatted).toString('base64') + ':FORMAT_PROBE_END');
});
