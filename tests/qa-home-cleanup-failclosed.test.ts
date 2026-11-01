import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { qaPlan, runSandboxedQA } from '../src/server/qa-runner.js';
import { UncertainCleanupError } from '../src/server/process-group.js';

const controls = vi.hoisted(() => ({
  createdHome: '',
  canonicalHome: '',
  stagedRoot: '',
  stagedHome: '',
  swapBeforeStageRename: '' as '' | 'symlink' | 'directory',
  failStageRename: false,
  failCanonicalization: false,
  failInitialIdentity: false,
  swapBeforeInitialIdentity: false,
  transientCanonicalRedirect: false,
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
      if (prefix.includes('ai-office-qa-cleanup-')) controls.stagedRoot = home;
      else if (prefix.includes('ai-office-qa-')) controls.createdHome = home;
      return home;
    },
    lstat: async (path: string) => {
      if (path === controls.createdHome && controls.failInitialIdentity) {
        controls.failInitialIdentity = false;
        if (controls.swapBeforeInitialIdentity) {
          await actual.rm(path, { recursive: true, force: true });
          await actual.symlink(controls.protectedHome, path, 'dir');
        }
        throw new Error('injected initial QA HOME identity failure');
      }
      return actual.lstat(path);
    },
    realpath: async (path: string) => {
      if (path === controls.createdHome && controls.transientCanonicalRedirect) {
        controls.transientCanonicalRedirect = false;
        const backup = path + '-canonical-original';
        await actual.rename(path, backup);
        await actual.symlink(controls.protectedHome, path, 'dir');
        const redirected = await actual.realpath(path);
        await actual.rm(path, { force: true });
        await actual.rename(backup, path);
        return redirected;
      }
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
    rename: async (from: string, to: string) => {
      if (from === controls.createdHome && to === join(controls.stagedRoot, 'home')) {
        controls.stagedHome = to;
        if (controls.failStageRename) {
          controls.failStageRename = false;
          throw new Error('injected QA HOME staging rename failure');
        }
        if (controls.swapBeforeStageRename) {
          const replacement = controls.swapBeforeStageRename;
          controls.swapBeforeStageRename = '';
          controls.replacedHomeBackup = from + '-original';
          await actual.rename(from, controls.replacedHomeBackup);
          if (replacement === 'symlink') {
            await actual.symlink(controls.protectedHome, from, 'dir');
          } else {
            await actual.mkdir(from);
            await actual.writeFile(join(from, 'keep'), 'replacement');
          }
        }
      }
      return actual.rename(from, to);
    },
    rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      if (controls.failRemoval && path === controls.stagedHome) {
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
  controls.stagedRoot = '';
  controls.stagedHome = '';
  controls.swapBeforeStageRename = '';
  controls.failStageRename = false;
  controls.failCanonicalization = false;
  controls.failInitialIdentity = false;
  controls.swapBeforeInitialIdentity = false;
  controls.transientCanonicalRedirect = false;
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
    if (controls.stagedRoot) {
      await actualFs.rm(controls.stagedRoot, { recursive: true, force: true });
    }
  }
}

it('quarantines a HOME whose initial identity could not be established', async () => {
  await withApprovedPlan(async (plan) => {
    controls.failInitialIdentity = true;
    await expect(runSandboxedQA('/tmp', plan, new AbortController().signal)).rejects.toBeInstanceOf(
      UncertainCleanupError,
    );
    expect(native.verification).not.toHaveBeenCalled();
    // No trusted inode was recorded, so even the original path is not deleted.
    await expect(actualFs.lstat(controls.createdHome)).resolves.toBeDefined();
  });
});

it('never removes a swapped symlink when initial HOME lstat fails', async () => {
  const protectedHome = await actualFs.mkdtemp(join(tmpdir(), 'ai-office-protected-'));
  try {
    await actualFs.writeFile(join(protectedHome, 'keep'), 'untouched');
    await withApprovedPlan(async (plan) => {
      controls.protectedHome = protectedHome;
      controls.failInitialIdentity = true;
      controls.swapBeforeInitialIdentity = true;
      await expect(
        runSandboxedQA('/tmp', plan, new AbortController().signal),
      ).rejects.toBeInstanceOf(UncertainCleanupError);
      expect(native.verification).not.toHaveBeenCalled();
      expect((await actualFs.lstat(controls.createdHome)).isSymbolicLink()).toBe(true);
      expect(await actualFs.readFile(join(protectedHome, 'keep'), 'utf8')).toBe('untouched');
    });
  } finally {
    await actualFs.rm(protectedHome, { recursive: true, force: true });
  }
});

it('rejects a transient realpath redirect even if the original HOME inode is restored', async () => {
  const protectedHome = await actualFs.mkdtemp(join(tmpdir(), 'ai-office-protected-'));
  try {
    await withApprovedPlan(async (plan) => {
      controls.protectedHome = protectedHome;
      controls.transientCanonicalRedirect = true;
      await expect(
        runSandboxedQA('/tmp', plan, new AbortController().signal),
      ).rejects.toBeInstanceOf(UncertainCleanupError);
      expect(native.verification).not.toHaveBeenCalled();
      // The original directory was restored, so its identity was verified and
      // the ordinary safe cleanup path can still remove it.
      await expect(actualFs.lstat(controls.createdHome)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  } finally {
    await actualFs.rm(protectedHome, { recursive: true, force: true });
  }
});

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
    await expect(actualFs.lstat(controls.createdHome)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(actualFs.lstat(controls.stagedHome)).resolves.toBeDefined();
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
      expect((await actualFs.lstat(controls.createdHome)).isSymbolicLink()).toBe(true);
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
    await expect(actualFs.lstat(controls.createdHome)).resolves.toBeDefined();
    await expect(actualFs.lstat(controls.replacedHomeBackup)).resolves.toBeDefined();
  });
});

it('does not delete a redirected HOME when the supervisor swaps in a symlink', async () => {
  const protectedHome = await actualFs.mkdtemp(join(tmpdir(), 'ai-office-protected-'));
  try {
    await actualFs.writeFile(join(protectedHome, 'keep'), 'untouched');
    await withApprovedPlan(async (plan) => {
      native.verification.mockImplementationOnce(async () => {
        controls.replacedHomeBackup = controls.createdHome + '-original';
        await actualFs.rename(controls.createdHome, controls.replacedHomeBackup);
        await actualFs.symlink(protectedHome, controls.createdHome, 'dir');
        return { passed: true, output: 'stale success' };
      });
      await expect(
        runSandboxedQA('/tmp', plan, new AbortController().signal),
      ).rejects.toBeInstanceOf(UncertainCleanupError);
      expect(native.verification).toHaveBeenCalledOnce();
      expect((await actualFs.lstat(controls.createdHome)).isSymbolicLink()).toBe(true);
      expect(await actualFs.readFile(join(protectedHome, 'keep'), 'utf8')).toBe('untouched');
      await expect(actualFs.lstat(controls.replacedHomeBackup)).resolves.toBeDefined();
    });
  } finally {
    await actualFs.rm(protectedHome, { recursive: true, force: true });
  }
});

it('does not recursively delete a replacement directory after supervisor completion', async () => {
  await withApprovedPlan(async (plan) => {
    native.verification.mockImplementationOnce(async () => {
      controls.replacedHomeBackup = controls.createdHome + '-original';
      await actualFs.rename(controls.createdHome, controls.replacedHomeBackup);
      await actualFs.mkdir(controls.createdHome);
      await actualFs.writeFile(join(controls.createdHome, 'keep'), 'replacement');
      return { passed: true, output: 'stale success' };
    });
    await expect(runSandboxedQA('/tmp', plan, new AbortController().signal)).rejects.toBeInstanceOf(
      UncertainCleanupError,
    );
    expect(native.verification).toHaveBeenCalledOnce();
    expect(await actualFs.readFile(join(controls.createdHome, 'keep'), 'utf8')).toBe('replacement');
    await expect(actualFs.lstat(controls.replacedHomeBackup)).resolves.toBeDefined();
  });
});

it('quarantines a missing HOME after supervisor completion instead of reporting success', async () => {
  await withApprovedPlan(async (plan) => {
    native.verification.mockImplementationOnce(async () => {
      controls.replacedHomeBackup = controls.createdHome + '-original';
      await actualFs.rename(controls.createdHome, controls.replacedHomeBackup);
      return { passed: true, output: 'stale success' };
    });
    await expect(runSandboxedQA('/tmp', plan, new AbortController().signal)).rejects.toBeInstanceOf(
      UncertainCleanupError,
    );
    expect(native.verification).toHaveBeenCalledOnce();
    await expect(actualFs.lstat(controls.createdHome)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(actualFs.lstat(controls.replacedHomeBackup)).resolves.toBeDefined();
  });
});

it('stages an attested HOME under a private root and removes both on success', async () => {
  await withApprovedPlan(async (plan) => {
    await expect(runSandboxedQA('/tmp', plan, new AbortController().signal)).resolves.toMatchObject({
      passed: true,
    });
    expect(native.verification).toHaveBeenCalledOnce();
    expect(controls.stagedRoot).not.toBe('');
    expect(controls.stagedHome).toBe(join(controls.stagedRoot, 'home'));
    await expect(actualFs.lstat(controls.createdHome)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(actualFs.lstat(controls.stagedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('quarantines a directory swapped between the final lstat and staging rename', async () => {
  await withApprovedPlan(async (plan) => {
    controls.swapBeforeStageRename = 'directory';
    await expect(
      runSandboxedQA('/tmp', plan, new AbortController().signal),
    ).rejects.toBeInstanceOf(UncertainCleanupError);
    expect(native.verification).toHaveBeenCalledOnce();
    expect(await actualFs.readFile(join(controls.stagedHome, 'keep'), 'utf8')).toBe('replacement');
    await expect(actualFs.lstat(controls.replacedHomeBackup)).resolves.toBeDefined();
    await expect(actualFs.lstat(controls.stagedRoot)).resolves.toBeDefined();
  });
});

it('quarantines a symlink swapped at staging without touching its external target', async () => {
  const protectedHome = await actualFs.mkdtemp(join(tmpdir(), 'ai-office-protected-'));
  try {
    await actualFs.writeFile(join(protectedHome, 'keep'), 'untouched');
    await withApprovedPlan(async (plan) => {
      controls.protectedHome = protectedHome;
      controls.swapBeforeStageRename = 'symlink';
      await expect(
        runSandboxedQA('/tmp', plan, new AbortController().signal),
      ).rejects.toBeInstanceOf(UncertainCleanupError);
      expect(native.verification).toHaveBeenCalledOnce();
      expect((await actualFs.lstat(controls.stagedHome)).isSymbolicLink()).toBe(true);
      expect(await actualFs.readFile(join(protectedHome, 'keep'), 'utf8')).toBe('untouched');
      await expect(actualFs.lstat(controls.replacedHomeBackup)).resolves.toBeDefined();
    });
  } finally {
    await actualFs.rm(protectedHome, { recursive: true, force: true });
  }
});

it('quarantines a failed staging rename instead of deleting the original HOME', async () => {
  await withApprovedPlan(async (plan) => {
    controls.failStageRename = true;
    await expect(
      runSandboxedQA('/tmp', plan, new AbortController().signal),
    ).rejects.toBeInstanceOf(UncertainCleanupError);
    expect(native.verification).toHaveBeenCalledOnce();
    await expect(actualFs.lstat(controls.createdHome)).resolves.toBeDefined();
    await expect(actualFs.lstat(controls.stagedRoot)).resolves.toBeDefined();
  });
});
