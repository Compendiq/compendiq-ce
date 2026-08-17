import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Same DNS short-circuit the sibling route tests use: the SSRF guard would
// otherwise resolve the fake hostnames against a public resolver.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

// The vision probe is a chat completion at an unrelated endpoint; nothing in
// this file is about it, and leaving it live makes every save wait on undici.
vi.mock('../../domains/llm/services/model-capabilities.js', async (orig) => {
  const actual = await orig<typeof import('../../domains/llm/services/model-capabilities.js')>();
  return {
    ...actual,
    getVisionCapability: vi.fn().mockResolvedValue(null),
    refreshVisionCapability: vi.fn().mockResolvedValue({
      vision: null, probedAt: '2026-08-01T00:00:00.000Z', probeError: null,
    }),
    readVisionCapabilityDetail: vi.fn().mockResolvedValue(null),
    invalidateProviderCapabilities: vi.fn(),
  };
});

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import {
  IMAGE_EMBEDDING_DIMENSIONS_KEY,
  IMAGE_EMBEDDING_INDEX_MODEL_KEY,
  IMAGE_EMBEDDING_HNSW_INDEX,
} from '../../domains/llm/services/image-embedding-index.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';

/**
 * #1115 — assigning `image_embedding` is gated on a BLOCKING probe.
 *
 * A leg that cannot embed must not be assignable: the failure mode this
 * prevents is an operator picking the default text provider, the assignment
 * saving cleanly, and every image vector afterwards being well-formed and
 * wrong. So the probe runs before the row is written and a failure is a 422 —
 * naming the CATEGORY, never the provider's raw body, which stays on the
 * admin-only probe route (#1184's rule).
 *
 * The fake endpoints are real local HTTP servers: mock at the boundary
 * (CLAUDE.md), never at the service layer, because "does this endpoint serve
 * the chat-embeddings shape" is precisely the question under test.
 */

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;
let adminToken: string;
let userToken: string;

/** Answers the chat-embeddings shape with a `width`-dimensional unit vector. */
let goodServer: Server;
let goodUrl: string;
/** Refuses `messages`, as a plain text-embedding server does. */
let badServer: Server;
let badUrl: string;
let width = 1024;

beforeAll(async () => {
  if (!dbAvailable) return;
  goodServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages?: unknown };
      if (!Array.isArray(body.messages)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'expected messages' }));
        return;
      }
      const v = new Array<number>(width).fill(0);
      v[0] = 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: v }] }));
    });
  });
  badServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Extra inputs are not permitted: messages (tenant-7 @ 10.0.0.4)' }));
    });
  });
  await new Promise<void>((r) => goodServer.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => badServer.listen(0, '127.0.0.1', r));
  goodUrl = `http://127.0.0.1:${(goodServer.address() as AddressInfo).port}/v1`;
  badUrl = `http://127.0.0.1:${(badServer.address() as AddressInfo).port}/v1`;

  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  // Leave the shared test database as migration 093 left it — these routes
  // retype a real column, and 093's own test asserts the placeholder shape.
  await query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
  await query(`ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE vector(2048)`);
  await app?.close();
  await teardownTestDb();
  await new Promise<void>((r) => goodServer.close(() => r()));
  await new Promise<void>((r) => badServer.close(() => r()));
});

beforeEach(async () => {
  if (!dbAvailable) return;
  width = 1024;
  await truncateAllTables();
  await bumpProviderCacheVersion();
  await query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
  await query(`ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE vector(2048)`);

  const admin = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ('ie_admin','h','admin') RETURNING id`,
  );
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [admin.rows[0]!.id]);
  adminToken = await generateAccessToken({ sub: admin.rows[0]!.id, username: 'ie_admin', role: 'admin' });

  const user = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ('ie_user','h','user') RETURNING id`,
  );
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.rows[0]!.id]);
  userToken = await generateAccessToken({ sub: user.rows[0]!.id, username: 'ie_user', role: 'user' });
});

async function seedProvider(name: string, baseUrl: string, model: string | null, isDefault = false): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
     VALUES ($1, $2, 'none', true, $3, $4) RETURNING id`,
    [name, baseUrl, isDefault, model],
  );
  await bumpProviderCacheVersion();
  return r.rows[0]!.id;
}

const put = (payload: Record<string, unknown>, token = adminToken) => app.inject({
  method: 'PUT', url: '/api/admin/llm-usecases',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  payload: JSON.stringify(payload),
});

async function setting(key: string): Promise<string | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`, [key],
  );
  return r.rows[0]?.setting_value ?? null;
}

describe.skipIf(!dbAvailable)('PUT /api/admin/llm-usecases — image_embedding is probe-gated', () => {
  it('assigns on a successful probe and builds the index at the probed width', async () => {
    const id = await seedProvider('vlbox', goodUrl, 'Qwen/Qwen3-VL-Embedding-2B');

    const res = await put({ image_embedding: { providerId: id } });
    expect(res.statusCode).toBe(200);

    const type = await query<{ type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = 'page_image_embeddings'::regclass AND attname = 'embedding'`,
    );
    expect(type.rows[0]!.type).toBe('vector(1024)');
    expect(await setting(IMAGE_EMBEDDING_DIMENSIONS_KEY)).toBe('1024');
    expect(await setting(IMAGE_EMBEDDING_INDEX_MODEL_KEY)).toBe(
      `${id}:Qwen/Qwen3-VL-Embedding-2B@${goodUrl}`,
    );

    const idx = await query(
      `SELECT 1 FROM pg_indexes WHERE tablename='page_image_embeddings' AND indexname=$1`,
      [IMAGE_EMBEDDING_HNSW_INDEX],
    );
    expect(idx.rows).toHaveLength(1);
  });

  it('refuses the assignment with 422 when the probe fails, and writes no row', async () => {
    const id = await seedProvider('textbox', badUrl, 'nomic-embed-text');

    const res = await put({ image_embedding: { providerId: id } });
    expect(res.statusCode).toBe(422);

    const rows = await query(`SELECT 1 FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`);
    expect(rows.rows).toHaveLength(0);
    // The column is untouched — a refused assignment must not have rebuilt it.
    const type = await query<{ type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = 'page_image_embeddings'::regclass AND attname = 'embedding'`,
    );
    expect(type.rows[0]!.type).toBe('vector(2048)');
  });

  /**
   * #1184's rule at its sharpest: the 422 an admin reads in a toast must name
   * the category, not echo the provider's body — that body can carry request
   * fragments and internal topology, and it is reachable on the admin-only
   * probe route instead.
   */
  it('names the category in the 422 and never the provider body', async () => {
    const id = await seedProvider('textbox2', badUrl, 'nomic-embed-text');
    const res = await put({ image_embedding: { providerId: id } });
    const body = res.json() as { error: string; reason: string };
    expect(body.error).toMatch(/chat-embeddings|messages shape|vLLM/i);
    expect(body.error).not.toContain('10.0.0.4');
    expect(body.error).not.toContain('tenant-7');
    // Review round 1: the CATEGORY as a slug, not only as prose. ADR-025 and
    // the runbook's refusal table are keyed on these four names, and nothing in
    // the answer carried them — an operator matching a toast to the table had
    // to guess which row they were in.
    expect(body.reason).toBe('shape_rejected');
  });

  /**
   * Review round 1: the refused pair is deliberately NOT persisted, so the
   * copy must not send the operator to a disclosure that is empty (first
   * assignment) or describes a different, still-working endpoint (a refused
   * change). The provider's body goes to the log; the sentence says so.
   */
  it('does not point the refusal at a probe detail it never wrote', async () => {
    const id = await seedProvider('textbox4', badUrl, 'nomic-embed-text');
    const res = await put({ image_embedding: { providerId: id } });
    const body = res.json() as { error: string };
    expect(body.error).not.toMatch(/probe detail|why this verdict/i);
    expect(body.error).toMatch(/backend log|server log/i);

    const stored = await query(
      `SELECT 1 FROM admin_settings WHERE setting_key = 'image_embedding_probe'`,
    );
    expect(stored.rows).toHaveLength(0);
  });

  /**
   * D7 says a model change truncates and re-scans. That only holds if the
   * assignment cannot silently change model underneath it — and an assignment
   * of {provider: P, model: null} re-resolves `P.default_model` on EVERY read,
   * so editing that default repointed the live image model with no probe and no
   * rebuild (review round 1). The probe verified one pair; the row names it.
   */
  it('pins the RESOLVED model so the provider default cannot repoint the leg', async () => {
    const id = await seedProvider('vlbox-pin', goodUrl, 'vl-2b');

    expect((await put({ image_embedding: { providerId: id } })).statusCode).toBe(200);

    const row = await query<{ model: string | null }>(
      `SELECT model FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`,
    );
    expect(row.rows[0]!.model).toBe('vl-2b');

    // Moving the provider's default now changes nothing about the image leg.
    await query(`UPDATE llm_providers SET default_model = 'some-text-embedder' WHERE id = $1`, [id]);
    await bumpProviderCacheVersion();
    const r = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases/image_embedding/probe',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.json()).toMatchObject({ model: 'vl-2b', dimensions: 1024 });
  });

  /**
   * ADR-025 D12: the served endpoint is part of the vector space's identity.
   * `PATCH /admin/llm-providers/:id` can move a provider row's `base_url` to a
   * different container without changing its id, so the recorded identity
   * carries the URL and the next probe rebuilds.
   */
  it('rebuilds when the same provider and model move to a new base URL', async () => {
    const id = await seedProvider('vlbox-move', goodUrl, 'vl-2b');
    expect((await put({ image_embedding: { providerId: id } })).statusCode).toBe(200);
    const before = await setting(IMAGE_EMBEDDING_INDEX_MODEL_KEY);

    // A second good server at a different origin — same shape, same width.
    const moved = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        void raw;
        const v = new Array<number>(width).fill(0);
        v[0] = 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: v }] }));
      });
    });
    await new Promise<void>((r) => moved.listen(0, '127.0.0.1', r));
    const movedUrl = `http://127.0.0.1:${(moved.address() as AddressInfo).port}/v1`;
    try {
      await query(`UPDATE llm_providers SET base_url = $1 WHERE id = $2`, [movedUrl, id]);
      await bumpProviderCacheVersion();

      const r = await app.inject({
        method: 'POST', url: '/api/admin/llm-usecases/image_embedding/reprobe',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ rebuilt: true });
      expect(await setting(IMAGE_EMBEDDING_INDEX_MODEL_KEY)).not.toBe(before);
    } finally {
      await new Promise<void>((r) => moved.close(() => r()));
    }
  });

  it('refuses when a provider is picked but no model resolves anywhere', async () => {
    const id = await seedProvider('nomodel', goodUrl, null);
    const res = await put({ image_embedding: { providerId: id } });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/model/i);
  });

  it('leaves the index in place when the assignment is cleared, and probes nothing', async () => {
    const id = await seedProvider('vlbox2', goodUrl, 'vl-2b');
    expect((await put({ image_embedding: { providerId: id } })).statusCode).toBe(200);

    // Point the endpoint at the refusing server so a probe on the unassign
    // path would be visible as a 422.
    await query(`UPDATE llm_providers SET base_url = $1 WHERE id = $2`, [badUrl, id]);
    await bumpProviderCacheVersion();

    const cleared = await put({ image_embedding: { providerId: null, model: null } });
    expect(cleared.statusCode).toBe(200);

    // The leg is off (no assignment), but nothing was destroyed: the index and
    // the recorded width survive, so re-assigning the same pair is free.
    const idx = await query(
      `SELECT 1 FROM pg_indexes WHERE tablename='page_image_embeddings' AND indexname=$1`,
      [IMAGE_EMBEDDING_HNSW_INDEX],
    );
    expect(idx.rows).toHaveLength(1);
    expect(await setting(IMAGE_EMBEDDING_DIMENSIONS_KEY)).toBe('1024');
  });

  /**
   * A refused CHANGE leaves the live leg alone, and that has to include its
   * stored verdict. Overwriting it would replace a true
   * "1024-dim · vector HNSW" with "Not established" for an endpoint that is
   * still working and still assigned.
   */
  it('a refused change does not wipe the stored probe of the live assignment', async () => {
    const good = await seedProvider('vlbox-live', goodUrl, 'vl-2b');
    expect((await put({ image_embedding: { providerId: good } })).statusCode).toBe(200);

    const bad = await seedProvider('textbox-live', badUrl, 'nomic-embed-text');
    expect((await put({ image_embedding: { providerId: bad } })).statusCode).toBe(422);

    const r = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases/image_embedding/probe',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.json()).toMatchObject({
      providerId: good, model: 'vl-2b', dimensions: 1024, tier: 'vector', error: null,
    });
  });

  /**
   * Review round 1: the DDL runs AFTER the assignment transaction commits and
   * used to be unguarded, so a failed `ALTER` produced a bare HTTP 500 for a
   * request whose row really did save — the panel then showed the leg as
   * assigned against a column of the previous width, with nothing said about
   * it. The failure is real here (a dependent view makes `ALTER COLUMN … TYPE`
   * illegal), not a mocked service.
   */
  it('saves the assignment and warns when the index DDL fails, rather than 500ing', async () => {
    const id = await seedProvider('vlbox-ddl', goodUrl, 'vl-2b');
    await query(`CREATE VIEW image_embedding_blocker AS SELECT embedding FROM page_image_embeddings`);
    try {
      const res = await put({ image_embedding: { providerId: id } });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { imageIndexWarning?: string }).imageIndexWarning)
        .toMatch(/Re-check/i);

      // The row landed — that is why a 500 was the wrong answer.
      const rows = await query<{ provider_id: string }>(
        `SELECT provider_id FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`,
      );
      expect(rows.rows[0]!.provider_id).toBe(id);
      // …and the column is honestly still at the old width.
      const type = await query<{ type: string }>(
        `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
          WHERE attrelid = 'page_image_embeddings'::regclass AND attname = 'embedding'`,
      );
      expect(type.rows[0]!.type).toBe('vector(2048)');
    } finally {
      await query(`DROP VIEW IF EXISTS image_embedding_blocker`);
    }
  });

  it('does not probe when the save touches only other use cases', async () => {
    const badId = await seedProvider('textbox3', badUrl, 'nomic-embed-text');
    await seedProvider('def', goodUrl, 'mDefault', true);
    const res = await put({ summary: { providerId: badId, model: 'x' } });
    expect(res.statusCode).toBe(200);
  });
});

describe.skipIf(!dbAvailable)('GET /api/admin/llm-usecases includes image_embedding', () => {
  it('lists it, and never inherits the default provider for it', async () => {
    await seedProvider('def', goodUrl, 'mDefault', true);
    const r = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = r.json() as Record<string, { resolved: { providerId: string; model: string } }>;
    expect(Object.keys(body).sort()).toEqual([
      'auto_tag', 'chat', 'embedding', 'image_embedding', 'quality', 'rerank', 'summary',
    ]);
    expect(body.image_embedding!.resolved).toMatchObject({
      providerId: '00000000-0000-0000-0000-000000000000', providerName: '', model: '',
    });
  });
});

describe.skipIf(!dbAvailable)('the probe detail routes (#1184 shape)', () => {
  it('GET answers the stored probe for the assigned pair', async () => {
    const id = await seedProvider('vlbox3', goodUrl, 'vl-2b');
    expect((await put({ image_embedding: { providerId: id } })).statusCode).toBe(200);

    const r = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases/image_embedding/probe',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      providerId: id, model: 'vl-2b', dimensions: 1024, tier: 'vector', error: null,
    });
  });

  it('GET answers 404 when the leg is unassigned', async () => {
    const r = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases/image_embedding/probe',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(404);
  });

  it('POST reprobe re-runs the probe and rebuilds at the new width', async () => {
    const id = await seedProvider('vlbox4', goodUrl, 'vl-2b');
    expect((await put({ image_embedding: { providerId: id } })).statusCode).toBe(200);

    width = 2560; // the operator restarted the server with a different --hf-override
    const r = await app.inject({
      method: 'POST', url: '/api/admin/llm-usecases/image_embedding/reprobe',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ dimensions: 2560, tier: 'halfvec' });
    const type = await query<{ type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = 'page_image_embeddings'::regclass AND attname = 'embedding'`,
    );
    expect(type.rows[0]!.type).toBe('halfvec(2560)');
  });

  /**
   * Review round 1: "Re-check" reads as diagnostic, and on a width change it
   * empties `page_image_embeddings` and re-dirties the corpus. The control
   * cannot say so unless the route reports it, so the verdict travels back —
   * `rebuilt` plus the page count — and it must stay FALSE when nothing moved.
   */
  it('reports whether the re-probe rebuilt the index, and how many pages it queued', async () => {
    const id = await seedProvider('vlbox-report', goodUrl, 'vl-2b');
    expect((await put({ image_embedding: { providerId: id } })).statusCode).toBe(200);
    await query(
      `INSERT INTO pages (title, space_key, body_html, page_type, source)
       VALUES ('Doc', 'DEV', '<p>x</p>', 'page', 'standalone')`,
    );

    const same = await app.inject({
      method: 'POST', url: '/api/admin/llm-usecases/image_embedding/reprobe',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(same.json()).toMatchObject({ rebuilt: false, dirtiedPages: 0 });

    width = 2560;
    const changed = await app.inject({
      method: 'POST', url: '/api/admin/llm-usecases/image_embedding/reprobe',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(changed.json()).toMatchObject({ rebuilt: true, dirtiedPages: 1 });
  });

  // A failed re-probe runs no DDL, so it reports no verdict about one either —
  // absent, never `false`, which would claim the column was checked and left.
  it('omits the rebuild verdict when the re-probe failed', async () => {
    const id = await seedProvider('vlbox-nover', goodUrl, 'vl-2b');
    expect((await put({ image_embedding: { providerId: id } })).statusCode).toBe(200);
    await query(`UPDATE llm_providers SET base_url = $1 WHERE id = $2`, [badUrl, id]);
    await bumpProviderCacheVersion();

    const r = await app.inject({
      method: 'POST', url: '/api/admin/llm-usecases/image_embedding/reprobe',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.json()).not.toHaveProperty('rebuilt');
  });

  it('POST reprobe records a failure without throwing', async () => {
    const id = await seedProvider('vlbox5', goodUrl, 'vl-2b');
    expect((await put({ image_embedding: { providerId: id } })).statusCode).toBe(200);
    await query(`UPDATE llm_providers SET base_url = $1 WHERE id = $2`, [badUrl, id]);
    await bumpProviderCacheVersion();

    const r = await app.inject({
      method: 'POST', url: '/api/admin/llm-usecases/image_embedding/reprobe',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ dimensions: null, tier: null });
    expect((r.json() as { error: string }).error).toContain('Extra inputs are not permitted');
  });

  it.each([
    ['GET', '/api/admin/llm-usecases/image_embedding/probe'],
    ['POST', '/api/admin/llm-usecases/image_embedding/reprobe'],
  ])('%s %s is requireAdmin', async (method, url) => {
    const r = await app.inject({
      method: method as 'GET' | 'POST', url,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe.skipIf(!dbAvailable)('GET /api/llm/usecase-default — image_embedding', () => {
  it('never inherits the default provider, and answers 404 when unassigned', async () => {
    await seedProvider('def', goodUrl, 'mDefault', true);
    const r = await app.inject({
      method: 'GET', url: '/api/llm/usecase-default?usecase=image_embedding',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(r.statusCode).toBe(404);
  });

  /**
   * The non-admin surface must never grow the probe error. `UsecaseDefault` is
   * `fastify.authenticate` and reachable by every logged-in user.
   */
  it('carries no probe error when the leg IS assigned', async () => {
    const id = await seedProvider('vlbox6', goodUrl, 'vl-2b');
    expect((await put({ image_embedding: { providerId: id } })).statusCode).toBe(200);

    const r = await app.inject({
      method: 'GET', url: '/api/llm/usecase-default?usecase=image_embedding',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ usecase: 'image_embedding', providerId: id, model: 'vl-2b' });
    expect(body).not.toHaveProperty('error');
    expect(body).not.toHaveProperty('probeError');
    expect(body).not.toHaveProperty('dimensions');
  });
});
