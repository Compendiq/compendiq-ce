import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// JWT_SECRET must be set before the auth plugin's verifyToken/generateAccessToken
// run (they read it at call time). 32+ chars to satisfy getJwtSecret().
process.env.JWT_SECRET = 'test-jwt-secret-value-that-is-32-chars-long-abcdef';

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

// The auth hook's only DB-touching external dep on the happy path is the cached
// liveness/role check (#737). Mock it to a live non-admin user so the hook never
// hits the DB itself — every query the test counts then belongs to RBAC space
// resolution, which is the thing the memo is supposed to deduplicate.
vi.mock('./user-security-cache.js', () => ({
  getUserSecurityState: vi.fn().mockResolvedValue({ kind: 'active', role: 'user' }),
}));

import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { query as mockQuery } from '../db/postgres.js';
import { runWithRbacScope } from './rbac-request-scope.js';
import { getUserAccessibleSpacesMemoized } from './rbac-service.js';
import authPlugin, { generateAccessToken } from '../plugins/auth.js';

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

  it('real auth.ts hook enters the scope so the route handler memoises (#899)', async () => {
    // Regression guard that exercises the ACTUAL `authenticate` decorator from
    // auth.ts (not a stand-in) driven through a real Fastify request lifecycle.
    // The auth hook enters the RBAC scope *synchronously* before its first
    // `await` (verifyToken / getUserSecurityState); ADR-022's per-request memo
    // then survives into the route handler that Fastify runs as a separate
    // awaited continuation. `enterWith` bound AFTER an await binds a resumed
    // frame the handler never inherits, so if enterRbacScope() were reordered
    // back below an await inside auth.ts the scope would be dead in the handler
    // and every retrieval path would re-hit the DB. This test asserts the memo
    // holds end-to-end, so that reordering would flip the query count 2 -> 4
    // and fail here — catching the regression inside auth.ts itself, not merely
    // a local model of it.
    const app = Fastify();
    // @fastify/sensible provides fastify.httpErrors, which the auth hook uses.
    await app.register(sensible);
    await app.register(authPlugin);
    // Register the REAL authenticate hook exactly as protected routes do.
    app.get('/probe', { onRequest: [app.authenticate] }, async (request) => {
      // A single request consults the readable-space set from multiple paths;
      // the memo must collapse these to one resolver hit for the whole request.
      await getUserAccessibleSpacesMemoized(request.userId);
      await getUserAccessibleSpacesMemoized(request.userId);
      return { ok: true };
    });
    await app.ready();

    // A genuinely valid token — verifyToken (jose) runs for real; nothing about
    // the auth ordering is stubbed. Only the external liveness check is mocked.
    const token = await generateAccessToken({ sub: 'u1', username: 'u1', role: 'user' });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // First handler call resolves via isSystemAdmin (1 query) + space lookup
    // (1 query); the second is served from the request scope entered by the real
    // auth hook. If the hook failed to propagate its scope into the handler the
    // memo is dead and the DB is hit 4 times.
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
