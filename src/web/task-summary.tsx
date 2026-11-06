import type { Dashboard } from '../shared/types.js';

export function TaskSummary({ dashboard }: { dashboard?: Dashboard }) {
  const tasks = dashboard?.tasks ?? [];
  const inProgress = tasks.filter(
    (task) => task.state === 'running' || task.state === 'stopping',
  ).length;
  const completed = tasks.filter((task) => task.state === 'completed').length;

  return (
    <div className="stats" aria-label="Task workspace statistics">
      <div>
        <span>AGENT PROFILES</span>
        <strong>
          {dashboard?.agents.length ?? '—'}
          <small>saved profiles</small>
        </strong>
      </div>
      <div>
        <span>IN PROGRESS</span>
        <strong>
          {dashboard ? inProgress : '—'}
          <small>active tasks</small>
        </strong>
      </div>
      <div>
        <span>COMPLETED</span>
        <strong>
          {dashboard ? completed : '—'}
          <small>saved results</small>
        </strong>
      </div>
      <div>
        <span>ACCESS</span>
        <strong className="environment">
          SCOPED<small>Isolated writes / read-only</small>
        </strong>
      </div>
    </div>
  );
}
