import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query } from '../../postgres.js';
import {
  insertTestRuntime,
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../../test-db-helper.js';

const dbAvailable = await isDbAvailable();

/**
 * #2035 — `page_write_intents.remote_effect_failed_at` marks a collaborative
 * Save whose remote phase failed after dispatch. It is additive: existing
 * intents keep reading as before.
 */
describe.skipIf(!dbAvailable)('migration 160 collaborative commit outcome unknown (#2035)', () => {
  beforeAll(async () => { await setupTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  async function insertPage(): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, source, visibility)
       VALUES ('Marker', '<p>seed</p>', 'seed', 'standalone', 'shared') RETURNING id`,
    );
    return page.rows[0]!.id;
  }

  /** A pending collaborative commit as the Save route leaves it, dispatched or not. */
  async function insertCommitIntent(
    pageId: number,
    runtimeId: string,
    dispatched: boolean,
    runner: { query: (sql: string, values?: unknown[]) => Promise<unknown> } = getPool(),
  ): Promise<string> {
    const id = crypto.randomUUID();
    await runner.query(
      `INSERT INTO page_write_intents
         (id, runtime_id, kind, page_ids, revisions, recovery_mode, effect,
          effect_started_at, remote_effect_started_at)
       VALUES ($1, $2, 'collab.commit.confluence', ARRAY[$3]::int[], '{}'::jsonb, 'remote_conditional',
               $4::jsonb, CASE WHEN $5::boolean THEN NOW() END, CASE WHEN $5::boolean THEN NOW() END)`,
      [
        id,
        runtimeId,
        pageId,
        JSON.stringify({
          effectClass: 'remote',
          pageId,
          confluenceId: 'cf-160',
          expectedRemoteVersion: '4',
          intendedStateDigest: 'a'.repeat(64),
        }),
        dispatched,
      ],
    );
    return id;
  }

  it('is recorded on a freshly migrated database as a nullable timestamp without a default', async () => {
    const applied = await query<{ name: string }>(
      "SELECT name FROM _migrations WHERE name = '160_collab_commit_outcome_unknown.sql'",
    );
    expect(applied.rows).toHaveLength(1);
    const column = await query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'page_write_intents' AND column_name = 'remote_effect_failed_at'`,
    );
    expect(column.rows).toEqual([
      { data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('applies on a database at 159 and leaves every existing intent unmarked', async () => {
    const pageId = await insertPage();
    const otherPageId = await insertPage();
    const runtimeId = await insertTestRuntime();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // The state of a database migrated at the previous level.
      await client.query(
        'ALTER TABLE page_write_intents DROP CONSTRAINT page_write_intents_remote_effect_failed_check',
      );
      await client.query('ALTER TABLE page_write_intents DROP COLUMN remote_effect_failed_at');
      const dispatched = await insertCommitIntent(pageId, runtimeId, true, client);
      const reserved = await insertCommitIntent(otherPageId, runtimeId, false, client);

      const migration = await readFile(
        new URL('../160_collab_commit_outcome_unknown.sql', import.meta.url), 'utf8',
      );
      await client.query(migration);

      const rows = await client.query<{ id: string; status: string; remote_effect_failed_at: Date | null }>(
        'SELECT id, status, remote_effect_failed_at FROM page_write_intents ORDER BY created_at, id',
      );
      expect(rows.rows).toHaveLength(2);
      expect(new Set(rows.rows.map((row) => row.id))).toEqual(new Set([dispatched, reserved]));
      for (const row of rows.rows) {
        expect(row).toMatchObject({ status: 'pending', remote_effect_failed_at: null });
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('accepts the marker only on an intent whose remote effect started', async () => {
    const runtimeId = await insertTestRuntime();
    const dispatched = await insertCommitIntent(await insertPage(), runtimeId, true);
    const reserved = await insertCommitIntent(await insertPage(), runtimeId, false);

    await expect(query(
      'UPDATE page_write_intents SET remote_effect_failed_at = NOW() WHERE id = $1', [reserved],
    )).rejects.toMatchObject({ code: '23514', constraint: 'page_write_intents_remote_effect_failed_check' });

    await query('UPDATE page_write_intents SET remote_effect_failed_at = NOW() WHERE id = $1', [dispatched]);
    const marked = await query<{ status: string; marked: boolean }>(
      'SELECT status, remote_effect_failed_at IS NOT NULL AS marked FROM page_write_intents WHERE id = $1',
      [dispatched],
    );
    // The marker settles nothing.
    expect(marked.rows).toEqual([{ status: 'pending', marked: true }]);
  });
});
