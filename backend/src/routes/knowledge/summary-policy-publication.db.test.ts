import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { runSummaryBatch } from '../../domains/knowledge/services/summary-worker.js';
import { processBatch } from '../../domains/knowledge/services/quality-worker.js';

const available = await isDbAvailable();
describe.skipIf(!available)('summary HTTP publication revision guards', () => {
  let redis: RedisClientType;
  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType;
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);
  });
  beforeEach(async () => { await truncateAllTables(); await redis.flushDb(); });
  afterAll(async () => { await redis?.quit(); await teardownTestDb(); });

  describe.each(['summary', 'quality'] as const)('%s', (worker) => {
  it.each(['allowed', 'policy', 'content', 'provider', 'assignment', 'failed_content'] as const)('%s', async (change) => {
    let mutate = async () => {};
    let requests = 0;
    let handlerError: unknown;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests++;
        void mutate().then(() => {
          if (change === 'failed_content') { res.writeHead(500); res.end('{}'); return; }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: worker === 'summary' ? 'A useful generated summary.' : '## Overall Quality Score: 75/100\n## Completeness: 75/100\n## Clarity: 75/100\n## Structure: 75/100\n## Accuracy: 75/100\n## Readability: 75/100\n## Summary\nA useful generated summary.' } }] }) + '\n\ndata: [DONE]\n\n');
        }).catch((err: unknown) => { handlerError = err; res.writeHead(500); res.end(); });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const provider = (await query(`INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
        VALUES ('summary-test', $1, 'none', 'summary-model', TRUE) RETURNING id`, [baseUrl])).rows[0];
      const page = (await query(`INSERT INTO pages (title, source, body_text, summary_status)
        VALUES ('Summary test', 'standalone', $1, 'pending') RETURNING id`, ['Authored content. '.repeat(20)])).rows[0];
      mutate = async () => {
        if (change === 'policy') await query("UPDATE pages SET ai_policy = 'none', summary_status = 'policy_blocked', quality_status = 'policy_blocked' WHERE id = $1", [page.id]);
        if (change === 'content' || change === 'failed_content') await query("UPDATE pages SET content_revision = content_revision + 1, summary_status = 'pending', quality_status = 'pending' WHERE id = $1", [page.id]);
        if (change === 'assignment') await query('INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ($1, $2, $3)', [worker, provider.id, 'successor-model']);
        if (change === 'provider') await query("UPDATE llm_providers SET base_url = 'http://changed.test/v1' WHERE id = $1", [provider.id]);
      };
      const result = await (worker === 'summary' ? runSummaryBatch() : processBatch());
      expect(handlerError).toBeUndefined();
      expect(requests).toBe(1);
      const row = (await query('SELECT summary_text, summary_status, summary_retry_count, quality_summary, quality_status, quality_retry_count FROM pages WHERE id = $1', [page.id])).rows[0];
      expect(result).toEqual({ processed: change === 'allowed' ? 1 : 0, errors: 0 });
      expect(row[`${worker}_retry_count`]).toBe(0);
      const text = worker === 'summary' ? row.summary_text : row.quality_summary;
      if (change === 'allowed') expect(text).toContain('A useful generated summary.');
      else {
        expect(text).toBeNull();
        expect(row[`${worker}_status`]).toBe(change === 'policy' ? 'policy_blocked' : (change === 'provider' || change === 'assignment') ? (worker === 'summary' ? 'summarizing' : 'analyzing') : 'pending');
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  });
});
