import { describe, expect, it } from 'vitest';
import {
  decodeTaskNavigation,
  encodeTaskNavigation,
  taskHasReview,
  taskNavigationTarget,
} from '../src/web/task-navigation.js';

const task = { id: 'task/with spaces', workspaceId: 'workspace-1', state: 'completed' } as const;

describe('task-scoped navigation', () => {
  it('round-trips task IDs safely through a local fragment', () => {
    const link = encodeTaskNavigation({ taskId: task.id, destination: 'review' });
    expect(link).toBe('#task/task%2Fwith%20spaces/review');
    expect(decodeTaskNavigation(link)).toEqual({ taskId: task.id, destination: 'review' });
  });

  it('never navigates to review before the isolated task is reviewable', () => {
    expect(taskHasReview({ workspaceId: 'workspace-1', state: 'running' })).toBe(false);
    expect(taskHasReview({ workspaceId: 'workspace-1', state: 'queued' })).toBe(false);
    expect(taskHasReview({ workspaceId: undefined, state: 'completed' })).toBe(false);
    expect(taskNavigationTarget({ ...task, state: 'running' }, 'review')).toBeNull();
    expect(taskNavigationTarget(task, 'review')).toEqual({ taskId: task.id, destination: 'review' });
  });

  it('does not treat a fragment as an authorization to start or mutate a task', () => {
    expect(taskNavigationTarget(task, 'session')).toEqual({ taskId: task.id, destination: 'session' });
    expect(taskNavigationTarget(task, 'workflow')).toEqual({ taskId: task.id, destination: 'workflow' });
    expect(taskNavigationTarget(undefined, 'session')).toBeNull();
  });

  it('rejects malformed, unsupported and oversized fragments', () => {
    expect(decodeTaskNavigation('#task/id/delete')).toBeNull();
    expect(decodeTaskNavigation('#task/%ZZ/session')).toBeNull();
    expect(decodeTaskNavigation('#task//review')).toBeNull();
    expect(decodeTaskNavigation('#task/' + 'x'.repeat(257) + '/session')).toBeNull();
    expect(decodeTaskNavigation('#task/id/session/extra')).toBeNull();
    expect(decodeTaskNavigation('#task/%0A/session')).toBeNull();
    expect(decodeTaskNavigation('#overview')).toBeNull();
  });
});
