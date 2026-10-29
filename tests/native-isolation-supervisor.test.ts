import { beforeEach, expect, it, vi } from 'vitest';
import { runVerification } from '../src/server/verification.js';
import { verifyNativeIsolation } from '../src/server/providers/native-isolation.js';

vi.mock('../src/server/verification.js', () => ({ runVerification: vi.fn() }));

const run = vi.mocked(runVerification);
const native = it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux');
const denied = { passed: false, output: '' };

function probeCommand(argv: string[]): string {
  return argv.slice(argv.indexOf('--') + 1).join(' ');
}

beforeEach(() => run.mockReset());

for (const probe of ['outside.txt', '.env', 'write-escape', '127.0.0.1:']) {
  native(`fails closed when the ${probe} probe supervisor cannot confirm cleanup`, async () => {
    run.mockImplementation(async (argv) => {
      const command = probeCommand(argv);
      if (command.includes('allowed.txt')) return { passed: true, output: 'READ_ALLOWED' };
      if (command.includes(probe)) throw new Error('Supervisor could not confirm process cleanup.');
      return denied;
    });

    await expect(verifyNativeIsolation('/bin/true')).rejects.toThrow(
      'Native sandbox capability verification failed',
    );
    // A failed supervisor is not proof of a denied operation; all other
    // concurrently started probes must still be awaited before teardown.
    expect(run).toHaveBeenCalledTimes(5);
  });
}

native('accepts completed denial probes, not a failed supervisor', async () => {
  run.mockImplementation(async (argv) =>
    probeCommand(argv).includes('allowed.txt')
      ? { passed: true, output: 'READ_ALLOWED' }
      : denied,
  );
  await expect(verifyNativeIsolation('/bin/true')).resolves.toBeUndefined();
  expect(run).toHaveBeenCalledTimes(5);
});

native('waits for every sibling supervisor to settle before failing closed', async () => {
  let releaseSibling!: () => void;
  const sibling = new Promise<typeof denied>((resolve) => {
    releaseSibling = () => resolve(denied);
  });
  let siblingStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    siblingStarted = resolve;
  });
  run.mockImplementation(async (argv) => {
    const command = probeCommand(argv);
    if (command.includes('allowed.txt')) return { passed: true, output: 'READ_ALLOWED' };
    if (command.includes('outside.txt')) throw new Error('Supervisor failed.');
    if (command.includes('.env')) {
      siblingStarted();
      return sibling;
    }
    return denied;
  });

  const pending = verifyNativeIsolation('/bin/true');
  try {
    await started;
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
  } finally {
    releaseSibling();
  }
  await expect(pending).rejects.toThrow('Native sandbox capability verification failed');
  expect(run).toHaveBeenCalledTimes(5);
});
