/**
 * #282 — a completed Improve row is REUSABLE STATE and retains the exact
 * server-captured provenance it was generated under.
 *
 * The row's text can be applied to the article later, so the row must say
 * what it was fed: provider, configuration revision, effective locality and
 * every page with its policy + content revision (migration 150). The write
 * runs inside the article-stage admission on the held client, so
 * `ai_provenance_complete` is TRUE only for output whose binding was
 * re-proved at publication; a truncated stream or a binding that moved
 * during generation leaves the row unknown — never a partial certification.
 *
 * Real PostgreSQL, real Redis, real provider resolution; only the outbound
 * HTTP peer is synthetic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { ArticleRouteFixture, sseEvents } from './article-route-test-fixture.js';
import { llmImproveRoutes } from './llm-improve.js';

vi.mock('../../core/services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [], wasModified: false })),
}));

const available = await isDbAvailable() && await isRedisAvailable();

interface DurableRow {
  improved_content: string;
  status: string;
  ai_provenance: Record<string, unknown> | null;
  ai_provenance_complete: boolean;
  ai_provenance_version: number | null;
}

describe.skipIf(!available)('Improve retains durable transitive provenance on the completed row (#282)', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmImproveRoutes));
  afterAll(() => fixture.close());
  beforeEach(async () => { vi.clearAllMocks(); await fixture.reset(); });

  const post = () => fixture.post('improve', { pageId: fixture.pageId, content: '<p>Original draft</p>', type: 'grammar' });
  const rows = () => query<DurableRow>(
    'SELECT improved_content, status, ai_provenance, ai_provenance_complete, ai_provenance_version FROM llm_improvements',
  );

  it('stores the entire completed output beside the exact provenance the dispatch was admitted under', async () => {
    fixture.output = `${'Long output '.repeat(2000)}END OF OUTPUT`;
    const page = (await query<{ ai_policy_revision: string | number; content_revision: string | number }>(
      'SELECT ai_policy_revision, content_revision FROM pages WHERE id = $1', [Number(fixture.pageId)],
    )).rows[0]!;
    const provider = (await query<{ config_revision: string | number }>(
      'SELECT config_revision FROM llm_providers WHERE id = $1', [fixture.providerId],
    )).rows[0]!;

    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(1);
    expect(sseEvents(response.body).some((e) => e.final === true)).toBe(true);

    const stored = (await rows()).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      improved_content: fixture.output,
      status: 'completed',
      ai_provenance_complete: true,
      ai_provenance_version: 1,
      ai_provenance: {
        version: 1,
        providerId: fixture.providerId,
        configRevision: Number(provider.config_revision),
        // The fixture provider carries no accountable local declaration.
        locality: 'external',
        pages: [{
          pageId: Number(fixture.pageId), policy: 'all',
          policyRevision: Number(page.ai_policy_revision), contentRevision: Number(page.content_revision),
        }],
      },
    });
    // Exactly one grounding page: the row names nothing it was not fed.
    expect((stored[0]!.ai_provenance as { pages: unknown[] }).pages).toHaveLength(1);

    // The durable row and the cache entry describe the same generation.
    const keys = await fixture.redis.keys('kb:llm:*');
    expect(keys).toHaveLength(1);
    const cached = JSON.parse((await fixture.redis.get(keys[0]!))!) as { aiProvenance: unknown };
    expect(stored[0]!.ai_provenance).toEqual(cached.aiProvenance);
  });

  it('a stream that ends without [DONE] certifies nothing', async () => {
    fixture.endWithoutDone = true;
    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(1);
    expect((await rows()).rows).toEqual([{
      improved_content: '', status: 'streaming',
      ai_provenance: null, ai_provenance_complete: false, ai_provenance_version: null,
    }]);
    expect(await fixture.redis.keys('kb:llm:*')).toEqual([]);
  });

  it('a binding that moved during generation leaves the row unknown rather than partially certified', async () => {
    // The provider answers only after the page policy has been tightened
    // underneath the in-flight request; the delta streams (the dispatch was
    // admitted under the old binding) but the completed-row write is
    // re-admitted on the held client and refused.
    let tightened: Promise<unknown> | null = null;
    const onArrival = (request: import('node:http').IncomingMessage) => {
      request.pause();
      tightened = query(
        "UPDATE pages SET ai_policy = 'none', ai_policy_revision = ai_policy_revision + 1 WHERE id = $1",
        [Number(fixture.pageId)],
      ).finally(() => request.resume());
    };
    fixture.server.prependListener('request', onArrival);
    try {
      const response = await post();
      expect(response.statusCode).toBe(200);
      expect(tightened).not.toBeNull();
      await tightened;
      expect(fixture.requests).toHaveLength(1);
      expect((await rows()).rows).toEqual([{
        improved_content: '', status: 'streaming',
        ai_provenance: null, ai_provenance_complete: false, ai_provenance_version: null,
      }]);
    } finally {
      fixture.server.removeListener('request', onArrival);
    }
  });
});
