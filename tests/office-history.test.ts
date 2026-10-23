import { describe, expect, it } from 'vitest';
import { selectOfficeHistory } from '../src/web/office-history.js';
import type { AgentId } from '../src/shared/types.js';

const id = (value: string) => value as AgentId;
const tasks = [
  { id: 'older', agentId: id('a'), state: 'completed', updatedAt: '2026-10-20T12:00:00Z' },
  { id: 'failed', agentId: id('b'), state: 'failed', updatedAt: '2026-10-22T12:00:00Z' },
  { id: 'stopped', agentId: id('a'), state: 'interrupted', updatedAt: '2026-10-21T12:00:00Z' },
  { id: 'newer', agentId: id('a'), state: 'running', updatedAt: '2026-10-22T12:00:00Z' },
] as const;

describe('persisted office task history', () => {
  it('orders by most recently updated with deterministic ties', () => {
    expect(selectOfficeHistory(tasks, id('a'), 'all', 8).map((task) => task.id)).toEqual([
      'failed',
      'newer',
      'stopped',
      'older',
    ]);
  });

  it('filters the selected agent without changing source order', () => {
    expect(selectOfficeHistory(tasks, id('a'), 'selected', 8).map((task) => task.id)).toEqual([
      'newer',
      'stopped',
      'older',
    ]);
    expect(tasks[0].id).toBe('older');
  });

  it('only treats actual failed or interrupted states as failures', () => {
    expect(selectOfficeHistory(tasks, id('a'), 'failures', 8).map((task) => task.id)).toEqual([
      'failed',
      'stopped',
    ]);
  });

  it('bounds results and safely handles invalid limits', () => {
    expect(selectOfficeHistory(tasks, id('a'), 'all', 1)).toHaveLength(1);
    expect(selectOfficeHistory(tasks, id('a'), 'all', Number.NaN)).toEqual([]);
    expect(selectOfficeHistory(tasks, id('a'), 'all', -1)).toEqual([]);
    expect(selectOfficeHistory(tasks, id('a'), 'all', Infinity)).toEqual([]);
    expect(selectOfficeHistory(tasks, id('a'), 'all', 1.9)).toHaveLength(1);
    expect(selectOfficeHistory([], id('a'), 'all', 8)).toEqual([]);
  });

  it('does not mutate frozen input while sorting and filtering', () => {
    const frozen = Object.freeze(tasks.map((task) => Object.freeze({ ...task })));
    const before = frozen.map((task) => task.id);
    expect(selectOfficeHistory(frozen, id('a'), 'all', 8).map((task) => task.id)).toEqual([
      'failed', 'newer', 'stopped', 'older',
    ]);
    expect(frozen.map((task) => task.id)).toEqual(before);
  });
});
