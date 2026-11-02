import { describe, expect, it } from 'vitest';
import { isNearLogEnd } from '../src/web/log-follow.js';

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
});
