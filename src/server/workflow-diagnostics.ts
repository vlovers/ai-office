import type { Workflow } from './workflows.js';
import { workflowTimeline } from './workflow-timeline.js';

export type DiagnosticSeverity = 'info' | 'attention' | 'blocked';

export interface WorkflowDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  stage: string | null;
  message: string;
  suggestedAction: string | null;
}

/**
 * Read-only interpretation of persisted checkpoints. No process liveness,
 * filesystem integrity, or authorization is inferred from a timestamp.
 */
export function diagnoseWorkflow(workflow: Workflow) {
  const timeline = workflowTimeline(workflow);
  const findings: WorkflowDiagnostic[] = [];
  for (const stage of timeline.stages) {
    if (stage.status === 'awaiting_approval') {
      findings.push({
        code: 'approval-required',
        severity: 'attention',
        stage: stage.kind,
        message: `${stage.kind} is awaiting an explicit operator approval.`,
        suggestedAction: stage.nextAction,
      });
    } else if (stage.status === 'interrupted' || stage.status === 'failed') {
      findings.push({
        code: stage.status === 'interrupted' ? 'execution-interrupted' : 'execution-failed',
        severity: 'blocked',
        stage: stage.kind,
        message: `${stage.kind} ${stage.status}; inspect the task events and workspace before proceeding.`,
        suggestedAction: null,
      });
    } else if (stage.status === 'blocked') {
      findings.push({
        code: 'stage-blocked',
        severity: 'blocked',
        stage: stage.kind,
        message: `${stage.kind} is blocked at a persisted checkpoint.`,
        suggestedAction: stage.nextAction,
      });
    }
  }
  if (workflow.state === 'blocked' && !findings.some((item) => item.severity === 'blocked')) {
    findings.push({
      code: 'workflow-blocked',
      severity: 'blocked',
      stage: null,
      message: 'The workflow is blocked; inspect its timeline and task events.',
      suggestedAction: null,
    });
  }
  if (workflow.state === 'completed' || workflow.state === 'cancelled') {
    findings.push({
      code: 'terminal-workflow',
      severity: 'info',
      stage: null,
      message: `Workflow is ${workflow.state}; no automatic restart is available.`,
      suggestedAction: null,
    });
  }
  return {
    id: workflow.id,
    version: workflow.version,
    state: workflow.state,
    updatedAt: workflow.updatedAt,
    findings,
    stageActions: timeline.stages.map((stage) => ({
      kind: stage.kind,
      status: stage.status,
      nextAction: stage.nextAction,
    })),
    warning:
      'Diagnostics are based on persisted state only. They do not prove process liveness or grant permission to execute, retry, cancel, push or publish.',
  };
}
