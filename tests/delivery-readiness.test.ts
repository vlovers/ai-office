import { describe, expect, it } from 'vitest';
import { assessDeliveryReadiness, buildDeliveryDraft } from '../src/web/delivery-readiness.js';
import type { Task, WorkspaceReview } from '../src/shared/types.js';

const task = { state: 'completed', workspaceId: 'workspace-1' } as Task;
const review = {
  revision: 'revision-1',
  workspace: {
    id: 'workspace-1',
    branch: 'ai-office/workspace-1',
    base: 'abcdef',
    decision: 'kept',
    identity: { root: '', gitDir: '', gitFile: '', sourceRoot: '', commonDir: '' },
  },
  files: [{ path: 'src/index.ts', status: 'M', availability: 'text' }],
} as WorkspaceReview;

describe('GitHub delivery read-only readiness', () => {
  it('requires manual publication gates even when local review is ready', () => {
    const result = assessDeliveryReadiness(task, review);
    expect(result.eligible).toBe(true);
    expect(result.gates.filter((gate) => gate.status === 'manual')).toHaveLength(3);
    expect(result.branch).toBe('ai-office/workspace-1');
    expect(result.revision).toBe('revision-1');
  });

  it('blocks active tasks and mismatched workspaces', () => {
    const result = assessDeliveryReadiness({ state: 'running', workspaceId: 'other' }, review);
    expect(result.eligible).toBe(false);
    expect(result.gates.find((gate) => gate.code === 'task')?.status).toBe('blocked');
  });

  it('blocks pending, rejected, recovering and unverified workspaces', () => {
    for (const change of [
      { decision: 'pending' },
      { decision: 'rejected' },
      { operation: 'verifying' },
      { recoveryError: 'ownership uncertain' },
      { identity: undefined },
    ]) {
      const result = assessDeliveryReadiness(task, {
        ...review,
        workspace: { ...review.workspace, ...change },
      } as WorkspaceReview);
      expect(result.eligible).toBe(false);
    }
  });

  it('blocks absent revisions, empty diffs and unavailable file contents', () => {
    for (const change of [
      { revision: undefined },
      { files: [] },
      { files: [{ availability: 'withheld' }] },
      { files: [{ availability: 'binary' }] },
      { files: [{ availability: 'oversized' }] },
    ]) {
      expect(
        assessDeliveryReadiness(task, { ...review, ...change } as WorkspaceReview).eligible,
      ).toBe(false);
    }
  });

  it('does not mutate task or review data', () => {
    const frozenTask = Object.freeze({ ...task });
    const frozenReview = Object.freeze({ ...review });
    assessDeliveryReadiness(frozenTask, frozenReview);
    expect(frozenReview.revision).toBe('revision-1');
  });

  it('prepares deterministic PR metadata without mutating review or sending credentials', () => {
    const draft = buildDeliveryDraft(
      { ...task, title: '  Fix   task   workflow  ' } as Task,
      review,
    );
    expect(draft.title).toBe('Fix task workflow');
    expect(draft.body).toContain('Changed files: 1');
    expect(draft.body).toContain('Review revision: revision-1');
    expect(draft.body).toContain('No GitHub action has been performed.');
    expect(draft.body).not.toContain('identity');
  });
});
