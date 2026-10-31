import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { killProcessGroup, reapProcessGroup } from '../src/server/process-group.js';
import { runVerification } from '../src/server/verification.js';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));
vi.mock('../src/server/process-group.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/process-group.js')>()),
  killProcessGroup: vi.fn(),
  reapProcessGroup: vi.fn(async () => {}),
}));

it('rejects a supervisor that exits without an attested result', async () => {
  const worker = Object.assign(new EventEmitter(), {
    pid: 424242,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);

  const pending = runVerification(['/bin/false'], '/tmp', 1000);
  // The worker can crash without emitting its result message, even when the
  // process group has been reaped. This is not proof of sandbox denial.
  worker.emit('close', 1);

  await expect(pending).rejects.toThrow(
    'Verification supervisor closed without an attested result',
  );
  expect(reapProcessGroup).toHaveBeenCalledWith(424242);
});

it('preserves an explicitly reported denied operation', async () => {
  const worker = Object.assign(new EventEmitter(), {
    pid: 424243,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);

  const pending = runVerification(['/bin/false'], '/tmp', 1000);
  worker.emit('message', { passed: false, output: 'Permission denied' });
  // The worker kills its detached process group after delivering IPC.
  worker.emit('close', null, 'SIGKILL');

  await expect(pending).resolves.toEqual({ passed: false, output: 'Permission denied' });
  expect(reapProcessGroup).toHaveBeenCalledWith(424243);
});

// A plausible IPC result is insufficient if the supervisor never completed
// its expected detached process-group termination. In particular, a crashed
// worker must not attest a sandbox denial merely by sending IPC first.
it.each([
  ['normal exit', 0, null],
  ['nonzero crash', 1, null],
  ['unexpected signal', null, 'SIGTERM'],
])('rejects a reported denial followed by %s', async (_case, code, signal) => {
  const worker = Object.assign(new EventEmitter(), {
    pid: 424244,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(reapProcessGroup).mockClear();

  const pending = runVerification(['/bin/false'], '/tmp', 1000);
  worker.emit('message', { passed: false, output: 'Permission denied' });
  worker.emit('close', code, signal);

  await expect(pending).rejects.toThrow(
    'Verification supervisor exited without expected group termination',
  );
  expect(reapProcessGroup).toHaveBeenCalledWith(424244);
});

it('preserves a successful result after the expected supervisor group termination', async () => {
  const worker = Object.assign(new EventEmitter(), {
    pid: 424245,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);

  const pending = runVerification(['/bin/true'], '/tmp', 1000);
  worker.emit('message', { passed: true, output: 'ok' });
  worker.emit('close', null, 'SIGKILL');

  await expect(pending).resolves.toEqual({ passed: true, output: 'ok' });
  expect(reapProcessGroup).toHaveBeenCalledWith(424245);
});

// The IPC boundary is not an attestation if the worker payload is malformed.
// In particular, null previously threw from the EventEmitter callback and
// a missing/incorrect passed flag was silently converted into a denial.
it.each([
  ['null payload', null],
  ['missing passed', { output: '' }],
  ['non-boolean passed', { passed: 'false', output: '' }],
  ['non-string output', { passed: false, output: 123 }],
  ['invalid incomplete flag', { passed: false, output: '', incomplete: 'false' }],
  ['contradictory success', { passed: true, output: '', incomplete: true }],
  ['oversized output', { passed: false, output: 'x'.repeat(128_101) }],
  ['unexpected attestation field', { passed: true, output: '', verified: true }],
])('fails closed on %s from the supervisor', async (_label, payload) => {
  const worker = Object.assign(new EventEmitter(), {
    pid: 525252,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();

  const pending = runVerification(['/bin/false'], '/tmp', 1000);
  worker.emit('message', payload);
  worker.emit('close', 0);

  await expect(pending).rejects.toThrow('Verification supervisor sent an invalid result');
  expect(killProcessGroup).toHaveBeenCalledWith(525252);
  expect(reapProcessGroup).toHaveBeenCalledWith(525252);
});

it('rejects a repeated IPC result rather than letting it overwrite an attested denial', async () => {
  const worker = Object.assign(new EventEmitter(), {
    pid: 525253,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();

  const pending = runVerification(['/bin/false'], '/tmp', 1000);
  worker.emit('message', { passed: false, output: 'Permission denied' });
  worker.emit('message', { passed: true, output: 'Forged success' });
  worker.emit('close', 0);

  await expect(pending).rejects.toThrow('Verification supervisor sent an invalid result');
  expect(killProcessGroup).toHaveBeenCalledWith(525253);
  expect(reapProcessGroup).toHaveBeenCalledWith(525253);
});

// A worker may emit a plausible result and then hang instead of closing.
// The backend watchdog must not turn a forced SIGKILL into an attested success
// (or an attested native sandbox denial).
it.each([
  ['success', { passed: true, output: 'ok' }],
  ['denial', { passed: false, output: 'Permission denied' }],
  ['incomplete result', { passed: false, output: 'timeout', incomplete: true }],
])('rejects a %s reported before supervisor watchdog termination', async (_label, payload) => {
  vi.useFakeTimers();
  const worker = Object.assign(new EventEmitter(), {
    pid: 525254,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();
  vi.mocked(reapProcessGroup).mockClear();
  try {
    const pending = runVerification(['/bin/true'], '/tmp', 1000);
    worker.emit('message', payload);
    await vi.advanceTimersByTimeAsync(6000);
    expect(killProcessGroup).toHaveBeenCalledWith(525254);
    worker.emit('message', { passed: true, output: 'late success' });
    worker.emit('close', null, 'SIGKILL');
    await expect(pending).rejects.toThrow('Verification supervisor exceeded its shutdown deadline');
    expect(reapProcessGroup).toHaveBeenCalledWith(525254);
  } finally {
    vi.useRealTimers();
  }
});

it('does not accept IPC success or signal a recycled PID when abort races with reaping', async () => {
  const controller = new AbortController();
  let finishReaping!: () => void;
  const reaping = new Promise<void>((resolve) => {
    finishReaping = resolve;
  });
  vi.mocked(reapProcessGroup).mockImplementationOnce(() => reaping);
  vi.mocked(killProcessGroup).mockClear();
  const worker = Object.assign(new EventEmitter(), {
    pid: 525255,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);

  const pending = runVerification(['/bin/true'], '/tmp', 1000, controller.signal);
  worker.emit('message', { passed: true, output: 'ok' });
  worker.emit('close', null, 'SIGKILL');
  // The close handler has entered reapProcessGroup but not completed it.
  controller.abort();
  finishReaping();

  await expect(pending).resolves.toEqual({
    passed: false,
    output: 'Verification interrupted during application shutdown.',
    incomplete: true,
  });
  expect(killProcessGroup).not.toHaveBeenCalledWith(525255);
});

it.each(['synchronous throw', 'callback failure'])(
  'reaps a detached worker after IPC send %s rather than returning before cleanup',
  async (failureMode) => {
    const worker = Object.assign(new EventEmitter(), {
      pid: 525256,
      send: vi.fn((_message: unknown, callback: (error?: Error) => void) => {
        if (failureMode === 'synchronous throw') throw new Error('IPC closed');
        callback(new Error('IPC closed'));
      }),
    });
    vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
    vi.mocked(killProcessGroup).mockClear();
    vi.mocked(reapProcessGroup).mockClear();

    const pending = runVerification(['/bin/true'], '/tmp', 1000);
    expect(killProcessGroup).toHaveBeenCalledWith(525256);
    worker.emit('close', null, 'SIGKILL');

    await expect(pending).rejects.toThrow('Verification supervisor could not start');
    expect(reapProcessGroup).toHaveBeenCalledWith(525256);
  },
);

it('does not send a launch message when cancellation races with worker fork', async () => {
  const controller = new AbortController();
  const worker = Object.assign(new EventEmitter(), {
    pid: 525257,
    send: vi.fn(),
  });
  vi.mocked(fork).mockImplementationOnce(() => {
    controller.abort();
    return worker as unknown as ChildProcess;
  });

  const pending = runVerification(['/bin/true'], '/tmp', 1000, controller.signal);
  expect(worker.send).not.toHaveBeenCalled();
  expect(killProcessGroup).toHaveBeenCalledWith(525257);
  worker.emit('close', null, 'SIGKILL');
  await expect(pending).resolves.toMatchObject({ passed: false, incomplete: true });
  expect(reapProcessGroup).toHaveBeenCalledWith(525257);
});

it('fails closed if an aborted supervisor never closes after SIGKILL', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const worker = Object.assign(new EventEmitter(), {
      pid: 525258,
      send: vi.fn(),
    });
    vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
    vi.mocked(killProcessGroup).mockClear();

    const pending = runVerification(['/bin/true'], '/tmp', 120000, controller.signal);
    // Attach the rejection assertion before fake timers fire to avoid an
    // unhandled-rejection race in Vitest.
    const rejected = expect(pending).rejects.toThrow('Process cleanup could not be confirmed');
    controller.abort();
    expect(killProcessGroup).toHaveBeenCalledWith(525258);
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
    // The original long watchdog must be disarmed after uncertain cleanup.
    await vi.advanceTimersByTimeAsync(125000);
    expect(killProcessGroup).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('fails closed if the watchdog kills a supervisor but close never arrives', async () => {
  vi.useFakeTimers();
  try {
    const worker = Object.assign(new EventEmitter(), {
      pid: 525259,
      send: vi.fn(),
    });
    vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
    vi.mocked(killProcessGroup).mockClear();

    const pending = runVerification(['/bin/true'], '/tmp', 1000);
    const rejected = expect(pending).rejects.toThrow('Process cleanup could not be confirmed');
    await vi.advanceTimersByTimeAsync(6000);
    expect(killProcessGroup).toHaveBeenCalledWith(525259);
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

it('clears the close deadline when cancellation is followed by a reaped supervisor', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const worker = Object.assign(new EventEmitter(), {
      pid: 525260,
      send: vi.fn(),
    });
    vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
    vi.mocked(killProcessGroup).mockClear();

    const pending = runVerification(['/bin/true'], '/tmp', 1000, controller.signal);
    controller.abort();
    worker.emit('close', null, 'SIGKILL');
    await expect(pending).resolves.toMatchObject({ passed: false, incomplete: true });
    await vi.advanceTimersByTimeAsync(7500);
    expect(killProcessGroup).toHaveBeenCalledTimes(1);
    expect(reapProcessGroup).toHaveBeenCalledWith(525260);
  } finally {
    vi.useRealTimers();
  }
});

it('ignores a late IPC send callback after the supervisor has closed', async () => {
  let reportSend!: (error?: Error) => void;
  const worker = Object.assign(new EventEmitter(), {
    pid: 525261,
    send: vi.fn((_message: unknown, callback: (error?: Error) => void) => {
      reportSend = callback;
    }),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();

  const pending = runVerification(['/bin/true'], '/tmp', 1000);
  worker.emit('message', { passed: true, output: 'ok' });
  worker.emit('close', null, 'SIGKILL');
  await expect(pending).resolves.toEqual({ passed: true, output: 'ok' });
  reportSend(new Error('Late IPC error'));
  expect(killProcessGroup).not.toHaveBeenCalledWith(525261);
});

it.each(['malformed IPC', 'IPC send failure', 'child process error'])(
  'fails closed within the termination deadline when %s never yields close',
  async (failureMode) => {
    vi.useFakeTimers();
    try {
      let sendCallback!: (error?: Error) => void;
      const worker = Object.assign(new EventEmitter(), {
        pid: 525262,
        send: vi.fn((_message: unknown, callback: (error?: Error) => void) => {
          sendCallback = callback;
        }),
      });
      vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
      vi.mocked(killProcessGroup).mockClear();

      const pending = runVerification(['/bin/true'], '/tmp', 120000);
      const rejected = expect(pending).rejects.toThrow('Process cleanup could not be confirmed');
      if (failureMode === 'malformed IPC') worker.emit('message', null);
      else if (failureMode === 'IPC send failure') sendCallback(new Error('IPC failure'));
      else worker.emit('error', new Error('Child process failure'));

      expect(killProcessGroup).toHaveBeenCalledTimes(1);
      expect(killProcessGroup).toHaveBeenCalledWith(525262);
      await vi.advanceTimersByTimeAsync(1500);
      await rejected;
      await vi.advanceTimersByTimeAsync(125000);
      expect(killProcessGroup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  },
);

it('signals the supervisor group only once when invalid IPC races with abort', async () => {
  const controller = new AbortController();
  const worker = Object.assign(new EventEmitter(), {
    pid: 525264,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();

  const pending = runVerification(['/bin/true'], '/tmp', 1000, controller.signal);
  worker.emit('message', null);
  controller.abort();
  expect(killProcessGroup).toHaveBeenCalledTimes(1);
  worker.emit('close', null, 'SIGKILL');

  await expect(pending).rejects.toThrow('Verification supervisor sent an invalid result');
  expect(reapProcessGroup).toHaveBeenCalledWith(525264);
});

it('fails closed when IPC disconnects before any attested supervisor result', async () => {
  const worker = Object.assign(new EventEmitter(), {
    pid: 525265,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();
  vi.mocked(reapProcessGroup).mockClear();

  const pending = runVerification(['/bin/true'], '/tmp', 120000);
  worker.emit('disconnect');
  expect(killProcessGroup).toHaveBeenCalledTimes(1);
  expect(killProcessGroup).toHaveBeenCalledWith(525265);
  worker.emit('close', null, 'SIGKILL');

  await expect(pending).rejects.toThrow('Verification supervisor could not start');
  expect(reapProcessGroup).toHaveBeenCalledWith(525265);
});

it('bounds a lost IPC channel even if supervisor close never arrives', async () => {
  vi.useFakeTimers();
  try {
    const worker = Object.assign(new EventEmitter(), {
      pid: 525266,
      send: vi.fn(),
    });
    vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
    vi.mocked(killProcessGroup).mockClear();

    const pending = runVerification(['/bin/true'], '/tmp', 120000);
    const rejected = expect(pending).rejects.toThrow('Process cleanup could not be confirmed');
    worker.emit('disconnect');
    expect(killProcessGroup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
    await vi.advanceTimersByTimeAsync(125000);
    expect(killProcessGroup).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('does not discard an attested result when the IPC channel then disconnects', async () => {
  const worker = Object.assign(new EventEmitter(), {
    pid: 525267,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();

  const pending = runVerification(['/bin/true'], '/tmp', 1000);
  worker.emit('message', { passed: true, output: 'ok' });
  worker.emit('disconnect');
  expect(killProcessGroup).not.toHaveBeenCalledWith(525267);
  worker.emit('close', null, 'SIGKILL');

  await expect(pending).resolves.toEqual({ passed: true, output: 'ok' });
});

it('never signals a possibly recycled PID after IPC disconnect observes child exit', async () => {
  vi.useFakeTimers();
  try {
    const worker = Object.assign(new EventEmitter(), {
      pid: 525268,
      exitCode: 0,
      signalCode: null,
      send: vi.fn(),
    });
    vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
    vi.mocked(killProcessGroup).mockClear();

    const pending = runVerification(['/bin/true'], '/tmp', 120000);
    const rejected = expect(pending).rejects.toThrow('Process cleanup could not be confirmed');
    worker.emit('disconnect');
    expect(killProcessGroup).not.toHaveBeenCalledWith(525268);
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
    worker.emit('close', 0);
    await vi.advanceTimersByTimeAsync(125000);
    expect(killProcessGroup).not.toHaveBeenCalledWith(525268);
  } finally {
    vi.useRealTimers();
  }
});

it('ignores late IPC send and child errors while a closed supervisor is being reaped', async () => {
  let reportSend!: (error?: Error) => void;
  let finishReaping!: () => void;
  const reaping = new Promise<void>((resolve) => {
    finishReaping = resolve;
  });
  vi.mocked(reapProcessGroup).mockImplementationOnce(() => reaping);
  const worker = Object.assign(new EventEmitter(), {
    pid: 525269,
    send: vi.fn((_message: unknown, callback: (error?: Error) => void) => {
      reportSend = callback;
    }),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();

  const pending = runVerification(['/bin/true'], '/tmp', 1000);
  worker.emit('message', { passed: true, output: 'ok' });
  worker.emit('close', null, 'SIGKILL');
  reportSend(new Error('Late IPC failure'));
  worker.emit('error', new Error('Late child error'));
  worker.emit('disconnect');
  finishReaping();

  await expect(pending).resolves.toEqual({ passed: true, output: 'ok' });
  expect(killProcessGroup).not.toHaveBeenCalledWith(525269);
});

it('sends only one termination signal when IPC disconnect races with cancellation', async () => {
  const controller = new AbortController();
  const worker = Object.assign(new EventEmitter(), {
    pid: 525270,
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();

  const pending = runVerification(['/bin/true'], '/tmp', 1000, controller.signal);
  worker.emit('disconnect');
  controller.abort();
  expect(killProcessGroup).toHaveBeenCalledTimes(1);
  worker.emit('close', null, 'SIGKILL');

  await expect(pending).resolves.toMatchObject({ passed: false, incomplete: true });
});

it('does not signal a recycled process-group PID if cancellation follows child exit', async () => {
  const controller = new AbortController();
  const worker = Object.assign(new EventEmitter(), {
    pid: 525271,
    exitCode: null,
    signalCode: 'SIGKILL',
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();

  const pending = runVerification(['/bin/true'], '/tmp', 1000, controller.signal);
  controller.abort();
  expect(killProcessGroup).not.toHaveBeenCalledWith(525271);
  worker.emit('close', null, 'SIGKILL');

  await expect(pending).resolves.toMatchObject({ passed: false, incomplete: true });
  expect(reapProcessGroup).toHaveBeenCalledWith(525271);
});

it.each([
  ['no result', null],
  ['attested success', { passed: true, output: 'ok' }],
])('fails closed promptly when supervisor exits but close never arrives: %s', async (_label, result) => {
  vi.useFakeTimers();
  try {
    const worker = Object.assign(new EventEmitter(), {
      pid: 525272,
      exitCode: null as number | null,
      signalCode: 'SIGKILL',
      send: vi.fn(),
    });
    vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
    vi.mocked(killProcessGroup).mockClear();
    vi.mocked(reapProcessGroup).mockClear();

    const pending = runVerification(['/bin/true'], '/tmp', 120000);
    const rejected = expect(pending).rejects.toThrow('Process cleanup could not be confirmed');
    if (result) worker.emit('message', result);
    worker.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
    // The original long watchdog must not fire or signal a recycled PID.
    await vi.advanceTimersByTimeAsync(125000);
    expect(killProcessGroup).not.toHaveBeenCalledWith(525272);
    expect(reapProcessGroup).not.toHaveBeenCalledWith(525272);
  } finally {
    vi.useRealTimers();
  }
});

it('accepts an attested supervisor result when close follows exit before the deadline', async () => {
  vi.useFakeTimers();
  try {
    const worker = Object.assign(new EventEmitter(), {
      pid: 525273,
      exitCode: null as number | null,
      signalCode: 'SIGKILL',
      send: vi.fn(),
    });
    vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
    vi.mocked(killProcessGroup).mockClear();
    vi.mocked(reapProcessGroup).mockClear();

    const pending = runVerification(['/bin/true'], '/tmp', 120000);
    worker.emit('message', { passed: true, output: 'ok' });
    worker.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1000);
    worker.emit('close', null, 'SIGKILL');

    await expect(pending).resolves.toEqual({ passed: true, output: 'ok' });
    await vi.advanceTimersByTimeAsync(125000);
    expect(killProcessGroup).not.toHaveBeenCalledWith(525273);
    expect(reapProcessGroup).toHaveBeenCalledWith(525273);
  } finally {
    vi.useRealTimers();
  }
});

it('preserves cancellation after supervisor exit without signalling a recycled PID', async () => {
  const controller = new AbortController();
  const worker = Object.assign(new EventEmitter(), {
    pid: 525274,
    exitCode: null as number | null,
    signalCode: 'SIGKILL',
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  vi.mocked(killProcessGroup).mockClear();
  vi.mocked(reapProcessGroup).mockClear();

  const pending = runVerification(['/bin/true'], '/tmp', 120000, controller.signal);
  worker.emit('message', { passed: true, output: 'ok' });
  worker.emit('exit', null, 'SIGKILL');
  controller.abort();
  worker.emit('close', null, 'SIGKILL');

  await expect(pending).resolves.toMatchObject({ passed: false, incomplete: true });
  expect(killProcessGroup).not.toHaveBeenCalledWith(525274);
  expect(reapProcessGroup).toHaveBeenCalledWith(525274);
});
