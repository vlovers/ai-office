import { describe, expect, it } from 'vitest';
import { deliveryPreflight } from '../src/server/delivery-preflight.js';
import type { Task, WorkspaceReview } from '../src/shared/types.js';

const task = {
  state: 'completed',
  repositoryId: 'repo-1',
  workspaceId: 'workspace-1',
} as Task;
const review = {
  revision: 'revision-1',
  workspace: {
    id: 'workspace-1',
    repositoryId: 'repo-1',
    branch: 'office/workspace-1',
    decision: 'kept',
    identity: { root: '', gitDir: '', gitFile: '', sourceRoot: '', commonDir: '' },
  },
  files: [{ path: 'index.ts', availability: 'text' }],
} as WorkspaceReview;

describe('read-only delivery preflight', () => {
  it('returns manual-review rather than publication authorization', () => {
    const result = deliveryPreflight(task, review, 'git@github.com:owner/repo.git');
    expect(result.status).toBe('manual-review');
    expect(result.remote).toEqual({ owner: 'owner', repository: 'repo' });
    expect(result.revision).toBe('revision-1');
  });

  it('fails closed on mismatched task, unsafe remote and uninspectable files', () => {
    expect(
      deliveryPreflight({ ...task, repositoryId: 'wrong' }, review, 'https://github.com/a/b')
        .status,
    ).toBe('blocked');
    expect(deliveryPreflight(task, review, 'https://token@github.com/a/b').remote).toBeNull();
    expect(deliveryPreflight(task, review, 'https://token@github.com/a/b').status).toBe('blocked');
    expect(
      deliveryPreflight(
        task,
        { ...review, files: [{ availability: 'binary' }] } as WorkspaceReview,
        'https://github.com/a/b',
      ).status,
    ).toBe('blocked');
    expect(
      deliveryPreflight(
        task,
        {
          ...review,
          workspace: { ...review.workspace, operation: 'verifying' },
        } as WorkspaceReview,
        'https://github.com/a/b',
      ).status,
    ).toBe('blocked');
  });
});
