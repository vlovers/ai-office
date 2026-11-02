import type { AgentEvent } from '../shared/types.js';

/** An SSE message is untrusted input, even when served by the local backend. */
export function parseTaskEvent(raw: string, taskId: string): AgentEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const event = value as Partial<AgentEvent>;
    if (
      !Number.isSafeInteger(event.id) ||
      (event.id ?? 0) <= 0 ||
      event.taskId !== taskId ||
      typeof event.at !== 'string' ||
      typeof event.kind !== 'string' ||
      !event.kind ||
      typeof event.message !== 'string'
    )
      return null;
    return event as AgentEvent;
  } catch {
    return null;
  }
}

/** Keep a bounded, monotonic event timeline across SSE reconnect/replay. */
export function appendTaskEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  // The server emits monotonically increasing persisted IDs per task.
  // A replay outside the retained 500-event window must not be appended again.
  if (events.length && event.id <= events[events.length - 1]!.id) return events;
  return [...events, event].slice(-500);
}
