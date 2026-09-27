import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';

// Regression tests for #734: IDOR on POST /api/llm/improvements/apply.
// Any authenticated user could overwrite another user's *private* standalone
// page because the handler resolved the page without checking
// created_by_user_id / visibility. These tests run against real Postgres
// (test-db-helper) with the full app (real auth, real route), mirroring the
// llm-providers.test.ts pattern. Confluence-sourced pages are out of scope:
// that branch pushes through the caller's own Confluence client, so
// Confluence ACLs apply.

const dbAvailable = await isDbAvailable();

const ORIGINAL_TITLE = 'Owner private notes';
const ORIGINAL_HTML = '<p>Original secret content</p>';
const ORIGINAL_TEXT = 'Original secret content';
const ORIGINAL_VERSION = 3;

async function createUser(username: string): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'fakehash') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: 'user' });
  return { token, userId };
}

async function createStandalonePage(opts: {
  ownerId: string;
  visibility: 'private' | 'shared';
  title?: string;
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (
       title, body_html, body_text, version, source,
       created_by_user_id, visibility, embedding_dirty, embedding_status
     ) VALUES ($1, $2, $3, $4, 'standalone', $5, $6, FALSE, 'not_embedded')
     RETURNING id`,
    [opts.title ?? ORIGINAL_TITLE, ORIGINAL_HTML, ORIGINAL_TEXT, ORIGINAL_VERSION, opts.ownerId, opts.visibility],
  );
  return res.rows[0]!.id;
}

async function fetchPage(id: number) {
  const res = await query<{ title: string; body_html: string; body_text: string; version: number }>(
    'SELECT title, body_html, body_text, version FROM pages WHERE id = $1',
    [id],
  );
  return res.rows[0]!;
}

async function baselineFixtureIds(
  pageId: number,
  actorId: string,
): Promise<{ baselineId: string; intentId: string }> {
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
     VALUES ('baseline-fixture', '{"kind":"test"}'::jsonb)
     ON CONFLICT (runtime_id) DO NOTHING`,
  );
  const result = await query<{ id: string; baseline_id: string }>(
    `WITH ids AS (
       SELECT gen_random_uuid() AS id, gen_random_uuid() AS baseline_id
     )
     INSERT INTO page_write_intents (
       id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode,
       effect, status, settled_at, settlement_reason, settlement_proof
     )
     SELECT ids.id, 'baseline-fixture', 'baseline.prepare', $2,
            ARRAY[p.id], jsonb_build_object(
              p.id::text,
              jsonb_build_object(
                'contentRevision', p.content_revision::text,
                'lifecycleRevision', p.lifecycle_revision::text
              )
            ),
            'local_verified',
            jsonb_build_object('effectClass', 'local', 'baselineId', ids.baseline_id::text),
            'completed', NOW(), 'effect_committed', '{}'::jsonb
       FROM ids
       JOIN pages p ON p.id = $1
     RETURNING id, (effect->>'baselineId')::uuid::text AS baseline_id`,
    [pageId, actorId],
  );
  return {
    baselineId: result.rows[0]!.baseline_id,
    intentId: result.rows[0]!.id,
  };
}

async function freezePage(id: number, actorId: string): Promise<void> {
  const page = await query<{
    version: number;
    title: string;
    body_html: string | null;
    body_text: string | null;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT version, title, body_html, body_text,
            content_revision::text, lifecycle_revision::text
       FROM pages WHERE id = $1`,
    [id],
  );
  const row = page.rows[0]!;
  const fixture = await baselineFixtureIds(id, actorId);
  const baseline = await query<{ id: string }>(
    `INSERT INTO page_baselines (
       id, page_id, original_page_id, page_identity, version,
       content_revision, lifecycle_revision, manifest_digest, manifest,
       manifest_bytes, title, body_html, body_text, total_bytes, reserved_bytes,
       status, prepared_by_user_id, prepared_by_name, preparation_intent_id,
       published_by_user_id, published_by_name, published_at, provenance, freeze_reason
     ) VALUES (
       $10, $1, $1, '[]'::jsonb, $2,
       $3::bigint, $4::bigint, $5, '[]'::jsonb,
       convert_to('[]', 'UTF8'), $6, $7, $8, 0, 0,
       'published', $9, 'Owner', $11,
       $9, 'Owner', NOW(), 'manual_assertion', 'Regression freeze'
     ) RETURNING id`,
    [
      id,
      row.version,
      row.content_revision,
      row.lifecycle_revision,
      '0'.repeat(64),
      row.title,
      row.body_html,
      row.body_text,
      actorId,
      fixture.baselineId,
      fixture.intentId,
    ],
  );
  await query(
    `UPDATE pages SET
       baseline_id = $2, frozen_version = version, frozen_at = NOW(),
       frozen_by_user_id = $3, frozen_by_name = 'Owner',
       freeze_reason = 'Regression freeze',
       freeze_provenance = 'manual_assertion',
       freeze_reported_signatories = '[]'::jsonb
     WHERE id = $1`,
    [id, baseline.rows[0]!.id, actorId],
  );
}

function applyPayload(pageId: number, extra: Record<string, unknown> = {}) {
  return {
    method: 'POST' as const,
    url: '/api/llm/improvements/apply',
    payload: JSON.stringify({
      pageId: String(pageId),
      improvedMarkdown: '# Overwritten\n\nAttacker controlled content.',
      ...extra,
    }),
  };
}

let app: FastifyInstance;
let owner: { token: string; userId: string };
let attacker: { token: string; userId: string };

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
  owner = await createUser('idor_owner');
  attacker = await createUser('idor_attacker');
});

describe.skipIf(!dbAvailable)('POST /api/llm/improvements/apply — standalone page IDOR (#734)', () => {
  it('returns 404 for a cross-user apply on a private standalone page and leaves content unchanged', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'private' });

    // No `version` in the payload — the exact lock-bypass vector from the issue.
    const response = await app.inject({
      ...applyPayload(pageId, { title: 'pwned' }),
      headers: { authorization: `Bearer ${attacker.token}`, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(404);
    // The response must not leak the page's real title or version.
    expect(response.body).not.toContain(ORIGINAL_TITLE);
    expect(response.body).not.toContain(`"version":${ORIGINAL_VERSION}`);

    const page = await fetchPage(pageId);
    expect(page.title).toBe(ORIGINAL_TITLE);
    expect(page.body_html).toBe(ORIGINAL_HTML);
    expect(page.body_text).toBe(ORIGINAL_TEXT);
    expect(page.version).toBe(ORIGINAL_VERSION);
  });

  it('returns 404 (not 409) for a stale-version cross-user apply — no existence oracle', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'private' });

    // A 409 here would confirm the page exists and that its version is > 1.
    const response = await app.inject({
      ...applyPayload(pageId, { version: 1 }),
      headers: { authorization: `Bearer ${attacker.token}`, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(404);

    const page = await fetchPage(pageId);
    expect(page.body_html).toBe(ORIGINAL_HTML);
    expect(page.version).toBe(ORIGINAL_VERSION);
  });

  it('still lets the owner apply an improvement to their own private standalone page', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'private' });

    const response = await app.inject({
      ...applyPayload(pageId, { version: ORIGINAL_VERSION, title: 'Improved title' }),
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: pageId, title: 'Improved title', version: ORIGINAL_VERSION + 1 });

    const page = await fetchPage(pageId);
    expect(page.title).toBe('Improved title');
    expect(page.body_html).toContain('Overwritten');
    expect(page.version).toBe(ORIGINAL_VERSION + 1);
  });

  it('still lets any authenticated user apply an improvement to a shared standalone page', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'shared', title: 'Team page' });

    const response = await app.inject({
      ...applyPayload(pageId, { version: ORIGINAL_VERSION }),
      headers: { authorization: `Bearer ${attacker.token}`, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: pageId, title: 'Team page', version: ORIGINAL_VERSION + 1 });

    const page = await fetchPage(pageId);
    expect(page.body_html).toContain('Overwritten');
    expect(page.version).toBe(ORIGINAL_VERSION + 1);
  });

  it('rejects AI Apply on a frozen page without changing authored content', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'private' });
    await freezePage(pageId, owner.userId);

    const response = await app.inject({
      ...applyPayload(pageId, { version: ORIGINAL_VERSION, title: 'Must not land' }),
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({ reason: 'page_is_frozen' });
    expect(await fetchPage(pageId)).toMatchObject({
      title: ORIGINAL_TITLE,
      body_html: ORIGINAL_HTML,
      version: ORIGINAL_VERSION,
    });
  });

  it('rejects label application on a frozen page', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'private' });
    await freezePage(pageId, owner.userId);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/labels`,
      payload: { addLabels: ['security'] },
      headers: { authorization: `Bearer ${owner.token}` },
    });

    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({ reason: 'page_is_frozen' });
    const labels = await query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [pageId]);
    expect(labels.rows[0]!.labels).toEqual([]);
  });

  it('rejects restoring a historical snapshot over a frozen page', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'private' });
    await query(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
       VALUES ($1, 2, 'Historical', '<p>Historical</p>', 'Historical')`,
      [pageId],
    );
    await freezePage(pageId, owner.userId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/2/restore`,
      payload: { version: ORIGINAL_VERSION },
      headers: { authorization: `Bearer ${owner.token}` },
    });

    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({ reason: 'page_is_frozen' });
    expect(await fetchPage(pageId)).toMatchObject({
      title: ORIGINAL_TITLE,
      body_html: ORIGINAL_HTML,
      version: ORIGINAL_VERSION,
    });
  });
});
