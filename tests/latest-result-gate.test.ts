import { describe, expect, it } from 'vitest';
import { createLatestResultGate } from '../src/web/latest-result-gate.js';

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('overlapping workspace refreshes', () => {
  it('accepts an early response while a newer request is still pending', () => {
    const gate = createLatestResultGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.accept(first)).toBe(true);
    expect(gate.accept(second)).toBe(true);
    expect(gate.accept(first)).toBe(false);
  });

  it('never lets an older successful response overwrite a newer snapshot', async () => {
    const gate = createLatestResultGate();
    const first = deferred();
    const second = deferred();
    const snapshots: string[] = [];
    const load = async (ticket: number, promise: Promise<string>) => {
      const snapshot = await promise;
      if (gate.accept(ticket)) snapshots.push(snapshot);
    };
    const firstLoad = load(gate.begin(), first.promise);
    const secondLoad = load(gate.begin(), second.promise);
    second.resolve('new');
    await secondLoad;
    first.resolve('stale');
    await firstLoad;
    expect(snapshots).toEqual(['new']);
  });

  it('ignores a stale failed poll after a newer successful poll', async () => {
    const gate = createLatestResultGate();
    const first = deferred();
    const second = deferred();
    const statuses: string[] = [];
    const load = async (ticket: number, promise: Promise<string>) => {
      try {
        const value = await promise;
        if (gate.accept(ticket)) statuses.push(value);
      } catch {
        if (gate.accept(ticket)) statuses.push('disconnected');
      }
    };
    const firstLoad = load(gate.begin(), first.promise);
    const secondLoad = load(gate.begin(), second.promise);
    second.resolve('connected');
    await secondLoad;
    first.reject(new Error('outdated request failed'));
    await firstLoad;
    expect(statuses).toEqual(['connected']);
  });

  it('keeps a newer failure from being undone by an older response', () => {
    const gate = createLatestResultGate();
    const older = gate.begin();
    const newer = gate.begin();
    expect(gate.accept(newer)).toBe(true);
    expect(gate.accept(older)).toBe(false);
  });

  it('rejects replayed or unissued request tickets', () => {
    const gate = createLatestResultGate();
    const ticket = gate.begin();
    expect(gate.accept(ticket)).toBe(true);
    expect(gate.accept(ticket)).toBe(false);
    expect(gate.accept(ticket + 1)).toBe(false);
    expect(gate.accept(0)).toBe(false);
    expect(gate.accept(Number.NaN)).toBe(false);
  });
});
