import type { Workflow, WorkflowStage } from './workflows.js';

export type WorkflowNextAction =
  | 'approve-initial'
  | 'bind-coder-task'
  | 'submit-initial'
  | 'capture-coder-evidence'
  | 'approve-coder-evidence'
  | 'approve-reviewer'
  | 'prepare-reviewer'
  | 'submit-reviewer'
  | 'approve-reviewer-result'
  | 'approve-qa'
  | 'submit-qa'
  | 'approve-qa-result';

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
      nextAction = stage.evidence ? 'approve-coder-evidence' : 'capture-coder-evidence';
    }
    if (active && reviewer && stage.state === 'awaiting_approval') {
      nextAction = 'approve-reviewer';
    }
    if (active && reviewer && stage.state === 'ready') {
      nextAction = stage.runtimeCandidate ? 'submit-reviewer' : 'prepare-reviewer';
    }
    if (active && stage.kind === 'qa') {
      if (stage.state === 'awaiting_approval') nextAction = 'approve-qa';
      if (stage.state === 'ready') nextAction = 'submit-qa';
    }
    if (blocked && stage.kind !== 'coder' && stage.state === 'blocked' && stage.report) {
      nextAction = stage.kind === 'reviewer' ? 'approve-reviewer-result' : 'approve-qa-result';
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
      sourceDigest: stage.execution?.sourceDigest ?? stage.sourceCandidate?.digest ?? null,
      reportDigest: stage.report?.digest ?? null,
      qaPlan: stage.qaPlan ?? null,
      started: stage.state === 'running',
    };
  });
  return {
    id: workflow.id,
    version: workflow.version,
    state: workflow.state,
    baselineRevision: workflow.baselineRevision,
    stages,
    downstreamExecutable: active && Boolean(workflow.stages[1]?.runtimeCandidate),
    notice:
      'Each stage requires explicit approval. Reviewer and QA use a verified native read-only sandbox; network and host verification are disabled. Interrupted runs never retry automatically.',
  };
}
