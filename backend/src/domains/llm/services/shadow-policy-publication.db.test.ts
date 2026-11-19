import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { runShadowBackfillJob } from './shadow-migration-service.js';

const available = await isDbAvailable();
describe.skipIf(!available)('shadow HTTP publication policy guards', () => {
  beforeAll(async () => {
    await setupTestDb();
    await query('ALTER TABLE page_embeddings ADD COLUMN IF NOT EXISTS embedding_next vector(1024)');
    await query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_avg_embedding_next vector(1024)');
  });
  beforeEach(async () => { await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it.each(['allowed', 'policy', 'content', 'provider', 'epoch', 'later_batch', 'model', 'candidate', 'image', 'claim'] as const)('%s', async (change) => {
    let mutate = async () => {};
    let requests = 0;
    let handlerError: unknown;
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1) * 0.01);
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        requests++;
        void mutate().then(() => {
          const body = JSON.parse(raw) as { input: string[] };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: vector })) }));
        }).catch((err: unknown) => { handlerError = err; res.writeHead(500); res.end(); });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const provider = (await query(`INSERT INTO llm_providers (name, base_url, auth_type, default_model)
        VALUES ('shadow-test', $1, 'none', 'embedding-model') RETURNING id`, [baseUrl])).rows[0];
      const page = (await query(`INSERT INTO pages (title, source, space_key, body_html, embedding_dirty)
        VALUES ('Shadow test', 'standalone', 'DEV', '<p>Saved article prose</p>', FALSE) RETURNING id`)).rows[0];
      const count = change === 'later_batch' ? 17 : 1;
      for (let i = 0; i < count; i++) {
        await query(`INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding)
          VALUES ($1, $2, 'Saved article prose', $3)`, [page.id, i, JSON.stringify(vector)]);
      }
      const state = { status: 'active', providerId: provider.id, model: 'embedding-model', dimensions: 1024,
        columnType: 'vector(1024)', indexed: false, startedAt: '2026-01-01T00:00:00Z' };
      await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('embedding_shadow_migration', $1)`, [JSON.stringify(state)]);
      mutate = async () => {
        if (change === 'model' || change === 'candidate') await query("UPDATE admin_settings SET setting_value = $1 WHERE setting_key = 'embedding_shadow_migration'", [JSON.stringify({ ...state, ...(change === 'model' ? { model: 'successor' } : { providerId: '00000000-0000-0000-0000-000000000001' }) })]);
        if (change === 'image') await query('UPDATE pages SET image_analysis_revision = image_analysis_revision + 1 WHERE id = $1', [page.id]);
        if (change === 'claim') await query("UPDATE pages SET embedding_status = 'embedding' WHERE id = $1", [page.id]);
        if (change === 'policy' || change === 'later_batch') await query("UPDATE pages SET ai_policy = 'none' WHERE id = $1", [page.id]);
        if (change === 'content') await query("UPDATE pages SET body_html = '<p>Changed</p>' WHERE id = $1", [page.id]);
        if (change === 'provider') await query("UPDATE llm_providers SET base_url = 'http://changed.test/v1' WHERE id = $1", [provider.id]);
        if (change === 'epoch') await query("UPDATE admin_settings SET setting_value = $1 WHERE setting_key = 'embedding_shadow_migration'", [JSON.stringify({ ...state, revertedAt: '2026-01-02T00:00:00Z' })]);
      };
      const result = await runShadowBackfillJob();
      expect(handlerError).toBeUndefined();
      expect(requests).toBe(1);
      const rows = await query('SELECT embedding_next FROM page_embeddings WHERE page_id = $1', [page.id]);
      const current = (await query('SELECT page_avg_embedding_next FROM pages WHERE id = $1', [page.id])).rows[0];
      if (change === 'allowed') {
        expect(result).toEqual({ processed: 1, failed: 0 });
        expect(rows.rows[0].embedding_next).not.toBeNull();
        expect(current.page_avg_embedding_next).not.toBeNull();
      } else {
        expect(result).toEqual({ processed: 0, failed: 0, blocked: 1 });
        expect(rows.rows.every((row) => row.embedding_next === null)).toBe(true);
        expect(current.page_avg_embedding_next).toBeNull();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
