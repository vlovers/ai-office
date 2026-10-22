import { useEffect, useId, useRef, useState } from 'react';
import type { AgentId } from '../shared/types.js';
import { OFFICE_LAYOUT, officeGeometry, selectOfficeSeats } from './office-layout.js';
import type { SceneStatus } from './scene-state.js';
import type { SceneState } from './scene-state.js';

/** Original local SVG sprites; no remote assets or simulated telemetry. */
export function PixelBot() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M10 2h4v3h4v3h3v12h-4v2H7v-2H3V8h3V5h4z" />
      <path fill="#07231a" d="M8 8h8v2h3v8h-5v-3h-4v3H5v-8h3z" />
      <path d="M8 10h2v3H8zm6 0h2v3h-2zm-4 8h4v2h-4z" />
    </svg>
  );
}

export interface OfficeAgent {
  id: AgentId;
  name: string;
  role?: string;
  taskTitle?: string;
  status: SceneStatus;
  access?: string;
  active?: boolean;
}

/** Isometric desk furniture; animation is driven by actual agent status classes. */
function IsometricDesk({ state }: { state: SceneState }) {
  const message = state === 'thinking' ? 'THINK' : state === 'working' ? 'RUN' : state === 'stopping' ? 'STOP' : state === 'error' ? 'ERROR' : state === 'offline' ? 'OFFLINE' : state === 'completed' ? 'DONE' : 'READY';
  return (
    <g aria-hidden="true">
      <ellipse cx="0" cy="66" rx="112" ry="35" fill="#020b0a" opacity=".55" />
      <path d="M-95 18L-12 -28L100 25L16 73Z" fill="#a27650" stroke="#d7b287" strokeWidth="3" />
      <path d="M-95 18L16 73V87L-95 32Z" fill="#593e32" />
      <path d="M16 73L100 25V39L16 87Z" fill="#80533c" />
      <path d="M-70 36V90M74 45V95" stroke="#4e3a30" strokeWidth="9" />
      <path d="M-28 5L16 -18L61 4L17 29Z" fill="#152d34" stroke="#4f8f85" strokeWidth="3" />
      <path d="M-28 5V-47L16 -70L61 -46V4L17 29V-23Z" fill="#203d40" stroke="#80b5a0" strokeWidth="3" />
      <path className="iso-monitor-glow" d="M-20 -42L16 -60L53 -41V-2L17 18L-20 -2Z" fill="#103a31" />
      <path d="M-10 -26L13 -38M-10 -15L27 -34M-10 -4L17 -18" stroke="#77eab0" strokeWidth="3" />
      <path d="M16 29V40M-8 52L16 40L39 51" stroke="#4f6f64" strokeWidth="5" />
      <path d="M-60 11L-35 -2L-13 9L-37 22Z" fill="#304b47" />
      <path d="M-52 10L-40 4M-44 14L-32 8" stroke="#80c2a1" strokeWidth="2" />
      <g className="iso-character" transform="translate(-43 -34)">
        <path d="M-23 24L0 11L24 24L0 38Z" fill="#29463e" />
        <path className="character-body" d="M-20 -7L0 -20L20 -7V22L0 35L-20 22Z" fill="#4d8e75" stroke="#18382d" strokeWidth="3" />
        <path d="M-16 -37L0 -47L17 -37V-12L0 -2L-16 -12Z" fill="#e6ad82" />
        <path d="M-18 -39L0 -50L18 -40L0 -29Z" fill="#3b2928" />
        <path d="M-8 -23L-4 -25M5 -30L9 -32" stroke="#1e302b" strokeWidth="3" />
        <path className="typing-hands" d="M8 10L29 21M-8 14L11 26" stroke="#e6ad82" strokeWidth="8" strokeLinecap="round" />
      </g>
      <g transform="translate(67 -23)">
        <path d="M-18 0L0 -10L19 0L0 11Z" fill="#1a382c" stroke="#72ad81" strokeWidth="2" />
        <path d="M0 0V-29M0 -15L-13 -25M0 -20L14 -31" stroke="#79b78d" strokeWidth="4" />
      </g>
      <g transform="translate(0 -91)">
        <path d="M-39 -15H39V9H7L0 17L-7 9H-39Z" fill="#0b201b" stroke={state === 'error' ? '#ffa99b' : '#8acda6'} strokeWidth="2" />
        <text x="0" y="1" textAnchor="middle" fill={state === 'error' ? '#ffa99b' : '#a5edc2'} fontFamily="monospace" fontSize="11">{message}</text>
      </g>
    </g>
  );
}

/** One room; scene placement and visual identity are independent of runtime state. */
export function PixelOffice({
  agents,
  selectedAgent,
  onSelect,
}: {
  agents: OfficeAgent[];
  selectedAgent: AgentId;
  onSelect: (id: AgentId) => void;
}) {
  const prefix = useId();
  const container = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 560);
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const geometry = officeGeometry(narrow);
  const activeCount = agents.filter((agent) => ['thinking', 'working', 'stopping'].includes(agent.status.state)).length;
  const errorCount = agents.filter((agent) => agent.status.state === 'error').length;
  // Keep the selected profile visible, then fill remaining seats with running agents.
  // The roster below remains the complete, untruncated list.
  const seatedAgents = selectOfficeSeats(agents, selectedAgent, OFFICE_LAYOUT.length);
  return (
    <div ref={container} className="shared-office isometric-office" data-layout={narrow ? 'portrait' : 'landscape'}>
      <svg className="pixel-office" viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="group" aria-label="Interactive isometric office, showing real agent status">
        <defs>
          <linearGradient id={`${prefix}-wall`} x2="0" y2="1">
            <stop stopColor="#183a39" /><stop offset="1" stopColor="#0c1f20" />
          </linearGradient>
          <pattern id={`${prefix}-tiles`} width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M0 0H40V40H0Z" fill="#203b37" stroke="#34544c" strokeWidth="1" />
          </pattern>
        </defs>
        <g aria-hidden="true">
          <path d={`M0 0H${geometry.width}V${geometry.height}H0Z`} fill="#081714" />
          <path d={narrow ? 'M12 80L210 10L408 80V280L210 360L12 280Z' : 'M40 118L420 8L800 118V270L420 390L40 270Z'} fill={`url(#${prefix}-wall)`} stroke="#477468" strokeWidth="3" />
          <path d={narrow ? 'M12 280L210 360L408 280L210 204Z' : 'M40 270L420 390L800 270L420 150Z'} fill={`url(#${prefix}-tiles)`} stroke="#6c9a83" strokeWidth="3" />
          <path d={narrow ? 'M12 80L210 10L210 204L12 280Z' : 'M40 118L420 8V150L40 270Z'} fill="#14312d" opacity=".65" />
          <path d={narrow ? 'M210 10L408 80V280L210 204Z' : 'M420 8L800 118V270L420 150Z'} fill="#20433c" opacity=".65" />
          <path d={narrow ? 'M54 115L150 78V161L54 198Z' : 'M124 108L277 62V155L124 201Z'} fill="#0b2628" stroke="#6bafaa" strokeWidth="5" />
          <path d={narrow ? 'M65 120L139 92V155L65 183Z' : 'M137 116L264 78V149L137 186Z'} fill="#23505b" />
          <path d={narrow ? 'M256 82L354 116V199L256 165Z' : 'M570 61L716 105V198L570 154Z'} fill="#0b2628" stroke="#6bafaa" strokeWidth="5" />
          <path d={narrow ? 'M266 98L344 125V182L266 155Z' : 'M582 78L704 115V181L582 144Z'} fill="#28545d" />
          <text x={geometry.width / 2} y={narrow ? 62 : 43} textAnchor="middle" fontSize="19" fontFamily="monospace" fontWeight="bold" fill="#b3ffca">AI OFFICE</text>
        </g>
        {OFFICE_LAYOUT.map((placement, index) => {
          const agent = seatedAgents[index];
          if (!agent) return null;
          const point = narrow ? placement.portrait : placement.landscape;
          const selected = selectedAgent === agent.id;
          return (
            <g key={agent.id} className={`office-workstation iso-station state-${agent.status.state} identity-${placement.identity}`} data-agent-id={agent.id} data-state={agent.status.state} role="button" tabIndex={0} aria-label={`Select ${agent.name} workstation`} aria-pressed={selected} aria-describedby={`${prefix}-${agent.id}-status`} transform={`translate(${point.x} ${point.y})`} onClick={() => onSelect(agent.id)} onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) onSelect(agent.id); }
              const buttons = Array.from(event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('.office-workstation') ?? []);
              const position = buttons.indexOf(event.currentTarget);
              const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (position + 1) % buttons.length : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (position + buttons.length - 1) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
              if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
            }}>
              <ellipse className="iso-selection" cx="0" cy="50" rx="115" ry="51" fill="none" stroke="#a5ffbb" strokeWidth="3" strokeDasharray="9 6" opacity={selected ? 1 : 0} />
              <IsometricDesk state={agent.status.state} />
              <text className="station-name" x="0" y="108" textAnchor="middle" fontSize="12" fontFamily="monospace" fontWeight="bold">{agent.name.length > 22 ? `${agent.name.slice(0, 21)}…` : agent.name}</text>
              <rect x="-115" y="-118" width="230" height="233" fill="transparent" className="station-hit-area" />
            </g>
          );
        })}
      </svg>
      <section className="office-workflow" aria-label="Agent workflow overview">
        <div className="office-workflow-header">
          <strong>Agent workflow</strong>
          <span>Live profile activity · not an automatic pipeline</span>
        </div>
        <div className="office-workflow-lanes">
          {(['coder', 'reviewer', 'qa'] as const).map((role) => {
            const matching = agents.filter((agent) => agent.role?.toLowerCase().includes(role));
            const active = matching.filter((agent) => agent.active || ['thinking', 'working', 'stopping'].includes(agent.status.state));
            return (
              <div className="office-workflow-lane" key={role} data-role={role}>
                <span className="office-workflow-step">{role === 'coder' ? '01' : role === 'reviewer' ? '02' : '03'}</span>
                <strong>{role === 'qa' ? 'QA' : role === 'coder' ? 'Coder' : 'Reviewer'}</strong>
                <span className="office-workflow-count">{matching.length === 0 ? 'No profile' : `${active.length} active / ${matching.length} profiles`}</span>
                {matching.length > 0 && <div className="office-workflow-members">{matching.map((agent) => (
                  <button key={agent.id} type="button" onClick={() => onSelect(agent.id)} aria-pressed={selectedAgent === agent.id} title={agent.status.label}>
                    <span className={`office-workflow-dot state-${agent.status.state}`} aria-hidden="true" />
                    {agent.name}
                  </button>
                ))}</div>}
              </div>
            );
          })}
        </div>
      </section>
      <div className="office-operations" aria-label="Live office operations">
        <div className="office-operations-heading"><strong>Office activity</strong><span aria-live="polite">{activeCount} active · {errorCount} errors</span></div>
        <p className="office-operations-help">Select a desk or an agent below to inspect their actual task and session. Status comes from the local server, not the animation.</p>
        {agents.length === 0 && <p className="office-operations-empty">No agent profiles available. Create a profile in Agent Studio to populate the office.</p>}
        <div className="office-operations-agents">{agents.map((agent) => (
          <button type="button" key={agent.id} className={`office-operations-agent state-${agent.status.state}`} aria-pressed={selectedAgent === agent.id} onClick={() => onSelect(agent.id)} title={`Inspect ${agent.name}: ${agent.status.label}`}>
            <span className="office-operations-indicator" aria-hidden="true" /><span className="office-operations-identity"><strong>{agent.name}</strong><small>{agent.role ? `${agent.role} · ` : ''}{agent.status.label}</small>{agent.taskTitle && <small className="office-operations-task" title={agent.taskTitle}>Task: {agent.taskTitle}</small>}</span><span className="office-operations-access">{agent.access ?? 'Read only'}</span>
          </button>
        ))}</div>
      </div>
      {agents.map((agent) => <span key={agent.id} id={`${prefix}-${agent.id}-status`} className="sr-only">{agent.status.label}. {agent.access ?? 'Read only'}.</span>)}
    </div>
  );
}
