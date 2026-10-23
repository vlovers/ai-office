import { useEffect, useId, useRef, useState } from 'react';
import type { AgentId } from '../shared/types.js';
import { OFFICE_LAYOUT, officeGeometry, selectOfficeSeats } from './office-layout.js';
import { selectOfficeHistory } from './office-history.js';
import type { OfficeHistoryFilter } from './office-history.js';
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
  taskId?: string;
  taskState?: string;
  status: SceneStatus;
  access?: string;
  active?: boolean;
}

export interface OfficeRecentTask {
  id: string;
  agentId: AgentId;
  title: string;
  state: string;
  updatedAt: string;
}

export interface OfficeQueueItem {
  taskId: string;
  agentId: AgentId;
  title: string;
  order: number;
  waitingReason?: string;
}

/** Isometric desk furniture; animation is driven by actual agent status classes. */
function IsometricDesk({ state, identity }: { state: SceneState; identity: 'fern' | 'sage' }) {
  const message =
    state === 'thinking'
      ? 'THINK'
      : state === 'working'
        ? 'RUN'
        : state === 'stopping'
          ? 'STOP'
          : state === 'error'
            ? 'ERROR'
            : state === 'offline'
              ? 'OFFLINE'
              : state === 'completed'
                ? 'DONE'
                : 'READY';
  return (
    <g aria-hidden="true">
      <ellipse cx="0" cy="66" rx="112" ry="35" fill="#020b0a" opacity=".55" />
      <path d="M-95 18L-12 -28L100 25L16 73Z" fill="#a27650" stroke="#d7b287" strokeWidth="3" />
      <path d="M-95 18L16 73V87L-95 32Z" fill="#593e32" />
      <path d="M16 73L100 25V39L16 87Z" fill="#80533c" />
      <path d="M-70 36V90M74 45V95" stroke="#4e3a30" strokeWidth="9" />
      <path d="M-28 5L16 -18L61 4L17 29Z" fill="#152d34" stroke="#4f8f85" strokeWidth="3" />
      <path
        d="M-28 5V-47L16 -70L61 -46V4L17 29V-23Z"
        fill="#203d40"
        stroke="#80b5a0"
        strokeWidth="3"
      />
      <path
        className="iso-monitor-glow"
        d="M-20 -42L16 -60L53 -41V-2L17 18L-20 -2Z"
        fill="#103a31"
      />
      <path d="M-10 -26L13 -38M-10 -15L27 -34M-10 -4L17 -18" stroke="#77eab0" strokeWidth="3" />
      <path d="M16 29V40M-8 52L16 40L39 51" stroke="#4f6f64" strokeWidth="5" />
      <path d="M-60 11L-35 -2L-13 9L-37 22Z" fill="#304b47" />
      <path d="M-52 10L-40 4M-44 14L-32 8" stroke="#80c2a1" strokeWidth="2" />
      <g className="iso-character" transform="translate(-43 -34)">
        <path d="M-23 24L0 11L24 24L0 38Z" fill="#29463e" />
        <path
          className="character-body"
          d="M-20 -7L0 -20L20 -7V22L0 35L-20 22Z"
          fill={identity === 'fern' ? '#c47e59' : '#668db5'}
          stroke={identity === 'fern' ? '#6b4637' : '#354e70'}
          strokeWidth="3"
        />
        <path d="M-16 -37L0 -47L17 -37V-12L0 -2L-16 -12Z" fill="#e6ad82" />
        <path d="M-18 -39L0 -50L18 -40L0 -29Z" fill={identity === 'fern' ? '#513c30' : '#c5a36e'} />
        <path d="M-8 -23L-4 -25M5 -30L9 -32" stroke="#1e302b" strokeWidth="3" />
        <path
          className="typing-hands"
          d="M8 10L29 21M-8 14L11 26"
          stroke="#e6ad82"
          strokeWidth="8"
          strokeLinecap="round"
        />
      </g>
      <g transform="translate(67 -23)">
        <path d="M-18 0L0 -10L19 0L0 11Z" fill="#1a382c" stroke="#72ad81" strokeWidth="2" />
        <path d="M0 0V-29M0 -15L-13 -25M0 -20L14 -31" stroke="#79b78d" strokeWidth="4" />
      </g>
      <g transform="translate(0 -91)">
        <path
          d="M-39 -15H39V9H7L0 17L-7 9H-39Z"
          fill="#0b201b"
          stroke={state === 'error' ? '#ffa99b' : '#8acda6'}
          strokeWidth="2"
        />
        <text
          x="0"
          y="1"
          textAnchor="middle"
          fill={state === 'error' ? '#ffa99b' : '#a5edc2'}
          fontFamily="monospace"
          fontSize="11"
        >
          {message}
        </text>
      </g>
    </g>
  );
}

/** Static room dressing. Decorative only: no invented agent activity or telemetry. */
function RoomDetails({ portrait }: { portrait: boolean }) {
  return (
    <g aria-hidden="true" className="office-room-details" pointerEvents="none">
      <g transform={portrait ? 'translate(76 183) scale(.64)' : 'translate(102 224) scale(.9)'}>
        <path d="M-24 1L0 -12L24 1L0 15Z" fill="#79523b" stroke="#a67b50" strokeWidth="2" />
        <path d="M-24 1V17L0 31V15Z" fill="#4a332a" />
        <path d="M0 15L24 1V17L0 31Z" fill="#654633" />
        <path
          d="M-16 -3V-51M-16 -43L-29 -54M-16 -35L0 -49"
          stroke="#618b60"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path d="M-16 -49L-39 -62L-35 -33Z" fill="#438064" />
        <path d="M-15 -39L9 -64L9 -33Z" fill="#68a47b" />
        <path d="M-20 -29L-43 -37L-27 -15Z" fill="#397557" />
      </g>
      <g transform={portrait ? 'translate(345 260) scale(.68)' : 'translate(730 233) scale(.9)'}>
        <path d="M-42 8L0 -14L42 8L0 30Z" fill="#7b5944" stroke="#b28a60" strokeWidth="3" />
        <path d="M-42 8V48L0 70V30Z" fill="#4c372d" />
        <path d="M0 30L42 8V48L0 70Z" fill="#664735" />
        <path d="M-27 4L0 -10L27 4L0 18Z" fill="#253e39" />
        <path d="M-21 2L0 -8L21 2L0 12Z" fill="#c7e6c9" />
        <path d="M-14 2L0 -5L14 2L0 9Z" fill="#416d63" />
        <path d="M-22 26L-5 34M-22 36L-5 44M7 38L25 28" stroke="#a28b67" strokeWidth="3" />
      </g>
      <g transform={portrait ? 'translate(210 110) scale(.75)' : 'translate(420 89)'}>
        <path d="M-45 -25H45V25H-45Z" fill="#0b2524" stroke="#6da58c" strokeWidth="3" />
        <path d="M-31 8L-12 -3L3 7L28 -10" fill="none" stroke="#b5e2bd" strokeWidth="3" />
        <circle cx="-31" cy="8" r="4" fill="#9addae" />
        <circle cx="28" cy="-10" r="4" fill="#9addae" />
        <path d="M-32 16H29" stroke="#3b6658" strokeWidth="2" />
      </g>
      <g transform={portrait ? 'translate(42 240) scale(.55)' : 'translate(145 75) scale(.85)'}>
        <path d="M0 0L48 -16L96 0L48 16Z" fill="#bd916a" />
        <path d="M0 0V45L48 61V16Z" fill="#725a4a" />
        <path d="M48 16L96 0V45L48 61Z" fill="#8e6a50" />
        <path
          d="M15 14L34 20M15 27L34 33M60 19L81 12M60 33L81 26"
          stroke="#e2bb89"
          strokeWidth="4"
        />
        <circle cx="48" cy="-33" r="18" fill="#eac28e" opacity=".8" />
        <path d="M48 -16V-5" stroke="#eac28e" strokeWidth="5" />
      </g>
      <g transform={portrait ? 'translate(359 203) scale(.6)' : 'translate(686 80) scale(.85)'}>
        <path d="M-37 0L0 -18L37 0L0 19Z" fill="#d5b38a" />
        <path d="M-37 0V36L0 55V19Z" fill="#876c5d" />
        <path d="M0 19L37 0V36L0 55Z" fill="#a68168" />
        <path d="M-22 -5L0 -16L22 -5L0 7Z" fill="#3b6267" />
        <path d="M-22 -5V-36L0 -48L22 -36V-5L0 7V-25Z" fill="#2a424a" />
        <path d="M-16 -31L0 -39L16 -31V-10L0 -2L-16 -10Z" fill="#e0b977" />
      </g>
      <g transform={portrait ? 'translate(206 485)' : 'translate(422 332)'}>
        <path d="M-34 0L0 -17L34 0L0 17Z" fill="#466a56" opacity=".8" />
        <path d="M-17 -2L0 -11L17 -2L0 7Z" fill="#8ba57c" />
        <path d="M-13 -3L0 -9L13 -3L0 4Z" fill="#2e4c41" />
      </g>
    </g>
  );
}

/** One room; scene placement and visual identity are independent of runtime state. */
export function PixelOffice({
  agents,
  selectedAgent,
  onSelect,
  queue = [],
  recentTasks = [],
}: {
  agents: OfficeAgent[];
  selectedAgent: AgentId;
  onSelect: (id: AgentId) => void;
  queue?: OfficeQueueItem[];
  recentTasks?: OfficeRecentTask[];
}) {
  const prefix = useId();
  const container = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [floorFilter, setFloorFilter] = useState<'all' | 'active' | 'queued'>('all');
  const [showOperations, setShowOperations] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<OfficeHistoryFilter>('all');
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 560);
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const geometry = officeGeometry(narrow);
  const activeCount = agents.filter(
    (agent) => agent.active || ['thinking', 'working', 'stopping'].includes(agent.status.state),
  ).length;
  const errorCount = agents.filter((agent) => agent.status.state === 'error').length;
  const selectedProfile = agents.find((agent) => agent.id === selectedAgent);
  const selectedQueue = queue
    .filter((entry) => entry.agentId === selectedAgent)
    .sort((a, b) => a.order - b.order);
  const lifecycle = [
    'queued',
    'running',
    'stopping',
    'completed',
    'failed',
    'stopped',
    'interrupted',
  ] as const;
  // Keep stable physical seats; reveal the selected profile if it was offscreen.
  // The roster below remains the complete, untruncated list.
  const seatedAgents = selectOfficeSeats(agents, selectedAgent, OFFICE_LAYOUT.length);
  const seatedIds = new Set(seatedAgents.map((agent) => agent.id));
  const offscreenAgents = agents.filter((agent) => !seatedIds.has(agent.id));
  const offscreenActive = offscreenAgents.filter(
    (agent) => agent.active || ['thinking', 'working', 'stopping'].includes(agent.status.state),
  );
  const nextQueued = selectedQueue[0];
  const visibleFloorAgents = agents.filter((agent) => {
    if (floorFilter === 'queued') return queue.some((entry) => entry.agentId === agent.id);
    if (floorFilter === 'active')
      return agent.active || ['thinking', 'working', 'stopping'].includes(agent.status.state);
    return true;
  });
  const filteredHistory = selectOfficeHistory(
    recentTasks,
    selectedAgent,
    historyFilter,
    recentTasks.length,
  );
  const visibleHistory = filteredHistory.slice(0, showAllTasks ? 24 : 8);
  const workstationSummary = seatedAgents
    .map((agent) => `${agent.name}: ${agent.status.label}`)
    .join('; ');
  return (
    <div
      ref={container}
      className="shared-office isometric-office"
      data-layout={narrow ? 'portrait' : 'landscape'}
    >
      <div className="office-operations-heading" aria-label="Office presence summary">
        <strong>Live office · {agents.length} profiles</strong>
        <span aria-live="polite">
          {activeCount} running · {queue.length} queued · {errorCount} errors
        </span>
      </div>
      <div className="office-v3-activity" aria-label="Selected agent live status">
        <span
          className={`office-v3-presence state-${selectedProfile?.status.state ?? 'offline'}`}
          aria-hidden="true"
        />
        <div className="office-v3-activity-copy">
          <span className="office-v3-activity-kicker">Selected workstation</span>
          <strong>{selectedProfile?.name ?? 'Select an agent'}</strong>
          <span>
            {selectedProfile
              ? `${selectedProfile.status.label} · ${selectedProfile.role ?? 'Agent'}`
              : 'No agent selected'}
          </span>
          {selectedProfile?.taskTitle && (
            <span className="office-v3-activity-task" title={selectedProfile.taskTitle}>
              Current task: {selectedProfile.taskTitle}
            </span>
          )}
          {!selectedProfile?.taskTitle && nextQueued && (
            <span className="office-v3-activity-task" title={nextQueued.title}>
              Next queued: {nextQueued.title}
            </span>
          )}
        </div>
        <span className="office-v3-activity-access">
          {selectedProfile?.access ?? 'No access selected'}
        </span>
      </div>
      {offscreenAgents.length > 0 && (
        <div className="office-operations-help" role="status">
          {offscreenAgents.length} profiles outside the two-desk view
          {offscreenActive.length > 0 ? ` · ${offscreenActive.length} active` : ''}. Select any
          profile in the roster below to bring it into view.
        </div>
      )}
      <svg
        className="pixel-office"
        data-visible-seats={seatedAgents.length}
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        role="group"
        aria-label={`Interactive isometric office. ${workstationSummary || 'No occupied desks'}`}
      >
        <defs>
          <linearGradient id={`${prefix}-wall`} x2="0" y2="1">
            <stop stopColor="#54716c" />
            <stop offset="1" stopColor="#243a40" />
          </linearGradient>
          <pattern id={`${prefix}-tiles`} width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M0 0H40V40H0Z" fill="#374a4b" stroke="#526966" strokeWidth="1" />
          </pattern>
        </defs>
        <g aria-hidden="true">
          <path d={`M0 0H${geometry.width}V${geometry.height}H0Z`} fill="#17252d" />
          <path
            d={
              narrow
                ? 'M12 80L210 10L408 80V280L210 360L12 280Z'
                : 'M40 118L420 8L800 118V270L420 390L40 270Z'
            }
            fill={`url(#${prefix}-wall)`}
            stroke="#477468"
            strokeWidth="3"
          />
          <path
            d={narrow ? 'M12 280L210 360L408 280L210 204Z' : 'M40 270L420 390L800 270L420 150Z'}
            fill={`url(#${prefix}-tiles)`}
            stroke="#6c9a83"
            strokeWidth="3"
          />
          <path
            d={narrow ? 'M12 80L210 10L210 204L12 280Z' : 'M40 118L420 8V150L40 270Z'}
            fill="#374c4c"
            opacity=".65"
          />
          <path
            d={narrow ? 'M210 10L408 80V280L210 204Z' : 'M420 8L800 118V270L420 150Z'}
            fill="#46635e"
            opacity=".65"
          />
          <path
            d={narrow ? 'M54 115L150 78V161L54 198Z' : 'M124 108L277 62V155L124 201Z'}
            fill="#0b2628"
            stroke="#6bafaa"
            strokeWidth="5"
          />
          <path
            d={narrow ? 'M65 120L139 92V155L65 183Z' : 'M137 116L264 78V149L137 186Z'}
            fill="#4a7c86"
          />
          <path
            d={narrow ? 'M256 82L354 116V199L256 165Z' : 'M570 61L716 105V198L570 154Z'}
            fill="#0b2628"
            stroke="#6bafaa"
            strokeWidth="5"
          />
          <path
            d={narrow ? 'M266 98L344 125V182L266 155Z' : 'M582 78L704 115V181L582 144Z'}
            fill="#5a8791"
          />
          <text
            x={geometry.width / 2}
            y={narrow ? 62 : 43}
            textAnchor="middle"
            fontSize="19"
            fontFamily="monospace"
            fontWeight="bold"
            fill="#f4dfb9"
          >
            AI OFFICE
          </text>
        </g>
        <g aria-hidden="true" className="office-v3-architecture" pointerEvents="none">
          {/* Layered floor materials and a central communal area, not extra workstations. */}
          <path
            d={narrow ? 'M87 294L210 248L334 294L210 342Z' : 'M266 286L420 230L574 286L420 344Z'}
            fill="#aa8466"
            opacity=".34"
          />
          <path
            d={narrow ? 'M104 295L210 257L316 295L210 334Z' : 'M285 287L420 238L555 287L420 335Z'}
            fill="#d4b38b"
            opacity=".2"
            stroke="#cba77b"
            strokeWidth="2"
          />
          {/* Left wall: noticeboard and pinned sketches. */}
          <g transform={narrow ? 'translate(37 126) scale(.55)' : 'translate(64 150) scale(.9)'}>
            <path d="M0 0L86 -25V44L0 69Z" fill="#9b6e52" stroke="#d7b087" strokeWidth="4" />
            <path d="M12 13L38 5V33L12 41Z" fill="#f1d7b4" />
            <path d="M47 1L72 -6V20L47 27Z" fill="#c9dfd8" />
            <path d="M46 36L73 28" stroke="#e3c5a2" strokeWidth="4" />
            <circle cx="24" cy="16" r="3" fill="#cc7b6b" />
            <circle cx="59" cy="3" r="3" fill="#cc7b6b" />
          </g>
          {/* Right wall: books and an ambient lamp. */}
          <g transform={narrow ? 'translate(346 129) scale(.48)' : 'translate(737 146) scale(.8)'}>
            <path d="M-76 -13L0 12V22L-76 -3Z" fill="#c79b74" />
            <path d="M-72 -34L-60 -30V-10L-72 -14Z" fill="#e4b77b" />
            <path d="M-56 -42L-43 -38V-4L-56 -8Z" fill="#87b8a4" />
            <path d="M-39 -31L-24 -27V1L-39 -3Z" fill="#b78c9b" />
            <path d="M-19 -36L-5 -32V8L-19 4Z" fill="#e0c5a0" />
            <path d="M-77 -47L-40 -69L-4 -46" stroke="#eacb9e" strokeWidth="5" fill="none" />
            <circle cx="-40" cy="-48" r="10" fill="#f4d29c" opacity=".9" />
          </g>
          {/* Floor edge accents make the room legible as a constructed space. */}
          <path
            d={narrow ? 'M12 280L210 360L408 280' : 'M40 270L420 390L800 270'}
            stroke="#c9aa81"
            strokeWidth="5"
            strokeOpacity=".75"
            fill="none"
          />
        </g>
        <RoomDetails portrait={narrow} />
        {OFFICE_LAYOUT.map((placement, index) => {
          const agent = seatedAgents[index];
          if (!agent) return null;
          const point = narrow ? placement.portrait : placement.landscape;
          const selected = selectedAgent === agent.id;
          return (
            <g
              key={agent.id}
              className={`office-workstation iso-station state-${agent.status.state} identity-${placement.identity}`}
              data-agent-id={agent.id}
              data-state={agent.status.state}
              role="button"
              tabIndex={0}
              aria-label={`Select ${agent.name} workstation`}
              aria-pressed={selected}
              aria-describedby={`${prefix}-${agent.id}-status`}
              transform={`translate(${point.x} ${point.y})`}
              onClick={() => onSelect(agent.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  if (!event.repeat) onSelect(agent.id);
                }
                const buttons = Array.from(
                  event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>(
                    '.office-workstation',
                  ) ?? [],
                );
                const position = buttons.indexOf(event.currentTarget);
                const next = ['ArrowRight', 'ArrowDown'].includes(event.key)
                  ? (position + 1) % buttons.length
                  : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                    ? (position + buttons.length - 1) % buttons.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? buttons.length - 1
                        : undefined;
                if (next !== undefined) {
                  event.preventDefault();
                  buttons[next]?.focus();
                }
              }}
            >
              <ellipse
                className="iso-selection"
                cx="0"
                cy="50"
                rx="115"
                ry="51"
                fill="none"
                stroke="#a5ffbb"
                strokeWidth="3"
                strokeDasharray="9 6"
                opacity={selected ? 1 : 0}
              />
              <IsometricDesk state={agent.status.state} identity={placement.identity} />
              <text
                className="station-name"
                x="0"
                y="108"
                textAnchor="middle"
                fontSize="12"
                fontFamily="monospace"
                fontWeight="bold"
              >
                {agent.name.length > 22 ? `${agent.name.slice(0, 21)}…` : agent.name}
              </text>
              <rect
                x="-115"
                y="-118"
                width="230"
                height="233"
                fill="transparent"
                className="station-hit-area"
              />
            </g>
          );
        })}
      </svg>
      <section className="office-v3-floorboard" aria-label="Office floor operations">
        <div className="office-v3-floorboard-heading">
          <div>
            <span className="office-v3-activity-kicker">Live floor</span>
            <strong>Agent presence</strong>
          </div>
          <span>{agents.length} profiles · {queue.length} queued</span>
        </div>
        <div className="office-v3-floor-filters" role="group" aria-label="Filter office agents">
          {(['all', 'active', 'queued'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={floorFilter === filter}
              onClick={() => setFloorFilter(filter)}
            >
              {filter === 'all' ? 'All agents' : filter === 'active' ? 'Active' : 'Queued'}
            </button>
          ))}
        </div>
        <div className="office-v3-agent-grid">
          {visibleFloorAgents.map((agent) => {
            const pending = queue.filter((entry) => entry.agentId === agent.id);
            const running =
              agent.active || ['thinking', 'working', 'stopping'].includes(agent.status.state);
            return (
              <button
                key={agent.id}
                type="button"
                className="office-v3-agent-card"
                data-state={agent.status.state}
                aria-pressed={selectedAgent === agent.id}
                onClick={() => onSelect(agent.id)}
              >
                <span
                  className={`office-v3-presence state-${agent.status.state}`}
                  aria-hidden="true"
                />
                <span className="office-v3-agent-card-content">
                  <strong>{agent.name}</strong>
                  <span>{agent.role ?? 'Agent'} · {agent.status.label}</span>
                  <small title={agent.taskTitle ?? pending[0]?.title ?? ''}>
                    {agent.taskTitle
                      ? `Working on: ${agent.taskTitle}`
                      : pending.length > 0
                        ? `Next: ${pending[0]?.title}`
                        : running
                          ? 'Active · no task title'
                          : 'No active assignment'}
                  </small>
                </span>
                <span
                  className="office-v3-agent-card-count"
                  aria-label={`${pending.length} queued tasks`}
                >
                  {pending.length > 0 ? pending.length : '—'}
                </span>
              </button>
            );
          })}
          {visibleFloorAgents.length === 0 && (
            <p className="office-operations-help">
              {agents.length === 0 ? 'No agent profiles yet.' : 'No agents match this filter.'}
            </p>
          )}
        </div>
        {queue.length > 0 && (
          <div className="office-v3-queue-preview" aria-label="Next queued tasks">
            <strong>Waiting room</strong>
            <ol>
              {[...queue]
                .sort((a, b) => a.order - b.order)
                .slice(0, 4)
                .map((entry) => (
                  <li key={entry.taskId}>
                    <button type="button" onClick={() => onSelect(entry.agentId)}>
                      <span>{entry.title}</span>
                      <small>
                        {agents.find((agent) => agent.id === entry.agentId)?.name ??
                          'Unknown agent'}
                        {entry.waitingReason ? ` · ${entry.waitingReason}` : ''}
                      </small>
                    </button>
                  </li>
                ))}
            </ol>
            {queue.length > 4 && (
              <span className="office-v3-queue-more">+{queue.length - 4} more queued</span>
            )}
          </div>
        )}
      </section>
      <div className="office-v3-detail-control">
        <div>
          <strong>Operations detail</strong>
          <span>Workflow, selected workstation and task history</span>
        </div>
        <button
          type="button"
          aria-controls={`${prefix}-operations-detail`}
          aria-expanded={showOperations}
          onClick={() => setShowOperations((value) => !value)}
        >
          {showOperations ? 'Hide details' : 'Show details'}
        </button>
      </div>
      <section
        id={`${prefix}-operations-detail`}
        className="office-workflow"
        aria-label="Agent workflow overview"
        hidden={!showOperations}
      >
        <div className="office-workflow-header">
          <strong>Agent workflow</strong>
          <span>Live profile activity · not an automatic pipeline</span>
        </div>
        <div className="office-workflow-lanes">
          {(['coder', 'reviewer', 'qa'] as const).map((role) => {
            const matching = agents.filter((agent) => agent.role?.toLowerCase().includes(role));
            const active = matching.filter(
              (agent) =>
                agent.active || ['thinking', 'working', 'stopping'].includes(agent.status.state),
            );
            return (
              <div className="office-workflow-lane" key={role} data-role={role}>
                <span className="office-workflow-step">
                  {role === 'coder' ? '01' : role === 'reviewer' ? '02' : '03'}
                </span>
                <strong>{role === 'qa' ? 'QA' : role === 'coder' ? 'Coder' : 'Reviewer'}</strong>
                <span className="office-workflow-count">
                  {matching.length === 0
                    ? 'No profile'
                    : `${active.length} active / ${matching.length} profiles`}
                </span>
                {matching.length > 0 && (
                  <div className="office-workflow-members">
                    {matching.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => onSelect(agent.id)}
                        aria-pressed={selectedAgent === agent.id}
                        title={agent.status.label}
                      >
                        <span
                          className={`office-workflow-dot state-${agent.status.state}`}
                          aria-hidden="true"
                        />
                        {agent.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section
        className="office-inspector"
        aria-label="Selected agent inspector"
        hidden={!showOperations}
      >
        <div className="office-operations-heading">
          <strong>Selected workstation</strong>
          <span>Read-only live snapshot</span>
        </div>
        {selectedProfile ? (
          <div className="office-inspector-content">
            <div>
              <strong>{selectedProfile.name}</strong>
              <p>
                {selectedProfile.role || 'Agent'} · {selectedProfile.status.label}
              </p>
              <p>Execution access: {selectedProfile.access ?? 'Read only'}</p>
            </div>
            <div>
              <strong>Current assignment</strong>
              <p>{selectedProfile.taskTitle ?? 'No running assignment'}</p>
              {selectedProfile.taskState && <p>Task lifecycle: {selectedProfile.taskState}</p>}
              {selectedProfile.taskState && (
                <ol className="office-lifecycle" aria-label="Selected task lifecycle">
                  {lifecycle.map((state) => (
                    <li
                      key={state}
                      aria-current={selectedProfile.taskState === state ? 'step' : undefined}
                    >
                      {state}
                    </li>
                  ))}
                </ol>
              )}
              <p>{selectedQueue.length} queued for this agent</p>
              {nextQueued && (
                <p>
                  Next submitted task: {nextQueued.title}
                  {nextQueued.waitingReason ? ` · ${nextQueued.waitingReason}` : ''}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="office-operations-help">
            Select an available agent to inspect its workstation.
          </p>
        )}
      </section>
      <section
        className="office-history"
        aria-label="Recent agent tasks"
        hidden={!showOperations}
      >
        <div className="office-operations-heading">
          <strong>Recent task activity</strong>
          <span>Persisted task snapshots · latest first</span>
        </div>
        <div className="office-history-filters" role="group" aria-label="Filter task history">
          {(['all', 'selected', 'failures'] as const).map((filter) => (
            <button
              type="button"
              key={filter}
              aria-pressed={historyFilter === filter}
              onClick={() => setHistoryFilter(filter)}
            >
              {filter === 'all'
                ? 'All tasks'
                : filter === 'selected'
                  ? 'Selected agent'
                  : 'Failures'}
            </button>
          ))}
        </div>
        {filteredHistory.length > 8 && (
          <button
            type="button"
            className="office-history-toggle"
            aria-expanded={showAllTasks}
            onClick={() => setShowAllTasks((value) => !value)}
          >
            {showAllTasks ? 'Show recent 8' : `Show up to 24 · ${filteredHistory.length} available`}
          </button>
        )}
        {filteredHistory.length === 0 ? (
          <p className="office-operations-help">
            {recentTasks.length === 0 ? 'No recorded tasks.' : 'No tasks match this filter.'}
          </p>
        ) : (
          <ol className="office-history-items">
            {visibleHistory.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => onSelect(task.agentId)}
                  aria-pressed={selectedAgent === task.agentId}
                  title={`Inspect agent for ${task.title}`}
                >
                  <span className={`office-history-state state-${task.state}`}>{task.state}</span>
                  <span className="office-queue-details">
                    <strong>{task.title}</strong>
                    <small>
                      {agents.find((agent) => agent.id === task.agentId)?.name ?? 'Unknown agent'}
                    </small>
                  </span>
                  <time dateTime={task.updatedAt}>
                    {task.updatedAt.slice(0, 16).replace('T', ' ')}
                  </time>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section
        className="office-queue"
        aria-label="Live task queue"
        hidden={!showOperations}
      >
        <div className="office-operations-heading">
          <strong>Task queue</strong>
          <span>{queue.length} waiting</span>
        </div>
        {queue.length === 0 ? (
          <p className="office-operations-help">No queued tasks.</p>
        ) : (
          <ol className="office-queue-items">
            {[...queue]
              .sort((a, b) => a.order - b.order)
              .map((item) => (
                <li key={item.taskId}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.agentId)}
                    aria-pressed={selectedAgent === item.agentId}
                    title={`Inspect agent assigned to ${item.title}`}
                  >
                    <span className="office-queue-position">#{item.order}</span>
                    <span className="office-queue-details">
                      <strong>{item.title}</strong>
                      <small>
                        {agents.find((agent) => agent.id === item.agentId)?.name ?? 'Unknown agent'}
                        {item.waitingReason ? ` · ${item.waitingReason}` : ' · Waiting'}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
          </ol>
        )}
      </section>
      <div
        className="office-operations"
        aria-label="Live office operations"
        hidden={!showOperations}
      >
        <div className="office-operations-heading">
          <strong>Office activity</strong>
          <span aria-live="polite">
            {activeCount} active · {errorCount} errors
          </span>
        </div>
        <p className="office-operations-help">
          Select a desk or an agent below to inspect their actual task and session. Status comes
          from the local server, not the animation.
        </p>
        {agents.length === 0 && (
          <p className="office-operations-empty">
            No agent profiles available. Create a profile in Agent Studio to populate the office.
          </p>
        )}
        <div className="office-operations-agents">
          {agents.map((agent) => (
            <button
              type="button"
              key={agent.id}
              className={`office-operations-agent state-${agent.status.state}`}
              aria-pressed={selectedAgent === agent.id}
              onClick={() => onSelect(agent.id)}
              title={`Inspect ${agent.name}: ${agent.status.label}`}
            >
              <span className="office-operations-indicator" aria-hidden="true" />
              <span className="office-operations-identity">
                <strong>{agent.name}</strong>
                <small>
                  {agent.role ? `${agent.role} · ` : ''}
                  {agent.status.label}
                </small>
                {agent.taskTitle && (
                  <small className="office-operations-task" title={agent.taskTitle}>
                    Task: {agent.taskTitle}
                    {agent.taskState ? ` · ${agent.taskState}` : ''}
                  </small>
                )}
              </span>
              <span className="office-operations-access">{agent.access ?? 'Read only'}</span>
            </button>
          ))}
        </div>
      </div>
      {agents.map((agent) => (
        <span key={agent.id} id={`${prefix}-${agent.id}-status`} className="sr-only">
          {agent.status.label}. {agent.access ?? 'Read only'}.
        </span>
      ))}
    </div>
  );
}
