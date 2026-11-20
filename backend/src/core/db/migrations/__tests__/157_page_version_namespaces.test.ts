import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getPool } from '../../postgres.js';
import { isDbAvailable } from '../../../../test-db-helper.js';

const available = await isDbAvailable();

describe.skipIf(!available)('migration 157 page version namespaces', () => {
  it('backfills both counters and snapshot sources with existing content and links intact', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TEMP TABLE pages (id INTEGER PRIMARY KEY, source TEXT NOT NULL, version INTEGER NOT NULL);
        CREATE TEMP TABLE page_versions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          page_id INTEGER NOT NULL REFERENCES pages(id),
          version_number INTEGER NOT NULL,
          title TEXT NOT NULL,
          body_html TEXT,
          body_text TEXT
        );
        CREATE UNIQUE INDEX page_versions_page_id_version_unique ON page_versions (page_id, version_number);
        CREATE TEMP TABLE page_baselines (
          page_id INTEGER NOT NULL REFERENCES pages(id),
          version_snapshot_id UUID REFERENCES page_versions(id) ON DELETE SET NULL
        );
        INSERT INTO pages VALUES (1, 'confluence', 9), (2, 'standalone', 8);
        INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
        VALUES (1, 3, 'Remote history', '<p>Remote</p>', 'Remote'), (2, 3, 'Local history', NULL, NULL);
        INSERT INTO page_baselines SELECT page_id, id FROM page_versions WHERE page_id = 2;
      `);
      const before = await client.query('SELECT to_jsonb(v) AS snapshot FROM page_versions v ORDER BY page_id');
      const baseline = await client.query('SELECT * FROM page_baselines');
      const migration = await readFile(new URL('../157_page_version_namespaces.sql', import.meta.url), 'utf8');
      await client.query(migration);

      expect((await client.query('SELECT id, version, remote_version FROM pages ORDER BY id')).rows).toEqual([
        { id: 1, version: 9, remote_version: 9 },
        { id: 2, version: 8, remote_version: null },
      ]);
      expect((await client.query("SELECT to_jsonb(v) - 'source' AS snapshot FROM page_versions v ORDER BY page_id")).rows)
        .toEqual(before.rows);
      expect((await client.query('SELECT source FROM page_versions ORDER BY page_id')).rows)
        .toEqual([{ source: 'confluence' }, { source: 'local' }]);
      expect((await client.query(
        'SELECT b.* FROM page_baselines b JOIN page_versions v ON v.id = b.version_snapshot_id',
      )).rows).toEqual(baseline.rows);
      expect((await client.query(
        "SELECT to_regclass('pg_temp.page_versions_page_id_version_unique') AS old_index",
      )).rows).toEqual([{ old_index: null }]);

      await client.query(
        "INSERT INTO page_versions (page_id, source, version_number, title) VALUES (1, 'local', 3, 'Same number')",
      );
      await expect(client.query(
        "INSERT INTO page_versions (page_id, source, version_number, title) VALUES (1, 'local', 3, 'Duplicate')",
      )).rejects.toMatchObject({ code: '23505', constraint: 'page_versions_page_id_source_version_unique' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
