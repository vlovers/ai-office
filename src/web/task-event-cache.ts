import type { AgentEvent } from '../shared/types.js';
import { appendTaskEvent } from './event-stream.js';

// Retain a few recently inspected timelines, but never evict an active stream.
const MAX_CACHED_TASKS = 6;
export type TaskEventHistory = Readonly<Record<string, AgentEvent[]>>;

export function retainTaskEventHistory(
  previous: TaskEventHistory,
  activeIds: readonly string[],
): Record<string, AgentEvent[]> {
  const keep = new Set(activeIds);
  const limit = Math.max(MAX_CACHED_TASKS, keep.size);
  // Insertion order tracks recency: appending an event moves its task last.
  for (const id of Object.keys(previous).reverse()) {
    if (keep.size >= limit) break;
    keep.add(id);
  }
  const next: Record<string, AgentEvent[]> = {};
  for (const [id, events] of Object.entries(previous)) {
    if (keep.has(id)) next[id] = events;
  }
  for (const id of activeIds) next[id] ??= [];
  return next;
}

export function appendCachedTaskEvent(
  previous: TaskEventHistory,
  taskId: string,
  event: AgentEvent,
): Record<string, AgentEvent[]> {
  const events = previous[taskId] ?? [];
  const next = appendTaskEvent(events, event);
  if (next === events) return previous as Record<string, AgentEvent[]>;
  // Move this task to the most-recent position without mutating React state.
  const updated = { ...previous };
  delete updated[taskId];
  updated[taskId] = next;
  return updated;
}

export function taskEventStreamUrl(taskId: string, history: TaskEventHistory): string {
  const after = history[taskId]?.at(-1)?.id ?? 0;
  const path = `/api/tasks/${encodeURIComponent(taskId)}/stream`;
  return after > 0 ? `${path}?after=${after}` : path;
}

/** Do not reconnect forever to a selected task removed from the dashboard. */
export function activeTaskStreamIds(
  selected: string | undefined,
  knownTaskIds: readonly string[],
  agentTaskIds: readonly (string | null)[],
): string[] {
  const known = new Set(knownTaskIds);
  const ids = [
    ...(selected && known.has(selected) ? [selected] : []),
    ...agentTaskIds.filter((id): id is string => Boolean(id)),
  ];
  return [...new Set(ids)].sort();
}
