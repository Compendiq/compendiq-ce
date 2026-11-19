import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationTurnAiProvenance } from '@compendiq/contracts';
import { query } from '../../../core/db/postgres.js';
import { newAiOperation } from '../../../core/enterprise/ai-policy-hooks.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { createProvider } from './llm-provider-service.js';
import { admitPageForProvider } from './ai-policy-admission.js';
import { analyzeImage } from './image-analysis-client.js';
import { ArticleStageRefusedError } from './article-stage-admission.js';
import { publishImageAnalysisResult } from './image-analysis-worker.js';

const available = await isDbAvailable();
describe.skipIf(!available)('image HTTP dispatch and publication', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it.each(['policy', 'content', 'provider', 'failure', 'before_dispatch'] as const)(
    'does not publish stale image inference: %s', async (change) => {
      let requests = 0;
      let mutate: () => Promise<void> = async () => {};
      let handlerError: unknown;
      const payload = { schemaVersion: 1, kind: 'screenshot', language: 'en',
        description: 'A database connection error is visible in the application.',
        visibleText: 'Connection refused', limitations: [] };
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          requests++;
          void mutate().then(() => {
            res.writeHead(change === 'failure' ? 500 : 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] }));
          }).catch((err: unknown) => { handlerError = err; res.writeHead(500); res.end(); });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
        const provider = await createProvider({ name: randomUUID(), baseUrl, authType: 'none', verifySsl: true });
        await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
          VALUES ('image_analysis', $1, 'vision') ON CONFLICT (usecase)
          DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`, [provider.id]);
        const page = (await query(`INSERT INTO pages (title, source, version, visibility)
          VALUES ('image HTTP', 'standalone', 1, 'shared') RETURNING id, content_revision`)).rows[0];
        const context = { operation: newAiOperation('image_analysis', { kind: 'worker', id: 'image-regression' }), stage: 'vision', attempt: 1 };
        const admission = await admitPageForProvider(page.id, 'image_analysis', provider.id, 'vision', { ...context, preliminary: true });
        if (!admission.admitted) throw new Error('fixture not admitted');
        const provenance: ConversationTurnAiProvenance = {
          version: 1, providerId: provider.id, configRevision: admission.configRevision, locality: admission.locality,
          pages: [{ pageId: page.id, policy: admission.policy, policyRevision: admission.policyRevision,
            contentRevision: Number(page.content_revision) }],
        };
        const image = (await query(`INSERT INTO page_image_analyses
          (page_id, source, attachment_key, content_hash, format, status)
          VALUES ($1, 'local', 'image.png', 'hash', 'png', 'pending') RETURNING id`, [page.id])).rows[0];
        mutate = async () => {
          if (change === 'provider') {
            await query("UPDATE llm_providers SET base_url = 'http://changed.test/v1' WHERE id = $1", [provider.id]);
          } else if (change === 'content') {
            await query('UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1', [page.id]);
          } else {
            await query("UPDATE pages SET ai_policy = 'none' WHERE id = $1", [page.id]);
          }
        };
        if (change === 'before_dispatch') await mutate();
        const inference = analyzeImage({
          bytes: Buffer.from('image bytes'), mimeType: 'image/png',
          identity: { providerId: provider.id, model: 'vision', baseUrl }, maxOutputTokens: 8192,
          articleStage: { provenance, userId: null, usecase: 'image_analysis', context },
        });
        if (change === 'before_dispatch') {
          await expect(inference).rejects.toBeInstanceOf(ArticleStageRefusedError);
          expect(requests).toBe(0);
        } else {
          const outcome = await inference;
          expect(handlerError).toBeUndefined();
          expect(requests).toBe(1);
          expect(outcome.ok).toBe(change !== 'failure');
          const published = await publishImageAnalysisResult(provenance,
            `UPDATE page_image_analyses SET payload = $2::jsonb, error = $3 WHERE id = $1 RETURNING id`,
            [image.id, outcome.ok ? JSON.stringify(outcome.payload) : null, outcome.ok ? null : outcome.class], async () => {});
          expect(published.rowCount).toBe(0);
        }
        expect((await query('SELECT status, payload, error, attempts FROM page_image_analyses WHERE id = $1', [image.id])).rows[0])
          .toMatchObject({ status: 'pending', payload: null, error: null, attempts: 0 });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
