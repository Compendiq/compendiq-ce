import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { embedPage } from '../../domains/llm/services/embedding-service.js';
import { insertLocalSpace, insertStandalonePage, insertUser } from './pages.test-helpers.js';

const alpha = '<p>Alpha former content contains enough words for a real embedding request.</p>';
const bravo = '<p>Bravo replacement content contains enough words for a real embedding request.</p>';

describe('embedding content revision publication fence', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let token: string;
  let userId: string;
  let pageId: number;
  let pendingResponse: ServerResponse | undefined;
  let notifyRequest: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += String(part);
    const request = JSON.parse(body) as { input: string[] };
    const vectors = request.input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) }));
    const respond = () => res.end(JSON.stringify({ object: 'list', data: vectors, model: 'synthetic', usage: { prompt_tokens: 1, total_tokens: 1 } }));
    res.setHeader('content-type', 'application/json');
    if (notifyRequest) {
      pendingResponse = res;
      res.once('release', respond);
      notifyRequest();
      notifyRequest = undefined;
    } else respond();
  });

  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    userId = await insertUser('embedding-fence');
    await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)', [userId]);
    await insertLocalSpace('NOTES', userId);
    pageId = await insertStandalonePage('Article', 'private', userId, 'NOTES', { dirty: true });
    await query('UPDATE pages SET body_html = $2, body_text = $3 WHERE id = $1', [pageId, alpha, 'Alpha former content contains enough words for a real embedding request.']);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address');
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
       VALUES ('embedding-fence', $1, 'none', TRUE, TRUE, 'synthetic') RETURNING id`,
      [`http://127.0.0.1:${address.port}/v1`],
    );
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('embedding', $1, 'synthetic') ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`, [provider.rows[0]!.id]);
    app = await buildApp();
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    token = await generateAccessToken({ sub: userId, username: 'embedding-fence', role: 'user' });
  }, 60_000);

  afterAll(async () => {
    pendingResponse?.emit('release');
    await app?.close();
    if (server.listening) { server.close(); await once(server, 'close'); }
    await teardownTestDb();
  });

  it('discards a delayed old body and publishes a subsequent current body', async () => {
    expect(await embedPage(userId, pageId, 'Article', 'NOTES', alpha)).toBeGreaterThan(0);
    const original = await query('SELECT id, chunk_text FROM page_embeddings WHERE page_id = $1 ORDER BY chunk_index', [pageId]);
    expect(original.rows.length).toBeGreaterThan(0);
    const before = await query<{ content_revision: string }>(
      'SELECT content_revision::text FROM pages WHERE id = $1', [pageId],
    );
    const { promise: held, resolve } = Promise.withResolvers<void>();
    notifyRequest = resolve;
    const stale = embedPage(userId, pageId, 'Article', 'NOTES', alpha);
    await held;
    const response = await fetch(`${baseUrl}/api/pages/${pageId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Article', bodyHtml: bravo, version: 1 }),
    });
    expect(response.status, await response.text()).toBe(200);
    pendingResponse!.emit('release');
    pendingResponse = undefined;
    expect(await stale).toBe(0);
    const after = await query<{ body_html: string; embedding_dirty: boolean; content_revision: string; image_analysis_revision: string }>(
      'SELECT body_html, embedding_dirty, content_revision::text, image_analysis_revision::text FROM pages WHERE id = $1', [pageId],
    );
    expect(after.rows[0]).toMatchObject({ body_html: bravo, embedding_dirty: true, image_analysis_revision: '0' });
    expect(BigInt(after.rows[0]!.content_revision)).toBeGreaterThan(BigInt(before.rows[0]!.content_revision));
    const oldChunks = await query('SELECT id, chunk_text FROM page_embeddings WHERE page_id = $1 ORDER BY chunk_index', [pageId]);
    expect(oldChunks.rows).toEqual(original.rows);
    expect(await embedPage(userId, pageId, 'Article', 'NOTES', bravo)).toBeGreaterThan(0);
    const current = await query<{ embedding_dirty: boolean; chunk_text: string }>(
      'SELECT p.embedding_dirty, e.chunk_text FROM pages p JOIN page_embeddings e ON e.page_id = p.id WHERE p.id = $1', [pageId],
    );
    expect(current.rows.length).toBeGreaterThan(0);
    expect(current.rows.every((r) => !r.embedding_dirty && r.chunk_text.includes('Bravo replacement'))).toBe(true);
  }, 30_000);
});
