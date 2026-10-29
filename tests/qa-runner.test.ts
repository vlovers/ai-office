import { expect, it } from 'vitest';
import { mkdtemp, realpath, writeFile, rm, readFile, chmod } from 'node:fs/promises';
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
it('does not start native capability probes for an already-cancelled QA request', async () => {
  const controller = new AbortController();
  controller.abort();
  const plan = await qaPlan('cancelled', ['/bin/echo'], 1000);
  expect(await runSandboxedQA('/does-not-exist', plan, controller.signal)).toEqual({
    passed: false,
    output: 'QA stopped before launch.',
  });
});
native(
  'rejects a forged sandbox that allows forbidden operations after passing the read probe',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-probe-forged-')));
    try {
      const fake = join(root, 'fake-sandbox.sh');
      await writeFile(
        fake,
        `#!/bin/sh
case "$*" in
  *allowed.txt*) printf 'READ_ALLOWED\\n' ;;
  *) exit 0 ;;
esac
`,
      );
      await chmod(fake, 0o700);
      await expect(verifyNativeIsolation(fake)).rejects.toThrow('capability verification failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
native(
  'checks all independent native sandbox denial probes concurrently without serial timeout amplification',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-probe-parallel-')));
    try {
      const fake = join(root, 'fake-sandbox.sh');
      await writeFile(
        fake,
        `#!/bin/sh
case "$*" in
  *allowed.txt*) printf 'READ_ALLOWED\\n'; exit 0 ;;
  *outside.txt*) marker=outside ;;
  *.env*) marker=secret ;;
  *write-escape*) marker=write ;;
  *127.0.0.1:*) marker=network ;;
  *) exit 0 ;;
esac
touch "${root}/$marker"
i=0
while [ "$i" -lt 200 ]; do
  if [ -f "${root}/outside" ] && [ -f "${root}/secret" ] && [ -f "${root}/write" ] && [ -f "${root}/network" ]; then
    exit 1
  fi
  sleep 0.02
  i=$((i + 1))
done
exit 0
`,
      );
      await chmod(fake, 0o700);
      await expect(verifyNativeIsolation(fake)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
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
