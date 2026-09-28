/**
 * Page restrictions (`inherit_perms = FALSE` + page ACEs) on the LLM-adjacent
 * and worker-status read surfaces, against real PostgreSQL, Redis and RBAC.
 *
 * R holds a DOCS role and no ACE; G reads the restricted pages through a group
 * ACE; the administrator sees restricted pages but not R's private note. Only
 * the LLM and embedding provider boundaries are replaced.
 */
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { getSyncOverview } from '../../domains/confluence/services/sync-overview-service.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { knowledgeAdminRoutes } from '../knowledge/knowledge-admin.js';
import {
  RESTRICTED_TITLES,
  restrictedLeaks,
  seedRestrictionFixture,
  type RestrictionFixture,
} from '../knowledge/page-restriction.test-helpers.js';
import { buildKnowledgeTestApp } from '../knowledge/pages.test-helpers.js';
import { llmConversationRoutes } from './llm-conversations.js';
import { llmEmbeddingRoutes } from './llm-embeddings.js';
import { llmImproveRoutes } from './llm-improve.js';

const provider = vi.hoisted(() => ({ prompts: [] as string[] }));

vi.mock('../../domains/llm/services/llm-provider-resolver.js', async (importActual) => ({
  ...(await importActual<typeof import('../../domains/llm/services/llm-provider-resolver.js')>()),
  resolveUsecase: async () => ({
    config: {
      providerId: 'fixture-provider', id: 'fixture-provider', name: 'Fixture',
      baseUrl: 'http://127.0.0.1:9/v1', apiKey: null, authType: 'none',
      verifySsl: true, defaultModel: 'fixture-model',
    },
    model: 'fixture-model',
  }),
}));

vi.mock('../../domains/llm/services/openai-compatible-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../domains/llm/services/openai-compatible-client.js')>()),
  // Every page the embedding worker touches fails, so each one lands in the
  // streamed progress events AND in the terminal error list.
  generateEmbedding: async () => {
    throw new Error('embedding provider unreachable');
  },
  streamChat: (_config: unknown, _model: string, messages: unknown) => {
    provider.prompts.push(JSON.stringify(messages));
    return (async function* () {
      yield { content: 'Improved.', done: true };
    })();
  },
}));

const available = await isDbAvailable() && await isRedisAvailable();

async function flushRedis(redis: RedisClientType): Promise<void> {
  for (const pattern of ['kb:*', 'kb-cache-generation:*', 'rbac:*']) {
    let cursor = '0';
    do {
      const scanned = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 });
      cursor = String(scanned.cursor);
      if (scanned.keys.length > 0) await redis.del(scanned.keys);
    } while (cursor !== '0');
  }
}

type SseEvent = Record<string, unknown>;

function sseEvents(body: string): SseEvent[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as SseEvent);
}

describe.skipIf(!available)('page restrictions on LLM and worker-status surfaces', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let currentUserId = '';
  let fx: RestrictionFixture;

  async function request(
    userId: string,
    url: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    payload?: unknown,
  ) {
    currentUserId = userId;
    return app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  }

  async function ok(userId: string, url: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', payload?: unknown) {
    const response = await request(userId, url, method, payload);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.body;
  }

  async function embeddingRun(userId: string): Promise<{ body: string; events: SseEvent[] }> {
    await query('UPDATE pages SET embedding_dirty = TRUE');
    const body = await ok(userId, '/api/embeddings/process', 'POST');
    return { body, events: sseEvents(body) };
  }

  /** Improve a page ref and return what the model was sent plus the SSE body. */
  async function improve(userId: string, pageId: string): Promise<{ prompt: string; body: string }> {
    // A cached answer would skip the provider call this helper inspects.
    await flushRedis(redis);
    provider.prompts.length = 0;
    const body = await ok(userId, '/api/llm/improve', 'POST', {
      content: '<p>Caller supplied draft text for the improvement.</p>',
      type: 'grammar',
      pageId,
      includeSubPages: true,
    });
    expect(provider.prompts).toHaveLength(1);
    return { prompt: provider.prompts[0]!, body };
  }

  async function insertConversation(ownerId: string, pageRef: number): Promise<string> {
    const result = await query<{ id: string }>(
      `INSERT INTO llm_conversations (user_id, model, title, title_source, page_ref, messages)
       VALUES ($1, 'fixture-model', 'Question about a page', 'question', $2, '[]'::jsonb)
       RETURNING id`,
      [ownerId, pageRef],
    );
    return result.rows[0]!.id;
  }

  async function insertImprovement(ownerId: string, pageId: number): Promise<string> {
    const result = await query<{ id: string }>(
      `INSERT INTO llm_improvements
         (user_id, page_id, improvement_type, model, original_content, improved_content, status)
       VALUES ($1, $2, 'grammar', 'fixture-model', 'old', 'new', 'completed')
       RETURNING id`,
      [ownerId, pageId],
    );
    return result.rows[0]!.id;
  }

  async function revokeGroupAces(): Promise<void> {
    await query('DELETE FROM access_control_entries WHERE id = ANY($1::int[])', [fx.groupAceIds]);
  }

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);

    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      instance.addHook('onRequest', async (req) => {
        req.userCan = async () => true;
      });
      await instance.register(llmEmbeddingRoutes, { prefix: '/api' });
      await instance.register(llmImproveRoutes, { prefix: '/api' });
      await instance.register(llmConversationRoutes, { prefix: '/api' });
      await instance.register(knowledgeAdminRoutes, { prefix: '/api' });
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (redis?.isOpen) {
      await flushRedis(redis);
      await redis.quit();
    }
    setRedisClient(null);
    await truncateAllTables();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await flushRedis(redis);
    fx = await seedRestrictionFixture();
    provider.prompts.length = 0;
  }, 30_000);

  describe('embedding run SSE (POST /embeddings/process, /embeddings/retry-failed)', () => {
    it('never streams a restricted page title to R, in progress events or the error list', async () => {
      const { body, events } = await embeddingRun(fx.readerId);
      expect(events.at(-1)).toMatchObject({ type: 'complete' });
      expect(restrictedLeaks(body)).toEqual([]);
      // R's own readable pages keep their titles.
      const titles = events.map((event) => event.currentPage).filter(Boolean);
      expect(titles).toEqual(expect.arrayContaining(['Open Root', 'Visible Child', 'Reader Private']));
      const errors = events.at(-1)!.errors as string[];
      expect(errors.some((entry) => entry.startsWith('Open Root: '))).toBe(true);

      // retry-failed resets the failed pages and streams the same run again.
      const retry = await ok(fx.readerId, '/api/embeddings/retry-failed', 'POST');
      expect(sseEvents(retry).at(-1)).toMatchObject({ type: 'complete' });
      expect(restrictedLeaks(retry)).toEqual([]);
    });

    it('keeps restricted titles for G and the administrator, and never shows R\'s private note to them', async () => {
      for (const userId of [fx.groupReaderId, fx.adminId]) {
        const { body, events } = await embeddingRun(userId);
        const titles = events.map((event) => event.currentPage).filter(Boolean);
        expect(titles).toEqual(expect.arrayContaining([...RESTRICTED_TITLES]));
        expect(body).not.toContain('Reader Private');
        const errors = events.at(-1)!.errors as string[];
        expect(errors.some((entry) => entry.startsWith('Hushed Leaf: '))).toBe(true);
      }
    });
  });

  describe('LLM page context (resolvePageRef / assembleContextIfNeeded / improvement rows)', () => {
    it('does not put a restricted title or its sub-page tree into R\'s prompt', async () => {
      for (const ref of [String(fx.pages.hushedLeaf), String(fx.pages.hushedParent), 'c-hushed-parent']) {
        const { prompt, body } = await improve(fx.readerId, ref);
        expect(restrictedLeaks(prompt), ref).toEqual([]);
        expect(restrictedLeaks(body), ref).toEqual([]);
        // The restricted parent's hierarchy is not disclosed through its children.
        expect(prompt, ref).not.toContain('Visible Child');
      }
    });

    it('answers a restricted ref exactly like a page that does not exist', async () => {
      const restricted = await improve(fx.readerId, String(fx.pages.hushedLeaf));
      const missing = await improve(fx.readerId, '987654');
      expect(restricted.prompt).toBe(missing.prompt);
    });

    it('records an improvement row only for a page the caller may read', async () => {
      await improve(fx.readerId, String(fx.pages.hushedLeaf));
      await improve(fx.readerId, String(fx.pages.openRoot));
      const rows = await query<{ page_id: number }>(
        'SELECT page_id FROM llm_improvements WHERE user_id = $1',
        [fx.readerId],
      );
      expect(rows.rows.map((row) => row.page_id)).toEqual([fx.pages.openRoot]);
    });

    it('keeps the restricted page context and row for G and the administrator', async () => {
      for (const userId of [fx.groupReaderId, fx.adminId]) {
        const leaf = await improve(userId, String(fx.pages.hushedLeaf));
        expect(leaf.prompt).toContain('Hushed Leaf');
        const parent = await improve(userId, String(fx.pages.hushedParent));
        expect(parent.prompt).toContain('Hushed Parent');
        expect(parent.prompt).toContain('Visible Child');
        const rows = await query<{ page_id: number }>(
          'SELECT page_id FROM llm_improvements WHERE user_id = $1 ORDER BY created_at',
          [userId],
        );
        expect(rows.rows.map((row) => row.page_id)).toEqual([fx.pages.hushedLeaf, fx.pages.hushedParent]);
      }
    });
  });

  describe('conversations and improvement history', () => {
    it('hides the restricted page chip from R on list, detail and rename', async () => {
      const conversationId = await insertConversation(fx.readerId, fx.pages.hushedLeaf);
      const readable = await insertConversation(fx.readerId, fx.pages.openRoot);

      const list = JSON.parse(await ok(fx.readerId, '/api/llm/conversations')) as {
        items: Array<{ id: string; pageId: number | null; pageTitle: string | null }>;
      };
      expect(list.items.find((item) => item.id === conversationId)).toMatchObject({ pageId: null, pageTitle: null });
      expect(list.items.find((item) => item.id === readable)).toMatchObject({
        pageId: fx.pages.openRoot,
        pageTitle: 'Open Root',
      });

      const detail = await ok(fx.readerId, `/api/llm/conversations/${conversationId}`);
      expect(restrictedLeaks(detail)).toEqual([]);
      expect(JSON.parse(detail)).toMatchObject({ pageId: null, pageTitle: null });

      const renamed = await ok(fx.readerId, `/api/llm/conversations/${conversationId}`, 'PATCH', { title: 'Renamed' });
      expect(restrictedLeaks(renamed)).toEqual([]);
      expect(JSON.parse(renamed)).toMatchObject({ title: 'Renamed', pageId: null, pageTitle: null });
    });

    it('omits the restricted page id from R\'s improvement history and its page filter', async () => {
      const restricted = await insertImprovement(fx.readerId, fx.pages.hushedLeaf);
      const readable = await insertImprovement(fx.readerId, fx.pages.openRoot);

      const history = JSON.parse(await ok(fx.readerId, '/api/llm/improvements')) as Array<{
        id: string;
        confluenceId?: string;
      }>;
      expect(history.find((row) => row.id === restricted)).toBeDefined();
      expect(history.find((row) => row.id === restricted)!.confluenceId).toBeUndefined();
      expect(history.find((row) => row.id === readable)!.confluenceId).toBe('c-open-root');

      expect(JSON.parse(await ok(fx.readerId, '/api/llm/improvements?pageId=c-hushed-leaf'))).toEqual([]);
    });

    it('keeps page chips and improvement ids for G and the administrator', async () => {
      for (const userId of [fx.groupReaderId, fx.adminId]) {
        const conversationId = await insertConversation(userId, fx.pages.hushedLeaf);
        const detail = JSON.parse(await ok(userId, `/api/llm/conversations/${conversationId}`)) as {
          pageTitle: string | null;
        };
        expect(detail.pageTitle).toBe('Hushed Leaf');

        const improvementId = await insertImprovement(userId, fx.pages.hushedLeaf);
        const filtered = JSON.parse(await ok(userId, '/api/llm/improvements?pageId=c-hushed-leaf')) as Array<{
          id: string;
          confluenceId?: string;
        }>;
        expect(filtered).toMatchObject([{ id: improvementId, confluenceId: 'c-hushed-leaf' }]);
      }
    });
  });

  describe('worker status counts and sync overview', () => {
    beforeEach(async () => {
      await query(
        `UPDATE pages SET quality_status = 'failed', summary_status = 'failed'
          WHERE id = ANY($1::int[])`,
        [[fx.pages.hushedLeaf, fx.pages.hushedParent]],
      );
      // Missing cached assets make both pages show up as sync-overview issues.
      await query(
        `UPDATE pages SET expected_image_files = ARRAY[title || '.png'], expected_drawio_files = '{}'
          WHERE source = 'confluence'`,
      );
    });

    async function statusFor(userId: string) {
      const quality = JSON.parse(await ok(userId, '/api/llm/quality-status')) as {
        totalPages: number;
        failedPages: number;
      };
      const summary = JSON.parse(await ok(userId, '/api/llm/summary-status')) as {
        totalPages: number;
        failedPages: number;
      };
      return { quality, summary };
    }

    it('counts only pages the caller may read in quality and summary status', async () => {
      const reader = await statusFor(fx.readerId);
      expect(reader.quality).toMatchObject({ totalPages: 4, failedPages: 0 });
      expect(reader.summary).toMatchObject({ totalPages: 4, failedPages: 0 });

      for (const userId of [fx.groupReaderId, fx.adminId]) {
        const status = await statusFor(userId);
        expect(status.quality).toMatchObject({ totalPages: 5, failedPages: 2 });
        expect(status.summary).toMatchObject({ totalPages: 5, failedPages: 2 });
      }
    });

    it('scopes sync-overview page counts and issues to pages the caller may read', async () => {
      const reader = await getSyncOverview(fx.readerId);
      expect(restrictedLeaks(JSON.stringify(reader))).toEqual([]);
      expect(reader.spaces.find((space) => space.spaceKey === 'DOCS')).toMatchObject({
        pageCount: 2,
        pagesWithAssets: 2,
        pagesWithIssues: 2,
      });
      expect(reader.issues.map((issue) => issue.pageTitle).sort()).toEqual(['Open Root', 'Visible Child']);

      for (const userId of [fx.groupReaderId, fx.adminId]) {
        const overview = await getSyncOverview(userId);
        expect(overview.spaces.find((space) => space.spaceKey === 'DOCS')).toMatchObject({ pageCount: 4 });
        expect(overview.issues.map((issue) => issue.pageTitle))
          .toEqual(expect.arrayContaining([...RESTRICTED_TITLES]));
      }
    });
  });

  it('revocation: deleting G\'s group ACE hides the restricted page on G\'s next request everywhere', async () => {
    const conversationId = await insertConversation(fx.groupReaderId, fx.pages.hushedLeaf);
    const improvementId = await insertImprovement(fx.groupReaderId, fx.pages.hushedLeaf);
    await query(
      `UPDATE pages SET quality_status = 'failed', expected_image_files = ARRAY['leaf.png'],
                        expected_drawio_files = '{}'
        WHERE id = $1`,
      [fx.pages.hushedLeaf],
    );

    // Before: G reads the restricted page on every surface.
    expect(await ok(fx.groupReaderId, `/api/llm/conversations/${conversationId}`)).toContain('Hushed Leaf');
    expect(await ok(fx.groupReaderId, '/api/llm/improvements')).toContain('c-hushed-leaf');
    expect((await improve(fx.groupReaderId, String(fx.pages.hushedLeaf))).prompt).toContain('Hushed Leaf');
    expect((await embeddingRun(fx.groupReaderId)).body).toContain('Hushed Leaf');
    expect(JSON.stringify(await getSyncOverview(fx.groupReaderId))).toContain('Hushed Leaf');
    expect(JSON.parse(await ok(fx.groupReaderId, '/api/llm/quality-status'))).toMatchObject({ failedPages: 1 });

    await revokeGroupAces();

    // After: the very next request hides it.
    const detail = await ok(fx.groupReaderId, `/api/llm/conversations/${conversationId}`);
    expect(restrictedLeaks(detail)).toEqual([]);
    expect(restrictedLeaks(await ok(fx.groupReaderId, '/api/llm/conversations'))).toEqual([]);
    const history = JSON.parse(await ok(fx.groupReaderId, '/api/llm/improvements')) as Array<{
      id: string;
      confluenceId?: string;
    }>;
    expect(history.find((row) => row.id === improvementId)!.confluenceId).toBeUndefined();
    expect(restrictedLeaks((await improve(fx.groupReaderId, String(fx.pages.hushedLeaf))).prompt)).toEqual([]);
    expect(restrictedLeaks((await embeddingRun(fx.groupReaderId)).body)).toEqual([]);
    expect(restrictedLeaks(JSON.stringify(await getSyncOverview(fx.groupReaderId)))).toEqual([]);
    expect(JSON.parse(await ok(fx.groupReaderId, '/api/llm/quality-status'))).toMatchObject({ failedPages: 0 });

    // The caller's own rows are kept, not deleted.
    const kept = await query('SELECT 1 FROM llm_conversations WHERE id = $1', [conversationId]);
    expect(kept.rowCount).toBe(1);
  });
});
