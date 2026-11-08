import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { recoverPolicyBlockedStage } from './ai-policy-worker-recovery.js';

const available = await isDbAvailable();
describe.skipIf(!available)('stage-owned policy recovery', () => {
  beforeAll(() => setupTestDb(), 30000);
  beforeEach(() => truncateAllTables());
  afterAll(() => teardownTestDb());
  it('filters eligibility before the limit and does not depend on another stage clearing the shared reason', async () => {
    const provider = (await query<{ id: string }>(`INSERT INTO llm_providers(name,base_url,auth_type)
      VALUES ('external','http://external/v1','none') RETURNING id`)).rows[0]!.id;
    await query(`INSERT INTO pages(title,source,ai_policy,summary_status,quality_status,embedding_status)
      SELECT 'blocked', 'standalone', 'local_only', 'policy_blocked', 'policy_blocked', 'policy_blocked'
      FROM generate_series(1, 120)`);
    const page = (await query<{ id: number }>(`INSERT INTO pages(title,source,ai_policy,summary_status,quality_status,embedding_status,ai_policy_block_reason)
      VALUES ('recover','standalone','all','policy_blocked','policy_blocked','policy_blocked',NULL) RETURNING id`)).rows[0]!.id;
    await query(`INSERT INTO page_image_analyses(page_id,source,attachment_key,content_hash,format,status,ai_policy_block_reason)
      SELECT id,'local','image.png','hash','png','policy_blocked','provider_not_local' FROM pages`);
    for (const stage of ['summary', 'quality', 'embedding', 'image_analysis'] as const) {
      expect(await recoverPolicyBlockedStage(stage, provider, 1)).toBe(1);
      expect(await recoverPolicyBlockedStage(stage, provider, 1)).toBe(0);
    }
    expect((await query('SELECT summary_status,quality_status,embedding_status,embedding_dirty FROM pages WHERE id=$1', [page])).rows[0])
      .toMatchObject({ summary_status: 'pending', quality_status: 'pending', embedding_status: 'not_embedded', embedding_dirty: true });
    expect((await query(`SELECT count(*)::int AS n FROM page_image_analyses WHERE status='policy_blocked'`)).rows[0]!.n).toBe(120);
  });
});
