import { describe, it, expect } from 'vitest';
import { entranceDelay } from './pinned-articles-layout';

describe('entranceDelay', () => {
  it('staggers the first few cards', () => {
    expect(entranceDelay(0)).toBe(0);
    expect(entranceDelay(1)).toBeCloseTo(0.05);
    expect(entranceDelay(3)).toBeCloseTo(0.15);
  });

  it('plateaus at 0.35s rather than queueing infinitely', () => {
    const max = entranceDelay(7);
    expect(entranceDelay(100)).toBe(max);
    expect(entranceDelay(1000)).toBe(max);
    expect(max).toBeCloseTo(0.35);
  });
});

