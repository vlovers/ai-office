import { describe, expect, it } from 'vitest';
import {
  selectWorkflowOperations,
  workflowNeedsAttention,
  workflowTriageKind,
  summarizeWorkflowOperations,
  type WorkflowOperationsSort,
} from '../src/web/workflow-operations.js';

const items = [
  {
    id: 'a',
    repositoryId: 'one',
    state: 'active',
    updatedAt: '2026-10-21',
    stages: [{ state: 'running' }],
  },
  {
    id: 'b',
    repositoryId: 'two',
    state: 'blocked',
    updatedAt: '2026-10-20',
    stages: [{ state: 'awaiting_approval' }],
  },
  {
    id: 'c',
    repositoryId: 'one',
    state: 'completed',
    updatedAt: '2026-10-22',
    stages: [{ state: 'completed' }],
  },
  {
    id: 'd',
    repositoryId: 'three',
    state: 'active',
    updatedAt: '2026-10-22',
    stages: [{ state: 'interrupted' }],
  },
] as const;

const options = {
  query: '',
  state: 'all',
  triageOnly: false,
  sort: 'attention' as WorkflowOperationsSort,
};

function select(overrides: Partial<typeof options> = {}) {
  return selectWorkflowOperations(items, { ...options, ...overrides });
}

describe('workflow operations projection', () => {
  it('prioritizes attention without mutating the source', () => {
    expect(select().map((item) => item.id)).toEqual(['d', 'b', 'c', 'a']);
    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters by state and case-insensitive repository search', () => {
    const result = select({ query: ' ONE ', state: 'completed' });
    expect(result.map((item) => item.id)).toEqual(['c']);
  });

  it('filters to triage items', () => {
    expect(select({ triageOnly: true }).map((item) => item.id)).toEqual(['d', 'b']);
  });

  it('sorts oldest first with stable ties', () => {
    const result = select({ sort: 'oldest' });
    expect(result.map((item) => item.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('sorts most recent first with stable ties', () => {
    const result = select({ sort: 'recent' });
    expect(result.map((item) => item.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('handles missing matches without mutating source', () => {
    expect(select({ query: 'missing' })).toEqual([]);
    expect(select({ state: 'cancelled' })).toEqual([]);
    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('recognizes failures and ignores healthy stages', () => {
    expect(workflowNeedsAttention(items[0]!)).toBe(false);
    expect(workflowNeedsAttention(items[2]!)).toBe(false);
    expect(workflowNeedsAttention(items[1]!)).toBe(true);
    expect(workflowNeedsAttention(items[3]!)).toBe(true);
  });
});

describe('persisted workflow triage semantics', () => {
  const fixture = [
    { id: 'failed', repositoryId: 'repo', state: 'active', stages: [{ state: 'failed' }] },
    {
      id: 'approval',
      repositoryId: 'repo',
      state: 'blocked',
      stages: [{ state: 'awaiting_approval' }],
    },
    { id: 'blocked', repositoryId: 'repo', state: 'blocked', stages: [{ state: 'blocked' }] },
    { id: 'running', repositoryId: 'repo', state: 'active', stages: [{ state: 'running' }] },
    {
      id: 'finished',
      repositoryId: 'repo',
      state: 'completed',
      stages: [{ state: 'failed' }],
    },
    { id: 'other', repositoryId: 'repo', state: 'active', stages: [{ state: 'pending' }] },
  ] as const;

  it('distinguishes actionable failures, approvals and blocked checkpoints', () => {
    expect(fixture.map(workflowTriageKind)).toEqual([
      'failed',
      'approval',
      'blocked',
      'running',
      'finished',
      'other',
    ]);
    expect(fixture.map(workflowNeedsAttention)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('does not surface historical failed stages in terminal workflows', () => {
    expect(workflowTriageKind(fixture[4]!)).toBe('finished');
    expect(workflowNeedsAttention(fixture[4]!)).toBe(false);
  });

  it('counts each workflow once without mutating source data', () => {
    expect(summarizeWorkflowOperations(fixture)).toEqual({
      total: 6,
      failed: 1,
      approval: 1,
      blocked: 1,
      running: 1,
      finished: 1,
      other: 1,
      attention: 3,
    });
    expect(summarizeWorkflowOperations([]).attention).toBe(0);
    expect(fixture[0]!.state).toBe('active');
  });

  it('orders failures ahead of approvals and blocked checkpoints', () => {
    expect(
      selectWorkflowOperations(fixture, {
        query: '',
        state: 'all',
        triageOnly: false,
        sort: 'attention',
      }).map((item) => item.id),
    ).toEqual(['failed', 'approval', 'blocked', 'running', 'other', 'finished']);
  });

  it('never infers a failure solely from missing timestamps or pending work', () => {
    expect(workflowTriageKind(fixture[5]!)).toBe('other');
    expect(workflowNeedsAttention(fixture[5]!)).toBe(false);
  });
});
