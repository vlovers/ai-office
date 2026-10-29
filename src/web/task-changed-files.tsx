import type { Task } from '../shared/types.js';

export function TaskChangedFiles({ task }: { task: Task }) {
  if (task.executionMode === 'write' || ['queued', 'running', 'stopping'].includes(task.state)) {
    return null;
  }

  return (
    <div className="file-summary">
      <h3>
        Changed-file summary <span>{task.changedFiles.length}</span>
      </h3>
      <p>
        Git worktree status at finish, including pre-existing changes. The agent has read-only access.
      </p>
      {task.summaryError ? (
        <p role="alert">Summary unavailable: {task.summaryError}</p>
      ) : task.changedFiles.length ? (
        <ul>
          {task.changedFiles.map((file) => (
            <li key={file.path}>
              <code>{file.status}</code> {file.path}
              {task.baselineFiles.some((before) => before.path === file.path) && (
                <small> · present before task</small>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>No changed files in the worktree.</p>
      )}
    </div>
  );
}
