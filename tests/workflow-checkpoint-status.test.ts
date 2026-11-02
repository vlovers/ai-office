import { describe, expect, it } from 'vitest';
import { isCurrentWorkflowCheckpoint } from '../src/web/workflow-checkpoint-status.js';

const summary = { id: 'workflow-a', version: 7 };
const timeline = { id: 'workflow-a', version: 7 };

describe('workflow checkpoint action safety', () => {
  it('allows a verified checkpoint with matching selection and version', () => {
    expect(isCurrentWorkflowCheckpoint('workflow-a', summary, timeline, '')).toBe(true);
  });

  it('fails closed before any workflow has been loaded', () => {
    expect(isCurrentWorkflowCheckpoint('', undefined, null, '')).toBe(false);
    expect(isCurrentWorkflowCheckpoint('workflow-a', undefined, null, '')).toBe(false);
  });

  it('rejects a timeline from a previously selected workflow', () => {
    expect(isCurrentWorkflowCheckpoint('workflow-b', summary, timeline, '')).toBe(false);
    expect(
      isCurrentWorkflowCheckpoint(
        'workflow-a',
        { id: 'workflow-b', version: 7 },
        timeline,
        '',
      ),
    ).toBe(false);
  });

  it('rejects stale timeline versions even when the workflow ID matches', () => {
    expect(
      isCurrentWorkflowCheckpoint('workflow-a', { ...summary, version: 8 }, timeline, ''),
    ).toBe(false);
    expect(
      isCurrentWorkflowCheckpoint('workflow-a', summary, { ...timeline, version: 6 }, ''),
    ).toBe(false);
  });

  it('disables checkpoint actions after a failed refresh until a verified recovery', () => {
    expect(isCurrentWorkflowCheckpoint('workflow-a', summary, timeline, 'HTTP 503')).toBe(false);
    expect(isCurrentWorkflowCheckpoint('workflow-a', summary, timeline, '')).toBe(true);
  });
});
