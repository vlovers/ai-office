import { describe, expect, it } from 'vitest';
import { workflowStagePresentation } from '../src/web/workflow-stage-presentation.js';

describe('workflow stage presentation', () => {
  it('distinguishes waiting, running, approval and terminal states', () => {
    expect(workflowStagePresentation('pending', null)).toEqual({
      label: 'Waiting',
      tone: 'muted',
    });
    expect(workflowStagePresentation('pending', 'approve-qa').label).toBe('Action required');
    expect(workflowStagePresentation('running', null).tone).toBe('active');
    expect(workflowStagePresentation('completed', null).tone).toBe('success');
    expect(workflowStagePresentation('failed', null).tone).toBe('danger');
    expect(workflowStagePresentation('interrupted', null).label).toBe('Interrupted');
    expect(workflowStagePresentation('blocked', null).tone).toBe('attention');
  });

  it('never treats a proposed next action as proof that a stage completed', () => {
    expect(workflowStagePresentation('pending', 'submit-qa').tone).toBe('attention');
    expect(workflowStagePresentation('unknown', null)).toEqual({
      label: 'unknown',
      tone: 'muted',
    });
  });
});
