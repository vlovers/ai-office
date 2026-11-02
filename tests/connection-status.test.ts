import { describe, expect, it } from 'vitest';
import {
  canRetryStreams,
  connectionLabel,
  streamConnectionOnError,
} from '../src/web/connection-status.js';

describe('workspace connection status', () => {
  const label = connectionLabel;
  const connected = 'connected';
  const disconnected = 'disconnected';
  const reconnecting = 'reconnecting';
  const connectingLabel = 'Connecting to live events…';
  const reconnectingLabel = 'Reconnecting to live events…';
  const disconnectedLabel = 'Live event stream disconnected';

  it('shows the HTTP connection before any live streams exist', () => {
    expect(label('connecting', {})).toBe('Connecting');
    expect(label(connected, {})).toBe('Local server connected');
  });

  it('does not claim live connectivity before newly opened streams connect', () => {
    expect(label(connected, { taskA: 'connecting' })).toBe(connectingLabel);
    expect(label(connected, { taskA: connected, taskB: 'connecting' })).toBe(connectingLabel);
  });

  it('keeps an SSE reconnect warning visible even after HTTP polling succeeds', () => {
    expect(label(connected, { taskA: reconnecting })).toBe(reconnectingLabel);
  });

  it('prioritizes reconnecting over newly connecting streams', () => {
    expect(label(connected, { taskA: 'connecting', taskB: reconnecting })).toBe(reconnectingLabel);
  });

  it('warns if one of several task streams is reconnecting', () => {
    expect(label(connected, { taskA: connected, taskB: reconnecting })).toBe(reconnectingLabel);
  });

  it('distinguishes a terminal CLOSED EventSource from automatic reconnect', () => {
    expect(streamConnectionOnError(0)).toBe(reconnecting);
    expect(streamConnectionOnError(1)).toBe(reconnecting);
    expect(streamConnectionOnError(2)).toBe(disconnected);
  });

  it('never masks a terminal stream failure with another connected stream', () => {
    expect(label(connected, { taskA: connected, taskB: disconnected })).toBe(disconnectedLabel);
    expect(label(connected, { taskA: reconnecting, taskB: disconnected })).toBe(disconnectedLabel);
    expect(label(disconnected, { taskA: disconnected })).toBe('Server disconnected');
  });

  it('offers manual recovery only for terminal streams while HTTP is healthy', () => {
    expect(canRetryStreams(connected, { taskA: disconnected })).toBe(true);
    expect(canRetryStreams(connected, { taskA: connected, taskB: disconnected })).toBe(true);
    expect(canRetryStreams(connected, { taskA: reconnecting })).toBe(false);
    expect(canRetryStreams('connecting', { taskA: disconnected })).toBe(false);
    expect(canRetryStreams(disconnected, { taskA: disconnected })).toBe(false);
    expect(canRetryStreams(connected, {})).toBe(false);
  });

  it('restores live connection status when streams recover', () => {
    expect(label(connected, { taskA: connected })).toBe('Live events connected');
  });

  it('prioritizes a failed HTTP connection over healthy stream status', () => {
    expect(label(disconnected, { taskA: connected })).toBe('Server disconnected');
  });
});
