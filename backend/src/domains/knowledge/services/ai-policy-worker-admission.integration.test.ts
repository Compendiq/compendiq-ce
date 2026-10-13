/**
 * SPEC-WORK-001 — article AI policy in the background workers, against real
 * Postgres. The provider seam is mocked so the ONE thing each test proves is
 * observable: a blocked page makes zero provider calls, lands on
 * `policy_blocked` with its reason, counts as neither processed nor failed,
 * and comes back only through the policy write (or, for a `provider_not_local`
 * block, through the per-pass re-check).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { runSummaryBatch, stopSummaryWorker, getSummaryStatus } from './summary-worker.js';
import { processBatch as processQualityBatch, getQualityStatus, stopQualityWorker } from './quality-worker.js';
import { updatePageAiPolicies, purgeDerivedAiStateForPages } from '../../../core/services/ai-policy-service.js';
import { streamChat } from '../../llm/services/openai-compatible-client.js';

const dbAvailable = await isDbAvailable();

const mocks = vi.hoisted(() => ({
  providerId: 'p1',
  enforcement: true,
}));

vi.mock('../../llm/services/openai-compatible-client.js', () => ({
  streamChat: vi.fn().mockImplementation(() => {
    async function* generator() {
      yield {
        content: `## Overall Quality Score: 75/100\n## Completeness: 80/100\n## Clarity: 70/100\n## Structure: 78/100\n## Accuracy: 72/100\n## Readability: 68/100\n## Summary\nDecent article.`,
        done: false,
      };
      yield { content: '', done: true };
    }
    return generator();
  }),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

vi.mock('../../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn().mockImplementation((input: string) => ({ sanitized: input, wasSanitized: false })),
}));

vi.mock('../../../core/services/content-converter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/services/content-converter.js')>()),
  htmlToMarkdown: vi.fn().mockImplementation((html: string) => html),
}));

vi.mock('../../llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn().mockImplementation(async () => ({
    config: {
      providerId: mocks.providerId, id: mocks.providerId, name: 'X',
      baseUrl: 'http://x/v1', apiKey: null,
      authType: 'none', verifySsl: true, defaultModel: 'qwen3.5',
    },
    model: 'qwen3.5',
  })),
}));

vi.mock('../../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: vi.fn(),
}));

// The policy write refuses restrictive policies on a foundation-only
// deployment; these tests ARE the enforcement, so the hook answers true.
vi.mock('../../../core/enterprise/loader.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../core/enterprise/loader.js')>();
  return {
    ...original,
    getEnterprisePlugin: () => ({
      ...original.getEnterprisePlugin(),
      aiPolicyEnforcementAvailable: () => mocks.enforcement,
    }),
  };
});

const LONG = 'Lorem ipsum dolor sit amet. '.repeat(20);

describe.skipIf(!dbAvailable)('article AI policy — worker admission (SPEC-WORK-001)', () => {
  let userId: string;
  const spaceKey = 'TEST';

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    vi.mocked(streamChat).mockClear();
    // The resolver names a REAL (undeclared, hence external) provider row:
    // admission fails closed on a provider it cannot describe, so a
    // fabricated id would admit nothing — not even `all` pages.
    const external = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url) VALUES ('external-box', 'http://x/v1') RETURNING id::text`,
    );
    mocks.providerId = external.rows[0]!.id;
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
        ('system_admin', 'System Administrator', TRUE, ARRAY['read','comment','edit','delete','manage','admin']),
        ('editor', 'Editor', TRUE, ARRAY['read','comment','edit','delete'])
       ON CONFLICT (name) DO NOTHING`,
    );
    const u = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('policyuser', 'fakehash', 'admin') RETURNING id",
    );
    userId = u.rows[0]!.id;
    await query("INSERT INTO spaces (space_key, space_name) VALUES ($1, 'Test Space')", [spaceKey]);
    const role = await query<{ id: number }>("SELECT id FROM roles WHERE name = 'system_admin' LIMIT 1");
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3) ON CONFLICT DO NOTHING`,
      [spaceKey, userId, role.rows[0]!.id],
    );
  });

  afterAll(async () => {
    stopSummaryWorker();
    stopQualityWorker();
    await teardownTestDb();
  });

  async function insertPage(confluenceId: string, policy: 'all' | 'local_only' | 'none'): Promise<number> {
    const r = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_html, body_text, summary_status, quality_status, ai_policy)
       VALUES ($1, $2, $3, $4, $4, 'pending', 'pending', $5) RETURNING id`,
      [confluenceId, spaceKey, `Page ${confluenceId}`, LONG, policy],
    );
    return r.rows[0]!.id;
  }

  it('summary: a `none` page makes no provider call, parks as policy_blocked, counts as neither processed nor error', async () => {
    const blocked = await insertPage('none1', 'none');
    const open = await insertPage('all1', 'all');

    expect(await runSummaryBatch('qwen3.5')).toEqual({ processed: 1, errors: 0 });
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1);

    const rows = await query<{ id: number; summary_status: string; ai_policy_block_reason: string | null }>(
      'SELECT id, summary_status, ai_policy_block_reason FROM pages ORDER BY id',
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(blocked)).toMatchObject({ summary_status: 'policy_blocked', ai_policy_block_reason: 'policy_none' });
    expect(byId.get(open)).toMatchObject({ summary_status: 'summarized' });

    const status = await getSummaryStatus(userId);
    expect(status.policyBlockedPages).toBe(1);
    expect(status.pendingPages).toBe(0);
    expect(status.failedPages).toBe(0);

    // Parked rows leave the work window: a second pass spends no call on them.
    vi.mocked(streamChat).mockClear();
    expect(await runSummaryBatch('qwen3.5')).toEqual({ processed: 0, errors: 0 });
    expect(vi.mocked(streamChat)).not.toHaveBeenCalled();
  });

  it('quality: a `local_only` page under an undeclared (external) provider is provider_not_local, re-checked once declared local', async () => {
    const page = await insertPage('lo1', 'local_only');

    expect(await processQualityBatch()).toEqual({ processed: 0, errors: 0 });
    expect(vi.mocked(streamChat)).not.toHaveBeenCalled();
    let row = await query<{ quality_status: string; ai_policy_block_reason: string | null }>(
      'SELECT quality_status, ai_policy_block_reason FROM pages WHERE id = $1', [page],
    );
    expect(row.rows[0]).toEqual({ quality_status: 'policy_blocked', ai_policy_block_reason: 'provider_not_local' });
    expect((await getQualityStatus(userId)).policyBlockedPages).toBe(1);

    // Declare a real local provider at its current revision and point the
    // resolver at it: the per-pass re-check admits the page without a policy write.
    const prov = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url) VALUES ('local-box', 'http://local/v1') RETURNING id`,
    );
    const providerId = prov.rows[0]!.id;
    // A declaration is only meaningful with its time and the revision it was
    // made against (migration 135's check) — one statement, like the route.
    await query(
      `UPDATE llm_providers
          SET locality = 'local', locality_declared_at = NOW(), locality_declared_by = $2,
              locality_config_revision = config_revision
        WHERE id = $1`,
      [providerId, userId],
    );
    mocks.providerId = providerId;

    expect(await processQualityBatch()).toEqual({ processed: 1, errors: 0 });
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1);
    row = await query('SELECT quality_status, ai_policy_block_reason FROM pages WHERE id = $1', [page]);
    expect(row.rows[0]).toEqual({ quality_status: 'analyzed', ai_policy_block_reason: null });
  });

  it('a resolver naming a provider with no row refuses every page (even `all`) retryably: no call, no persisted block, row stays pending', async () => {
    const open = await insertPage('all-gone', 'all');
    const lo = await insertPage('lo-gone', 'local_only');
    await query(`DELETE FROM llm_providers WHERE id::text = $1`, [mocks.providerId]);

    expect(await runSummaryBatch('qwen3.5')).toEqual({ processed: 0, errors: 0 });
    expect(await processQualityBatch()).toEqual({ processed: 0, errors: 0 });
    expect(vi.mocked(streamChat)).not.toHaveBeenCalled();

    const rows = await query<{ id: number; summary_status: string; quality_status: string; ai_policy_block_reason: string | null }>(
      'SELECT id, summary_status, quality_status, ai_policy_block_reason FROM pages ORDER BY id',
    );
    for (const id of [open, lo]) {
      expect(rows.rows.find((r) => r.id === id)).toEqual({
        id, summary_status: 'pending', quality_status: 'pending', ai_policy_block_reason: null,
      });
    }
  });

  it('policy write to `none` purges every derived artefact in the same transaction and keeps the body', async () => {
    const page = await insertPage('purge1', 'all');
    await runSummaryBatch('qwen3.5');
    await processQualityBatch();
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, 'chunk', $2::vector, '{}'::jsonb)`,
      [page, `[${new Array(1024).fill(0.1).join(',')}]`],
    );
    await query(`UPDATE pages SET page_avg_embedding = (SELECT embedding FROM page_embeddings WHERE page_id = $1) WHERE id = $1`, [page]);
    await query(
      // An analyzed row carries its identity hash and both versions (migration 115's CHECK).
      `INSERT INTO page_image_analyses
         (page_id, source, attachment_key, content_hash, format, status, payload,
          identity_hash, prompt_version, schema_version, analyzed_at)
       VALUES ($1, 'local', 'a.png', 'h', 'png', 'analyzed', '{"k":1}'::jsonb, 'idh', 1, 1, NOW())`,
      [page],
    );
    const before = await query<{ summary_text: string | null; quality_score: number | null }>(
      'SELECT summary_text, quality_score FROM pages WHERE id = $1', [page],
    );
    expect(before.rows[0]!.summary_text).not.toBeNull();
    expect(before.rows[0]!.quality_score).not.toBeNull();

    const res = await updatePageAiPolicies(userId, 'none', [{ pageId: page, expectedRevision: 0 }]);
    expect(res.ok).toBe(true);

    const after = await query<Record<string, unknown>>(
      `SELECT body_html, summary_text, summary_html, summary_status, quality_score, quality_status,
              embedding_status, page_avg_embedding, ai_policy_block_reason,
              (SELECT COUNT(*)::int FROM page_embeddings WHERE page_id = $1) AS vectors,
              (SELECT status FROM page_image_analyses WHERE page_id = $1) AS image_status,
              (SELECT payload FROM page_image_analyses WHERE page_id = $1) AS image_payload
         FROM pages WHERE id = $1`,
      [page],
    );
    expect(after.rows[0]).toMatchObject({
      body_html: LONG,
      summary_text: null,
      summary_html: null,
      summary_status: 'policy_blocked',
      quality_score: null,
      quality_status: 'policy_blocked',
      embedding_status: 'policy_blocked',
      page_avg_embedding: null,
      ai_policy_block_reason: 'policy_none',
      vectors: 0,
      image_status: 'policy_blocked',
      image_payload: null,
    });

    // Nothing re-queues it: a pass over the corpus spends no call.
    vi.mocked(streamChat).mockClear();
    expect(await runSummaryBatch('qwen3.5')).toEqual({ processed: 0, errors: 0 });
    expect(await processQualityBatch()).toEqual({ processed: 0, errors: 0 });
    expect(vi.mocked(streamChat)).not.toHaveBeenCalled();
  });

  it('relaxing `none` → `all` re-queues every stage; the next pass regenerates', async () => {
    const page = await insertPage('relax1', 'all');
    await updatePageAiPolicies(userId, 'none', [{ pageId: page, expectedRevision: 0 }]);
    const res = await updatePageAiPolicies(userId, 'all', [{ pageId: page, expectedRevision: 1 }]);
    expect(res.ok).toBe(true);

    const row = await query<Record<string, unknown>>(
      `SELECT summary_status, quality_status, embedding_status, embedding_dirty, image_analysis_dirty, ai_policy_block_reason
         FROM pages WHERE id = $1`, [page],
    );
    expect(row.rows[0]).toEqual({
      summary_status: 'pending',
      quality_status: 'pending',
      embedding_status: 'not_embedded',
      embedding_dirty: true,
      image_analysis_dirty: true,
      ai_policy_block_reason: null,
    });

    expect(await runSummaryBatch('qwen3.5')).toEqual({ processed: 1, errors: 0 });
    expect(await processQualityBatch()).toEqual({ processed: 1, errors: 0 });
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(2);
  });

  it('ingestion purge entrypoint behaves like the policy write for a label-tightened page', async () => {
    const page = await insertPage('ing1', 'all');
    await runSummaryBatch('qwen3.5');
    await query(`UPDATE pages SET ai_policy = 'none' WHERE id = $1`, [page]);
    await purgeDerivedAiStateForPages([page]);
    const row = await query<{ summary_text: string | null; summary_status: string; body_text: string }>(
      'SELECT summary_text, summary_status, body_text FROM pages WHERE id = $1', [page],
    );
    expect(row.rows[0]).toEqual({ summary_text: null, summary_status: 'policy_blocked', body_text: LONG });
  });
});
