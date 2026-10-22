import { describe, expect, it } from 'vitest';
import { selectOfficeSeats } from '../src/web/office-layout.js';
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

  it('does not invent seats or agents', () => {
    expect(selectOfficeSeats(agents, 'profile-3' as AgentId, 0)).toEqual([]);
    expect(selectOfficeSeats([], 'profile-3' as AgentId)).toEqual([]);
    expect(selectOfficeSeats(agents, 'profile-3' as AgentId, 1).map((a) => a.id))
      .toEqual(['profile-3']);
  });
});
