import { beforeEach, expect, it, vi } from 'vitest';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixtures = vi.hoisted(() => ({
  cleanup: null as null | { entered: () => void; resume: Promise<void> },
  preflight: vi.fn(async () => {}),
  verification: vi.fn(async (..._args: unknown[]) => ({ passed: true, output: 'approved' })),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rm: async (...args: Parameters<typeof original.rm>) => {
      if (typeof args[0] === 'string' && args[0].includes('ai-office-qa-') && fixtures.cleanup) {
        fixtures.cleanup.entered();
        await fixtures.cleanup.resume;
      }
      return original.rm(...args);
    },
  };
});

vi.mock('../src/server/providers/native-isolation.js', () => ({
  nativeCodex: '/mock-native-codex',
  sandboxArguments: (_directory: string, argv: string[]) => ['--', ...argv],
  verifyNativeIsolation: fixtures.preflight,
}));
vi.mock('../src/server/verification.js', () => ({
  runVerification: fixtures.verification,
}));

import { qaPlan, runSandboxedQA } from '../src/server/qa-runner.js';

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.cleanup = null;
  fixtures.preflight.mockImplementation(async () => {});
  fixtures.verification.mockImplementation(async () => ({ passed: true, output: 'approved' }));
});

function pauseHomeRemoval() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixtures.cleanup = { entered, resume };
  return { started, release };
}

it.each([
  { label: 'successful verification', passed: true, cancelled: true },
  { label: 'denied verification', passed: false, cancelled: true },
  { label: 'successful verification without cancellation', passed: true, cancelled: false },
  { label: 'denied verification without cancellation', passed: false, cancelled: false },
])(
  'preserves QA cancellation provenance during HOME cleanup: $label',
  async (scenario) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-office-qa-cleanup-fixture-')));
    const controller = new AbortController();
    const { started, release } = pauseHomeRemoval();
    const result = { passed: scenario.passed, output: 'supervisor finished' };
    try {
      const plan = await qaPlan('approved', ['/bin/echo', 'safe'], 2000);
      fixtures.verification.mockResolvedValueOnce(result);
      const pending = runSandboxedQA(root, plan, controller.signal);
      await started;
      expect(fixtures.verification).toHaveBeenCalledOnce();
      if (scenario.cancelled) controller.abort();
      release();

      await expect(pending).resolves.toEqual(
        scenario.cancelled
          ? { passed: false, output: 'QA stopped before launch.', incomplete: true }
          : result,
      );
      const environment = fixtures.verification.mock.calls[0]?.[4] as { HOME: string };
      await expect(lstat(environment.HOME)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      release();
      fixtures.cleanup = null;
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
