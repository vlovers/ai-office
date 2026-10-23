import { officeCheckpoint, type OfficeWorkflow } from './office-workflows.js';
import type { AgentEvent, Dashboard, Task, AgentId } from '../shared/types.js';

export type SceneState =
  | 'offline'
  | 'idle'
  | 'preparing'
  | 'queued'
  | 'thinking'
  | 'working'
  | 'reviewing'
  | 'approval'
  | 'stopping'
  | 'completed'
  | 'error';
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
  agentId: AgentId = 'codex-1',
  workflows: readonly OfficeWorkflow[] = [],
): SceneStatus {
  if (disconnected) return { state: 'offline', label: 'Server disconnected' };
  if (!dashboard) return { state: 'offline', label: 'Connecting' };
  const agent = dashboard.agents.find((item) => item.id === agentId);
  const active = dashboard.tasks.find((task) => task.id === agent?.taskId);
  if (!agent) return { state: 'offline', label: 'Agent unavailable' };
  if (agent.state === 'offline') return { state: 'offline', label: 'Agent offline' };
  if (agent?.state === 'preparing')
    return {
      state: 'preparing',
      label:
        active?.executionMode === 'write'
          ? 'Preparing isolated coding session'
          : 'Preparing read-only session',
    };
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
    if (
      workflows.some(
        (workflow) =>
          ['active', 'blocked'].includes(workflow.state) &&
          workflow.stages.some(
            (stage) =>
              stage.kind === 'reviewer' &&
              stage.state === 'running' &&
              stage.taskId === active.id &&
              stage.agentId === agentId,
          ),
      )
    )
      return { state: 'reviewing', label: 'Reviewing · running workflow Reviewer' };
    return {
      state: 'working',
      label:
        active.executionMode === 'write'
          ? 'Working · isolated write turn'
          : 'Working · read-only turn',
    };
  }
  const checkpoint = officeCheckpoint(workflows, agentId);
  if (checkpoint) return { state: 'approval', label: checkpoint.label };
  const blocked = workflows
    .filter((workflow) => workflow.state === 'blocked')
    .flatMap((workflow) => workflow.stages)
    .find(
      (stage) =>
        stage.agentId === agentId && ['blocked', 'failed', 'interrupted'].includes(stage.state),
    );
  if (blocked)
    return { state: 'error', label: `Blocked · ${blocked.kind} workflow requires inspection` };
  const submitted = dashboard.queue.find((entry) => entry.agentId === agentId);
  if (submitted)
    return {
      state: 'queued',
      label: `Queued · ${submitted.waitingReason ?? 'submitted for execution'}`,
    };
  if (
    selected?.agentId === agentId &&
    (selected?.state === 'failed' || selected?.state === 'interrupted')
  )
    return { state: 'error', label: `Selected task ${selected.state}` };
  if (dashboard.connection.status === 'connection-error')
    return { state: 'error', label: 'Connection error' };
  if (dashboard.connection.status === 'authentication-required')
    return { state: 'offline', label: 'Authentication required' };
  if (agent?.state === 'waiting')
    return { state: 'idle', label: 'Waiting · no submitted task confirmed' };
  if (selected?.agentId === agentId && selected.state === 'completed')
    return { state: 'completed', label: 'Completed · saved result' };
  return {
    state: 'idle',
    label:
      selected?.agentId === agentId && selected.state === 'stopped'
        ? 'Idle · task stopped'
        : 'Idle · awaiting a task',
  };
}

export function workstationTask(
  dashboard: Dashboard | undefined,
  selectedId: string | undefined,
  agentId: AgentId = 'codex-1',
) {
  return (
    dashboard?.tasks.find(
      (task) => task.id === dashboard.agents.find((agent) => agent.id === agentId)?.taskId,
    ) ??
    dashboard?.tasks.find((task) => task.id === selectedId && task.agentId === agentId) ??
    dashboard?.tasks.find((task) => task.agentId === agentId)
  );
}
