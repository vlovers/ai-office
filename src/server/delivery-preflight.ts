import type { Task, WorkspaceReview } from '../shared/types.js';
import { parseGitHubRemote } from '../shared/github-remote.js';

export type DeliveryPreflight = {
  status: 'blocked' | 'manual-review';
  revision: string | null;
  branch: string;
  checks: { id: string; ok: boolean; message: string }[];
  remote: { owner: string; repository: string } | null;
};

/**
 * Server-side read-only gate. Never authorizes push/commit; caller must first
 * obtain a fresh, lease-protected workspace review.
 */
export function deliveryPreflight(
  task: Task,
  review: WorkspaceReview,
  remoteInput: string,
): DeliveryPreflight {
  const workspace = review.workspace;
  const remote = parseGitHubRemote(remoteInput);
  const checks = [
    {
      id: 'task',
      ok: task.state === 'completed' && task.workspaceId === workspace.id &&
        task.repositoryId === workspace.repositoryId,
      message: 'Task must be completed and bound to the exact repository/workspace.',
    },
    {
      id: 'identity',
      ok: Boolean(workspace.identity) && !workspace.operation && !workspace.recoveryError,
      message: 'Workspace ownership must be verified with no pending recovery.',
    },
    {
      id: 'kept',
      ok: workspace.decision === 'kept',
      message: 'Operator must Keep changes before delivery.',
    },
    {
      id: 'review',
      ok: Boolean(review.revision) && review.files.length > 0 &&
        review.files.every((file) => file.availability === 'text'),
      message: 'A current, non-empty and inspectable review is required.',
    },
    {
      id: 'remote-format',
      ok: Boolean(remote),
      message: 'A credential-free GitHub remote URL must be supplied.',
    },
  ];
  return {
    status: checks.every((check) => check.ok) ? 'manual-review' : 'blocked',
    revision: review.revision ?? null,
    branch: workspace.branch,
    checks,
    remote: remote ? { owner: remote.owner, repository: remote.repository } : null,
  };
}
