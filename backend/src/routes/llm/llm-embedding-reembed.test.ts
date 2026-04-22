import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Short-circuit DNS lookups performed by the SSRF guard — mirrors the pattern
// in llm-providers.test.ts. The guard swallows DNS errors silently, so a fake
// ENOTFOUND is safe here and prevents real DNS resolution from hanging.
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

async function createAdminAndLogin(): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('llm_reembed_admin', 'fakehash', 'admin') RETURNING id`,
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({
    sub: userId,
    username: 'llm_reembed_admin',
    role: 'admin',
  });
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
  // Reset the page_embeddings column to 1024 dims + seed the admin_settings
  // row. An earlier test in this file may have ALTERed the column to a
  // different dimension (incl. halfvec) or dropped the HNSW index entirely
  // via the seq-scan-tier path; the reset must DROP INDEX → ALTER → CREATE
  // in that order to accommodate any prior leftover state, matching the
  // service's own DDL order in enqueueReembedAll.
  await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw`);
  await query(`ALTER TABLE page_embeddings ALTER COLUMN embedding TYPE vector(1024)`);
  await query(
    `CREATE INDEX idx_page_embeddings_hnsw ON page_embeddings
       USING hnsw (embedding vector_cosine_ops)
       WITH (m = 16, ef_construction = 200)`,
  );
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('embedding_dimensions', '1024', NOW())
     ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
  );
  ({ token: adminToken } = await createAdminAndLogin());
});

describe.skipIf(!dbAvailable)('POST /api/admin/embedding/reembed', () => {
  it('returns jobId and pageCount', async () => {
    // Seed one page so pageCount is observably non-zero.
    await query(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, body_html)
       VALUES ('p1', $1, 'Reembed Test Page', 'hello', '<p>hello</p>')`,
      ['SPACE1'],
    );

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.jobId).toMatch(/^reembed-/);
    expect(typeof body.pageCount).toBe('number');
    expect(body.pageCount).toBe(1);
  });

  it('returns 0 pageCount when pages table is empty', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.jobId).toMatch(/^reembed-/);
    expect(body.pageCount).toBe(0);
  });

  it('returns 401 without auth', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
    });
    expect(r.statusCode).toBe(401);
  });

  it('with newDimensions=768, rewrites column type + truncates embeddings + updates admin_settings', async () => {
    // Seed a page + an existing embedding row so we can observe the truncation.
    const pageResult = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, body_html)
       VALUES ('p1', $1, 'Before Reembed', 'hello', '<p>hello</p>') RETURNING id`,
      ['SPACE1'],
    );
    const pageId = pageResult.rows[0]!.id;
    // Build a 1024-length vector (current column type from migration 048).
    const oneVector = '[' + new Array(1024).fill('0.01').join(',') + ']';
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, 'chunk', $2::vector, '{}'::jsonb)`,
      [pageId, oneVector],
    );

    // Confirm current state
    const { rows: before } = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM page_embeddings`,
    );
    expect(parseInt(before[0]!.c, 10)).toBe(1);

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ newDimensions: 768 }),
    });
    expect(r.statusCode).toBe(200);

    // page_embeddings must now be empty
    const { rows: after } = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM page_embeddings`,
    );
    expect(parseInt(after[0]!.c, 10)).toBe(0);

    // Column type must be vector(768) now — verified via pg_attribute/format_type.
    const typeRows = await query<{ format_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS format_type
       FROM pg_attribute a
       WHERE a.attrelid = 'page_embeddings'::regclass AND a.attname = 'embedding'`,
    );
    expect(typeRows.rows[0]!.format_type).toBe('vector(768)');

    // admin_settings row must have been updated
    const settingRows = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key='embedding_dimensions'`,
    );
    expect(settingRows.rows[0]!.setting_value).toBe('768');
  });

  it('rejects non-integer / out-of-range newDimensions', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ newDimensions: 99999 }),
    });
    // Zod rejects at the boundary with 400 (max: 16000)
    expect(r.statusCode).toBe(400);
  });

  it('with newDimensions=2560 (halfvec tier), uses halfvec column + halfvec HNSW index', async () => {
    // Seed an existing embedding row so the ALTER COLUMN TYPE path is exercised
    // with non-empty data between TRUNCATE-and-ALTER (the prior order-of-ops
    // bug only manifested once the index-rebuild-on-ALTER tried to run).
    const pageResult = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, body_html)
       VALUES ('p-halfvec', $1, 'Before 2560', 'x', '<p>x</p>') RETURNING id`,
      ['SPACE1'],
    );
    const pageId = pageResult.rows[0]!.id;
    const v1024 = '[' + new Array(1024).fill('0.01').join(',') + ']';
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, 'c', $2::vector, '{}'::jsonb)`,
      [pageId, v1024],
    );

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ newDimensions: 2560 }),
    });
    expect(r.statusCode).toBe(200);

    // Column type should now be halfvec(2560)
    const typeRows = await query<{ format_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS format_type
       FROM pg_attribute a
       WHERE a.attrelid = 'page_embeddings'::regclass AND a.attname = 'embedding'`,
    );
    expect(typeRows.rows[0]!.format_type).toBe('halfvec(2560)');

    // HNSW index should exist with the halfvec opclass
    const indexRows = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE indexname = 'idx_page_embeddings_hnsw'`,
    );
    expect(indexRows.rows).toHaveLength(1);
    expect(indexRows.rows[0]!.indexdef).toContain('halfvec_cosine_ops');

    const settingRows = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key='embedding_dimensions'`,
    );
    expect(settingRows.rows[0]!.setting_value).toBe('2560');
  });

  it('with newDimensions=4096 (>4000, seq-scan tier), drops index and falls back to no index', async () => {
    const pageResult = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, body_html)
       VALUES ('p-seq', $1, 'Before 4096', 'x', '<p>x</p>') RETURNING id`,
      ['SPACE1'],
    );
    const pageId = pageResult.rows[0]!.id;
    const v1024 = '[' + new Array(1024).fill('0.01').join(',') + ']';
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, 'c', $2::vector, '{}'::jsonb)`,
      [pageId, v1024],
    );

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ newDimensions: 4096 }),
    });
    expect(r.statusCode).toBe(200);

    // Column type switched to vector(4096); no HNSW index exists
    const typeRows = await query<{ format_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS format_type
       FROM pg_attribute a
       WHERE a.attrelid = 'page_embeddings'::regclass AND a.attname = 'embedding'`,
    );
    expect(typeRows.rows[0]!.format_type).toBe('vector(4096)');

    const indexRows = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_page_embeddings_hnsw'`,
    );
    expect(indexRows.rows).toHaveLength(0);

    const settingRows = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key='embedding_dimensions'`,
    );
    expect(settingRows.rows[0]!.setting_value).toBe('4096');
  });

  it('returns 403 when caller is not an admin', async () => {
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('reembed_member', 'fakehash', 'member') RETURNING id`,
    );
    const memberId = userResult.rows[0]!.id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [memberId]);
    const memberToken = await generateAccessToken({
      sub: memberId,
      username: 'reembed_member',
      role: 'member',
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(r.statusCode).toBe(403);
  });

  // ─── Plan §2.5 / §4.4 RED #8 + #9 + #10 ─────────────────────────────────
  it('returns the fixed jobId="reembed-all" (idempotent across repeated POSTs)', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.jobId).toBe('reembed-all');

    // Second POST returns the same fixed jobId (collapse-concurrent).
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().jobId).toBe('reembed-all');
  });

  it('returns a heldBy string[] (empty when no per-user locks are held)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Array.isArray(body.heldBy)).toBe(true);
    expect(body.heldBy).toEqual([]);
  });
});

describe.skipIf(!dbAvailable)('GET /api/admin/embedding/reembed/:jobId', () => {
  it('returns 401 without auth', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding/reembed/reembed-all',
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('reembed_getter_member', 'fakehash', 'member') RETURNING id`,
    );
    const memberId = userResult.rows[0]!.id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [memberId]);
    const memberToken = await generateAccessToken({
      sub: memberId,
      username: 'reembed_getter_member',
      role: 'member',
    });
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding/reembed/reembed-all',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('returns { jobId, state: "unknown", progress: null, heldBy: [] } for an unknown job id', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding/reembed/does-not-exist',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.jobId).toBe('does-not-exist');
    expect(body.state).toBe('unknown');
    expect(body.progress).toBeNull();
    expect(Array.isArray(body.heldBy)).toBe(true);
  });
});
