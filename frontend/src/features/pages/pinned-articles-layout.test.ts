import { describe, it, expect } from 'vitest';
import { COLLAPSED_PIN_COUNT, entranceDelay, staggerPosition } from './pinned-articles-layout';

describe('entranceDelay', () => {
  it('staggers the first screenful', () => {
    expect(entranceDelay(0)).toBe(0);
    expect(entranceDelay(1)).toBeCloseTo(0.05);
    expect(entranceDelay(3)).toBeCloseTo(0.15);
  });

  // At a flat 0.05s per card the hundredth pin would arrive five seconds after
  // the user pressed "Show all", which reads as a hang, not a transition.
  it('plateaus rather than queueing', () => {
    const max = entranceDelay(COLLAPSED_PIN_COUNT - 1);
    expect(entranceDelay(100)).toBe(max);
    expect(entranceDelay(1000)).toBe(max);
    expect(max).toBeLessThanOrEqual(0.5);
  });
});

describe('staggerPosition', () => {
  it('is the plain index while collapsed', () => {
    expect(staggerPosition(0, false)).toBe(0);
    expect(staggerPosition(5, false)).toBe(5);
  });

  // Expanding only mounts the cards past the cut-off; the ones before it keep
  // their keys and never re-animate. Feeding the new cards their absolute index
  // would put every one of them at the plateau, so they would all appear at
  // once after a dead beat instead of arriving in sequence.
  it('counts newly revealed cards from zero when expanded', () => {
    expect(staggerPosition(COLLAPSED_PIN_COUNT, true)).toBe(0);
    expect(staggerPosition(COLLAPSED_PIN_COUNT + 1, true)).toBe(1);
    expect(staggerPosition(COLLAPSED_PIN_COUNT + 4, true)).toBe(4);
  });

  it('leaves the already-mounted cards alone when expanded', () => {
    expect(staggerPosition(0, true)).toBe(0);
    expect(staggerPosition(COLLAPSED_PIN_COUNT - 1, true)).toBe(COLLAPSED_PIN_COUNT - 1);
  });

  it('gives the revealed cards a real stagger rather than one dead beat', () => {
    const delays = [0, 1, 2, 3].map((n) => entranceDelay(staggerPosition(COLLAPSED_PIN_COUNT + n, true)));
    expect(new Set(delays).size).toBe(4);
    expect(delays[0]).toBe(0);
  });
});
