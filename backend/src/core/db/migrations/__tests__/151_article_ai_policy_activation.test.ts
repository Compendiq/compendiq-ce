import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../../test-db-helper.js';
import { getPool, query } from '../../postgres.js';

const available = await isDbAvailable();
const sql = await readFile(new URL('../151_article_ai_policy_activation.sql', import.meta.url), 'utf8');

async function triggerNames(table: string): Promise<string[]> {
  const rows = await query<{ tgname: string }>(
    `SELECT t.tgname FROM pg_trigger t
      WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal AND t.tgname LIKE 'guard_ai_policy%'
      ORDER BY t.tgname`,
    [table],
  );
  return rows.rows.map((row) => row.tgname);
}

async function indexNames(): Promise<string[]> {
  const rows = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('pages_ai_policy_restricted_idx', 'page_writer_runtimes_ai_policy_incompatible_idx')
      ORDER BY indexname`,
  );
  return rows.rows.map((row) => row.indexname);
}

describe.skipIf(!available)('Migration 151 — article AI policy activation (#1881)', () => {
  beforeAll(async () => { await setupTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it('fresh: installs the switch, the observer table, the runtime version and both guards', async () => {
    const state = await query(
      `SELECT enabled, changed_at, changed_by_user_id, changed_by_name, legacy_clients_acknowledged,
              observing_since IS NOT NULL AS observing
         FROM ai_policy_activation_state`,
    );
    expect(state.rows).toEqual([{
      enabled: false, changed_at: null, changed_by_user_id: null, changed_by_name: null,
      legacy_clients_acknowledged: false, observing: true,
    }]);
    const columns = await query<{ table_name: string; column_name: string; column_default: string | null; is_nullable: string }>(
      `SELECT table_name, column_name, column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'page_writer_runtimes' AND column_name = 'ai_policy_enforcement_version')
            OR table_name = 'ai_policy_legacy_client_observations')
        ORDER BY table_name, column_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: 'ai_policy_legacy_client_observations', column_name: 'last_seen_at', column_default: null, is_nullable: 'NO' },
      { table_name: 'ai_policy_legacy_client_observations', column_name: 'observations', column_default: '1', is_nullable: 'NO' },
      { table_name: 'ai_policy_legacy_client_observations', column_name: 'token_expires_at', column_default: null, is_nullable: 'NO' },
      { table_name: 'ai_policy_legacy_client_observations', column_name: 'user_id', column_default: null, is_nullable: 'NO' },
      { table_name: 'page_writer_runtimes', column_name: 'ai_policy_enforcement_version', column_default: '0', is_nullable: 'NO' },
    ]);
    expect(await triggerNames('page_writer_runtimes')).toEqual(['guard_ai_policy_runtime_registration']);
    expect(await triggerNames('pages')).toEqual(['guard_ai_policy_tightening_insert', 'guard_ai_policy_tightening_update']);
    expect(await indexNames()).toEqual(['page_writer_runtimes_ai_policy_incompatible_idx', 'pages_ai_policy_restricted_idx']);

    // The singleton CHECK and the FK semantics the design relies on.
    await expect(query(`INSERT INTO ai_policy_activation_state (singleton, enabled) VALUES (FALSE, TRUE)`))
      .rejects.toMatchObject({ code: '23514' });
    const admin = randomUUID();
    await query(`INSERT INTO users (id, username, password_hash, role) VALUES ($1::uuid, $1::text, 'x', 'admin')`, [admin]);
    await query(`UPDATE ai_policy_activation_state SET changed_by_user_id = $1, changed_by_name = 'Admin'`, [admin]);
    await query(`INSERT INTO ai_policy_legacy_client_observations (user_id, last_seen_at, token_expires_at) VALUES ($1, NOW(), NOW())`, [admin]);
    await query('DELETE FROM users WHERE id = $1', [admin]);
    expect((await query('SELECT changed_by_user_id, changed_by_name FROM ai_policy_activation_state')).rows)
      .toEqual([{ changed_by_user_id: null, changed_by_name: 'Admin' }]);
    expect((await query('SELECT count(*)::int AS n FROM ai_policy_legacy_client_observations')).rows[0]!.n).toBe(0);
    await expect(query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, ai_policy_enforcement_version)
       VALUES ('negative', '{}'::jsonb, -1)`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('upgrade from 150: existing runtimes become version 0, the switch is seeded off, the door closes at once', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // Back to the 150 shape. Triggers first: the registration trigger
      // depends on the column it fires on.
      await client.query('DROP TRIGGER guard_ai_policy_runtime_registration ON page_writer_runtimes');
      await client.query('DROP TRIGGER guard_ai_policy_tightening_insert ON pages');
      await client.query('DROP TRIGGER guard_ai_policy_tightening_update ON pages');
      await client.query('DROP FUNCTION guard_ai_policy_runtime_registration()');
      await client.query('DROP FUNCTION guard_ai_policy_tightening()');
      await client.query('DROP INDEX pages_ai_policy_restricted_idx');
      await client.query('ALTER TABLE page_writer_runtimes DROP COLUMN ai_policy_enforcement_version');
      await client.query('DROP TABLE ai_policy_legacy_client_observations');
      await client.query('DROP TABLE ai_policy_activation_state');
      expect((await client.query(`SELECT to_regclass('public.ai_policy_activation_state') AS t`)).rows[0]!.t).toBeNull();

      // Pre-#1881 data: a live dev binary (protected-writer protocol 1, no
      // policy protocol) and a restriction stored before the door existed.
      await client.query(
        `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version)
         VALUES ('pre-1881-live', '{"host":"old"}'::jsonb, 1)`,
      );
      const restricted = (await client.query<{ id: number }>(
        `INSERT INTO pages (title, ai_policy, labels) VALUES ('Already restricted', 'none', ARRAY['no-ai']) RETURNING id`,
      )).rows[0]!.id;

      await client.query(sql);
      await client.query(sql);

      expect((await client.query(
        `SELECT enforcement_version, ai_policy_enforcement_version FROM page_writer_runtimes WHERE runtime_id = 'pre-1881-live'`,
      )).rows).toEqual([{ enforcement_version: 1, ai_policy_enforcement_version: 0 }]);
      expect((await client.query(
        `SELECT enabled, changed_at, changed_by_user_id, legacy_clients_acknowledged,
                observing_since > NOW() - interval '1 minute' AS installed_now
           FROM ai_policy_activation_state`,
      )).rows).toEqual([{ enabled: false, changed_at: null, changed_by_user_id: null, legacy_clients_acknowledged: false, installed_now: true }]);
      expect((await client.query('SELECT ai_policy, ai_policy_revision FROM pages WHERE id = $1', [restricted])).rows)
        .toEqual([{ ai_policy: 'none', ai_policy_revision: '0' }]);
      expect((await client.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
          AND indexname IN ('pages_ai_policy_restricted_idx', 'page_writer_runtimes_ai_policy_incompatible_idx')
          ORDER BY indexname`,
      )).rows.map((row) => row.indexname)).toEqual(['page_writer_runtimes_ai_policy_incompatible_idx', 'pages_ai_policy_restricted_idx']);

      // The door is closed from the first statement after the upgrade: the
      // live old binary blocks new restrictions, and the stored restriction
      // blocks any further old binary from registering.
      await client.query('SAVEPOINT tighten');
      await expect(client.query(`INSERT INTO pages (title, ai_policy) VALUES ('New restriction', 'local_only')`))
        .rejects.toMatchObject({ code: '55000', constraint: 'ai_policy_incompatible_runtime_active' });
      await client.query('ROLLBACK TO SAVEPOINT tighten');
      await client.query('SAVEPOINT register');
      await expect(client.query(
        `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version)
         VALUES ('pre-1881-restart', '{"host":"old"}'::jsonb, 1)`,
      )).rejects.toMatchObject({ code: '55000', constraint: 'ai_policy_incompatible_runtime_registration' });
      await client.query('ROLLBACK TO SAVEPOINT register');
      // The live old binary's own per-admission re-registration still works.
      await expect(client.query(
        `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version)
         VALUES ('pre-1881-live', '{"host":"old"}'::jsonb, 1) ON CONFLICT (runtime_id) DO NOTHING`,
      )).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('is idempotent on an already migrated database and never rewrites the seeded row', async () => {
    await query(`UPDATE ai_policy_activation_state SET enabled = TRUE, changed_by_name = 'kept', observing_since = '2020-01-01T00:00:00Z'`);
    await query(sql);
    await query(sql);
    expect((await query(
      `SELECT count(*) OVER ()::int AS rows, enabled, changed_by_name, observing_since FROM ai_policy_activation_state`,
    )).rows).toEqual([{ rows: 1, enabled: true, changed_by_name: 'kept', observing_since: new Date('2020-01-01T00:00:00Z') }]);
    expect(await triggerNames('page_writer_runtimes')).toEqual(['guard_ai_policy_runtime_registration']);
    expect(await triggerNames('pages')).toEqual(['guard_ai_policy_tightening_insert', 'guard_ai_policy_tightening_update']);
    expect(await indexNames()).toEqual(['page_writer_runtimes_ai_policy_incompatible_idx', 'pages_ai_policy_restricted_idx']);
  });
});
