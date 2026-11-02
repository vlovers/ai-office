import { describe, expect, it } from 'vitest';
import { appendTaskEvent, nextTaskEventCursor, parseTaskEvent } from '../src/web/event-stream.js';
import type { AgentEvent } from '../src/shared/types.js';

const event = (id: number, taskId = 'task-1'): AgentEvent => ({
  id,
  taskId,
  at: '2026-11-02T08:00:00Z',
  kind: 'progress',
  message: 'Working',
});

describe('task event stream ingestion', () => {
  it('accepts a well-formed event for its own task', () => {
    expect(parseTaskEvent(JSON.stringify(event(1)), 'task-1')).toEqual(event(1));
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...event(1), taskId: 'another-task' }),
    JSON.stringify({ ...event(1), id: 0 }),
    JSON.stringify({ ...event(1), id: 1.5 }),
    JSON.stringify({ ...event(1), id: Number.MAX_SAFE_INTEGER + 1 }),
    JSON.stringify({ ...event(1), message: null }),
    JSON.stringify({ ...event(1), kind: '' }),
  ])('rejects malformed, foreign-task and invalid event payloads: %s', (raw) => {
    expect(parseTaskEvent(raw, 'task-1')).toBeNull();
  });

  it('ignores duplicated and older replayed events without changing the array', () => {
    const events = [event(10), event(11)];
    expect(appendTaskEvent(events, event(11))).toBe(events);
    expect(appendTaskEvent(events, event(9))).toBe(events);
    expect(events).toHaveLength(2);
  });

  it('ignores replayed state events before scheduling duplicate dashboard refreshes', () => {
    let cursor = 10;
    const refreshed: number[] = [];
    for (const item of [event(10), event(9), event(11), event(11), event(12)]) {
      const next = nextTaskEventCursor(cursor, item.id);
      if (next === null) continue;
      cursor = next;
      refreshed.push(item.id);
    }
    expect(refreshed).toEqual([11, 12]);
    expect(cursor).toBe(12);
    expect(nextTaskEventCursor(cursor, Number.NaN)).toBeNull();
  });

  it('retains only the newest 500 persisted events without mutating input', () => {
    const original = Array.from({ length: 500 }, (_, index) => event(index + 1));
    const next = appendTaskEvent(original, event(501));
    expect(next).toHaveLength(500);
    expect(next[0]?.id).toBe(2);
    expect(next.at(-1)?.id).toBe(501);
    expect(original[0]?.id).toBe(1);
    expect(appendTaskEvent(next, event(1))).toBe(next);
  });
});
