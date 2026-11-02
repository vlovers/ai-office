import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import { format } from 'prettier';

describe('temporary formatter diagnostics', () => {
  it('prints canonical workflow polling test formatting', async () => {
    const path = 'tests/workflow-polling.test.ts';
    const source = await readFile(path, 'utf8');
    const formatted = await format(source, { filepath: path });
    console.log('WORKFLOW_POLLING_FORMAT_START\n' + formatted + 'WORKFLOW_POLLING_FORMAT_END');
  });
});
