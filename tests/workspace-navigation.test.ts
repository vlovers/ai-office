import { describe, expect, it } from 'vitest';
import { decodeTaskNavigation, encodeTaskNavigation, taskHasReview, taskNavigationTarget } from '../src/web/task-navigation.js';
import { destinationForSection, destinationFromHash, destinationHash, destinations } from '../src/web/destinations.js';

describe('workspace navigation', () => {
  it.each(destinations)('round-trips the %s destination', (destination) => {
    expect(destinationFromHash(destinationHash(destination))).toBe(destination);
  });

  it('keeps task deep links on Tasks', () => {
    expect(destinationFromHash('#task/example/session')).toBe('tasks');
    expect(destinationFromHash('#task/example/review')).toBe('tasks');
    expect(destinationFromHash('#task/example/workflow')).toBe('tasks');
    expect(destinationFromHash('#compose')).toBe('tasks');
    expect(destinationFromHash('#task-history')).toBe('tasks');
    expect(destinationFromHash('#agent-studio')).toBe('agents');
    expect(destinationFromHash('#repositories')).toBe('settings');
  });

  it('accepts legacy and slash-prefixed destination links', () => {
    expect(destinationFromHash('#/tasks')).toBe('tasks');
    expect(destinationFromHash('#/settings')).toBe('settings');
    expect(destinationFromHash('#agent')).toBe('agents');
    expect(destinationFromHash('#connection')).toBe('settings');
    expect(destinationFromHash('#code-review-center')).toBe('tasks');
  });

  it('preserves task IDs through URL encoding and rejects malformed links', () => {
    const original = { taskId: 'review / issue #42', destination: 'workflow' as const };
    const hash = encodeTaskNavigation(original);
    expect(destinationFromHash(hash)).toBe('tasks');
    expect(decodeTaskNavigation(hash)).toEqual(original);
    expect(decodeTaskNavigation('#task/%ZZ/review')).toBeNull();
    expect(decodeTaskNavigation('#task/example/invalid')).toBeNull();
    expect(decodeTaskNavigation('#task/%00/review')).toBeNull();
    expect(decodeTaskNavigation('#task/' + 'a'.repeat(257) + '/session')).toBeNull();
  });

  it('only exposes code review after a writable workspace finishes', () => {
    const task = { id: 't1', workspaceId: 'w1', state: 'running' as const };
    expect(taskHasReview(task)).toBe(false);
    expect(taskNavigationTarget(task, 'review')).toBeNull();
    expect(taskNavigationTarget(task, 'workflow')).toEqual({
      taskId: 't1',
      destination: 'workflow',
    });
    expect(taskHasReview({ ...task, state: 'completed' })).toBe(true);
    expect(taskNavigationTarget({ ...task, state: 'completed' }, 'review')).toEqual({
      taskId: 't1',
      destination: 'review',
    });
    expect(taskNavigationTarget(undefined, 'session')).toBeNull();
  });

  it('falls back safely for unknown and empty fragments', () => {
    expect(destinationFromHash('')).toBe('office');
    expect(destinationFromHash('#not-a-page')).toBe('office');
  });

  it('routes contextual actions to the right destination', () => {
    expect(destinationForSection('compose')).toBe('tasks');
    expect(destinationForSection('task-workflow')).toBe('tasks');
    expect(destinationForSection('workflows')).toBe('workflows');
    expect(destinationForSection('agent-studio')).toBe('agents');
    expect(destinationForSection('repositories')).toBe('settings');
  });
});
