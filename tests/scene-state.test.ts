import { expect, it } from 'vitest';
import type { AgentEvent, Dashboard, Task } from '../src/shared/types.js';
import { sceneStatus, workstationTask } from '../src/web/scene-state.js';

const task = (id: string, state: Task['state'] = 'queued'): Task => ({
  id,
  state,
  repositoryId: 'example',
  sessionId: null,
  agentId: 'codex-1',
  title: id,
  prompt: 'Review README',
  result: '',
  error: null,
  changedFiles: [],
  baselineFiles: [],
  summaryError: null,
  createdAt: '',
  updatedAt: '',
});
const dashboard = (tasks: Task[] = [], activeId: string | null = null): Dashboard => ({
  tasks,
  concurrency: 2,
  queue: [],
  agents: [
    {
      id: 'codex-1',
      name: 'Codex 01',
      provider: 'codex',
      state: activeId ? 'running' : 'idle',
      taskId: activeId,
      canStop: true,
      mode: 'read-only',
    },
  ],
  repositories: [],
  sessions: [],
  ready: true,
  readinessMessage: 'Available',
  connection: {
    mode: 'local-cli-chatgpt',
    status: 'available',
    message: 'Available',
    checkedAt: null,
    modes: [],
  },
  agent: {
    id: 'codex-1',
    name: 'Codex 01',
    provider: 'codex',
    state: activeId ? 'running' : 'idle',
    taskId: activeId,
    canStop: true,
    mode: 'read-only',
  },
});
const event = (taskId: string, type: string, itemType: string): AgentEvent => ({
  id: 1,
  taskId,
  at: '',
  kind: 'progress',
  message: 'Not used to infer activity',
  data: { kind: 'progress', data: { type, item: { type: itemType } } },
});
it('shows connecting/offline rather than fabricated activity', () => {
  expect(sceneStatus(undefined, undefined, []).state).toBe('offline');
  expect(sceneStatus(dashboard(), undefined, []).state).toBe('idle');
  expect(sceneStatus(dashboard([task('a', 'running')], 'a'), undefined, [], true).label).toBe(
    'Server disconnected',
  );
});
it('derives thinking only from a live SDK reasoning item for the active task', () => {
  const active = task('a', 'running');
  const data = dashboard([active], 'a');
  expect(sceneStatus(data, active, [event('a', 'item.updated', 'reasoning')]).state).toBe(
    'thinking',
  );
  expect(sceneStatus(data, active, [event('a', 'item.completed', 'reasoning')]).state).toBe(
    'working',
  );
  expect(sceneStatus(data, active, [event('old', 'item.updated', 'reasoning')]).state).toBe(
    'working',
  );
  expect(sceneStatus(data, active, [event('a', 'item.started', 'command_execution')]).state).toBe(
    'working',
  );
});
it('does not retain reasoning animation after a task ends or stops', () => {
  const saved = task('a', 'completed');
  expect(
    sceneStatus(dashboard([saved]), saved, [event('a', 'item.updated', 'reasoning')]).state,
  ).toBe('idle');
  const stopping = task('a', 'stopping');
  expect(
    sceneStatus(dashboard([stopping], 'a'), stopping, [event('a', 'item.updated', 'reasoning')])
      .state,
  ).toBe('stopping');
});
it('labels failed history as selected task failure while prioritizing real active work', () => {
  const failed = task('old', 'failed');
  const active = task('a', 'running');
  expect(sceneStatus(dashboard([failed]), failed, []).label).toBe('Selected task failed');
  expect(sceneStatus(dashboard([active, failed], 'a'), failed, []).state).toBe('working');
});
it('reports connection and authentication failures without implying work is running', () => {
  const data = dashboard();
  data.connection.status = 'authentication-required';
  expect(sceneStatus(data, undefined, []).label).toBe('Authentication required');
  data.connection.status = 'connection-error';
  expect(sceneStatus(data, undefined, []).state).toBe('error');
});
it('workstation selects only an actual active, selected, or saved task', () => {
  const a = task('a');
  const b = task('b');
  expect(workstationTask(undefined, undefined)).toBeUndefined();
  expect(workstationTask(dashboard(), 'missing')).toBeUndefined();
  expect(workstationTask(dashboard([a, b], 'b'), 'a')?.id).toBe('b');
  expect(workstationTask(dashboard([a, b]), 'b')?.id).toBe('b');
  expect(workstationTask(dashboard([a, b]), undefined)?.id).toBe('a');
});
