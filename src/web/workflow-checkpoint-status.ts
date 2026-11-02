/** Only a fully verified, current checkpoint may offer workflow actions.
 * The server independently checks the submitted optimistic version.
 */
export function isCurrentWorkflowCheckpoint(
  selected: string,
  summary: { id: string; version: number } | undefined,
  timeline: { id: string; version: number } | null,
  error: string,
): boolean {
  return Boolean(
    !error &&
      selected &&
      summary?.id === selected &&
      timeline?.id === selected &&
      summary.version === timeline.version,
  );
}
