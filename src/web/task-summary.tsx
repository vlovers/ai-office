import type { Dashboard } from '../shared/types.js';

export function TaskSummary({ dashboard }: { dashboard?: Dashboard }) {
  const tasks = dashboard?.tasks ?? [];
  const inProgress = tasks.filter((task) => task.state === 'running' || task.state === 'stopping').length;
  const completed = tasks.filter((task) => task.state === 'completed').length;

  return (
    <div className="stats" aria-label="Workspace statistics">
      <div>
        <span>CODEX AGENTS</span>
        <strong>{dashboard?.agents.length ?? '—'}<small>saved profiles</small></strong>
      </div>
      <div>
        <span>IN PROGRESS</span>
        <strong>{inProgress}<small>active tasks</small></strong>
      </div>
      <div>
        <span>COMPLETED</span>
        <strong>{completed}<small>saved results</small></strong>
      </div>
      <div>
        <span>ACCESS</span>
        <strong className="environment">SCOPED<small>Isolated writes / read-only</small></strong>
      </div>
    </div>
  );
}
