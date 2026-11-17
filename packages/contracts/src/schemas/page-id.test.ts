import { describe, expect, it } from 'vitest';
import { PagePrimaryKeySchema } from '../index.js';

// New public feature coverage, not part of #1742's accepted original-red ledger.
describe('PagePrimaryKeySchema public export', () => {
  it.each([
    ['decimal one', '1', 1],
    ['ordinary decimal', '7', 7],
    ['padded decimal', '0007', 7],
    ['maximum decimal', '2147483647', 2_147_483_647],
    ['padded maximum', '00000000002147483647', 2_147_483_647],
    ['numeric one', 1, 1],
    ['ordinary number', 7, 7],
    ['maximum number', 2_147_483_647, 2_147_483_647],
  ] as const)('parses %s into the exact numeric PK', (_label, input, expected) => {
    expect(PagePrimaryKeySchema.parse(input)).toBe(expected);
  });

  it.each([
    ['numeric zero', 0],
    ['negative number', -1],
    ['fractional number', 1.5],
    ['int4 overflow number', 2_147_483_648],
    ['unsafe integer number', 9_007_199_254_740_992],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['empty string', ''],
    ['zero string', '0'],
    ['padded zero', '000'],
    ['negative string', '-7'],
    ['plus sign', '+7'],
    ['leading whitespace', ' 7'],
    ['trailing whitespace', '7 '],
    ['trailing newline', '7\n'],
    ['leading newline', '\n7'],
    ['decimal spelling', '1.0'],
    ['exponent spelling', '1e3'],
    ['hex spelling', '0x10'],
    ['numeric prefix', '7tail'],
    ['int4 overflow string', '2147483648'],
    ['large decimal', '3000000000'],
    ['padded large decimal', '0003000000000'],
    ['beyond safe precision', '9007199254740993'],
    ['fraction that Number would round to maximum', '2147483647.00000001'],
    ['full-width digit', '９'],
    ['Arabic-Indic digit', '١'],
    ['decimal overflowing to infinity', '9'.repeat(400)],
    ['null', null],
    ['undefined', undefined],
    ['boolean true', true],
    ['boolean false', false],
    ['object', { id: 7 }],
    ['array', [7]],
  ] as const)('rejects %s without producing a usable PK', (_label, input) => {
    expect(PagePrimaryKeySchema.safeParse(input).success).toBe(false);
  });
});
