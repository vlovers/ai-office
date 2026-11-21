import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentProfile } from '../shared/types.js';
import type {
  ContextContent,
  OrchestrationSnapshot,
  Plan,
  PlanValidation,
  Proposal,
  WorkflowTemplate,
} from '../shared/orchestration.js';
import { WorkflowBoard } from './workflow-board.js';

export type ProjectSection = 'lead' | 'templates' | 'context';
async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal: signal ?? AbortSignal.timeout(15000),
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Request failed: HTTP ${response.status}; invalid JSON.`);
  }
  if (!response.ok) throw new Error(value.error ?? `Request failed: HTTP ${response.status}`);
  return value as T;
}
const emptyContext: ContextContent = { brief: '', requirements: '', constraints: '', roadmap: '' };
const newProposal = (): Proposal => ({
  title: '',
  prompt: '',
  stages: [
    {
      kind: 'coder',
      agentId: '',
      dependsOn: [],
      entryCondition: 'operator_approval',
      estimateMinutes: null,
    },
    {
      kind: 'reviewer',
      agentId: '',
      dependsOn: ['coder'],
      entryCondition: 'approved_coder_evidence',
      estimateMinutes: null,
    },
  ],
  constraints: { maxWorkers: 2, estimatedMinutesBudget: null },
  includeContext: false,
});

/** Keying the entire component cancels old reads and discards drafts on repository switches. */
export function ProjectWorkspace(props: { repositoryId: string; section: ProjectSection }) {
  return <RepositoryWorkspace key={props.repositoryId} {...props} />;
}
function RepositoryWorkspace({
  repositoryId,
  section,
}: {
  repositoryId: string;
  section: ProjectSection;
}) {
  const root = `/api/repositories/${encodeURIComponent(repositoryId)}`;
  const [snapshot, setSnapshot] = useState<OrchestrationSnapshot | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal>(newProposal);
  const [selected, setSelected] = useState<Plan | WorkflowTemplate | null>(null);
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [context, setContext] = useState<ContextContent>(emptyContext);
  const [contextBase, setContextBase] = useState<number | null>(null);
  const [editingContext, setEditingContext] = useState(false);
  const [history, setHistory] = useState<
    { revision: number; provenance: { savedAt: string | null } }[]
  >([]);
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState<PlanValidation | null>(null);
  const alive = useRef(true);
  const readSequence = useRef(0);
  const controller = useRef(new AbortController());
  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    try {
      const [data, current] = await Promise.all([
        request<OrchestrationSnapshot>(
          root + '/orchestration',
          'GET',
          undefined,
          AbortSignal.any([controller.current.signal, AbortSignal.timeout(15000)]),
        ),
        request<AgentProfile[]>(
          '/api/agents',
          'GET',
          undefined,
          AbortSignal.any([controller.current.signal, AbortSignal.timeout(15000)]),
        ),
      ]);
      if (!alive.current || sequence !== readSequence.current) return;
      if (
        data.repositoryId !== repositoryId ||
        !Array.isArray(data.plans) ||
        !Array.isArray(data.templates) ||
        !Array.isArray(data.runs) ||
        !Array.isArray(current) ||
        current.some(
          (profile) =>
            typeof profile.id !== 'string' ||
            typeof profile.name !== 'string' ||
            typeof profile.archived !== 'boolean' ||
            !['write', 'read-only'].includes(profile.maximumMode),
        ) ||
        !data.context ||
        !data.capabilities ||
        data.branch?.readOnly !== true
      )
        throw new Error('Invalid repository snapshot. Refresh before making changes.');
      setSnapshot(data);
      setProfiles(current);
      setFresh(true);
      setError('');
    } catch (cause) {
      if (!alive.current || sequence !== readSequence.current) return;
      setFresh(false);
      setError(cause instanceof Error ? cause.message : 'Server disconnected.');
    }
  }, [repositoryId, root]);
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    void refresh();
    const interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3000);
    return () => {
      alive.current = false;
      controller.current.abort();
      clearInterval(interval);
    };
  }, [refresh]);
  const mutate = async <T,>(
    path: string,
    method: string,
    body: unknown,
    accept?: (value: T) => void,
  ) => {
    if (!fresh || busy) return;
    setBusy(true);
    setError('');
    // Do not retry a mutation automatically, including after connection loss.
    try {
      const value = await request<T>(root + path, method, body);
      if (!alive.current) return;
      accept?.(value);
      setConfirmed(false);
      await refresh();
    } catch (cause) {
      if (alive.current) {
        setFresh(false);
        setError(cause instanceof Error ? cause.message : 'Request failed.');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const choose = (record: Plan | WorkflowTemplate, template: boolean) => {
    setSelected(record);
    setProposal(structuredClone(record.proposal));
    setEditingTemplate(template);
    setConfirmed(false);
  };
  const currentPlan =
    selected && !editingTemplate
      ? snapshot?.plans.find((plan) => plan.id === selected.id)
      : undefined;
  const run = currentPlan
    ? snapshot?.runs.find((item) => item.planId === currentPlan.id)
    : undefined;
  const locked = Boolean(currentPlan?.workflowId);
  const draftMatches = selected && JSON.stringify(proposal) === JSON.stringify(selected.proposal);
  useEffect(() => {
    setConfirmed(false);
    setValidation(null);
  }, [currentPlan?.version, snapshot?.context.revision]);
  const saveProposal = (template: boolean) => {
    const matching = selected && template === editingTemplate;
    const path = template ? '/workflow-templates' : '/plans';
    void mutate<Plan | WorkflowTemplate>(
      path + (matching ? '/' + selected.id : ''),
      matching ? 'PUT' : 'POST',
      matching
        ? {
            version: selected.version,
            proposal,
            ...(template ? { archived: (selected as WorkflowTemplate).archived } : {}),
          }
        : { proposal },
      (value) => choose(value, template),
    );
  };
  const updateStage = (index: number, patch: Partial<Proposal['stages'][number]>) =>
    setProposal({
      ...proposal,
      stages: proposal.stages.map((stage, position) =>
        position === index ? { ...stage, ...patch } : stage,
      ),
    });
  return (
    <section aria-label="Project orchestration" className="settings-destination">
      <div className="destination-intro">
        <h2>
          {section === 'lead'
            ? 'Lead Agent'
            : section === 'templates'
              ? 'Workflow templates'
              : 'Project Context'}
        </h2>
        <p>
          {snapshot
            ? `Branch: ${snapshot.branch.name ?? 'detached HEAD'} · read-only selector · ${snapshot.branch.revision.slice(0, 12)}`
            : 'Loading repository…'}
        </p>
        <button onClick={() => void refresh()} disabled={busy}>
          Refresh project data
        </button>
      </div>
      {error && <p role="alert">{error} Actions are locked until a successful refresh.</p>}
      {!snapshot && !error && <p role="status">Loading persisted project data…</p>}
      {snapshot && (
        <>
          <p role="status">
            {fresh
              ? snapshot.capabilities.executionMessage
              : 'Disconnected. Showing the last received snapshot.'}
          </p>
          {section === 'context' ? (
            <section className="panel" aria-label="Repository context">
              <h3>Repository brief and constraints</h3>
              <p>
                Operator supplied · revision {snapshot.context.revision} ·{' '}
                {snapshot.context.provenance.savedAt ?? 'No saved context'}. Context is reference
                data and cannot grant permissions.
              </p>
              <fieldset disabled={!fresh || busy}>
                {(['brief', 'requirements', 'constraints', 'roadmap'] as const).map((field) => (
                  <label key={field}>
                    {field[0]!.toUpperCase() + field.slice(1)}
                    <textarea
                      aria-label={field[0]!.toUpperCase() + field.slice(1)}
                      rows={field === 'brief' ? 4 : 3}
                      maxLength={field === 'brief' ? 4000 : 2000}
                      readOnly={!editingContext}
                      value={editingContext ? context[field] : snapshot.context.content[field]}
                      onChange={(event) => setContext({ ...context, [field]: event.target.value })}
                    />
                  </label>
                ))}
                {!editingContext ? (
                  <button
                    onClick={() => {
                      setContext(structuredClone(snapshot.context.content));
                      setContextBase(snapshot.context.revision);
                      setEditingContext(true);
                    }}
                  >
                    Edit context
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() =>
                        void mutate(
                          '/context',
                          'PUT',
                          { revision: contextBase, content: context },
                          () => setEditingContext(false),
                        )
                      }
                    >
                      Save context
                    </button>
                    <button onClick={() => setEditingContext(false)}>Discard context edits</button>
                  </>
                )}
                <button
                  onClick={() =>
                    void request<typeof history>(root + '/context/history')
                      .then((value) => {
                        if (alive.current) setHistory(value);
                      })
                      .catch((cause: Error) => {
                        if (alive.current) {
                          setFresh(false);
                          setError(cause.message);
                        }
                      })
                  }
                >
                  Load context history
                </button>
                <ol>
                  {history.map((item) => (
                    <li key={item.revision}>
                      Revision {item.revision} · {item.provenance.savedAt}
                      <button
                        disabled={editingContext || item.revision === snapshot.context.revision}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Restore context revision ${item.revision} as a new revision?`,
                            )
                          )
                            void mutate('/context/revert', 'POST', {
                              revision: snapshot.context.revision,
                              targetRevision: item.revision,
                              confirmed: true,
                            });
                        }}
                      >
                        Restore revision {item.revision}
                      </button>
                    </li>
                  ))}
                </ol>
              </fieldset>
            </section>
          ) : (
            <>
              <section className="panel" aria-label="Saved proposals and templates">
                <h3>{section === 'lead' ? 'Saved proposals' : 'Repository templates'}</h3>
                <button
                  disabled={!fresh || busy}
                  onClick={() => {
                    setSelected(null);
                    setProposal(newProposal());
                    setEditingTemplate(section === 'templates');
                    setConfirmed(false);
                  }}
                >
                  New {section === 'lead' ? 'proposal' : 'template'}
                </button>
                <ul>
                  {(section === 'lead' ? snapshot.plans : snapshot.templates).map((record) => (
                    <li key={record.id}>
                      <button
                        disabled={!fresh || busy}
                        onClick={() => choose(record, section === 'templates')}
                      >
                        {record.proposal.title}
                        {'archived' in record && record.archived ? ' (archived)' : ''}
                      </button>
                    </li>
                  ))}
                </ul>
                {!(section === 'lead' ? snapshot.plans : snapshot.templates).length && (
                  <p>
                    No saved {section === 'lead' ? 'proposals' : 'templates'} in this repository.
                  </p>
                )}
              </section>
              <section className="panel" aria-label="Proposal editor">
                <h3>{editingTemplate ? 'Template definition' : 'Operator-authored proposal'}</h3>
                <p>{snapshot.capabilities.modelPlanningReason}</p>
                <button disabled title={snapshot.capabilities.modelPlanningReason}>
                  Generate plan — unavailable
                </button>
                <fieldset disabled={!fresh || busy || locked}>
                  <label>
                    Plan title
                    <input
                      value={proposal.title}
                      maxLength={160}
                      onChange={(event) => setProposal({ ...proposal, title: event.target.value })}
                    />
                  </label>
                  <label>
                    Objective
                    <textarea
                      aria-label="Objective"
                      rows={4}
                      value={proposal.prompt}
                      maxLength={6000}
                      onChange={(event) => setProposal({ ...proposal, prompt: event.target.value })}
                    />
                  </label>
                  <ol aria-label="Proposed stages">
                    {proposal.stages.map((stage, index) => (
                      <li key={stage.kind}>
                        <h4>
                          {stage.kind === 'coder'
                            ? 'Implement'
                            : stage.kind === 'reviewer'
                              ? 'Review'
                              : 'Test'}{' '}
                          · {stage.entryCondition.replaceAll('_', ' ')}
                        </h4>
                        <p>
                          Depends on: {stage.dependsOn.join(', ') || 'explicit baseline approval'}
                        </p>
                        <label>
                          {stage.kind} agent
                          <select
                            aria-label={`${stage.kind} agent`}
                            value={stage.agentId}
                            onChange={(event) =>
                              updateStage(index, { agentId: event.target.value })
                            }
                          >
                            <option value="">Choose a profile</option>
                            {stage.agentId &&
                              !profiles?.some(
                                (profile) =>
                                  profile.id === stage.agentId &&
                                  !profile.archived &&
                                  profile.maximumMode ===
                                    (stage.kind === 'coder' ? 'write' : 'read-only'),
                              ) && (
                                <option value={stage.agentId} disabled>
                                  {profiles?.find((profile) => profile.id === stage.agentId)
                                    ?.name ?? stage.agentId}{' '}
                                  · no longer eligible
                                </option>
                              )}
                            {profiles
                              ?.filter(
                                (profile) =>
                                  !profile.archived &&
                                  profile.maximumMode ===
                                    (stage.kind === 'coder' ? 'write' : 'read-only'),
                              )
                              .map((profile) => (
                                <option key={profile.id} value={profile.id}>
                                  {profile.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          {stage.kind} estimate (minutes, optional)
                          <input
                            type="number"
                            min={1}
                            max={10080}
                            value={stage.estimateMinutes ?? ''}
                            onChange={(event) =>
                              updateStage(index, {
                                estimateMinutes: event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              })
                            }
                          />
                        </label>
                      </li>
                    ))}
                  </ol>
                  <label>
                    <input
                      type="checkbox"
                      checked={proposal.stages.length === 3}
                      onChange={(event) =>
                        setProposal({
                          ...proposal,
                          stages: event.target.checked
                            ? [
                                ...proposal.stages,
                                {
                                  kind: 'qa',
                                  agentId: '',
                                  dependsOn: ['reviewer'],
                                  entryCondition: 'approved_reviewer_result',
                                  estimateMinutes: null,
                                },
                              ]
                            : proposal.stages.slice(0, 2),
                        })
                      }
                    />
                    Include sandboxed QA
                  </label>
                  <label>
                    Maximum workers
                    <select
                      value={proposal.constraints.maxWorkers}
                      onChange={(event) =>
                        setProposal({
                          ...proposal,
                          constraints: {
                            ...proposal.constraints,
                            maxWorkers: Number(event.target.value) as 1 | 2,
                          },
                        })
                      }
                    >
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                    </select>
                  </label>
                  <label>
                    Estimated time budget (minutes, optional)
                    <input
                      type="number"
                      min={1}
                      max={30240}
                      value={proposal.constraints.estimatedMinutesBudget ?? ''}
                      onChange={(event) =>
                        setProposal({
                          ...proposal,
                          constraints: {
                            ...proposal.constraints,
                            estimatedMinutesBudget: event.target.value
                              ? Number(event.target.value)
                              : null,
                          },
                        })
                      }
                    />
                  </label>
                  <p>
                    Estimates are entered by you, not measured costs or runtime guarantees. This
                    workflow runs one stage at a time within the global{' '}
                    {snapshot.capabilities.maxWorkers}-worker cap. Monetary budgets and release
                    automation are unavailable.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={proposal.includeContext}
                      onChange={(event) =>
                        setProposal({ ...proposal, includeContext: event.target.checked })
                      }
                    />
                    Attach current Project Context as untrusted reference data
                  </label>
                  <button onClick={() => saveProposal(section === 'templates')}>
                    Save {section === 'templates' ? 'template' : 'proposal'}
                  </button>
                  {section === 'lead' && (
                    <button onClick={() => saveProposal(true)}>Save as workflow template</button>
                  )}
                </fieldset>
                {editingTemplate && selected && (
                  <fieldset disabled={!fresh || busy}>
                    <button
                      disabled={(selected as WorkflowTemplate).archived}
                      onClick={() =>
                        void mutate<WorkflowTemplate>(
                          `/workflow-templates/${selected.id}/duplicate`,
                          'POST',
                          { version: selected.version },
                          (value) => choose(value, true),
                        )
                      }
                    >
                      Duplicate template
                    </button>
                    <button
                      onClick={() =>
                        void mutate<WorkflowTemplate>(
                          `/workflow-templates/${selected.id}`,
                          'PUT',
                          {
                            version: selected.version,
                            proposal: selected.proposal,
                            archived: !(selected as WorkflowTemplate).archived,
                          },
                          (value) => choose(value, true),
                        )
                      }
                    >
                      {(selected as WorkflowTemplate).archived
                        ? 'Restore template'
                        : 'Archive template'}
                    </button>
                    <button
                      disabled={(selected as WorkflowTemplate).archived}
                      onClick={() =>
                        void mutate<Plan>(
                          `/workflow-templates/${selected.id}/instantiate`,
                          'POST',
                          { version: selected.version },
                          (value) => choose(value, false),
                        )
                      }
                    >
                      Create proposal from template
                    </button>
                  </fieldset>
                )}
                {currentPlan && (
                  <>
                    <p>
                      Run: {run?.state} · {run?.completedStages}/{run?.totalStages} stages approved
                      · proposal v{currentPlan.version} · context{' '}
                      {currentPlan.contextRevision ?? 'not attached'}
                    </p>
                    {!locked && (
                      <fieldset disabled={!fresh || busy || !snapshot.capabilities.executionReady}>
                        <p>
                          Uses the saved proposal above. Save edits first. Creation does not start
                          execution; inspect and approve every workflow checkpoint below.
                        </p>
                        <label>
                          <input
                            type="checkbox"
                            checked={confirmed}
                            onChange={(event) => setConfirmed(event.target.checked)}
                          />
                          I confirm creating a workflow from this saved proposal and context
                          revision {snapshot.context.revision}
                        </label>
                        <button
                          disabled={!draftMatches}
                          onClick={() =>
                            void mutate<PlanValidation>(
                              `/plans/${currentPlan.id}/validate`,
                              'POST',
                              {
                                version: currentPlan.version,
                                contextRevision: snapshot.context.revision,
                              },
                              setValidation,
                            )
                          }
                        >
                          Check prerequisites
                        </button>
                        {validation && (
                          <p role="status">
                            {validation.notice} Checked at {validation.checkedAt}.
                          </p>
                        )}
                        <button
                          disabled={!confirmed || !draftMatches}
                          onClick={() =>
                            void mutate<{ plan: Plan }>(
                              `/plans/${currentPlan.id}/run`,
                              'POST',
                              {
                                version: currentPlan.version,
                                contextRevision: snapshot.context.revision,
                                confirmed: true,
                              },
                              (value) => choose(value.plan, false),
                            )
                          }
                        >
                          Create workflow for approval
                        </button>
                      </fieldset>
                    )}
                    <section aria-label="Plan conversation">
                      <h4>Persisted operator conversation</h4>
                      <ul>
                        {currentPlan.messages.map((item) => (
                          <li key={item.id}>
                            <strong>You · {item.at}</strong>
                            <p>{item.text}</p>
                          </li>
                        ))}
                      </ul>
                      <fieldset disabled={!fresh || busy}>
                        <label>
                          Conversation note
                          <textarea
                            maxLength={6000}
                            value={message}
                            onChange={(event) => setMessage(event.target.value)}
                          />
                        </label>
                        <button
                          disabled={!message.trim()}
                          onClick={() =>
                            void mutate<Plan>(
                              `/plans/${currentPlan.id}/messages`,
                              'POST',
                              { version: currentPlan.version, text: message },
                              (value) => {
                                choose(value, false);
                                setMessage('');
                              },
                            )
                          }
                        >
                          Save note
                        </button>
                      </fieldset>
                    </section>
                  </>
                )}
              </section>
              {currentPlan?.workflowId && run?.taskIds[0] && (
                <WorkflowBoard
                  key={currentPlan.workflowId}
                  taskId={run.taskIds[0]}
                  inspection={{ id: currentPlan.workflowId, request: 0 }}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
