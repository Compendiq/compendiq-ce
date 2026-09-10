import { describe, it, expect } from 'vitest';
import { toPageIdText } from './page-id-text.js';

describe('toPageIdText (#1167)', () => {
  it('leaves a plain id unchanged', () => {
    expect(toPageIdText('7')).toBe('7');
    expect(toPageIdText('12345')).toBe('12345');
  });

  it('strips leading zeros the way the old ::int cast did', () => {
    // `'007'::int` was 7, so `id = $1::int` matched page 7. Text comparison is
    // literal, so without this the overflow fix would silently stop resolving.
    expect(toPageIdText('007')).toBe('7');
    expect(toPageIdText('0000042')).toBe('42');
  });

  it('normalises zero without collapsing it to empty', () => {
    expect(toPageIdText('0')).toBe('0');
    expect(toPageIdText('000')).toBe('0');
  });

  it('preserves ids beyond int4 — the ones that motivated the fix', () => {
    // parseInt/Number would be lossy well before this matters; BigInt is not.
    expect(toPageIdText('2200000000')).toBe('2200000000');
    expect(toPageIdText('00002200000000')).toBe('2200000000');
    expect(toPageIdText('9007199254740993')).toBe('9007199254740993');
  });
});
