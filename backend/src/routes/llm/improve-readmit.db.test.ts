/**
 * #282 — a STORED improvement is re-admitted by reference before its text
 * is reused (`POST /llm/improvements/:id/readmit`), closing the reuse half
 * of the durable-provenance record (`improve-durable-output.db.test.ts`
 * pins the write half).
 *
 * A completed `llm_improvements` row can be applied to the article long
 * after the stream that produced it; markdown carries no proof of the
 * binding it was generated under. The readmit answers with the row's text
 * ONLY after its recorded provenance has been re-proved against the
 * provider the `chat` use case resolves to now — same provider, current
 * configuration revision and locality, every page at its recorded policy
 * and content revision, still readable by the caller. A row that cannot be
 * re-proved is 409 `ai_history_not_replayable`; an unknown row (truncated
 * stream, pre-migration, incomplete provenance) is refused the same way —
 * never backfilled from `page_id`.
 *
 * Real PostgreSQL, real Redis, real provider resolution; only the outbound
 * HTTP peer is synthetic. Every refusal is proven to cost NO provider call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { ArticleRouteFixture, sseEvents } from './article-route-test-fixture.js';
import { llmImproveRoutes } from './llm-improve.js';

vi.mock('../../core/services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [], wasModified: false })),
}));

const available = await isDbAvailable() && await isRedisAvailable();

describe.skipIf(!available)('POST /llm/improvements/:id/readmit re-admits a stored improvement by reference (#282)', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmImproveRoutes));
  afterAll(() => fixture.close());
  beforeEach(async () => { vi.clearAllMocks(); await fixture.reset(); });

  /** Run one Improve and return the id its final frame names. */
  async function improve(): Promise<string> {
    const response = await fixture.post('improve', { pageId: fixture.pageId, content: '<p>Original draft</p>', type: 'grammar' });
    expect(response.statusCode).toBe(200);
    const final = sseEvents(response.body).find((e) => e.final === true);
    expect(final).toBeDefined();
    expect(typeof final!.improvementId).toBe('string');
    expect(fixture.requests).toHaveLength(1);
    return final!.improvementId as string;
  }

  const readmit = (id: string) => fixture.app.inject({ method: 'POST', url: `/api/llm/improvements/${id}/readmit` });

  it('names the durable row on the final frame and re-admits it under the recorded binding without a provider call', async () => {
    const id = await improve();
    const stored = (await query<{ id: string; ai_provenance: unknown }>('SELECT id, ai_provenance FROM llm_improvements')).rows;
    expect(stored).toEqual([expect.objectContaining({ id })]);

    const response = await readmit(id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      improvementId: id,
      pageId: Number(fixture.pageId),
      improvedMarkdown: 'Improved text',
      aiProvenance: stored[0]!.ai_provenance,
    });
    expect(response.json().aiProvenance).toMatchObject({
      providerId: fixture.providerId, locality: 'external',
      pages: [expect.objectContaining({ pageId: Number(fixture.pageId), policy: 'all' })],
    });
    // Re-admission is a decision, never an inference.
    expect(fixture.requests).toHaveLength(1);
  });

  it('refuses with 409 once the page policy forbids the provider the row was generated under', async () => {
    const id = await improve();
    await query("UPDATE pages SET ai_policy = 'none', ai_policy_revision = ai_policy_revision + 1 WHERE id = $1", [Number(fixture.pageId)]);

    const refused = await readmit(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage: 'chat' });
    expect(fixture.requests).toHaveLength(1);
    // The row is untouched: not reusable NOW, not deleted or downgraded.
    expect((await query('SELECT status, ai_provenance_complete FROM llm_improvements WHERE id = $1', [id])).rows[0])
      .toEqual({ status: 'completed', ai_provenance_complete: true });
  });

  it('refuses with 409 once the article body moved past the recorded content revision', async () => {
    const id = await improve();
    await query("UPDATE pages SET body_text = 'Edited since', content_revision = content_revision + 1 WHERE id = $1", [Number(fixture.pageId)]);

    const refused = await readmit(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage: 'chat' });
    expect(fixture.requests).toHaveLength(1);
  });

  it('refuses with 409 once the provider configuration moved', async () => {
    const id = await improve();
    await query('UPDATE llm_providers SET base_url = $2 WHERE id = $1', [fixture.providerId, `${fixture.baseUrl}/moved`]);
    bumpProviderCacheVersion();

    const refused = await readmit(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage: 'chat' });
    expect(fixture.requests).toHaveLength(1);
  });

  it('refuses with 409 once the chat use case resolves to another provider', async () => {
    const id = await improve();
    const other = (await query<{ id: string }>(`INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
      VALUES ('Other provider', $1, 'none', 'm', FALSE) RETURNING id`, [`${fixture.baseUrl}/other`])).rows[0]!.id;
    await query("UPDATE llm_usecase_assignments SET provider_id = $1 WHERE usecase = 'chat'", [other]);
    bumpProviderCacheVersion();

    const refused = await readmit(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage: 'chat' });
    expect(fixture.requests).toHaveLength(1);
  });

  it('refuses a row whose stream never completed — unknown provenance is never backfilled from page_id', async () => {
    fixture.endWithoutDone = true;
    const response = await fixture.post('improve', { pageId: fixture.pageId, content: '<p>Original draft</p>', type: 'grammar' });
    expect(response.statusCode).toBe(200);
    const { id } = (await query<{ id: string; status: string }>('SELECT id, status FROM llm_improvements')).rows[0]!;
    expect((await query('SELECT status, ai_provenance_complete FROM llm_improvements WHERE id = $1', [id])).rows[0])
      .toEqual({ status: 'streaming', ai_provenance_complete: false });

    const refused = await readmit(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage: 'chat' });
    expect(fixture.requests).toHaveLength(1);
  });

  it('refuses a completed row whose provenance was lost or does not parse', async () => {
    const id = await improve();
    await query("UPDATE llm_improvements SET ai_provenance = '{\"version\": 1}'::jsonb WHERE id = $1", [id]);
    expect((await readmit(id)).statusCode).toBe(409);

    await query('UPDATE llm_improvements SET ai_provenance = NULL, ai_provenance_complete = FALSE, ai_provenance_version = NULL WHERE id = $1', [id]);
    const refused = await readmit(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'ai_history_not_replayable', stage: 'chat' });
    expect(fixture.requests).toHaveLength(1);
  });

  it("answers 404 for another user's row and for a row that does not exist", async () => {
    const id = await improve();
    const stranger = (await query<{ id: string }>("INSERT INTO users (username, password_hash, role) VALUES ('stranger', 'x', 'user') RETURNING id")).rows[0]!.id;
    await query('UPDATE llm_improvements SET user_id = $2 WHERE id = $1', [id, stranger]);
    expect((await readmit(id)).statusCode).toBe(404);
    expect((await readmit('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect(fixture.requests).toHaveLength(1);
  });
});
