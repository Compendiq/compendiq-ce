import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { buildKnowledgeTestApp, insertUser, insertStandalonePage } from './pages.test-helpers.js';
import { pagesTagRoutes } from './pages-tags.js';

const available = await isDbAvailable();
describe.skipIf(!available)('auto-tag policy refusal HTTP contract', () => {
  let app: FastifyInstance;
  let pageId: number;
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    const userId = await insertUser(`tag-refusal-${randomUUID()}`);
    pageId = await insertStandalonePage('Restricted', 'private', userId);
    await query(`UPDATE pages SET body_html = '<p>Restricted content</p>', ai_policy = 'none' WHERE id = $1`, [pageId]);
    const provider = await query(`INSERT INTO llm_providers (name, base_url, auth_type, default_model)
      VALUES ('refusal', 'http://127.0.0.1:1/v1', 'none', 'test-model') RETURNING id`);
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
      VALUES ('auto_tag', $1, 'test-model')`, [provider.rows[0].id]);
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      await instance.register(pagesTagRoutes, { prefix: '/api' });
    });
  });
  afterAll(async () => { await app?.close(); await teardownTestDb(); });
  it('returns shared 403 instead of a generic provider 502', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/auto-tag`, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'ai_policy_denied', pageIds: [pageId] });
  });
});
