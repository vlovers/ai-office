import { describe, expect, it, vi } from 'vitest';
import { createRequestDeadline, createSingleFlight } from '../src/web/workflow-polling.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('workflow polling backpressure', () => {
  it('coalesces automatic ticks while a slow refresh is pending', async () => {
    const gate = createSingleFlight();
    const slow = deferred();
    let calls = 0;
    const first = gate.run(() => {
      calls++;
      return slow.promise;
    });
    const second = gate.run(async () => {
      calls++;
    });
    expect(second).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    slow.resolve();
    await first;
    await gate.run(async () => {
      calls++;
    });
    expect(calls).toBe(2);
  });

  it('recovers after a rejected request instead of freezing future polls', async () => {
    const gate = createSingleFlight();
    await expect(gate.run(async () => {
      throw new Error('HTTP 503');
    })).rejects.toThrow('HTTP 503');
    await expect(gate.run(async () => {})).resolves.toBeUndefined();
  });

  it('reset allows a new selection to refresh while the old request is pending', async () => {
    const gate = createSingleFlight();
    const old = deferred();
    const current = deferred();
    const previous = gate.run(() => old.promise);
    gate.reset();
    const next = gate.run(() => current.promise);
    expect(next).not.toBe(previous);
    old.resolve();
    await previous;
    expect(gate.run(async () => {})).toBe(next);
    current.resolve();
    await next;
    await expect(gate.run(async () => {})).resolves.toBeUndefined();
  });
});

describe('workflow polling deadline', () => {
  it('aborts a stuck read request and marks a timeout', async () => {
    vi.useFakeTimers();
    try {
      const deadline = createRequestDeadline(15000);
      expect(deadline.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(15000);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.timedOut).toBe(true);
      deadline.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels superseded reads without reporting a timeout', async () => {
    vi.useFakeTimers();
    try {
      const deadline = createRequestDeadline(15000);
      deadline.cancel();
      deadline.dispose();
      await vi.advanceTimersByTimeAsync(20000);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.timedOut).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
