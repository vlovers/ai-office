import type { AgentEvent, Dashboard, Task } from '../shared/types.js';

export type SceneState = 'offline' | 'idle' | 'thinking' | 'working' | 'stopping' | 'error';
export interface SceneStatus {
  state: SceneState;
  label: string;
}

/** SDK item metadata, never prompt text or elapsed-time guesses, drives thinking. */
export function sceneStatus(
  dashboard: Dashboard | undefined,
  selected: Task | undefined,
  events: AgentEvent[],
  disconnected = false,
): SceneStatus {
  if (disconnected) return { state: 'offline', label: 'Server disconnected' };
  if (!dashboard) return { state: 'offline', label: 'Connecting' };
  const active = dashboard.tasks.find((task) => task.id === dashboard.agent.taskId);
  if (active?.state === 'stopping') return { state: 'stopping', label: 'Stopping' };
  if (active?.state === 'running') {
    const latest = events.findLast(
      (event) =>
        event.taskId === active.id &&
        event.kind === 'progress' &&
        typeof event.data === 'object' &&
        event.data !== null &&
        'data' in event.data,
    );
    const sdk = (latest?.data as { data?: { type?: string; item?: { type?: string } } } | undefined)
      ?.data;
    if (
      sdk?.item?.type === 'reasoning' &&
      ['item.started', 'item.updated'].includes(sdk.type ?? '')
    )
      return { state: 'thinking', label: 'Thinking · SDK reasoning item' };
    return { state: 'working', label: 'Working · read-only turn' };
  }
  if (selected?.state === 'failed' || selected?.state === 'interrupted')
    return { state: 'error', label: `Selected task ${selected.state}` };
  if (dashboard.connection.status === 'connection-error')
    return { state: 'error', label: 'Connection error' };
  if (dashboard.connection.status === 'authentication-required')
    return { state: 'offline', label: 'Authentication required' };
  return { state: 'idle', label: 'Idle · awaiting a task' };
}

export function workstationTask(dashboard: Dashboard | undefined, selectedId: string | undefined) {
  return (
    dashboard?.tasks.find((task) => task.id === dashboard.agent.taskId) ??
    dashboard?.tasks.find((task) => task.id === selectedId) ??
    dashboard?.tasks[0]
  );
}
