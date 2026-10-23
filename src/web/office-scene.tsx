import { useEffect, useId, useRef, useState } from 'react';
import type { AgentId } from '../shared/types.js';
import type { SceneStatus } from './scene-state.js';
import { STUDIO_DESKS, selectOfficeSeats } from './office-layout.js';
import { selectOfficeHistory } from './office-history.js';
import { AgentPortrait, StudioDesk, StudioRoom, STATE_SYMBOL, roomPoint } from './office-art.js';
import './office.css';

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
  checkpoint?: string;
  assignable?: boolean;
}
export interface OfficeQueueItem {
  taskId: string;
  agentId: AgentId;
  title: string;
  order: number;
  waitingReason?: string;
}
export interface OfficeRecentTask {
  id: string;
  agentId: AgentId;
  title: string;
  state: string;
  updatedAt: string;
}

export function PixelOffice({
  agents,
  selectedAgent,
  onSelect,
  queue = [],
  recentTasks = [],
  onInspectTask,
  onAssign,
  onInspectSession,
  onCheckpoint,
  transport = 'connected',
}: {
  agents: OfficeAgent[];
  selectedAgent: AgentId;
  onSelect: (id: AgentId) => void;
  queue?: OfficeQueueItem[];
  recentTasks?: OfficeRecentTask[];
  onInspectTask?: (taskId: string) => void;
  onAssign?: () => void;
  onInspectSession?: () => void;
  onCheckpoint?: () => void;
  transport?: 'loading' | 'connected' | 'disconnected' | 'unavailable';
}) {
  const prefix = useId();
  const container = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [filter, setFilter] = useState<'all' | 'active' | 'queued'>('all');
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 620);
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const unknown = transport === 'loading' || transport === 'unavailable';
  const selected = agents.find((agent) => agent.id === selectedAgent);
  const seats = selectOfficeSeats(agents, selectedAgent, STUDIO_DESKS.length);
  const active = (agent: OfficeAgent) =>
    Boolean(agent.active) ||
    ['preparing', 'working', 'thinking', 'reviewing', 'stopping'].includes(agent.status.state);
  const activeCount = agents.filter(active).length;
  const sortedQueue = [...queue].sort((a, b) => a.order - b.order);
  const filtered = agents.filter(
    (agent) =>
      filter === 'all' ||
      (filter === 'active' ? active(agent) : queue.some((entry) => entry.agentId === agent.id)),
  );
  const selectedQueue = sortedQueue.filter((entry) => entry.agentId === selectedAgent);
  return (
    <div
      ref={container}
      className="shared-office isometric-office"
      data-layout={narrow ? 'portrait' : 'landscape'}
    >
      <div className="studio-heading">
        <div>
          <span className="studio-kicker">THE STUDIO / OFFICE 04</span>
          <h2>A little space. Big ideas.</h2>
        </div>
        <div className="studio-population">
          <span>{unknown ? 'Loading profiles…' : `${agents.length} profiles`}</span>
          <span>{unknown ? '2 worker capacity' : `${activeCount} active / 2 capacity`}</span>
        </div>
      </div>
      {transport !== 'connected' && (
        <div className="studio-notice" role="status">
          {transport === 'loading'
            ? 'Opening your office…'
            : transport === 'unavailable'
              ? 'Unable to connect to your office. Retrying…'
              : 'Connection interrupted · showing the last saved snapshot. Actions are unavailable until reconnected.'}
        </div>
      )}
      <div className="studio-world">
        <div className="studio-room-heading" aria-hidden="true">
          <span>01 / SHARED WORKSPACE</span>
          <span>SELECT A DESK TO CHECK IN ↙</span>
        </div>
        <svg
          className="pixel-office"
          data-visible-seats={seats.length}
          viewBox={narrow ? '25 -5 950 640' : '0 -25 1000 650'}
          role="group"
          aria-label={`Interactive isometric office. ${seats.map((agent) => `${agent.name}: ${agent.status.label}`).join('; ') || 'No occupied desks'}`}
        >
          <StudioRoom prefix={prefix}>
            {STUDIO_DESKS.map((desk, index) => {
              const agent = seats[index];
              if (!agent) return null;
              const p = roomPoint(desk.x, desk.y);
              return (
                <g
                  key={agent.id}
                  className={`office-workstation iso-station state-${agent.status.state}`}
                  data-agent-id={agent.id}
                  data-state={agent.status.state}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select ${agent.name} workstation`}
                  aria-pressed={selectedAgent === agent.id}
                  aria-describedby={`${prefix}-${index}-status`}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={() => onSelect(agent.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      if (!event.repeat) onSelect(agent.id);
                      return;
                    }
                    const buttons = Array.from(
                      event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>(
                        '.office-workstation',
                      ) ?? [],
                    );
                    const current = buttons.indexOf(event.currentTarget);
                    const next = ['ArrowRight', 'ArrowDown'].includes(event.key)
                      ? (current + 1) % buttons.length
                      : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                        ? (current + buttons.length - 1) % buttons.length
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
                  <title>
                    {agent.name} · {agent.status.label}
                  </title>
                  <desc id={`${prefix}-${index}-status`}>
                    {agent.status.label}. {agent.access ?? 'No active access'}.{' '}
                    {agent.taskTitle ?? 'No active assignment'}.
                  </desc>
                  <ellipse className="iso-selection" cy="8" rx="91" ry="42" />
                  <StudioDesk id={agent.id} state={agent.status.state} />
                  <rect
                    className="station-hit-area"
                    x="-94"
                    y="-120"
                    width="188"
                    height="216"
                    rx="12"
                    fill="transparent"
                  />
                </g>
              );
            })}
          </StudioRoom>
        </svg>
        {transport === 'connected' && agents.length === 0 && (
          <div className="studio-empty">
            <strong>Your office is ready for company.</strong>
            <p>Create an agent profile to take the first desk.</p>
            <a className="button-link" href="#agent-studio">
              Open Agent Studio →
            </a>
          </div>
        )}
        {agents.length > seats.length && (
          <p className="studio-overflow">
            {agents.length - seats.length} more profiles in the roster. Select one to bring it into
            the room.
          </p>
        )}
        <div className="studio-room-footer">
          <span>{selected ? `Selected · ${selected.name}` : 'Your shared workspace'}</span>
          <span>Tab + arrows to explore · Enter to select</span>
        </div>
      </div>
      <section className="studio-roster" aria-label="Office floor operations">
        <div className="studio-section-heading">
          <strong>
            Your team <small>{unknown ? '—' : agents.length}</small>
          </strong>
          <div className="studio-filters" role="group" aria-label="Filter office agents">
            {(['all', 'active', 'queued'] as const).map((value) => (
              <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {value === 'all' ? 'All agents' : value === 'active' ? 'Active' : 'Queued'}
              </button>
            ))}
          </div>
        </div>
        <div className="studio-agent-list">
          {filtered.map((agent) => (
            <button
              key={agent.id}
              className={`studio-agent state-${agent.status.state}`}
              aria-pressed={selectedAgent === agent.id}
              onClick={() => onSelect(agent.id)}
            >
              <AgentPortrait id={agent.id} />
              <span>
                <strong>{agent.name}</strong>
                <small>{agent.role || 'Agent'}</small>
                <span className="studio-agent-status">
                  {STATE_SYMBOL[agent.status.state]} {agent.status.label}
                </span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="studio-muted">
              {unknown
                ? 'Profiles will appear when the office connects.'
                : agents.length === 0
                  ? 'No agent profiles yet.'
                  : 'No agents match this filter.'}
            </p>
          )}
        </div>
      </section>
      <section className="studio-inspector" aria-label="Selected agent inspector">
        {selected ? (
          <>
            <div className="studio-selected">
              <AgentPortrait id={selected.id} />
              <div>
                <span className="studio-kicker">SELECTED AGENT</span>
                <h3>{selected.name}</h3>
                <p>{selected.status.label}</p>
                {selected.checkpoint && (
                  <small className="studio-muted">Workflow {selected.checkpoint.slice(0, 8)}</small>
                )}
              </div>
              <span className="studio-access">
                {selected.active ? (selected.access ?? 'Access unavailable') : 'No active access'}
              </span>
            </div>
            <div className="studio-assignment">
              <div>
                <span className="studio-kicker">
                  {selected.active ? 'CURRENT ASSIGNMENT' : 'TASK IN VIEW'}
                </span>
                <strong>{selected.taskTitle ?? 'A clear desk. A fresh start.'}</strong>
                <p>
                  {selected.taskState
                    ? `Task lifecycle: ${selected.taskState}`
                    : 'Choose a task for this agent when you are ready.'}
                  {selectedQueue.length > 0 ? ` · ${selectedQueue.length} submitted in queue` : ''}
                </p>
              </div>
              <div className="studio-actions">
                {selected.taskId && onInspectSession && (
                  <button disabled={transport !== 'connected'} onClick={onInspectSession}>
                    Inspect task & session ↗
                  </button>
                )}
                {onAssign && (
                  <button
                    className="secondary"
                    disabled={transport !== 'connected' || selected.assignable === false}
                    onClick={onAssign}
                  >
                    Assign a task
                  </button>
                )}
                {selected.checkpoint && onCheckpoint && (
                  <button
                    className="studio-approval"
                    disabled={transport !== 'connected'}
                    onClick={onCheckpoint}
                  >
                    ◇ Inspect approval
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <p className="studio-muted">
            {unknown
              ? 'Task details will appear after connection.'
              : 'Select an available agent to inspect its task and session.'}
          </p>
        )}
      </section>
      <section className="studio-queue" aria-label="Live task queue">
        <div className="studio-section-heading">
          <strong>
            Up next <small>{unknown ? '—' : queue.length} waiting</small>
          </strong>
          <span className="studio-muted">Submitted tasks</span>
        </div>
        {sortedQueue.length === 0 ? (
          <p className="studio-muted">
            {unknown
              ? 'Waiting for the task queue…'
              : 'No queued tasks. The next idea can wait for you.'}
          </p>
        ) : (
          <ol>
            {sortedQueue.map((entry) => (
              <li key={entry.taskId}>
                <button
                  disabled={transport !== 'connected' || !onInspectTask}
                  onClick={() => onInspectTask?.(entry.taskId)}
                  title={`Inspect queued task ${entry.title}`}
                >
                  <span className="studio-queue-number">
                    {entry.order.toString().padStart(2, '0')}
                  </span>
                  <span>
                    <strong>{entry.title}</strong>
                    <small>
                      {agents.find((agent) => agent.id === entry.agentId)?.name ?? 'Unknown agent'}{' '}
                      · {entry.waitingReason ?? 'Waiting for an available worker'}
                    </small>
                  </span>
                  <span aria-hidden="true">↗</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="studio-history" aria-label="Recent agent tasks">
        <button
          className="studio-history-toggle secondary"
          aria-expanded={showHistory}
          aria-controls={`${prefix}-history`}
          onClick={() => setShowHistory(!showHistory)}
        >
          Recent task activity{' '}
          <span>
            {unknown ? '—' : recentTasks.length} saved {showHistory ? '−' : '+'}
          </span>
        </button>
        <div id={`${prefix}-history`} hidden={!showHistory}>
          {recentTasks.length === 0 ? (
            <p className="studio-muted">
              {unknown ? 'History will appear after connection.' : 'No recorded tasks.'}
            </p>
          ) : (
            <ul>
              {selectOfficeHistory(recentTasks, selectedAgent, 'all', 12).map((task) => (
                <li key={task.id}>
                  <button disabled={!onInspectTask} onClick={() => onInspectTask?.(task.id)}>
                    <span className={`studio-task-state state-${task.state}`}>{task.state}</span>
                    <strong>{task.title}</strong>
                    <time dateTime={task.updatedAt}>
                      {task.updatedAt.slice(0, 16).replace('T', ' ')}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
