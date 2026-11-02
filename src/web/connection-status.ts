export type HttpConnection = 'connecting' | 'connected' | 'disconnected';
export type StreamConnection = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * EventSource retries while CONNECTING (0), but CLOSED (2) is terminal.
 * In particular, a failed HTTP response can permanently close the stream;
 * displaying "Reconnecting" indefinitely would falsely promise recovery.
 */
export function streamConnectionOnError(readyState: number): StreamConnection {
  return readyState === 2 ? 'disconnected' : 'reconnecting';
}

/** A terminal CLOSED EventSource requires an explicit new connection. */
export function canRetryStreams(
  http: HttpConnection,
  streams: Readonly<Record<string, StreamConnection>>,
): boolean {
  return http === 'connected' && Object.values(streams).includes('disconnected');
}

/** HTTP polling must not mask a broken live-event stream (or vice versa). */
export function connectionLabel(
  http: HttpConnection,
  streams: Readonly<Record<string, StreamConnection>>,
): string {
  if (http === 'disconnected') return 'Server disconnected';
  const states = Object.values(streams);
  if (states.includes('disconnected')) return 'Live event stream disconnected';
  if (states.includes('reconnecting')) return 'Reconnecting to live events…';
  if (states.includes('connecting')) return 'Connecting to live events…';
  if (states.includes('connected')) return 'Live events connected';
  return http === 'connected' ? 'Local server connected' : 'Connecting';
}
