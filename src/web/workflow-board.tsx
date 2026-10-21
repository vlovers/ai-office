import React, { useCallback, useEffect, useState } from 'react';

type TimelineStage = {
  kind: 'coder' | 'reviewer' | 'qa';
  agentId: string;
  agentRevision: number;
  mode: 'write' | 'read-only';
  status: string;
  taskId: string | null;
  nextAction: string | null;
  evidenceRevision: string | null;
  approvalRevision: string | null;
};
type Timeline = {
  id: string;
  version: number;
  state: string;
  stages: TimelineStage[];
  downstreamExecutable: boolean;
  notice: string;
};
type WorkflowSummary = { id: string; version: number; state: string };

async function request<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Workflow request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Read-only observability. Operator actions deliberately stay in Review Center
 * until the snapshot-backed authorization boundary is implemented.
 */
export function WorkflowBoard() {
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const workflows = await request<WorkflowSummary[]>('/api/workflows');
      setItems(workflows);
      const id = selected && workflows.some((item) => item.id === selected)
        ? selected
        : (workflows[0]?.id ?? '');
      setSelected(id);
      setTimeline(id ? await request<Timeline>(`/api/workflows/${id}/timeline`) : null);
      setError('');
    } catch (cause) {
      setTimeline(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [selected]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <section className="panel" id="workflows" aria-label="Workflow timeline">
      <div className="panel-heading">
        <h2>Workflow Timeline</h2>
        <button className="secondary" type="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="panel-description">
        Inspect pinned agents and operator checkpoints. This view never dispatches tasks.
      </p>
      {error && <p role="alert">{error}</p>}
      {!items.length && !error && <p>No workflows created yet.</p>}
      {items.length > 0 && (
        <>
          <label htmlFor="workflow-selection">Workflow</label>
          <select
            id="workflow-selection"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id.slice(0, 8)} · {item.state} · v{item.version}
              </option>
            ))}
          </select>
          {timeline && (
            <div>
              <p role="status">State: {timeline.state} · version {timeline.version}</p>
              <ol>
                {timeline.stages.map((stage) => (
                  <li key={stage.kind}>
                    <strong>{stage.kind.toUpperCase()}</strong> — {stage.status}
                    <p>{stage.agentId} · profile v{stage.agentRevision} · {stage.mode}</p>
                    {stage.nextAction && <p>Operator checkpoint: {stage.nextAction}</p>}
                    {stage.evidenceRevision && <p>Evidence: {stage.evidenceRevision.slice(0, 12)}…</p>}
                  </li>
                ))}
              </ol>
              <p role="note">{timeline.notice}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
