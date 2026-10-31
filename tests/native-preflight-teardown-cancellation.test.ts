import { beforeEach, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  cleanup: null as null | { entered: () => void; resume: Promise<void> },
  verification: vi.fn(async (..._args: unknown[]) => ({ passed: false, output: 'denied' })),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rm: async (...args: Parameters<typeof original.rm>) => {
      if (
        typeof args[0] === 'string' &&
        args[0].includes('ai-office-policy-') &&
        fixtures.cleanup
      ) {
        fixtures.cleanup.entered();
        await fixtures.cleanup.resume;
      }
      return original.rm(...args);
    },
  };
});
vi.mock('../src/server/verification.js', () => ({
  runVerification: fixtures.verification,
}));

import {
  assertNativeDenials,
  verifyNativeIsolation,
} from '../src/server/providers/native-isolation.js';

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.cleanup = null;
  fixtures.verification.mockImplementation(async (..._args: unknown[]) => ({
    passed: false,
    output: 'denied',
  }));
});

function pausePolicyRemoval() {
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
  { label: 'abort during teardown', cancelled: true },
  { label: 'normal teardown', cancelled: false },
])('attests native preflight cancellation after all probes: $label', async (scenario) => {
  fixtures.verification.mockImplementation(async (argv: unknown) => {
    const command = argv as string[];
    const allowedRead =
      command.includes('/bin/cat') && command.some((arg) => arg.endsWith('/allowed.txt'));
    return allowedRead
      ? { passed: true, output: 'READ_ALLOWED' }
      : { passed: false, output: 'denied' };
  });
  const controller = new AbortController();
  const { started, release } = pausePolicyRemoval();
  try {
    const pending = verifyNativeIsolation('/mock-native-codex', controller.signal);
    await started;
    expect(fixtures.verification).toHaveBeenCalled();
    if (scenario.cancelled) controller.abort();
    release();
    if (scenario.cancelled) {
      await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    } else {
      await expect(pending).resolves.toBeUndefined();
    }
  } finally {
    controller.abort();
    release();
    fixtures.cleanup = null;
  }
}, 15000);

it('never treats a cancelled denial probe as completed sandbox evidence', async () => {
  await expect(
    assertNativeDenials([['/bin/false']], async () => ({
      passed: false,
      output: 'Verification cancelled before launch.',
      incomplete: true,
    })),
  ).rejects.toThrow('Native sandbox denial probe did not complete normally.');
});
