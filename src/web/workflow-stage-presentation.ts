// A display-only stage vocabulary. Never use this to authorize actions.
export function workflowStagePresentation(
  status: string,
  nextAction: string | null,
): { label: string; tone: 'muted' | 'active' | 'attention' | 'success' | 'danger' } {
  if (status === 'completed') return { label: 'Completed', tone: 'success' };
  if (status === 'failed' || status === 'interrupted') {
    return { label: status === 'failed' ? 'Failed' : 'Interrupted', tone: 'danger' };
  }
  if (status === 'running') return { label: 'Running', tone: 'active' };
  if (status === 'blocked') return { label: 'Blocked', tone: 'attention' };
  if (nextAction) return { label: 'Action required', tone: 'attention' };
  if (status === 'pending') return { label: 'Waiting', tone: 'muted' };
  return { label: status, tone: 'muted' };
}
