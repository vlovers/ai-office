import { describe, expect, it } from 'vitest';
import {
  destinations,
  destinationForSection,
  destinationFromHash,
  destinationHash,
  routeFromHash,
} from '../src/web/destinations.js';

describe('workspace destinations', () => {
  it('round-trips all five primary destinations', () => {
    for (const destination of destinations) {
      expect(destinationFromHash(destinationHash(destination))).toBe(destination);
    }
  });

  it('preserves legacy section and task deep links', () => {
    expect(destinationFromHash('#compose')).toBe('tasks');
    expect(destinationFromHash('#task-history')).toBe('tasks');
    expect(destinationFromHash('#task/example/session')).toBe('tasks');
    expect(destinationFromHash('#agent-studio')).toBe('agents');
    expect(destinationFromHash('#repositories')).toBe('settings');
    expect(destinationForSection('workflows')).toBe('workflows');
    expect(destinationForSection('overview')).toBe('office');
    expect(destinationForSection('code-review-center')).toBe('tasks');
  });

  it('restores focus only for a valid task-scoped fragment', () => {
    expect(routeFromHash('#task/example/session')).toEqual({
      page: 'tasks',
      taskPanel: 'details',
      view: 'focus',
    });
    expect(routeFromHash('#task/%ZZ/session')).toEqual({
      page: 'tasks',
      taskPanel: 'details',
      view: 'mission',
    });
    expect(routeFromHash('#compose')).toEqual({
      page: 'tasks',
      taskPanel: 'new',
      view: 'mission',
    });
    expect(routeFromHash('#settings')).toEqual({
      page: 'settings',
      taskPanel: 'details',
      view: 'mission',
    });
  });
});
