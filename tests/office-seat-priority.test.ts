import { describe, expect, it } from 'vitest';
import { STUDIO_DESKS, selectOfficeSeats } from '../src/web/office-layout.js';
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

  it('keeps selected profile and displaced active worker visible', () => {
    expect(selectOfficeSeats(agents, 'profile-3' as AgentId, 2).map((a) => a.id)).toEqual([
      'codex-2',
      'profile-3',
    ]);
  });

  it('preserves default seat order when selected profile is unavailable', () => {
    expect(selectOfficeSeats(agents, 'missing' as AgentId, 2).map((a) => a.id)).toEqual([
      'codex-1',
      'codex-2',
    ]);
  });

  it('never renders duplicate workstations for a duplicated runtime profile', () => {
    const duplicate = [agent('codex-1'), agent('codex-1'), agent('codex-2', 'working')];
    expect(selectOfficeSeats(duplicate, 'codex-1' as AgentId).map((a) => a.id)).toEqual([
      'codex-1',
      'codex-2',
    ]);
  });

  it('treats invalid capacities as empty rather than throwing', () => {
    expect(selectOfficeSeats(agents, 'codex-1' as AgentId, Number.NaN)).toEqual([]);
    expect(selectOfficeSeats(agents, 'codex-1' as AgentId, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(selectOfficeSeats(agents, 'codex-1' as AgentId, -2)).toEqual([]);
  });

  it('does not invent seats or agents', () => {
    expect(selectOfficeSeats(agents, 'profile-3' as AgentId, 0)).toEqual([]);
    expect(selectOfficeSeats([], 'profile-3' as AgentId)).toEqual([]);
    expect(selectOfficeSeats(agents, 'profile-3' as AgentId, 1).map((a) => a.id)).toEqual([
      'profile-3',
    ]);
  });
});

describe('studio placement', () => {
  it('provides four distinct desks within the projected room', () => {
    expect(STUDIO_DESKS).toHaveLength(4);
    expect(new Set(STUDIO_DESKS.map((desk) => `${desk.x}:${desk.y}`)).size).toBe(4);
    expect(
      STUDIO_DESKS.every((desk) => desk.x > 0 && desk.y > 0 && desk.x < 500 && desk.y < 500),
    ).toBe(true);
  });
  it('does not reshuffle profiles when their execution state changes', () => {
    const profiles = [
      agent('one'),
      agent('two'),
      agent('three', 'reviewing'),
      agent('four', 'working'),
    ];
    expect(selectOfficeSeats(profiles, 'unknown').map((a) => a.id)).toEqual(
      profiles.map((a) => a.id),
    );
  });
});
