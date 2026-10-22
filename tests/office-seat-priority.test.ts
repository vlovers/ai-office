import { describe, expect, it } from 'vitest';
import { officeGeometry, selectOfficeSeats } from '../src/web/office-layout.js';
import type { AgentId } from '../src/shared/types.js';

const agent = (id: string, state = 'idle', active = false) => ({
  id: id as AgentId,
  status: { state },
  active,
});

describe('office seat priority', () => {
  const agents = [
    agent('codex-1', 'idle'),
    agent('codex-2', 'working', true),
    agent('profile-3', 'idle'),
    agent('profile-4', 'thinking', true),
  ];

  it('keeps selected profile and an active worker visible', () => {
    expect(selectOfficeSeats(agents, 'profile-3' as AgentId).map((a) => a.id))
      .toEqual(['profile-3', 'codex-2']);
  });

  it('prioritizes active workers when selected profile is unavailable', () => {
    expect(selectOfficeSeats(agents, 'missing' as AgentId).map((a) => a.id))
      .toEqual(['codex-2', 'profile-4']);
  });

  it('never renders duplicate workstations for a duplicated runtime profile', () => {
    const duplicate = [agent('codex-1'), agent('codex-1'), agent('codex-2', 'working')];
    expect(selectOfficeSeats(duplicate, 'codex-1' as AgentId).map((a) => a.id))
      .toEqual(['codex-1', 'codex-2']);
  });

  it('treats invalid capacities as empty rather than throwing', () => {
    expect(selectOfficeSeats(agents, 'codex-1' as AgentId, Number.NaN)).toEqual([]);
    expect(selectOfficeSeats(agents, 'codex-1' as AgentId, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(selectOfficeSeats(agents, 'codex-1' as AgentId, -2)).toEqual([]);
  });

  it('does not invent seats or agents', () => {
    expect(selectOfficeSeats(agents, 'profile-3' as AgentId, 0)).toEqual([]);
    expect(selectOfficeSeats([], 'profile-3' as AgentId)).toEqual([]);
    expect(selectOfficeSeats(agents, 'profile-3' as AgentId, 1).map((a) => a.id))
      .toEqual(['profile-3']);
  });
});

describe('office responsive geometry', () => {
  it('provides a consistent portrait viewport for narrow containers', () => {
    expect(officeGeometry(true)).toEqual({ width: 420, height: 580, wall: 159 });
  });

  it('provides a consistent landscape viewport for wider containers', () => {
    expect(officeGeometry(false)).toEqual({ width: 840, height: 440, wall: 191 });
  });

  it('keeps running profiles in the room even if idle profiles come first', () => {
    const profiles = [
      agent('idle-1'),
      agent('idle-2'),
      agent('running-1', 'working'),
      agent('running-2', 'stopping'),
    ];
    expect(selectOfficeSeats(profiles, 'unknown' as AgentId).map((a) => a.id))
      .toEqual(['running-1', 'running-2']);
  });
});
