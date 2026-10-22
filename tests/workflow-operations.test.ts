import { describe, expect, it } from 'vitest';
import { selectWorkflowOperations, workflowNeedsAttention } from '../src/web/workflow-operations.js';

const items = Object.freeze([
  Object.freeze({ id: 'a', repositoryId: 'repo-one', state: 'active', updatedAt: '2026-10-21T00:00:00Z', stages: Object.freeze([{ state: 'running' }]) }),
  Object.freeze({ id: 'b', repositoryId: 'repo-two', state: 'blocked', updatedAt: '2026-10-20T00:00:00Z', stages: Object.freeze([{ state: 'awaiting_approval' }]) }),
  Object.freeze({ id: 'c', repositoryId: 'repo-one', state: 'completed', updatedAt: '2026-10-22T00:00:00Z', stages: Object.freeze([{ state: 'completed' }]) }),
  Object.freeze({ id: 'd', repositoryId: 'repo-three', state: 'active', updatedAt: '2026-10-22T00:00:00Z', stages: Object.freeze([{ state: 'interrupted' }]) }),
]);

const options = { query: '', state: 'all', triageOnly: false, sort: 'attention' as const };
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

describe('workflow operations projection', () => {
  it('prioritizes blocked or interrupted workflows without mutating source', () => {
    expect(ids(selectWorkflowOperations(items, options))).toEqual(['d', 'b', 'c', 'a']);
    expect(ids(items)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('filters by state and repository with trimmed case-insensitive query', () => {
    expect(ids(selectWorkflowOperations(items, { ...options, query: ' REPO-ONE ', state: 'completed' }))).toEqual(['c']);
  });
  it('supports triage-only and chronological sorts', () => {
    expect(ids(selectWorkflowOperations(items, { ...options, triageOnly: true }))).toEqual(['d', 'b']);
    expect(ids(selectWorkflowOperations(items, { ...options, sort: 'oldest' }))).toEqual(['b', 'a', 'c', 'd']);
  });
  it('does not classify normal running or completed stages as attention', () => {
    expect(workflowNeedsAttention(items[0])).toBe(false);
    expect(workflowNeedsAttention(items[2])).toBe(false);
  });
  it('uses workflow ID as deterministic timestamp tie breaker', () => {
    expect(ids(selectWorkflowOperations(items, { ...options, sort: 'recent' }))).toEqual(['c', 'd', 'a', 'b']);
  });
});
