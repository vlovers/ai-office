import { describe, expect, it } from 'vitest';
import {
  isDashboardSnapshot,
  isOfficeWorkflowList,
  parseOfficeApiResponse,
} from '../src/web/office-api-response.js';

const reply = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

const dashboard = {
  connection: { message: 'Ready', modes: [] },
  repositories: [{ id: 'repo', name: 'Example' }],
  tasks: [
    {
      id: 'task',
      title: 'Review',
      state: 'queued',
      agentId: 'codex-1',
      repositoryId: 'repo',
      createdAt: '2026-11-03T06:00:00Z',
      updatedAt: '2026-11-03T06:00:00Z',
    },
  ],
  sessions: [{ id: 'session' }],
  agents: [{ id: 'codex-1', name: 'Codex' }],
  agent: { id: 'codex-1' },
  queue: [{ taskId: 'task' }],
  concurrency: 2,
  ready: true,
  readinessMessage: 'Ready',
};

describe('office API response handling', () => {
  it('accepts JSON success and preserves JSON error details with HTTP status', async () => {
    await expect(parseOfficeApiResponse(reply(200, '{"ok":true}'))).resolves.toEqual({
      ok: true,
    });
    await expect(parseOfficeApiResponse(reply(409, '{"error":"Stale revision"}'))).rejects.toThrow(
      'HTTP 409: Stale revision',
    );
  });

  it.each([
    [502, '<html>Bad gateway</html>', 'Request failed (HTTP 502)'],
    [503, '', 'Request failed (HTTP 503)'],
    [200, '<html>Login proxy</html>', 'Invalid server response (HTTP 200)'],
    [200, '', 'Invalid server response (HTTP 200)'],
    [200, 'null', 'Invalid server response (HTTP 200)'],
    [200, '"not a snapshot"', 'Invalid server response (HTTP 200)'],
  ])('rejects malformed response with HTTP %i', async (status, body, message) => {
    await expect(parseOfficeApiResponse(reply(status, body))).rejects.toThrow(message);
  });

  it('rejects malformed dashboard collections and preserves a valid snapshot', () => {
    expect(isDashboardSnapshot(dashboard)).toBe(true);
    // Archived profiles yield an empty agents list and no legacy agent field.
    expect(isDashboardSnapshot({ ...dashboard, agents: [], agent: undefined })).toBe(true);
    expect(isDashboardSnapshot({ ...dashboard, tasks: 'invalid' })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, agents: null })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, tasks: [null] })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, tasks: [{ id: 7 }] })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, connection: null })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, repositories: [{}] })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, concurrency: Infinity })).toBe(false);
  });

  it('accepts valid nested dashboard details, including archived profiles', () => {
    expect(
      isDashboardSnapshot({
        ...dashboard,
        connection: {
          ...dashboard.connection,
          checkedAt: null,
          modes: [{ mode: 'api-key', label: 'API key', status: 'available' }],
        },
        profiles: [{ id: 'archived', name: 'Archived', archived: true }],
        tasks: [
          {
            ...dashboard.tasks[0],
            changedFiles: [{ path: 'README.md', status: 'modified' }],
            baselineFiles: [],
            error: null,
            summaryError: null,
            sessionId: null,
            reviewRequest: { revision: 'rev', sessionId: 'session', threadId: 'thread' },
            result: '',
          },
        ],
        sessions: [{ id: 'session', threadId: null }],
        agents: [{ ...dashboard.agents[0], taskId: null, canStop: false }],
        queue: [{ taskId: 'task', order: 0, resumeSessionId: null, waitingReason: 'waiting' }],
      }),
    ).toBe(true);
  });

  it.each([
    ['connection mode entry', { connection: { ...dashboard.connection, modes: [null] } }],
    [
      'connection mode label',
      { connection: { ...dashboard.connection, modes: [{ mode: 'api-key', label: {} }] } },
    ],
    ['connection timestamp', { connection: { ...dashboard.connection, checkedAt: {} } }],
    ['profile entry', { profiles: [null] }],
    ['profile name', { profiles: [{ id: 'p', name: {} }] }],
    ['profile archive flag', { profiles: [{ id: 'p', name: 'Profile', archived: 'yes' }] }],
    ['task changed file entry', { tasks: [{ ...dashboard.tasks[0], changedFiles: [null] }] }],
    [
      'task changed file path',
      { tasks: [{ ...dashboard.tasks[0], changedFiles: [{ path: {}, status: 'added' }] }] },
    ],
    ['task baseline files', { tasks: [{ ...dashboard.tasks[0], baselineFiles: {} }] }],
    ['task error', { tasks: [{ ...dashboard.tasks[0], error: {} }] }],
    ['task result', { tasks: [{ ...dashboard.tasks[0], result: {} }] }],
    ['session thread', { sessions: [{ id: 'session', threadId: {} }] }],
    ['agent task ID', { agents: [{ ...dashboard.agents[0], taskId: {} }] }],
    ['agent stop flag', { agents: [{ ...dashboard.agents[0], canStop: 'yes' }] }],
    ['queue order', { queue: [{ taskId: 'task', order: 'first' }] }],
  ])('rejects malformed nested dashboard %s', (_label, override) => {
    expect(isDashboardSnapshot({ ...dashboard, ...override })).toBe(false);
  });

  it.each([
    ['missing task repository', { tasks: [{ ...dashboard.tasks[0], repositoryId: undefined }] }],
    ['object task repository', { tasks: [{ ...dashboard.tasks[0], repositoryId: {} }] }],
    ['missing task createdAt', { tasks: [{ ...dashboard.tasks[0], createdAt: undefined }] }],
    ['object task createdAt', { tasks: [{ ...dashboard.tasks[0], createdAt: {} }] }],
    ['missing task updatedAt', { tasks: [{ ...dashboard.tasks[0], updatedAt: undefined }] }],
    ['numeric task updatedAt', { tasks: [{ ...dashboard.tasks[0], updatedAt: 42 }] }],
    ['unknown task state', { tasks: [{ ...dashboard.tasks[0], state: 'approved' }] }],
    ['task summary error', { tasks: [{ ...dashboard.tasks[0], summaryError: {} }] }],
    ['task session ID', { tasks: [{ ...dashboard.tasks[0], sessionId: {} }] }],
    ['review request object', { tasks: [{ ...dashboard.tasks[0], reviewRequest: [] }] }],
    [
      'review request revision',
      {
        tasks: [
          {
            ...dashboard.tasks[0],
            reviewRequest: { revision: {}, sessionId: 'session', threadId: 'thread' },
          },
        ],
      },
    ],
    [
      'review request thread',
      {
        tasks: [
          {
            ...dashboard.tasks[0],
            reviewRequest: { revision: 'rev', sessionId: 'session', threadId: null },
          },
        ],
      },
    ],
    ['negative queue order', { queue: [{ taskId: 'task', order: -1 }] }],
    ['fractional queue order', { queue: [{ taskId: 'task', order: 1.5 }] }],
    ['queue resume session', { queue: [{ taskId: 'task', resumeSessionId: {} }] }],
    ['queue waiting reason', { queue: [{ taskId: 'task', waitingReason: {} }] }],
    ['negative concurrency', { concurrency: -1 }],
    ['fractional concurrency', { concurrency: 1.5 }],
    ['unsafe concurrency', { concurrency: Number.MAX_SAFE_INTEGER + 1 }],
    ['malformed legacy agent with no active agents', { agents: [], agent: { id: 4 } }],
  ])('rejects invalid dashboard control data: %s', (_label, override) => {
    expect(isDashboardSnapshot({ ...dashboard, ...override })).toBe(false);
  });

  it('accepts zero concurrency and an absent legacy agent with no active agents', () => {
    expect(isDashboardSnapshot({ ...dashboard, concurrency: 0 })).toBe(true);
    expect(isDashboardSnapshot({ ...dashboard, agents: [], agent: undefined })).toBe(true);
  });

  it('rejects malformed workflow lists before the office scene renders', () => {
    const valid = [
      {
        id: 'workflow',
        state: 'active',
        stages: [{ kind: 'coder', agentId: 'codex-1', state: 'ready', taskId: null }],
      },
    ];
    expect(isOfficeWorkflowList(valid)).toBe(true);
    expect(isOfficeWorkflowList([])).toBe(true);
    expect(isOfficeWorkflowList({ workflows: valid })).toBe(false);
    expect(isOfficeWorkflowList([{ ...valid[0], stages: null }])).toBe(false);
    expect(isOfficeWorkflowList([{ ...valid[0], stages: [null] }])).toBe(false);
    const malformedStage = { ...valid[0]!.stages[0]!, taskId: {} };
    expect(isOfficeWorkflowList([{ ...valid[0], stages: [malformedStage] }])).toBe(false);
  });
});
