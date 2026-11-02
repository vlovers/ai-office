import type { Dashboard, Task } from '../shared/types.js';
import type { TaskHistoryOrder, TaskHistoryStatus } from './task-history-operations.js';
import { exportTaskHistoryCsv } from './task-history-export.js';

export function TaskHistory({
  dashboard,
  visibleHistory,
  taskSummary,
  historyQuery,
  historyStatus,
  historyOrder,
  historyAgent,
  historyRepository,
  selected,
  onQueryChange,
  onStatusChange,
  onOrderChange,
  onAgentChange,
  onRepositoryChange,
  onSelectTask,
}: {
  dashboard?: Dashboard;
  visibleHistory: Task[];
  taskSummary: {
    total: number;
    active: number;
    queued: number;
    attention: number;
    completed: number;
  };
  historyQuery: string;
  historyStatus: TaskHistoryStatus;
  historyOrder: TaskHistoryOrder;
  historyAgent: string;
  historyRepository: string;
  selected?: string;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: TaskHistoryStatus) => void;
  onOrderChange: (value: TaskHistoryOrder) => void;
  onAgentChange: (value: string) => void;
  onRepositoryChange: (value: string) => void;
  onSelectTask: (task: Task) => void;
}) {
  return (
    <section className="panel history" id="task-history">
      <div className="panel-heading">
        <h2>Task history</h2>
        <span className="subtle">{dashboard?.tasks.length ?? 0} tasks</span>
      </div>
      {!!dashboard?.tasks.length && (
        <div className="history-controls" aria-label="Task history filters">
          <button
            type="button"
            className="secondary"
            disabled={visibleHistory.length === 0}
            title="Export filtered task metadata only. Prompts, logs and paths are excluded."
            onClick={() => {
              const csv = exportTaskHistoryCsv(visibleHistory);
              const url = URL.createObjectURL(
                new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = 'ai-office-task-history.csv';
              link.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Export filtered CSV ({visibleHistory.length})
          </button>
          <p role="status">
            {taskSummary.active} active · {taskSummary.queued} queued · {taskSummary.attention}{' '}
            failed/interrupted · {taskSummary.completed} completed
          </p>
          <label>
            Search tasks
            <input
              type="search"
              value={historyQuery}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Title or task ID"
            />
          </label>
          <label>
            Task state
            <select
              value={historyStatus}
              onChange={(event) => onStatusChange(event.target.value as TaskHistoryStatus)}
            >
              <option value="all">All states</option>
              <option value="attention">Failed / interrupted</option>
              <option value="active">Running / stopping</option>
              <option value="queued">Queued</option>
              <option value="completed">Completed</option>
            </select>
          </label>
          <label>
            Agent
            <select value={historyAgent} onChange={(event) => onAgentChange(event.target.value)}>
              <option value="">All agents</option>
              {dashboard?.agents.map((slot) => (
                <option key={slot.id} value={slot.id}>
                  {slot.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Repository
            <select
              value={historyRepository}
              onChange={(event) => onRepositoryChange(event.target.value)}
            >
              <option value="">All repositories</option>
              {dashboard?.repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Sort
            <select
              value={historyOrder}
              onChange={(event) => onOrderChange(event.target.value as TaskHistoryOrder)}
            >
              <option value="attention">Attention first</option>
              <option value="recent">Most recently updated</option>
              <option value="oldest">Oldest updates</option>
            </select>
          </label>
          <p role="status">
            {visibleHistory.length} of {taskSummary.total} tasks shown
          </p>
          {(historyQuery ||
            historyStatus !== 'all' ||
            historyAgent ||
            historyRepository ||
            historyOrder !== 'attention') && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                onQueryChange('');
                onStatusChange('all');
                onOrderChange('attention');
                onAgentChange('');
                onRepositoryChange('');
              }}
            >
              Reset task filters
            </button>
          )}
        </div>
      )}
      {!dashboard?.tasks.length ? (
        <div className="empty-state">
          <div>☷</div>
          <h3>No reviews yet.</h3>
          <p>
            Your tasks and their results will appear here.
            <br />
            Choose a repository and describe your first read-only review.
          </p>
          <a href={dashboard?.repositories.length ? '#compose' : '#repositories'}>
            {dashboard?.repositories.length ? 'Create your first task →' : 'Register a worktree →'}
          </a>
        </div>
      ) : (
        <div className="task-list">
          {visibleHistory.map((item) => (
            <button
              key={item.id}
              aria-pressed={selected === item.id}
              className={`task-row ${selected === item.id ? 'selected' : ''}`}
              onClick={() => {
                onSelectTask(item);
              }}
            >
              <span className={`task-indicator ${item.state}`} />
              <span>
                <strong>{item.title}</strong>
                <small>
                  {item.agentId} ·{' '}
                  {dashboard.repositories.find((r) => r.id === item.repositoryId)?.name} ·{' '}
                  {new Date(item.createdAt).toLocaleString()}
                </small>
              </span>
              <span className={`badge ${item.state}`}>{item.state}</span>
            </button>
          ))}
          {visibleHistory.length === 0 && (
            <p role="status">
              No tasks match these filters. Reset filters to see the full history.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
