import type { AgentId } from '../shared/types.js';

export interface WorkstationPlacement {
  agentId: AgentId;
  identity: 'fern' | 'sage';
  landscape: { x: number; y: number };
  portrait: { x: number; y: number };
}

/** Placement only: rendering never creates an agent absent from the runtime. */
export const OFFICE_LAYOUT: readonly WorkstationPlacement[] = [
  { agentId: 'codex-1', identity: 'fern', landscape: { x: 235, y: 245 }, portrait: { x: 135, y: 260 } },
  {
    agentId: 'codex-2',
    identity: 'sage',
    landscape: { x: 605, y: 245 },
    portrait: { x: 280, y: 405 },
  },
];

export function officeGeometry(portrait: boolean) {
  return portrait ? { width: 420, height: 580, wall: 159 } : { width: 840, height: 440, wall: 191 };
}

/** Always display the inspected agent before filling spare seats with active workers.
 * Does not invent agents or alter execution/queue priority. */
export function selectOfficeSeats<T extends {
  id: AgentId;
  active?: boolean;
  status: { state: string };
}>(agents: readonly T[], selectedAgent: AgentId, capacity = OFFICE_LAYOUT.length): T[] {
  const visible = agents.slice(0, Math.max(0, capacity));
  const selected = agents.find((agent) => agent.id === selectedAgent);
  if (!selected || visible.some((agent) => agent.id === selectedAgent)) return visible;
  // Keep existing workstation identity/keyboard order stable whenever possible.
  // Only replace a seat when the selected profile is otherwise hidden.
  const replaceIndex = visible.findLastIndex((agent) =>
    !agent.active && !['thinking', 'working', 'stopping'].includes(agent.status.state),
  );
  const slot = replaceIndex === -1 ? visible.length - 1 : replaceIndex;
  if (slot >= 0) visible[slot] = selected;
  return visible;
}
