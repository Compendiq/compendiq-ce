import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockQueryFn = vi.fn();

vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
}));

import {
  BulkSelectionSchema,
  resolveBulkSelection,
  buildFilterClauses,
  BulkSelectionError,
} from './bulk-page-selection.js';

describe('BulkSelectionSchema', () => {
  it('accepts ids-only mode', () => {
    expect(BulkSelectionSchema.parse({ ids: ['1', '2'] })).toEqual({ ids: ['1', '2'] });
  });

  it('accepts filter + expectedCount mode', () => {
    const r = BulkSelectionSchema.parse({
      filter: { spaceKey: 'OPS' },
      expectedCount: 42,
    });
    expect(r.expectedCount).toBe(42);
    expect(r.filter?.spaceKey).toBe('OPS');
  });

  it('rejects ids alongside filter', () => {
    expect(() =>
      BulkSelectionSchema.parse({
        ids: ['1'],
        filter: { spaceKey: 'OPS' },
        expectedCount: 1,
      }),
    ).toThrow();
  });

  it('rejects filter without expectedCount', () => {
    expect(() => BulkSelectionSchema.parse({ filter: { spaceKey: 'OPS' } })).toThrow();
  });

  it('rejects empty body', () => {
    expect(() => BulkSelectionSchema.parse({})).toThrow();
  });

  it('rejects unknown filter keys (strict)', () => {
    expect(() =>
      BulkSelectionSchema.parse({
        filter: { spaceKey: 'OPS', search: 'foo' },
        expectedCount: 1,
      }),
    ).toThrow();
  });
});

describe('buildFilterClauses', () => {
  it('builds parts for the standard combination', () => {
    const r = buildFilterClauses(
      { spaceKey: 'OPS', labels: 'a,b,c', source: 'confluence' },
      3,
    );
    expect(r.parts).toEqual([
      'cp.space_key = $3',
      'cp.labels @> $4',
      'cp.source = $5',
    ]);
    expect(r.values).toEqual(['OPS', ['a', 'b', 'c'], 'confluence']);
    expect(r.nextIdx).toBe(6);
  });

  it('skips empty labels', () => {
    const r = buildFilterClauses({ labels: '  ,  ' }, 3);
    expect(r.parts).toEqual([]);
  });

  it('translates freshness=stale into a literal date predicate (no extra param)', () => {
    const r = buildFilterClauses({ freshness: 'stale' }, 3);
    expect(r.parts.some((p) => p.includes("90 days"))).toBe(true);
    expect(r.values).toEqual([]);
  });
});

describe('resolveBulkSelection — ids mode', () => {
  beforeEach(() => {
    mockQueryFn.mockReset();
  });

  it('resolves numeric + confluence ids and reports not-found', async () => {
    mockQueryFn.mockResolvedValueOnce({
      rows: [
        { id: 1, confluence_id: null, space_key: null, source: 'standalone' },
        { id: 2, confluence_id: 'conf-2', space_key: 'OPS', source: 'confluence' },
      ],
      rowCount: 2,
    });

    const r = await resolveBulkSelection(
      'user-1',
      { ids: ['1', 'conf-2', 'conf-missing'] },
      ['OPS'],
    );

    expect(r.rows).toHaveLength(2);
    expect(r.notFoundIds).toEqual(['conf-missing']);
  });

  it('respects numeric-only mode (filters out confluence ids before query)', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await resolveBulkSelection('user-1', { ids: ['1', 'conf-2'] }, ['OPS'], {
      idMode: 'numeric-only',
    });

    const args = mockQueryFn.mock.calls[0]!;
    expect(args[1]![0]).toEqual([1]);            // numericIds
    expect(args[1]![1]).toEqual([]);             // confluenceStringIds (empty)
  });
});

describe('resolveBulkSelection — filter mode', () => {
  beforeEach(() => {
    mockQueryFn.mockReset();
  });

  it('rejects when actual count drifts beyond tolerance (default 5%)', async () => {
    // expectedCount = 100, actual = 110 → allowedDrift = ceil(100 * 0.05) = 5
    // 110 - 100 = 10 > 5 → must throw count_drift
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '110' }], rowCount: 1 });

    await expect(
      resolveBulkSelection(
        'user-1',
        { filter: { spaceKey: 'OPS' }, expectedCount: 100 },
        ['OPS'],
      ),
    ).rejects.toThrow(BulkSelectionError);
  });

  it('passes when actual count is within tolerance', async () => {
    // expectedCount = 100, actual = 102, allowedDrift = 5 → OK
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '102' }], rowCount: 1 });
    mockQueryFn.mockResolvedValueOnce({
      rows: Array.from({ length: 102 }, (_, i) => ({
        id: i + 1,
        confluence_id: null,
        space_key: 'OPS',
        source: 'confluence',
      })),
      rowCount: 102,
    });

    const r = await resolveBulkSelection(
      'user-1',
      { filter: { spaceKey: 'OPS' }, expectedCount: 100 },
      ['OPS'],
    );
    expect(r.rows).toHaveLength(102);
  });

  it('zero-tolerance rejects any drift', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '101' }], rowCount: 1 });

    await expect(
      resolveBulkSelection(
        'user-1',
        { filter: { spaceKey: 'OPS' }, expectedCount: 100, driftToleranceFraction: 0 },
        ['OPS'],
      ),
    ).rejects.toMatchObject({
      detail: { kind: 'count_drift', expected: 100, actual: 101 },
    });
  });

  it('treats expectedCount=0, actual=0 as an empty selection (no-op)', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    const r = await resolveBulkSelection(
      'user-1',
      { filter: { spaceKey: 'EMPTY' }, expectedCount: 0 },
      ['EMPTY'],
    );
    expect(r.rows).toEqual([]);
    expect(r.notFoundIds).toEqual([]);
  });

  it('builds the WHERE clause with RBAC + filter merged', async () => {
    mockQueryFn.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
    mockQueryFn.mockResolvedValueOnce({
      rows: [{ id: 7, confluence_id: 'c', space_key: 'OPS', source: 'confluence' }],
      rowCount: 1,
    });

    await resolveBulkSelection(
      'user-1',
      {
        filter: { spaceKey: 'OPS', labels: 'on-call' },
        expectedCount: 1,
      },
      ['OPS'],
    );

    const countSql = mockQueryFn.mock.calls[0]![0] as string;
    expect(countSql).toContain("cp.space_key = ANY($1::text[])");
    expect(countSql).toContain('cp.deleted_at IS NULL');
    expect(countSql).toContain('cp.space_key = $3');
    expect(countSql).toContain('cp.labels @> $4');

    const dataSql = mockQueryFn.mock.calls[1]![0] as string;
    expect(dataSql).toContain('LIMIT 5000');
  });
});
