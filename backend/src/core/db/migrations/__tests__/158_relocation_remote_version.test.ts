import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../../postgres.js';
import {
  insertTestRuntime, isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables,
} from '../../../../test-db-helper.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('migration 158 Confluence writer counters', () => {
  beforeAll(async () => { await setupTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it('fills intervening provider counters and preserves the pre-publish number of pending legacy drafts', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE page_relocation_preparations
        DROP COLUMN original_remote_version, DROP COLUMN published_local_version`);
      const { rows: pages } = await client.query<{ id: number }>(
        `INSERT INTO pages (title, source, confluence_id, version, remote_version)
         VALUES ('Old synced page', 'confluence', 'migration-158-sync', 6, NULL),
                ('Pending legacy draft', 'confluence', 'migration-158-draft', 7, 7),
                ('Already known', 'confluence', 'migration-158-known', 8, 4),
                ('Standalone', 'standalone', NULL, 9, NULL)
         RETURNING id`,
      );
      const runtimeId = await insertTestRuntime({ client });
      await client.query(
        `INSERT INTO page_write_intents
           (runtime_id, kind, page_ids, revisions, recovery_mode, effect)
         VALUES ($1, 'pages.draft.publish.confluence', ARRAY[$2]::integer[], '{}',
                 'remote_terminal_only', '{"effectClass":"remote","expectedVersion":6}')`,
        [runtimeId, pages[1]!.id],
      );

      const migration = await readFile(new URL('../158_relocation_remote_version.sql', import.meta.url), 'utf8');
      await client.query(migration);

      const result = await client.query(
        `SELECT version, remote_version, content_revision::text FROM pages
          WHERE id = ANY($1::integer[]) ORDER BY id`,
        [pages.map(({ id }) => id)],
      );
      expect(result.rows).toEqual([
        { version: 6, remote_version: 6, content_revision: '0' },
        { version: 7, remote_version: 6, content_revision: '0' },
        { version: 8, remote_version: 4, content_revision: '0' },
        { version: 9, remote_version: null, content_revision: '0' },
      ]);
      await client.query(`SELECT original_remote_version, published_local_version
                            FROM page_relocation_preparations LIMIT 0`);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
