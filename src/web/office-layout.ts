import type { AgentId } from '../shared/types.js';

export interface WorkstationPlacement {
  agentId: AgentId;
  identity: 'fern' | 'sage';
  landscape: { x: number; y: number };
  portrait: { x: number; y: number };
}

/** Placement only: rendering never creates an agent absent from the runtime. */
export const OFFICE_LAYOUT: readonly WorkstationPlacement[] = [
  { agentId: 'codex-1', identity: 'fern', landscape: { x: 46, y: 80 }, portrait: { x: 34, y: 98 } },
  {
    agentId: 'codex-2',
    identity: 'sage',
    landscape: { x: 441, y: 80 },
    portrait: { x: 34, y: 278 },
  },
];

export function officeGeometry(portrait: boolean) {
  return portrait ? { width: 420, height: 465, wall: 159 } : { width: 840, height: 280, wall: 191 };
}
