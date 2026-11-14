import { describe, it, expect } from 'vitest';
import { toPageIdInt4, toPageIdText } from './page-id-text.js';

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

// New shared-adapter feature checks; the original four text-normalizer controls stay intact.
describe('toPageIdInt4 shared positive-int4 adapter', () => {
  it.each([
    ['1', 1],
    ['7', 7],
    ['0007', 7],
    ['2147483647', 2_147_483_647],
    ['00000000002147483647', 2_147_483_647],
  ] as const)('returns the exact PK for %s', (input, expected) => {
    expect(toPageIdInt4(input)).toBe(expected);
  });

  it.each([
    '', '0', '000', '-7', '+7', ' 7 ', '7 ', '7\n', '\n7',
    '1.0', '1e3', '0x10', '7tail', '2147483648', '3000000000',
    '0003000000000', '9007199254740993', '2147483647.00000001',
    '９', '١', '9'.repeat(400),
  ])('returns null without throwing for unusable raw text %j', (input) => {
    expect(toPageIdInt4(input)).toBeNull();
  });
});
