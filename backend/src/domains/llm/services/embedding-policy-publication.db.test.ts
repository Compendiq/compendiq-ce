import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { embedPage } from './embedding-service.js';

const available = await isDbAvailable();
describe.skipIf(!available)('embedding HTTP publication policy guards', () => {
  beforeAll(async () => { await setupTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it.each(['allowed', 'policy', 'content', 'provider', 'stale_input', 'later_batch', 'context_policy', 'context_content', 'context_provider', 'context_allowed', 'assignment', 'image', 'claim', 'shadow_model', 'shadow_image', 'shadow_claim'] as const)('%s', async (change) => {
    let mutate = async () => {};
    let requests = 0;
    let handlerError: unknown;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        requests++;
        void mutate().then(() => {
          if (change.startsWith('context_')) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'context length exceeded' } }));
            return;
          }
          const body = JSON.parse(raw) as { input: string[] };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1) * 0.01) })) }));
        }).catch((err: unknown) => { handlerError = err; res.writeHead(500); res.end(); });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const provider = (await query(`INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
        VALUES ('embedding-test', $1, 'none', 'embedding-model', TRUE) RETURNING id`, [baseUrl])).rows[0];
      const body = change === 'later_batch'
        ? Array.from({ length: 12 }, (_, i) => `<h2>Section ${i}</h2><p>${'Substantive article prose. '.repeat(80)}</p>`).join('')
        : '<p>Substantive article prose that is long enough to embed.</p>';
      const page = (await query(`INSERT INTO pages (title, source, space_key, body_html, embedding_dirty)
        VALUES ('Embedding test', 'standalone', 'DEV', $1, TRUE) RETURNING id`, [body])).rows[0];
      if (change.startsWith('shadow_')) {
        await query('ALTER TABLE page_embeddings ADD COLUMN IF NOT EXISTS embedding_next vector(1024)');
        await query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_avg_embedding_next vector(1024)');
        await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('embedding_shadow_migration', $1)`, [JSON.stringify({ status: 'active', providerId: provider.id, model: 'embedding-model', dimensions: 1024, startedAt: '2026-01-01' })]);
      }
      mutate = async () => {
        if (requests === 2 && change === 'shadow_model') await query(`UPDATE admin_settings SET setting_value = jsonb_set(setting_value::jsonb, '{model}', '"successor"')::text WHERE setting_key = 'embedding_shadow_migration'`);
        if (requests === 2 && change === 'shadow_image') await query('UPDATE pages SET image_analysis_revision = image_analysis_revision + 1 WHERE id = $1', [page.id]);
        if (requests === 2 && change === 'shadow_claim') await query("UPDATE pages SET embedding_status = 'embedding' WHERE id = $1", [page.id]);
        if (change === 'assignment') await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
          VALUES ('embedding', $1, 'successor-model') ON CONFLICT (usecase) DO UPDATE SET model = EXCLUDED.model`, [provider.id]);
        if (change === 'image') await query('UPDATE pages SET image_analysis_revision = image_analysis_revision + 1 WHERE id = $1', [page.id]);
        if (change === 'claim') await query("UPDATE pages SET embedding_status = 'embedding' WHERE id = $1", [page.id]);
        if (change === 'policy' || change === 'later_batch' || change === 'context_policy') await query("UPDATE pages SET ai_policy = 'none', embedding_status = 'policy_blocked' WHERE id = $1", [page.id]);
        if (change === 'content' || change === 'context_content') await query('UPDATE pages SET body_html = $2 WHERE id = $1', [page.id, '<p>Changed content</p>']);
        if (change === 'provider' || change === 'context_provider') await query("UPDATE llm_providers SET base_url = 'http://changed.test/v1' WHERE id = $1", [provider.id]);
      };
      const count = await embedPage('worker', page.id, 'Embedding test', 'DEV', change === 'stale_input' ? '<p>Old content</p>' : body);
      expect(handlerError).toBeUndefined();
      expect(requests).toBe(change === 'stale_input' ? 0 : change.startsWith('shadow_') ? 2 : 1);
      const rows = await query('SELECT chunk_text FROM page_embeddings WHERE page_id = $1', [page.id]);
      const current = (await query('SELECT embedding_dirty, embedding_status, page_avg_embedding FROM pages WHERE id = $1', [page.id])).rows[0];
      if (change === 'allowed') {
        expect(count).toBeGreaterThan(0);
        expect(rows.rows).toHaveLength(count);
        expect(current.embedding_status).toBe('embedded');
      } else {
        expect(count).toBe(0);
        expect(rows.rows).toHaveLength(0);
        expect(current.page_avg_embedding).toBeNull();
        expect(current.embedding_dirty).toBe(true);
        if (change === 'context_allowed') expect(current.embedding_status).toBe('failed');
        else if (change.startsWith('context_')) expect(current.embedding_status).not.toBe('failed');
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
