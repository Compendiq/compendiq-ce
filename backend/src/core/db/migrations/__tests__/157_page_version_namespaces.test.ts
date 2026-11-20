import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { getPool, query } from '../../postgres.js';
import {
  insertTestRuntime, isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables,
} from '../../../../test-db-helper.js';

const available = await isDbAvailable();

async function freezeConfluenceFixture(client: PoolClient, pageId: number, snapshotId: string) {
  // Model an Enterprise-frozen Confluence page with the real baseline and
  // protected-write triggers. CE's freeze route only admits standalone pages.
  const runtimeId = await insertTestRuntime({ client });
  const frozen = await client.query(
    `WITH intent AS (
       INSERT INTO page_write_intents (runtime_id, kind, page_ids, revisions, recovery_mode, effect)
       VALUES ($2, 'baseline.prepare', ARRAY[$1]::integer[], '{}', 'local_verified', '{"effectClass":"local"}')
       RETURNING id
     ), baseline AS (
       INSERT INTO page_baselines (
         id, page_id, original_page_id, page_identity, version, content_revision, lifecycle_revision,
         manifest_digest, manifest, manifest_bytes, title, body_html, body_text, labels, total_bytes, reserved_bytes, status,
         prepared_by_name, preparation_intent_id, published_by_name, published_at, provenance, freeze_reason,
         version_snapshot_id
       )
       SELECT gen_random_uuid(), p.id, p.id, '[]', p.version, p.content_revision, p.lifecycle_revision,
              repeat('a', 64), '[]', decode('00', 'hex'), p.title, p.body_html, p.body_text, p.labels, 0, 0, 'published',
              'Tester', intent.id, 'Tester', NOW(), 'authenticated_approval', 'Migration fixture', $3
         FROM pages p CROSS JOIN intent WHERE p.id = $1
       RETURNING id
     )
     UPDATE pages
        SET baseline_id = baseline.id, frozen_version = version, frozen_at = NOW(), frozen_by_name = 'Tester',
            freeze_reason = 'Migration fixture', freeze_provenance = 'authenticated_approval',
            freeze_reported_signatories = '[]'
       FROM baseline WHERE pages.id = $1
     RETURNING pages.baseline_id`,
    [pageId, runtimeId, snapshotId],
  );
  expect(frozen.rowCount).toBe(1);
}

describe.skipIf(!available)('migration 157 page version namespaces', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('backfills active and frozen pages while preserving revisions, snapshot content and baseline links', async () => {
    const client = await getPool().connect();
    try {
      // Replay the migration against the real pre-157 table shapes. Rollback
      // restores the schema for other files sharing this worker database.
      await client.query('BEGIN');
      await client.query(`
        DROP TRIGGER IF EXISTS page_versions_infer_source_on_insert ON page_versions;
        DROP FUNCTION IF EXISTS infer_page_version_source();
        DROP INDEX page_versions_page_id_source_version_unique;
        ALTER TABLE page_versions DROP COLUMN source;
        CREATE UNIQUE INDEX page_versions_page_id_version_unique ON page_versions (page_id, version_number);
        ALTER TABLE pages DROP COLUMN remote_version;
      `);
      const pages = await client.query<{ id: number }>(`
        INSERT INTO pages (title, source, confluence_id, version, body_html, body_text)
        VALUES ('Frozen remote', 'confluence', 'migration-157-frozen', 9, '<p>Remote</p>', 'Remote'),
               ('Active remote', 'confluence', 'migration-157-active', 7, NULL, NULL),
               ('Local', 'standalone', NULL, 8, NULL, NULL)
        RETURNING id
      `);
      const frozenId = pages.rows[0]!.id;
      const activeId = pages.rows[1]!.id;
      const localId = pages.rows[2]!.id;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
         VALUES ($1, 9, 'Frozen remote', '<p>Remote</p>', 'Remote'), ($2, 3, 'Local history', NULL, NULL)
         RETURNING id`,
        [frozenId, localId],
      );
      await freezeConfluenceFixture(client, frozenId, inserted.rows[0]!.id);

      const beforePage = await client.query('SELECT to_jsonb(p) AS page FROM pages p ORDER BY id');
      const beforeHistory = await client.query('SELECT to_jsonb(v) AS snapshot FROM page_versions v ORDER BY page_id');
      const beforeLink = await client.query('SELECT id, version_snapshot_id FROM page_baselines');
      const migration = await readFile(new URL('../157_page_version_namespaces.sql', import.meta.url), 'utf8');
      await client.query(migration);

      expect((await client.query('SELECT id, version, remote_version FROM pages ORDER BY id')).rows).toEqual([
        { id: frozenId, version: 9, remote_version: 9 },
        { id: activeId, version: 7, remote_version: 7 },
        { id: localId, version: 8, remote_version: null },
      ]);
      expect((await client.query("SELECT to_jsonb(p) - 'remote_version' AS page FROM pages p ORDER BY id")).rows)
        .toEqual(beforePage.rows);
      expect((await client.query("SELECT to_jsonb(v) - 'source' AS snapshot FROM page_versions v ORDER BY page_id")).rows)
        .toEqual(beforeHistory.rows);
      expect((await client.query('SELECT source FROM page_versions ORDER BY page_id')).rows)
        .toEqual([{ source: 'confluence' }, { source: 'local' }]);
      expect((await client.query(
        'SELECT b.id, b.version_snapshot_id FROM page_baselines b JOIN page_versions v ON v.id = b.version_snapshot_id',
      )).rows).toEqual(beforeLink.rows);
      expect((await client.query(
        "SELECT to_regclass('page_versions_page_id_version_unique') AS old_index",
      )).rows).toEqual([{ old_index: null }]);

      await client.query('SAVEPOINT frozen_guard');
      await expect(client.query("UPDATE pages SET title = 'Changed' WHERE id = $1", [frozenId]))
        .rejects.toMatchObject({ code: '55000', message: 'page_is_frozen' });
      await client.query('ROLLBACK TO SAVEPOINT frozen_guard');
      await client.query(
        "INSERT INTO page_versions (page_id, source, version_number, title) VALUES ($1, 'local', 9, 'Same number')",
        [frozenId],
      );
      await expect(client.query(
        "INSERT INTO page_versions (page_id, source, version_number, title) VALUES ($1, 'local', 9, 'Duplicate')",
        [frozenId],
      )).rejects.toMatchObject({ code: '23505', constraint: 'page_versions_page_id_source_version_unique' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('derives omitted and NULL snapshot sources from page provenance and preserves explicit sources', async () => {
    const { rows: [remote, local] } = await query<{ id: number }>(
      `INSERT INTO pages (title, source, confluence_id)
       VALUES ('Remote', 'confluence', 'migration-157-remote'),
              ('Local with historical remote ID', 'standalone', 'migration-157-local')
       RETURNING id`,
    );
    const omitted = await query(
      `INSERT INTO page_versions (page_id, version_number, title)
       VALUES ($1, 1, 'Remote snapshot'), ($2, 1, 'Local snapshot')
       RETURNING source`,
      [remote!.id, local!.id],
    );
    expect(omitted.rows).toEqual([{ source: 'confluence' }, { source: 'local' }]);
    const explicit = await query(
      `INSERT INTO page_versions (page_id, version_number, title, source)
       VALUES ($1, 2, 'Null source', NULL), ($1, 1, 'Local at remote number', 'local')
       RETURNING source`,
      [remote!.id],
    );
    expect(explicit.rows).toEqual([{ source: 'confluence' }, { source: 'local' }]);
  });
});
