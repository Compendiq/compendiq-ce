import { describe, it, expect } from 'vitest';
import { safeIntOr } from './safe-int.js';

describe('safeIntOr', () => {
  it('parses a valid integer string', () => {
    expect(safeIntOr('42', 7)).toBe(42);
  });

  it('falls back on undefined / null / empty', () => {
    expect(safeIntOr(undefined, 7)).toBe(7);
    expect(safeIntOr(null, 7)).toBe(7);
    expect(safeIntOr('', 7)).toBe(7);
  });

  it('falls back on non-numeric garbage (would otherwise be NaN)', () => {
    // The bug this guards: `parseInt('abc') ?? fallback` === NaN (?? ignores NaN),
    // so a NaN would flow downstream (e.g. `elapsed > NaN` is always false).
    expect(safeIntOr('abc', 600000)).toBe(600000);
    expect(safeIntOr('12abc', 7)).toBe(12); // parseInt's leading-digits behaviour is fine
  });

  it('rejects values below min (default min = 1 rejects 0 and negatives)', () => {
    expect(safeIntOr('0', 7)).toBe(7);
    expect(safeIntOr('-5', 7)).toBe(7);
  });

  it('allows 0 when min = 0 (e.g. chunk overlap)', () => {
    expect(safeIntOr('0', 50, 0)).toBe(0);
    expect(safeIntOr('-1', 50, 0)).toBe(50); // still rejects negatives
  });
});
