import { expect, it } from 'vitest';
import { assertNativeDenials } from '../src/server/providers/native-isolation.js';

const denied = { passed: false, output: '' };
const commands = [['outside.txt'], ['.env'], ['write-escape'], ['127.0.0.1:']];

for (const probe of commands.map(([name]) => name!)) {
  it(`fails closed when the ${probe} supervisor cannot confirm cleanup`, async () => {
    const started: string[] = [];
    await expect(
      assertNativeDenials(commands, async ([name]) => {
        started.push(name!);
        if (name === probe) throw new Error('Supervisor could not confirm process cleanup.');
        return denied;
      }),
    ).rejects.toThrow('Native sandbox probe supervisor failed.');
    expect(started).toEqual(commands.map(([name]) => name));
  });
}

it('accepts completed denial probes, not a failed supervisor', async () => {
  await expect(assertNativeDenials(commands, async () => denied)).resolves.toBeUndefined();
});

it('rejects a forbidden operation reported as allowed', async () => {
  await expect(
    assertNativeDenials(commands, async ([name]) =>
      name === 'write-escape' ? { passed: true, output: '' } : denied,
    ),
  ).rejects.toThrow('Sandbox allowed a forbidden operation.');
});

it('waits for every sibling supervisor to settle before failing closed', async () => {
  let releaseSibling!: () => void;
  const sibling = new Promise<typeof denied>((resolve) => {
    releaseSibling = () => resolve(denied);
  });
  let siblingStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    siblingStarted = resolve;
  });
  const pending = assertNativeDenials(commands, async ([name]) => {
    if (name === 'outside.txt') throw new Error('Supervisor failed.');
    if (name === '.env') {
      siblingStarted();
      return sibling;
    }
    return denied;
  });

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
  await expect(pending).rejects.toThrow('Native sandbox probe supervisor failed.');
});

for (const reason of ['spawn failure', 'timeout', 'output limit', 'signal termination']) {
  it(`rejects an incomplete ${reason} as proof of native sandbox denial`, async () => {
    await expect(
      assertNativeDenials(commands, async ([name]) => {
        if (name === 'outside.txt') return { passed: false, output: reason, incomplete: true };
        return denied;
      }),
    ).rejects.toThrow('Native sandbox denial probe did not complete normally.');
  });
}

it('rejects forbidden read canaries even when the sandbox exits nonzero', async () => {
  const canaries = ['outside-unique-canary', 'secret-unique-canary'];
  for (const canary of canaries) {
    await expect(
      assertNativeDenials(
        commands,
        async () => ({ passed: false, output: `read succeeded: ${canary}\\n` }),
        canaries,
      ),
    ).rejects.toThrow('Sandbox leaked forbidden read contents.');
  }
});

it('does not mistake ordinary permission-denied output for a leaked canary', async () => {
  await expect(
    assertNativeDenials(
      commands,
      async () => ({ passed: false, output: 'cat: Permission denied' }),
      ['outside-unique-canary', 'secret-unique-canary'],
    ),
  ).resolves.toBeUndefined();
});
