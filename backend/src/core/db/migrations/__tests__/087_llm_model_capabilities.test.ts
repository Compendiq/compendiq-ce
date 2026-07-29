import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 087 — llm_model_capabilities', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  async function seedProvider(name: string): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
       VALUES ($1,'http://x/v1','none',true,false) RETURNING id`,
      [name],
    );
    return rows[0]!.id;
  }

  it('creates the table', async () => {
    const { rows } = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname='public' AND tablename='llm_model_capabilities'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('allows vision to be NULL, meaning unknown', async () => {
    const id = await seedProvider('P1');
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probe_error)
       VALUES ($1,'mystery',NULL,'connect ECONNREFUSED')`,
      [id],
    );
    const { rows } = await query<{ vision: boolean | null; probe_error: string }>(
      `SELECT vision, probe_error FROM llm_model_capabilities WHERE provider_id=$1`,
      [id],
    );
    expect(rows[0]!.vision).toBeNull();
    expect(rows[0]!.probe_error).toBe('connect ECONNREFUSED');
  });

  it('keys on (provider_id, model) so one host can serve both kinds', async () => {
    const id = await seedProvider('P1');
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision)
       VALUES ($1,'qwen2.5vl',true), ($1,'llama3.1',false)`,
      [id],
    );
    const { rows } = await query<{ model: string; vision: boolean }>(
      `SELECT model, vision FROM llm_model_capabilities
       WHERE provider_id=$1 ORDER BY model`,
      [id],
    );
    expect(rows).toEqual([
      { model: 'llama3.1', vision: false },
      { model: 'qwen2.5vl', vision: true },
    ]);
  });

  it('rejects a duplicate (provider_id, model)', async () => {
    const id = await seedProvider('P1');
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision) VALUES ($1,'m',true)`,
      [id],
    );
    await expect(query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision) VALUES ($1,'m',false)`,
      [id],
    )).rejects.toThrow();
  });

  /**
   * CASCADE, unlike llm_usecase_assignments' RESTRICT: capability is derived
   * data, so it should vanish with its provider rather than block the delete.
   */
  it('CASCADEs on provider delete', async () => {
    const id = await seedProvider('P1');
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision) VALUES ($1,'m',true)`,
      [id],
    );
    await query(`DELETE FROM llm_providers WHERE id=$1`, [id]);
    const { rows } = await query(`SELECT 1 FROM llm_model_capabilities WHERE provider_id=$1`, [id]);
    expect(rows).toHaveLength(0);
  });
});
