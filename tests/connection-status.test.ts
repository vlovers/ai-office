import { describe, expect, it } from 'vitest';
import { connectionLabel } from '../src/web/connection-status.js';

describe('workspace connection status', () => {
  it('shows the HTTP connection before any live streams exist', () => {
    expect(connectionLabel('connecting', {})).toBe('Connecting');
    expect(connectionLabel('connected', {})).toBe('Local server connected');
  });

  it('keeps an SSE reconnect warning visible even after HTTP polling succeeds', () => {
    expect(connectionLabel('connected', { taskA: 'reconnecting' })).toBe(
      'Reconnecting to live events…',
    );
  });

  it('warns if one of several task streams is reconnecting', () => {
    expect(connectionLabel('connected', { taskA: 'connected', taskB: 'reconnecting' })).toBe(
      'Reconnecting to live events…',
    );
  });

  it('restores live connection status when streams recover', () => {
    expect(connectionLabel('connected', { taskA: 'connected' })).toBe('Live events connected');
  });

  it('prioritizes a failed HTTP connection over healthy stream status', () => {
    expect(connectionLabel('disconnected', { taskA: 'connected' })).toBe('Server disconnected');
  });
});
