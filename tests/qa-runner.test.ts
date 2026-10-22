import { expect, it } from 'vitest';
import { mkdtemp, realpath, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qaPlan, runSandboxedQA } from '../src/server/qa-runner.js';
import { verifyNativeIsolation } from '../src/server/providers/native-isolation.js';

const native = it.skipIf(
  process.platform !== 'darwin' && process.env.AI_OFFICE_NATIVE_TESTS !== '1',
);
it('rejects unconfigured, relative and excessive QA plans', async () => {
  await expect(qaPlan('missing', undefined)).rejects.toThrow();
  await expect(qaPlan('relative', ['node', '--test'])).rejects.toThrow();
  await expect(qaPlan('timeout', ['/bin/echo'], Infinity)).rejects.toThrow();
  await expect(qaPlan('nul', ['/bin/echo', '\0'])).rejects.toThrow();
  await expect(qaPlan('bounded', ['/bin/echo'], 120001)).rejects.toThrow();
});
native(
  'proves native read-only, secret, outside-read and network denial without inference',
  async () => {
    await verifyNativeIsolation();
    await expect(verifyNativeIsolation('/bin/true')).rejects.toThrow(
      'capability verification failed',
    );
  },
  30000,
);
native(
  'executes real QA assertions, denies writes and secrets, bounds output, times out and cancels descendants',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-native-')));
    try {
      await writeFile(join(root, 'README.md'), 'expected');
      await writeFile(join(root, '.env'), 'SECRET_MUST_NOT_LEAK');
      const run = async (argv: string[], timeout = 3000, signal = new AbortController().signal) =>
        runSandboxedQA(root, await qaPlan('test', argv, timeout), signal);
      expect(
        await run([
          '/bin/sh',
          '-c',
          'test "$(cat README.md)" = expected && echo assertions-passed',
        ]),
      ).toMatchObject({ passed: true, output: 'assertions-passed\n' });
      const denied = await run(['/bin/sh', '-c', 'cat .env; touch README.md; touch forbidden']);
      expect(denied.passed).toBe(false);
      expect(denied.output).not.toContain('SECRET_MUST_NOT_LEAK');
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('expected');
      await expect(readFile(join(root, 'forbidden'))).rejects.toThrow();
      expect((await run(['/bin/sh', '-c', 'sleep 30 & wait'], 200)).passed).toBe(false);
      const controller = new AbortController();
      const pending = run(['/bin/sh', '-c', 'sleep 30 & wait'], 5000, controller.signal);
      setTimeout(() => controller.abort(), 1000);
      expect((await pending).passed).toBe(false);
      const flood = await run(['/usr/bin/yes'], 5000);
      expect(flood.passed).toBe(false);
      expect(flood.output.length).toBeLessThanOrEqual(128100);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
