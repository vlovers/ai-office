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

  it('does not start a queued poll after selection reset', async () => {
    const gate = createSingleFlight();
    let obsoleteCalls = 0;
    let currentCalls = 0;
    const obsolete = gate.run(async () => {
      obsoleteCalls++;
    });
    gate.reset();
    const current = gate.run(async () => {
      currentCalls++;
    });
    await Promise.all([obsolete, current]);
    expect(obsoleteCalls).toBe(0);
    expect(currentCalls).toBe(1);
    await gate.run(async () => {
      currentCalls++;
    });
    expect(currentCalls).toBe(2);
  });

  it('recovers after a rejected request instead of freezing future polls', async () => {
    const gate = createSingleFlight();
    await expect(
      gate.run(async () => {
        throw new Error('HTTP 503');
      }),
    ).rejects.toThrow('HTTP 503');
    await expect(gate.run(async () => {})).resolves.toBeUndefined();
  });

  it('coalesces slow ticks and retries after the read deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const gate = createSingleFlight();
      let calls = 0;
      const poll = () =>
        gate.run(async () => {
          calls++;
          if (calls > 1) return;
          const deadline = createRequestDeadline(15000);
          try {
            await new Promise<void>((_resolve, reject) => {
              deadline.signal.addEventListener(
                'abort',
                () => reject(new Error('read deadline exceeded')),
                { once: true },
              );
            });
          } finally {
            deadline.dispose();
          }
        });
      const first = poll();
      const rejected = expect(first).rejects.toThrow('read deadline exceeded');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3000);
      expect(poll()).toBe(first);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(12000);
      await rejected;
      await expect(poll()).resolves.toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an old rejected request cannot unlock the new selection', async () => {
    const gate = createSingleFlight();
    const old = deferred();
    const current = deferred();
    const previous = gate.run(() => old.promise);
    // This case exercises an already-running request, not a queued microtask.
    await Promise.resolve();
    gate.reset();
    const next = gate.run(() => current.promise);
    old.reject(new Error('superseded'));
    await expect(previous).rejects.toThrow('superseded');
    expect(gate.run(async () => {})).toBe(next);
    current.resolve();
    await next;
  });

  it('reset allows a new selection to refresh while the old request is pending', async () => {
    const gate = createSingleFlight();
    const old = deferred();
    const current = deferred();
    const previous = gate.run(() => old.promise);
    // This case exercises an already-running request, not a queued microtask.
    await Promise.resolve();
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

  it('does not turn cancellation into a timeout while cleanup is delayed', async () => {
    vi.useFakeTimers();
    try {
      const deadline = createRequestDeadline(15000);
      deadline.cancel();
      await vi.advanceTimersByTimeAsync(20000);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.timedOut).toBe(false);
      deadline.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes a completed read without aborting it later', async () => {
    vi.useFakeTimers();
    try {
      const deadline = createRequestDeadline(15000);
      deadline.dispose();
      await vi.advanceTimersByTimeAsync(20000);
      expect(deadline.signal.aborted).toBe(false);
      expect(deadline.timedOut).toBe(false);
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
