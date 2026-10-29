import type { AgentId, Dashboard } from '../shared/types.js';

export function SubmittedQueue({
  dashboard,
  onSelect,
}: {
  dashboard?: Dashboard;
  onSelect: (taskId: string, agentId: AgentId) => void;
}) {
  if (!dashboard?.queue.length) return null;

  return (
    <section className="panel queue-panel" aria-label="Submitted queue">
      <div className="panel-heading">
        <h2>Submitted queue</h2>
        <span>{dashboard.queue.length} / 100</span>
      </div>
      <ol>
        {dashboard.queue.map((entry) => (
          <li key={entry.taskId}>
            <button
              type="button"
              className="secondary"
              onClick={() => onSelect(entry.taskId, entry.agentId)}
            >
              {dashboard.tasks.find((task) => task.id === entry.taskId)?.title ?? 'Untitled task'} ·{' '}
              {entry.agentId}
              <small> / {entry.waitingReason}</small>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
