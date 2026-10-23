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
  ).toBe('completed');
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

it('keeps saved outcomes and live reasoning scoped to their owning workstation', () => {
  const first = task('saved', 'completed');
  const second = { ...task('active', 'running'), agentId: 'codex-2' as const };
  const data = dashboard([second, first]);
  data.agents.push({
    ...data.agents[0]!,
    id: 'codex-2',
    name: 'Codex 02',
    taskId: second.id,
    state: 'running',
  });
  expect(
    sceneStatus(data, first, [event(second.id, 'item.started', 'reasoning')], false, 'codex-1')
      .state,
  ).toBe('completed');
  expect(
    sceneStatus(data, first, [event(second.id, 'item.started', 'reasoning')], false, 'codex-2')
      .state,
  ).toBe('thinking');
  expect(sceneStatus(data, first, [], true, 'codex-1').state).toBe('offline');
  expect(sceneStatus(data, first, [], true, 'codex-2').state).toBe('offline');
  data.agents = [];
  expect(sceneStatus(data, first, [], false, 'codex-1').state).toBe('offline');
});

it('distinguishes unsubmitted tasks from a real persisted FIFO entry', () => {
  const waiting = task('draft');
  const data = dashboard([waiting]);
  expect(sceneStatus(data, waiting, []).state).toBe('idle');
  data.queue = [
    {
      taskId: waiting.id,
      agentId: waiting.agentId,
      order: 1,
      enqueuedAt: '',
      mode: 'local-cli-chatgpt',
      resumeSessionId: null,
      waitingReason: 'Workspace busy',
    },
  ];
  expect(sceneStatus(data, waiting, [])).toEqual({
    state: 'queued',
    label: 'Queued · Workspace busy',
  });
});
it('derives approval only from an actionable persisted workflow and prioritizes live work', () => {
  const workflows = [
    {
      id: 'flow',
      state: 'active',
      stages: [{ kind: 'coder', agentId: 'codex-1', state: 'awaiting_approval', taskId: null }],
    },
  ];
  expect(sceneStatus(dashboard(), undefined, [], false, 'codex-1', workflows).state).toBe(
    'approval',
  );
  expect(sceneStatus(dashboard(), undefined, [], true, 'codex-1', workflows).state).toBe('offline');
  expect(
    sceneStatus(dashboard(), undefined, [], false, 'codex-1', [
      { ...workflows[0]!, state: 'cancelled' },
    ]).state,
  ).toBe('idle');
  const running = task('live', 'running');
  expect(
    sceneStatus(dashboard([running], running.id), running, [], false, 'codex-1', workflows).state,
  ).toBe('working');
});
it('calls a task reviewing only when the exact workflow Reviewer stage is running', () => {
  const running = task('review', 'running');
  const data = dashboard([running], running.id);
  const workflows = [
    {
      id: 'flow',
      state: 'active',
      stages: [{ kind: 'reviewer', agentId: 'codex-1', state: 'running', taskId: running.id }],
    },
  ];
  expect(sceneStatus(data, running, [], false, 'codex-1', workflows).state).toBe('reviewing');
  expect(
    sceneStatus(data, running, [], false, 'codex-1', [
      { ...workflows[0]!, stages: [{ ...workflows[0]!.stages[0]!, taskId: 'different' }] },
    ]).state,
  ).toBe('working');
  expect(
    sceneStatus(
      data,
      running,
      [event(running.id, 'item.started', 'reasoning')],
      false,
      'codex-1',
      workflows,
    ).state,
  ).toBe('thinking');
});

it('shows explicit blocked workflow diagnostics without fabricating an approval', () => {
  const blocked = [
    {
      id: 'flow',
      state: 'blocked',
      stages: [{ kind: 'coder', agentId: 'codex-1', state: 'blocked', taskId: null }],
    },
  ];
  expect(sceneStatus(dashboard(), undefined, [], false, 'codex-1', blocked)).toEqual({
    state: 'error',
    label: 'Blocked · coder workflow requires inspection',
  });
  const evidence = [
    { ...blocked[0]!, stages: [{ ...blocked[0]!.stages[0]!, evidence: { revision: 'actual' } }] },
  ];
  expect(sceneStatus(dashboard(), undefined, [], false, 'codex-1', evidence).state).toBe(
    'approval',
  );
});

it('does not label an actual preparing reservation as ready or running', () => {
  const data = dashboard([task('prepare')], 'prepare');
  data.agents[0]!.state = 'preparing';
  expect(sceneStatus(data, undefined, [])).toEqual({
    state: 'preparing',
    label: 'Preparing read-only session',
  });
});
