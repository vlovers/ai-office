/** Read-only operations projection. Never authorizes or dispatches workflows. */
export interface WorkflowOperationsItem {
  id: string;
  repositoryId: string;
  state: string;
  updatedAt?: string;
  stages: readonly { state?: string }[];
}

export type WorkflowOperationsSort = 'recent' | 'oldest' | 'attention';
export type WorkflowTriageKind =
  'failed' | 'approval' | 'blocked' | 'running' | 'finished' | 'other';

export interface WorkflowTriageSummary {
  total: number;
  failed: number;
  approval: number;
  blocked: number;
  running: number;
  finished: number;
  other: number;
  attention: number;
}

/** Persisted workflow/stage states only. Never infer a hung process from elapsed time.
 * Failure outranks approval; an active workflow with a blocked stage is still blocked.
 * Terminal workflows are not actionable even if their historical stages failed. */
export function workflowTriageKind(item: WorkflowOperationsItem): WorkflowTriageKind {
  if (item.state === 'completed' || item.state === 'cancelled') return 'finished';
  const states = item.stages.map((stage) => stage.state ?? '');
  if (states.some((state) => state === 'failed' || state === 'interrupted')) return 'failed';
  if (states.some((state) => state === 'awaiting_approval')) return 'approval';
  if (item.state === 'blocked' || states.includes('blocked')) return 'blocked';
  if (states.some((state) => state === 'running' || state === 'preparing')) return 'running';
  return 'other';
}

export function workflowNeedsAttention(item: WorkflowOperationsItem): boolean {
  const kind = workflowTriageKind(item);
  return kind === 'failed' || kind === 'approval' || kind === 'blocked';
}

export function summarizeWorkflowOperations(
  items: readonly WorkflowOperationsItem[],
): WorkflowTriageSummary {
  const summary: WorkflowTriageSummary = {
    total: items.length,
    failed: 0,
    approval: 0,
    blocked: 0,
    running: 0,
    finished: 0,
    other: 0,
    attention: 0,
  };
  for (const item of items) {
    const kind = workflowTriageKind(item);
    summary[kind]++;
    if (workflowNeedsAttention(item)) summary.attention++;
  }
  return summary;
}

const attentionRank: Record<WorkflowTriageKind, number> = {
  failed: 0,
  approval: 1,
  blocked: 2,
  running: 3,
  other: 4,
  finished: 5,
};

export function selectWorkflowOperations<T extends WorkflowOperationsItem>(
  items: readonly T[],
  options: { query: string; state: string; triageOnly: boolean; sort: WorkflowOperationsSort },
): T[] {
  const query = options.query.trim().toLowerCase();
  return items
    .filter(
      (item) =>
        (!options.triageOnly || workflowNeedsAttention(item)) &&
        (options.state === 'all' || item.state === options.state) &&
        (item.id.toLowerCase().includes(query) || item.repositoryId.toLowerCase().includes(query)),
    )
    .sort((a, b) => {
      if (options.sort === 'attention') {
        const priority =
          attentionRank[workflowTriageKind(a)] - attentionRank[workflowTriageKind(b)];
        if (priority) return priority;
      }
      const chronological = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
      if (chronological) return options.sort === 'oldest' ? -chronological : chronological;
      return a.id.localeCompare(b.id);
    });
}
