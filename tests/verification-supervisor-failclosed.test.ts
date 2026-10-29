import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { reapProcessGroup } from '../src/server/process-group.js';
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
