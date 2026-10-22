import { describe, expect, it } from 'vitest';
import {
  selectWorkflowOperations,
  workflowNeedsAttention,
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
