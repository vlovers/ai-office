export type HttpConnection = 'connecting' | 'connected' | 'disconnected';
export type StreamConnection = 'connected' | 'reconnecting';

/** HTTP polling must not mask a broken live-event stream (or vice versa). */
export function connectionLabel(
  http: HttpConnection,
  streams: Readonly<Record<string, StreamConnection>>,
): string {
  if (http === 'disconnected') return 'Server disconnected';
  const states = Object.values(streams);
  if (states.includes('reconnecting')) return 'Reconnecting to live events…';
  if (states.includes('connected')) return 'Live events connected';
  return http === 'connected' ? 'Local server connected' : 'Connecting';
}
