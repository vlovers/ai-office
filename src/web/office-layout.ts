import type { AgentId } from '../shared/types.js';

export interface WorkstationPlacement {
  agentId: AgentId;
  identity: 'fern' | 'sage';
  landscape: { x: number; y: number };
  portrait: { x: number; y: number };
}

/** Placement only: rendering never creates an agent absent from the runtime. */
export const OFFICE_LAYOUT: readonly WorkstationPlacement[] = [
  {
    agentId: 'codex-1',
    identity: 'fern',
    landscape: { x: 235, y: 245 },
    portrait: { x: 135, y: 260 },
  },
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
export function selectOfficeSeats<
  T extends {
    id: AgentId;
    active?: boolean;
    status: { state: string };
  },
>(agents: readonly T[], selectedAgent: AgentId, capacity = OFFICE_LAYOUT.length): T[] {
  const limit = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
  if (limit === 0) return [];
  // Preserve runtime order. The selected profile replaces the last visible
  // unselected profile when necessary; it never changes desk identity/order.
  const unique: T[] = [];
  const seen = new Set<AgentId>();
  for (const agent of agents) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    unique.push(agent);
  }
  const selectedIndex = unique.findIndex((agent) => agent.id === selectedAgent);
  const visible = unique.slice(0, limit);
  if (selectedIndex < 0 || selectedIndex < limit) return visible;
  visible[visible.length - 1] = unique[selectedIndex]!;
  return visible;
}
