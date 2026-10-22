import { describe, expect, it } from 'vitest';
import { selectOfficeSeats } from '../src/web/office-layout.js';

type Seat = Parameters<typeof selectOfficeSeats>[0][number];
const agent = (id: string, state = 'idle', active = false) =>
  ({ id, active, status: { state } }) as Seat;

describe('office seating', () => {
  it('always displays the inspected profile even when busy workers occupy both seats', () => {
    const agents = [agent('coder', 'working'), agent('reviewer', 'thinking'), agent('qa')];
    expect(selectOfficeSeats(agents, 'qa', 2).map((item) => item.id)).toEqual(['coder', 'qa']);
  });

  it('preserves the stable default workstation order', () => {
    const agents = [agent('one'), agent('two'), agent('three', 'stopping')];
    expect(selectOfficeSeats(agents, 'one', 2).map((item) => item.id)).toEqual(['one', 'two']);
  });

  it('keeps active workers visible when inspecting a hidden profile', () => {
    const agents = [agent('one', 'working'), agent('two'), agent('three')];
    expect(selectOfficeSeats(agents, 'three', 2).map((item) => item.id)).toEqual(['one', 'three']);
  });

  it('never invents a profile when the selected id is missing', () => {
    expect(selectOfficeSeats([agent('one')], 'missing', 2).map((item) => item.id)).toEqual(['one']);
  });

  it('respects zero capacity and does not mutate the source', () => {
    const agents = [agent('one'), agent('two')];
    expect(selectOfficeSeats(agents, 'two', 0)).toEqual([]);
    expect(agents.map((item) => item.id)).toEqual(['one', 'two']);
  });
});
