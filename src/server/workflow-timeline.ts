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
  const active = workflow.state === 'active';
  const blocked = workflow.state === 'blocked';
  const stages = workflow.stages.map((stage: WorkflowStage, index: number) => {
    const coder = index === 0;
    const reviewer = index === 1;
    let nextAction: WorkflowNextAction | null = null;
    if (active && coder) {
      if (stage.state === 'awaiting_approval') nextAction = 'approve-initial';
      if (stage.state === 'ready') {
        nextAction = stage.taskId ? 'submit-initial' : 'bind-coder-task';
      }
    }
    if (blocked && coder && stage.state === 'blocked') {
      nextAction = stage.evidence
        ? 'approve-coder-evidence'
        : 'capture-coder-evidence';
    }
    if (active && reviewer && stage.state === 'awaiting_approval') {
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
      evidenceRevision: coder ? (stage.evidence?.revision ?? null) : null,
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
