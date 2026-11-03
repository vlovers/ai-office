/**
 * Read-only workflow endpoints are fetched independently. Each response may
 * be well-formed yet belong to a different workflow or persisted version.
 * Never present such a mixed response as a verified, actionable checkpoint.
 */
type CheckpointIdentity = { id: string; version: number };

export function assertWorkflowSnapshotCoherent(
  requestedId: string,
  summary: CheckpointIdentity | undefined,
  timeline: CheckpointIdentity | null,
  diagnostics: CheckpointIdentity | null,
): void {
  if (!summary || !timeline || !diagnostics) {
    throw new Error('Workflow checkpoint incomplete; refresh to retry');
  }
  if ([summary, timeline, diagnostics].some((checkpoint) => checkpoint.id !== requestedId)) {
    throw new Error('Workflow checkpoint identity mismatch; refresh to retry');
  }
  if (summary.version !== timeline.version || timeline.version !== diagnostics.version) {
    throw new Error('Workflow checkpoint changed during refresh; retry to verify current version');
  }
}
