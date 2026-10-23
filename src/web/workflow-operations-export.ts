import { csvCell } from './task-history-export.js';
import { workflowTriageKind, type WorkflowOperationsItem } from './workflow-operations.js';

export interface ExportWorkflow extends WorkflowOperationsItem {
  version: number;
}

/** Export only persisted workflow metadata; no stage reports, prompts, commands or paths. */
export function exportWorkflowOperationsCsv(workflows: readonly ExportWorkflow[]): string {
  const rows = workflows.map((workflow) =>
    [
      workflow.id,
      workflow.repositoryId,
      workflow.state,
      workflowTriageKind(workflow),
      String(workflow.version),
      workflow.updatedAt ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  const header = ['Workflow ID', 'Repository ID', 'State', 'Triage', 'Version', 'Updated at']
    .map(csvCell)
    .join(',');
  return [header, ...rows].join('\r\n') + '\r\n';
}
