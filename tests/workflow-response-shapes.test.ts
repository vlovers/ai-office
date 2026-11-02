import { describe, expect, it } from 'vitest';
import { assertWorkflowReadShape } from '../src/web/workflow-response-shapes.js';

const stage = { taskId: null, agentId: 'coder' };
const summary = {
  id: 'workflow-1',
  repositoryId: 'repo-1',
  state: 'active',
  version: 3,
  stages: [stage],
};
const timeline = {
  id: 'workflow-1',
  version: 3,
  state: 'active',
  notice: '',
  stages: [
    {
      kind: 'coder',
      status: 'awaiting_approval',
      agentId: 'coder',
      agentRevision: 1,
      mode: 'write',
      nextAction: 'approve-initial',
    },
  ],
};
const dashboard = {
  tasks: [{ id: 'task-1', title: 'Task', repositoryId: 'repo-1', agentId: 'coder', state: 'queued' }],
  queue: [{ taskId: 'task-1' }],
  profiles: [{ id: 'reviewer', name: 'Reviewer', archived: false, maximumMode: 'read-only' }],
};
const diagnostics = {
  id: 'workflow-1',
  version: 3,
  state: 'active',
  warning: '',
  findings: [{ code: 'none', severity: 'info', stage: null, message: 'OK', suggestedAction: null }],
};

describe('workflow read response shape boundary', () => {
  it.each([
    ['/workflows', [summary]],
    ['/dashboard', dashboard],
    ['/workflows/qa-commands', { commands: [{ commandId: 'source', argv: ['npm', 'test'] }] }],
    ['/workflows/workflow-1/timeline', timeline],
    ['/workflows/workflow-1/results', [{ kind: 'coder', result: '', error: null }]],
    ['/workflows/workflow-1/diagnostics', diagnostics],
  ])('accepts the expected fields for %s', (path, value) => {
    expect(() => assertWorkflowReadShape(path as string, value)).not.toThrow();
  });

  it.each([
    ['/workflows', { items: [summary] }, 'workflow list'],
    ['/workflows', [{ ...summary, stages: null }], 'workflow list'],
    ['/workflows', [{ ...summary, version: '3' }], 'workflow list'],
    ['/dashboard', { ...dashboard, queue: null }, 'dashboard'],
    ['/dashboard', { ...dashboard, tasks: [null] }, 'dashboard'],
    ['/workflows/qa-commands', [], 'QA command catalog'],
    ['/workflows/qa-commands', { commands: [{ commandId: 'source', argv: 'npm test' }] }, 'QA command catalog'],
    ['/workflows/workflow-1/timeline', { ...timeline, stages: 'broken' }, 'workflow timeline'],
    ['/workflows/workflow-1/timeline', { ...timeline, stages: [{ kind: null }] }, 'workflow timeline'],
    ['/workflows/workflow-1/results', [{ kind: 'coder', result: null, error: null }], 'workflow reports'],
    ['/workflows/workflow-1/diagnostics', { ...diagnostics, findings: null }, 'workflow diagnostics'],
    ['/workflows/workflow-1/diagnostics', { ...diagnostics, findings: [null] }, 'workflow diagnostics'],
  ])('rejects malformed %s without trusting the checkpoint', (path, value, label) => {
    expect(() => assertWorkflowReadShape(path as string, value)).toThrow(
      `Invalid workflow response: malformed ${label}`,
    );
  });

  it('rejects unknown GET endpoints rather than silently trusting unvalidated data', () => {
    expect(() => assertWorkflowReadShape('/workflows/unrecognized', {})).toThrow(
      'Unrecognized workflow read endpoint',
    );
  });

  it('does not mutate valid server payloads', () => {
    const input = Object.freeze([Object.freeze({ ...summary, stages: Object.freeze([stage]) })]);
    assertWorkflowReadShape('/workflows', input);
    expect(input[0]?.stages[0]).toBe(stage);
  });
});
