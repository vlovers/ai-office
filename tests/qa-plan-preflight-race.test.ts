import { beforeEach, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const native = vi.hoisted(() => ({
  preflight: vi.fn(async () => {}),
  verification: vi.fn(async () => ({ passed: true, output: 'approved' })),
}));

vi.mock('../src/server/providers/native-isolation.js', () => ({
  nativeCodex: '/mock-native-codex',
  sandboxArguments: (_directory: string, argv: string[]) => ['--', ...argv],
  verifyNativeIsolation: native.preflight,
}));
vi.mock('../src/server/verification.js', () => ({
  runVerification: native.verification,
}));

import { qaPlan, runSandboxedQA } from '../src/server/qa-runner.js';

beforeEach(() => {
  vi.clearAllMocks();
  native.preflight.mockImplementation(async () => {});
  native.verification.mockImplementation(async () => ({ passed: true, output: 'approved' }));
});

function preflightGate() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  native.preflight.mockImplementationOnce(async () => {
    entered();
    await gate;
  });
  return { started, release };
}

it('refuses an inode swap during native preflight without launching verification', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-preflight-swap-')));
  const executable = join(root, 'approved.sh');
  const replacement = join(root, 'replacement.sh');
  const { started, release } = preflightGate();
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    const plan = await qaPlan('approved', [executable, '--safe'], 2000);
    const pending = runSandboxedQA(root, plan, new AbortController().signal);
    await started;

    // Identical bytes and permissions still represent a different approved inode.
    await writeFile(replacement, '#!/bin/sh\nexit 0\n');
    await chmod(replacement, 0o700);
    await rename(replacement, executable);
    release();

    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(native.preflight).toHaveBeenCalledOnce();
    expect(native.verification).not.toHaveBeenCalled();
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it('stops a QA request cancelled while native preflight is pending', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-preflight-abort-')));
  const { started, release } = preflightGate();
  const controller = new AbortController();
  try {
    const plan = await qaPlan('approved', ['/bin/echo', 'safe'], 2000);
    const pending = runSandboxedQA(root, plan, controller.signal);
    await started;
    controller.abort();
    release();

    await expect(pending).resolves.toEqual({
      passed: false,
      output: 'QA stopped before launch.',
    });
    expect(native.verification).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    release();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it('passes an unchanged approved command to the supervisor after preflight', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-preflight-valid-')));
  try {
    const plan = await qaPlan('approved', ['/bin/echo', 'safe'], 2000);
    const controller = new AbortController();
    await expect(runSandboxedQA(root, plan, controller.signal)).resolves.toEqual({
      passed: true,
      output: 'approved',
    });
    expect(native.preflight).toHaveBeenCalledOnce();
    expect(native.verification).toHaveBeenCalledOnce();
    expect(native.verification).toHaveBeenCalledWith(
      [process.execPath, '/mock-native-codex', '--', ...plan.argv],
      root,
      2000,
      controller.signal,
      expect.objectContaining({ HOME: expect.any(String), CODEX_HOME: expect.any(String) }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it('rejects an executable permission change during native preflight', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-preflight-mode-')));
  const executable = join(root, 'approved.sh');
  const { started, release } = preflightGate();
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    const plan = await qaPlan('approved', [executable], 2000);
    const pending = runSandboxedQA(root, plan, new AbortController().signal);
    await started;
    await chmod(executable, 0o600);
    release();

    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(native.verification).not.toHaveBeenCalled();
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it('does not launch verification if cancellation arrives as native preflight finishes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-preflight-finish-abort-')));
  const controller = new AbortController();
  try {
    const plan = await qaPlan('approved', ['/bin/echo', 'safe'], 2000);
    native.preflight.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(runSandboxedQA(root, plan, controller.signal)).resolves.toEqual({
      passed: false,
      output: 'QA stopped before launch.',
    });
    expect(native.verification).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it('removes isolated QA home even when verification supervisor rejects', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-supervisor-error-')));
  let home: string | undefined;
  try {
    const plan = await qaPlan('approved', ['/bin/echo', 'safe'], 2000);
    native.verification.mockImplementationOnce(async (...args: unknown[]) => {
      home = (args[4] as { HOME: string }).HOME;
      throw new Error('verification supervisor failed');
    });
    await expect(runSandboxedQA(root, plan, new AbortController().signal)).rejects.toThrow(
      'verification supervisor failed',
    );
    expect(home).toBeDefined();
    await expect(lstat(home!)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
