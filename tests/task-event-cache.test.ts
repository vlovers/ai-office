import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/shared/types.js';
import {
  activeTaskStreamIds,
  appendCachedTaskEvent,
  retainTaskEventHistory,
  taskEventStreamUrl,
} from '../src/web/task-event-cache.js';

const event = (id: number, taskId: string): AgentEvent => ({
  id,
  taskId,
  at: '2026-11-02T08:00:00Z',
  kind: 'progress',
  message: 'Working',
});

describe('bounded task event history and SSE resume', () => {
  it('preserves recently inspected tasks when switching active streams', () => {
    const first = { 'task-a': [event(3, 'task-a')] };
    const switched = retainTaskEventHistory(first, ['task-b']);
    expect(switched['task-a']).toBe(first['task-a']);
    expect(switched['task-b']).toEqual([]);
    expect(taskEventStreamUrl('task-a', switched)).toBe('/api/tasks/task-a/stream?after=3');
    expect(taskEventStreamUrl('task-b', switched)).toBe('/api/tasks/task-b/stream');
  });

  it('resumes after the latest retained ID without duplicating reconnect replay', () => {
    const first = appendCachedTaskEvent({}, 'task-a', event(10, 'task-a'));
    const duplicate = appendCachedTaskEvent(first, 'task-a', event(10, 'task-a'));
    expect(duplicate).toBe(first);
    const newer = appendCachedTaskEvent(first, 'task-a', event(11, 'task-a'));
    expect(newer['task-a']?.map((item) => item.id)).toEqual([10, 11]);
    expect(taskEventStreamUrl('task-a', newer)).toBe('/api/tasks/task-a/stream?after=11');
    expect(first['task-a']).toHaveLength(1);
  });

  it('evicts the oldest inactive timelines while keeping the active task', () => {
    let history: Record<string, AgentEvent[]> = {};
    for (let i = 1; i <= 7; i++) {
      const id = `task-${i}`;
      history = retainTaskEventHistory(history, [id]);
      history = appendCachedTaskEvent(history, id, event(i, id));
    }
    expect(Object.keys(history)).toHaveLength(6);
    expect(history['task-1']).toBeUndefined();
    expect(history['task-7']).toHaveLength(1);
    expect(history['task-2']).toHaveLength(1);
  });

  it('does not evict active streams even when there are more than six', () => {
    const active = Array.from({ length: 8 }, (_, index) => `task-${index}`);
    const previous = { old: [event(1, 'old')], 'task-0': [event(2, 'task-0')] };
    const history = retainTaskEventHistory(previous, active);
    expect(Object.keys(history)).toHaveLength(8);
    expect(history.old).toBeUndefined();
    expect(history['task-0']?.[0]?.id).toBe(2);
  });

  it('treats an appended event as recent and encodes task IDs in URLs', () => {
    let history: Record<string, AgentEvent[]> = {};
    for (let i = 1; i <= 6; i++) {
      history = appendCachedTaskEvent(history, `task-${i}`, event(i, `task-${i}`));
    }
    history = appendCachedTaskEvent(history, 'task-1', event(7, 'task-1'));
    history = retainTaskEventHistory(history, ['new-task']);
    expect(history['task-2']).toBeUndefined();
    expect(history['task-1']?.at(-1)?.id).toBe(7);
    const encodedUrl = '/api/tasks/task%2Fwith%20space/stream';
    expect(taskEventStreamUrl('task/with space', {})).toBe(encodedUrl);
  });

  it('does not open a reconnecting SSE stream for a removed selected task', () => {
    expect(activeTaskStreamIds('deleted', ['existing'], [null])).toEqual([]);
    expect(activeTaskStreamIds('existing', ['existing'], [null])).toEqual(['existing']);
  });

  it('keeps running agent streams and deduplicates sorted task IDs', () => {
    const agentIds = ['task-c', 'task-b', null, 'task-a'];
    const streamIds = activeTaskStreamIds('task-b', ['task-b'], agentIds);
    expect(streamIds).toEqual(['task-a', 'task-b', 'task-c']);
    // An active agent may have a task missing from a temporarily stale task list.
    expect(activeTaskStreamIds('missing', [], ['agent-task'])).toEqual(['agent-task']);
  });

  it('preserves task cursors without replay across stream switches', () => {
    let history: Record<string, AgentEvent[]> = {};
    history = appendCachedTaskEvent(history, 'task-a', event(7, 'task-a'));
    history = retainTaskEventHistory(history, ['task-b']);
    history = appendCachedTaskEvent(history, 'task-b', event(19, 'task-b'));
    history = retainTaskEventHistory(history, ['task-a']);
    expect(taskEventStreamUrl('task-a', history)).toBe('/api/tasks/task-a/stream?after=7');
    expect(taskEventStreamUrl('task-b', history)).toBe('/api/tasks/task-b/stream?after=19');
    const replayed = appendCachedTaskEvent(history, 'task-a', event(7, 'task-a'));
    expect(replayed).toBe(history);
    const advanced = appendCachedTaskEvent(replayed, 'task-a', event(8, 'task-a'));
    expect(advanced['task-a']?.map((item) => item.id)).toEqual([7, 8]);
    expect(advanced['task-b']?.map((item) => item.id)).toEqual([19]);
  });

  it('keeps the active task during cache pressure after switching away and back', () => {
    let history: Record<string, AgentEvent[]> = {};
    history = appendCachedTaskEvent(history, 'task-a', event(10, 'task-a'));
    for (let i = 0; i < 8; i++) {
      const id = `background-${i}`;
      history = appendCachedTaskEvent(history, id, event(i + 1, id));
    }
    history = retainTaskEventHistory(history, ['task-a']);
    expect(history['task-a']?.map((item) => item.id)).toEqual([10]);
    expect(Object.keys(history)).toHaveLength(6);
  });

  it('retains unknown provider event kinds as inert timeline data', () => {
    const providerEvent = { ...event(12, 'task-a'), kind: 'provider-custom-progress' };
    const history = appendCachedTaskEvent({}, 'task-a', providerEvent);
    expect(history['task-a']).toEqual([providerEvent]);
    expect(taskEventStreamUrl('task-a', history)).toBe('/api/tasks/task-a/stream?after=12');
  });
});
