import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Dashboard } from '../shared/types.js';

type Stage = {
  kind: 'coder' | 'reviewer' | 'qa';
  agentId: string;
  agentRevision: number;
  mode: string;
  status: string;
  taskId: string | null;
  nextAction: string | null;
  evidenceRevision: string | null;
  approvalRevision: string | null;
  reportDigest: string | null;
  sourceDigest: string | null;
};
type Timeline = { id: string; version: number; state: string; stages: Stage[]; notice: string };
type Summary = {
  id: string;
  version: number;
  state: string;
  repositoryId: string;
  stages: { taskId: string | null; agentId: string }[];
};
type Report = { kind: string; taskId: string | null; result: string; error: string | null };
const labels: Record<string, string> = {
  'approve-initial': 'Approve Coder baseline',
  'bind-coder-task': 'Bind Coder task',
  'submit-initial': 'Start Coder',
  'capture-coder-evidence': 'Capture Coder evidence',
  'approve-coder-evidence': 'Approve Coder evidence',
  'approve-reviewer': 'Approve Reviewer input',
  'prepare-reviewer': 'Prepare Reviewer snapshot',
  'submit-reviewer': 'Start Reviewer',
  'approve-reviewer-result': 'Approve Reviewer result',
  'approve-qa': 'Approve QA command',
  'submit-qa': 'Start QA',
  'approve-qa-result': 'Approve QA result',
  cancel: 'Cancel workflow',
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    '/api' + path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? `Workflow request failed: HTTP ${response.status}`);
  return value as T;
}

export function WorkflowBoard({ taskId }: { taskId?: string }) {
  const [items, setItems] = useState<Summary[]>([]);
  const [stateFilter, setStateFilter] = useState('all');
  const [workflowQuery, setWorkflowQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [commands, setCommands] = useState<{ commandId: string; argv: string[] }[]>([]);
  const [commandId, setCommandId] = useState('');
  const [coderTask, setCoderTask] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [qa, setQA] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<{
    name: string;
    stage: Stage;
    version: number;
    id: string;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const refreshEpoch = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++refreshEpoch.current;
    try {
      const [all, current, choices] = await Promise.all([
        request<Summary[]>('/workflows'),
        request<Dashboard>('/dashboard'),
        request<{ commands: { commandId: string; argv: string[] }[] }>('/workflows/qa-commands'),
      ]);
      if (epoch !== refreshEpoch.current) return;
      const workflows = taskId ? all.filter((item) => item.stages[0]?.taskId === taskId) : all;
      setItems(workflows);
      setDashboard(current);
      setCommands(choices.commands);
      const next = workflows.some((item) => item.id === selected)
        ? selected
        : (workflows[0]?.id ?? '');
      setSelected(next);
      const [view, output] = next
        ? await Promise.all([
            request<Timeline>(`/workflows/${next}/timeline`),
            request<Report[]>(`/workflows/${next}/results`),
          ])
        : [null, []];
      if (epoch !== refreshEpoch.current) return;
      setTimeline(view);
      setReports(output);
      setError('');
    } catch (cause) {
      if (epoch === refreshEpoch.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [selected, taskId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      clearInterval(timer);
      refreshEpoch.current++;
    };
  }, [refresh]);
  async function mutate(operation: () => Promise<unknown>) {
    setLoading(true);
    setError('');
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
  const chosen = items.find((item) => item.id === selected);
  const counts = {
    active: items.filter((item) => item.state === 'active').length,
    blocked: items.filter((item) => item.state === 'blocked').length,
    completed: items.filter((item) => item.state === 'completed').length,
    cancelled: items.filter((item) => item.state === 'cancelled').length,
  };
  const visibleWorkflows = items.filter(
    (item) =>
      (stateFilter === 'all' || item.state === stateFilter) &&
      (item.id.toLowerCase().includes(workflowQuery.trim().toLowerCase()) ||
        item.repositoryId.toLowerCase().includes(workflowQuery.trim().toLowerCase())),
  );
  const staleAction = Boolean(
    action && (!timeline || action.id !== timeline.id || action.version !== timeline.version),
  );
  const unsubmitted =
    dashboard?.tasks.filter(
      (task) =>
        task.executionMode === 'write' &&
        task.state === 'queued' &&
        !dashboard.queue.some((entry) => entry.taskId === task.id) &&
        !items.some((item) => item.stages.some((stage) => stage.taskId === task.id)),
    ) ?? [];
  const profiles =
    dashboard?.profiles?.filter(
      (profile) => !profile.archived && profile.maximumMode === 'read-only',
    ) ?? [];
  async function perform() {
    if (!action || !confirmed || staleAction) return;
    const body: Record<string, unknown> = { version: action.version, confirmed: true };
    let endpoint = action.name;
    if (action.name === 'bind-coder-task') {
      endpoint = 'bind-task';
      body.taskId = coderTask;
    }
    if (action.name === 'submit-initial') body.confirmedWrite = true;
    if (['approve-coder-evidence', 'approve-reviewer', 'approve-qa'].includes(action.name))
      body.revision = action.stage.evidenceRevision ?? timeline?.stages[0]?.evidenceRevision;
    if (action.name === 'approve-qa') body.commandId = commandId;
    if (action.name.endsWith('-result')) body.digest = action.stage.reportDigest;
    await request(`/workflows/${action.id}/${endpoint}`, body);
    dialog.current?.close();
    setAction(null);
    setConfirmed(false);
  }
  return (
    <section
      className="panel"
      id={taskId ? undefined : 'workflows'}
      aria-label={taskId ? 'Workflow review results' : 'Workflow timeline'}
    >
      <div className="panel-heading">
        <h2>{taskId ? 'Workflow review & QA' : 'Workflow Timeline'}</h2>
        <button className="secondary" disabled={loading} onClick={() => void mutate(refresh)}>
          Refresh workflow
        </button>
      </div>
      {!taskId && (
        <details>
          <summary>Create workflow</summary>
          <p>
            Choose an unsubmitted Coder task and read-only profiles. Each stage has a separate
            approval gate.
          </p>
          <label>
            Coder task
            <select value={coderTask} onChange={(event) => setCoderTask(event.target.value)}>
              <option value="">Select Coder task</option>
              {unsubmitted.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reviewer profile
            <select value={reviewer} onChange={(event) => setReviewer(event.target.value)}>
              <option value="">Select Reviewer</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            QA profile
            <select value={qa} onChange={(event) => setQA(event.target.value)}>
              <option value="">No QA stage</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={loading || !coderTask || !reviewer}
            onClick={() =>
              void mutate(async () => {
                const task = dashboard!.tasks.find((item) => item.id === coderTask)!;
                const created = await request<Summary>('/workflows', {
                  repositoryId: task.repositoryId,
                  coderAgentId: task.agentId,
                  reviewerAgentId: reviewer,
                  ...(qa ? { qaAgentId: qa } : {}),
                });
                setSelected(created.id);
              })
            }
          >
            Create gated workflow
          </button>
        </details>
      )}
      {error && <p role="alert">{error} Refresh workflow before trying another action.</p>}
      {!taskId && items.length > 0 && (
        <div aria-label="Workflow operations overview">
          <p role="status">
            {items.length} workflows · {counts.active} active · {counts.blocked} blocked ·{' '}
            {counts.completed} completed · {counts.cancelled} cancelled
          </p>
          <label>
            Find workflow by ID or repository
            <input
              type="search"
              value={workflowQuery}
              onChange={(event) => setWorkflowQuery(event.target.value)}
              placeholder="Workflow or repository ID"
            />
          </label>
          <label>
            Workflow state
            <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
              <option value="all">All states</option>
              <option value="active">Active</option>
              <option value="blocked">Blocked</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          {visibleWorkflows.length === 0 && (
            <p role="status">No workflows match the current filters.</p>
          )}
        </div>
      )}
      {!items.length && <p>No workflows created yet.</p>}
      {items.length > 0 && (
        <>
          <label>
            Workflow
            <select
              aria-label="Workflow"
              value={selected}
              onChange={(event) => {
                refreshEpoch.current++;
                setTimeline(null);
                setReports([]);
                setSelected(event.target.value);
              }}
            >
              {visibleWorkflows.some((item) => item.id === selected) ? null : (
                <option value={selected} disabled>
                  Selected workflow (outside current filters)
                </option>
              )}
              {visibleWorkflows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id.slice(0, 8)} · {item.state} · v{item.version}
                </option>
              ))}
            </select>
          </label>
          {timeline && timeline.id === selected && (
            <>
              <p role="status">
                State: {timeline.state} · version {timeline.version}
              </p>
              <ol>
                {timeline.stages.map((stage) => (
                  <li key={stage.kind}>
                    <strong>{stage.kind.toUpperCase()}</strong> — {stage.status}
                    <p>
                      {stage.agentId} · profile v{stage.agentRevision} · {stage.mode}
                    </p>
                    {stage.evidenceRevision && (
                      <p>
                        Evidence: <code>{stage.evidenceRevision}</code>
                      </p>
                    )}
                    {stage.sourceDigest && (
                      <p>
                        Snapshot: <code>{stage.sourceDigest}</code>
                      </p>
                    )}
                    {reports
                      .filter((report) => report.kind === stage.kind)
                      .map((report) => (
                        <div key={report.kind}>
                          {report.result && (
                            <details open>
                              <summary>{stage.kind.toUpperCase()} report</summary>
                              <pre className="result-text">{report.result}</pre>
                            </details>
                          )}
                          {report.error && <p role="alert">{report.error}</p>}
                        </div>
                      ))}
                    {stage.nextAction && (
                      <button
                        disabled={loading}
                        onClick={() => {
                          setAction({
                            name: stage.nextAction!,
                            stage,
                            version: timeline.version,
                            id: timeline.id,
                          });
                          setConfirmed(false);
                          setError('');
                          dialog.current?.showModal();
                        }}
                      >
                        {labels[stage.nextAction] ?? stage.nextAction}
                      </button>
                    )}
                    {stage.status === 'running' && stage.taskId && (
                      <button
                        className="secondary"
                        disabled={loading}
                        onClick={() =>
                          void mutate(() => request(`/tasks/${stage.taskId}/stop`, {}))
                        }
                      >
                        Stop {stage.kind}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              <p role="note">{timeline.notice}</p>
              {['active', 'blocked'].includes(timeline.state) &&
                !timeline.stages.some((stage) => stage.status === 'running') && (
                  <button
                    className="secondary"
                    disabled={loading}
                    onClick={() => {
                      setAction({
                        name: 'cancel',
                        stage: timeline.stages[0]!,
                        version: timeline.version,
                        id: timeline.id,
                      });
                      setConfirmed(false);
                      dialog.current?.showModal();
                    }}
                  >
                    Cancel workflow
                  </button>
                )}
            </>
          )}
        </>
      )}
      <dialog
        ref={dialog}
        aria-label="Confirm workflow checkpoint"
        onCancel={() => {
          setAction(null);
          setConfirmed(false);
        }}
      >
        {action && (
          <>
            <h3>{labels[action.name]}</h3>
            <p>
              Workflow {action.id.slice(0, 8)} · version {action.version} · pinned profile v
              {action.stage.agentRevision}
            </p>
            <p>
              Revision:{' '}
              <code>
                {action.stage.evidenceRevision ??
                  action.stage.approvalRevision ??
                  timeline?.stages[0]?.evidenceRevision}
              </code>
            </p>
            {action.name === 'submit-initial' && (
              <p>This starts Coder with write access in an isolated worktree.</p>
            )}
            {action.name === 'bind-coder-task' && (
              <label>
                Bind Coder task
                <select value={coderTask} onChange={(event) => setCoderTask(event.target.value)}>
                  <option value="">Select task</option>
                  {unsubmitted
                    .filter(
                      (task) =>
                        task.agentId === action.stage.agentId &&
                        task.repositoryId === chosen?.repositoryId,
                    )
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {action.name === 'approve-qa' && (
              <label>
                Approved QA command
                <select value={commandId} onChange={(event) => setCommandId(event.target.value)}>
                  <option value="">Select command</option>
                  {commands.map((command) => (
                    <option key={command.commandId} value={command.commandId}>
                      {command.commandId}: {JSON.stringify(command.argv)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {action.stage.reportDigest && (
              <p>
                Report digest: <code>{action.stage.reportDigest}</code>
              </p>
            )}
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I approve this exact checkpoint
            </label>
            {error && <p role="alert">{error}</p>}
            {staleAction && (
              <p role="alert">
                The workflow changed. Close this dialog and inspect the current checkpoint.
              </p>
            )}
            <div className="button-row">
              <button
                disabled={
                  loading ||
                  staleAction ||
                  !confirmed ||
                  (action.name === 'approve-qa' && !commandId) ||
                  (action.name === 'bind-coder-task' && !coderTask)
                }
                onClick={() => void mutate(perform)}
              >
                Confirm checkpoint
              </button>
              <button
                className="secondary"
                disabled={loading}
                onClick={() => {
                  dialog.current?.close();
                  setAction(null);
                }}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
