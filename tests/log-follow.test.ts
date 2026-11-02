import { describe, expect, it } from 'vitest';
import { countEventsAfter, isNearLogEnd } from '../src/web/log-follow.js';

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
    expect(isNearLogEnd(-20, 1000, 400)).toBe(false);
  });

  it('rejects invalid scroll geometry instead of jumping unexpectedly', () => {
    expect(isNearLogEnd(Number.NaN, 1000, 400)).toBe(false);
    expect(isNearLogEnd(600, Number.POSITIVE_INFINITY, 400)).toBe(false);
    expect(isNearLogEnd(550, 1000, 400, 0)).toBe(false);
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

  it('counts retained unread events even after the 500-event history cap', () => {
    const retained = Array.from({ length: 500 }, (_, index) => ({ id: index + 101 }));
    expect(countEventsAfter(retained, 550)).toBe(50);
    expect(countEventsAfter(retained, 1)).toBe(500);
  });
});
