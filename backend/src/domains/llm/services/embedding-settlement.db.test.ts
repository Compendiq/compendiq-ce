import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { captureEmbeddingArticle, settleEmbeddingArticle } from './embedding-article-stage.js';
import { embedPage, processDirtyPages } from './embedding-service.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getProviderBreaker } from '../../../core/services/circuit-breaker.js';

import { createClient } from 'redis';
import { setRedisClient, forceReleaseEmbeddingLock } from '../../../core/services/redis-cache.js';

const available = await isDbAvailable();
const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
describe.skipIf(!available)('non-inference embedding settlement', () => {
  beforeAll(async () => { await setupTestDb(); await redis.connect(); setRedisClient(redis); });
  beforeEach(async () => { await truncateAllTables(); await forceReleaseEmbeddingLock('__reembed_all__'); });
  afterAll(async () => { await redis.quit(); setRedisClient(null); await teardownTestDb(); });
  it.each(['ordinary', 'content', 'policy', 'claim', 'breaker_content', 'breaker_policy', 'breaker_claim'] as const)(
    'worker failure settlement: %s', async (change) => {
      let requests = 0;
      let mutation = async () => {};
      let failure: unknown;
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => { requests++; void mutation().then(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{}');
        }).catch((err: unknown) => { failure = err; res.writeHead(500); res.end(); }); });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const provider = (await query(`INSERT INTO llm_providers (name, base_url, auth_type, is_default, default_model)
          VALUES ('worker', $1, 'none', TRUE, 'embed') RETURNING id`,
        [`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`])).rows[0];
        const page = (await query(`INSERT INTO pages (title, source, space_key, body_html, embedding_dirty)
          VALUES ('Worker', 'standalone', 'DEV', '<p>Substantial authored content for the worker.</p>', TRUE) RETURNING id`)).rows[0];
        const supersede = async () => {
          if (change.endsWith('content')) await query("UPDATE pages SET body_html = '<p>Successor authored content</p>', embedding_status = 'not_embedded' WHERE id = $1", [page.id]);
          if (change.endsWith('policy')) await query("UPDATE pages SET ai_policy = 'none', embedding_status = 'policy_blocked' WHERE id = $1", [page.id]);
          if (change.endsWith('claim')) await query("UPDATE pages SET embedding_status = 'embedding', embedding_error = 'successor' WHERE id = $1", [page.id]);
        };
        mutation = supersede;
        if (change.startsWith('breaker_')) {
          const breaker = getProviderBreaker(provider.id);
          breaker.recordFailure(); breaker.recordFailure(); breaker.recordFailure();
        }
        let successor: Promise<void> | undefined;
        const result = await processDirtyPages('__reembed_all__', (event) => {
          if (event.type === 'waiting' && !successor) {
            successor = supersede().then(() => { getProviderBreaker(provider.id).reset(); });
          }
        });
        await successor;
        expect(failure).toBeUndefined();
        if (change.startsWith('breaker_')) {
          expect(successor).toBeDefined();
          expect(requests).toBe(0);
          expect(result).toEqual({ processed: 0, errors: 0 });
          const row = (await query('SELECT embedding_status, embedding_error FROM pages WHERE id = $1', [page.id])).rows[0];
          expect(row.embedding_status).toBe(change.endsWith('policy') ? 'policy_blocked' : change.endsWith('claim') ? 'embedding' : 'not_embedded');
          if (change.endsWith('claim')) expect(row.embedding_error).toBe('successor');
        } else {
          expect(requests).toBe(1);
          expect(result.errors).toBe(change === 'ordinary' ? 1 : 0);
          const row = (await query('SELECT embedding_status, embedding_error, embedding_dirty FROM pages WHERE id = $1', [page.id])).rows[0];
          expect(row.embedding_dirty).toBe(true);
          expect(row.embedding_status).toBe(change === 'ordinary' ? 'failed' : change === 'policy' ? 'policy_blocked' : change === 'claim' ? 'embedding' : 'not_embedded');
          if (change === 'claim') expect(row.embedding_error).toBe('successor');
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 45000);

  it('does not clear a policy block for short input', async () => {
    const page = (await query(`INSERT INTO pages (title, source, space_key, body_html, ai_policy, embedding_status, embedding_dirty)
      VALUES ('Stub', 'standalone', 'DEV', '<p>x</p>', 'none', 'policy_blocked', TRUE) RETURNING id`)).rows[0];
    expect(await embedPage('worker', page.id, 'Stub', 'DEV', '<p>x</p>')).toBe(0);
    const current = (await query('SELECT embedding_dirty, embedding_status FROM pages WHERE id = $1', [page.id])).rows[0];
    expect(current).toMatchObject({ embedding_dirty: true, embedding_status: 'policy_blocked' });
  });
  it.each(['unchanged', 'content', 'policy', 'deleted', 'claim', 'image'] as const)('%s snapshot', async (change) => {
    const page = (await query(`INSERT INTO pages (title, source, space_key, body_html, embedding_dirty)
      VALUES ('Stub', 'standalone', 'DEV', '<p>x</p>', TRUE) RETURNING id`)).rows[0];
    const snapshot = await captureEmbeddingArticle(page.id, 'Stub', 'DEV', '<p>x</p>');
    if (change === 'content') await query("UPDATE pages SET body_html = '<p>Successor content</p>' WHERE id = $1", [page.id]);
    if (change === 'policy') await query("UPDATE pages SET ai_policy = 'none', embedding_status = 'policy_blocked' WHERE id = $1", [page.id]);
    if (change === 'deleted') await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [page.id]);
    if (change === 'claim') await query("UPDATE pages SET embedding_status = 'embedding' WHERE id = $1", [page.id]);
    if (change === 'image') await query('UPDATE pages SET image_analysis_revision = image_analysis_revision + 1 WHERE id = $1', [page.id]);
    let called = false;
    const settled = await settleEmbeddingArticle(snapshot, async (client) => {
      called = true;
      await client.query("UPDATE pages SET embedding_dirty = FALSE, embedding_status = 'not_embedded' WHERE id = $1", [page.id]);
    });
    expect(settled).toBe(change === 'unchanged');
    expect(called).toBe(change === 'unchanged');
    const current = (await query('SELECT embedding_dirty, embedding_status FROM pages WHERE id = $1', [page.id])).rows[0];
    expect(current.embedding_dirty).toBe(change !== 'unchanged');
    if (change === 'policy') expect(current.embedding_status).toBe('policy_blocked');
  });
});
