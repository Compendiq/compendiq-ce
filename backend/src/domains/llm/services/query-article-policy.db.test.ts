import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { newAiOperation } from '../../../core/enterprise/ai-policy-hooks.js';
import { reformulateQuery } from './multi-query-search.js';
import { hybridSearch, flushSearchAnalytics } from './rag-service.js';
import type { QueryArticleInput } from './query-article-transport.js';

// Exercise the real resolver, SQL, queue and admission. Only HTTP is synthetic.
describe('article-derived retrieval queries', () => {
  const agent = new MockAgent();
  const previous = getGlobalDispatcher();
  let userId: string;
  let input: QueryArticleInput;
  let sent: string[];
  beforeAll(async () => {
    await setupTestDb();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent.get('http://query.test').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, () => {
      sent.push('chat');
      return { choices: [{ message: { content: 'another question\na different question' } }] };
    }).persist();
    agent.get('http://query.test').intercept({ path: '/v1/embeddings', method: 'POST' }).reply(200, () => {
      sent.push('embedding');
      return { data: [{ embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) }] };
    }).persist();
    agent.get('http://query.test').intercept({ path: '/v1/rerank', method: 'POST' }).reply(200, () => {
      sent.push('rerank');
      return { results: [{ index: 0, relevance_score: 0.9 }] };
    }).persist();
  });
  beforeEach(async () => {
    await flushSearchAnalytics();
    await truncateAllTables();
    sent = [];
    userId = (await query<{ id: string }>("INSERT INTO users (username, password_hash) VALUES ('query-reader', 'x') RETURNING id")).rows[0]!.id;
    const providerId = (await query<{ id: string }>(`INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
      VALUES ('external', 'http://query.test/v1', 'none', 'm', TRUE) RETURNING id`)).rows[0]!.id;
    await query("INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('rerank', $1, 'm')", [providerId]);
    const page = (await query<{ id: number; content_revision: string; ai_policy_revision: string }>(`INSERT INTO pages
      (title, source, visibility, owner_id, created_by_user_id, ai_policy)
      VALUES ('Input', 'standalone', 'private', $1, $1, 'local_only') RETURNING id, content_revision, ai_policy_revision`, [userId])).rows[0]!;
    input = { operation: newAiOperation('query-test', { kind: 'user', id: userId }), pages: [{
      pageId: page.id, policy: 'local_only', policyRevision: Number(page.ai_policy_revision), contentRevision: Number(page.content_revision),
    }] };
  });
  afterAll(async () => {
    await flushSearchAnalytics();
    setGlobalDispatcher(previous);
    await agent.close();
    await teardownTestDb();
  });

  it('refuses external paraphrasing of restricted input but permits independent input', async () => {
    expect(await reformulateQuery('restricted selection question', userId, input)).toEqual([]);
    expect(sent).toEqual([]);
    expect(await reformulateQuery('independent question')).toHaveLength(2);
    expect(sent).toEqual(['chat']);
  });

  it('external rerank cannot receive a restricted query even with unrestricted candidates', async () => {
    const { createProvider } = await import('./llm-provider-service.js');
    const local = await createProvider({ name: 'local embedding', baseUrl: 'http://query.test/v1',
      authType: 'none', verifySsl: true, defaultModel: 'm', locality: 'local' }, userId);
    await query("INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('embedding', $1, 'm')", [local.id]);
    for (const title of ['First', 'Second']) {
      const pageId = (await query<{ id: number }>(`INSERT INTO pages (title, body_text, source, visibility)
        VALUES ($1, 'gateway token', 'standalone', 'shared') RETURNING id`, [title])).rows[0]!.id;
      await query(`INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
        VALUES ($1, 0, 'gateway token', $2, $3::jsonb)`, [pageId,
        JSON.stringify(Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)),
        JSON.stringify({ page_title: title, section_title: title, space_key: null })]);
    }
    const options = { queryArticle: input, aiPolicy: { purpose: 'ai', destinationLocality: 'local' } as const,
      rerank: true, recordAnalytics: false };
    const results = await hybridSearch(userId, 'gateway token', 5, null, options);
    expect(results).toHaveLength(2);
    expect(results.every((row) => row.rerankScore === undefined)).toBe(true);
    expect(sent).toEqual(['embedding']);
    await hybridSearch(userId, 'gateway token', 5, null, { ...options, queryArticle: undefined });
    expect(sent).toEqual(['embedding', 'embedding', 'rerank']);
  });

  it('does not send an article query to an external embedder', async () => {
    await hybridSearch(userId, 'restricted selection question', 5, null, {
      queryArticle: input, aiPolicy: { purpose: 'ai', destinationLocality: 'local' }, recordAnalytics: false,
    });
    expect(sent).toEqual([]);
  });
});
