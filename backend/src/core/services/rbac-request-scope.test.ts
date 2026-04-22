import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB so we can count resolver invocations without a real Postgres.
// `getUserAccessibleSpaces` issues a single SELECT against
// `space_role_assignments`; counting that call tells us whether the memoised
// wrapper (ADR-022) actually deduplicated work for a given request scope.
vi.mock('../db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [{ space_key: 'SPACE1' }] }),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// Disable Redis so the resolver always hits the DB mock.
vi.mock('./redis-cache.js', () => ({
  getRedisClient: vi.fn().mockReturnValue(null),
  setRedisClient: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { query as mockQuery } from '../db/postgres.js';
import { runWithRbacScope } from './rbac-request-scope.js';
import { getUserAccessibleSpacesMemoized } from './rbac-service.js';

describe('rbac-request-scope', () => {
  beforeEach(() => {
    (mockQuery as ReturnType<typeof vi.fn>).mockReset();
    // Every call to `getUserAccessibleSpaces` fires two SELECTs:
    //   1. `isSystemAdmin` — must return zero rows so we stay on the
    //      non-admin branch (avoids a third query for "all spaces").
    //   2. The space-role join — returns the user's readable-space set.
    // We alternate between empty (admin check) and `[{ space_key: 'SPACE1' }]`
    // (space lookup) so the counts are stable and predictable.
    (mockQuery as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (/FROM users\b.*role.*=.*'admin'/is.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ space_key: 'SPACE1' }], rowCount: 1 };
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls the underlying resolver exactly once per request scope', async () => {
    await runWithRbacScope('u1', async () => {
      const a = await getUserAccessibleSpacesMemoized('u1');
      const b = await getUserAccessibleSpacesMemoized('u1');
      const c = await getUserAccessibleSpacesMemoized('u1');
      expect(a).toEqual(['SPACE1']);
      expect(b).toEqual(['SPACE1']);
      expect(c).toEqual(['SPACE1']);
    });
    // First call inside the scope triggers isSystemAdmin (1 query) + the
    // space-lookup (1 query). Every subsequent call returns the memoised
    // array without touching the DB. Expect exactly 2 total DB hits.
    expect((mockQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('fresh scope = fresh resolution (no leakage between requests)', async () => {
    await runWithRbacScope('u1', async () => {
      await getUserAccessibleSpacesMemoized('u1');
    });
    await runWithRbacScope('u1', async () => {
      await getUserAccessibleSpacesMemoized('u1');
    });
    // Each scope is independent, so the DB is hit twice per scope = 4 total.
    expect((mockQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it('returns null from getScopedSpaces when called outside any scope', async () => {
    const { getScopedSpaces } = await import('./rbac-request-scope.js');
    expect(getScopedSpaces('u1')).toBeNull();
  });

  it('memoised wrapper falls back to the resolver when no scope is active', async () => {
    // Without runWithRbacScope, the memoised wrapper still works — it just
    // hits the DB every call. Verifies the degradation path (background
    // workers, unit tests that skipped the scope) stays correct.
    await getUserAccessibleSpacesMemoized('u1');
    await getUserAccessibleSpacesMemoized('u1');
    // 2 calls × 2 queries each (isSystemAdmin + space lookup) = 4
    expect((mockQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });
});
