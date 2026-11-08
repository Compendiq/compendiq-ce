import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { isAiPolicyEnforcementAvailable } from '../../core/services/ai-policy-service.js';
import { runNotionImport } from '../../domains/knowledge/services/notion-import-service.js';
import { NotionClient } from '../../domains/knowledge/services/notion-client.js';
import { startFakeNotionServer } from '../../domains/knowledge/services/__fixtures__/fake-notion-server.js';

const available = await isDbAvailable();
describe.skipIf(!available)('Notion durable policy deferral at the HTTP boundary', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it.each([false, true])('retains observed intent after upstream removal (existing=%s)', async (existing) => {
    const actor = randomUUID();
    const sourceId = randomUUID();
    await query(`INSERT INTO users (id, username, password_hash, role) VALUES ($1::uuid,$1::text,'x','user')`, [actor]);
    let pageId: number | undefined;
    if (existing) {
      pageId = (await query<{ id: number }>(`INSERT INTO pages
        (title, source, visibility, created_by_user_id, notion_page_id, body_html, body_text)
        VALUES ('Original','standalone','private',$1,$2,'<p>Original</p>','Original') RETURNING id`,
      [actor, sourceId])).rows[0]!.id;
    }
    const page = {
      object: 'page', id: sourceId, last_edited_time: '2026-01-01T00:00:00Z',
      properties: { Tags: { type: 'multi_select', multi_select: [{ name: 'no-ai' }] } },
    };
    const server = await startFakeNotionServer({ validToken: 'test-token', pages: { [sourceId]: page }, blockChildren: {
      [sourceId]: [{ object: 'block', id: 'paragraph', type: 'paragraph', paragraph: {
        rich_text: [{ type: 'text', plain_text: 'New body', text: { content: 'New body' } }],
      } }],
    } });
    try {
      expect(isAiPolicyEnforcementAvailable()).toBe(false);
      const client = new NotionClient('test-token', { baseUrl: server.baseUrl });
      const input = { userId: actor, client, pageIds: [sourceId], visibility: 'private' as const, overwriteExisting: true };
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runNotionImport(input);
        expect(result[0]).toMatchObject({ status: 'fail' });
        expect(result[0]!.reason).toContain('ai_policy_enforcement_unavailable');
        page.properties.Tags.multi_select = [];
        page.last_edited_time = '2026-01-02T00:00:00Z';
      }
      const observations = await query(`SELECT observed_revision, policy, applied_at FROM ai_policy_deferred_ingestion
        WHERE source='notion' AND source_scope=$1 AND source_id=$2 ORDER BY observed_revision`,
      [actor, sourceId.replace(/-/g, '')]);
      expect(observations.rows).toEqual([
        { observed_revision: '2026-01-01T00:00:00Z', policy: 'none', applied_at: null },
        { observed_revision: '2026-01-02T00:00:00Z', policy: 'none', applied_at: null },
      ]);
      const pages = await query('SELECT id, ai_policy, ai_policy_revision, body_text FROM pages WHERE created_by_user_id=$1', [actor]);
      expect(pages.rows).toEqual(existing ? [{ id: pageId, ai_policy: 'all', ai_policy_revision: '0', body_text: 'Original' }] : []);
      expect(server.requests.some((request) => request.url.startsWith('/files/'))).toBe(false);
    } finally { await server.close(); }
  });
});
