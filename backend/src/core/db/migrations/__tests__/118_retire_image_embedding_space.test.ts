import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  isDbAvailable,
  restoreUsecaseCheck,
} from '../../../../test-db-helper.js';
import { query, runMigrations } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

const MIGRATION = '118_retire_image_embedding_space.sql';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The six `admin_settings` rows 118 deletes (ADR-027 `:5275` plus its erratum). */
const RETIRED_SETTING_KEYS = [
  'image_embedding_probe',
  'image_embedding_dimensions',
  'image_embedding_index_model',
  'image_embedding_target_dimensions',
  'rag_image_leg_enabled',
  'image_index_last_run',
];

/** Every use case the narrowed CHECK must still admit. */
const SURVIVING_USECASES = [
  'chat', 'summary', 'quality', 'auto_tag', 'embedding',
  'rerank', 'inline_completion', 'image_analysis',
];

/**
 * Migration 118 (#1618 stage 2, ADR-027 "Retirement plan") — the one migration
 * in this tree that NARROWS rather than adds.
 *
 * It is worth its own file for reasons the other migration tests do not cover:
 *
 *  - **The objects really are gone.** 093 created the table, the dirty column
 *    and its partial index; a `DROP … IF EXISTS` that silently matched nothing
 *    (a typo in a name, a schema qualification) would leave the retired leg's
 *    schema standing on every upgraded deployment, and nothing else in the
 *    suite would notice — `test-db-helper` no longer touches any of them.
 *  - **The CHECK is a drop-and-re-add of the WHOLE list**, so a narrowing gets
 *    the eight surviving members wrong exactly as easily as it gets
 *    `image_embedding` right. Both halves are asserted.
 *  - **The DELETEs are exercised, not merely observed.** The rows are absent on
 *    a fresh boot whether or not the statements are right — nothing seeds them
 *    — so the settings case re-seeds all six and REPLAYS the migration.
 *  - **A fresh `001 → N` boot still succeeds and is idempotent.** This file's
 *    `setupTestDb` IS that boot (the runner applies every `*.sql` in the
 *    directory, oldest first); re-running the runner must then change nothing,
 *    which is what makes a destructive migration safe in a release that boots
 *    twice.
 */
describe.skipIf(!dbAvailable)('Migration 118 — retire the legacy image embedding space (#1618)', () => {
  beforeAll(async () => { await setupTestDb(); }, 60_000);
  afterAll(async () => {
    // Shared worker database: leave the CHECK as this file found it.
    await restoreUsecaseCheck();
    await teardownTestDb();
  });

  it('applies on a fresh 001 → N boot, and re-running the runner is a no-op', async () => {
    const onDisk = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(onDisk).toContain(MIGRATION);

    const applied = await query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
    // Every file on disk is applied: the destructive one is not skipped by the
    // runner's own filter, and nothing before it failed.
    expect(applied.rows.map((r) => r.name).sort()).toEqual(onDisk);

    await runMigrations();
    const again = await query<{ name: string }>('SELECT name FROM _migrations');
    expect(again.rows.length).toBe(applied.rows.length);
  });

  it('drops page_image_embeddings, the dirty column and every index on either', async () => {
    const res = await query<{
      leg_table: string | null;
      dirty_col: number;
      dirty_idx: number;
      leg_idx: number;
    }>(
      `SELECT to_regclass('public.page_image_embeddings')::text        AS leg_table,
              (SELECT count(*)::int FROM information_schema.columns
                WHERE table_name = 'pages' AND column_name = 'image_embedding_dirty') AS dirty_col,
              (SELECT count(*)::int FROM pg_indexes
                WHERE indexname = 'pages_image_embedding_dirty_idx')  AS dirty_idx,
              (SELECT count(*)::int FROM pg_indexes
                WHERE tablename = 'page_image_embeddings')            AS leg_idx`,
    );
    expect(res.rows[0]).toEqual({ leg_table: null, dirty_col: 0, dirty_idx: 0, leg_idx: 0 });
  });

  it('leaves the replacement untouched — page_image_analyses, 116\'s columns, 115\'s seeds', async () => {
    const schema = await query<{
      analyses_table: string | null;
      analysis_dirty: number;
      analysis_revision: number;
      chunk_tsv: number;
    }>(
      `SELECT to_regclass('public.page_image_analyses')::text AS analyses_table,
              (SELECT count(*)::int FROM information_schema.columns
                WHERE table_name = 'pages' AND column_name = 'image_analysis_dirty')    AS analysis_dirty,
              (SELECT count(*)::int FROM information_schema.columns
                WHERE table_name = 'pages' AND column_name = 'image_analysis_revision') AS analysis_revision,
              (SELECT count(*)::int FROM information_schema.columns
                WHERE table_name = 'page_embeddings' AND column_name = 'chunk_tsv')     AS chunk_tsv`,
    );
    expect(schema.rows[0]).toEqual({
      analyses_table: 'page_image_analyses',
      analysis_dirty: 1,
      analysis_revision: 1,
      chunk_tsv: 1,
    });

    // 115 and 116 seed the vision assignment, the output-token ceiling and the
    // batch size. 118's DELETE names neither `image_analysis_%` prefix, and one
    // swept up by it would silently reset the worker on every upgrade — so the
    // seeds are replayed alongside 118 and read back.
    await truncateAllTables();
    await query(`DELETE FROM _migrations WHERE name IN ('115_page_image_analyses.sql', '116_image_analysis_index.sql', $1)`, [MIGRATION]);
    await runMigrations();
    const kept = await query<{ setting_key: string }>(
      `SELECT setting_key FROM admin_settings WHERE setting_key LIKE 'image\\_analysis\\_%' ORDER BY setting_key`,
    );
    expect(kept.rows.map((r) => r.setting_key)).toEqual([
      'image_analysis_batch_size',
      'image_analysis_max_output_tokens',
    ]);
    const assignment = await query<{ usecase: string }>(
      `SELECT usecase FROM llm_usecase_assignments WHERE usecase = 'image_analysis'`,
    );
    expect(assignment.rows).toHaveLength(1);
  });

  it('deletes the six legacy settings rows and the legacy assignment when it replays over them', async () => {
    await truncateAllTables();
    await restoreUsecaseCheck();
    // Re-seed exactly what an upgrading deployment carries. The assignment row
    // needs the dump-time CHECK back, because the narrowed one refuses it —
    // which is itself the state the migration has to cope with in the other
    // order.
    await query('ALTER TABLE llm_usecase_assignments DROP CONSTRAINT IF EXISTS llm_usecase_assignments_usecase_check');
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_embedding', NULL, 'vl-2b')`);
    for (const key of RETIRED_SETTING_KEYS) {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, 'x')
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'x'`,
        [key],
      );
    }

    await query('DELETE FROM _migrations WHERE name = $1', [MIGRATION]);
    await runMigrations();

    const settings = await query<{ setting_key: string }>(
      `SELECT setting_key FROM admin_settings WHERE setting_key = ANY($1::text[])`,
      [RETIRED_SETTING_KEYS],
    );
    expect(settings.rows).toEqual([]);
    const assignment = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM llm_usecase_assignments WHERE usecase = 'image_embedding'`,
    );
    expect(assignment.rows[0]!.count).toBe('0');
  });

  it('narrows the use-case CHECK to refuse image_embedding and admit every survivor', async () => {
    await truncateAllTables();
    await restoreUsecaseCheck();

    await expect(
      query(`INSERT INTO llm_usecase_assignments (usecase) VALUES ('image_embedding')`),
    ).rejects.toThrow(/llm_usecase_assignments_usecase_check/);

    for (const usecase of SURVIVING_USECASES) {
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
         VALUES ($1, NULL, 'm') ON CONFLICT (usecase) DO NOTHING`,
        [usecase],
      );
    }
    const { rows } = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM llm_usecase_assignments',
    );
    expect(rows[0]!.count).toBe(String(SURVIVING_USECASES.length));
  });
});
