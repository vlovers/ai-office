import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { runVerification } from '../src/server/verification.js';
import { killProcessGroup, reapProcessGroup } from '../src/server/process-group.js';
import { until } from './helpers.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it('does not treat denied process-group cleanup as confirmed termination', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  expect(() => killProcessGroup(123)).toThrow('cleanup could not be confirmed');
  kill.mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  expect(() => killProcessGroup(123)).not.toThrow();
});
it('bounds commands whose exited parent leaves descendants holding its output open', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-supervisor-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const start = Date.now();
  const result = await runVerification(['/bin/sh', '-c', 'sleep 60 & exit 0'], root, 100);
  expect(result.passed).toBe(false);
  expect(result.output).toContain('time/output limit');
  expect(Date.now() - start).toBeLessThan(5000);
});
it('supervises host verification after abrupt backend death without passing host environment secrets', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-verify-orphan-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const child = fork(new URL('./fixtures/verification-child.ts', import.meta.url), [root], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  // File polling here never accesses an external project or credentials.
  let marker: { pid: number; group: number } | undefined;
  for (let i = 0; i < 200 && !marker; i++) {
    marker = await readFile(join(root, 'started.json'), 'utf8').then(
      (text) => JSON.parse(text),
      () => undefined,
    );
    if (!marker) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(marker).toBeDefined();
  const group = marker!.group;
  cleanups.push(async () => {
    try {
      killProcessGroup(group);
    } catch {
      /* failure remains visible in assertions */
    }
  });
  child.kill('SIGKILL');
  await exited;
  await until(
    () => {
      try {
        process.kill(-group, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
        throw error;
      }
    },
    (alive) => !alive,
  );
  await expect(lstat(join(root, 'must-not-run'))).rejects.toThrow();
  process.env.AI_OFFICE_FAKE_AUDIT_SECRET = 'SYNTHETIC_MARKER';
  try {
    const result = await runVerification(
      [
        process.execPath,
        '-e',
        'process.stdout.write(process.env.AI_OFFICE_FAKE_AUDIT_SECRET ?? "absent")',
      ],
      root,
      1000,
    );
    expect(result).toEqual({ passed: true, output: 'absent' });
  } finally {
    delete process.env.AI_OFFICE_FAKE_AUDIT_SECRET;
  }
});

it('retries transient EPERM without accepting persistent denied cleanup', async () => {
  const kill = vi
    .spyOn(process, 'kill')
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('reaping'), { code: 'EPERM' });
    })
    .mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
  await expect(reapProcessGroup(123, 100)).resolves.toBeUndefined();
  kill.mockImplementation(() => {
    throw Object.assign(new Error('still denied'), { code: 'EPERM' });
  });
  await expect(reapProcessGroup(123, 40)).rejects.toThrow('cleanup could not be confirmed');
});
it('waits for worker closure when verification is aborted during shutdown', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-verify-abort-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const pending = runVerification(['/bin/sleep', '60'], root, 60_000, controller.signal);
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    expect((await pending).passed).toBe(false);
  } finally {
    clearTimeout(timer);
  }
});

it('attests an ordinary nonzero process exit without marking it incomplete', async () => {
  const result = await runVerification(['/bin/sh', '-c', 'exit 7'], tmpdir(), 1000);
  expect(result).toEqual({ passed: false, output: '' });
});

it('marks an executable spawn failure as incomplete, not a sandbox denial', async () => {
  const result = await runVerification(
    ['/nonexistent-ai-office-verification-executable'],
    tmpdir(),
    1000,
  );
  expect(result).toMatchObject({ passed: false, incomplete: true });
  expect(result.output).toContain('could not start');
});

it('marks timed-out and signal-terminated processes as incomplete', async () => {
  const timedOut = await runVerification(['/bin/sleep', '30'], tmpdir(), 100);
  expect(timedOut).toMatchObject({ passed: false, incomplete: true });
  expect(timedOut.output).toContain('time/output limit');

  const signaled = await runVerification(['/bin/sh', '-c', 'kill -TERM $$'], tmpdir(), 1000);
  expect(signaled).toMatchObject({ passed: false, incomplete: true });
});

it('marks an output-limit termination as incomplete', async () => {
  const result = await runVerification(['/usr/bin/yes'], tmpdir(), 5000);
  expect(result).toMatchObject({ passed: false, incomplete: true });
  expect(result.output).toContain('time/output limit');
  expect(result.output.length).toBeLessThanOrEqual(128100);
});
