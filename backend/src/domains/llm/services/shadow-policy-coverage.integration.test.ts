import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { getShadowMigrationStatus, performShadowSwap, rollbackShadowMigration, SHADOW_MIGRATION_STATE_KEY } from './shadow-migration-service.js';

const available = await isDbAvailable();
describe.skipIf(!available)('shadow current-policy coverage gates', () => {
  beforeAll(() => setupTestDb(), 30000);
  beforeEach(async () => {
    await truncateAllTables();
    await query('ALTER TABLE page_embeddings ADD COLUMN IF NOT EXISTS embedding_next vector(1024)');
    await query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_avg_embedding_next vector(1024)');
  });
  afterEach(async () => {
    await query('ALTER TABLE page_embeddings DROP COLUMN IF EXISTS embedding_next');
    await query('ALTER TABLE pages DROP COLUMN IF EXISTS page_avg_embedding_next');
  });
  afterAll(() => teardownTestDb());
  async function seed(withVectors: boolean, swapped = false) {
    const user = (await query<{ id: string }>(`INSERT INTO users(username,password_hash,role) VALUES ('admin','x','admin') RETURNING id`)).rows[0]!.id;
    const provider = (await query<{ id: string }>(`INSERT INTO llm_providers(name,base_url,auth_type,is_default) VALUES ('candidate','http://candidate/v1','none',true) RETURNING id`)).rows[0]!.id;
    await query(`UPDATE llm_providers SET locality='local', locality_declared_by=$2, locality_declared_at=NOW(), locality_config_revision=config_revision WHERE id=$1`, [provider, user]);
    const page = (await query<{ id: number }>(`INSERT INTO pages(title,body_text,body_html,source,ai_policy)
      VALUES ('private title','long enough authored content for embedding','<p>long enough authored content for embedding</p>','standalone','local_only') RETURNING id`)).rows[0]!.id;
    if (withVectors) await query(`INSERT INTO page_embeddings(page_id,chunk_index,chunk_text,embedding,embedding_next)
      VALUES ($1,0,'text',$2::vector,$2::vector)`, [page, JSON.stringify(new Array(1024).fill(0.1))]);
    await query(`INSERT INTO admin_settings(setting_key,setting_value) VALUES ($1,$2)`, [SHADOW_MIGRATION_STATE_KEY,
      JSON.stringify({ status: swapped ? 'swapped' : 'active', providerId: provider, model: 'candidate', dimensions: 2,
        columnType: 'vector(1024)', indexed: false, startedAt: new Date().toISOString(),
        ...(swapped ? { prev: { providerId: provider, model: 'old', dimensions: 1024 } } : {}) })]);
    return provider;
  }
  it.each([true, false])('refuses external candidate with filled-vectors=%s', async (withVectors) => {
    const provider = await seed(withVectors);
    await query(`UPDATE llm_providers SET locality='external' WHERE id=$1`, [provider]);
    expect(await getShadowMigrationStatus()).toMatchObject({ phase: 'backfilling', policyBlockedPages: 1 });
    await expect(performShadowSwap()).rejects.toThrow(/1 blocked by article AI policy/);
  });
  it('refuses rollback to a now-external previous provider before any rename', async () => {
    const provider = await seed(false, true);
    await query(`UPDATE llm_providers SET locality='external' WHERE id=$1`, [provider]);
    await expect(rollbackShadowMigration()).rejects.toThrow(/1 pages blocked by article AI policy/);
    expect((await query(`SELECT setting_value::jsonb->>'status' AS status FROM admin_settings WHERE setting_key=$1`, [SHADOW_MIGRATION_STATE_KEY])).rows[0]!.status).toBe('swapped');
  });
});
