import { describe, expect, it } from 'vitest';
import { destinationForSection, destinationFromHash, destinationHash, destinations } from '../src/web/destinations.js';

describe('workspace navigation', () => {
  it.each(destinations)('round-trips the %s destination', (destination) => {
    expect(destinationFromHash(destinationHash(destination))).toBe(destination);
  });

  it('keeps task deep links on Tasks', () => {
    expect(destinationFromHash('#task/example/session')).toBe('tasks');
    expect(destinationFromHash('#task/example/review')).toBe('tasks');
    expect(destinationFromHash('#task/example/workflow')).toBe('tasks');
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
