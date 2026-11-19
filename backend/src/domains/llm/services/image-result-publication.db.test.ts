import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { createProvider } from './llm-provider-service.js';
import { admitPageForProvider } from './ai-policy-admission.js';
import { publishImageAnalysisResult } from './image-analysis-worker.js';
import type { ConversationTurnAiProvenance } from '@compendiq/contracts';

const available = await isDbAvailable();
describe.skipIf(!available)('image completion publication binding', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it.each(['policy', 'content', 'provider'] as const)('rejects success and failure after %s changes', async (change) => {
    const provider = await createProvider({ name: randomUUID(), baseUrl: 'http://images.test/v1', authType: 'none', verifySsl: true });
    const page = (await query(`INSERT INTO pages (title, source, version, visibility)
      VALUES ('image', 'standalone', 1, 'shared') RETURNING id, content_revision`)).rows[0];
    const admission = await admitPageForProvider(page.id, 'image_analysis', provider.id, 'vision', {
      operation: { operationId: randomUUID(), actor: { kind: 'worker', id: 'image-test' }, source: 'image_test', cascadeId: null },
      stage: 'vision', attempt: 1, preliminary: true,
    });
    if (!admission.admitted) throw new Error('fixture not admitted');
    const provenance: ConversationTurnAiProvenance = {
      version: 1, providerId: provider.id, configRevision: admission.configRevision, locality: admission.locality,
      pages: [{ pageId: page.id, policy: admission.policy, policyRevision: admission.policyRevision, contentRevision: Number(page.content_revision) }],
    };
    const image = (await query(`INSERT INTO page_image_analyses
      (page_id, source, attachment_key, content_hash, format, status)
      VALUES ($1, 'local', 'image.png', 'hash', 'png', 'pending') RETURNING id`, [page.id])).rows[0];
    const publish = (status: string) => publishImageAnalysisResult(provenance,
      'UPDATE page_image_analyses SET status = $2 WHERE id = $1 RETURNING id', [image.id, status], async () => {});
    expect((await publish('pending')).rowCount).toBe(1);
    if (change === 'policy') await query("UPDATE pages SET ai_policy = 'local_only' WHERE id = $1", [page.id]);
    if (change === 'content') await query('UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1', [page.id]);
    if (change === 'provider') await query("UPDATE llm_providers SET base_url = 'http://changed.test/v1' WHERE id = $1", [provider.id]);
    expect((await publish('analyzed')).rowCount).toBe(0);
    expect((await publish('failed_terminal')).rowCount).toBe(0);
    expect((await query('SELECT status FROM page_image_analyses WHERE id = $1', [image.id])).rows[0].status).toBe('pending');
  });
});
