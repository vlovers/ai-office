import { describe, expect, it } from 'vitest';
import { nextNavigationIndex } from '../src/web/navigation-keys.js';

describe('destination keyboard navigation', () => {
  it('moves between destinations and wraps at both ends', () => {
    expect(nextNavigationIndex('ArrowRight', 0, 5)).toBe(1);
    expect(nextNavigationIndex('ArrowRight', 4, 5)).toBe(0);
    expect(nextNavigationIndex('ArrowLeft', 0, 5)).toBe(4);
    expect(nextNavigationIndex('ArrowLeft', 3, 5)).toBe(2);
  });

  it('supports Home and End without activating a destination', () => {
    expect(nextNavigationIndex('Home', 3, 5)).toBe(0);
    expect(nextNavigationIndex('End', 1, 5)).toBe(4);
    expect(nextNavigationIndex('Enter', 2, 5)).toBeNull();
    expect(nextNavigationIndex(' ', 2, 5)).toBeNull();
    expect(nextNavigationIndex('Tab', 2, 5)).toBeNull();
  });

  it('ignores invalid indices and empty navigation lists', () => {
    expect(nextNavigationIndex('Home', -1, 5)).toBeNull();
    expect(nextNavigationIndex('ArrowRight', 5, 5)).toBeNull();
    expect(nextNavigationIndex('ArrowLeft', 0, 0)).toBeNull();
  });
});
