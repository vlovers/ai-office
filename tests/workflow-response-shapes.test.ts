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
  tasks: [
    {
      id: 'task-1',
      title: 'Task',
      repositoryId: 'repo-1',
      agentId: 'coder',
      state: 'queued',
    },
  ],
  queue: [{ taskId: 'task-1' }],
  profiles: [
    {
      id: 'reviewer',
      name: 'Reviewer',
      archived: false,
      maximumMode: 'read-only',
    },
  ],
};
const diagnostics = {
  id: 'workflow-1',
  version: 3,
  state: 'active',
  warning: '',
  findings: [
    {
      code: 'none',
      severity: 'info',
      stage: null,
      message: 'OK',
      suggestedAction: null,
    },
  ],
};

describe('workflow read response shape boundary', () => {
  it('accepts all expected GET payloads', () => {
    expect(() => assertWorkflowReadShape('/workflows', [summary])).not.toThrow();
    expect(() => assertWorkflowReadShape('/dashboard', dashboard)).not.toThrow();
    expect(() =>
      assertWorkflowReadShape('/workflows/qa-commands', {
        commands: [{ commandId: 'source', argv: ['npm', 'test'] }],
      }),
    ).not.toThrow();
    expect(() => assertWorkflowReadShape('/workflows/workflow-1/timeline', timeline)).not.toThrow();
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/results', [
        { kind: 'coder', result: '', error: null },
      ]),
    ).not.toThrow();
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/diagnostics', diagnostics),
    ).not.toThrow();
  });

  it('rejects a non-array workflow list', () => {
    expect(() => assertWorkflowReadShape('/workflows', { items: [summary] })).toThrow(
      'Invalid workflow response: malformed workflow list',
    );
  });

  it('rejects invalid nested workflow stages and versions', () => {
    expect(() => assertWorkflowReadShape('/workflows', [{ ...summary, stages: null }])).toThrow();
    expect(() => assertWorkflowReadShape('/workflows', [{ ...summary, version: '3' }])).toThrow();
  });

  it('rejects malformed dashboard collections', () => {
    expect(() => assertWorkflowReadShape('/dashboard', { ...dashboard, queue: null })).toThrow();
    expect(() => assertWorkflowReadShape('/dashboard', { ...dashboard, tasks: [null] })).toThrow();
  });

  it('rejects malformed QA command catalogs', () => {
    expect(() => assertWorkflowReadShape('/workflows/qa-commands', [])).toThrow(
      'Invalid workflow response: malformed QA command catalog',
    );
    expect(() =>
      assertWorkflowReadShape('/workflows/qa-commands', {
        commands: [{ commandId: 'source', argv: 'npm test' }],
      }),
    ).toThrow();
  });

  it('rejects malformed timeline stages', () => {
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/timeline', {
        ...timeline,
        stages: 'broken',
      }),
    ).toThrow('Invalid workflow response: malformed workflow timeline');
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/timeline', {
        ...timeline,
        stages: [{ kind: null }],
      }),
    ).toThrow();
  });

  it('rejects malformed report entries', () => {
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/results', [
        { kind: 'coder', result: null, error: null },
      ]),
    ).toThrow('Invalid workflow response: malformed workflow reports');
  });

  it('rejects malformed diagnostics', () => {
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/diagnostics', {
        ...diagnostics,
        findings: null,
      }),
    ).toThrow('Invalid workflow response: malformed workflow diagnostics');
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/diagnostics', {
        ...diagnostics,
        findings: [null],
      }),
    ).toThrow();
  });

  it('rejects unknown GET endpoints instead of silently trusting data', () => {
    expect(() => assertWorkflowReadShape('/workflows/unrecognized', {})).toThrow(
      'Unrecognized workflow read endpoint',
    );
  });

  it('accepts optional checkpoint metadata when absent, null, or well-typed', () => {
    expect(() =>
      assertWorkflowReadShape('/workflows', [
        {
          ...summary,
          createdAt: '2026-11-03T00:00:00Z',
          updatedAt: '2026-11-03T00:00:00Z',
          stages: [{ ...stage, kind: 'coder', state: 'running' }],
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/timeline', {
        ...timeline,
        stages: [
          {
            ...timeline.stages[0],
            taskId: null,
            evidenceRevision: 'revision-1',
            approvalRevision: null,
            reportDigest: 'digest-1',
            sourceDigest: null,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertWorkflowReadShape('/dashboard', {
        ...dashboard,
        tasks: [{ ...dashboard.tasks[0], executionMode: 'write' }],
      }),
    ).not.toThrow();
  });

  it('rejects malformed optional workflow metadata and stage labels', () => {
    expect(() => assertWorkflowReadShape('/workflows', [{ ...summary, updatedAt: {} }])).toThrow();
    expect(() =>
      assertWorkflowReadShape('/workflows', [
        { ...summary, stages: [{ ...stage, kind: { label: 'coder' } }] },
      ]),
    ).toThrow();
    expect(() =>
      assertWorkflowReadShape('/workflows', [
        { ...summary, stages: [{ ...stage, state: ['running'] }] },
      ]),
    ).toThrow();
  });

  it.each<[string, unknown]>([
    ['taskId', { id: 'task' }],
    ['evidenceRevision', { revision: 'unsafe' }],
    ['approvalRevision', ['unsafe']],
    ['reportDigest', 42],
    ['sourceDigest', { digest: 'unsafe' }],
  ])('rejects malformed timeline stage %s before rendering', (field, invalid) => {
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/timeline', {
        ...timeline,
        stages: [{ ...timeline.stages[0], [field]: invalid }],
      }),
    ).toThrow('Invalid workflow response: malformed workflow timeline');
  });

  it('rejects malformed optional report task IDs', () => {
    expect(() =>
      assertWorkflowReadShape('/workflows/workflow-1/results', [
        { kind: 'coder', result: '', error: null, taskId: { id: 'task' } },
      ]),
    ).toThrow('Invalid workflow response: malformed workflow reports');
  });

  it('rejects malformed optional dashboard execution modes', () => {
    expect(() =>
      assertWorkflowReadShape('/dashboard', {
        ...dashboard,
        tasks: [{ ...dashboard.tasks[0], executionMode: { mode: 'write' } }],
      }),
    ).toThrow('Invalid workflow response: malformed dashboard');
  });

  it('does not mutate valid server payloads', () => {
    const input = Object.freeze([Object.freeze({ ...summary, stages: Object.freeze([stage]) })]);
    assertWorkflowReadShape('/workflows', input);
    expect(input[0]?.stages[0]).toBe(stage);
  });
});
