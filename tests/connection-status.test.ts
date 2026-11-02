import { describe, expect, it } from 'vitest';
import { connectionLabel, streamConnectionOnError } from '../src/web/connection-status.js';

describe('workspace connection status', () => {
  it('shows the HTTP connection before any live streams exist', () => {
    expect(connectionLabel('connecting', {})).toBe('Connecting');
    expect(connectionLabel('connected', {})).toBe('Local server connected');
  });

  it('does not claim live connectivity before newly opened streams connect', () => {
    expect(connectionLabel('connected', { taskA: 'connecting' })).toBe(
      'Connecting to live events…',
    );
    expect(connectionLabel('connected', { taskA: 'connected', taskB: 'connecting' })).toBe(
      'Connecting to live events…',
    );
  });

  it('keeps an SSE reconnect warning visible even after HTTP polling succeeds', () => {
    expect(connectionLabel('connected', { taskA: 'reconnecting' })).toBe(
      'Reconnecting to live events…',
    );
  });

  it('prioritizes reconnecting over newly connecting streams', () => {
    expect(connectionLabel('connected', { taskA: 'connecting', taskB: 'reconnecting' })).toBe(
      'Reconnecting to live events…',
    );
  });

  it('warns if one of several task streams is reconnecting', () => {
    expect(connectionLabel('connected', { taskA: 'connected', taskB: 'reconnecting' })).toBe(
      'Reconnecting to live events…',
    );
  });

  it('distinguishes a terminal CLOSED EventSource from automatic reconnect', () => {
    expect(streamConnectionOnError(0)).toBe('reconnecting');
    expect(streamConnectionOnError(1)).toBe('reconnecting');
    expect(streamConnectionOnError(2)).toBe('disconnected');
  });

  it('never masks a terminal stream failure with another connected stream', () => {
    expect(connectionLabel('connected', { taskA: 'connected', taskB: 'disconnected' })).toBe(
      'Live event stream disconnected',
    );
    expect(connectionLabel('connected', { taskA: 'reconnecting', taskB: 'disconnected' })).toBe(
      'Live event stream disconnected',
    );
    expect(connectionLabel('disconnected', { taskA: 'disconnected' })).toBe(
      'Server disconnected',
    );
  });

  it('restores live connection status when streams recover', () => {
    expect(connectionLabel('connected', { taskA: 'connected' })).toBe('Live events connected');
  });

  it('prioritizes a failed HTTP connection over healthy stream status', () => {
    expect(connectionLabel('disconnected', { taskA: 'connected' })).toBe('Server disconnected');
  });
});
