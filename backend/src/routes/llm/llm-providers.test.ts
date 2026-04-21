import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Short-circuit DNS lookups performed by the SSRF guard — the mutations tests
// POST providers like `http://a` / `http://b` which would otherwise trigger
// real DNS resolution that hangs for ~25s per call against public resolvers.
// The guard swallows DNS errors silently, so a fake ENOTFOUND is safe here.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';

// The plan references a `createTestUserAndLogin` helper that does not exist
// in this repo. We inline the same behaviour here using `generateAccessToken`,
// mirroring the pattern used by `rate-limit.test.ts`.
async function createAdminAndLogin(): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('llm_provider_admin', 'fakehash', 'admin') RETURNING id`,
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({
    sub: userId,
    username: 'llm_provider_admin',
    role: 'admin',
  });
  return { token, userId };
}

const dbAvailable = await isDbAvailable();

// Shared app + DB lifecycle — one Fastify instance + one pool across describes
// so the second block doesn't try to run against a closed pg pool.
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
  ({ token: adminToken } = await createAdminAndLogin());
});

describe.skipIf(!dbAvailable)('GET /api/admin/llm-providers', () => {
  it('returns [] when no providers', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('never returns the plaintext apiKey', async () => {
    await query(
      `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, is_default)
       VALUES ('X','http://x/v1','encrypted-sekret','bearer',true,true)`,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body[0]).toMatchObject({ name: 'X', hasApiKey: true });
    expect(JSON.stringify(body)).not.toContain('encrypted-sekret');
  });
});

describe.skipIf(!dbAvailable)('SSRF guard returns 400 (not 500)', () => {
  beforeEach(async () => {
    await truncateAllTables();
    ({ token: adminToken } = await createAdminAndLogin());
  });

  it('POST with loopback baseUrl returns 400 with SSRF error message', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Loopback',
        baseUrl: 'http://127.0.0.1/v1',
        authType: 'none',
        verifySsl: true,
      }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/ssrf/i);
    // Stack trace must not leak in the response body
    expect(JSON.stringify(r.json())).not.toMatch(/at .+\.ts:\d+/);
  });

  it('PATCH with loopback baseUrl returns 400 with SSRF error message', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true }),
    });
    const { id } = create.json();

    const r = await app.inject({
      method: 'PATCH', url: `/api/admin/llm-providers/${id}`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ baseUrl: 'http://127.0.0.1/v1' }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/ssrf/i);
  });
});

describe.skipIf(!dbAvailable)('DELETE race conditions return 409 (not 500)', () => {
  beforeEach(async () => {
    await truncateAllTables();
    ({ token: adminToken } = await createAdminAndLogin());
  });

  it('concurrent DELETE + usecase-assignment INSERT never returns 500', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'R', baseUrl: 'http://r/v1', authType: 'none', verifySsl: true }),
    });
    const { id } = create.json();

    // Race: concurrently delete the provider while a usecase-assignment INSERT
    // tries to reference it. Depending on which transaction wins the row-lock:
    //   - DELETE wins first → INSERT fails with FK violation (handled elsewhere)
    //   - INSERT wins first → DELETE sees the reference (either via the service
    //     layer pre-check OR via PG raising 23503 on cascade). Either path must
    //     map to HTTP 409 — never 500.
    const settled = await Promise.allSettled([
      app.inject({
        method: 'DELETE', url: `/api/admin/llm-providers/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      }),
      query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
         VALUES ('summary', $1, 'm') ON CONFLICT (usecase) DO NOTHING`,
        [id],
      ),
    ]);

    const delResult = settled[0];
    expect(delResult.status).toBe('fulfilled');
    if (delResult.status === 'fulfilled') {
      // Either 200 (delete won) or 409 (reference detected) — never 500.
      expect([200, 409]).toContain(delResult.value.statusCode);
    }
  });
});

describe.skipIf(!dbAvailable)('mutations', () => {
  beforeEach(async () => {
    await truncateAllTables();
    ({ token: adminToken } = await createAdminAndLogin());
  });

  it('POST returns 201 and the created provider', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a', authType: 'none', verifySsl: true }),
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'A', baseUrl: 'http://a/v1', isDefault: false });
  });

  it('PATCH with omitted apiKey keeps the stored key', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', apiKey: 'sekret', authType: 'bearer', verifySsl: true }),
    });
    const { id } = create.json();
    const patch = await app.inject({
      method: 'PATCH', url: `/api/admin/llm-providers/${id}`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ defaultModel: 'm2' }),
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ defaultModel: 'm2', hasApiKey: true });
  });

  it('DELETE returns 409 when provider is default', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true }),
    });
    const { id } = create.json();
    await app.inject({
      method: 'POST', url: `/api/admin/llm-providers/${id}/set-default`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const del = await app.inject({
      method: 'DELETE', url: `/api/admin/llm-providers/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toMatch(/default/i);
  });

  it('DELETE returns 409 when provider is referenced by a use case', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'B', baseUrl: 'http://b/v1', authType: 'none', verifySsl: true }),
    });
    const { id } = create.json();
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('summary', $1, 'm')`,
      [id],
    );
    const del = await app.inject({
      method: 'DELETE', url: `/api/admin/llm-providers/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toMatch(/referenced/i);
  });
});
