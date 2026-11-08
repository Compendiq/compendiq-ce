import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { buildKnowledgeTestApp, insertUser } from './pages.test-helpers.js';
import { pagesCrudRoutes } from './pages-crud.js';

// The CE activation gate stays closed; restrictive incoming labels must defer
// the entire snapshot, not be ignored while its content becomes AI-eligible.
describe('bulk Confluence refresh policy publication', () => {
  let app: FastifyInstance;
  let userId: string;
  let pageId: number;
  let calls = 0;
  let labels: string[] = [];
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'remote-policy', title: 'Refreshed', type: 'page', status: 'current',
      version: { number: 2 }, body: { storage: { value: '<p>Fresh authored content</p>' } },
      metadata: { labels: { results: labels.map((name) => ({ name })) } } }));
  });
  beforeAll(async () => {
    await setupTestDb();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    app = await buildKnowledgeTestApp(() => userId, (instance) => instance.register(pagesCrudRoutes, { prefix: '/api' }));
  });
  beforeEach(async () => {
    await truncateAllTables();
    calls = 0; labels = [];
    userId = await insertUser('bulk-policy');
    await query("INSERT INTO spaces (space_key, space_name, source) VALUES ('DEV', 'Development', 'confluence')");
    const role = (await query("INSERT INTO roles (name, display_name, permissions) VALUES ('bulk-editor', 'Editor', ARRAY['read','edit']) RETURNING id")).rows[0];
    await query("INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id) VALUES ('DEV', 'user', $1, $2)", [userId, role.id]);
    await query(`INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
      VALUES ($1, $2, $3, TRUE)`, [userId, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, encryptPat('test-pat')]);
    pageId = (await query(`INSERT INTO pages (confluence_id, source, space_key, title, body_html, body_text, version)
      VALUES ('remote-policy', 'confluence', 'DEV', 'Original', '<p>Original</p>', 'Original', 1) RETURNING id`)).rows[0].id;
  });
  afterAll(async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownTestDb();
  });
  const refresh = () => app.inject({ method: 'POST', url: '/api/pages/bulk/sync', payload: { ids: [String(pageId)] } });

  it('does not publish content while a stricter incoming label is deferred by rollout', async () => {
    labels = ['all-ai', 'no-ai'];
    const response = await refresh();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
    expect(calls).toBe(1);
    expect((await query('SELECT title, ai_policy FROM pages WHERE id = $1', [pageId])).rows[0])
      .toEqual({ title: 'Original', ai_policy: 'all' });
    expect((await query("SELECT policy FROM ai_policy_deferred_ingestion WHERE source_id = 'remote-policy'")).rows)
      .toEqual([{ policy: 'none' }]);
  });
  it.each([[], ['all-ai'], ['ai:all', 'local-ai-only']])('preserves a stored no-AI policy and parked status with labels %j', async (...incoming) => {
    labels = incoming as string[];
    await query("UPDATE pages SET ai_policy = 'none', embedding_status = 'policy_blocked' WHERE id = $1", [pageId]);
    const response = await refresh();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ succeeded: 1, failed: 0 });
    expect(calls).toBe(1);
    expect((await query('SELECT title, ai_policy, embedding_status, labels FROM pages WHERE id = $1', [pageId])).rows[0])
      .toMatchObject({ title: 'Refreshed', ai_policy: 'none', embedding_status: 'policy_blocked', labels: ['no-ai'] });
  });
  it('makes no upstream request while Confluence is off', async () => {
    await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [userId]);
    expect((await refresh()).statusCode).toBe(400);
    expect(calls).toBe(0);
  });
});
