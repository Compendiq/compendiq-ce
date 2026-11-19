import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { getPool, query } from '../../../core/db/postgres.js';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../../test-db-helper.js';
import { createProvider } from './llm-provider-service.js';
import { loadProviderConfig, resolveArticleUsecaseOnClient } from './llm-provider-resolver.js';
import { chat, type TransportContext } from './openai-compatible-client.js';

const available = await isDbAvailable();
describe.skipIf(!available)('authoritative article model selection', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it('sends assigned and saved explicit models, refuses arbitrary model intent before HTTP', async () => {
    const provider = await createProvider({ name: randomUUID(), baseUrl: 'http://selection.test/v1', authType: 'none', verifySsl: true, defaultModel: 'default' });
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('chat', $1, 'assigned'), ('summary', $1, 'summary-choice')
      ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`, [provider.id]);
    const config = await loadProviderConfig(provider.id);
    const page = (await query(`INSERT INTO pages (title, source, version, visibility) VALUES ('Selection', 'standalone', 1, 'shared') RETURNING id, content_revision`)).rows[0];
    const context: TransportContext = { kind: 'article', stage: {
      provenance: { version: 1, providerId: provider.id, configRevision: config.configRevision!, locality: 'external', pages: [{ pageId: page.id, policy: 'all', policyRevision: 0, contentRevision: Number(page.content_revision) }] },
      userId: null, usecase: 'chat', context: { operation: { operationId: randomUUID(), actor: { kind: 'worker', id: 'model-test' }, source: 'test', cascadeId: null }, stage: 'chat', attempt: 1 },
    } };
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const models: string[] = [];
    agent.get('http://selection.test').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, (options) => {
      models.push(JSON.parse(String(options.body)).model);
      return { choices: [{ message: { content: 'ok' } }] };
    }).persist();
    try {
      await expect(chat(config, 'assigned', [], { transportContext: context })).resolves.toBe('ok');
      context.stage.context.modelSelection = { kind: 'explicit', model: 'summary-choice' };
      await expect(chat(config, 'summary-choice', [], { transportContext: context })).resolves.toBe('ok');
      context.stage.context.modelSelection = { kind: 'explicit', model: 'operator-selected' };
      await expect(chat(config, 'operator-selected', [], { transportContext: context })).resolves.toBe('ok');
      context.stage.context.modelSelection = { kind: 'assigned' };
      await expect(chat(config, 'arbitrary', [], { transportContext: context })).rejects.toThrow();
      expect(models).toEqual(['assigned', 'summary-choice', 'operator-selected']);
    } finally { setGlobalDispatcher(previous); await agent.close(); }
  });

  it.each(['assignment', 'default'] as const)('serializes %s writers until held-client admission ends', async (kind) => {
    const reader = await getPool().connect();
    const writer = await getPool().connect();
    let pending: Promise<unknown> | undefined;
    try {
      await reader.query('BEGIN');
      expect(await resolveArticleUsecaseOnClient(reader, 'chat')).not.toBeNull();
      await writer.query('BEGIN');
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = writer.query(kind === 'assignment'
        ? "UPDATE llm_usecase_assignments SET model = 'successor' WHERE usecase = 'chat'"
        : "UPDATE llm_providers SET default_model = 'successor'");
      await vi.waitFor(async () => {
        expect((await query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0]?.wait_event_type).toBe('Lock');
      });
      await reader.query('COMMIT');
      await pending;
      await writer.query('COMMIT');
    } finally {
      await reader.query('ROLLBACK');
      await pending;
      await writer.query('ROLLBACK');
      reader.release(); writer.release();
    }
  });
});
