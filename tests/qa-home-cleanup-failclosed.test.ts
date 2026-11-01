import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { qaPlan, runSandboxedQA } from '../src/server/qa-runner.js';
import { UncertainCleanupError } from '../src/server/process-group.js';

const controls = vi.hoisted(() => ({
  createdHome: '',
  canonicalHome: '',
  failCanonicalization: false,
  failRemoval: false,
  replaceHome: '' as '' | 'symlink' | 'directory',
  protectedHome: '',
  replacedHomeBackup: '',
}));
const native = vi.hoisted(() => ({
  preflight: vi.fn(async () => {}),
  verification: vi.fn(async () => ({ passed: true, output: 'approved' })),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const home = await actual.mkdtemp(prefix);
      if (prefix.includes('ai-office-qa-')) controls.createdHome = home;
      return home;
    },
    realpath: async (path: string) => {
      if (path === controls.createdHome && controls.replaceHome) {
        const replacement = controls.replaceHome;
        controls.replaceHome = '';
        if (replacement === 'symlink') {
          await actual.rm(path, { recursive: true, force: true });
          await actual.symlink(controls.protectedHome, path, 'dir');
        } else {
          controls.replacedHomeBackup = path + '-original';
          await actual.rename(path, controls.replacedHomeBackup);
          await actual.mkdir(path);
        }
      }
      if (controls.failCanonicalization && path === controls.createdHome) {
        controls.failCanonicalization = false;
        throw new Error('injected QA HOME canonicalization failure');
      }
      const resolved = await actual.realpath(path);
      if (path === controls.createdHome) controls.canonicalHome = resolved;
      return resolved;
    },
    rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      if (
        controls.failRemoval &&
        (path === controls.createdHome || path === controls.canonicalHome)
      ) {
        controls.failRemoval = false;
        throw new Error('injected QA HOME removal failure');
      }
      return actual.rm(path, options);
    },
  };
});
vi.mock('../src/server/providers/native-isolation.js', () => ({
  nativeCodex: '/mock-native-codex',
  sandboxArguments: (_directory: string, argv: string[]) => ['--', ...argv],
  verifyNativeIsolation: native.preflight,
}));
vi.mock('../src/server/verification.js', () => ({
  runVerification: native.verification,
}));

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

beforeEach(() => {
  vi.clearAllMocks();
  controls.createdHome = '';
  controls.canonicalHome = '';
  controls.failCanonicalization = false;
  controls.failRemoval = false;
  controls.replaceHome = '';
  controls.protectedHome = '';
  controls.replacedHomeBackup = '';
  native.preflight.mockResolvedValue(undefined);
  native.verification.mockResolvedValue({ passed: true, output: 'approved' });
});

async function withApprovedPlan(run: (plan: Awaited<ReturnType<typeof qaPlan>>) => Promise<void>) {
  const plan = await qaPlan('approved', ['/bin/echo', 'safe'], 2000);
  try {
    await run(plan);
  } finally {
    if (controls.createdHome) {
      await actualFs.rm(controls.createdHome, { recursive: true, force: true });
    }
    if (controls.replacedHomeBackup) {
      await actualFs.rm(controls.replacedHomeBackup, { recursive: true, force: true });
    }
  }
}

it('removes the created QA HOME if realpath fails before supervisor launch', async () => {
  await withApprovedPlan(async (plan) => {
    controls.failCanonicalization = true;
    await expect(runSandboxedQA('/tmp', plan, new AbortController().signal)).rejects.toThrow(
      'injected QA HOME canonicalization failure',
    );
    expect(controls.createdHome).not.toBe('');
    await expect(actualFs.lstat(controls.createdHome)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(native.verification).not.toHaveBeenCalled();
  });
});

it('quarantines cleanup failure instead of returning an attested QA success', async () => {
  await withApprovedPlan(async (plan) => {
    controls.failRemoval = true;
    await expect(runSandboxedQA('/tmp', plan, new AbortController().signal)).rejects.toBeInstanceOf(
      UncertainCleanupError,
    );
    expect(native.verification).toHaveBeenCalledOnce();
    await expect(actualFs.lstat(controls.createdHome)).resolves.toBeDefined();
  });
});

it('preserves uncertain cleanup when verification also fails', async () => {
  await withApprovedPlan(async (plan) => {
    native.verification.mockRejectedValueOnce(new Error('supervisor failed'));
    controls.failRemoval = true;
    await expect(runSandboxedQA('/tmp', plan, new AbortController().signal)).rejects.toBeInstanceOf(
      UncertainCleanupError,
    );
    expect(native.verification).toHaveBeenCalledOnce();
  });
});

it('does not turn failed HOME removal into a harmless cancellation', async () => {
  await withApprovedPlan(async (plan) => {
    const controller = new AbortController();
    native.verification.mockImplementationOnce(async () => {
      controller.abort();
      return { passed: true, output: 'stale success' };
    });
    controls.failRemoval = true;
    await expect(runSandboxedQA('/tmp', plan, controller.signal)).rejects.toBeInstanceOf(
      UncertainCleanupError,
    );
    expect(native.verification).toHaveBeenCalledOnce();
  });
});

it('rejects a symlink swap and never removes the external resolved HOME', async () => {
  const protectedHome = await actualFs.mkdtemp(join(tmpdir(), 'ai-office-protected-'));
  try {
    await actualFs.writeFile(join(protectedHome, 'keep'), 'untouched');
    await withApprovedPlan(async (plan) => {
      controls.protectedHome = protectedHome;
      controls.replaceHome = 'symlink';
      await expect(
        runSandboxedQA('/tmp', plan, new AbortController().signal),
      ).rejects.toBeInstanceOf(UncertainCleanupError);
      expect(native.verification).not.toHaveBeenCalled();
      await expect(actualFs.lstat(controls.createdHome)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await actualFs.readFile(join(protectedHome, 'keep'), 'utf8')).toBe('untouched');
    });
  } finally {
    await actualFs.rm(protectedHome, { recursive: true, force: true });
  }
});

it('rejects a replaced directory inode before launching the supervisor', async () => {
  await withApprovedPlan(async (plan) => {
    controls.replaceHome = 'directory';
    await expect(runSandboxedQA('/tmp', plan, new AbortController().signal)).rejects.toBeInstanceOf(
      UncertainCleanupError,
    );
    expect(native.verification).not.toHaveBeenCalled();
    await expect(actualFs.lstat(controls.createdHome)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(actualFs.lstat(controls.replacedHomeBackup)).resolves.toBeDefined();
  });
});
