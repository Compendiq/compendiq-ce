import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { healthApiRoutes, constantTimeEqual } from './health-api.js';

// The route only needs `query`, `logger`, `version`, and `fastify.license`.
// We mock `query` to return canned rows so each test exercises one branch.
const mockQuery = vi.fn();

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/utils/version.js', () => ({
  APP_VERSION: '0.4.0-test',
  APP_BUILD_INFO: { edition: 'community', commit: 'abc1234', builtAt: '2026-04-28T00:00:00Z' },
}));

const VALID_TOKEN = 'a'.repeat(64);

interface QueryDescriptor {
  text: string;
  rows: unknown[];
}

/**
 * Configure mockQuery to dispatch on SQL fragments. Each test wires up
 * exactly the rows that should come back for each branch of buildHealthReport.
 */
function wireQueryRouting(routes: QueryDescriptor[]) {
  mockQuery.mockImplementation(async (sql: string) => {
    for (const r of routes) {
      if (sql.includes(r.text)) return { rows: r.rows };
    }
    throw new Error(`unexpected SQL in test: ${sql.slice(0, 80)}`);
  });
}

describe('health-api route — Compendiq/compendiq-ee#113 Part A', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    // The route reads `fastify.license` for the tier field. Decorate with null
    // (community mode); one test below exercises the licensed branch.
    app.decorate('license', null);
    await app.register(healthApiRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('auth', () => {
    it('401s when token query string is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/internal/health' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'token required' });
    });

    it('401s when token query string is empty', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/internal/health?token=' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'token required' });
    });

    it('503s when admin_settings.health_api_token row is missing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // token lookup
      const res = await app.inject({ method: 'GET', url: `/api/internal/health?token=${VALID_TOKEN}` });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'health token not initialised' });
    });

    it('401s on wrong token (length-equal)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: VALID_TOKEN }] });
      const wrong = 'b'.repeat(64);
      const res = await app.inject({ method: 'GET', url: `/api/internal/health?token=${wrong}` });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid token' });
    });

    it('401s on wrong token (length-mismatched) without throwing', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ setting_value: VALID_TOKEN }] });
      const res = await app.inject({ method: 'GET', url: '/api/internal/health?token=short' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid token' });
    });
  });

  describe('200 happy path', () => {
    it('returns the full health report shape', async () => {
      wireQueryRouting([
        { text: "setting_key = 'health_api_token'", rows: [{ setting_value: VALID_TOKEN }] },
        { text: 'FROM users', rows: [{ total: '12', active: '10' }] },
        { text: 'FROM pages', rows: [{ c: '5' }] },
        { text: 'FROM spaces', rows: [{ ts: new Date('2026-04-28T12:00:00Z') }] },
        { text: 'FROM audit_log', rows: [{ failed: '3', total: '300' }] },
      ]);

      const res = await app.inject({ method: 'GET', url: `/api/internal/health?token=${VALID_TOKEN}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        version: '0.4.0-test',
        edition: 'community',
        tier: 'community',
        commit: 'abc1234',
        builtAt: '2026-04-28T00:00:00Z',
        userCount: 12,
        activeUserCount: 10,
        dirtyPages: 5,
        lastSyncAt: '2026-04-28T12:00:00.000Z',
        errorRate24h: 0.01,
      });
      expect(typeof body.uptime).toBe('number');
      expect(typeof body.collectedAt).toBe('string');
    });

    it('returns errorRate24h=0 when no audit activity in window', async () => {
      wireQueryRouting([
        { text: "setting_key = 'health_api_token'", rows: [{ setting_value: VALID_TOKEN }] },
        { text: 'FROM users', rows: [{ total: '0', active: '0' }] },
        { text: 'FROM pages', rows: [{ c: '0' }] },
        { text: 'FROM spaces', rows: [{ ts: null }] },
        { text: 'FROM audit_log', rows: [{ failed: '0', total: '0' }] },
      ]);

      const res = await app.inject({ method: 'GET', url: `/api/internal/health?token=${VALID_TOKEN}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.errorRate24h).toBe(0);
      expect(body.lastSyncAt).toBeNull();
    });

    it('returns "community" tier when fastify.license is null', async () => {
      wireQueryRouting([
        { text: "setting_key = 'health_api_token'", rows: [{ setting_value: VALID_TOKEN }] },
        { text: 'FROM users', rows: [{ total: '1', active: '1' }] },
        { text: 'FROM pages', rows: [{ c: '0' }] },
        { text: 'FROM spaces', rows: [{ ts: null }] },
        { text: 'FROM audit_log', rows: [{ failed: '0', total: '0' }] },
      ]);

      const res = await app.inject({ method: 'GET', url: `/api/internal/health?token=${VALID_TOKEN}` });
      expect(res.statusCode).toBe(200);
      expect((res.json() as Record<string, unknown>).tier).toBe('community');
    });

    it('returns license tier when fastify.license is set', async () => {
      // Spin up a separate app with a non-null license decoration.
      const licensed = Fastify({ logger: false });
      licensed.decorate('license', { tier: 'enterprise', expiresAt: null, customer: 'acme' });
      await licensed.register(healthApiRoutes, { prefix: '/api' });
      await licensed.ready();

      wireQueryRouting([
        { text: "setting_key = 'health_api_token'", rows: [{ setting_value: VALID_TOKEN }] },
        { text: 'FROM users', rows: [{ total: '1', active: '1' }] },
        { text: 'FROM pages', rows: [{ c: '0' }] },
        { text: 'FROM spaces', rows: [{ ts: null }] },
        { text: 'FROM audit_log', rows: [{ failed: '0', total: '0' }] },
      ]);

      const res = await licensed.inject({ method: 'GET', url: `/api/internal/health?token=${VALID_TOKEN}` });
      expect(res.statusCode).toBe(200);
      expect((res.json() as Record<string, unknown>).tier).toBe('enterprise');
      await licensed.close();
    });
  });

  describe('500 error path', () => {
    it('returns 500 when buildHealthReport throws', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("setting_key = 'health_api_token'")) {
          return { rows: [{ setting_value: VALID_TOKEN }] };
        }
        throw new Error('postgres exploded');
      });

      const res = await app.inject({ method: 'GET', url: `/api/internal/health?token=${VALID_TOKEN}` });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'failed to assemble health report' });
    });
  });
});

describe('constantTimeEqual', () => {
  it('returns true on equal strings', () => {
    expect(constantTimeEqual('hello', 'hello')).toBe(true);
  });

  it('returns false on different equal-length strings', () => {
    expect(constantTimeEqual('hello', 'world')).toBe(false);
  });

  it('returns false on length mismatch (and does not throw)', () => {
    expect(constantTimeEqual('short', 'a-much-longer-string')).toBe(false);
  });

  it('returns true on the canonical 64-hex case', () => {
    const t = 'a'.repeat(64);
    expect(constantTimeEqual(t, t)).toBe(true);
  });
});
