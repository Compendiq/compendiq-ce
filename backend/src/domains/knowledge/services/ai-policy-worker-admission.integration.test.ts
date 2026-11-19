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
import { _resetAiPolicyActivationForTests, setAiPolicyEnforcementForTest } from '../../../core/services/ai-policy-activation.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadEnterprisePlugin, _resetForTesting } from '../../../core/enterprise/loader.js';
import { bumpProviderCacheVersion } from '../../llm/services/cache-bus.js';

const dbAvailable = await isDbAvailable();
let providerId: string;
let server: Server;
let baseUrl: string;
let calls = 0;
let enterprise = false;
import { generateKeyPairSync, sign } from 'node:crypto';

// Resolve the genuine plugin into the same Vitest graph as its license service.
// Variable paths keep this CE-owned test compilable without an EE overlay.
vi.mock('@compendiq/enterprise', async () => {
  const path = '../../../enterprise/plugin.js';
  try { return await import(path); }
  catch (error) {
    const { existsSync } = await import('node:fs');
    if (existsSync(new URL(path.replace('.js', '.ts'), import.meta.url))) throw error;
    const { noopPlugin } = await import('../../../core/enterprise/noop.js');
    return { default: noopPlugin };
  }
});
const licensePath = '../../../enterprise/license-service.js';
const keys = generateKeyPairSync('ed25519');

vi.mock('../../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn().mockImplementation((input: string) => ({ sanitized: input, wasSanitized: false })),
}));

vi.mock('../../../core/services/content-converter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/services/content-converter.js')>()),
  htmlToMarkdown: vi.fn().mockImplementation((html: string) => html),
}));

vi.mock('../../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: vi.fn(),
}));

const LONG = 'Lorem ipsum dolor sit amet. '.repeat(20);

describe.skipIf(!dbAvailable)('article AI policy — worker admission (SPEC-WORK-001)', () => {
  let userId: string;
  const spaceKey = 'TEST';

  beforeAll(async () => {
    await setupTestDb();
    server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        calls++;
        const content = '## Overall Quality Score: 75/100\n## Completeness: 80/100\n## Clarity: 70/100\n## Structure: 78/100\n## Accuracy: 72/100\n## Readability: 68/100\n## Summary\nDecent article.';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    _resetForTesting();
    enterprise = (await loadEnterprisePlugin()).version !== 'community';
  });

  beforeEach(async () => {
    await truncateAllTables();
    if (enterprise) {
      const license = await import(licensePath);
      license._resetLicenseStateForTesting();
      license._setVerificationKeyForTesting(keys.publicKey.export({ type: 'spki', format: 'pem' }));
      const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
      const issued = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      const payload = `CQEE1-enterprise-200-${expiry}-CPQabcdef12-paid-${issued}`;
      expect((await license.setLicenseKey(`${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString('base64url')}`)).isValid).toBe(true);
    }
    // The CE-owned switch (#1881) opens new tightening in both editions; the
    // licence above only exercises EE's own policy extensions.
    await setAiPolicyEnforcementForTest(true);
    calls = 0;
    const external = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
       VALUES ('external-box', $1, 'none', 'qwen3.5', TRUE) RETURNING id::text`, [baseUrl],
    );
    providerId = external.rows[0]!.id;
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
      VALUES ('summary', $1, 'qwen3.5'), ('quality', $1, 'qwen3.5')`, [providerId]);
    bumpProviderCacheVersion();
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
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    _resetAiPolicyActivationForTests();
    if (enterprise) {
      const license = await import(licensePath);
      await license.clearLicenseKey();
      license._resetLicenseStateForTesting();
      license._resetVerificationKeyForTesting();
    }
    _resetForTesting();
    await teardownTestDb();
  });

  async function restrictPage(page: number) {
    const result = await updatePageAiPolicies(userId, 'none', [{ pageId: page, expectedRevision: 0 }]);
    expect(result.ok).toBe(true);
  }

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
    expect(calls).toBe(1);

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
    calls = 0;
    expect(await runSummaryBatch('qwen3.5')).toEqual({ processed: 0, errors: 0 });
    expect(calls).toBe(0);
  });

  it('quality: a `local_only` page under an undeclared (external) provider is provider_not_local, re-checked once declared local', async () => {
    const page = await insertPage('lo1', 'local_only');

    expect(await processQualityBatch()).toEqual({ processed: 0, errors: 0 });
    expect(calls).toBe(0);
    let row = await query<{ quality_status: string; ai_policy_block_reason: string | null }>(
      'SELECT quality_status, ai_policy_block_reason FROM pages WHERE id = $1', [page],
    );
    expect(row.rows[0]).toEqual({ quality_status: 'policy_blocked', ai_policy_block_reason: 'provider_not_local' });
    expect((await getQualityStatus(userId)).policyBlockedPages).toBe(1);

    // Declare a real local provider at its current revision and point the
    // resolver at it: the per-pass re-check admits the page without a policy write.
    const prov = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, default_model) VALUES ('local-box', $1, 'none', 'qwen3.5') RETURNING id`, [baseUrl],
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
    await query("UPDATE llm_usecase_assignments SET provider_id = $1 WHERE usecase = 'quality'", [providerId]);
    bumpProviderCacheVersion();

    expect(await processQualityBatch()).toEqual({ processed: 1, errors: 0 });
    expect(calls).toBe(1);
    row = await query('SELECT quality_status, ai_policy_block_reason FROM pages WHERE id = $1', [page]);
    expect(row.rows[0]).toEqual({ quality_status: 'analyzed', ai_policy_block_reason: null });
  });

  it('a resolver naming a provider with no row refuses every page (even `all`) retryably: no call, no persisted block, row stays pending', async () => {
    const open = await insertPage('all-gone', 'all');
    const lo = await insertPage('lo-gone', 'local_only');
    const { getPool } = await import('../../../core/db/postgres.js');
    const { lockAiPolicyForPages } = await import('../../../core/services/ai-policy-service.js');
    const holder = await getPool().connect();
    await holder.query('BEGIN');
    await lockAiPolicyForPages(holder, [open, lo]);
    const summary = runSummaryBatch('qwen3.5');
    const quality = processQualityBatch();
    try {
      // Both workers have resolved the saved assignment and are waiting at
      // article admission, not merely queued before provider resolution.
      await vi.waitFor(async () => {
        const waiting = await query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory' AND pid <> pg_backend_pid()`);
        expect(waiting.rows[0]!.count).toBeGreaterThanOrEqual(2);
      }, { timeout: 10000 });
      await query('DELETE FROM llm_usecase_assignments WHERE provider_id = $1', [providerId]);
      await query(`DELETE FROM llm_providers WHERE id::text = $1`, [providerId]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await summary).toEqual({ processed: 0, errors: 0 });
    expect(await quality).toEqual({ processed: 0, errors: 0 });
    expect(calls).toBe(0);

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

    await restrictPage(page);

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
    calls = 0;
    expect(await runSummaryBatch('qwen3.5')).toEqual({ processed: 0, errors: 0 });
    expect(await processQualityBatch()).toEqual({ processed: 0, errors: 0 });
    expect(calls).toBe(0);
  });

  it('relaxing `none` → `all` re-queues every stage; the next pass regenerates', async () => {
    const page = await insertPage('relax1', 'all');
    await restrictPage(page);
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
    expect(calls).toBe(2);
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
