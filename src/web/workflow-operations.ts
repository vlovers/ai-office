/** Read-only operations projection. Never authorizes or dispatches workflows. */
export interface WorkflowOperationsItem {
  id: string;
  repositoryId: string;
  state: string;
  updatedAt?: string;
  stages: readonly { state?: string }[];
}

export type WorkflowOperationsSort = 'recent' | 'oldest' | 'attention';

export function workflowNeedsAttention(item: WorkflowOperationsItem): boolean {
  return item.state === 'blocked' ||
    item.stages.some((stage) =>
      ['failed', 'interrupted', 'blocked', 'awaiting_approval'].includes(stage.state ?? ''),
    );
}

export function selectWorkflowOperations<T extends WorkflowOperationsItem>(
  items: readonly T[],
  options: { query: string; state: string; triageOnly: boolean; sort: WorkflowOperationsSort },
): T[] {
  const query = options.query.trim().toLowerCase();
  return items.filter((item) =>
    (!options.triageOnly || workflowNeedsAttention(item)) &&
    (options.state === 'all' || item.state === options.state) &&
    (item.id.toLowerCase().includes(query) || item.repositoryId.toLowerCase().includes(query)),
  ).sort((a, b) => {
    if (options.sort === 'attention') {
      const priority = Number(workflowNeedsAttention(b)) - Number(workflowNeedsAttention(a));
      if (priority) return priority;
    }
    const chronological = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
    if (chronological) return options.sort === 'oldest' ? -chronological : chronological;
    return a.id.localeCompare(b.id);
  });
}
