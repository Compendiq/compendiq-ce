import { describe, it, expect } from 'vitest';
import { toFixedDecimalString } from './fixed-decimal.js';

/**
 * Trap 2 of #1118, at the unit level: the route test proves the knob
 * round-trips; this proves the helper is what makes it round-trip, and pins
 * the exact strings `String()` would have produced instead.
 */
describe('toFixedDecimalString', () => {
  it('leaves ordinary decimals untouched', () => {
    expect(toFixedDecimalString(0)).toBe('0');
    expect(toFixedDecimalString(30)).toBe('30');
    expect(toFixedDecimalString(0.003)).toBe('0.003');
    expect(toFixedDecimalString(0.7)).toBe('0.7');
    expect(toFixedDecimalString(0.35)).toBe('0.35');
  });

  it('expands the exponent notation String() would have emitted', () => {
    // Each left-hand value stringifies with an exponent — that is the bug.
    expect(String(5e-7)).toBe('5e-7');
    expect(toFixedDecimalString(5e-7)).toBe('0.0000005');
    expect(toFixedDecimalString(1e-7)).toBe('0.0000001');
    expect(toFixedDecimalString(1.25e-8)).toBe('0.0000000125');
  });

  it('survives an exponent far below what toFixed(20) could represent', () => {
    // `(1e-25).toFixed(20)` is '0.00000000000000000000' — the naive fix turns
    // a tiny value into a flat zero.
    expect(toFixedDecimalString(1e-25)).toBe('0.0000000000000000000000001');
  });

  it('round-trips back to the identical double', () => {
    for (const n of [5e-7, 1e-7, 1.25e-8, 0.003, 0.05, 0.7, 1e-25]) {
      expect(Number(toFixedDecimalString(n))).toBe(n);
    }
  });

  it('produces a string the retrieval readers accept', () => {
    // The three strict shapes guarding the decimal knobs.
    const confidence = /^\d*\.?\d+$/;
    const priorWeight = /^\d+(\.\d+)?$/;
    const mmrLambda = /^-?\d+(\.\d+)?$/;
    for (const n of [0, 5e-7, 0.003, 0.05, 0.35, 0.7, 1e-7]) {
      const s = toFixedDecimalString(n);
      expect(confidence.test(s), `${n} → ${s}`).toBe(true);
      expect(priorWeight.test(s), `${n} → ${s}`).toBe(true);
      expect(mmrLambda.test(s), `${n} → ${s}`).toBe(true);
    }
  });

  it('handles a negative exponent-notation value symmetrically', () => {
    // No knob accepts a negative, but the helper must not mangle a sign if a
    // future caller hands it one.
    expect(toFixedDecimalString(-5e-7)).toBe('-0.0000005');
  });

  it('expands a POSITIVE exponent too', () => {
    expect(String(1e21)).toBe('1e+21');
    expect(toFixedDecimalString(1e21)).toBe('1000000000000000000000');
  });
});
