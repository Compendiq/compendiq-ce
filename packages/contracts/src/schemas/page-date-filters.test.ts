import { describe, expect, expectTypeOf, it } from 'vitest';
import { PageListQuerySchema, type PageListQuery } from './pages.js';

const DATE_KEYS = ['dateFrom', 'dateTo'] as const;

// Keep this 57-value matrix aligned with the real-route suite. Every zone
// spelling has no fraction and each supported precision, not just milliseconds.
const ACCEPTED_FORMATS = [
  { name: 'date ordinary', value: '2025-06-15' },
  { name: 'date leap 2000', value: '2000-02-29' },
  { name: 'date leap 2024', value: '2024-02-29' },
  { name: 'date year 0001', value: '0001-01-01' },
  { name: 'date year 9999', value: '9999-12-31' },
  ...['Z', '+00:00', '-00:00', '+05:30', '-04:00', '+15:59', '-15:59'].flatMap((zone) =>
    Array.from({ length: 7 }, (_, digits) => ({
      name: `timestamp ${zone} fraction ${digits}`,
      value: `2025-06-15T06:30:00${digits ? `.${'123456'.slice(0, digits)}` : ''}${zone}`,
    })),
  ),
  { name: 'timestamp leap 2000', value: '2000-02-29T00:00:00Z' },
  { name: 'timestamp year 0001', value: '0001-01-01T00:00:00Z' },
  { name: 'timestamp year 9999', value: '9999-12-31T00:00:00Z' },
];

// These are malformed/outside the PostgreSQL timestamp input domain. The
// separate profile-hardening group does NOT claim every old response was 500.
const INVALID_DATES = [
  'notadate',
  '2025-02-29', '1900-02-29', '2025-04-31',
  '2025-13-01', '2025-00-01', '2025-01-00', '2025-01-32',
  '2025-02-29T12:00:00Z', '1900-02-29T12:00:00+05:30',
  '0000-01-01', '0000-02-29', '0000-01-01T00:00:00Z',
  '2025-06-15T25:00:00Z', '2025-06-15T12:60:00Z', '2025-06-15T12:00:61Z',
  '2025-06-15T12:00:00+16:00', '2025-06-15T12:00:00-16:00',
  '2025-06-15T12:00:00+23:59', '2025-06-15T12:00:00-23:59',
  '2025-06-15T12:00:00+24:00', '2025-06-15T12:00:00+05:60',
  '2025-06-15T12:00:00+15:60',
];

const UNSUPPORTED_PROFILE = [
  '', ' ', '\t',
  ' 2025-06-15', '2025-06-15 ', '2025-06-15\n', '2025-06-15\r\n', '2025-06-15\u2028',
  '2025-06-15T06:30:00Z\n', '2025-06-15T06:30:00Z\r\n', '2025-06-15T06:30:00Z\u2029',
  'now', 'today', 'epoch', 'infinity', '-infinity',
  '2025-06-15T24:00:00Z', '2025-06-15T23:59:60Z',
  '2025-06-15T12:00Z', '2025-06-15T12:00+05:30', '2025-06-15T12:00:00',
  '2025-06-15 12:00:00Z', '2025-06-15t12:00:00z',
  '20250615', '2025-6-15',
  '2025-06-15T12:00:00+0530', '2025-06-15T12:00:00+05',
  '2025-06-15T12:00:00+05:30:00', '2025-06-15T12:00:00 UTC',
  '2025-06-15T12:00:00.Z',
  '2025-06-15T12:00:00.1234567Z',
  '2025-06-15T12:00:00.1234567+05:30', '2025-06-15T12:00:00.1234567-04:00',
  `2025-06-15T12:00:00.${'1'.repeat(100)}Z`,
  '+010000-01-01', '-0001-01-01', '10000-01-01',
];

function expectRejected(value: unknown): void {
  for (const key of DATE_KEYS) {
    const result = PageListQuerySchema.safeParse({ [key]: value });
    expect.soft(result.success, `${key}=${JSON.stringify(value)}`).toBe(false);
    if (!result.success) {
      expect.soft(result.error.issues.map((issue) => issue.path.join('.'))).toContain(key);
    }
  }
}

describe('date filters boundary regression', () => {
  it.each(INVALID_DATES)('rejects %j through both existing list fields', expectRejected);

  it('does not ignore an invalid bound beside a valid companion', () => {
    for (const key of DATE_KEYS) {
      expect.soft(PageListQuerySchema.safeParse({
        dateFrom: '2025-06-01', dateTo: '2025-06-30', [key]: 'notadate',
      }).success).toBe(false);
    }
  });
});

describe('date filters profile hardening', () => {
  it.each(UNSUPPORTED_PROFILE)('rejects the explicitly unsupported spelling %j', expectRejected);
});

describe('date filters accepted profile', () => {
  it.each(ACCEPTED_FORMATS)('$name round-trips each key and the pair without normalization', ({ value }) => {
    for (const key of DATE_KEYS) {
      const parsed = PageListQuerySchema.parse({ [key]: value });
      expect(parsed[key]).toBe(value);
      expect(parsed[key === 'dateFrom' ? 'dateTo' : 'dateFrom']).toBeUndefined();
    }
    expect(PageListQuerySchema.parse({ dateFrom: value, dateTo: value })).toMatchObject({
      dateFrom: value, dateTo: value,
    });
  });
});

describe('date filters preservation — existing request shape', () => {
  it('preserves omitted fields, defaults and optional string types', () => {
    expect(PageListQuerySchema.parse({})).toEqual({ page: 1, limit: 50, sort: 'title' });
    expectTypeOf<PageListQuery['dateFrom']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PageListQuery['dateTo']>().toEqualTypeOf<string | undefined>();
  });

  it.each([null, 0, true, [], ['2025-06-15'], {}].map((value) => ({ value })))(
    'continues rejecting non-string input $value', ({ value }) => expectRejected(value),
  );

  it('preserves other filters and coercion', () => {
    expect(PageListQuerySchema.parse({
      dateFrom: '2025-06-01', dateTo: '2025-06-30', page: '2', limit: '20', sort: 'modified',
      qualityMin: '10', qualityMax: '90', qualityStatus: 'policy_blocked',
      visibility: 'private', source: 'standalone', aiPolicy: 'all',
    })).toEqual({
      dateFrom: '2025-06-01', dateTo: '2025-06-30', page: 2, limit: 20, sort: 'modified',
      qualityMin: 10, qualityMax: 90, qualityStatus: 'policy_blocked',
      visibility: 'private', source: 'standalone', aiPolicy: 'all',
    });
  });

  it('accepts individually valid reversed bounds without a pair-order refinement', () => {
    const reversed = { dateFrom: '2025-06-15T01:00:00Z', dateTo: '2025-06-15T05:00:00+05:30' };
    expect(PageListQuerySchema.parse(reversed)).toMatchObject(reversed);
  });
});
