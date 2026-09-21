import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { upsertVersionMetadata, fillVersionBody } from './version-snapshot.js';
import { runRetentionCleanup } from './data-retention-service.js';

const dbAvailable = await isDbAvailable();

/**
 * Seed a minimal standalone page and return its internal `id`.
 */
async function seedPage(): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (space_key, title, body_html, body_text, version, source, embedding_dirty, embedding_status)
     VALUES ('TEST', 'Test page', '<p>v1</p>', 'v1', 1, 'standalone', FALSE, 'not_embedded')
     RETURNING id`,
  );
  return res.rows[0]!.id;
}

async function baselineFixtureIds(pageId: number): Promise<{ baselineId: string; intentId: string }> {
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
       id, runtime_id, kind, page_ids, revisions, recovery_mode,
       effect, status, settled_at, settlement_reason, settlement_proof
     )
     SELECT ids.id, 'baseline-fixture', 'baseline.prepare',
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
    [pageId],
  );
  return {
    baselineId: result.rows[0]!.baseline_id,
    intentId: result.rows[0]!.id,
  };
}

describe.skipIf(!dbAvailable)('upsertVersionMetadata + fillVersionBody (#722)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('upsertVersionMetadata inserts then updates metadata idempotently', async () => {
    const id = await seedPage();
    await upsertVersionMetadata(id, 3, 'T', { editedAt: '2026-01-02T00:00:00Z', author: 'Ann', message: 'edit' });
    await upsertVersionMetadata(id, 3, 'T', { editedAt: '2026-01-02T00:00:00Z', author: 'Ann', message: 'edit' }); // no dup
    const r = await query(`SELECT author, message FROM page_versions WHERE page_id=$1 AND version_number=3`, [id]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ author: 'Ann', message: 'edit' });
  });

  it('fillVersionBody fills a null body only', async () => {
    const id = await seedPage();
    await upsertVersionMetadata(id, 2, 'T', { editedAt: null, author: null, message: null });
    await fillVersionBody(id, 2, '<p>hi</p>', 'hi');
    const r = await query(`SELECT body_html FROM page_versions WHERE page_id=$1 AND version_number=2`, [id]);
    expect(r.rows[0]!.body_html).toBe('<p>hi</p>');
  });

  it('retention prunes excess ordinary snapshots but keeps a baseline-linked snapshot', async () => {
    const id = await seedPage();
    const versions = await query<{ id: string; version_number: number }>(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
       VALUES
         ($1, 1, 'v1', '<p>v1</p>', 'v1'),
         ($1, 2, 'v2', '<p>v2</p>', 'v2'),
         ($1, 3, 'v3', '<p>v3</p>', 'v3')
       RETURNING id, version_number`,
      [id],
    );
    const protectedVersion = versions.rows.find((row) => row.version_number === 1)!;
    const page = await query<{ content_revision: string; lifecycle_revision: string }>(
      'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1',
      [id],
    );
    const fixture = await baselineFixtureIds(id);
    await query(
      `INSERT INTO page_baselines (
         id, page_id, original_page_id, page_identity, version,
         content_revision, lifecycle_revision, manifest_digest, manifest,
         manifest_bytes, title, total_bytes, reserved_bytes,
         prepared_by_name, preparation_intent_id, version_snapshot_id
       ) VALUES (
         $6, $1, $1, '[]'::jsonb, 1,
         $2::bigint, $3::bigint, $4, '[]'::jsonb,
         convert_to('[]', 'UTF8'), 'v1', 0, 0,
         'Retention test', $7, $5
       )`,
      [
        id,
        page.rows[0]!.content_revision,
        page.rows[0]!.lifecycle_revision,
        '0'.repeat(64),
        protectedVersion.id,
        fixture.baselineId,
        fixture.intentId,
      ],
    );

    const previous = process.env.RETENTION_VERSIONS_MAX;
    process.env.RETENTION_VERSIONS_MAX = '1';
    try {
      await runRetentionCleanup();
    } finally {
      if (previous === undefined) delete process.env.RETENTION_VERSIONS_MAX;
      else process.env.RETENTION_VERSIONS_MAX = previous;
    }

    const retained = await query<{ version_number: number }>(
      'SELECT version_number FROM page_versions WHERE page_id = $1 ORDER BY version_number',
      [id],
    );
    expect(retained.rows.map((row) => row.version_number)).toEqual([1, 3]);
  });
});
