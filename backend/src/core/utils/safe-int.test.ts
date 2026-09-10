import { describe, it, expect, afterEach } from 'vitest';
import { safeIntOr, vitestIntOr } from './safe-int.js';

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

describe('vitestIntOr', () => {
  const KEY = 'VITEST_INT_OR_PROBE';
  const prevVitest = process.env.VITEST;
  const prevKey = process.env[KEY];

  afterEach(() => {
    if (prevVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = prevVitest;
    if (prevKey === undefined) delete process.env[KEY];
    else process.env[KEY] = prevKey;
  });

  it('always returns the production fallback when VITEST is not true', () => {
    delete process.env.VITEST;
    process.env[KEY] = '50';
    expect(vitestIntOr(KEY, 10_000)).toBe(10_000);
  });

  it('honours a positive override under Vitest', () => {
    process.env.VITEST = 'true';
    process.env[KEY] = '200';
    expect(vitestIntOr(KEY, 10_000)).toBe(200);
  });

  it('falls back on garbage under Vitest rather than returning NaN', () => {
    process.env.VITEST = 'true';
    process.env[KEY] = 'nope';
    expect(vitestIntOr(KEY, 5_000)).toBe(5_000);
  });
});
