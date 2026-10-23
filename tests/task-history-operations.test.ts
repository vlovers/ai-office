import { describe, expect, it } from 'vitest';
import type { AgentId } from '../src/shared/types.js';
import {
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

  it('uses stable task ids for timestamp ties', () => {
    const tied = [
      { ...tasks[0]!, id: 'z' },
      { ...tasks[0]!, id: 'a' },
    ];
    expect(selectTaskHistory(tied, options).map((task) => task.id)).toEqual(['a', 'z']);
  });
});
