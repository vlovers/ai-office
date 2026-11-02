import { describe, expect, it } from 'vitest';
import { countEventsAfter, isNearLogEnd, unreadBaseline } from '../src/web/log-follow.js';

describe('task event log follow behavior', () => {
  it('follows when the log is at or near its end', () => {
    expect(isNearLogEnd(600, 1000, 400)).toBe(true);
    expect(isNearLogEnd(552, 1000, 400)).toBe(true);
    expect(isNearLogEnd(551, 1000, 400)).toBe(false);
  });

  it('does not steal the scroll position when reading earlier events', () => {
    expect(isNearLogEnd(200, 1000, 400)).toBe(false);
    expect(isNearLogEnd(200, 1200, 400)).toBe(false);
  });

  it('keeps short logs in follow mode and clamps elastic overscroll', () => {
    expect(isNearLogEnd(0, 200, 400)).toBe(true);
    expect(isNearLogEnd(0, 0, 400)).toBe(true);
    expect(isNearLogEnd(-20, 1000, 400)).toBe(false);
  });

  it('rejects invalid scroll geometry instead of jumping unexpectedly', () => {
    expect(isNearLogEnd(Number.NaN, 1000, 400)).toBe(false);
    expect(isNearLogEnd(600, Number.POSITIVE_INFINITY, 400)).toBe(false);
    expect(isNearLogEnd(550, 1000, 400, 0)).toBe(false);
    expect(isNearLogEnd(0, -1, 400)).toBe(false);
    expect(isNearLogEnd(0, 1000, -1)).toBe(false);
    expect(isNearLogEnd(600, 1000, 400, -1)).toBe(false);
  });

  it('counts only new persisted IDs while following is paused', () => {
    const events = [{ id: 11 }, { id: 13 }, { id: 18 }];
    expect(countEventsAfter(events, null)).toBe(0);
    expect(countEventsAfter(events, 18)).toBe(0);
    expect(countEventsAfter(events, 11)).toBe(2);
    expect(countEventsAfter(events, 12)).toBe(2);
    expect(countEventsAfter(events, 0)).toBe(3);
    expect(countEventsAfter([], 18)).toBe(0);
  });

  it('never regresses the unread cursor when SSE replays older events', () => {
    expect(unreadBaseline(null, undefined)).toBe(0);
    expect(unreadBaseline(21, 19)).toBe(21);
    expect(unreadBaseline(21, 21)).toBe(21);
    expect(unreadBaseline(21, 24)).toBe(24);
  });

  it('ignores malformed event IDs and invalid unread baselines', () => {
    const events = [{ id: 11 }, { id: Number.NaN }, { id: Number.POSITIVE_INFINITY }];
    expect(countEventsAfter(events, 10)).toBe(1);
    expect(countEventsAfter(events, Number.NaN)).toBe(0);
    expect(countEventsAfter(events, -1)).toBe(0);
    expect(unreadBaseline(Number.NaN, 20)).toBe(20);
    expect(unreadBaseline(20, Number.POSITIVE_INFINITY)).toBe(20);
    expect(unreadBaseline(-5, -1)).toBe(0);
  });

  it('counts retained unread events even after the 500-event history cap', () => {
    const retained = Array.from({ length: 500 }, (_, index) => ({ id: index + 101 }));
    expect(countEventsAfter(retained, 550)).toBe(50);
    expect(countEventsAfter(retained, 1)).toBe(500);
  });
});
