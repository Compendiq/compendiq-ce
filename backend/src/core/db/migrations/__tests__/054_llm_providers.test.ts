import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query, runMigrations } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

const migrationsDir = path.dirname(fileURLToPath(import.meta.url)) + path.sep + '..';

/**
 * Every migration that (re)writes `llm_usecase_assignments_usecase_check`.
 *
 * DISCOVERED, never listed. The CHECK is 054's inline column constraint, which
 * Postgres auto-names `<table>_<column>_check`, so widening it means dropping
 * and re-adding the WHOLE list — 090 added `rerank`, 093 added
 * `image_embedding`, and the next use case will do the same. The repair below
 * has to re-run all of them in order; re-running only the one that happened to
 * be current when this file was written leaves the constraint NARROWER than
 * the schema, which is the exact bug this comment used to describe for 090.
 */
function usecaseCheckMigrations(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      fs.readFileSync(path.join(migrationsDir, f), 'utf8').includes('llm_usecase_assignments_usecase_check'),
    )
    .sort();
}

/**
 * Undo the schema damage the pre-054 simulation cases below inflict on the
 * SHARED test database: force the affected migrations to re-run by deleting
 * their `_migrations` rows. Exported shape kept local — it is only ever the
 * cleanup, plus the regression test that pins it.
 */
async function repairSharedSchema(): Promise<void> {
  // Several cases below `DROP TABLE IF EXISTS llm_providers CASCADE` to
  // simulate the pre-054 world. That CASCADE also removes migration 087's
  // FK on llm_model_capabilities, and the runner will not rebuild it
  // because `_migrations` still lists 087 as applied — which silently
  // breaks every later CASCADE assertion against this shared test DB.
  // Force 087 to re-run so the constraint is back before the pool closes.
  await query(`DROP TABLE IF EXISTS llm_model_capabilities CASCADE`);
  // The same cases recreate llm_usecase_assignments from 054's original DDL,
  // silently reverting its usecase CHECK to the five original names (#1104 was
  // the first victim). Same fix, over every widener rather than a hardcoded
  // one — all of them are idempotent (`DROP CONSTRAINT IF EXISTS` + `ADD`).
  //
  // The rows go first: replaying the wideners in order means an OLDER one
  // briefly re-imposes its shorter list, and `ADD CONSTRAINT` validates
  // existing rows — so a row naming a use case a LATER migration introduced
  // aborts the replay. Content is not what this repairs, and every test file
  // seeds its own.
  await query(`TRUNCATE TABLE llm_usecase_assignments`);
  await query(`DELETE FROM _migrations WHERE name = ANY($1::text[])`, [
    ['087_llm_model_capabilities.sql', ...usecaseCheckMigrations()],
  ]);
  await runMigrations();
}

describe.skipIf(!dbAvailable)('Migration 054 — multi LLM providers', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => {
    await repairSharedSchema();
    await teardownTestDb();
  });
  beforeEach(async () => { await truncateAllTables(); });

  async function seedLegacy(rows: Record<string, string>) {
    for (const [k, v] of Object.entries(rows)) {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
        [k, v],
      );
    }
  }

  it('creates llm_providers and llm_usecase_assignments tables', async () => {
    const tables = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'
       AND tablename IN ('llm_providers','llm_usecase_assignments')`,
    );
    expect(tables.rows.map(r => r.tablename).sort()).toEqual(
      ['llm_providers', 'llm_usecase_assignments'],
    );
  });

  it('enforces single default via partial unique index', async () => {
    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='llm_providers'
         AND indexname='llm_providers_one_default'`,
    );
    expect(idx.rows).toHaveLength(1);
  });

  it('RESTRICTs delete of provider referenced by a use-case row', async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
       VALUES ('P1','http://x/v1','none',true,true) RETURNING id`,
    );
    const id = rows[0]!.id;
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
       VALUES ('chat', $1, 'm1')`,
      [id],
    );
    await expect(
      query(`DELETE FROM llm_providers WHERE id=$1`, [id]),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it('seeds OpenAI provider from legacy admin_settings (true pre-054 path)', async () => {
    // Re-create a true pre-054 state: the CREATE TABLE statements in 054 are
    // IF NOT EXISTS, so the tables still exist after truncate. Drop them so the
    // migration re-runs its full body against the seeded legacy data.
    await seedLegacy({
      llm_provider: 'openai',
      openai_base_url: 'https://api.openai.com',
      openai_model: 'gpt-4o-mini',
    });
    const sql = await (await import('node:fs')).promises.readFile(
      new URL('../054_llm_providers.sql', import.meta.url), 'utf8',
    );
    await query(`DROP TABLE IF EXISTS llm_usecase_assignments CASCADE`);
    await query(`DROP TABLE IF EXISTS llm_providers CASCADE`);
    await query(sql);
    const providers = await query<{ name: string; default_model: string | null; is_default: boolean }>(
      `SELECT name, default_model, is_default FROM llm_providers ORDER BY name`,
    );
    expect(providers.rows).toEqual([
      expect.objectContaining({ name: 'OpenAI', default_model: 'gpt-4o-mini', is_default: true }),
    ]);
    const keys = await query<{ setting_key: string }>(
      `SELECT setting_key FROM admin_settings
       WHERE setting_key IN ('llm_provider','openai_base_url','openai_model')`,
    );
    expect(keys.rows).toEqual([]);
  });

  it('seeds Ollama provider with sentinel when legacy ollama_model present', async () => {
    await truncateAllTables();
    await seedLegacy({ llm_provider: 'ollama', ollama_model: 'qwen3:4b' });
    const sql = await (await import('node:fs')).promises.readFile(
      new URL('../054_llm_providers.sql', import.meta.url), 'utf8',
    );
    // Each pre-054 case must drop the tables first to simulate the real path.
    await query(`DROP TABLE IF EXISTS llm_usecase_assignments CASCADE`);
    await query(`DROP TABLE IF EXISTS llm_providers CASCADE`);
    await query(sql);
    const p = await query<{ name: string; base_url: string; default_model: string; is_default: boolean }>(
      `SELECT name, base_url, default_model, is_default FROM llm_providers`,
    );
    expect(p.rows).toEqual([
      { name: 'Ollama', base_url: 'http://localhost:11434/v1', default_model: 'qwen3:4b', is_default: true },
    ]);
  });

  it('does NOT seed Ollama on OpenAI-only legacy installs', async () => {
    await truncateAllTables();
    await seedLegacy({ llm_provider: 'openai', openai_model: 'gpt-4o' });
    const sql = await (await import('node:fs')).promises.readFile(
      new URL('../054_llm_providers.sql', import.meta.url), 'utf8',
    );
    // Each pre-054 case must drop the tables first to simulate the real path.
    await query(`DROP TABLE IF EXISTS llm_usecase_assignments CASCADE`);
    await query(`DROP TABLE IF EXISTS llm_providers CASCADE`);
    await query(sql);
    const p = await query<{ name: string }>(`SELECT name FROM llm_providers`);
    expect(p.rows.map(r => r.name)).toEqual(['OpenAI']);
  });

  it('seeds use-case rows from legacy per-use-case keys', async () => {
    await truncateAllTables();
    await seedLegacy({
      llm_provider: 'ollama',
      ollama_model: 'qwen3:4b',
      openai_base_url: 'https://api.openai.com',
      openai_model: 'gpt-4o',
      llm_usecase_summary_provider: 'openai',
      llm_usecase_summary_model: 'gpt-4o-mini',
      embedding_model: 'bge-m3',
    });
    const sql = await (await import('node:fs')).promises.readFile(
      new URL('../054_llm_providers.sql', import.meta.url), 'utf8',
    );
    // Each pre-054 case must drop the tables first to simulate the real path.
    await query(`DROP TABLE IF EXISTS llm_usecase_assignments CASCADE`);
    await query(`DROP TABLE IF EXISTS llm_providers CASCADE`);
    await query(sql);
    const assigns = await query<{ usecase: string; provider_name: string | null; model: string | null }>(
      `SELECT a.usecase, p.name AS provider_name, a.model
       FROM llm_usecase_assignments a
       LEFT JOIN llm_providers p ON p.id = a.provider_id
       ORDER BY a.usecase`,
    );
    expect(assigns.rows).toEqual([
      { usecase: 'embedding', provider_name: 'Ollama', model: 'bge-m3' },
      { usecase: 'summary', provider_name: 'OpenAI', model: 'gpt-4o-mini' },
    ]);
  });

  it('repairs the usecase CHECK to the NEWEST widener, not to a hardcoded one', async () => {
    // The cases above leave the shared database carrying 054's original
    // five-name CHECK. The repair in `afterAll` has to put every later
    // widening migration back — if it re-runs only the one that was current
    // when it was written, the constraint ends up narrower than the schema
    // and the *next* test file to assert on a newer use case fails for a
    // reason that has nothing to do with it (093 hit exactly this).
    const wideners = usecaseCheckMigrations();
    expect(wideners.length).toBeGreaterThan(1); // 090 and 093 today

    // Names the newest widener admits — read from the migration rather than
    // listed here, so a future widener is covered without editing this test.
    const newest = fs.readFileSync(path.join(migrationsDir, wideners[wideners.length - 1]!), 'utf8');
    const listed = /CHECK\s*\(\s*usecase\s+IN\s*\(([^)]*)\)/i.exec(newest);
    expect(listed).not.toBeNull();
    const expected = [...listed![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(expected).toContain('image_embedding');
    expect(expected).toContain('inline_completion');

    // Revert to 054's inline five — exactly the end state the pre-054 cases
    // above produce by recreating the table from 054's own DDL.
    await query(`ALTER TABLE llm_usecase_assignments DROP CONSTRAINT IF EXISTS llm_usecase_assignments_usecase_check`);
    await query(
      `ALTER TABLE llm_usecase_assignments ADD CONSTRAINT llm_usecase_assignments_usecase_check
         CHECK (usecase IN ('chat','summary','quality','auto_tag','embedding'))`,
    );

    await repairSharedSchema();

    for (const usecase of expected) {
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ($1, NULL, 'm')`,
        [usecase],
      );
    }
    const { rows } = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM llm_usecase_assignments',
    );
    expect(rows[0]!.count).toBe(String(expected.length));
    await expect(
      query(`INSERT INTO llm_usecase_assignments (usecase) VALUES ('bogus')`),
    ).rejects.toThrow();
  });
});
