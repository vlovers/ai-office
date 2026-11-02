/**
 * Only a fully verified, current checkpoint may offer workflow actions.
 * The server independently checks the submitted optimistic version.
 */
export function isCurrentWorkflowCheckpoint(
  selected: string,
  summary: { id: string; version: number } | undefined,
  timeline: { id: string; version: number } | null,
  error: string,
): boolean {
  if (error || !selected || !summary || !timeline) return false;
  const sameWorkflow = summary.id === selected && timeline.id === selected;
  return sameWorkflow && summary.version === timeline.version;
}
