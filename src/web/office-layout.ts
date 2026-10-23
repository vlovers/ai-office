import type { AgentId } from '../shared/types.js';

/** Physical profile desks. Worker execution capacity remains server-owned (two). */
export const STUDIO_DESKS = [
  { x: 150, y: 170 },
  { x: 340, y: 170 },
  { x: 180, y: 330 },
  { x: 365, y: 330 },
] as const;

/** Preserve stable workstation order, replacing the last visible slot for inspection.
 * This is a read-only viewport: it never schedules or fabricates execution. */
export function selectOfficeSeats<
  T extends {
    id: AgentId;
    active?: boolean;
    status: { state: string };
  },
>(agents: readonly T[], selectedAgent: AgentId, capacity: number = STUDIO_DESKS.length): T[] {
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
  const displaced = visible[visible.length - 1]!;
  visible[visible.length - 1] = unique[selectedIndex]!;
  // If selection evicts an active worker, retain them instead of an idle
  // occupant, without changing the order of the surviving workstations.
  const isActive = (agent: T) =>
    agent.active === true ||
    ['preparing', 'thinking', 'working', 'reviewing', 'stopping'].includes(agent.status.state);
  if (isActive(displaced)) {
    const idleIndex = visible.findIndex((agent) => agent.id !== selectedAgent && !isActive(agent));
    if (idleIndex >= 0) visible[idleIndex] = displaced;
  }
  return visible;
}
