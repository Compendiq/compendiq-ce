import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { buildKnowledgeTestApp, insertUser } from './pages.test-helpers.js';
import { pageAiPolicyRoutes } from './page-ai-policy.js';

const available = await isDbAvailable();
describe.skipIf(!available)('dedicated policy refusal serialization', () => {
  let app: FastifyInstance;
  let userId: string;
  let ids: number[];
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    userId = await insertUser(`policy-wire-${randomUUID()}`);
    ids = (await query<{ id: number }>(`INSERT INTO pages
      (title, source, visibility, created_by_user_id, ai_policy_revision)
      VALUES ('safe', 'standalone', 'private', $1, 0),
             ('unsafe', 'standalone', 'private', $1, 9007199254740993) RETURNING id`, [userId])).rows.map((row) => row.id);
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.addHook('preHandler', instance.authenticate);
      await instance.register(pageAiPolicyRoutes, { prefix: '/api' });
    });
  });
  afterAll(async () => { await app?.close(); await teardownTestDb(); });

  it.each(['single', 'bulk'])('serializes unavailable policy for %s and preserves every row', async (kind) => {
    const before = (await query('SELECT * FROM pages WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows;
    const response = await app.inject(kind === 'single' ? {
      method: 'PUT', url: `/api/pages/${ids[1]}/ai-policy`, payload: { aiPolicy: 'all', expectedRevision: 0 },
    } : {
      method: 'POST', url: '/api/pages/bulk/ai-policy',
      payload: { aiPolicy: 'all', items: ids.map((pageId) => ({ pageId, expectedRevision: 0 })) },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'ai_policy_unavailable', pageIds: [ids[1]] });
    expect((await query('SELECT * FROM pages WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows).toEqual(before);
  });
});
