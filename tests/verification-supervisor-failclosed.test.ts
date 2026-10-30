import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { killProcessGroup, reapProcessGroup } from '../src/server/process-group.js';
import { runVerification } from '../src/server/verification.js';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));
vi.mock('../src/server/process-group.js', () => ({
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
  worker.emit('close', 1);

  await expect(pending).resolves.toEqual({ passed: false, output: 'Permission denied' });
  expect(reapProcessGroup).toHaveBeenCalledWith(424243);
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
