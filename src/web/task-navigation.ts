import type { Task } from '../shared/types.js';

export type TaskDestination =
  'overview' | 'execution' | 'changes' | 'history' | 'session' | 'review' | 'workflow';

export interface TaskNavigation {
  taskId: string;
  destination: TaskDestination;
  context?: 'overview';
}

export function taskHasReview(task: Pick<Task, 'workspaceId' | 'state'>): boolean {
  return Boolean(task.workspaceId) && !['queued', 'running', 'stopping'].includes(task.state);
}

export function taskNavigationTarget(
  task: Pick<Task, 'id' | 'workspaceId' | 'state'> | undefined,
  destination: TaskDestination,
): TaskNavigation | null {
  if (!task) return null;
  if (destination === 'review' && !taskHasReview(task)) return null;
  return { taskId: task.id, destination };
}

/** URL fragments are local navigation only; they never grant permission or launch tasks. */
export function encodeTaskNavigation(value: TaskNavigation): string {
  return `#${value.context === 'overview' ? 'overview/' : ''}task/${encodeURIComponent(value.taskId)}/${value.destination}`;
}

export function decodeTaskNavigation(hash: string): TaskNavigation | null {
  const match =
    /^#(overview\/)?task\/([^/]+)\/(overview|execution|changes|history|session|review|workflow)$/.exec(
      hash,
    );
  if (!match) return null;
  try {
    const taskId = decodeURIComponent(match[2]!);
    if (!taskId || taskId.length > 256 || /[\x00-\x1f\x7f]/.test(taskId)) return null;
    return {
      taskId,
      destination: match[3] as TaskDestination,
      ...(match[1] ? { context: 'overview' as const } : {}),
    };
  } catch {
    return null;
  }
}
