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
  if (![scrollTop, scrollHeight, clientHeight, threshold].every(Number.isFinite))
    return false;
  return scrollHeight - Math.max(0, scrollTop) - clientHeight <= Math.max(0, threshold);
}
