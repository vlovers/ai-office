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
  if (scrollHeight < 0 || clientHeight < 0 || threshold < 0) return false;
  if (scrollHeight < clientHeight) return true;
  return scrollHeight - Math.max(0, scrollTop) - clientHeight <= threshold;
}

/** Count only retained events newer than the last event the reader saw. */
export function countEventsAfter(
  events: readonly { id: number }[],
  afterId: number | null,
): number {
  if (afterId === null || !Number.isSafeInteger(afterId) || afterId < 0) return 0;
  return events.reduce(
    (count, event) => count + (Number.isSafeInteger(event.id) && event.id > afterId ? 1 : 0),
    0,
  );
}

/** A paused reader must never move their unread baseline backwards on replay. */
export function unreadBaseline(current: number | null, latestId: number | undefined): number {
  const validCursor = (value: number | null | undefined): number =>
    value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return Math.max(validCursor(current), validCursor(latestId));
}
