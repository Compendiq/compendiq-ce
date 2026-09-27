import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '../../postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../../../test-db-helper.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('page-write migration rolling-deployment boundary', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });

  it('keeps legacy page writes usable between separately committed migrations 120 and 121', async () => {
    const schema = `baseline_gap_${randomUUID().replaceAll('-', '')}`;
    const client = await getPool().connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, pg_catalog`);
      await client.query('CREATE TABLE users (id UUID PRIMARY KEY)');
      await client.query('CREATE TABLE page_versions (id UUID PRIMARY KEY)');
      // A separate schema exercises real PostgreSQL DDL without downgrading the
      // shared worker database or copying its triggers and foreign keys.
      await client.query('CREATE TABLE pages (LIKE public.pages INCLUDING DEFAULTS INCLUDING CONSTRAINTS)');
      await client.query('ALTER TABLE pages ADD PRIMARY KEY (id)');
      await client.query(`ALTER TABLE pages
        DROP COLUMN content_revision,
        DROP COLUMN lifecycle_revision,
        DROP COLUMN baseline_id,
        DROP COLUMN frozen_version,
        DROP COLUMN frozen_at,
        DROP COLUMN frozen_by_user_id,
        DROP COLUMN frozen_by_name,
        DROP COLUMN freeze_reason,
        DROP COLUMN freeze_provenance,
        DROP COLUMN freeze_reported_signatories,
        DROP COLUMN freeze_reported_reference`);
      await client.query(`INSERT INTO pages (id, title, source, body_html)
        VALUES (1, 'Legacy edit', 'standalone', '<p>Before</p>'),
               (2, 'Legacy delete', 'standalone', '<p>Delete</p>')`);

      await client.query('BEGIN');
      await client.query(await readFile(new URL('../120_page_write_admission.sql', import.meta.url), 'utf8'));
      await client.query('COMMIT');
      const edited = await client.query<{ title: string; content_revision: string }>(
        `UPDATE pages SET title = 'Edited between migrations' WHERE id = 1
         RETURNING title, content_revision::text`,
      );
      expect(edited.rows[0]?.title).toBe('Edited between migrations');
      expect((await client.query('DELETE FROM pages WHERE id = 2 RETURNING id')).rows).toEqual([{ id: 2 }]);

      await client.query('BEGIN');
      await client.query(await readFile(new URL('../121_page_baselines.sql', import.meta.url), 'utf8'));
      await client.query('COMMIT');
      const current = await client.query(
        `UPDATE pages SET body_html = '<p>After</p>' WHERE id = 1
         RETURNING title, body_html, content_revision::text, baseline_id`,
      );
      expect(current.rows).toEqual([{
        title: 'Edited between migrations',
        body_html: '<p>After</p>',
        content_revision: String(BigInt(edited.rows[0]!.content_revision) + 1n),
        baseline_id: null,
      }]);
      expect((await client.query('SELECT creation_enabled FROM page_baseline_feature_state')).rows)
        .toEqual([{ creation_enabled: false }]);
    } finally {
      try {
        await client.query('ROLLBACK');
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        // This connection changed search_path; never lend it to another test.
        client.release(true);
      }
    }
  });
});
