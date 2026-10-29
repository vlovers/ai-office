import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import {
  mkdtemp,
  realpath,
  writeFile,
  rm,
  readFile,
  chmod,
  rename,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qaPlan, runSandboxedQA, type QAPlan } from '../src/server/qa-runner.js';
import {
  listenProbeServer,
  verifyNativeIsolation,
} from '../src/server/providers/native-isolation.js';

it('removes transient HTTP listener callbacks after successful native probe bind', async () => {
  const server = createServer();
  try {
    const errors = server.listenerCount('error');
    const listening = server.listenerCount('listening');
    await listenProbeServer(server);
    expect(server.listenerCount('error')).toBe(errors);
    expect(server.listenerCount('listening')).toBe(listening);
  } finally {
    server.close();
  }
});

it('cleans native probe listeners when listen throws synchronously', async () => {
  const server = createServer();
  try {
    await listenProbeServer(server);
    const errors = server.listenerCount('error');
    const listening = server.listenerCount('listening');
    await expect(listenProbeServer(server)).rejects.toThrow();
    expect(server.listenerCount('error')).toBe(errors);
    expect(server.listenerCount('listening')).toBe(listening);
  } finally {
    server.close();
  }
});

it('cleans native probe listeners after an asynchronous bind error', async () => {
  const occupied = createServer();
  const contender = createServer();
  try {
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Missing occupied port.');
    // Force an asynchronous EADDRINUSE on the same address using the server's
    // native listen method while retaining the normal probe lifecycle handler.
    const originalListen = contender.listen.bind(contender);
    contender.listen = ((..._args: Parameters<typeof contender.listen>) =>
      originalListen(address.port, '127.0.0.1')) as typeof contender.listen;
    const errors = contender.listenerCount('error');
    const listening = contender.listenerCount('listening');
    await expect(listenProbeServer(contender)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(contender.listenerCount('error')).toBe(errors);
    expect(contender.listenerCount('listening')).toBe(listening);
  } finally {
    if (contender.listening) contender.close();
    if (occupied.listening) occupied.close();
  }
});

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
it('rejects missing, broken, directory and non-executable QA commands before approval', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-invalid-command-')));
  const executable = join(root, 'qa.sh');
  const brokenLink = join(root, 'broken-link');
  try {
    await writeFile(executable, '#!/bin/sh\\nexit 0\\n');
    await chmod(executable, 0o600);
    await expect(qaPlan('not-executable', [executable])).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(qaPlan('directory', [root])).rejects.toMatchObject({ statusCode: 409 });
    await expect(qaPlan('missing', [join(root, 'missing')])).rejects.toMatchObject({
      statusCode: 409,
    });
    await symlink(join(root, 'missing'), brokenLink);
    await expect(qaPlan('broken-symlink', [brokenLink])).rejects.toMatchObject({
      statusCode: 409,
    });
    await chmod(executable, 0o700);
    await expect(qaPlan('valid', [executable])).resolves.toMatchObject({
      commandId: 'valid',
      argv: [executable],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function expectQAPlanConflict(directory: string, plan: QAPlan) {
  await expect(runSandboxedQA(directory, plan, new AbortController().signal)).rejects.toMatchObject(
    { statusCode: 409 },
  );
}

it('rejects changed or missing approved QA executables', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-pinned-executable-')));
  const executable = join(root, 'approved-qa.sh');
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    const plan = await qaPlan('approved', [executable, '--safe'], 1000);
    await writeFile(executable, '#!/bin/sh\necho changed\n');
    await expectQAPlanConflict(root, plan);

    // A byte-identical replacement with a different inode is forbidden too.
    const reapproved = await qaPlan('approved', [executable, '--safe'], 1000);
    const replacement = join(root, 'replacement.sh');
    await writeFile(replacement, '#!/bin/sh\necho changed\n');
    await chmod(replacement, 0o700);
    await rename(replacement, executable);
    await expectQAPlanConflict(root, reapproved);

    const swapped = await qaPlan('approved', [executable, '--safe'], 1000);
    await rm(executable);
    await expectQAPlanConflict(root, swapped);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects metadata-only changes to an approved executable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-mode-change-')));
  const executable = join(root, 'approved-qa.sh');
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    const plan = await qaPlan('approved', [executable], 1000);
    await chmod(executable, 0o600);
    await expectQAPlanConflict(root, plan);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('pins a symlink approval to the resolved executable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-symlink-')));
  const executable = join(root, 'approved.sh');
  const replacement = join(root, 'replacement.sh');
  const alias = join(root, 'qa.sh');
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await writeFile(replacement, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    await chmod(replacement, 0o700);
    await symlink(executable, alias);
    const plan = await qaPlan('approved', [alias, '--safe'], 1000);
    expect(plan.argv).toEqual([executable, '--safe']);
    await rm(alias);
    await symlink(replacement, alias);
    const newPlan = await qaPlan('approved', [alias, '--safe'], 1000);
    expect(newPlan.argv[0]).toBe(replacement);
    expect(newPlan.digest).not.toBe(plan.digest);
    expect(plan.argv[0]).toBe(executable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects tampered approved QA arguments, timeout, and digest before preflight', async () => {
  const plan = await qaPlan('approved', ['/bin/echo', 'safe'], 1000);
  const changed = [
    { ...plan, argv: [plan.argv[0]!, 'unsafe'] },
    { ...plan, commandId: 'different-command' },
    { ...plan, timeoutMs: 2000 },
    { ...plan, digest: '0'.repeat(64) },
  ];
  for (const candidate of changed) {
    await expectQAPlanConflict('/does-not-exist', candidate);
  }
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
const fakeNative = it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux');

async function waitForProbeMarkers(paths: string[]) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = await Promise.all(paths.map((p) => readFile(p).then(Boolean, () => false)));
    if (found.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Native probe processes did not start.');
}

fakeNative('rejects an already-aborted preflight before starting a subprocess', async () => {
  const controller = new AbortController();
  controller.abort();
  const pending = verifyNativeIsolation('/nonexistent-native-probe', controller.signal);
  await expect(pending).rejects.toThrow('verification was cancelled');
});

fakeNative(
  'interrupts an in-flight native read probe without waiting for its ten-second timeout',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-probe-read-abort-')));
    const controller = new AbortController();
    const fake = join(root, 'fake-sandbox.sh');
    await writeFile(
      fake,
      `#!/bin/sh
case "$*" in
  *allowed.txt*) touch "${root}/read-started"; exec /bin/sleep 30 ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(fake, 0o700);
    const pending = verifyNativeIsolation(fake, controller.signal);
    try {
      await waitForProbeMarkers([join(root, 'read-started')]);
      const started = Date.now();
      controller.abort();
      await expect(pending).rejects.toThrow('capability verification failed');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      controller.abort();
      await pending.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
  12000,
);

fakeNative(
  'interrupts all four concurrent native denial probes on cancellation',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-probe-denial-abort-')));
    const controller = new AbortController();
    const fake = join(root, 'fake-sandbox.sh');
    await writeFile(
      fake,
      `#!/bin/sh
# Codex --config arguments include .env deny patterns. Inspect only the
# sandbox command after the -- separator, not its permission configuration.
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] || exit 1
shift
case "$*" in
  *allowed.txt*) printf 'READ_ALLOWED\\n'; exit 0 ;;
  *outside.txt*) marker=outside ;;
  *.env*) marker=secret ;;
  *write-escape*) marker=write ;;
  *127.0.0.1:*) marker=network ;;
  *) exit 1 ;;
esac
touch "${root}/$marker"
exec /bin/sleep 30
`,
    );
    await chmod(fake, 0o700);
    const pending = verifyNativeIsolation(fake, controller.signal);
    try {
      const markers = ['outside', 'secret', 'write', 'network'].map((name) => join(root, name));
      await waitForProbeMarkers(markers);
      const started = Date.now();
      controller.abort();
      await expect(pending).rejects.toThrow('capability verification failed');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      controller.abort();
      await pending.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
  12000,
);

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
# Ignore --config values, which contain .env deny patterns, and inspect only
# the actual sandbox command following the -- separator.
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] || exit 1
shift
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
