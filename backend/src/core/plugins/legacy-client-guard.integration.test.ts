import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import bcrypt from 'bcrypt';
import { z, ZodError } from 'zod';
import { AI_POLICY_CLIENT_PROTOCOL_HEADER, CLIENT_RELOAD_REQUIRED } from '@compendiq/contracts';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import {
  cleanupExpiredTokens,
  generateAccessToken,
  generateRefreshToken,
  getAccessTokenLifetimeSeconds,
  verifyToken,
} from './auth.js';
import { authRoutes } from '../../routes/foundation/auth.js';
import { setupRoutes } from '../../routes/foundation/setup.js';
import {
  AI_POLICY_SESSION_ROUTES,
  awaitLegacyClientObservationsForTest,
  registerLegacyClientGuard,
  resetLegacyClientGuardForTest,
} from './legacy-client-guard.js';

/**
 * #1881 design §2.3 / §5 (G2): the legacy-client guard over the real auth
 * routes and the real schema. The switch is written straight to
 * `ai_policy_activation_state`, because the guard must read PostgreSQL on its
 * rare path rather than any process cache.
 */

const dbAvailable = await isDbAvailable();

const PASSWORD = 'correct-horse-battery-staple';
/** A browser request from a pre-#1881 bundle: `Sec-Fetch-Mode`, no marker. */
const LEGACY: Record<string, string> = { 'sec-fetch-mode': 'cors' };
/** The current bundle: marker header in its canonical (mixed) case. */
const MARKED: Record<string, string> = { 'sec-fetch-mode': 'cors', [AI_POLICY_CLIENT_PROTOCOL_HEADER]: '1' };
/** A non-browser client (Playwright's Node `request`, curl, a worker). */
const NON_BROWSER: Record<string, string> = {};

const ExchangeBody = z.object({ code: z.string().min(1) });
/** The fields of `{ accessToken, user }` the assertions read; every covered route answers this shape. */
const SessionBody = z.object({ accessToken: z.string().min(1), user: z.object({ id: z.string().uuid() }) });
const ErrorBody = z.object({ error: z.string() });

interface ObservationRow {
  user_id: string;
  last_seen_at: Date;
  token_expires_at: Date;
  observations: number;
}

function refreshCookieOf(response: LightMyRequestResponse): string | null {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header === undefined ? [] : [String(header)];
  for (const value of values) {
    const match = /^kb_refresh=([^;]*)/.exec(value);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

describe.skipIf(!dbAvailable)('legacy-client guard (#1881 G2)', () => {
  let app: FastifyInstance;
  let passwordHash: string;
  /** The serialized body as it entered the guard's `onSend` (probe hook registered before it). */
  let payloadBeforeGuard: string | null = null;
  /** Stub for EE's exchange: single-use codes, consumed only by the handler. */
  const exchangeCodes = new Map<string, string>();
  let exchangeHandlerCalls = 0;

  async function setSwitch(enabled: boolean): Promise<void> {
    await query(
      `INSERT INTO ai_policy_activation_state (singleton, enabled) VALUES (TRUE, $1)
       ON CONFLICT (singleton) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [enabled],
    );
  }

  async function createUser(username: string, role: 'user' | 'admin' = 'user'): Promise<string> {
    const result = await query<{ id: string }>(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [username, passwordHash, role],
    );
    return result.rows[0]!.id;
  }

  async function observations(): Promise<ObservationRow[]> {
    await awaitLegacyClientObservationsForTest();
    const result = await query<ObservationRow>(
      'SELECT user_id, last_seen_at, token_expires_at, observations FROM ai_policy_legacy_client_observations ORDER BY last_seen_at',
    );
    return result.rows;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const result = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${sql}`, params);
    return result.rows[0]!.n;
  }

  function login(username: string, headers: Record<string, string>, password = PASSWORD) {
    return app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username, password } });
  }

  function refresh(token: string, headers: Record<string, string>) {
    return app.inject({ method: 'POST', url: '/api/auth/refresh', headers, cookies: { kb_refresh: token } });
  }

  function exchange(code: string, headers: Record<string, string>) {
    return app.inject({ method: 'POST', url: '/api/auth/oidc/exchange', headers, payload: { code } });
  }

  beforeAll(async () => {
    await setupTestDb();
    passwordHash = await bcrypt.hash(PASSWORD, 4);
    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(cookie);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
        return;
      }
      const statusCode = error.statusCode ?? 500;
      reply.status(statusCode).send({ error: error.message, statusCode });
    });
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});

    // Probe BEFORE the guard: hooks run in registration order, so this sees
    // exactly the payload the guard's onSend receives. The login and refresh
    // handlers call reply.send() without returning the reply, so Fastify runs
    // onSend a second time with an undefined payload; only the serialized
    // body is the one under test.
    app.addHook('onSend', async (_request, _reply, payload) => {
      if (typeof payload === 'string') payloadBeforeGuard = payload;
      return payload;
    });
    registerLegacyClientGuard(app);

    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.register(setupRoutes, { prefix: '/api' });
    // EE registers its exchange route after the guard (app.ts order); a child
    // plugin created after the root hooks inherits them.
    await app.register(async (ee) => {
      ee.post('/api/auth/oidc/exchange', async (request, reply) => {
        exchangeHandlerCalls += 1;
        const { code } = ExchangeBody.parse(request.body);
        const userId = exchangeCodes.get(code);
        if (userId === undefined) return reply.code(401).send({ error: 'invalid_code' });
        exchangeCodes.delete(code);
        const user = await query<{ id: string; username: string; role: 'user' | 'admin' }>(
          'SELECT id, username, role FROM users WHERE id = $1',
          [userId],
        );
        const row = user.rows[0]!;
        const accessToken = await generateAccessToken({ sub: row.id, username: row.username, role: row.role });
        return { accessToken, user: { id: row.id, username: row.username, role: row.role } };
      });
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    // Settle the previous test's detached upserts before their users vanish.
    await resetLegacyClientGuardForTest();
    await truncateAllTables();
    await setSwitch(false);
    payloadBeforeGuard = null;
    exchangeCodes.clear();
    exchangeHandlerCalls = 0;
  });

  it('pins the allow-list to the five session-issuing POSTs', () => {
    expect([...AI_POLICY_SESSION_ROUTES]).toEqual([
      '/api/auth/refresh',
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/oidc/exchange',
      '/api/setup/admin',
    ]);
  });

  describe('switch off: observation only', () => {
    it('records nothing for a forged unauthenticated legacy login', async () => {
      await createUser('alice');
      const response = await login('alice', LEGACY, 'wrong-password');
      expect(response.statusCode).toBe(401);
      expect(await observations()).toEqual([]);
    });

    it('records a successful legacy login with token_expires_at and leaves the response untouched', async () => {
      const aliceId = await createUser('alice');

      const legacy = await login('alice', LEGACY);
      expect(legacy.statusCode, legacy.body).toBe(200);
      expect(legacy.body).toBe(payloadBeforeGuard);
      const body = SessionBody.parse(legacy.json());
      expect(body.user.id).toBe(aliceId);
      expect((await verifyToken(body.accessToken)).sub).toBe(aliceId);
      expect(refreshCookieOf(legacy)).not.toBeNull();

      // Same route, marked client: identical shape and user record; only the
      // freshly signed tokens differ.
      const marked = await login('alice', MARKED);
      expect(marked.statusCode).toBe(200);
      const stripTokens = (response: LightMyRequestResponse) => ({ ...response.json(), accessToken: undefined });
      expect(stripTokens(marked)).toEqual(stripTokens(legacy));
      expect(refreshCookieOf(marked)).not.toBeNull();

      const rows = await observations();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.user_id).toBe(aliceId);
      expect(rows[0]!.observations).toBe(1);
      const windowSeconds = Math.round((rows[0]!.token_expires_at.getTime() - rows[0]!.last_seen_at.getTime()) / 1000);
      expect(windowSeconds).toBe(getAccessTokenLifetimeSeconds());
    });

    it('records a legacy refresh (new cookie issued), never a marked or non-browser one', async () => {
      const aliceId = await createUser('alice');
      const bobId = await createUser('bob');
      const alice = await generateRefreshToken({ sub: aliceId, username: 'alice', role: 'user' });
      const bob = await generateRefreshToken({ sub: bobId, username: 'bob', role: 'user' });
      const carolId = await createUser('carol');
      const carol = await generateRefreshToken({ sub: carolId, username: 'carol', role: 'user' });

      const markedRefresh = await refresh(alice.token, MARKED);
      expect(markedRefresh.statusCode, markedRefresh.body).toBe(200);
      const nonBrowserRefresh = await refresh(carol.token, NON_BROWSER);
      expect(nonBrowserRefresh.statusCode, nonBrowserRefresh.body).toBe(200);

      const legacyRefresh = await refresh(bob.token, LEGACY);
      expect(legacyRefresh.statusCode, legacyRefresh.body).toBe(200);
      expect(legacyRefresh.body).toBe(payloadBeforeGuard);
      expect(refreshCookieOf(legacyRefresh)).not.toBe(bob.token);
      expect(SessionBody.parse(legacyRefresh.json()).user.id).toBe(bobId);

      const rows = await observations();
      expect(rows.map((row) => row.user_id)).toEqual([bobId]);
    });

    it('records every covered route on a 2xx (setup-admin and register answer 201)', async () => {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES ('registration_mode', 'open', NOW())`,
      );
      const setup = await app.inject({
        method: 'POST', url: '/api/setup/admin', headers: LEGACY, payload: { username: 'first-admin', password: PASSWORD },
      });
      expect(setup.statusCode, setup.body).toBe(201);
      const register = await app.inject({
        method: 'POST', url: '/api/auth/register', headers: LEGACY, payload: { username: 'newcomer', password: PASSWORD },
      });
      expect(register.statusCode, register.body).toBe(201);
      const adminId = SessionBody.parse(setup.json()).user.id;
      const newcomerId = SessionBody.parse(register.json()).user.id;

      const rows = await observations();
      expect(rows.map((row) => row.user_id).sort()).toEqual([adminId, newcomerId].sort());
    });

    it('covers a stub /api/auth/oidc/exchange registered after the guard', async () => {
      const aliceId = await createUser('alice');
      exchangeCodes.set('code-1', aliceId);

      const response = await exchange('code-1', LEGACY);
      expect(response.statusCode, response.body).toBe(200);
      expect(exchangeHandlerCalls).toBe(1);
      expect(response.body).toBe(payloadBeforeGuard);

      const rows = await observations();
      expect(rows.map((row) => row.user_id)).toEqual([aliceId]);
    });

    it('throttles repeated issuances per user for 30 s, counts after the throttle, and never shortens the window', async () => {
      const aliceId = await createUser('alice');
      const bobId = await createUser('bob');

      expect((await login('alice', LEGACY)).statusCode).toBe(200);
      expect((await login('alice', LEGACY)).statusCode).toBe(200);
      expect((await login('bob', LEGACY)).statusCode).toBe(200);
      let rows = await observations();
      expect(Object.fromEntries(rows.map((row) => [row.user_id, row.observations]))).toEqual({ [aliceId]: 1, [bobId]: 1 });

      // A token issued under a longer lifetime must stay visible until it expires.
      await query(
        "UPDATE ai_policy_legacy_client_observations SET token_expires_at = NOW() + interval '2 days' WHERE user_id = $1",
        [aliceId],
      );
      const farFuture = (await observations()).find((row) => row.user_id === aliceId)!.token_expires_at;

      await resetLegacyClientGuardForTest();
      expect((await login('alice', LEGACY)).statusCode).toBe(200);
      rows = await observations();
      const alice = rows.find((row) => row.user_id === aliceId)!;
      expect(alice.observations).toBe(2);
      expect(alice.token_expires_at.getTime()).toBe(farFuture.getTime());
    });
  });

  describe('switch on: refusal before any work', () => {
    beforeEach(async () => {
      await setSwitch(true);
    });

    it('refuses a legacy login with 409 before the credential check or any token issuance', async () => {
      const aliceId = await createUser('alice');

      const response = await login('alice', LEGACY, 'wrong-password');
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: CLIENT_RELOAD_REQUIRED, message: expect.any(String) });
      expect(refreshCookieOf(response)).toBeNull();

      const correct = await login('alice', LEGACY);
      expect(correct.statusCode).toBe(409);
      expect(await count('refresh_tokens')).toBe(0);
      expect(await count("audit_log WHERE action IN ('LOGIN', 'LOGIN_FAILED', 'SESSION_CREATED')")).toBe(0);
      const user = await query<{ last_login_at: Date | null }>('SELECT last_login_at FROM users WHERE id = $1', [aliceId]);
      expect(user.rows[0]!.last_login_at).toBeNull();
      expect(await observations()).toEqual([]);
    });

    it('refuses a legacy refresh before rotation: the presented token stays valid and no successor exists', async () => {
      const aliceId = await createUser('alice');
      const alice = await generateRefreshToken({ sub: aliceId, username: 'alice', role: 'user' });

      const response = await refresh(alice.token, LEGACY);
      expect(response.statusCode).toBe(409);
      expect(ErrorBody.parse(response.json()).error).toBe(CLIENT_RELOAD_REQUIRED);
      const tokens = await query<{ jti: string; revoked: boolean }>('SELECT jti, revoked FROM refresh_tokens');
      expect(tokens.rows).toEqual([{ jti: alice.jti, revoked: false }]);

      // The very same cookie still rotates for a marked client.
      const marked = await refresh(alice.token, MARKED);
      expect(marked.statusCode, marked.body).toBe(200);
    });

    it('refuses legacy register, setup-admin and the EE exchange stub without consuming anything', async () => {
      const aliceId = await createUser('alice');
      exchangeCodes.set('code-1', aliceId);
      const usersBefore = await count('users');

      const register = await app.inject({
        method: 'POST', url: '/api/auth/register', headers: LEGACY, payload: { username: 'newcomer', password: PASSWORD },
      });
      expect(register.statusCode).toBe(409);
      const setup = await app.inject({
        method: 'POST', url: '/api/setup/admin', headers: LEGACY, payload: { username: 'first-admin', password: PASSWORD },
      });
      expect(setup.statusCode).toBe(409);
      const exchanged = await exchange('code-1', LEGACY);
      expect(exchanged.statusCode).toBe(409);

      for (const response of [register, setup, exchanged]) {
        expect(ErrorBody.parse(response.json()).error).toBe(CLIENT_RELOAD_REQUIRED);
      }
      expect(await count('users')).toBe(usersBefore);
      expect(exchangeHandlerCalls).toBe(0);
      expect(exchangeCodes.get('code-1')).toBe(aliceId);
      expect(await observations()).toEqual([]);

      // Reloading the callback URL signs in: the code was never consumed.
      const retried = await exchange('code-1', MARKED);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(exchangeCodes.has('code-1')).toBe(false);
    });

    it('never touches marked or non-browser clients; a stale or malformed marker counts as legacy', async () => {
      await createUser('alice');

      expect((await login('alice', NON_BROWSER)).statusCode).toBe(200);
      expect((await login('alice', MARKED)).statusCode).toBe(200);
      expect((await login('alice', { 'sec-fetch-mode': 'cors', 'x-compendiq-client-protocol': '2' })).statusCode).toBe(200);
      expect((await login('alice', { 'sec-fetch-mode': 'navigate', 'x-compendiq-client-protocol': '0' })).statusCode).toBe(409);
      expect((await login('alice', { 'sec-fetch-mode': 'cors', 'x-compendiq-client-protocol': 'legacy' })).statusCode).toBe(409);
      expect(await observations()).toEqual([]);
    });

    it('stops refusing on the very next request after the switch is turned off', async () => {
      await createUser('alice');
      expect((await login('alice', LEGACY)).statusCode).toBe(409);
      await setSwitch(false);
      const response = await login('alice', LEGACY);
      expect(response.statusCode, response.body).toBe(200);
    });

    it('leaves logout and GET routes alone', async () => {
      const aliceId = await createUser('alice');
      const alice = await generateRefreshToken({ sub: aliceId, username: 'alice', role: 'user' });

      const policy = await app.inject({ method: 'GET', url: '/api/auth/registration-policy', headers: LEGACY });
      expect(policy.statusCode).toBe(200);
      const status = await app.inject({ method: 'GET', url: '/api/health/setup-status', headers: LEGACY });
      expect(status.statusCode).toBe(200);

      const logout = await app.inject({
        method: 'POST', url: '/api/auth/logout', headers: LEGACY, cookies: { kb_refresh: alice.token },
      });
      expect(logout.statusCode, logout.body).toBe(200);
      expect(logout.json()).toEqual({ message: 'Logged out' });
      const revoked = await query<{ revoked: boolean }>('SELECT revoked FROM refresh_tokens WHERE jti = $1', [alice.jti]);
      expect(revoked.rows[0]!.revoked).toBe(true);
    });

    it('fails closed with 503 when the switch cannot be read, and only for legacy clients', async () => {
      await createUser('alice');

      // Invariant violation: the singleton row is gone.
      await query('DELETE FROM ai_policy_activation_state');
      const missing = await login('alice', LEGACY);
      expect(missing.statusCode).toBe(503);
      expect(missing.json()).toEqual({ error: 'ai_policy_unavailable', message: expect.any(String) });
      expect(await count('refresh_tokens')).toBe(0);
      await setSwitch(true);

      // A real read error: the table is not where the guard expects it.
      await query('ALTER TABLE ai_policy_activation_state RENAME TO ai_policy_activation_state_hidden');
      try {
        const unreadable = await login('alice', LEGACY);
        expect(unreadable.statusCode).toBe(503);
        expect(ErrorBody.parse(unreadable.json()).error).toBe('ai_policy_unavailable');
        const marked = await login('alice', MARKED);
        expect(marked.statusCode, marked.body).toBe(200);
      } finally {
        await query('ALTER TABLE ai_policy_activation_state_hidden RENAME TO ai_policy_activation_state');
      }
      expect((await login('alice', LEGACY)).statusCode).toBe(409);
    });
  });

  describe('cleanupExpiredTokens (design N27)', () => {
    it('sweeps observations whose token expired more than a day ago and keeps the rest; the count stays refresh tokens', async () => {
      const staleId = await createUser('stale');
      const recentId = await createUser('recent');
      const liveId = await createUser('live');
      await query(
        `INSERT INTO ai_policy_legacy_client_observations (user_id, last_seen_at, token_expires_at, observations) VALUES
           ($1, NOW() - interval '26 hours', NOW() - interval '25 hours', 3),
           ($2, NOW() - interval '24 hours', NOW() - interval '23 hours', 1),
           ($3, NOW(), NOW() + interval '1 hour', 1)`,
        [staleId, recentId, liveId],
      );
      await generateRefreshToken({ sub: liveId, username: 'live', role: 'user' });
      await query("UPDATE refresh_tokens SET expires_at = NOW() - interval '1 second'");

      expect(await cleanupExpiredTokens()).toBe(1);

      const remaining = await query<{ user_id: string }>(
        'SELECT user_id FROM ai_policy_legacy_client_observations ORDER BY token_expires_at',
      );
      expect(remaining.rows.map((row) => row.user_id)).toEqual([recentId, liveId]);
      expect(await count('refresh_tokens')).toBe(0);
    });
  });
});
