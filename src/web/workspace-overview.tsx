import { useState } from 'react';
import type { Dashboard, Task } from '../shared/types.js';

interface WorkspaceOverviewProps {
  dashboard?: Dashboard;
  transportStatus?: 'connecting' | 'connected' | 'disconnected';
  onOpenTask: (task: Task) => void;
  onNewTask: () => void;
}

function taskStatus(state: Task['state']): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'stopping':
      return 'Stopping';
    case 'queued':
      return 'Not started';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    case 'interrupted':
      return 'Interrupted';
  }
}

export function WorkspaceOverview({
  dashboard,
  transportStatus = 'connecting',
  onOpenTask,
  onNewTask,
}: WorkspaceOverviewProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [visibleCount, setVisibleCount] = useState(12);
  const isLive = transportStatus === 'connected';
  const tasks = dashboard?.tasks ?? [];
  const queueIds = new Set(dashboard?.queue.map((entry) => entry.taskId) ?? []);
  const running = tasks.filter(
    (task) => task.state === 'running' || task.state === 'stopping',
  ).length;
  const completed = tasks.filter((task) => task.state === 'completed').length;
  const attention = tasks.filter(
    (task) => task.state === 'failed' || task.state === 'interrupted',
  ).length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchesStatus = (task: Task) => {
    switch (statusFilter) {
      case 'running':
        return task.state === 'running' || task.state === 'stopping';
      case 'queued':
        return queueIds.has(task.id);
      case 'completed':
        return task.state === 'completed';
      case 'attention':
        return task.state === 'failed' || task.state === 'interrupted';
      default:
        return true;
    }
  };
  const matchingTasks = [...tasks]
    .filter((task) => {
      const repository = dashboard?.repositories.find((repo) => repo.id === task.repositoryId);
      const agentName =
        dashboard?.profiles?.find((profile) => profile.id === task.agentId)?.name ??
        dashboard?.agents.find((agent) => agent.id === task.agentId)?.name ??
        task.agentId;
      return (
        matchesStatus(task) &&
        (!normalizedQuery ||
          [task.title, task.id, repository?.name ?? '', agentName].some((value) =>
            value.toLocaleLowerCase().includes(normalizedQuery),
          ))
      );
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recent = matchingTasks.slice(0, visibleCount);
  const agents = dashboard?.agents ?? [];
  const agentLabel = (state: string, hasTask: boolean) => {
    if (state === 'waiting') return 'Waiting';
    if (state === 'preparing') return 'Preparing';
    if (state === 'stopping') return 'Stopping';
    if (hasTask || state === 'running') return 'Running';
    return 'Idle';
  };
  const metrics = [
    { label: 'Running', value: running, hint: 'Tasks executing now' },
    { label: 'In queue', value: dashboard?.queue.length ?? 0, hint: 'Submitted and waiting' },
    { label: 'Completed', value: completed, hint: 'Across this workspace' },
    { label: 'Needs attention', value: attention, hint: 'Failed or interrupted' },
  ];

  return (
    <section className="workspace-overview" aria-label="Workspace activity">
      {!isLive && (
        <p className="overview-transport-warning" role="status">
          {transportStatus === 'disconnected'
            ? dashboard
              ? 'Server disconnected. Task counts and provider status are from the last received snapshot.'
              : 'Server disconnected. No workspace snapshot is available. Retry the connection to load tasks.'
            : dashboard
              ? 'Reconnecting to server. Task counts and provider status may be outdated.'
              : 'Connecting to server. Waiting for the first workspace snapshot.'}
        </p>
      )}
      <div className="overview-metrics" aria-label="Task status summary">
        {metrics.map(({ label, value, hint }) => (
          <div className="overview-metric" key={label}>
            <span>{label}</span>
            <strong>{dashboard ? value : '—'}</strong>
            <small>{hint}</small>
          </div>
        ))}
      </div>
      <div className="overview-columns">
        <section className="overview-card overview-tasks" aria-label="Workspace tasks">
          <div className="overview-card-heading">
            <div>
              <h3>Tasks</h3>
              <p>Open a task to inspect its session and results.</p>
            </div>
            <span>{dashboard ? tasks.length : '—'} total</span>
          </div>
          <label className="overview-task-search">
            <span className="sr-only">Search workspace tasks</span>
            <input
              type="search"
              aria-label="Search workspace tasks"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(12);
              }}
              placeholder="Search tasks, repositories or agents"
            />
          </label>
          <div className="overview-task-filters">
            <label>
              <span className="sr-only">Filter tasks by status</span>
              <select
                aria-label="Filter tasks by status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value);
                  setVisibleCount(12);
                }}
              >
                <option value="all">All statuses</option>
                <option value="running">Running</option>
                <option value="queued">In queue</option>
                <option value="completed">Completed</option>
                <option value="attention">Needs attention</option>
              </select>
            </label>
            {dashboard && <span role="status">{matchingTasks.length} matching</span>}
          </div>
          {!dashboard ? (
            <p className="overview-empty" role="status">
              Loading workspace tasks…
            </p>
          ) : recent.length === 0 ? (
            <div className="overview-empty">
              {tasks.length === 0 ? (
                <>
                  <p>No tasks yet. Start with a read-only review of a repository.</p>
                  <button type="button" onClick={onNewTask}>
                    Create a task
                  </button>
                </>
              ) : (
                <p role="status">No tasks match your search or status filter.</p>
              )}
            </div>
          ) : (
            <div className="overview-task-list">
              {recent.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="overview-task"
                  onClick={() => onOpenTask(task)}
                  aria-label={`Open task: ${task.title}`}
                >
                  <span className="overview-task-title">
                    <strong>{task.title}</strong>
                    <small>
                      {dashboard.repositories.find((repo) => repo.id === task.repositoryId)?.name ??
                        'Repository unavailable'}
                      {' · '}
                      {dashboard.profiles?.find((profile) => profile.id === task.agentId)?.name ??
                        dashboard.agents.find((agent) => agent.id === task.agentId)?.name ??
                        task.agentId}
                    </small>
                  </span>
                  <span className="overview-task-meta">
                    <span className={`overview-state state-${task.state}`}>
                      {queueIds.has(task.id) ? 'In queue' : taskStatus(task.state)}
                    </span>
                    <time dateTime={task.updatedAt} title={task.updatedAt}>
                      {new Date(task.updatedAt).toLocaleDateString()}
                    </time>
                  </span>
                </button>
              ))}
              {matchingTasks.length > recent.length && (
                <button
                  type="button"
                  className="overview-show-more"
                  onClick={() => setVisibleCount((count) => count + 20)}
                >
                  Show more tasks ({matchingTasks.length - recent.length} remaining)
                </button>
              )}
            </div>
          )}
        </section>
        <aside className="overview-side" aria-label="Agent and task overview">
          <section className="overview-card">
            <div className="overview-card-heading">
              <h3>Agents</h3>
              <span>{dashboard ? agents.length : '—'}</span>
            </div>
            {!dashboard ? (
              <p className="overview-empty">Loading agents…</p>
            ) : agents.length === 0 ? (
              <p className="overview-empty">No agents configured.</p>
            ) : (
              <ul className="overview-agent-list">
                {agents.map((agent) => (
                  <li key={agent.id}>
                    <span className="overview-agent-mark" aria-hidden="true">
                      ◇
                    </span>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>
                        {agent.taskId
                          ? 'Working on a task'
                          : agent.state === 'waiting'
                            ? 'Task waiting in queue'
                            : 'No active task'}
                      </small>
                    </span>
                    <span className={`overview-agent-state ${agent.taskId ? 'busy' : ''}`}>
                      {agentLabel(agent.state, Boolean(agent.taskId))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="overview-card overview-health">
            <div className="overview-card-heading">
              <h3>Provider readiness</h3>
            </div>
            <p className="overview-connection">
              <span
                className={`overview-connection-dot ${
                  isLive && dashboard?.connection.status === 'available' ? 'ready' : ''
                }`}
              />
              {!dashboard
                ? 'Checking connection…'
                : isLive
                  ? dashboard.connection.message
                  : `Last known: ${dashboard.connection.message}`}
            </p>
            <p className="overview-connection-caption">
              Provider readiness is based on the last received snapshot; server connectivity is tracked separately.
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}
