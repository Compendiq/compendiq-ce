/**
 * Integration tests for the admin IP-allowlist REST routes (EE #111, Phase D).
 *
 * These exercise the full wire: real Fastify `buildApp()` + real Postgres
 * (`test-db-helper.ts`). Auth decorators are produced by the real auth
 * plugin via `generateAccessToken`. If no test database is reachable
 * (POSTGRES_TEST_URL) the whole file `describe.skipIf`s — never fails —
 * matching the admin-embedding-locks.test.ts precedent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Short-circuit DNS lookups performed by the SSRF guard during buildApp().
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';

async function createAdminAndLogin(username: string): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'admin') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: 'admin' });
  return { token, userId };
}

async function createMemberAndLogin(username: string): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'member') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: 'member' });
  return { token, userId };
}

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;
let adminToken: string;

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  ({ token: adminToken } = await createAdminAndLogin('ipallowlist_admin'));
});

describe.skipIf(!dbAvailable)('GET /api/admin/ip-allowlist', () => {
  it('returns the default config when no admin_settings row exists', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.config.enabled).toBe(false);
    expect(body.config.cidrs).toEqual([]);
    // Defaults include loopback trusted proxies + conservative exceptions.
    expect(body.config.trustedProxies).toEqual(['127.0.0.1/32', '::1/128']);
    expect(body.config.exceptions).toContain('/api/health');
  });

  it('returns the persisted config after a PUT', async () => {
    const next = {
      enabled: true,
      cidrs: ['10.0.0.0/8'],
      trustedProxies: ['127.0.0.1/32'],
      exceptions: ['/api/health'],
    };

    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: next,
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().config).toEqual(next);
  });
});

describe.skipIf(!dbAvailable)('PUT /api/admin/ip-allowlist', () => {
  it('persists the config to admin_settings as JSON', async () => {
    const next = {
      enabled: true,
      cidrs: ['192.168.0.0/16', '10.0.0.0/8'],
      trustedProxies: ['127.0.0.1/32', '::1/128'],
      exceptions: ['/api/health', '/api/auth/'],
    };

    const r = await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: next,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().config).toEqual(next);

    const { rows } = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'ip_allowlist'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.setting_value)).toEqual(next);
  });

  it('rejects an invalid CIDR in `cidrs` with 400 { error: invalid_cidr }', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        enabled: true,
        cidrs: ['not-a-cidr'],
        trustedProxies: [],
        exceptions: [],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid_cidr', cidr: 'not-a-cidr' });
  });

  it('rejects an invalid CIDR in `trustedProxies` with 400 { error: invalid_cidr }', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        enabled: true,
        cidrs: [],
        trustedProxies: ['999.999.0.0/8'],
        exceptions: [],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid_cidr', cidr: '999.999.0.0/8' });
  });

  it('rejects an exception path not starting with /api/ with 400 { error: invalid_exception }', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        enabled: true,
        cidrs: [],
        trustedProxies: [],
        exceptions: ['/not-api/ok'],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid_exception', path: '/not-api/ok' });
  });

  it('returns 403 for non-admin callers', async () => {
    const { token: memberToken } = await createMemberAndLogin('ipallowlist_member');
    const r = await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: {
        enabled: false,
        cidrs: [],
        trustedProxies: [],
        exceptions: [],
      },
    });
    expect(r.statusCode).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      payload: {
        enabled: false,
        cidrs: [],
        trustedProxies: [],
        exceptions: [],
      },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe.skipIf(!dbAvailable)('POST /api/admin/ip-allowlist/test', () => {
  it('returns allowed:true + matchedCidr for an IP inside the configured CIDRs', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        enabled: true,
        cidrs: ['10.0.0.0/8'],
        trustedProxies: [],
        exceptions: ['/api/health'],
      },
    });
    expect(put.statusCode).toBe(200);

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/ip-allowlist/test',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ip: '10.1.2.3' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.allowed).toBe(true);
    expect(body.matchedCidr).toBe('10.0.0.0/8');
    expect(body.isTrustedProxy).toBe(false);
    expect(body.reason).toContain('10.0.0.0/8');
  });

  it('returns allowed:false for an IP outside the configured CIDRs', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        enabled: true,
        cidrs: ['10.0.0.0/8'],
        trustedProxies: [],
        exceptions: ['/api/health'],
      },
    });

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/ip-allowlist/test',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ip: '8.8.8.8' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.allowed).toBe(false);
    expect(body.matchedCidr).toBeNull();
    expect(body.reason).toMatch(/blocked/);
  });

  it('returns allowed:true with a "feature disabled" reason when enabled=false', async () => {
    // Default state: no row persisted → enabled=false.
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/ip-allowlist/test',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ip: '8.8.8.8' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.allowed).toBe(true);
    expect(body.matchedCidr).toBeNull();
    expect(body.reason).toMatch(/feature disabled/i);
  });

  it('returns isTrustedProxy:true for an IP inside trustedProxies', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/admin/ip-allowlist',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        enabled: true,
        cidrs: ['10.0.0.0/8'],
        trustedProxies: ['203.0.113.0/24'],
        exceptions: ['/api/health'],
      },
    });

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/ip-allowlist/test',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ip: '203.0.113.7' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.isTrustedProxy).toBe(true);
    // Not inside the allowlist itself → blocked, but still flagged as a proxy.
    expect(body.allowed).toBe(false);
  });

  it('returns 400 { error: invalid_ip } for a garbage IP string', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/ip-allowlist/test',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ip: 'not-an-ip' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid_ip' });
  });
});
