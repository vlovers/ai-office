import type { Dashboard, Task } from '../shared/types.js';

interface WorkspaceOverviewProps {
  dashboard?: Dashboard;
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
  onOpenTask,
  onNewTask,
}: WorkspaceOverviewProps) {
  const tasks = dashboard?.tasks ?? [];
  const queueIds = new Set(dashboard?.queue.map((entry) => entry.taskId) ?? []);
  const running = tasks.filter((task) => task.state === 'running' || task.state === 'stopping').length;
  const completed = tasks.filter((task) => task.state === 'completed').length;
  const attention = tasks.filter((task) => task.state === 'failed' || task.state === 'interrupted').length;
  const recent = [...tasks]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const agents = dashboard?.agents ?? [];
  const metrics = [
    { label: 'Running', value: running, hint: 'Tasks executing now' },
    { label: 'In queue', value: dashboard?.queue.length ?? 0, hint: 'Submitted and waiting' },
    { label: 'Completed', value: completed, hint: 'Across this workspace' },
    { label: 'Needs attention', value: attention, hint: 'Failed or interrupted' },
  ];

  return (
    <section className="workspace-overview" aria-label="Workspace activity">
      <div className="overview-intro">
        <div>
          <span className="overview-kicker">WORKSPACE</span>
          <h2>Your workspace</h2>
          <p>Tasks, agents and recent work in one place.</p>
        </div>
        <button type="button" onClick={onNewTask} className="overview-new-task">
          + New task
        </button>
      </div>
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
        <section className="overview-card overview-tasks" aria-label="Recent tasks">
          <div className="overview-card-heading">
            <div>
              <h3>Recent tasks</h3>
              <p>Open a task to inspect its session and results.</p>
            </div>
            <span>{dashboard ? tasks.length : '—'} total</span>
          </div>
          {!dashboard ? (
            <p className="overview-empty" role="status">Loading workspace tasks…</p>
          ) : recent.length === 0 ? (
            <div className="overview-empty">
              <p>No tasks yet. Start with a read-only review of a repository.</p>
              <button type="button" onClick={onNewTask}>Create a task</button>
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
                        'Repository unavailable'}{' · '}
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
                    <span className="overview-agent-mark" aria-hidden="true">◇</span>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.taskId ? 'Working on a task' : 'No active task'}</small>
                    </span>
                    <span className={`overview-agent-state ${agent.taskId ? 'busy' : ''}`}>
                      {agent.taskId ? 'Busy' : 'Idle'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="overview-card overview-health">
            <div className="overview-card-heading"><h3>Connection</h3></div>
            <p className="overview-connection">
              <span className={`overview-connection-dot ${dashboard?.connection.status === 'available' ? 'ready' : ''}`} />
              {dashboard ? dashboard.connection.message : 'Checking connection…'}
            </p>
            <p className="overview-connection-caption">
              Tasks and agents may be unavailable while the server is disconnected.
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}
