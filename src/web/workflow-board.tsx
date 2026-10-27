import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Dashboard } from '../shared/types.js';
import { exportWorkflowOperationsCsv } from './workflow-operations-export.js';
import {
  selectWorkflowOperations,
  summarizeWorkflowOperations,
  workflowNeedsAttention,
  workflowTriageKind,
} from './workflow-operations.js';

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
  createdAt?: string;
  updatedAt?: string;
  stages: { kind?: string; state?: string; taskId: string | null; agentId: string }[];
};
type Report = { kind: string; taskId: string | null; result: string; error: string | null };
type Diagnostics = {
  id: string;
  version: number;
  state: string;
  findings: {
    code: string;
    severity: 'info' | 'attention' | 'blocked';
    stage: string | null;
    message: string;
    suggestedAction: string | null;
  }[];
  warning: string;
};
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

export function WorkflowBoard({
  taskId,
  inspection,
}: {
  taskId?: string;
  inspection?: { id: string; request: number };
}) {
  const [items, setItems] = useState<Summary[]>([]);
  const [stateFilter, setStateFilter] = useState('all');
  const [workflowQuery, setWorkflowQuery] = useState('');
  const [triageOnly, setTriageOnly] = useState(false);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<'recent' | 'oldest' | 'attention'>('attention');
  const [paused, setPaused] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    if (inspection) {
      setSelected(inspection.id);
      // Explicit inspection must load the requested checkpoint, including after a pause.
      setPaused(false);
      setRefreshRequired(true);
    }
  }, [inspection]);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
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
  const pollingInFlight = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // A user selection must trigger a fresh read even when the selected ID
  // equals the value already held in React state.
  const [selectionRevision, setSelectionRevision] = useState(0);
  const refresh = useCallback(
    async (force = false) => {
      // Periodic polling is serial. Explicit operator refresh supersedes any
      // in-flight poll so a mutation never silently skips its fresh read.
      if (!force && pollingInFlight.current) return;
      pollingInFlight.current = true;
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
        // Read the latest selection after the async list request. A poll started
        // before a user switched workflows must not restore its old selection.
        const currentSelection = selectedRef.current;
        const next = workflows.some((item) => item.id === currentSelection)
          ? currentSelection
          : (workflows[0]?.id ?? '');
        if (next !== currentSelection) {
          selectedRef.current = next;
          setSelected(next);
        }
        const [view, output, diagnosis] = next
          ? await Promise.all([
              request<Timeline>(`/workflows/${next}/timeline`),
              request<Report[]>(`/workflows/${next}/results`),
              request<Diagnostics>(`/workflows/${next}/diagnostics`),
            ])
          : [null, [], null];
        if (epoch !== refreshEpoch.current || next !== selectedRef.current) return;
        setTimeline(view);
        setReports(output);
        setDiagnostics(diagnosis);
        setError('');
        setRefreshRequired(false);
      } catch (cause) {
        if (epoch === refreshEpoch.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (epoch === refreshEpoch.current) pollingInFlight.current = false;
      }
    },
    [selected, taskId],
  );
  useEffect(() => {
    // Selection changes and resume must load their own snapshot even if a
    // previous generation's slow poll has not settled yet.
    if (!paused) void refresh(true);
    const timer = paused ? undefined : setInterval(() => void refresh(), 3000);
    return () => {
      if (timer) clearInterval(timer);
      refreshEpoch.current++;
      // Invalidated requests may still be pending. Their finally blocks
      // cannot clear the new epoch's lock, so reset it on effect teardown.
      pollingInFlight.current = false;
    };
  }, [refresh, paused, selectionRevision]);
  async function refreshNow() {
    // A manual read is not a mutation: do not invoke mutate(), which would
    // run the supplied refresh and then issue a second forced refresh.
    setLoading(true);
    try {
      await refresh(true);
    } finally {
      setLoading(false);
    }
  }
  async function mutate(operation: () => Promise<unknown>) {
    setLoading(true);
    setError('');
    try {
      await operation();
      await refresh(true);
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
  const needsAttention = workflowNeedsAttention;
  const triage = summarizeWorkflowOperations(items);
  const filteredWorkflows = selectWorkflowOperations(items, {
    query: workflowQuery,
    state: stateFilter,
    triageOnly,
    sort: sortBy,
  });
  const visibleWorkflows = selectedOnly
    ? filteredWorkflows.filter((item) => item.id === selected)
    : filteredWorkflows;
  const workflowChoices = filteredWorkflows;
  const staleAction = Boolean(
    action && (!timeline || action.id !== timeline.id || action.version !== timeline.version),
  );
  // Pausing polling is for inspection only, never permission to act on a stale snapshot.
  // Resume requires a new successful refresh before operator actions are enabled.
  const mutationUnavailable = loading || Boolean(error) || paused || refreshRequired;
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
  // A polling refresh can invalidate an already-selected task or profile.
  // Never submit stale form values just because their IDs remain in React state.
  const selectedCoder = unsubmitted.find((task) => task.id === coderTask);
  const selectedReviewer = profiles.some((profile) => profile.id === reviewer);
  const selectedQA = !qa || profiles.some((profile) => profile.id === qa);
  async function perform() {
    if (!action || !confirmed || staleAction || paused || refreshRequired || error) return;
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
      tabIndex={-1}
      aria-label={taskId ? 'Workflow review results' : 'Workflow timeline'}
    >
      <div className="panel-heading">
        <h2>{taskId ? 'Workflow review & QA' : 'Workflow Timeline'}</h2>
        {!taskId && (
          <button
            className="secondary"
            type="button"
            aria-pressed={paused}
            onClick={() => {
              // Discard any in-flight polling response from the previous pause state.
              refreshEpoch.current++;
              setRefreshRequired(true);
              setPaused((current) => !current);
            }}
          >
            {paused ? 'Resume live updates' : 'Pause live updates'}
          </button>
        )}
        <button className="secondary" disabled={loading} onClick={() => void mutate(refresh)}>
          Refresh workflow
        </button>
      </div>
      {paused && (
        <p role="status">Live updates are paused. Resume and refresh before changing workflows.</p>
      )}
      {!taskId && (
        <details>
          <summary>Create workflow</summary>
          <p>
            Choose an unsubmitted Coder task and read-only profiles. Each stage has a separate
            approval gate.
          </p>
          <label>
            Coder task
            <select
              aria-label="Coder task"
              value={coderTask}
              onChange={(event) => setCoderTask(event.target.value)}
            >
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
            <select
              aria-label="Reviewer profile"
              value={reviewer}
              onChange={(event) => setReviewer(event.target.value)}
            >
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
            <select
              aria-label="QA profile"
              value={qa}
              onChange={(event) => setQA(event.target.value)}
            >
              <option value="">No QA stage</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={mutationUnavailable || !selectedCoder || !selectedReviewer || !selectedQA}
            onClick={() =>
              void mutate(async () => {
                if (!selectedCoder || !selectedReviewer || !selectedQA) return;
                const created = await request<Summary>('/workflows', {
                  repositoryId: selectedCoder.repositoryId,
                  coderAgentId: selectedCoder.agentId,
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
            {paused ? 'Live updates paused · ' : 'Live updates every 3 seconds · '}
            {items.length} workflows · {counts.active} active · {counts.blocked} blocked ·{' '}
            {counts.completed} completed · {counts.cancelled} cancelled
          </p>
          <p aria-label="Workflow attention summary">
            {triage.attention} need attention · {triage.failed} failed/interrupted ·{' '}
            {triage.approval} awaiting approval · {triage.blocked} blocked · {triage.running}{' '}
            running · {triage.finished} finished
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
          <label>
            Sort workflows
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as typeof sortBy)}
            >
              <option value="attention">Attention first</option>
              <option value="recent">Recently updated</option>
              <option value="oldest">Oldest updates</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={triageOnly}
              onChange={(event) => setTriageOnly(event.target.checked)}
            />{' '}
            Needs attention (blocked, interrupted, failed or awaiting approval)
          </label>
          <label>
            <input
              type="checkbox"
              checked={selectedOnly}
              onChange={(event) => setSelectedOnly(event.target.checked)}
            />{' '}
            Show selected workflow only
          </label>
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setWorkflowQuery('');
              setStateFilter('all');
              setTriageOnly(false);
              setSelectedOnly(false);
              setSortBy('attention');
            }}
          >
            Reset workflow filters
          </button>
          <button
            className="secondary"
            type="button"
            disabled={visibleWorkflows.length === 0}
            title="Export filtered workflow metadata only. Reports, prompts and commands are excluded."
            onClick={() => {
              const csv = exportWorkflowOperationsCsv(visibleWorkflows);
              const url = URL.createObjectURL(
                new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = 'ai-office-workflow-operations.csv';
              link.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Export workflow CSV ({visibleWorkflows.length})
          </button>
          <p role="status">
            {visibleWorkflows.length} displayed · {filteredWorkflows.length} matching filters
            {selectedOnly ? ' · focused on selected workflow' : ''}
          </p>
          <p role="note">
            Attention is derived from persisted stage states, not from a live process health probe.
            An old update does not prove that a workflow is stuck. Inspect its timeline and
            execution events before stopping or cancelling anything.
          </p>
          {visibleWorkflows.length > 0 && (
            <ul aria-label="Workflow operations queue">
              {visibleWorkflows.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="secondary"
                    aria-current={item.id === selected ? 'true' : undefined}
                    onClick={() => {
                      refreshEpoch.current++;
                      setTimeline(null);
                      setReports([]);
                      setDiagnostics(null);
                      selectedRef.current = item.id;
                      setSelected(item.id);
                      setSelectionRevision((revision) => revision + 1);
                    }}
                  >
                    {item.id.slice(0, 8)} · {item.state} · v{item.version}
                  </button>{' '}
                  {needsAttention(item) && (
                    <strong>
                      {workflowTriageKind(item) === 'failed'
                        ? 'Failure to inspect'
                        : workflowTriageKind(item) === 'approval'
                          ? 'Approval required'
                          : 'Blocked checkpoint'}{' '}
                      ·{' '}
                    </strong>
                  )}
                  {item.updatedAt && (
                    <time dateTime={item.updatedAt} title={item.updatedAt}>
                      Updated {new Date(item.updatedAt).toLocaleString()}
                    </time>
                  )}{' '}
                  {item.stages
                    .filter((stage) => stage.state && stage.state !== 'pending')
                    .map((stage, index) => (
                      <span key={`${item.id}-${stage.kind ?? index}`}>
                        {stage.kind ?? 'stage'}: {stage.state}{' '}
                      </span>
                    ))}
                </li>
              ))}
            </ul>
          )}
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
                // A different selection invalidates the operator's verified snapshot.
                // Keep privileged actions fail-closed until its own timeline loads.
                setRefreshRequired(true);
                setTimeline(null);
                setReports([]);
                setDiagnostics(null);
                selectedRef.current = event.target.value;
                setSelected(event.target.value);
                setSelectionRevision((revision) => revision + 1);
              }}
            >
              {selected && !workflowChoices.some((item) => item.id === selected) && (
                <option value={selected} disabled>
                  Selected workflow (outside current filters)
                </option>
              )}
              {workflowChoices.map((item) => (
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
              {diagnostics &&
                diagnostics.id === timeline.id &&
                diagnostics.version === timeline.version && (
                  <section aria-label="Workflow diagnostics">
                    <h3>Persisted checkpoint diagnostics</h3>
                    {diagnostics.findings.length === 0 ? (
                      <p>No persisted checkpoint findings.</p>
                    ) : (
                      <ul>
                        {diagnostics.findings.map((finding, index) => (
                          <li key={`${finding.code}-${finding.stage ?? 'workflow'}-${index}`}>
                            <strong>{finding.severity.toUpperCase()}</strong> ·{' '}
                            {finding.stage ?? 'workflow'} — {finding.message}
                            {finding.suggestedAction && (
                              <p>
                                Suggested checkpoint:{' '}
                                {labels[finding.suggestedAction] ?? finding.suggestedAction}. Review
                                the stage and confirm explicitly below.
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p role="note">{diagnostics.warning}</p>
                  </section>
                )}
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
                        disabled={mutationUnavailable}
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
                        disabled={mutationUnavailable}
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
                    disabled={mutationUnavailable}
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
                  mutationUnavailable ||
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
