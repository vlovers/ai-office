import { useEffect, useState, type ReactNode } from 'react';
import type { AgentEvent, Dashboard, Task, WorkspaceReview } from '../shared/types.js';
import { taskHasReview, type TaskDestination } from './task-navigation.js';
import { WorkspaceIcon } from './workspace-icon.js';

const tabs = [
  ['overview', 'Overview'],
  ['execution', 'Execution'],
  ['changes', 'Changes'],
  ['review', 'Review'],
  ['history', 'History'],
] as const;

export function TaskTimeline({ task, events }: { task: Task; events: AgentEvent[] }) {
  return (
    <ol className="task-timeline">
      <li>
        <span className="timeline-dot" />
        <div>
          <strong>Task created</strong>
          <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString()}</time>
        </div>
      </li>
      {events
        .filter((event) => event.taskId === task.id && event.kind === 'state')
        .map((event) => (
          <li key={event.id}>
            <span className="timeline-dot" />
            <div>
              <strong>{event.message}</strong>
              <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
            </div>
          </li>
        ))}
      <li>
        <span className={`timeline-dot ${task.state}`} />
        <div>
          <strong>Latest saved state: {task.state}</strong>
          <time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString()}</time>
        </div>
      </li>
    </ol>
  );
}

export function TaskDetails({
  task,
  dashboard,
  events,
  destination,
  connected,
  embedded = false,
  controls,
  execution,
  changes,
  review,
  workflow,
  onNavigate,
  api,
}: {
  task: Task;
  dashboard?: Dashboard;
  events: AgentEvent[];
  destination?: TaskDestination;
  connected: boolean;
  embedded?: boolean;
  controls: ReactNode;
  execution: ReactNode;
  changes: ReactNode;
  review: ReactNode;
  workflow: ReactNode;
  onNavigate: (task: Task, destination: TaskDestination) => void;
  api: <T>(path: string) => Promise<T>;
}) {
  const active = destination === 'session' || !destination ? 'execution' : destination;
  const [branch, setBranch] = useState<{ taskId: string; name?: string; error?: string }>();
  const Heading = embedded ? 'h2' : 'h1';
  const repo = dashboard?.repositories.find((repo) => repo.id === task.repositoryId);
  const assignee =
    task.configuration?.name ??
    dashboard?.profiles?.find((profile) => profile.id === task.agentId)?.name ??
    dashboard?.agents.find((agent) => agent.id === task.agentId)?.name ??
    task.agentId;
  useEffect(() => {
    let live = true;
    if (connected && taskHasReview(task)) {
      void api<WorkspaceReview>(`/tasks/${encodeURIComponent(task.id)}/review`).then(
        (value) => {
          if (live) setBranch({ taskId: task.id, name: value.workspace.branch });
        },
        () => {
          if (live)
            setBranch({
              taskId: task.id,
              error: 'Working branch unavailable. Open Review to retry.',
            });
        },
      );
    }
    return () => {
      live = false;
    };
  }, [task.id, task.state, task.workspaceId, connected]);
  const metadata = [
    ['Repository', repo?.name ?? task.repositoryId],
    ['Task ID', task.id],
    ['Assignee', assignee],
    ['Execution mode', task.executionMode === 'write' ? 'Isolated write' : 'Read only'],
    ['Priority', 'Not recorded'],
    ['Risk', 'Not recorded'],
    ['Created', new Date(task.createdAt).toLocaleString()],
    ['Updated', new Date(task.updatedAt).toLocaleString()],
  ];
  return (
    <div className="task-details" data-detail-tab={active}>
      <div className="task-breadcrumb">
        <a href="#task-history">← Tasks</a>
        <span>/</span>
        <span>{task.id}</span>
      </div>
      <header className="task-detail-heading">
        <div className="task-heading-icon">
          <WorkspaceIcon name="tasks" />
        </div>
        <Heading>{task.title}</Heading>
        <span className={`badge ${task.state}`}>{task.state}</span>
      </header>
      <div className="task-detail-byline">
        <span>
          Assignee <strong>{assignee}</strong>
        </span>
        <span>
          Priority <strong>Not recorded</strong>
        </span>
        <span>
          Risk <strong>Not recorded</strong>
        </span>
      </div>
      {!connected && (
        <p className="overview-transport-warning" role="status">
          Disconnected. Task details show the last received snapshot.
        </p>
      )}
      {controls}
      <div
        className="task-detail-tabs"
        role="tablist"
        aria-label="Task detail sections"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
          );
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
      >
        {tabs.map(([id, label]) => (
          <button
            type="button"
            key={id}
            role="tab"
            id={`task-tab-${id}`}
            disabled={id === 'review' && !taskHasReview(task)}
            title={
              id === 'review' && !taskHasReview(task)
                ? 'Available after an isolated write task finishes'
                : undefined
            }
            aria-selected={active === id}
            aria-controls={`task-content-${id}`}
            tabIndex={active === id ? 0 : -1}
            onClick={() => onNavigate(task, id)}
          >
            {label}
          </button>
        ))}
        {active === 'workflow' && (
          <button
            type="button"
            role="tab"
            id="task-tab-workflow"
            aria-selected="true"
            aria-controls="task-content-workflow"
            onClick={() => onNavigate(task, 'workflow')}
          >
            Workflow &amp; QA
          </button>
        )}
      </div>
      <section
        id="task-content-overview"
        role="tabpanel"
        aria-labelledby="task-tab-overview"
        hidden={active !== 'overview'}
        tabIndex={0}
      >
        <div className="task-detail-columns">
          <div className="task-detail-primary">
            <section className="detail-card">
              <h3>
                <WorkspaceIcon name="overview" />
                Objective
              </h3>
              <p className="task-objective">{task.prompt}</p>
            </section>
            <section className="detail-card">
              <h3>
                <WorkspaceIcon name="tasks" />
                Acceptance criteria
              </h3>
              <p className="unavailable-copy">
                Not recorded. This workspace does not store structured acceptance criteria.
              </p>
            </section>
            <section className="detail-card">
              <h3>
                <WorkspaceIcon name="workflows" />
                Dependencies
              </h3>
              <p className="unavailable-copy">
                No supported dependency links are recorded for this task.
              </p>
            </section>
            <section className="detail-card">
              <h3>
                <WorkspaceIcon name="execution" />
                Execution timeline
              </h3>
              <TaskTimeline task={task} events={events} />
            </section>
          </div>
          <aside className="task-detail-secondary">
            <section className="detail-card">
              <h3>
                <WorkspaceIcon name="context" />
                Task metadata
              </h3>
              <dl className="metadata-list">
                {metadata.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="detail-card">
              <h3>
                <WorkspaceIcon name="execution" />
                Progress
              </h3>
              <p>
                <span className={`badge ${task.state}`}>{task.state}</span>
              </p>
              <p className="unavailable-copy">
                Runtime state is authoritative. Step completion and estimates are not recorded.
              </p>
            </section>
            <section className="detail-card">
              <h3>
                <WorkspaceIcon name="branch" />
                Working branch
              </h3>
              <p className="branch-name">
                {branch?.taskId === task.id
                  ? (branch.name ?? branch.error)
                  : task.workspaceId
                    ? 'Available after execution finishes.'
                    : 'No isolated worktree recorded.'}
              </p>
              {!connected && branch?.name && <small>Last received branch</small>}
            </section>
            <section className="detail-card">
              <h3>
                <WorkspaceIcon name="repository" />
                Linked pull request
              </h3>
              <p className="unavailable-copy">No pull request link is recorded by this runtime.</p>
            </section>
          </aside>
        </div>
      </section>
      <section
        id="task-content-execution"
        role="tabpanel"
        aria-labelledby="task-tab-execution"
        hidden={active !== 'execution'}
        tabIndex={0}
      >
        {execution}
      </section>
      <section
        id="task-content-changes"
        role="tabpanel"
        aria-labelledby="task-tab-changes"
        hidden={active !== 'changes'}
        tabIndex={0}
      >
        {changes}
      </section>
      <section
        id="task-content-review"
        role="tabpanel"
        aria-labelledby="task-tab-review"
        hidden={active !== 'review'}
        tabIndex={0}
      >
        {review}
      </section>
      <section
        id="task-content-history"
        role="tabpanel"
        aria-labelledby="task-tab-history"
        hidden={active !== 'history'}
        tabIndex={0}
      >
        <div className="detail-card">
          <h3>Task history</h3>
          <p className="unavailable-copy">
            Persisted runtime state events received for this task. Live logs remain in Execution.
          </p>
          <TaskTimeline task={task} events={events} />
        </div>
      </section>
      {active === 'workflow' && (
        <section
          id="task-content-workflow"
          role="tabpanel"
          aria-labelledby="task-tab-workflow"
          tabIndex={0}
        >
          {workflow}
        </section>
      )}
    </div>
  );
}
