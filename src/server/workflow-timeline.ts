import type { Workflow, WorkflowStage } from './workflows.js';

export type WorkflowNextAction =
  | 'approve-initial'
  | 'bind-coder-task'
  | 'submit-initial'
  | 'capture-coder-evidence'
  | 'approve-coder-evidence'
  | 'approve-reviewer';

/** Presentation-only timeline. Never treat this as authorization. */
export function workflowTimeline(workflow: Workflow) {
  const stages = workflow.stages.map((stage: WorkflowStage, index: number) => {
    let nextAction: WorkflowNextAction | null = null;
    if (workflow.state === 'active' && index === 0) {
      if (stage.state === 'awaiting_approval') nextAction = 'approve-initial';
      if (stage.state === 'ready')
        nextAction = stage.taskId ? 'submit-initial' : 'bind-coder-task';
    }
    if (index === 0 && workflow.state === 'blocked' && stage.state === 'blocked') {
      nextAction = stage.evidence ? 'approve-coder-evidence' : 'capture-coder-evidence';
    }
    if (
      index === 1 &&
      workflow.state === 'active' &&
      stage.state === 'awaiting_approval'
    ) {
      nextAction = 'approve-reviewer';
    }
    return {
      kind: stage.kind,
      agentId: stage.agentId,
      agentRevision: stage.agentRevision,
      mode: stage.mode,
      status: stage.state,
      taskId: stage.taskId,
      nextAction,
      evidenceRevision: index === 0 ? (stage.evidence?.revision ?? null) : null,
      approvalRevision: stage.approvedRevision,
      started: stage.state === 'running',
    };
  });
  return {
    id: workflow.id,
    version: workflow.version,
    state: workflow.state,
    baselineRevision: workflow.baselineRevision,
    stages,
    downstreamExecutable: false,
    notice:
      'Reviewer and QA execution are disabled until a verified read-only snapshot runner exists.',
  };
}
