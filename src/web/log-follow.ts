/**
 * A live event log should follow new output only while the reader is already
 * near its end. Scrolling up must not be undone by an incoming SSE event.
 */
export function isNearLogEnd(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 48,
): boolean {
  if (![scrollTop, scrollHeight, clientHeight, threshold].every(Number.isFinite)) return false;
  return scrollHeight - Math.max(0, scrollTop) - clientHeight <= Math.max(0, threshold);
}

/** Count only retained events newer than the last event the reader saw. */
export function countEventsAfter(
  events: readonly { id: number }[],
  afterId: number | null,
): number {
  if (afterId === null) return 0;
  return events.reduce((count, event) => count + (event.id > afterId ? 1 : 0), 0);
}

/** A paused reader must never move their unread baseline backwards on replay. */
export function unreadBaseline(current: number | null, latestId: number | undefined): number {
  const latest = latestId ?? 0;
  return Math.max(current ?? 0, latest);
}
