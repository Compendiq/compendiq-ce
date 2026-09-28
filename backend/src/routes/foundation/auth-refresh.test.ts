import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import type { PoolClient } from 'pg';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import {
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  verifyRefreshToken,
  revokeToken,
  revokeTokenFamily,
  revokeAllUserTokens,
  cleanupExpiredTokens,
  verifyToken,
} from '../../core/plugins/auth.js';
import { authRoutes } from './auth.js';

const dbAvailable = await isDbAvailable();

interface InjectedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
}

function refreshCookieOf(response: InjectedResponse): string | null {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header === undefined ? [] : [String(header)];
  for (const value of values) {
    const match = /^kb_refresh=([^;]*)/.exec(value);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

describe.skipIf(!dbAvailable)('Refresh Token Rotation and Revocation', () => {
  let testUserId: string;
  let app: FastifyInstance;

  const testPayload = () => ({
    sub: testUserId,
    username: 'testuser',
    role: 'user' as const,
  });

  const refreshRoute = (token: string) =>
    app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { kb_refresh: token } });

  async function activeJtis(where: 'family' | 'user_id', value: string): Promise<string[]> {
    const result = await query<{ jti: string }>(
      `SELECT jti FROM refresh_tokens WHERE ${where} = $1 AND revoked = FALSE`,
      [value],
    );
    return result.rows.map((row) => row.jti);
  }

  /**
   * Holds a row lock on one refresh_tokens row from a separate connection.
   * This only makes the production interleaving deterministic: requests that
   * reach the claim UPDATE on that row wait until the barrier is released.
   */
  async function holdTokenRow(jti: string): Promise<Barrier> {
    return holdRow('SELECT jti FROM refresh_tokens WHERE jti = $1 FOR UPDATE', jti);
  }

  interface Barrier {
    /** Idempotent: the finally-block release after an in-test release is a no-op. */
    release(): Promise<void>;
  }

  async function holdRow(sql: string, param: string): Promise<Barrier> {
    const client: PoolClient = await getPool().connect();
    let released = false;
    const barrier: Barrier = {
      async release() {
        if (released) return;
        released = true;
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      },
    };
    try {
      await client.query('BEGIN');
      await client.query(sql, [param]);
    } catch (error) {
      await barrier.release();
      throw error;
    }
    return barrier;
  }

  /** Waits until `count` sessions in this worker database wait on a lock. */
  async function lockWaiters(count: number): Promise<boolean> {
    return waitForDatabaseCondition(async () => {
      const waiting = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'`,
      );
      return waiting.rows[0]!.n >= count;
    });
  }

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(cookie);
    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAllTables();
    // Create test user
    const result = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('testuser', 'fakehash', 'user') RETURNING id",
    );
    testUserId = result.rows[0].id;
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe('generateRefreshToken', () => {
    it('should generate a token with JTI and family', async () => {
      const result = await generateRefreshToken(testPayload());
      expect(result.token).toBeTruthy();
      expect(result.jti).toBeTruthy();
      expect(result.family).toBeTruthy();
    });

    it('should store the JTI in the database', async () => {
      const { jti } = await generateRefreshToken(testPayload());
      const dbResult = await query<{ jti: string; revoked: boolean }>(
        'SELECT jti, revoked FROM refresh_tokens WHERE jti = $1',
        [jti],
      );
      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].jti).toBe(jti);
      expect(dbResult.rows[0].revoked).toBe(false);
    });

    it('should create a new family when none provided', async () => {
      const result1 = await generateRefreshToken(testPayload());
      const result2 = await generateRefreshToken(testPayload());
      expect(result1.family).not.toBe(result2.family);
    });

    it('should generate unique JTIs', async () => {
      const t1 = await generateRefreshToken(testPayload());
      const t2 = await generateRefreshToken(testPayload());
      expect(t1.jti).not.toBe(t2.jti);
    });
  });

  describe('rotateRefreshToken', () => {
    it('consumes the presented JTI and leaves exactly one active same-family successor', async () => {
      const initial = await generateRefreshToken(testPayload());
      const rotated = await rotateRefreshToken(initial.token);

      const successor = await verifyRefreshToken(rotated.refreshToken);
      expect(successor.family).toBe(initial.family);
      expect(successor.jti).not.toBe(initial.jti);
      expect(await activeJtis('family', initial.family)).toEqual([successor.jti]);
      expect((await verifyToken(rotated.accessToken)).sub).toBe(testUserId);
      expect(rotated.user).toEqual({
        id: testUserId,
        username: 'testuser',
        role: 'user',
        email: null,
        displayName: null,
      });
    });

    it('signs the successor with the current database role, not the presented claims', async () => {
      const initial = await generateRefreshToken(testPayload());
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [testUserId]);

      const rotated = await rotateRefreshToken(initial.token);

      expect(rotated.user.role).toBe('admin');
      expect((await verifyToken(rotated.accessToken)).role).toBe('admin');
    });

    it('rejects a deactivated user and revokes the presented JTI', async () => {
      const initial = await generateRefreshToken(testPayload());
      await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [testUserId]);

      await expect(rotateRefreshToken(initial.token)).rejects.toThrow(/deactivated/);

      expect(await activeJtis('user_id', testUserId)).toEqual([]);
    });

    it('rejects a signed token whose JTI is not persisted without touching other sessions', async () => {
      const other = await generateRefreshToken(testPayload());
      const orphan = await generateRefreshToken(testPayload());
      await query('DELETE FROM refresh_tokens WHERE jti = $1', [orphan.jti]);

      await expect(rotateRefreshToken(orphan.token)).rejects.toThrow(/not found/);

      expect(await activeJtis('user_id', testUserId)).toEqual([other.jti]);
    });
  });

  describe('verifyRefreshToken', () => {
    it('should verify a valid refresh token', async () => {
      const { token } = await generateRefreshToken(testPayload());
      const payload = await verifyRefreshToken(token);
      expect(payload.sub).toBe(testUserId);
      expect(payload.username).toBe('testuser');
      expect(payload.jti).toBeTruthy();
      expect(payload.family).toBeTruthy();
    });

    it('should reject a revoked token', async () => {
      const { token, jti } = await generateRefreshToken(testPayload());
      await revokeToken(jti);
      // Attempting to use a revoked token should trigger family revocation
      await expect(verifyRefreshToken(token)).rejects.toThrow(/reuse detected/);
    });

    it('should revoke entire family on reuse detection', async () => {
      // A three-generation family: t1 and t2 consumed, t3 live.
      const t1 = await generateRefreshToken(testPayload());
      const t2 = await rotateRefreshToken(t1.token);
      await rotateRefreshToken(t2.refreshToken);
      const unrelated = await generateRefreshToken(testPayload());

      // Presenting consumed t1 again revokes the whole family
      await expect(verifyRefreshToken(t1.token)).rejects.toThrow(/reuse detected/);

      expect(await activeJtis('family', t1.family)).toEqual([]);
      expect(await activeJtis('user_id', testUserId)).toEqual([unrelated.jti]);
    });

    // #307 review Finding #5: reuse detection must emit SESSION_REVOKED so
    // the compliance Authentication report surfaces session-hijack events.
    it('should emit a SESSION_REVOKED audit event on reuse detection', async () => {
      const t1 = await generateRefreshToken(testPayload());
      await rotateRefreshToken(t1.token);

      await expect(verifyRefreshToken(t1.token)).rejects.toThrow(/reuse detected/);

      const audit = await query<{ metadata: Record<string, unknown>; user_id: string | null }>(
        `SELECT metadata, user_id FROM audit_log
           WHERE action = 'SESSION_REVOKED'
             AND resource_id = $1`,
        [testUserId],
      );
      expect(audit.rows.length).toBeGreaterThanOrEqual(1);
      // Reason must be the compliance-documented token_reuse_detected flag
      // so reports can distinguish voluntary logouts from hijack responses.
      const reuseRow = audit.rows.find((r) => r.metadata['reason'] === 'token_reuse_detected');
      expect(reuseRow).toBeDefined();
      expect(reuseRow!.metadata['family']).toBe(t1.family);
      expect(reuseRow!.user_id).toBe(testUserId);
    });
  });

  describe('revokeToken', () => {
    it('should mark a single token as revoked', async () => {
      const { jti } = await generateRefreshToken(testPayload());
      await revokeToken(jti);

      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE jti = $1',
        [jti],
      );
      expect(result.rows[0].revoked).toBe(true);
    });
  });

  describe('revokeTokenFamily', () => {
    it('should revoke all tokens in a family and nothing else', async () => {
      const t1 = await generateRefreshToken(testPayload());
      const t2 = await rotateRefreshToken(t1.token);
      await rotateRefreshToken(t2.refreshToken);
      const unrelated = await generateRefreshToken(testPayload());

      await revokeTokenFamily(t1.family);

      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE family = $1',
        [t1.family],
      );
      expect(result.rows).toHaveLength(3);
      expect(result.rows.every((r) => r.revoked)).toBe(true);
      expect(await activeJtis('user_id', testUserId)).toEqual([unrelated.jti]);
    });
  });

  describe('revokeAllUserTokens', () => {
    it('should revoke all tokens for a user (logout)', async () => {
      // Create multiple families
      await generateRefreshToken(testPayload());
      await generateRefreshToken(testPayload());
      await generateRefreshToken(testPayload());

      await revokeAllUserTokens(testUserId);

      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE user_id = $1',
        [testUserId],
      );
      expect(result.rows.length).toBe(3);
      expect(result.rows.every((r) => r.revoked)).toBe(true);
    });
  });

  describe('cleanupExpiredTokens', () => {
    it('should delete expired tokens', async () => {
      await generateRefreshToken(testPayload());

      // Manually expire the token
      await query(
        "UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1",
        [testUserId],
      );

      const deleted = await cleanupExpiredTokens();
      expect(deleted).toBe(1);

      const remaining = await query(
        'SELECT COUNT(*) as count FROM refresh_tokens WHERE user_id = $1',
        [testUserId],
      );
      expect(parseInt(remaining.rows[0].count, 10)).toBe(0);
    });

    it('should not delete non-expired tokens', async () => {
      await generateRefreshToken(testPayload());
      const deleted = await cleanupExpiredTokens();
      expect(deleted).toBe(0);
    });
  });

  describe('POST /api/auth/refresh (real PostgreSQL)', () => {
    it('lets exactly one of two concurrent same-cookie refreshes win and then revokes the family', async () => {
      const initial = await generateRefreshToken(testPayload());
      const blocker = await holdTokenRow(initial.jti);
      let responses: InjectedResponse[];
      try {
        const attempts = [refreshRoute(initial.token), refreshRoute(initial.token)];
        // Both requests reached the database before either consumed the JTI:
        // one waits on the barrier, the other on the user's session lock.
        expect(await lockWaiters(2)).toBe(true);
        await blocker.release();
        responses = await Promise.all(attempts);
      } finally {
        await blocker.release();
      }

      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 401]);
      const winnerCookie = refreshCookieOf(responses.find((r) => r.statusCode === 200)!);
      expect(winnerCookie).not.toBeNull();
      expect(refreshCookieOf(responses.find((r) => r.statusCode === 401)!)).toBeNull();

      // One successor was minted, and the loser's reuse response revoked it.
      const family = await query<{ jti: string; revoked: boolean }>(
        'SELECT jti, revoked FROM refresh_tokens WHERE family = $1',
        [initial.family],
      );
      expect(family.rows).toHaveLength(2);
      expect(await activeJtis('family', initial.family)).toEqual([]);
      expect((await refreshRoute(winnerCookie!)).statusCode).toBe(401);
    });

    it('revokes every persisted descendant on sequential replay', async () => {
      const initial = await generateRefreshToken(testPayload());
      const first = await refreshRoute(initial.token);
      expect(first.statusCode).toBe(200);
      const descendant = refreshCookieOf(first)!;

      const replay = await refreshRoute(initial.token);
      expect(replay.statusCode).toBe(401);
      expect(refreshCookieOf(replay)).toBeNull();

      expect(await activeJtis('family', initial.family)).toEqual([]);
      expect((await refreshRoute(descendant)).statusCode).toBe(401);
    });

    it.each(['rotation first', 'replay first'] as const)(
      'leaves no active token when replay-driven family revocation races successor creation (%s)',
      async (order) => {
        const initial = await generateRefreshToken(testPayload());
        const second = await rotateRefreshToken(initial.token);
        const secondJti = (await verifyRefreshToken(second.refreshToken)).jti;

        const blocker = await holdTokenRow(secondJti);
        let rotation!: InjectedResponse;
        let replay!: InjectedResponse;
        try {
          const start = order === 'rotation first'
            ? [() => refreshRoute(second.refreshToken), () => refreshRoute(initial.token)]
            : [() => refreshRoute(initial.token), () => refreshRoute(second.refreshToken)];
          const firstAttempt = start[0]!();
          expect(await lockWaiters(1)).toBe(true);
          const secondAttempt = start[1]!();
          expect(await lockWaiters(2)).toBe(true);
          await blocker.release();
          const [a, b] = await Promise.all([firstAttempt, secondAttempt]);
          [rotation, replay] = order === 'rotation first' ? [a, b] : [b, a];
        } finally {
          await blocker.release();
        }

        expect(replay.statusCode).toBe(401);
        expect(rotation.statusCode).toBe(order === 'rotation first' ? 200 : 401);
        expect(await activeJtis('family', initial.family)).toEqual([]);
        const lateCookie = refreshCookieOf(rotation);
        if (lateCookie) expect((await refreshRoute(lateCookie)).statusCode).toBe(401);
      },
    );

    it('does not let a successor escape a family revocation that started before it committed', async () => {
      // The revocation's UPDATE would miss a successor committed after its
      // snapshot; the shared user lock makes it wait for the rotation.
      const initial = await generateRefreshToken(testPayload());
      const second = await rotateRefreshToken(initial.token);
      const secondJti = (await verifyRefreshToken(second.refreshToken)).jti;

      const blocker = await holdTokenRow(secondJti);
      let rotation!: InjectedResponse;
      let revocation!: PromiseSettledResult<unknown>;
      try {
        const rotationAttempt = refreshRoute(second.refreshToken);
        expect(await lockWaiters(1)).toBe(true);
        const revocationAttempt = revokeTokenFamily(initial.family);
        expect(await lockWaiters(2)).toBe(true);
        await blocker.release();
        [rotation, revocation] = [
          await rotationAttempt,
          (await Promise.allSettled([revocationAttempt]))[0]!,
        ];
      } finally {
        await blocker.release();
      }

      expect(revocation.status).toBe('fulfilled');
      expect(rotation.statusCode).toBe(200);
      expect(await activeJtis('family', initial.family)).toEqual([]);
      expect((await refreshRoute(refreshCookieOf(rotation)!)).statusCode).toBe(401);
    });

    it('leaves no active token when logout races an in-flight refresh', async () => {
      const initial = await generateRefreshToken(testPayload());
      const otherSession = await generateRefreshToken(testPayload());
      const accessToken = await generateAccessToken(testPayload());

      const blocker = await holdTokenRow(initial.jti);
      let rotation!: InjectedResponse;
      let logout!: InjectedResponse;
      try {
        const rotationAttempt = refreshRoute(initial.token);
        expect(await lockWaiters(1)).toBe(true);
        const logoutAttempt = app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { authorization: `Bearer ${accessToken}` },
          cookies: { kb_refresh: initial.token },
        });
        expect(await lockWaiters(2)).toBe(true);
        await blocker.release();
        [rotation, logout] = await Promise.all([rotationAttempt, logoutAttempt]);
      } finally {
        await blocker.release();
      }

      expect(logout.statusCode).toBe(200);
      expect(rotation.statusCode).toBe(200);
      // dev's logout scope (every refresh token of the user) now includes the
      // successor the concurrent refresh committed first.
      expect(await activeJtis('user_id', testUserId)).toEqual([]);
      expect((await refreshRoute(refreshCookieOf(rotation)!)).statusCode).toBe(401);
      expect((await refreshRoute(otherSession.token)).statusCode).toBe(401);
    });

    it('returns 503 without consuming the cookie when the session lock wait times out', async () => {
      const initial = await generateRefreshToken(testPayload());
      const blocker = await holdRow('SELECT id FROM users WHERE id = $1 FOR UPDATE', testUserId);
      let busy!: InjectedResponse;
      try {
        busy = await refreshRoute(initial.token);
      } finally {
        await blocker.release();
      }

      expect(busy.statusCode).toBe(503);
      expect(refreshCookieOf(busy)).toBeNull();
      expect(await activeJtis('family', initial.family)).toEqual([initial.jti]);
      expect((await refreshRoute(initial.token)).statusCode).toBe(200);
    }, 20_000);

    it('still revokes every session on logout when the users row stays locked past the deadline', async () => {
      const first = await generateRefreshToken(testPayload());
      const second = await generateRefreshToken(testPayload());
      const accessToken = await generateAccessToken(testPayload());
      // NO KEY UPDATE, like a concurrent admin edit: the logout audit insert's
      // foreign-key check (KEY SHARE) must still get through.
      const blocker = await holdRow('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', testUserId);
      let logout!: InjectedResponse;
      try {
        logout = await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { authorization: `Bearer ${accessToken}` },
        });
      } finally {
        await blocker.release();
      }

      expect(logout.statusCode).toBe(200);
      expect(await activeJtis('user_id', testUserId)).toEqual([]);
      expect((await refreshRoute(first.token)).statusCode).toBe(401);
      expect((await refreshRoute(second.token)).statusCode).toBe(401);
    }, 20_000);
  });

  describe('Logout with expired access token (refresh cookie fallback)', () => {
    it('should allow user identification from refresh token when access token is unavailable', async () => {
      // Simulate the logout flow when access token has expired:
      // 1. Generate refresh token (as if user was logged in)
      const { token: refreshToken } = await generateRefreshToken(testPayload());

      // 2. Verify refresh token to extract user ID (fallback path)
      const payload = await verifyRefreshToken(refreshToken);
      expect(payload.sub).toBe(testUserId);

      // 3. Revoke all user tokens (logout)
      await revokeAllUserTokens(payload.sub);

      // 4. Verify all tokens are revoked
      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE user_id = $1',
        [testUserId],
      );
      expect(result.rows.every((r) => r.revoked)).toBe(true);
    });

    it('should revoke the specific refresh token JTI during logout fallback', async () => {
      const { token: refreshToken } = await generateRefreshToken(testPayload());

      // Verify and get payload with JTI
      const payload = await verifyRefreshToken(refreshToken);

      // Revoke specific JTI (as the logout route does before revoking all)
      await revokeToken(payload.jti);

      // Then revoke all user tokens
      await revokeAllUserTokens(payload.sub);

      // Verify the specific JTI is revoked
      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE jti = $1',
        [payload.jti],
      );
      expect(result.rows[0].revoked).toBe(true);
    });
  });
});
