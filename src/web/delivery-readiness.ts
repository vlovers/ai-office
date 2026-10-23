import type { Task, WorkspaceReview } from '../shared/types.js';

export type DeliveryGate = {
  code: string;
  status: 'ready' | 'blocked' | 'manual';
  message: string;
};

export type DeliveryReadiness = {
  eligible: boolean;
  workspaceId: string;
  revision: string | null;
  branch: string;
  base: string;
  gates: DeliveryGate[];
};

/** Read-only local checklist. Remote actions require separate server-side approval. */
export function assessDeliveryReadiness(
  task: Pick<Task, 'state' | 'workspaceId'>,
  review: WorkspaceReview,
): DeliveryReadiness {
  const workspace = review.workspace;
  const gates: DeliveryGate[] = [];
  const gate = (code: string, status: DeliveryGate['status'], message: string) =>
    gates.push({ code, status, message });

  gate(
    'task',
    task.state === 'completed' && task.workspaceId === workspace.id ? 'ready' : 'blocked',
    'Coder task must be completed and bound to this workspace.',
  );
  gate(
    'ownership',
    workspace.identity && !workspace.operation && !workspace.recoveryError ? 'ready' : 'blocked',
    'Workspace identity must be verified with no recovery or pending operation.',
  );
  gate(
    'decision',
    workspace.decision === 'kept' ? 'ready' : 'blocked',
    'Changes must be explicitly kept before delivery.',
  );
  gate(
    'revision',
    review.revision && review.files.length > 0 ? 'ready' : 'blocked',
    'A current non-empty review revision must be available.',
  );
  gate(
    'contents',
    review.files.every((file) => file.availability === 'text') ? 'ready' : 'blocked',
    'Every changed file must be reviewable as text; other files need manual inspection.',
  );
  gate('commit', 'manual', 'No commit or push is performed by this screen.');
  gate('remote', 'manual', 'Verify remote URL, target branch, permissions and branch protection manually.');
  gate('approval', 'manual', 'A separate explicit confirmation is required for publishing a PR.');

  return {
    eligible: gates.every((item) => item.status !== 'blocked'),
    workspaceId: workspace.id,
    revision: review.revision ?? null,
    branch: workspace.branch,
    base: workspace.base,
    gates,
  };
}
