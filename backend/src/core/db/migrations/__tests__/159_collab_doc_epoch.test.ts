import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CollabDocEpochSchema } from '@compendiq/contracts';
import { getPool, query } from '../../postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../../test-db-helper.js';

const dbAvailable = await isDbAvailable();

/**
 * #2034 — `page_collaborative_docs.doc_epoch` is the server-owned identity of
 * a collaborative document lineage. The database generates it, for existing
 * rows as well as for rows a process older than this column inserts.
 */
describe.skipIf(!dbAvailable)('migration 159 collaborative document epoch (#2034)', () => {
  beforeAll(async () => { await setupTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  async function insertPages(count: number): Promise<number[]> {
    const pages = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, source, visibility)
       SELECT 'Epoch ' || n, '<p>seed</p>', 'seed', 'standalone', 'shared'
         FROM generate_series(1, $1::integer) AS n
       RETURNING id`,
      [count],
    );
    return pages.rows.map((row) => row.id);
  }

  it('is recorded on a freshly migrated database as a NOT NULL uuid with a generated default', async () => {
    const applied = await query<{ name: string }>(
      "SELECT name FROM _migrations WHERE name = '159_collab_doc_epoch.sql'",
    );
    expect(applied.rows).toHaveLength(1);
    const column = await query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'page_collaborative_docs' AND column_name = 'doc_epoch'`,
    );
    expect(column.rows).toEqual([
      { data_type: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
    ]);
  });

  it('gives every existing row its own epoch', async () => {
    const pageIds = await insertPages(5);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // The state of a database migrated at the previous level.
      await client.query('ALTER TABLE page_collaborative_docs DROP COLUMN doc_epoch');
      await client.query(
        `INSERT INTO page_collaborative_docs (page_id, doc_state)
         SELECT id, '\\x00'::bytea FROM unnest($1::integer[]) AS id`,
        [pageIds],
      );

      const migration = await readFile(new URL('../159_collab_doc_epoch.sql', import.meta.url), 'utf8');
      await client.query(migration);

      const rows = await client.query<{ page_id: number; doc_epoch: string; doc_state: Buffer }>(
        'SELECT page_id, doc_epoch::text, doc_state FROM page_collaborative_docs ORDER BY page_id',
      );
      expect(rows.rows.map((row) => row.page_id)).toEqual(pageIds);
      for (const row of rows.rows) {
        expect(CollabDocEpochSchema.safeParse(row.doc_epoch).success, row.doc_epoch).toBe(true);
        // The rewrite keeps the persisted bytes.
        expect(row.doc_state.equals(Buffer.from([0]))).toBe(true);
      }
      expect(new Set(rows.rows.map((row) => row.doc_epoch)).size).toBe(pageIds.length);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('gives a row inserted without naming the column a default epoch, as a process older than the column does', async () => {
    const [first, second] = await insertPages(2);
    // The exact statement shape a pod that predates this column still runs.
    const legacyUpsert = `INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector, version, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (page_id) DO UPDATE SET
         doc_state = EXCLUDED.doc_state,
         state_vector = EXCLUDED.state_vector,
         version = page_collaborative_docs.version + 1,
         updated_at = NOW()`;
    await query(legacyUpsert, [first, Buffer.from([1]), Buffer.from([1])]);
    await query(legacyUpsert, [second, Buffer.from([1]), Buffer.from([1])]);
    const seeded = await query<{ page_id: number; doc_epoch: string }>(
      'SELECT page_id, doc_epoch::text FROM page_collaborative_docs ORDER BY page_id',
    );
    expect(seeded.rows).toHaveLength(2);
    expect(seeded.rows[0]!.doc_epoch).not.toBe(seeded.rows[1]!.doc_epoch);
    for (const row of seeded.rows) expect(CollabDocEpochSchema.safeParse(row.doc_epoch).success).toBe(true);

    // The same pod's later overwrite of that row keeps its epoch: only a new row is a new lineage.
    await query(legacyUpsert, [first, Buffer.from([2]), Buffer.from([2])]);
    const rewritten = await query<{ doc_epoch: string; version: number }>(
      'SELECT doc_epoch::text, version FROM page_collaborative_docs WHERE page_id = $1', [first],
    );
    expect(rewritten.rows).toEqual([{ doc_epoch: seeded.rows[0]!.doc_epoch, version: 2 }]);

    // A deleted and re-inserted row is a new lineage.
    await query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [first]);
    await query(legacyUpsert, [first, Buffer.from([3]), Buffer.from([3])]);
    const reseeded = await query<{ doc_epoch: string }>(
      'SELECT doc_epoch::text FROM page_collaborative_docs WHERE page_id = $1', [first],
    );
    expect(reseeded.rows[0]!.doc_epoch).not.toBe(seeded.rows[0]!.doc_epoch);
  });
});
