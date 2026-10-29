import type { Dashboard, Task } from '../shared/types.js';
import type { TaskDestination } from './task-navigation.js';
import { encodeTaskNavigation, taskHasReview } from './task-navigation.js';
import type { ReactNode } from 'react';

export function TaskSessionControls({
  task, repositoryName, dashboard, queued, taskConfiguration, resumeSessionId,
  busy, stopPending, showStopControl, stopControl, onNavigate, onFocus,
  onResumeSessionChange, onStartTask, onStopTask,
}: {
  task: Task;
  repositoryName?: string;
  dashboard?: Dashboard;
  queued?: { agentId: string; order: number; waitingReason?: string };
  taskConfiguration?: NonNullable<Task['configuration']>;
  resumeSessionId: string;
  busy: boolean;
  stopPending: boolean;
  showStopControl: boolean;
  stopControl: ReactNode;
  onNavigate: (task: Task, destination: TaskDestination) => void;
  onFocus: () => void;
  onResumeSessionChange: (id: string) => void;
  onStartTask: () => void;
  onStopTask: () => void;
}) {
  const repository = { name: repositoryName };
  return (
    <>
                    <div className="task-toolbar">
                      <span>
                        <span className={`badge ${task.state}`}>{task.state}</span>{' '}
                        {repository?.name} ·{' '}
                        {task.executionMode === 'write' ? 'Isolated write' : 'Read only'}
                      </span>
                      <nav className="task-navigation" aria-label="Selected task navigation">
                        <a
                          href={encodeTaskNavigation({ taskId: task.id, destination: 'session' })}
                          onClick={(event) => {
                            event.preventDefault();
                            onNavigate(task, 'session');
                          }}
                        >
                          Session
                        </a>
                        {taskHasReview(task) && (
                          <a
                            href={encodeTaskNavigation({ taskId: task.id, destination: 'review' })}
                            onClick={(event) => {
                              event.preventDefault();
                              onNavigate(task, 'review');
                            }}
                          >
                            Code review
                          </a>
                        )}
                        <a
                          href={encodeTaskNavigation({ taskId: task.id, destination: 'workflow' })}
                          onClick={(event) => {
                            event.preventDefault();
                            onNavigate(task, 'workflow');
                          }}
                        >
                          Workflow &amp; QA
                        </a>
                      </nav>
                      {showStopControl && stopControl}
                      {task.workspaceId &&
                        !['queued', 'running', 'stopping'].includes(task.state) && (
                          <a
                            className="review-shortcut"
                            href="#code-review-center"
                            onClick={onFocus}
                          >
                            Code Review Center ↗
                          </a>
                        )}
                      {task.state === 'queued' && !queued && (
                        <div className="start-controls">
                          <select
                            aria-label="Session"
                            value={resumeSessionId}
                            onChange={(e) => onResumeSessionChange(e.target.value)}
                          >
                            <option value="">New Codex session</option>
                            {dashboard?.sessions
                              .filter(
                                (s) =>
                                  s.agentId === task.agentId &&
                                  s.repositoryId === task.repositoryId &&
                                  s.threadId &&
                                  s.authMode === dashboard.connection.mode &&
                                  (s.executionMode ?? 'read-only') ===
                                    (task.executionMode ?? 'read-only'),
                              )
                              .map((s) => (
                                <option key={s.id} value={s.id}>
                                  Resume {s.threadId?.slice(0, 12)}… · pinned{' '}
                                  {s.configuration?.source === 'legacy'
                                    ? 'legacy'
                                    : `v${s.configuration?.profileRevision ?? '?'}`}
                                </option>
                              ))}
                          </select>
                          {resumeSessionId && (
                            <small>
                              Resumes the original pinned configuration; current profile edits do
                              not apply.
                            </small>
                          )}
                          <button
                            disabled={busy || !dashboard?.ready}
                            onClick={onStartTask}
                          >
                            ▶ Start task
                          </button>
                        </div>
                      )}
                    </div>
                    {queued && (
                      <div className="queue-notice" role="status">
                        Submitted / {queued.agentId} / queue #{queued.order}. {queued.waitingReason}
                        <button
                          className="secondary"
                          disabled={stopPending}
                          onClick={onStopTask}
                        >
                          Cancel queued task
                        </button>
                      </div>
                    )}
                    {taskConfiguration && (
                      <details className="configuration-record">
                        <summary>
                          Pinned configuration · {taskConfiguration.name} ·{' '}
                          {taskConfiguration.source === 'legacy'
                            ? 'legacy v0.5'
                            : `v${taskConfiguration.profileRevision}`}
                        </summary>
                        <p>
                          Current profile v
                          {dashboard?.profiles?.find((profile) => profile.id === task.agentId)
                            ?.revision ?? 'unavailable'}
                          . This task retains its submitted configuration.
                        </p>
                        <p>
                          {taskConfiguration.executionMode} ·{' '}
                          {taskConfiguration.model ??
                            'Connection default (resolved before execution)'}{' '}
                          · {taskConfiguration.policy}
                        </p>
                        <pre>
                          {taskConfiguration.role}
                          {'\n'}
                          {taskConfiguration.instructions}
                        </pre>
                      </details>
                    )}

    </>
  );
}
