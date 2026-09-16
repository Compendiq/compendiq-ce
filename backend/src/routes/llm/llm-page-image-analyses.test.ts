import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { IMAGE_ANALYSIS_SCHEMA_VERSION, ImageAnalysisInspectionSchema } from '@compendiq/contracts';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import {
  IMAGE_ANALYSIS_IDENTITY_KEY,
  IMAGE_ANALYSIS_PROMPT_VERSION,
} from '../../domains/llm/services/image-analysis-identity.js';

/**
 * #1615 (ADR-027 D14) — the analysis inspection route is admin-only AND
 * page-visibility-checked, withholds payload bodies unless asked, and a
 * shared `content_hash` across pages is not an authorization shortcut.
 */

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;
let adminId: string;
let adminToken: string;
let userId: string;
let userToken: string;

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

async function createUser(username: string, role: 'admin' | 'user'): Promise<{ id: string; token: string }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'h', $2) RETURNING id`,
    [username, role],
  );
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [rows[0]!.id]);
  return { id: rows[0]!.id, token: await generateAccessToken({ sub: rows[0]!.id, username, role }) };
}

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  ({ id: adminId, token: adminToken } = await createUser('pia_admin', 'admin'));
  ({ id: userId, token: userToken } = await createUser('pia_user', 'user'));
});

async function seedPage(visibility: 'shared' | 'private', ownerId: string): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, source, visibility, created_by_user_id, body_html)
     VALUES ('p', 'standalone', $1, $2, '<p>x</p>') RETURNING id`,
    [visibility, ownerId],
  );
  return r.rows[0]!.id;
}

const RETAINED_HASH = 'a'.repeat(64);

async function retainIdentity(): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)`,
    [IMAGE_ANALYSIS_IDENTITY_KEY, JSON.stringify({
      providerId: '00000000-0000-4000-8000-000000000001', model: 'qwen3-vl', baseUrl: 'http://vision/v1',
      identityHash: RETAINED_HASH, assignedAt: '2026-09-15T00:00:00.000Z',
    })],
  );
}

async function seedRows(pageId: number): Promise<void> {
  await query(
    `INSERT INTO page_image_analyses
       (page_id, source, attachment_key, content_hash, format, width, height, status, identity_hash, prompt_version, schema_version, payload, analyzed_at)
     VALUES ($1, 'local', 'diagram.png', 'shared-hash', 'png', 800, 600, 'analyzed', $2, $3, $4,
             '{"schemaVersion":1,"kind":"diagram","description":"SECRET-DESCRIPTION"}'::jsonb, NOW())`,
    [pageId, RETAINED_HASH, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
  );
  await query(
    `INSERT INTO page_image_analyses
       (page_id, source, attachment_key, content_hash, format, status, identity_hash, prompt_version, schema_version, attempts, next_attempt_at, error)
     VALUES ($1, 'confluence', 'chart.png', 'h2', 'png', 'failed', $2, $3, $4, 2, NOW() + interval '1 hour', 'rejected:413')`,
    [pageId, RETAINED_HASH, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
  );
  await query(
    `INSERT INTO page_image_analyses
       (page_id, source, attachment_key, content_hash, format, status, identity_hash, prompt_version, schema_version, payload, analyzed_at)
     VALUES ($1, 'local', 'stale.png', 'h3', 'png', 'analyzed', 'old-identity', $2, $3, '{"schemaVersion":1}'::jsonb, NOW())`,
    [pageId, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
  );
}

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

describe.skipIf(!dbAvailable)('GET /api/admin/pages/:id/image-analyses', () => {
  it('lists the page\'s rows without payload bodies, with validity against the retained identity', async () => {
    await retainIdentity();
    const pageId = await seedPage('shared', userId);
    await seedRows(pageId);

    const res = await get(`/api/admin/pages/${pageId}/image-analyses`, adminToken);
    expect(res.statusCode).toBe(200);
    const body = ImageAnalysisInspectionSchema.parse(res.json());
    expect(body.pageId).toBe(pageId);
    expect(body.retainedIdentity?.identityHash).toBe(RETAINED_HASH);
    expect(body.promptVersion).toBe(IMAGE_ANALYSIS_PROMPT_VERSION);
    expect(body.schemaVersion).toBe(IMAGE_ANALYSIS_SCHEMA_VERSION);
    // Ordered by source, then key — the composition order (D9.2).
    expect(body.rows.map((r) => [r.source, r.attachmentKey, r.status, r.valid])).toEqual([
      ['confluence', 'chart.png', 'failed', false],
      ['local', 'diagram.png', 'analyzed', true],
      ['local', 'stale.png', 'analyzed', false],
    ]);
    expect(body.rows[0]).toMatchObject({ error: 'rejected:413', attempts: 2 });
    expect(body.rows[0]!.nextAttemptAt).not.toBeNull();
    expect(body.rows[1]).toMatchObject({ width: 800, height: 600, format: 'png' });
    for (const row of body.rows) expect(row).not.toHaveProperty('payload');
    expect(JSON.stringify(res.json())).not.toContain('SECRET-DESCRIPTION');
  });

  it('includes payload bodies on ?payload=1', async () => {
    const pageId = await seedPage('shared', userId);
    await seedRows(pageId);
    const res = await get(`/api/admin/pages/${pageId}/image-analyses?payload=1`, adminToken);
    const body = ImageAnalysisInspectionSchema.parse(res.json());
    const analyzed = body.rows.find((r) => r.attachmentKey === 'diagram.png')!;
    expect(analyzed.payload).toMatchObject({ kind: 'diagram', description: 'SECRET-DESCRIPTION' });
    const failed = body.rows.find((r) => r.attachmentKey === 'chart.png')!;
    expect(failed.payload).toBeNull();
    // No retained identity in this case: nothing is valid, and the route says so rather than 500ing.
    expect(body.retainedIdentity).toBeNull();
    expect(body.rows.every((r) => r.valid === false)).toBe(true);
  });

  it('answers 404 for a page the admin cannot see, even though its rows share a content_hash with a visible page', async () => {
    const visible = await seedPage('shared', userId);
    const hidden = await seedPage('private', userId); // another user's private page
    await seedRows(visible);
    await seedRows(hidden);

    expect((await get(`/api/admin/pages/${visible}/image-analyses`, adminToken)).statusCode).toBe(200);
    const res = await get(`/api/admin/pages/${hidden}/image-analyses`, adminToken);
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.json())).not.toContain('diagram.png');
    // The admin's own private page is visible to them.
    const own = await seedPage('private', adminId);
    expect((await get(`/api/admin/pages/${own}/image-analyses`, adminToken)).statusCode).toBe(200);
  });

  it('answers 404 for a trashed page and for an id that does not exist', async () => {
    const pageId = await seedPage('shared', userId);
    await query(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [pageId]);
    expect((await get(`/api/admin/pages/${pageId}/image-analyses`, adminToken)).statusCode).toBe(404);
    expect((await get('/api/admin/pages/999999/image-analyses', adminToken)).statusCode).toBe(404);
    expect((await get('/api/admin/pages/not-a-number/image-analyses', adminToken)).statusCode).toBe(400);
  });

  it('is requireAdmin — a member gets 403 and nothing else, for a page they can see', async () => {
    const pageId = await seedPage('shared', userId);
    await seedRows(pageId);
    const res = await get(`/api/admin/pages/${pageId}/image-analyses?payload=1`, userToken);
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain('SECRET-DESCRIPTION');
    expect((await app.inject({ method: 'GET', url: `/api/admin/pages/${pageId}/image-analyses` })).statusCode).toBe(401);
  });
});
