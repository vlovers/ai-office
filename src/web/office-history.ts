import type { AgentId } from '../shared/types.js';

export type OfficeHistoryFilter = 'all' | 'selected' | 'failures';

export interface OfficeHistoryRecord {
  id: string;
  agentId: AgentId;
  state: string;
  updatedAt: string;
}

/** Stable, read-only projection of persisted task snapshots. Never dispatches tasks. */
export function selectOfficeHistory<T extends OfficeHistoryRecord>(
  tasks: readonly T[],
  selectedAgent: AgentId,
  filter: OfficeHistoryFilter,
  limit: number,
): T[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (safeLimit === 0) return [];
  return tasks
    .filter((task) => {
      if (filter === 'selected') return task.agentId === selectedAgent;
      if (filter === 'failures') return task.state === 'failed' || task.state === 'interrupted';
      return true;
    })
    .sort((left, right) => {
      const byDate = right.updatedAt.localeCompare(left.updatedAt);
      return byDate || left.id.localeCompare(right.id);
    })
    .slice(0, safeLimit);
}
