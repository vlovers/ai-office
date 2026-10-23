/** Minimal read-only shape returned by the existing workflow list API. */
export interface OfficeWorkflow {
  id: string;
  state: string;
  stages: {
    kind: string;
    agentId: string;
    state: string;
    taskId: string | null;
    evidence?: unknown;
    report?: unknown;
  }[];
}

export function officeCheckpoint(workflows: readonly OfficeWorkflow[], agentId: string) {
  for (const workflow of workflows) {
    if (!['active', 'blocked'].includes(workflow.state)) continue;
    const stage = workflow.stages.find(
      (stage) =>
        stage.agentId === agentId &&
        (stage.state === 'awaiting_approval' ||
          (stage.state === 'blocked' && Boolean(stage.evidence || stage.report))),
    );
    if (stage)
      return {
        workflowId: workflow.id,
        stage,
        label: `Waiting for approval · ${stage.kind} checkpoint`,
      };
  }
  return undefined;
}
