import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { getPool, query } from '../../../core/db/postgres.js';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../../test-db-helper.js';
import { createProvider } from './llm-provider-service.js';
import { admitArticleStage, validateArticleStageOnClient } from './article-stage-admission.js';
import { getEnterprisePlugin } from '../../../core/enterprise/loader.js';
import type { AiDecisionEvent, ConversationTurnAiProvenance } from '@compendiq/contracts';

const available = await isDbAvailable();
describe.skipIf(!available)('serialized article stage admission', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });
  afterEach(() => vi.restoreAllMocks());

  it('refuses missing transport revisions and queued endpoint edits before outbound HTTP', async () => {
    const { generateEmbedding } = await import('./openai-compatible-client.js');
    const { loadProviderConfig } = await import('./llm-provider-resolver.js');
    const { enqueue, setConcurrency, getMetrics } = await import('./llm-queue.js');
    const { getProviderBreaker } = await import('../../../core/services/circuit-breaker.js');
    const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
    const agent = new MockAgent();
    agent.disableNetConnect();
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(agent);
    const provider = await createProvider({ name: randomUUID(), baseUrl: 'http://stage.test/v1', authType: 'none', verifySsl: true });
    const config = await loadProviderConfig(provider.id);
    const rows = await query<{ id: number; content_revision: string }>(`INSERT INTO pages (title, source, version, visibility) VALUES ('Queued', 'standalone', 1, 'shared') RETURNING id, content_revision`);
    const page = rows.rows[0]!;
    const provenance: ConversationTurnAiProvenance = { version: 1, providerId: provider.id, configRevision: config.configRevision!, locality: 'external',
      pages: [{ pageId: page.id, policy: 'all', policyRevision: 0, contentRevision: Number(page.content_revision) }] };
    const operation = { operationId: randomUUID(), actor: { kind: 'worker' as const, id: 'queue-test' }, source: 'test', cascadeId: null };
    const events: AiDecisionEvent[] = [];
    vi.spyOn(getEnterprisePlugin(), 'onAiDecision').mockImplementation((event) => { events.push(event); });
    let sent = 0;
    agent.get('http://stage.test').intercept({ path: '/v1/embeddings', method: 'POST' }).reply(200, () => {
      sent++;
      return { data: [{ embedding: [1, 2] }] };
    }).persist();
    const stage = { provenance, userId: null, usecase: 'embedding', context: { operation, stage: 'embedding', attempt: 1 } };
    let release = () => {};
    const oldConcurrency = getMetrics().concurrency;
    try {
      await expect(generateEmbedding({ ...config, configRevision: undefined }, 'm', 'article', { kind: 'article', stage })).rejects.toThrow();
      expect(sent).toBe(0);
      expect(events.at(-1)).toMatchObject({ decision: 'blocked', reason: 'transport_binding_unavailable', operationId: operation.operationId });
      setConcurrency(1);
      const held = enqueue(async () => new Promise<void>((resolve) => { release = resolve; }));
      await vi.waitFor(() => expect(getMetrics().activeCount).toBe(1));
      const queued = generateEmbedding(config, 'm', 'article', { kind: 'article', stage });
      const rejected = expect(queued).rejects.toThrow();
      await vi.waitFor(() => expect(getMetrics().pendingCount).toBe(1));
      await query("UPDATE llm_providers SET base_url = 'http://changed.test/v1' WHERE id = $1", [provider.id]);
      release();
      await held;
      await rejected;
      expect(sent).toBe(0);
      expect(events.at(-1)).toMatchObject({ decision: 'blocked', operationId: operation.operationId });
      expect(getProviderBreaker(provider.id).getStatus().failureCount).toBe(0);
    } finally {
      release();
      setConcurrency(oldConcurrency);
      setGlobalDispatcher(previous);
      await agent.close();
    }
  });

  it('records the authoritative model on admission and on a same-provider model change', async () => {
    const { authorizeArticleDispatch } = await import('./article-stage-admission.js');
    const { loadProviderConfig } = await import('./llm-provider-resolver.js');
    const provider = await createProvider({ name: randomUUID(), baseUrl: 'http://model-evidence.test/v1', authType: 'none', verifySsl: true });
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('summary', $1, 'first-model')
      ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`, [provider.id]);
    const config = await loadProviderConfig(provider.id);
    const rows = await query<{ id: number; content_revision: string }>(`INSERT INTO pages (title, source, version, visibility)
      VALUES ('Private title not for evidence', 'standalone', 1, 'shared') RETURNING id, content_revision`);
    const page = rows.rows[0]!;
    const provenance: ConversationTurnAiProvenance = { version: 1, providerId: provider.id, configRevision: config.configRevision!, locality: 'external',
      pages: [{ pageId: page.id, policy: 'all', policyRevision: 0, contentRevision: Number(page.content_revision) }] };
    const operation = { operationId: randomUUID(), actor: { kind: 'worker' as const, id: 'model-evidence-test' }, source: 'test', cascadeId: null };
    const events: AiDecisionEvent[] = [];
    vi.spyOn(getEnterprisePlugin(), 'onAiDecision').mockImplementation((event) => { events.push(event); });
    await admitArticleStage(provenance, null, 'summary', undefined, { operation, stage: 'summary', attempt: 1 }, undefined, undefined, true);
    await authorizeArticleDispatch(config, provenance, null, 'summary', { operation, stage: 'summary', attempt: 1 }, 'first-model', true);
    expect(events).toEqual([]);
    await authorizeArticleDispatch(config, provenance, null, 'summary', { operation, stage: 'summary', attempt: 1 }, 'first-model');
    await query("UPDATE llm_usecase_assignments SET model = 'second-model' WHERE usecase = 'summary'");
    await expect(authorizeArticleDispatch(config, provenance, null, 'summary', { operation, stage: 'summary', attempt: 2 }, 'first-model')).rejects.toThrow();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ operationId: operation.operationId, attempt: 1, decision: 'admitted', provider: { providerId: provider.id, model: 'first-model' } });
    expect(events[1]).toMatchObject({ operationId: operation.operationId, attempt: 2, decision: 'blocked', provider: { providerId: provider.id, model: 'second-model' } });
    expect(events[0]!.eventId).not.toBe(events[1]!.eventId);
    expect(JSON.stringify(events)).not.toContain('Private title');
    expect(JSON.stringify(events)).not.toContain('model-evidence.test');
  });

  it('records unknown state when a real SQL error aborts admission', async () => {
    const events: AiDecisionEvent[] = [];
    vi.spyOn(getEnterprisePlugin(), 'onAiDecision').mockImplementation((event) => { events.push(event); });
    const provenance: ConversationTurnAiProvenance = { version: 1, providerId: randomUUID(), configRevision: 1, locality: 'external',
      pages: [{ pageId: 2 ** 40, policy: 'all', policyRevision: 0, contentRevision: 0 }] };
    await expect(admitArticleStage(provenance, null, 'embedding')).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'blocked', reason: 'policy_unavailable', articles: [{ pageId: 2 ** 40, policy: null, policyRevision: null, contentRevision: null }], provider: { configRevision: null } });
  });

  it('holds provider revision through finalization and rejects stale content and endpoint bindings', async () => {
    const provider = await createProvider({ name: randomUUID(), baseUrl: 'http://127.0.0.1:1234/v1', authType: 'none', verifySsl: false });
    const rows = await query<{ id: number; content_revision: string }>(`INSERT INTO pages (title, source, version, visibility) VALUES ('a', 'standalone', 1, 'shared'), ('b', 'standalone', 1, 'shared') RETURNING id, content_revision`);
    const provenance: ConversationTurnAiProvenance = { version: 1, providerId: provider.id, configRevision: provider.configRevision!, locality: 'external',
      pages: rows.rows.map((r) => ({ pageId: r.id, policy: 'all', policyRevision: 0, contentRevision: Number(r.content_revision) })) };
    const events: AiDecisionEvent[] = [];
    vi.spyOn(getEnterprisePlugin(), 'onAiDecision').mockImplementation((event) => { events.push(event); });
    const operation = { operationId: randomUUID(), actor: { kind: 'worker' as const, id: 'stage-test' }, source: 'test', cascadeId: null };
    await admitArticleStage(provenance, null, 'embedding', undefined, { operation, stage: 'embedding', attempt: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ...operation, decision: 'admitted', articles: provenance.pages, provider: { declaredLocality: 'external', configRevision: 1 } });

    const reader = await getPool().connect();
    const writer = await getPool().connect();
    try {
      await reader.query('BEGIN');
      await validateArticleStageOnClient(reader, provenance, null);
      await writer.query('BEGIN');
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const edit = writer.query("UPDATE llm_providers SET base_url = 'http://127.0.0.1:4321/v1' WHERE id = $1", [provider.id]);
      await vi.waitFor(async () => {
        const waiting = await query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
        expect(waiting.rows[0]?.wait_event_type).toBe('Lock');
      });
      await reader.query('COMMIT');
      await edit;
      await writer.query('COMMIT');
      await expect(admitArticleStage(provenance, null, 'embedding')).rejects.toThrow();
      provenance.configRevision = 2;
      await query('UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1', [rows.rows[0]!.id]);
      let published = false;
      await expect(admitArticleStage(provenance, null, 'embedding', async () => { published = true; })).rejects.toThrow();
      expect(published).toBe(false);
    } finally {
      await reader.query('ROLLBACK'); await writer.query('ROLLBACK'); reader.release(); writer.release();
    }
  });
});
