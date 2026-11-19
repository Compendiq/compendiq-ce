import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { query } from '../../../core/db/postgres.js';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../../test-db-helper.js';
import { createProvider } from './llm-provider-service.js';
import { historicalVersionDigest } from './article-stage-admission.js';
import { loadProviderConfig } from './llm-provider-resolver.js';
import { generateEmbedding, chat, streamChat, type ProviderConfig, type TransportContext } from './openai-compatible-client.js';

const available = await isDbAvailable();
describe.skipIf(!available)('article transport concrete binding', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it('refuses missing/malformed context and substituted transport/model before HTTP; sends saved binding', async () => {
    const provider = await createProvider({ name: randomUUID(), baseUrl: 'http://binding.test/v1', authType: 'none', verifySsl: true, defaultModel: 'm' });
    await query("INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('embedding', $1, 'm') ON CONFLICT (usecase) DO UPDATE SET provider_id = $1, model = 'm'", [provider.id]);
    const config = await loadProviderConfig(provider.id);
    const pages = await query<{ id: number; content_revision: string }>(
      "INSERT INTO pages (title, source, version, visibility) VALUES ('Binding', 'standalone', 1, 'shared') RETURNING id, content_revision",
    );
    const page = pages.rows[0]!;
    const context: TransportContext = { kind: 'article', stage: {
      provenance: { version: 1, providerId: provider.id, configRevision: config.configRevision!, locality: 'external',
        pages: [{ pageId: page.id, policy: 'all', policyRevision: 0, contentRevision: Number(page.content_revision) }] },
      userId: null, usecase: 'embedding',
      context: { operation: { operationId: randomUUID(), actor: { kind: 'worker', id: 'binding-test' }, source: 'test', cascadeId: null }, stage: 'embedding', attempt: 1 },
    } };
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    let sent = 0;
    for (const origin of ['http://binding.test', 'http://substituted.test']) {
      agent.get(origin).intercept({ path: '/v1/embeddings', method: 'POST' }).reply(200, () => {
        sent++;
        return { data: [{ embedding: [1, 2] }] };
      }).persist();
    }
    try {
      for (const malformed of [undefined, null, {}, { kind: 'article' }, { kind: 'non_article', purpose: 'unknown' }]) {
        const invalid = malformed as TransportContext;
        await expect(generateEmbedding(config, 'm', 'article bytes', invalid)).rejects.toThrow();
        await expect(chat(config, 'm', [], { transportContext: invalid })).rejects.toThrow();
        await expect(streamChat(config, 'm', [], undefined, { transportContext: invalid }).next()).rejects.toThrow();
        expect(sent).toBe(0);
      }
      const substitutions: Partial<ProviderConfig>[] = [
        { baseUrl: 'http://substituted.test/v1' }, { apiKey: 'substituted' },
        { authType: 'bearer' }, { verifySsl: false },
      ];
      for (const substitution of substitutions) {
        await expect(generateEmbedding({ ...config, ...substitution }, 'm', 'article bytes', context)).rejects.toThrow();
        expect(sent).toBe(0);
      }
      await expect(generateEmbedding(config, 'spoofed-model', 'article bytes', context)).rejects.toThrow();
      expect(sent).toBe(0);
      await expect(generateEmbedding(config, 'm', 'article bytes', context)).resolves.toEqual([[1, 2]]);
      expect(sent).toBe(1);
      const version = await query<{ id: string }>(
        "INSERT INTO page_versions (page_id, version_number, title, body_html, body_text) VALUES ($1, 1, 'Old', '<p>old</p>', 'old') RETURNING id", [page.id],
      );
      context.stage.context.historicalVersions = [{ pageId: page.id, versionId: version.rows[0]!.id,
        versionNumber: 1, digest: historicalVersionDigest('Old', '<p>old</p>', 'old') }];
      await query("UPDATE page_versions SET body_html = '<p>replacement</p>' WHERE id = $1", [version.rows[0]!.id]);
      await expect(generateEmbedding(config, 'm', 'old historical bytes', context)).rejects.toThrow();
      expect(sent).toBe(1);
      delete context.stage.context.historicalVersions;
      await query('UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1', [page.id]);
      await expect(generateEmbedding(config, 'm', 'old article bytes', context)).rejects.toThrow();
      expect(sent).toBe(1);
    } finally {
      setGlobalDispatcher(previous);
      await agent.close();
    }
  });
});
