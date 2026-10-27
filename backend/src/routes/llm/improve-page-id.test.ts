import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { ArticleRouteFixture, sseEvents } from './article-route-test-fixture.js';
import { llmImproveRoutes } from './llm-improve.js';

const mockEmitLlmAudit = vi.fn();
vi.mock('../../domains/llm/services/llm-audit-hook.js', async (importActual) => ({
  ...await importActual<typeof import('../../domains/llm/services/llm-audit-hook.js')>(),
  emitLlmAudit: (...args: unknown[]) => mockEmitLlmAudit(...args),
}));
const available = await isDbAvailable() && await isRedisAvailable();
describe.skipIf(!available)('Improve page identity and persisted results', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmImproveRoutes));
  afterAll(() => fixture.close());
  beforeEach(async () => { await fixture.reset(); vi.clearAllMocks(); });
  const post = (payload: Record<string, unknown> = {}) => fixture.post('improve', {
    pageId: fixture.pageId, content: '<p>Original content</p>', type: 'grammar', model: 'ignored-body-model', ...payload,
  });
  const improvements = () => query('SELECT user_id, page_id, improvement_type, model, original_content, improved_content, status FROM llm_improvements');

  it('first click resolves the external reference and persists its internal page_id', async () => {
    const response = await post({ pageId: 'conf-123' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect((await improvements()).rows).toEqual([expect.objectContaining({
      page_id: Number(fixture.pageId), improved_content: 'Improved text', status: 'completed',
    })]);
  });
  it('resolves numeric IDs internally before trying a colliding external reference', async () => {
    await query(`INSERT INTO pages (title, source, visibility, created_by_user_id, confluence_id)
      VALUES ('Other article', 'standalone', 'private', $1, $2)`, [fixture.userId, fixture.pageId]);
    expect((await post()).statusCode).toBe(200);
    expect((await improvements()).rows[0]!.page_id).toBe(Number(fixture.pageId));
  });
  it('persists and audits the saved provider/model, not the request override', async () => {
    await query("UPDATE llm_usecase_assignments SET model = 'resolved-model' WHERE usecase = 'chat'");
    bumpProviderCacheVersion();
    expect((await post()).statusCode).toBe(200);
    expect((await improvements()).rows).toEqual([{
      user_id: fixture.userId, page_id: Number(fixture.pageId), improvement_type: 'grammar',
      model: 'resolved-model', original_content: '<p>Original content</p>', improved_content: 'Improved text', status: 'completed',
    }]);
    expect(fixture.requests[0]!.model).toBe('resolved-model');
    expect(mockEmitLlmAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'improve', model: 'resolved-model', provider: fixture.providerId,
    }));
  });
  it('unsynced references fail closed without persistence or provider bytes', async () => {
    expect((await post({ pageId: 'conf-not-synced' })).statusCode).toBe(404);
    expect((await improvements()).rows).toHaveLength(0);
    expect(fixture.requests).toHaveLength(0);
  });
  it('echoes the original markdown in the final SSE event', async () => {
    const response = await post({ content: '<h1>Heading</h1><p>Original markdown body</p>' });
    expect(response.statusCode).toBe(200);
    expect(sseEvents(response.body).find((e) => e.final)).toMatchObject({ originalMarkdown: '# Heading\n\nOriginal markdown body' });
  });
  it('cached responses also echo the original markdown and avoid a second call', async () => {
    const payload = { content: '<h1>Heading</h1><p>Original markdown body</p>' };
    fixture.output = 'cached improved markdown';
    expect((await post(payload)).statusCode).toBe(200);
    const response = await post(payload);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(sseEvents(response.body).find((e) => e.final)).toMatchObject({ originalMarkdown: '# Heading\n\nOriginal markdown body' });
    expect(response.body).toContain('cached improved markdown');
    expect(fixture.requests).toHaveLength(1);
  });
  it('missing mandatory identity creates no improvement and sends no bytes', async () => {
    expect((await post({ pageId: undefined })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await improvements()).rows).toHaveLength(0);
    expect(fixture.requests).toHaveLength(0);
  });
  it('unreadable private identity creates no improvement and sends no bytes', async () => {
    await query('UPDATE pages SET created_by_user_id = NULL WHERE id = $1', [fixture.pageId]);
    expect((await post()).statusCode).toBe(404);
    expect((await improvements()).rows).toHaveLength(0);
    expect(fixture.requests).toHaveLength(0);
  });
});
