/** Repository-scoped UI contracts. Proposals never confer execution authority. */
export interface ProposalStage {
  kind: 'coder' | 'reviewer' | 'qa';
  agentId: string;
  dependsOn: ('coder' | 'reviewer')[];
  entryCondition: 'operator_approval' | 'approved_coder_evidence' | 'approved_reviewer_result';
  estimateMinutes: number | null;
}
export interface Proposal {
  title: string;
  prompt: string;
  stages: ProposalStage[];
  constraints: { maxWorkers: 1 | 2; estimatedMinutesBudget: number | null };
  includeContext: boolean;
}
export interface Plan {
  id: string;
  repositoryId: string;
  version: number;
  proposal: Proposal;
  provenance: 'operator';
  messages: { id: string; role: 'operator'; text: string; at: string }[];
  workflowId: string | null;
  templateSource: { id: string; version: number } | null;
  contextRevision: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowTemplate {
  id: string;
  repositoryId: string;
  version: number;
  proposal: Proposal;
  archived: boolean;
  duplicatedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ContextContent {
  brief: string;
  requirements: string;
  constraints: string;
  roadmap: string;
}
export interface ProjectContext {
  repositoryId: string;
  revision: number;
  content: ContextContent;
  provenance: { source: 'operator'; restoredFrom: number | null; savedAt: string | null };
}
export interface PlanRun {
  planId: string;
  workflowId: string | null;
  state:
    | 'draft'
    | 'awaiting_approval'
    | 'queued'
    | 'running'
    | 'blocked'
    | 'failed'
    | 'stopped'
    | 'interrupted'
    | 'completed'
    | 'cancelled';
  completedStages: number;
  totalStages: number;
  taskIds: string[];
  /** Existing engine is sequential, within the global TaskManager cap. */
  effectiveParallelism: 1;
  pauseSupported: false;
}
export interface PlanValidation {
  planId: string;
  version: number;
  contextRevision: number;
  baselineRevision: string;
  checkedAt: string;
  notice: string;
}
export interface OrchestrationSnapshot {
  repositoryId: string;
  branch: { name: string | null; revision: string; readOnly: true };
  capabilities: {
    modelPlanning: false;
    modelPlanningReason: string;
    release: false;
    pause: false;
    monetaryBudgets: false;
    maxWorkers: number;
    executionReady: boolean;
    executionMessage: string;
  };
  context: ProjectContext;
  plans: Plan[];
  templates: WorkflowTemplate[];
  runs: PlanRun[];
}
