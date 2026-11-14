/**
 * A workflow can be inspected from the task belonging to any stage. Restricting
 * task-scoped review to the first (Coder) stage hides Reviewer and QA evidence.
 */
export function workflowsForTask<T extends { stages: readonly { taskId?: string | null }[] }>(
  workflows: readonly T[],
  taskId?: string,
): T[] {
  if (!taskId) return workflows.slice();
  return workflows.filter((workflow) => workflow.stages.some((stage) => stage.taskId === taskId));
}
