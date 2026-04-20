import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 054 — multi LLM providers', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
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
});
