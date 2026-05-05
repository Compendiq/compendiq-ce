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

describe.skipIf(!dbAvailable)('SSRF guard — private-network base URLs accepted (LM Studio / Ollama / on-prem vLLM)', () => {
  // The original SSRF block-list rejected loopback / RFC-1918 base URLs at
  // POST/PATCH time, which made on-prem and LAN LLM endpoints unreachable
  // from the admin UI (the Confluence settings flow already handled this
  // correctly by allowlisting BEFORE validating). These tests pin the new
  // ordering: allowlist → validate → write. Protocol restrictions remain
  // (Zod accepts only http/https; non-HTTP protocols never reach the route).
  beforeEach(async () => {
    await truncateAllTables();
    ({ token: adminToken } = await createAdminAndLogin());
  });

  it('POST with loopback baseUrl is now accepted and allowlisted', async () => {
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
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'Loopback', baseUrl: 'http://127.0.0.1/v1' });
  });

  it('POST with RFC-1918 baseUrl is accepted and allowlisted', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'LM Studio (LAN)',
        baseUrl: 'http://192.168.178.185:1234/v1',
        authType: 'none',
        verifySsl: true,
      }),
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ baseUrl: 'http://192.168.178.185:1234/v1' });
  });

  it('PATCH from public to RFC-1918 baseUrl is accepted', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true }),
    });
    const { id } = create.json();

    const r = await app.inject({
      method: 'PATCH', url: `/api/admin/llm-providers/${id}`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ baseUrl: 'http://10.0.0.5:1234/v1' }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().baseUrl).toBe('http://10.0.0.5:1234/v1');
  });

  it('POST with duplicate name revokes the speculative allowlist entry (verified directly)', async () => {
    const { validateUrl, SsrfError } = await import('../../core/utils/ssrf-guard.js');

    // Seed the row that will collide.
    await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Dup', baseUrl: 'http://10.0.0.10/v1', authType: 'none', verifySsl: true }),
    });
    // Second POST: same unique name, different (private) baseUrl. The DB
    // unique-constraint will fail; the route revokes the speculative
    // allowlist entry IFF no other provider references it.
    const r = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Dup', baseUrl: 'http://10.0.0.99/v1', authType: 'none', verifySsl: true }),
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);

    // Direct allowlist assertion: validateUrl on the failed origin must now
    // throw (allowlist was revoked). Without this, a row-count check could
    // pass even if revoke logic broke.
    expect(() => validateUrl('http://10.0.0.99/v1')).toThrow(SsrfError);
  });

  it('failed POST does NOT revoke the allowlist of a concurrent successful sibling for the same origin', async () => {
    const { validateUrl } = await import('../../core/utils/ssrf-guard.js');

    // First POST succeeds with origin http://10.0.0.50:1234.
    const ok = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Sibling-A',
        baseUrl: 'http://10.0.0.50:1234/v1',
        authType: 'none', verifySsl: true,
      }),
    });
    expect(ok.statusCode).toBe(201);

    // Second POST: SAME baseUrl, different name that we'll force to fail
    // by re-using a unique name from the first row. Repurpose: collide on
    // 'Sibling-A' to trigger the unique-name failure path.
    const fail = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Sibling-A', // duplicate → fails
        baseUrl: 'http://10.0.0.50:1234/v2', // same origin, different path
        authType: 'none', verifySsl: true,
      }),
    });
    expect(fail.statusCode).toBeGreaterThanOrEqual(400);

    // Critical assertion: the allowlist for the SHARED origin must STILL
    // be present (Sibling-A still owns it). The naïve revoke would have
    // stripped it.
    expect(() => validateUrl('http://10.0.0.50:1234/v1')).not.toThrow();
  });

  it('PATCH that changes baseUrl revokes the old origin when nothing else references it', async () => {
    const { validateUrl, SsrfError } = await import('../../core/utils/ssrf-guard.js');

    const create = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Migrate',
        baseUrl: 'http://10.0.0.60/v1',
        authType: 'none', verifySsl: true,
      }),
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    // Pre-condition: old origin is allowlisted.
    expect(() => validateUrl('http://10.0.0.60/v1')).not.toThrow();

    const patch = await app.inject({
      method: 'PATCH', url: `/api/admin/llm-providers/${id}`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ baseUrl: 'http://10.0.0.61/v1' }),
    });
    expect(patch.statusCode).toBe(200);

    // New origin allowlisted, OLD origin garbage-collected because no
    // surviving row references it.
    expect(() => validateUrl('http://10.0.0.61/v1')).not.toThrow();
    expect(() => validateUrl('http://10.0.0.60/v1')).toThrow(SsrfError);
  });

  it('PATCH baseUrl change does NOT revoke the old origin when another provider still uses it', async () => {
    const { validateUrl } = await import('../../core/utils/ssrf-guard.js');

    // Two providers share origin http://10.0.0.70.
    const a = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Shared-A', baseUrl: 'http://10.0.0.70/v1', authType: 'none', verifySsl: true }),
    });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Shared-B', baseUrl: 'http://10.0.0.70/v2', authType: 'none', verifySsl: true }),
    });
    expect(b.statusCode).toBe(201);

    // Migrate B away from the shared origin. A should still keep it allowlisted.
    const patch = await app.inject({
      method: 'PATCH', url: `/api/admin/llm-providers/${b.json().id}`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ baseUrl: 'http://10.0.0.71/v1' }),
    });
    expect(patch.statusCode).toBe(200);

    // The shared origin is still owned by Shared-A — must remain allowlisted.
    expect(() => validateUrl('http://10.0.0.70/v1')).not.toThrow();
  });

  // ──────────────────────────────────────────────────────────────────────
  // INFO #5: PATCH revoke-on-failure paths now have explicit coverage.
  // The route does `await revokeAllowlistIfUnused(patch.baseUrl)` in three
  // branches (catch-on-validate, catch-on-updateProvider, 404-not-found);
  // only the validate branch was implicitly covered by inspection of POST.
  // The two tests below pin the remaining branches so a regression that
  // dropped the revoke from either branch would be caught here.
  // ──────────────────────────────────────────────────────────────────────

  it('PATCH against a non-existent provider id returns 404 and revokes the speculative allowlist entry', async () => {
    const { validateUrl, SsrfError } = await import('../../core/utils/ssrf-guard.js');

    // No DB row exists at this UUID — `updateProvider` returns undefined,
    // taking the `if (!updated) … 404` branch.
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/admin/llm-providers/00000000-0000-4000-8000-000000000000',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ baseUrl: 'http://10.0.0.99/v1' }),
    });
    expect(r.statusCode).toBe(404);

    // The 404 branch must call `revokeAllowlistIfUnused(patch.baseUrl)`.
    // Nothing else references this origin, so the allowlist entry should
    // be revoked and `validateUrl` should fall back to the SSRF block.
    expect(() => validateUrl('http://10.0.0.99/v1')).toThrow(SsrfError);
  });

  it('PATCH name collision (updateProvider throws) revokes the speculative allowlist entry', async () => {
    const { validateUrl, SsrfError } = await import('../../core/utils/ssrf-guard.js');

    // Seed two distinct providers with distinct names + non-overlapping origins.
    const a = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Throw-A', baseUrl: 'http://10.0.0.80/v1', authType: 'none', verifySsl: true }),
    });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Throw-B', baseUrl: 'http://10.0.0.81/v1', authType: 'none', verifySsl: true }),
    });
    expect(b.statusCode).toBe(201);

    // PATCH B's name to collide with A's, and at the same time bring in a
    // brand-new baseUrl (origin http://10.0.0.82) so the speculative
    // allowlist entry is observable. `updateProvider` will throw on the
    // unique-name constraint — taking the catch-on-updateProvider branch.
    const fail = await app.inject({
      method: 'PATCH',
      url: `/api/admin/llm-providers/${b.json().id}`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Throw-A', baseUrl: 'http://10.0.0.82/v1' }),
    });
    expect(fail.statusCode).toBeGreaterThanOrEqual(400);

    // The catch branch must revoke the speculative allowlist entry —
    // nothing references the new origin, so it should be revoked.
    expect(() => validateUrl('http://10.0.0.82/v1')).toThrow(SsrfError);
    // Provider A's original origin must be untouched.
    expect(() => validateUrl('http://10.0.0.80/v1')).not.toThrow();
    // Provider B's original origin must also be untouched (the throw
    // happens AFTER `previous` is captured but BEFORE the GC-on-success
    // path runs, so the previous origin stays allowlisted).
    expect(() => validateUrl('http://10.0.0.81/v1')).not.toThrow();
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
