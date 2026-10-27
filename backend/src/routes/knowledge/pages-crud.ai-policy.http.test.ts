import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { pagesTagRoutes } from './pages-tags.js';

/**
 * HTTP contract of the article AI policy refusals on the page write routes
 * (#280). Real Fastify, real PostgreSQL, real Redis; nothing is mocked.
 *
 * - `PUT /pages/:id` with `aiPolicy` but no `expectedRevision` (or the other
 *   way round) is the route's own 422 `ai_policy_revision_required`, never
 *   the global schema 400 — the pairing is a policy rule, not a shape rule.
 * - a label set naming two policies is the frozen 422
 *   `ai_policy_label_conflict` body on EVERY label writer: page create, page
 *   update by labels, and the labels route.
 */
const LOCAL_SPACE = 'AIPOL-HTTP';

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);

async function labelsFor(pageId: number): Promise<string[]> {
  const result = await query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [pageId]);
  return result.rows[0]!.labels;
}

describe.skipIf(!(dbAvailable && redisAvailable))('article AI policy — page route HTTP contract (#280)', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let userId: string;
  let pageId: number;

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
    await truncateAllTables();

    userId = await insertUser(`aipol-http-${randomUUID()}`);
    await insertLocalSpace(LOCAL_SPACE, userId);
    pageId = await insertStandalonePage('Policy HTTP page', 'private', userId, LOCAL_SPACE);
    await query(`UPDATE pages SET labels = ARRAY['keep']::text[] WHERE id = $1`, [pageId]);

    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
      await instance.register(pagesTagRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await teardownTestDb();
  });

  it('PUT /pages/:id with aiPolicy but no expectedRevision is the route\'s 422, not a schema 400', async () => {
    const before = await query<{ title: string; ai_policy: string }>(
      'SELECT title, ai_policy FROM pages WHERE id = $1', [pageId],
    );
    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Changed', bodyHtml: '<p>x</p>', aiPolicy: 'none' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'ai_policy_revision_required', missing: 'expectedRevision' });

    const other = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Changed', bodyHtml: '<p>x</p>', expectedRevision: 0 },
    });
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ error: 'ai_policy_revision_required', missing: 'aiPolicy' });

    const after = await query<{ title: string; ai_policy: string }>(
      'SELECT title, ai_policy FROM pages WHERE id = $1', [pageId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('PUT /pages/:id with neither field is still an ordinary content write', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      payload: { title: 'Plain update', bodyHtml: '<p>plain</p>' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: pageId, title: 'Plain update' });
  });

  it.each([{ labels: [] }, { labels: ['ordinary'] }, { labels: ['ordinary', 'ai:all'] }])('canonicalizes ordinary creation labels $labels', async ({ labels }) => {
    const response = await app.inject({
      method: 'POST', url: '/api/pages',
      payload: { title: 'Canonical creation', bodyHtml: '<p>authored</p>', source: 'standalone', labels },
    });
    expect(response.statusCode).toBe(200);
    const stored = await query<{ ai_policy: string; labels: string[] }>(
      'SELECT ai_policy, labels FROM pages WHERE id = $1', [response.json().id],
    );
    expect(stored.rows[0]).toEqual({
      ai_policy: 'all', labels: labels.includes('ordinary') ? ['ordinary', 'all-ai'] : ['all-ai'],
    });
  });

  it('POST /pages with labels naming two policies is the frozen 422 label-conflict body and creates nothing', async () => {
    const countBefore = await query<{ n: string }>('SELECT count(*)::text AS n FROM pages');
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Contradictory',
        bodyHtml: '<p>x</p>',
        source: 'standalone',
        spaceKey: LOCAL_SPACE,
        labels: ['no-ai', 'local-ai-only', 'ordinary'],
      },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe('ai_policy_label_conflict');
    expect([...body.policies].sort()).toEqual(['local_only', 'none']);
    const countAfter = await query<{ n: string }>('SELECT count(*)::text AS n FROM pages');
    expect(countAfter.rows[0]!.n).toBe(countBefore.rows[0]!.n);
  });

  it.each(['no-ai', 'no_ai', 'ai:none', 'local-ai-only', 'local_only', 'ai:local'])(
    'POST /pages refuses label %s before any row or intent is published while rollout is closed', async (label) => {
      const before = await query('SELECT * FROM pages ORDER BY id');
      const intents = await query('SELECT * FROM page_write_intents ORDER BY id');
      const response = await app.inject({
        method: 'POST', url: '/api/pages',
        payload: { title: `Closed creation ${label}`, bodyHtml: '<p>authored content</p>',
          source: 'standalone', spaceKey: LOCAL_SPACE, labels: ['ordinary', label] },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'ai_policy_enforcement_unavailable' });
      expect((await query('SELECT * FROM pages ORDER BY id')).rows).toEqual(before.rows);
      expect((await query('SELECT * FROM page_write_intents ORDER BY id')).rows).toEqual(intents.rows);
    },
  );

  it('POST /pages with an explicit aiPolicy contradicting its labels is the same 422 body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: {
        title: 'Contradictory explicit',
        bodyHtml: '<p>x</p>',
        source: 'standalone',
        spaceKey: LOCAL_SPACE,
        labels: ['no-ai'],
        aiPolicy: 'all',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'ai_policy_label_conflict' });
    expect([...response.json().policies].sort()).toEqual(['all', 'none']);
  });

  it('PUT /pages/:id/labels naming two policies is the frozen 422 body and leaves the labels unchanged', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}/labels`,
      payload: { addLabels: ['no-ai', 'ai:local'] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'ai_policy_label_conflict' });
    expect([...response.json().policies].sort()).toEqual(['local_only', 'none']);
    expect(await labelsFor(pageId)).toEqual(['keep']);
  });

  it('POST /pages/bulk/tag naming two policies is the frozen 422 body (not a generic 422) and writes nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/tag',
      payload: { ids: [String(pageId)], addTags: ['no-ai', 'local-ai-only'] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'ai_policy_label_conflict' });
    expect([...response.json().policies].sort()).toEqual(['local_only', 'none']);
    expect(response.json()).not.toHaveProperty('succeeded');
    expect(await labelsFor(pageId)).toEqual(['keep']);
  });

  it('a shared non-owner cannot relax policy through labels and receives the shared denial body', async () => {
    const ownerId = await insertUser(`aipol-other-${randomUUID()}`);
    const target = await insertStandalonePage('Shared restricted page', 'shared', ownerId, null);
    await query(`UPDATE pages SET ai_policy = 'none', labels = ARRAY['no-ai', 'ordinary'] WHERE id = $1`, [target]);
    const before = await query('SELECT * FROM pages WHERE id = $1', [target]);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${target}/labels`,
      payload: { addLabels: ['all-ai'], removeLabels: ['no-ai'] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'ai_policy_denied' });
    expect((await query('SELECT * FROM pages WHERE id = $1', [target])).rows).toEqual(before.rows);

    await query(`UPDATE pages SET visibility = 'private' WHERE id = $1`, [target]);
    const hidden = await app.inject({
      method: 'PUT',
      url: `/api/pages/${target}/labels`,
      payload: { addLabels: ['all-ai'], removeLabels: ['no-ai'] },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error).not.toBe('ai_policy_denied');
  });

  it('refuses new label restrictions while rollout is closed and preserves ordinary tag edits', async () => {
    const target = await insertStandalonePage('Closed rollout', 'private', userId, null);
    const before = await query('SELECT * FROM pages WHERE id = $1', [target]);
    const denied = await app.inject({
      method: 'PUT', url: `/api/pages/${target}/labels`, payload: { addLabels: ['ordinary', 'no-ai'] },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: 'ai_policy_enforcement_unavailable' });
    expect((await query('SELECT * FROM pages WHERE id = $1', [target])).rows).toEqual(before.rows);
    const ordinary = await app.inject({
      method: 'PUT', url: `/api/pages/${target}/labels`, payload: { addLabels: ['ordinary'] },
    });
    expect(ordinary.statusCode).toBe(200);
  });

  it('shared visibility cannot authorize label tightening either', async () => {
    const owner = await insertUser(`tighten-other-${randomUUID()}`);
    const target = await insertStandalonePage('Shared unrestricted', 'shared', owner, null);
    const before = await query('SELECT * FROM pages WHERE id = $1', [target]);
    const response = await app.inject({
      method: 'PUT', url: `/api/pages/${target}/labels`, payload: { addLabels: ['no-ai'] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'ai_policy_denied' });
    expect((await query('SELECT * FROM pages WHERE id = $1', [target])).rows).toEqual(before.rows);
  });

  it.each(['tag', 'replace-tags'])('bulk/%s refuses a mixed unauthorized policy set before any row or intent changes', async (action) => {
    const owner = await insertUser(`bulk-policy-other-${randomUUID()}`);
    const owned = await insertStandalonePage('Owned bulk target', 'shared', userId, null);
    const foreign = await insertStandalonePage('Foreign bulk target', 'shared', owner, null);
    const ids = [owned, foreign];
    await query(`UPDATE pages SET ai_policy = 'none', labels = ARRAY['no-ai', 'ordinary'] WHERE id = ANY($1::int[])`, [ids]);
    const before = await query('SELECT * FROM pages WHERE id = ANY($1::int[]) ORDER BY id', [ids]);
    const intents = await query('SELECT * FROM page_write_intents ORDER BY id');
    const response = await app.inject({
      method: 'POST', url: `/api/pages/bulk/${action}`,
      payload: action === 'tag'
        ? { ids: ids.map(String), addTags: ['all-ai'], removeTags: ['no-ai'] }
        : { ids: ids.map(String), tags: ['all-ai'] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'ai_policy_denied' });
    expect(response.json()).not.toHaveProperty('succeeded');
    expect((await query('SELECT * FROM pages WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows).toEqual(before.rows);
    expect((await query('SELECT * FROM page_write_intents ORDER BY id')).rows).toEqual(intents.rows);
  });

  it('POST /pages/bulk/replace-tags naming two policies is the frozen 422 body and writes nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/replace-tags',
      payload: { ids: [String(pageId)], tags: ['NO_AI', 'ai:local', 'x'] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'ai_policy_label_conflict' });
    expect([...response.json().policies].sort()).toEqual(['local_only', 'none']);
    expect(await labelsFor(pageId)).toEqual(['keep']);
  });
});
