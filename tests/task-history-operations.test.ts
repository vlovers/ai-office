import { describe, expect, it } from 'vitest';
import type { AgentId } from '../src/shared/types.js';
import {
  historyFilterOptions,
  selectTaskHistory,
  summarizeTaskHistory,
  taskHistoryGroup,
  taskNeedsAttention,
  type TaskHistoryOptions,
} from '../src/web/task-history-operations.js';

const id = (value: string) => value as AgentId;
const tasks = [
  {
    id: 'done',
    title: 'Finish docs',
    agentId: id('a'),
    repositoryId: 'repo-1',
    state: 'completed',
    updatedAt: '2026-10-23T11:00:00Z',
  },
  {
    id: 'broken',
    title: 'Fix auth',
    agentId: id('b'),
    repositoryId: 'repo-2',
    state: 'failed',
    updatedAt: '2026-10-20T11:00:00Z',
  },
  {
    id: 'running',
    title: 'Build UI',
    agentId: id('a'),
    repositoryId: 'repo-1',
    state: 'running',
    updatedAt: '2026-10-22T11:00:00Z',
  },
  {
    id: 'queued',
    title: 'Review UI',
    agentId: id('b'),
    repositoryId: 'repo-1',
    state: 'queued',
    updatedAt: '2026-10-21T11:00:00Z',
  },
  {
    id: 'stopped',
    title: 'Interrupted run',
    agentId: id('a'),
    repositoryId: 'repo-2',
    state: 'interrupted',
    updatedAt: '2026-10-19T11:00:00Z',
  },
] as const;

const options: TaskHistoryOptions = { query: '', status: 'all', order: 'attention' };
const select = (changes: Partial<TaskHistoryOptions> = {}) =>
  selectTaskHistory(tasks, { ...options, ...changes });

describe('task history operations', () => {
  it('sorts failures before running, queued and completed without changing input', () => {
    expect(select().map((task) => task.id)).toEqual([
      'broken',
      'stopped',
      'running',
      'queued',
      'done',
    ]);
    expect(tasks[0]?.id).toBe('done');
  });

  it('filters by title, task id, repository and agent', () => {
    expect(select({ query: ' AUTH ' }).map((task) => task.id)).toEqual(['broken']);
    expect(select({ query: 'BROKEN' }).map((task) => task.id)).toEqual(['broken']);
    expect(select({ repositoryId: 'repo-1', agentId: id('b') }).map((task) => task.id)).toEqual([
      'queued',
    ]);
    expect(select({ query: 'missing' })).toEqual([]);
  });

  it('supports all status groups and chronological ordering', () => {
    expect(select({ status: 'attention' }).map((task) => task.id)).toEqual(['broken', 'stopped']);
    expect(select({ status: 'active' }).map((task) => task.id)).toEqual(['running']);
    expect(select({ status: 'queued' }).map((task) => task.id)).toEqual(['queued']);
    expect(select({ status: 'completed' }).map((task) => task.id)).toEqual(['done']);
    expect(select({ order: 'recent' }).map((task) => task.id)).toEqual([
      'done',
      'running',
      'queued',
      'broken',
      'stopped',
    ]);
    expect(select({ order: 'oldest' }).map((task) => task.id)).toEqual([
      'stopped',
      'broken',
      'queued',
      'running',
      'done',
    ]);
  });

  it('counts persisted states without inferring elapsed-time failures', () => {
    expect(summarizeTaskHistory(tasks)).toEqual({
      total: 5,
      active: 1,
      queued: 1,
      attention: 2,
      completed: 1,
      other: 0,
    });
    expect(summarizeTaskHistory([]).total).toBe(0);
    expect(taskNeedsAttention({ state: 'running' })).toBe(false);
    expect(taskHistoryGroup({ state: 'stopping' })).toBe('active');
    expect(taskHistoryGroup({ state: 'stopped' })).toBe('other');
  });

  it('keeps archived agents and removed repositories available as history filters', () => {
    const agentOptions = historyFilterOptions(
      [{ id: 'a', name: 'Active agent' }],
      tasks.map((task) => task.agentId),
    );
    expect(agentOptions).toEqual([
      { id: 'a', name: 'Active agent' },
      { id: 'b', name: 'b' },
    ]);
    expect(select({ agentId: id('b') }).map((task) => task.id)).toEqual([
      'broken',
      'queued',
    ]);

    const repoOptions = historyFilterOptions(
      [{ id: 'repo-1', name: 'Current repository' }],
      tasks.map((task) => task.repositoryId),
    );
    expect(repoOptions).toEqual([
      { id: 'repo-1', name: 'Current repository' },
      { id: 'repo-2', name: 'repo-2' },
    ]);
    expect(select({ repositoryId: 'repo-2' }).map((task) => task.id)).toEqual([
      'broken',
      'stopped',
    ]);
  });

  it('deduplicates filter IDs and prefers the last known display name', () => {
    const known = [
      { id: 'old', name: 'Old profile name' },
      { id: 'old', name: 'Current profile name' },
    ];
    expect(historyFilterOptions(known, ['old', 'missing', 'missing'])).toEqual([
      { id: 'old', name: 'Current profile name' },
      { id: 'missing', name: 'missing' },
    ]);
    expect(known[0]!.name).toBe('Old profile name');
  });

  it('uses stable task ids for timestamp ties', () => {
    const tied = [
      { ...tasks[0]!, id: 'z' },
      { ...tasks[0]!, id: 'a' },
    ];
    expect(selectTaskHistory(tied, options).map((task) => task.id)).toEqual(['a', 'z']);
  });
});
