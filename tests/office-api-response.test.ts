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
  tasks: [{ id: 'task', title: 'Review', state: 'queued', agentId: 'codex-1' }],
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
    expect(isDashboardSnapshot({ ...dashboard, tasks: 'invalid' })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, agents: null })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, tasks: [null] })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, tasks: [{ id: 7 }] })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, connection: null })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, repositories: [{}] })).toBe(false);
    expect(isDashboardSnapshot({ ...dashboard, concurrency: Infinity })).toBe(false);
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
    expect(
      isOfficeWorkflowList([
        { ...valid[0], stages: [{ ...valid[0].stages[0], taskId: {} }] },
      ]),
    ).toBe(false);
  });
});
