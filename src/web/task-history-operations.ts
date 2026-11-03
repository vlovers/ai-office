import type { AgentId, Task } from '../shared/types.js';

export type TaskHistoryStatus = 'all' | 'active' | 'queued' | 'attention' | 'completed';
export type TaskHistoryOrder = 'recent' | 'oldest' | 'attention';

export interface TaskHistoryOptions {
  query: string;
  status: TaskHistoryStatus;
  order: TaskHistoryOrder;
  agentId?: AgentId;
  repositoryId?: string;
}

/** Include historical IDs even after an agent profile or repository is removed.
 * Keep known names, deduplicate IDs and make filter order deterministic.
 */
export function historyFilterOptions(
  known: readonly { id: string; name: string }[],
  referencedIds: readonly string[],
): { id: string; name: string }[] {
  const labels = new Map(known.map(({ id, name }) => [id, name]));
  for (const id of referencedIds) {
    if (!labels.has(id)) labels.set(id, id);
  }
  return [...labels].map(([id, name]) => ({ id, name })).sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

export function taskNeedsAttention(task: Pick<Task, 'state'>): boolean {
  return task.state === 'failed' || task.state === 'interrupted';
}

export function taskHistoryGroup(
  task: Pick<Task, 'state'>,
): Exclude<TaskHistoryStatus, 'all'> | 'other' {
  if (taskNeedsAttention(task)) return 'attention';
  if (task.state === 'running' || task.state === 'stopping') return 'active';
  if (task.state === 'queued') return 'queued';
  if (task.state === 'completed') return 'completed';
  return 'other';
}

export function summarizeTaskHistory(tasks: readonly Pick<Task, 'state'>[]) {
  const summary = {
    total: tasks.length,
    active: 0,
    queued: 0,
    attention: 0,
    completed: 0,
    other: 0,
  };
  for (const task of tasks) summary[taskHistoryGroup(task)]++;
  return summary;
}

const rank: Record<ReturnType<typeof taskHistoryGroup>, number> = {
  attention: 0,
  active: 1,
  queued: 2,
  other: 3,
  completed: 4,
};

/** Deterministic, read-only projection of persisted tasks. No scheduling, approvals or mutations. */
export function selectTaskHistory<
  T extends Pick<Task, 'id' | 'title' | 'state' | 'agentId' | 'repositoryId' | 'updatedAt'>,
>(tasks: readonly T[], options: TaskHistoryOptions): T[] {
  const query = options.query.trim().toLocaleLowerCase();
  return tasks
    .filter(
      (task) =>
        (options.status === 'all' || taskHistoryGroup(task) === options.status) &&
        (!options.agentId || task.agentId === options.agentId) &&
        (!options.repositoryId || task.repositoryId === options.repositoryId) &&
        (!query ||
          task.title.toLocaleLowerCase().includes(query) ||
          task.id.toLocaleLowerCase().includes(query)),
    )
    .sort((left, right) => {
      if (options.order === 'attention') {
        const priority = rank[taskHistoryGroup(left)] - rank[taskHistoryGroup(right)];
        if (priority !== 0) return priority;
      }
      const byDate = right.updatedAt.localeCompare(left.updatedAt);
      if (byDate !== 0) return options.order === 'oldest' ? -byDate : byDate;
      return left.id.localeCompare(right.id);
    });
}
