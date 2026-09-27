import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from '../knowledge/pages.test-helpers.js';
import { llmConversationRoutes } from './llm-conversations.js';

const CONV_1 = '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const CONV_2 = '6a1f9f0b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';
const CONV_3 = '7b2a0a1c-3d4e-4f50-8b6c-7d8e9f0a1b2c';

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

let app: FastifyInstance;
let redis: RedisClientType;
let userId: string;
let otherUserId: string;
let authenticated = true;

async function insertConversation(input: {
  id: string;
  ownerId?: string;
  title?: string | null;
  titleSource?: 'question' | 'generated' | 'user';
  model?: string;
  pageRef?: number | null;
  messages?: unknown[];
  createdAt?: string;
  updatedAt?: string;
}): Promise<void> {
  await query(
    `INSERT INTO llm_conversations
       (id, user_id, model, title, title_source, page_ref, messages, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)`,
    [
      input.id,
      input.ownerId ?? userId,
      input.model ?? 'test-model',
      input.title ?? 'Conversation',
      input.titleSource ?? 'question',
      input.pageRef ?? null,
      JSON.stringify(input.messages ?? []),
      input.createdAt ?? '2026-01-01T10:00:00.000Z',
      input.updatedAt ?? '2026-01-01T11:00:00.000Z',
    ],
  );
}

async function insertImprovement(input: {
  ownerId?: string;
  pageId: number;
  type: string;
  model: string;
  status: string;
  improvedContent?: string;
  createdAt: string;
}): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO llm_improvements
       (user_id, page_id, improvement_type, model, original_content, improved_content, status, created_at)
     VALUES ($1, $2, $3, $4, 'old', $5, $6, $7::timestamptz)
     RETURNING id`,
    [
      input.ownerId ?? userId,
      input.pageId,
      input.type,
      input.model,
      input.improvedContent ?? 'new',
      input.status,
      input.createdAt,
    ],
  );
  return result.rows[0]!.id;
}

async function get(url: string) {
  return app.inject({ method: 'GET', url });
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'llm conversations — real PostgreSQL and Redis persistence',
  () => {
    beforeAll(async () => {
      await setupTestDb();
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      await redis.connect();
      setRedisClient(redis);
      app = await buildKnowledgeTestApp(() => userId, async (instance) => {
        instance.redis = redis;
        vi.spyOn(instance, 'authenticate').mockImplementation(async (request) => {
          if (!authenticated) throw instance.httpErrors.unauthorized('Missing or invalid token');
          request.userId = userId;
          request.userCan = async () => true;
        });
        await instance.register(llmConversationRoutes, { prefix: '/api' });
      });
    }, 30_000);

    afterAll(async () => {
      await app.close();
      if (redis.isOpen) await redis.quit();
      await teardownTestDb();
      vi.restoreAllMocks();
    });

    beforeEach(async () => {
      await truncateAllTables();
      await redis.flushDb();
      authenticated = true;
      userId = await insertUser(`conversation-owner-${randomUUID()}`);
      otherUserId = await insertUser(`conversation-other-${randomUUID()}`);
      await insertLocalSpace('VIEWER', userId);
      await insertLocalSpace('OTHER', otherUserId);
    });

    it('requires authentication for every conversation and improvement endpoint', async () => {
      authenticated = false;
      const requests = [
        app.inject({ method: 'GET', url: '/api/llm/conversations' }),
        app.inject({ method: 'GET', url: `/api/llm/conversations/${CONV_1}` }),
        app.inject({ method: 'PATCH', url: `/api/llm/conversations/${CONV_1}`, payload: { title: 'x' } }),
        app.inject({ method: 'DELETE', url: `/api/llm/conversations/${CONV_1}` }),
        app.inject({ method: 'GET', url: '/api/llm/improvements' }),
        app.inject({ method: 'POST', url: '/api/llm/improvements/apply', payload: { pageId: '1', improvedMarkdown: 'x' } }),
      ];
      for (const response of await Promise.all(requests)) expect(response.statusCode).toBe(401);
    });

    it('lists only the caller’s persisted conversations with page chips, title fallback, and ISO timestamps', async () => {
      const pageId = await insertStandalonePage('Runbook', 'private', userId, 'VIEWER');
      await insertConversation({
        id: CONV_1,
        title: 'First conversation',
        model: 'llama3',
        pageRef: pageId,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-02T12:00:00.000Z',
      });
      await insertConversation({
        id: CONV_2,
        title: '   ',
        titleSource: 'user',
        model: 'qwen3:32b',
        createdAt: '2026-01-02T10:00:00.000Z',
        updatedAt: '2026-01-02T11:00:00.000Z',
      });
      await insertConversation({
        id: CONV_3,
        ownerId: otherUserId,
        title: 'Another user’s conversation',
        updatedAt: '2026-01-03T00:00:00.000Z',
      });

      const response = await get('/api/llm/conversations');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        items: [
          {
            id: CONV_1,
            title: 'First conversation',
            titleSource: 'question',
            model: 'llama3',
            pageId,
            pageTitle: 'Runbook',
            createdAt: '2026-01-01T10:00:00.000Z',
            updatedAt: '2026-01-02T12:00:00.000Z',
          },
          {
            id: CONV_2,
            title: 'Untitled conversation',
            titleSource: 'user',
            model: 'qwen3:32b',
            pageId: null,
            pageTitle: null,
            createdAt: '2026-01-02T10:00:00.000Z',
            updatedAt: '2026-01-02T11:00:00.000Z',
          },
        ],
        nextCursor: null,
      });
    });

    it('uses a stable keyset cursor across actual rows', async () => {
      await insertConversation({ id: CONV_1, title: 'c0', updatedAt: '2026-01-03T00:00:00.000Z' });
      await insertConversation({ id: CONV_2, title: 'c1', updatedAt: '2026-01-02T00:00:00.000Z' });
      await insertConversation({ id: CONV_3, title: 'c2', updatedAt: '2026-01-01T00:00:00.000Z' });
      await insertConversation({
        id: '8c3b1b2d-4e5f-4061-9c7d-8e9f0a1b2c3d',
        ownerId: otherUserId,
        title: 'not visible',
        updatedAt: '2026-01-04T00:00:00.000Z',
      });

      const first = await get('/api/llm/conversations?limit=2');
      expect(first.statusCode).toBe(200);
      const page1 = first.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
      expect(page1.items.map((item) => item.id)).toEqual([CONV_1, CONV_2]);
      expect(page1.nextCursor).toEqual(expect.any(String));

      const second = await get(`/api/llm/conversations?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({ items: [{ id: CONV_3 }], nextCursor: null });
    });

    it('rejects malformed cursors, oversized limits, and non-UUID ids before reading a row', async () => {
      expect((await get('/api/llm/conversations?cursor=not-base64-json')).statusCode).toBe(400);
      expect((await get('/api/llm/conversations?limit=101')).statusCode).toBe(400);
      expect((await get('/api/llm/conversations/conv-1')).statusCode).toBe(400);
      expect((await app.inject({ method: 'DELETE', url: '/api/llm/conversations/conv-1' })).statusCode).toBe(400);
      expect((await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM llm_conversations')).rows[0]?.count).toBe('0');
    });

    it('returns an empty page when the caller has no conversations', async () => {
      expect((await get('/api/llm/conversations')).json()).toEqual({ items: [], nextCursor: null });
    });

    it('reopens persisted messages and annotates source availability per page without losing image provenance', async () => {
      const visiblePage = await insertStandalonePage('Visible', 'private', userId, 'VIEWER');
      const revokedPage = await insertStandalonePage('Revoked', 'private', otherUserId, 'OTHER');
      const trashedPage = await insertStandalonePage('Trashed', 'shared', otherUserId, 'OTHER', { deletedAt: new Date() });
      const messages = [
        { role: 'user', content: 'What is shown?' },
        {
          role: 'assistant',
          content: 'A diagram.',
          sources: [
            { pageTitle: 'Visible', pageId: visiblePage, similarity: 0.8 },
            { pageTitle: 'Revoked', pageId: revokedPage, similarity: 0.5 },
            { pageTitle: 'Trashed', pageId: trashedPage, similarity: 0.4 },
            { pageTitle: 'Web', url: 'https://example.com', similarity: null },
            {
              pageTitle: 'Revoked image',
              pageId: revokedPage,
              kind: 'image',
              attachmentUrl: `/api/attachments/${revokedPage}/shared.png`,
              attachmentStore: 'confluence',
              attachmentKey: 'shared.png',
              contentHash: 'sha256:same',
              analysisVersion: 1,
              similarity: null,
            },
            {
              pageTitle: 'Visible image',
              pageId: visiblePage,
              kind: 'image',
              attachmentUrl: `/api/attachments/${visiblePage}/shared.png`,
              attachmentStore: 'confluence',
              attachmentKey: 'shared.png',
              contentHash: 'sha256:same',
              analysisVersion: 1,
              similarity: null,
            },
          ],
        },
        { role: 'assistant', content: 'I am not answering.', refused: true },
      ];
      await insertConversation({
        id: CONV_1,
        title: 'Docker questions',
        titleSource: 'generated',
        model: 'llama3',
        pageRef: visiblePage,
        messages,
      });

      const response = await get(`/api/llm/conversations/${CONV_1}`);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{
        id: string;
        pageId: number;
        pageTitle: string;
        historyTruncated: boolean;
        messages: Array<{ refused?: boolean; sources?: Array<Record<string, unknown>> }>;
      }>();
      expect(body).toMatchObject({
        id: CONV_1,
        pageId: visiblePage,
        pageTitle: 'Visible',
        historyTruncated: false,
      });
      expect(body.messages[2]?.refused).toBe(true);
      const sources = body.messages[1]!.sources!;
      expect(sources[0]).not.toHaveProperty('unavailable');
      expect(sources[1]).toMatchObject({ pageId: revokedPage, unavailable: true });
      expect(sources[2]).toMatchObject({ pageId: trashedPage, unavailable: true });
      expect(sources[3]).not.toHaveProperty('unavailable');
      expect(sources[4]).toMatchObject({
        pageId: revokedPage,
        kind: 'image',
        attachmentKey: 'shared.png',
        contentHash: 'sha256:same',
        analysisVersion: 1,
        unavailable: true,
      });
      expect(sources[5]).toMatchObject({
        pageId: visiblePage,
        kind: 'image',
        attachmentStore: 'confluence',
        contentHash: 'sha256:same',
      });
      expect(sources[5]).not.toHaveProperty('unavailable');
    });

    it('reports truncation without modifying the persisted message history', async () => {
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (let index = 0; index < 6; index++) {
        messages.push(
          { role: 'user', content: 'x'.repeat(4_000) },
          { role: 'assistant', content: 'y'.repeat(4_000) },
        );
      }
      await insertConversation({ id: CONV_1, messages });

      const body = (await get(`/api/llm/conversations/${CONV_1}`)).json<{
        historyTruncated: boolean;
        messages: unknown[];
      }>();
      expect(body.historyTruncated).toBe(true);
      expect(body.messages).toHaveLength(12);
      const persisted = await query<{ messages: unknown[] }>('SELECT messages FROM llm_conversations WHERE id = $1', [CONV_1]);
      expect(persisted.rows[0]!.messages).toHaveLength(12);
    });

    it('returns 404 for a missing or another user’s conversation', async () => {
      await insertConversation({ id: CONV_2, ownerId: otherUserId });
      for (const id of [CONV_1, CONV_2]) {
        const response = await get(`/api/llm/conversations/${id}`);
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: 'Conversation not found' });
      }
    });

    it('renames only the caller’s row, marks it user-named, and preserves its keyset timestamp', async () => {
      await insertConversation({
        id: CONV_1,
        title: 'Old title',
        updatedAt: '2026-01-01T11:00:00.000Z',
      });
      await insertConversation({ id: CONV_2, ownerId: otherUserId, title: 'Other title' });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/llm/conversations/${CONV_1}`,
        payload: { title: '  PAT rotation  ' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: CONV_1, title: 'PAT rotation', titleSource: 'user' });
      const renamed = await query<{ title: string; title_source: string; updated_at: Date }>(
        'SELECT title, title_source, updated_at FROM llm_conversations WHERE id = $1',
        [CONV_1],
      );
      expect(renamed.rows[0]).toMatchObject({ title: 'PAT rotation', title_source: 'user' });
      expect(renamed.rows[0]!.updated_at.toISOString()).toBe('2026-01-01T11:00:00.000Z');

      const denied = await app.inject({
        method: 'PATCH',
        url: `/api/llm/conversations/${CONV_2}`,
        payload: { title: 'Stolen' },
      });
      expect(denied.statusCode).toBe(404);
      expect((await query<{ title: string }>('SELECT title FROM llm_conversations WHERE id = $1', [CONV_2])).rows[0]?.title)
        .toBe('Other title');
    });

    it('rejects blank, over-long, and malformed rename requests without changing the row', async () => {
      await insertConversation({ id: CONV_1, title: 'Original' });
      expect((await app.inject({ method: 'PATCH', url: `/api/llm/conversations/${CONV_1}`, payload: { title: '   ' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: `/api/llm/conversations/${CONV_1}`, payload: { title: 'x'.repeat(201) } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: '/api/llm/conversations/conv-1', payload: { title: 'x' } })).statusCode).toBe(400);
      expect((await query<{ title: string }>('SELECT title FROM llm_conversations WHERE id = $1', [CONV_1])).rows[0]?.title)
        .toBe('Original');
    });

    it('deletes only the caller’s conversation and remains idempotent', async () => {
      await insertConversation({ id: CONV_1 });
      await insertConversation({ id: CONV_2, ownerId: otherUserId });

      const denied = await app.inject({ method: 'DELETE', url: `/api/llm/conversations/${CONV_2}` });
      expect(denied.statusCode).toBe(200);
      expect((await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM llm_conversations WHERE id = $1', [CONV_2])).rows[0]?.count)
        .toBe('1');

      const deleted = await app.inject({ method: 'DELETE', url: `/api/llm/conversations/${CONV_1}` });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ message: 'Conversation deleted' });
      expect((await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM llm_conversations WHERE id = $1', [CONV_1])).rows[0]?.count)
        .toBe('0');
      expect((await app.inject({ method: 'DELETE', url: `/api/llm/conversations/${CONV_1}` })).statusCode).toBe(200);
    });

    it('returns the caller’s persisted improvement history and filters it by Confluence page id', async () => {
      const firstPage = await insertConfluencePage('page-abc', 'First page', 'ENG');
      const secondPage = await insertConfluencePage('page-other', 'Second page', 'ENG');
      const firstId = await insertImprovement({
        pageId: firstPage,
        type: 'grammar',
        model: 'llama3',
        status: 'completed',
        createdAt: '2026-01-01T10:00:00.000Z',
      });
      const secondId = await insertImprovement({
        pageId: secondPage,
        type: 'clarity',
        model: 'qwen3',
        status: 'applied',
        createdAt: '2026-01-02T10:00:00.000Z',
      });
      await insertImprovement({
        ownerId: otherUserId,
        pageId: firstPage,
        type: 'other-user',
        model: 'hidden',
        status: 'completed',
        createdAt: '2026-01-03T10:00:00.000Z',
      });

      const all = await get('/api/llm/improvements');
      expect(all.statusCode, all.body).toBe(200);
      expect(all.json()).toMatchObject([
        { id: secondId, confluenceId: 'page-other', type: 'clarity', model: 'qwen3', status: 'applied' },
        { id: firstId, confluenceId: 'page-abc', type: 'grammar', model: 'llama3', status: 'completed' },
      ]);

      const filtered = await get('/api/llm/improvements?pageId=page-abc');
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json()).toMatchObject([
        { id: firstId, confluenceId: 'page-abc', type: 'grammar', model: 'llama3', status: 'completed' },
      ]);
    });
  },
);
