import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type * as Undici from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getPool, query } from '../../core/db/postgres.js';
import { confluenceToHtml, htmlToConfluence, htmlToMarkdown, htmlToText, protectMedia } from '../../core/services/content-converter.js';
import { oracleElements, oracleUrlLinks } from '../../core/services/__fixtures__/storage-oracle.js';
import {
  lockPageLifecycle,
  reconcilePageWriteIntent,
} from '../../core/services/page-write-admission.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { invalidateRbacCache } from '../../core/services/rbac-service.js';
import { encryptPat } from '../../core/utils/crypto.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from '../knowledge/pages.test-helpers.js';
import { llmConversationRoutes } from './llm-conversations.js';

// The Confluence REST call is the only non-auth boundary controlled here. All
// persistence, admission, conversion, cache, audit, and collaboration behavior
// below is production code backed by the real test PostgreSQL and Redis.
const mockHttpRequest = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return { ...actual, request: mockHttpRequest };
});

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
let app: FastifyInstance;
let redis: RedisClientType;
let userId: string;
let otherUserId: string;
let lastConfluenceRequest: { url: string; options: Record<string, unknown> } | null;
let recoveryAdminId: string;

async function waitForBlockedLifecycleLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
            AND query LIKE '%pg_advisory_xact_lock%'
       ) AS waiting`,
    );
    if (waiting.rows[0]?.waiting) return;
  }
  throw new Error('Apply writer did not reach the lifecycle admission barrier');
}

async function setPageContent(
  pageId: number,
  bodyHtml: string,
  version = 5,
  bodyStorage = '',
): Promise<void> {
  await query(
    `UPDATE pages
        SET body_html = $2, body_text = $3, body_storage = $4, version = $5,
            embedding_dirty = FALSE, image_analysis_dirty = FALSE
      WHERE id = $1`,
    [pageId, bodyHtml, bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), bodyStorage, version],
  );
}

async function enableConfluence(enabled: boolean, configured = true): Promise<void> {
  await query(
    `INSERT INTO spaces (space_key, space_name, source, last_synced)
     VALUES ('OPS', 'OPS', 'confluence', NOW())
     ON CONFLICT (space_key) DO NOTHING`,
  );
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ('apply-editor', 'Apply editor', ARRAY['read', 'write'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ('OPS', 'user', $1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, role.rows[0]!.id],
  );
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       confluence_url = EXCLUDED.confluence_url,
       confluence_pat = EXCLUDED.confluence_pat,
       confluence_enabled = EXCLUDED.confluence_enabled`,
    [
      userId,
      configured ? 'https://confluence.example.test' : null,
      configured ? encryptPat('test-personal-access-token') : null,
      enabled,
    ],
  );
}

/** Sets one user's own integration mode, the toggle any user controls. */
async function setIntegration(user: string, enabled: boolean): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, 'https://confluence.example.test', $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       confluence_url = EXCLUDED.confluence_url,
       confluence_pat = EXCLUDED.confluence_pat,
       confluence_enabled = EXCLUDED.confluence_enabled`,
    [user, encryptPat('caller-personal-access-token'), enabled],
  );
}

async function grantSpace(user: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ('apply-editor', 'Apply editor', ARRAY['read', 'write'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT DO NOTHING`,
    [spaceKey, user, role.rows[0]!.id],
  );
  // The role-assignment routes clear the RBAC space cache the same way.
  await invalidateRbacCache(user);
}

async function insertAcceptedImprovement(
  user: string,
  pageId: number,
  improvedMarkdown: string,
): Promise<string> {
  const inserted = await query<{ id: string }>(
    `INSERT INTO llm_improvements
       (user_id, page_id, improvement_type, model, original_content, improved_content, status)
     VALUES ($1, $2, 'clarity', 'test-model', 'old', $3, 'completed')
     RETURNING id`,
    [user, pageId, improvedMarkdown],
  );
  return inserted.rows[0]!.id;
}

async function improvementStatus(id: string): Promise<string | undefined> {
  const result = await query<{ status: string }>(
    'SELECT status FROM llm_improvements WHERE id = $1',
    [id],
  );
  return result.rows[0]?.status;
}

async function pageUpdateAuditCount(pageId: number): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log
      WHERE action = 'PAGE_UPDATED' AND resource_id = $1`,
    [String(pageId)],
  );
  return Number(result.rows[0]!.count);
}

function acceptNextConfluenceUpdate(expectedProviderVersion?: number): void {
  mockHttpRequest.mockImplementationOnce(async (url: string, options: Record<string, unknown>) => {
    lastConfluenceRequest = { url, options };
    const sent = JSON.parse(String(options.body)) as {
      title: string;
      version: { number: number };
      body: { storage: { value: string } };
    };
    if (expectedProviderVersion !== undefined && sent.version.number !== expectedProviderVersion + 1) {
      return { statusCode: 409, body: { text: async () => 'Confluence requires its next version' } } as never;
    }
    return {
      statusCode: 200,
      headers: {},
      body: {
        text: async () => JSON.stringify({
          id: new URL(String(url)).pathname.split('/').at(-1),
          type: 'page',
          title: sent.title,
          version: sent.version,
          body: { storage: { value: sent.body.storage.value, representation: 'storage' } },
        }),
      },
    };
  });
}

function acceptNextConfluenceReadback(input: {
  id: string;
  title: string;
  version: number;
  storage: string;
}): void {
  mockHttpRequest.mockImplementationOnce(async (url: string, options: Record<string, unknown>) => {
    lastConfluenceRequest = { url, options };
    return {
      statusCode: 200,
      headers: {},
      body: {
        text: async () => JSON.stringify({
          id: input.id,
          type: 'page',
          status: 'current',
          title: input.title,
          version: { number: input.version },
          body: { storage: { value: input.storage, representation: 'storage' } },
        }),
      },
    };
  });
}

async function apply(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/llm/improvements/apply', payload });
}

async function readPage(pageId: number) {
  const result = await query<{
    title: string;
    body_html: string;
    body_storage: string | null;
    body_text: string;
    version: number;
    local_modified_at: Date | null;
    local_modified_by: string | null;
    embedding_dirty: boolean;
    image_analysis_dirty: boolean;
  }>(
    `SELECT title, body_html, body_storage, body_text, version,
            local_modified_at, local_modified_by, embedding_dirty, image_analysis_dirty
       FROM pages WHERE id = $1`,
    [pageId],
  );
  return result.rows[0]!;
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'POST /api/llm/improvements/apply — real PostgreSQL, Redis, admission, and conversion',
  () => {
    beforeAll(async () => {
      process.env.PAT_ENCRYPTION_KEY ??= 'apply-improvement-test-key-32bytes!';
      await setupTestDb();
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      await redis.connect();
      setRedisClient(redis);
      app = await buildKnowledgeTestApp(() => userId, async (instance) => {
        instance.redis = redis;
        await instance.register(llmConversationRoutes, { prefix: '/api' });
      });
    });

    afterAll(async () => {
      await app.close();
      if (redis.isOpen) await redis.quit();
      await teardownTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      await redis.flushDb();
      vi.clearAllMocks();
      lastConfluenceRequest = null;
      userId = await insertUser(`apply-owner-${randomUUID()}`);
      otherUserId = await insertUser(`apply-other-${randomUUID()}`);
      recoveryAdminId = await insertUser(`apply-recovery-admin-${randomUUID()}`);
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [recoveryAdminId]);
    });

    it('falls back to a numeric Confluence id only when no internal id matches', async () => {
      await insertLocalSpace('LOCAL', userId);
      const pageId = await insertStandalonePage('Fallback target', 'private', userId, 'LOCAL');
      await query('UPDATE pages SET confluence_id = $2 WHERE id = $1', [pageId, '1146884']);
      await setPageContent(pageId, '<p>Old fallback body</p>', 2);

      const response = await apply({ pageId: '1146884', improvedMarkdown: '## Better fallback' });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: pageId, version: 3 });
      expect(await readPage(pageId)).toMatchObject({
        version: 3,
        body_text: 'Better fallback',
        local_modified_by: userId,
      });
    });

    it('gives the internal id precedence instead of selecting an ambiguous Confluence-id row', async () => {
      await insertLocalSpace('LOCAL', userId);
      const internalId = await insertStandalonePage('Internal winner', 'private', userId, 'LOCAL');
      const confluenceMatch = await insertStandalonePage('Confluence-id loser', 'private', userId, 'LOCAL');
      await query('UPDATE pages SET confluence_id = $2 WHERE id = $1', [confluenceMatch, String(internalId)]);
      await setPageContent(internalId, '<p>Internal old</p>', 4);
      await setPageContent(confluenceMatch, '<p>Other old</p>', 9);

      const response = await apply({ pageId: String(internalId), improvedMarkdown: 'Internal changed' });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: internalId, version: 5 });
      expect((await readPage(internalId)).body_text).toBe('Internal changed');
      expect(await readPage(confluenceMatch)).toMatchObject({ body_text: 'Other old', version: 9 });
    });

    it('does not cast a long numeric Confluence id and returns the ordinary not-found response', async () => {
      const response = await apply({ pageId: '123456789012', improvedMarkdown: 'Better' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: 'Page not found' });
    });

    it('conceals another user private standalone page before exposing its version', async () => {
      await insertLocalSpace('PRIVATE', otherUserId);
      const pageId = await insertStandalonePage('Secret', 'private', otherUserId, 'PRIVATE');
      await setPageContent(pageId, '<p>Secret old</p>', 8);

      const response = await apply({ pageId: String(pageId), improvedMarkdown: 'Stolen', version: 1 });

      expect(response.statusCode).toBe(404);
      expect(await readPage(pageId)).toMatchObject({ body_text: 'Secret old', version: 8 });
    });

    it('allows a shared standalone page and persists the converted body and version', async () => {
      await insertLocalSpace('SHARED', otherUserId);
      const pageId = await insertStandalonePage('Shared article', 'shared', otherUserId, 'SHARED');
      await setPageContent(pageId, '<p>Old shared body</p>', 3);

      const response = await apply({
        pageId: String(pageId),
        improvedMarkdown: '## Shared heading\n\nA **real** converted body.',
        version: 3,
      });

      expect(response.statusCode, response.body).toBe(200);
      const saved = await readPage(pageId);
      expect(saved.version).toBe(4);
      expect(saved.body_html).toContain('<h2>Shared heading</h2>');
      expect(saved.body_html).toContain('<strong>real</strong>');
      expect(saved.body_text).toContain('Shared heading A real converted body.');
      expect(saved.embedding_dirty).toBe(true);
      expect(saved.image_analysis_dirty).toBe(true);
    });

    it('returns a conflict and leaves the row unchanged for a stale version', async () => {
      await insertLocalSpace('LOCAL', userId);
      const pageId = await insertStandalonePage('Current article', 'private', userId, 'LOCAL');
      await setPageContent(pageId, '<p>Current body</p>', 10);

      const response = await apply({ pageId: String(pageId), improvedMarkdown: 'Outdated edit', version: 5 });

      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toMatch(/modified since you loaded/i);
      expect(await readPage(pageId)).toMatchObject({ body_text: 'Current body', version: 10 });
    });

    it('keeps a synced page local when Confluence is disabled', async () => {
      const pageId = await insertConfluencePage('page-1', 'Synced article', 'OPS');
      await setPageContent(pageId, '<p>Old synced body</p>', 5, '<p>Old storage</p>');
      await enableConfluence(false, true);

      const response = await apply({
        pageId: 'page-1',
        improvedMarkdown: '## Local-only improvement',
        version: 5,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(mockHttpRequest).not.toHaveBeenCalled();
      expect(await readPage(pageId)).toMatchObject({
        version: 6,
        body_text: 'Local-only improvement',
        body_storage: '<p>Old storage</p>',
        local_modified_by: userId,
      });
    });

    it('requires configured credentials for an enabled Confluence page', async () => {
      const pageId = await insertConfluencePage('page-1', 'Synced article', 'OPS');
      await setPageContent(pageId, '<p>Old body</p>', 5, '<p>Old storage</p>');
      await enableConfluence(true, false);

      const response = await apply({ pageId: 'page-1', improvedMarkdown: 'Better', version: 5 });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'Confluence not configured' });
      expect(mockHttpRequest).not.toHaveBeenCalled();
      expect(await readPage(pageId)).toMatchObject({ body_text: 'Old body', version: 5 });
    });

    it.each([false, true])('pushes production XHTML and commits the improvement with divergent counters: %s', async (diverged) => {
      const pageId = await insertConfluencePage('page-1', 'Synced article', 'OPS');
      const localVersion = diverged ? 6 : 5;
      await setPageContent(pageId, '<p>Old body</p>', localVersion, '<p>Old storage</p>');
      await query('UPDATE pages SET remote_version = 5 WHERE id = $1', [pageId]);
      await enableConfluence(true);
      const improvedMarkdown = '## Improved\n\nBetter **content**.';
      const accepted = await query<{ id: string }>(
        `INSERT INTO llm_improvements
           (user_id, page_id, improvement_type, model, original_content, improved_content, status)
         VALUES ($1, $2, 'clarity', 'test-model', 'old', $3, 'completed')
         RETURNING id`,
        [userId, pageId, improvedMarkdown],
      );
      const laterUnrelated = await query<{ id: string }>(
        `INSERT INTO llm_improvements
           (user_id, page_id, improvement_type, model, original_content, improved_content, status)
         VALUES ($1, $2, 'grammar', 'later-model', 'other old', 'other new', 'completed')
         RETURNING id`,
        [userId, pageId],
      );
      if (diverged) {
        const stale = await apply({ pageId: 'page-1', improvedMarkdown, version: 5 });
        expect(stale.statusCode).toBe(409);
        expect(lastConfluenceRequest).toBeNull();
      }
      acceptNextConfluenceUpdate(5);

      const response = await apply({
        pageId: 'page-1',
        improvedMarkdown,
        version: localVersion,
        title: 'Improved title',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ id: pageId, title: 'Improved title', version: localVersion + 1 });
      expect(lastConfluenceRequest?.url).toBe('https://confluence.example.test/rest/api/content/page-1');
      const sent = JSON.parse(String(lastConfluenceRequest?.options.body));
      expect(sent).toMatchObject({ title: 'Improved title', version: { number: 6 } });
      expect(sent.body.storage.value).toContain('<h2>Improved</h2>');
      expect(sent.body.storage.value).toContain('<strong>content</strong>');

      const saved = await readPage(pageId);
      expect(saved).toMatchObject({
        title: 'Improved title',
        version: localVersion + 1,
        body_storage: sent.body.storage.value,
        local_modified_at: null,
        local_modified_by: null,
        embedding_dirty: true,
        image_analysis_dirty: true,
      });
      expect(saved.body_html).toContain('<h2>Improved</h2>');
      expect(saved.body_text).toContain('Improved Better content.');

      expect((await query('SELECT remote_version FROM pages WHERE id = $1', [pageId])).rows)
        .toEqual([{ remote_version: 6 }]);
      const improvements = await query<{ id: string; status: string }>(
        'SELECT id, status FROM llm_improvements WHERE page_id = $1',
        [pageId],
      );
      expect(improvements.rows.find((row) => row.id === accepted.rows[0]!.id)?.status).toBe('applied');
      expect(improvements.rows.find((row) => row.id === laterUnrelated.rows[0]!.id)?.status).toBe('completed');
      const intent = await query<{ effect: Record<string, unknown>; status: string }>(
        `SELECT effect, status
           FROM page_write_intents
          WHERE kind = 'page.ai_apply' AND page_ids = ARRAY[$1]::integer[]`,
        [pageId],
      );
      expect(intent.rows[0]).toMatchObject({
        status: 'completed',
        effect: {
          improvementId: accepted.rows[0]!.id,
          expectedRemoteVersion: '5',
          expectedLocalVersion: localVersion,
          intendedStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(Object.keys(intent.rows[0]!.effect).sort()).toEqual([
        'confluenceId',
        'effectClass',
        'expectedLocalVersion',
        'expectedRemoteVersion',
        'improvementId',
        'intendedStateDigest',
        'pageId',
      ]);
      expect(JSON.stringify(intent.rows[0]!.effect)).not.toContain(improvedMarkdown);
      expect(JSON.stringify(intent.rows[0]!.effect)).not.toContain('Improved title');
      const audit = await query<{ metadata: { source?: string } }>(
        `SELECT metadata FROM audit_log
          WHERE user_id = $1 AND action = 'PAGE_UPDATED' AND resource_id = $2`,
        [userId, String(pageId)],
      );
      expect(audit.rows[0]?.metadata.source).toBe('ai_improvement');
    });

    it('blocks Confluence Apply while a manual-review sync conflict is pending', async () => {
      const pageId = await insertConfluencePage('page-conflict-pending', 'Synced', 'OPS');
      await setPageContent(pageId, '<p>Old body</p>', 5, '<p>Old storage</p>');
      await enableConfluence(true);
      await query('UPDATE pages SET conflict_pending = TRUE WHERE id = $1', [pageId]);

      const response = await apply({ pageId: 'page-conflict-pending', improvedMarkdown: 'My edited body', version: 5 });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ reason: 'sync_conflict_pending' });
      expect(lastConfluenceRequest).toBeNull();
      expect((await query(
        'SELECT id FROM page_write_intents WHERE page_ids = ARRAY[$1]::int[] AND status = $2', [pageId, 'pending'],
      )).rows).toEqual([]);
    });

    it('keeps the Confluence id of a task whose text the improvement left unchanged (#1751)', async () => {
      const pageId = await insertConfluencePage('page-1', 'Synced article', 'OPS');
      await setPageContent(
        pageId,
        '<p>Old body</p>',
        5,
        '<p>Old</p><ac:task-list><ac:task><ac:task-id>794464</ac:task-id>'
        + '<ac:task-status>incomplete</ac:task-status><ac:task-body>Ship it</ac:task-body></ac:task></ac:task-list>',
      );
      await enableConfluence(true);
      // htmlToMarkdown writes no task ids, so the improvement's tasks carry none
      // (raw task markup here; with #1752 a GFM task list renders the same).
      const improvedMarkdown = '## Improved\n\n<ul data-type="taskList">'
        + '<li data-type="taskItem" data-checked="false">Ship it</li>'
        + '<li data-type="taskItem" data-checked="false">Celebrate</li></ul>\n';
      acceptNextConfluenceUpdate();

      const response = await apply({ pageId: 'page-1', improvedMarkdown, version: 5 });

      expect(response.statusCode, response.body).toBe(200);
      const sent = JSON.parse(String(lastConfluenceRequest?.options.body)) as { body: { storage: { value: string } } };
      expect([...sent.body.storage.value.matchAll(/<ac:task-id>([^<]*)<\/ac:task-id>/g)].map((match) => match[1]))
        .toEqual(['794464', '794465']);
    });

    describe('tasks the improvement changed (#1751)', () => {
      // htmlToMarkdown writes no task ids, so the improvement's tasks carry none
      // (raw task markup here; with #1752 a GFM task list renders the same).
      async function applyTasks(...texts: string[]): Promise<string[]> {
        const pageId = await insertConfluencePage('page-1', 'Synced article', 'OPS');
        await setPageContent(
          pageId,
          '<p>Old body</p>',
          5,
          '<p>Old</p><ac:task-list>'
          + [[1, 'Buy milk'], [2, 'Call Bob'], [3, 'Book flights']].map(([id, text]) => `<ac:task><ac:task-id>${id}</ac:task-id>`
            + `<ac:task-status>incomplete</ac:task-status><ac:task-body>${text}</ac:task-body></ac:task>`).join('')
          + '</ac:task-list>',
        );
        await enableConfluence(true);
        const improvedMarkdown = '## Improved\n\n<ul data-type="taskList">'
          + texts.map((text) => `<li data-type="taskItem" data-checked="false">${text}</li>`).join('')
          + '</ul>\n';
        acceptNextConfluenceUpdate();

        const response = await apply({ pageId: 'page-1', improvedMarkdown, version: 5 });

        expect(response.statusCode, response.body).toBe(200);
        const sent = JSON.parse(String(lastConfluenceRequest?.options.body)) as { body: { storage: { value: string } } };
        return [...sent.body.storage.value.matchAll(/<ac:task-id>([^<]*)<\/ac:task-id>/g)].map((match) => match[1]!);
      }

      it('gives a task the improvement reworded a new id (#1751)', async () => {
        expect(await applyTasks('Buy milk', 'Phone Bob', 'Book flights')).toEqual(['1', '4', '3']);
      });

      it('never gives a task the improvement added the id of one it dropped (#1751)', async () => {
        expect(await applyTasks('Buy milk', 'Book flights', 'Pack bags')).toEqual(['1', '3', '4']);
      });
    });

    it('publishes a successful sparse Confluence response without requiring recovery', async () => {
      const pageId = await insertConfluencePage('page-sparse', 'Sparse article', 'OPS');
      await setPageContent(pageId, '<p>Old body</p>', 5, '<p>Old storage</p>');
      await enableConfluence(true);
      let acceptedStorage = '';
      mockHttpRequest.mockImplementationOnce(async (url: string, options: Record<string, unknown>) => {
        lastConfluenceRequest = { url, options };
        const sent = JSON.parse(String(options.body)) as {
          body: { storage: { value: string } };
        };
        acceptedStorage = sent.body.storage.value;
        return {
          statusCode: 200,
          headers: {},
          body: {
            text: async () => JSON.stringify({
              id: 'page-sparse',
              type: 'page',
              title: 'Accepted sparse article',
              version: { number: 6 },
            }),
          },
        };
      });
      mockHttpRequest.mockImplementationOnce(async () => ({
        statusCode: 200,
        headers: {},
        body: {
          text: async () => JSON.stringify({
            id: 'page-sparse',
            type: 'page',
            status: 'current',
            title: 'Accepted sparse article',
            version: { number: 6 },
            body: { storage: { value: acceptedStorage, representation: 'storage' } },
          }),
        },
      }));

      const response = await apply({
        pageId: 'page-sparse',
        improvedMarkdown: '## Accepted without expansion\n\nStored content.',
        title: 'Accepted sparse article',
        version: 5,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ id: pageId, title: 'Accepted sparse article', version: 6 });
      const saved = await readPage(pageId);
      expect(saved).toMatchObject({
        title: 'Accepted sparse article',
        version: 6,
        body_text: 'Accepted without expansion Stored content.',
        local_modified_at: null,
        local_modified_by: null,
      });
      expect(saved.body_html).toContain('<h2>Accepted without expansion</h2>');
      expect(saved.body_storage).toContain('<p>Stored content.</p>');
      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
      const pending = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM page_write_intents
          WHERE $1 = ANY(page_ids) AND status = 'pending'`,
        [pageId],
      );
      expect(pending.rows[0]?.count).toBe('0');
    });
    it('keeps a large successful provider body out of terminal metadata and publishes it exactly', async () => {
      const pageId = await insertConfluencePage('page-large', 'Large article', 'OPS');
      await setPageContent(pageId, '<p>Old body</p>', 5, '<p>Old storage</p>');
      await enableConfluence(true);
      const authoredText = `large-${'x'.repeat(36_000)}-end`;
      acceptNextConfluenceUpdate();

      const response = await apply({
        pageId: 'page-large',
        improvedMarkdown: authoredText,
        title: 'Large accepted title',
        version: 5,
      });

      expect(response.statusCode, response.body).toBe(200);
      const saved = await readPage(pageId);
      expect(saved).toMatchObject({
        title: 'Large accepted title',
        body_text: authoredText,
        version: 6,
      });
      const intent = await query<{
        status: string;
        remote_terminal_result: Record<string, unknown>;
      }>(
        `SELECT status, remote_terminal_result
           FROM page_write_intents
          WHERE kind = 'page.ai_apply' AND page_ids = ARRAY[$1]::integer[]`,
        [pageId],
      );
      expect(intent.rows[0]?.status).toBe('completed');
      expect(Buffer.byteLength(JSON.stringify(intent.rows[0]?.remote_terminal_result))).toBeLessThan(1024);
      expect(JSON.stringify(intent.rows[0]?.remote_terminal_result)).not.toContain(authoredText.slice(0, 128));
    });

    it('retains a compact acknowledged Apply for recovery when readback fails without replaying the PUT', async () => {
      const pageId = await insertConfluencePage('page-compact-failure', 'Compact article', 'OPS');
      await setPageContent(pageId, '<p>Old body</p>', 5, '<p>Old storage</p>');
      await enableConfluence(true);
      let acceptedStorage = '';
      mockHttpRequest.mockImplementationOnce(async (_url: string, options: Record<string, unknown>) => {
        const sent = JSON.parse(String(options.body)) as { body: { storage: { value: string } } };
        acceptedStorage = sent.body.storage.value;
        return {
          statusCode: 200,
          headers: {},
          body: {
            text: async () => JSON.stringify({
              id: 'page-compact-failure',
              type: 'page',
              title: 'Compact accepted',
              version: { number: 6 },
            }),
          },
        };
      });
      mockHttpRequest.mockResolvedValueOnce({
        statusCode: 403,
        headers: {},
        body: { text: async () => JSON.stringify({ message: 'readback denied' }) },
      });

      const response = await apply({
        pageId: 'page-compact-failure',
        improvedMarkdown: 'Compact accepted body',
        title: 'Compact accepted',
        version: 5,
      });
      expect(response.statusCode).toBe(403);
      const pending = await query<{
        id: string;
        remote_terminal_result: Record<string, unknown>;
        remote_effects_completed_at: Date | null;
      }>(
        `SELECT id, remote_terminal_result, remote_effects_completed_at
           FROM page_write_intents
          WHERE kind = 'page.ai_apply' AND page_ids = ARRAY[$1]::integer[] AND status = 'pending'`,
        [pageId],
      );
      expect(pending.rows[0]?.remote_effects_completed_at).toEqual(expect.any(Date));
      expect(JSON.stringify(pending.rows[0]?.remote_terminal_result)).not.toContain('Compact accepted body');

      const retiredRuntime = `retired-apply-${randomUUID()}`;
      await query(
        `INSERT INTO page_writer_runtimes
           (runtime_id, deployment_identity, fenced_at, fenced_by, fence_reason, fence_proof)
         VALUES ($1, '{"fixture":"retired Apply writer"}', NOW(), $2,
                 'Fixture confirms the acknowledged writer stopped',
                 '{"kind":"verified_local_termination"}')`,
        [retiredRuntime, recoveryAdminId],
      );
      await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1', [
        pending.rows[0]!.id,
        retiredRuntime,
      ]);
      acceptNextConfluenceReadback({
        id: 'page-compact-failure',
        title: 'Compact accepted',
        version: 6,
        storage: acceptedStorage,
      });
      await expect(reconcilePageWriteIntent(pending.rows[0]!.id, {
        actorId: recoveryAdminId,
        reason: 'Recover compact acknowledged Apply without repeating its remote mutation',
      })).resolves.toEqual({
        intentId: pending.rows[0]!.id,
        status: 'reconciled_applied',
      });
      expect(await readPage(pageId)).toMatchObject({
        title: 'Compact accepted',
        body_text: 'Compact accepted body',
        version: 6,
      });
      const methods = mockHttpRequest.mock.calls.map((call) =>
        (call[1] as Record<string, unknown> | undefined)?.method);
      expect(methods.filter((method) => method === 'PUT')).toHaveLength(1);
    });

    it('cancels an admitted Apply when Confluence is switched off while it waits', async () => {
      const pageId = await insertConfluencePage('page-mode-race', 'Mode race', 'OPS');
      await setPageContent(pageId, '<p>Old body</p>', 5, '<p>Old storage</p>');
      await enableConfluence(true);
      const blocker = await getPool().connect();
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageId]);
      try {
        const pending = apply({
          pageId: 'page-mode-race',
          improvedMarkdown: 'Must remain local',
          version: 5,
        });
        await waitForBlockedLifecycleLock();
        await blocker.query(
          'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
          [userId],
        );
        await blocker.query('COMMIT');

        const response = await pending;
        expect(response.statusCode).toBe(409);
        expect(mockHttpRequest).not.toHaveBeenCalled();
        expect((await query(
          `SELECT status FROM page_write_intents
            WHERE kind = 'page.ai_apply' AND page_ids = ARRAY[$1]::integer[]`,
          [pageId],
        )).rows).toEqual([{ status: 'cancelled' }]);
      } catch (error) {
        await blocker.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        blocker.release();
      }
    });

    it('uses a PAT rotated while Apply waits for admission', async () => {
      const pageId = await insertConfluencePage('page-pat-race', 'PAT race', 'OPS');
      await setPageContent(pageId, '<p>Old body</p>', 5, '<p>Old storage</p>');
      await enableConfluence(true);
      acceptNextConfluenceUpdate();
      const blocker = await getPool().connect();
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageId]);
      try {
        const pending = apply({
          pageId: 'page-pat-race',
          improvedMarkdown: 'Uses rotated credentials',
          version: 5,
        });
        await waitForBlockedLifecycleLock();
        await blocker.query(
          'UPDATE user_settings SET confluence_pat = $2 WHERE user_id = $1',
          [userId, encryptPat('rotated-apply-pat')],
        );
        await blocker.query('COMMIT');

        const response = await pending;
        expect(response.statusCode, response.body).toBe(200);
        expect(
          (lastConfluenceRequest?.options.headers as Record<string, string>).Authorization,
        ).toBe('Bearer rotated-apply-pat');
      } catch (error) {
        await blocker.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        blocker.release();
      }
    });


    it('preserves protected draw.io and image markup even when the improvement drops every token', async () => {
      await insertLocalSpace('LOCAL', userId);
      const pageId = await insertStandalonePage('Media article', 'private', userId, 'LOCAL');
      const drawio = '<div class="confluence-drawio" data-diagram-name="Arch"><img src="/api/attachments/42/Arch.png"></div>';
      const image = '<img src="/api/attachments/42/photo.png" data-confluence-filename="photo.png" data-confluence-image-source="attachment">';
      await setPageContent(pageId, `<p>Old introduction</p>${drawio}${image}`, 2);

      const response = await apply({
        pageId: String(pageId),
        improvedMarkdown: 'A replacement introduction with no media placeholders.',
        version: 2,
      });

      expect(response.statusCode, response.body).toBe(200);
      const saved = await readPage(pageId);
      expect(saved.body_html).toContain('A replacement introduction');
      expect(saved.body_html).toContain('class="confluence-drawio"');
      expect(saved.body_html).toContain('/api/attachments/42/Arch.png');
      expect(saved.body_html).toContain('/api/attachments/42/photo.png');
    });

    it('round-trips an expand macro through production conversion before the remote write', async () => {
      const storage = '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Runbook</ac:parameter><ac:rich-text-body><p>old step</p></ac:rich-text-body></ac:structured-macro>';
      const pageId = await insertConfluencePage('page-expand', 'Macro article', 'OPS');
      const bodyHtml = confluenceToHtml(storage, 'page-expand', 'OPS');
      await setPageContent(pageId, bodyHtml, 7, storage);
      await enableConfluence(true);
      acceptNextConfluenceUpdate();
      const protectedHtml = protectMedia(bodyHtml).html;
      const faithfulMarkdown = htmlToMarkdown(protectedHtml, { layoutTokens: true })
        .replace('old step', 'clarified step');

      const response = await apply({
        pageId: 'page-expand',
        improvedMarkdown: faithfulMarkdown,
        version: 7,
      });

      expect(response.statusCode, response.body).toBe(200);
      const sent = JSON.parse(String(lastConfluenceRequest?.options.body));
      expect(sent.body.storage.value).toContain('ac:name="expand"');
      expect(sent.body.storage.value).toContain('Runbook');
      expect(sent.body.storage.value).toContain('clarified step');
      expect((await readPage(pageId)).body_html).toContain('data-macro-name="expand"');
    });

    it('keeps Confluence page, attachment and anchor links through Apply (#1748); the model is not called', async () => {
      // The accepted improvement stands in for the model's output: the page's
      // own Markdown, as Improve sends it, with one word changed. Everything
      // after it is the production Apply path (Markdown → HTML, media restore,
      // layout recovery, htmlToConfluence, the Confluence PUT, whose HTTP alone
      // is mocked). What a model does to a link's Markdown is not covered.
      const storage = '<p>Intro</p>'
        + '<p>See <ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" />'
        + '<ac:plain-text-link-body><![CDATA[see runbook]]></ac:plain-text-link-body></ac:link> and '
        + '<ac:link ac:anchor="Restore"><ri:page ri:content-title="Runbook" ri:space-key="OPS" /></ac:link>.</p>'
        + '<p>Jump to <ac:link ac:anchor="Restore"><ac:plain-text-link-body><![CDATA[restore]]></ac:plain-text-link-body></ac:link>'
        + ' or get <ac:link><ri:attachment ri:filename="logo.png"><ri:page ri:content-title="Shared Assets" ri:space-key="ENG" />'
        + '</ri:attachment></ac:link>.</p>';
      const pageId = await insertConfluencePage('page-links', 'Links article', 'OPS');
      const bodyHtml = confluenceToHtml(storage, 'page-links', 'OPS');
      await setPageContent(pageId, bodyHtml, 7, storage);
      await enableConfluence(true);
      acceptNextConfluenceUpdate();
      const faithfulMarkdown = htmlToMarkdown(protectMedia(bodyHtml).html, { layoutTokens: true })
        .replace('Intro', 'Introduction');

      const response = await apply({ pageId: 'page-links', improvedMarkdown: faithfulMarkdown, version: 7 });

      expect(response.statusCode, response.body).toBe(200);
      const sent = JSON.parse(String(lastConfluenceRequest?.options.body)) as { body: { storage: { value: string } } };
      expect(sent.body.storage.value).toContain('Introduction');
      expect(sent.body.storage.value.match(/<ac:link\b[\s\S]*?<\/ac:link>/g)).toEqual([
        '<ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page>'
        + '<ac:plain-text-link-body><![CDATA[see runbook]]></ac:plain-text-link-body></ac:link>',
        '<ac:link ac:anchor="Restore"><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page></ac:link>',
        '<ac:link ac:anchor="Restore"><ac:plain-text-link-body><![CDATA[restore]]></ac:plain-text-link-body></ac:link>',
        '<ac:link><ri:attachment ri:filename="logo.png"><ri:page ri:content-title="Shared Assets" ri:space-key="ENG"></ri:page>'
        + '</ri:attachment></ac:link>',
      ]);
    });

    describe('ri:url links through Apply (#1955)', () => {
      const FILLER = `<p>${'Unrelated prose that keeps the paragraphs apart. '.repeat(3)}</p>`;
      const JS_LINK = '<ac:link><ri:url ri:value="javascript:alert(1)" />'
        + '<ac:plain-text-link-body><![CDATA[legacy tool]]></ac:plain-text-link-body></ac:link>';
      const WEB_LINK = '<ac:link><ri:url ri:value="https://example.com/a?b=1&amp;c=2" />'
        + '<ac:plain-text-link-body><![CDATA[example]]></ac:plain-text-link-body></ac:link>';
      const STORAGE = `<p>Intro</p><p>Open the ${JS_LINK} here.</p>${FILLER}<p>Web: ${WEB_LINK}.</p>`;

      async function seed(): Promise<{ pageId: number; markdown: string }> {
        const pageId = await insertConfluencePage('page-url-links', 'URL links article', 'OPS');
        const bodyHtml = confluenceToHtml(STORAGE, 'page-url-links', 'OPS');
        await setPageContent(pageId, bodyHtml, 7, STORAGE);
        await enableConfluence(true);
        return { pageId, markdown: htmlToMarkdown(protectMedia(bodyHtml).html, { layoutTokens: true }) };
      }

      const sentStorage = (): string =>
        (JSON.parse(String(lastConfluenceRequest?.options.body)) as { body: { storage: { value: string } } }).body.storage.value;

      it('keeps the stored unsafe link and the web link through an unchanged echo', async () => {
        const { pageId, markdown } = await seed();
        // What the model is shown: the carrier is the destination of both links.
        expect(markdown).toContain('[legacy tool](#confluence-url:javascript%3Aalert%281%29?body=plain)');
        expect(markdown).toContain('[example](#confluence-url:https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2?body=plain)');
        acceptNextConfluenceUpdate();

        const response = await apply({ pageId: 'page-url-links', improvedMarkdown: markdown.replace('Intro', 'Introduction'), version: 7 });

        expect(response.statusCode, response.body).toBe(200);
        expect(oracleUrlLinks(sentStorage())).toEqual([
          { value: 'javascript:alert(1)', link: {}, resource: {}, body: 'plain:legacy tool', text: 'legacy tool' },
          { value: 'https://example.com/a?b=1&c=2', link: {}, resource: {}, body: 'plain:example', text: 'example' },
        ]);
        // The published page is re-derived from what Confluence returned.
        expect((await readPage(pageId)).body_html).toBe(confluenceToHtml(sentStorage(), 'page-url-links', 'OPS'));
      });

      it('never lets the model add, multiply or retarget an unsafe link', async () => {
        const { markdown } = await seed();
        acceptNextConfluenceUpdate();
        const improved = `${markdown}\n\n`
          // A copy of the stored link elsewhere, an invented target, raw link markup, and an image-linked variant.
          + 'Copy: [legacy tool](#confluence-url:javascript%3Aalert%281%29?body=plain).\n\n'
          + 'New: [free prize](#confluence-url:data%3Atext%2Fhtml%2Cx?body=plain) and [mail](mailto:a@b.c).\n\n'
          + '<p>Raw: <a href="#confluence-url:javascript%3Aalert%282%29">raw anchor</a></p>\n\n'
          + 'Pic: [![alt](https://example.com/p.png)](#confluence-url:javascript%3Aalert%281%29?body=rich)\n';

        const response = await apply({ pageId: 'page-url-links', improvedMarkdown: improved, version: 7 });

        expect(response.statusCode, response.body).toBe(200);
        const links = oracleUrlLinks(sentStorage());
        // Exactly the stored occurrence, in its stored place, and the web link.
        expect(links).toEqual([
          { value: 'javascript:alert(1)', link: {}, resource: {}, body: 'plain:legacy tool', text: 'legacy tool' },
          { value: 'https://example.com/a?b=1&c=2', link: {}, resource: {}, body: 'plain:example', text: 'example' },
        ]);
        expect(sentStorage()).toContain('<p>Open the <ac:link><ri:url ri:value="javascript:alert(1)"></ri:url>');
        // What the declined links held is still there, as text and as an image.
        expect(sentStorage()).toContain('<p>Copy: legacy tool.</p>');
        expect(sentStorage()).toContain('<p>New: free prize and <a href="mailto:a@b.c">mail</a>.</p>');
        expect(sentStorage()).toContain('<p>Raw: raw anchor</p>');
        expect(sentStorage()).toContain('<img src="https://example.com/p.png" alt="alt" />');
        expect(sentStorage()).not.toMatch(/data:text|alert\(2\)/);
      });

      it('writes the stored link as text when the model moved it and reworded it at once', async () => {
        const { markdown } = await seed();
        acceptNextConfluenceUpdate();
        const improved = markdown
          .replace('Open the [legacy tool](#confluence-url:javascript%3Aalert%281%29?body=plain) here.', 'Open it here.')
          + '\n\nSee [the new name](#confluence-url:javascript%3Aalert%281%29?body=plain).\n';

        const response = await apply({ pageId: 'page-url-links', improvedMarkdown: improved, version: 7 });

        expect(response.statusCode, response.body).toBe(200);
        expect(oracleUrlLinks(sentStorage()).map((link) => link.value)).toEqual(['https://example.com/a?b=1&c=2']);
        expect(sentStorage()).toContain('<p>See the new name.</p>');
      });

      it('refuses an improvement whose storage would carry a link past the check, before any effect (W3)', async () => {
        const { pageId, markdown } = await seed();
        const before = await readPage(pageId);
        const improved = `${markdown}\n\n<style><ac:link><ri:url ri:value="javascript:alert(3)"></ri:url></ac:link></style>\n`;

        const response = await apply({ pageId: 'page-url-links', improvedMarkdown: improved, version: 7 });

        expect(response.statusCode, response.body).toBe(422);
        expect(response.json()).toEqual({ error: 'ConfluenceStorageRefusedError', reason: 'unapproved-link' });
        expect(mockHttpRequest).not.toHaveBeenCalled();
        expect(await readPage(pageId)).toEqual(before);
        expect((await query("SELECT 1 FROM page_write_intents WHERE kind = 'page.ai_apply'")).rowCount).toBe(0);
      });

      it('stores a standalone Accept as inert fragments and writes no unsafe link when the page is later published', async () => {
        await insertLocalSpace('LOCAL', userId);
        const pageId = await insertStandalonePage('Standalone', 'shared', userId, 'LOCAL');
        await setPageContent(pageId, '<p>Old</p>', 3);
        const improved = 'New: [free prize](#confluence-url:javascript%3Aalert%281%29?body=plain)'
          + ' and [site](#confluence-url:https%3A%2F%2Fexample.com%2F).';

        const response = await apply({ pageId: String(pageId), improvedMarkdown: improved, version: 3 });

        expect(response.statusCode, response.body).toBe(200);
        const saved = (await readPage(pageId)).body_html;
        // Locally the unsafe value is a fragment of this page; only the web address is a real link.
        expect(saved).toContain('<a href="#confluence-url:javascript%3Aalert%281%29?body=plain">free prize</a>');
        expect(saved).toContain('<a href="https://example.com/" class="#confluence-url:https%3A%2F%2Fexample.com%2F">site</a>');
        // A later publication of this body (relocation, a create from it) has no stored origin for it.
        const published = htmlToConfluence(saved);
        expect(oracleUrlLinks(published).map((link) => link.value)).toEqual(['https://example.com/']);
        expect(published).toContain('New: free prize and ');
      });
    });

    it('rejects unrecoverable layout loss before any remote effect and keeps the page unchanged', async () => {
      const bodyHtml = '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="two_equal"><div class="confluence-layout-cell"><p>Left</p></div><div class="confluence-layout-cell"><p>Right</p></div></div></div>';
      const pageId = await insertConfluencePage('page-layout', 'Layout article', 'OPS');
      await setPageContent(pageId, bodyHtml, 4, '<p>original storage</p>');
      await enableConfluence(true);

      const response = await apply({
        pageId: 'page-layout',
        improvedMarkdown: 'The model flattened both cells into one paragraph.',
        version: 4,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: string }>().error).toMatch(/lost this page's structure/i);
      expect(mockHttpRequest).not.toHaveBeenCalled();
      expect(await readPage(pageId)).toMatchObject({
        body_html: bodyHtml,
        body_storage: '<p>original storage</p>',
        version: 4,
      });
    });

    describe('page authority on the local write a switched-off integration takes', () => {
      // OPS is granted only to the space member (`userId` when the test
      // starts, via enableConfluence). The outsider holds no role on OPS
      // and switches their OWN integration off, which every user may do.
      const improvedMarkdown = '## Outsider rewrite\n\nReplaced shared content.';
      let outsiderId: string;

      beforeEach(async () => {
        outsiderId = otherUserId;
        await enableConfluence(true);
      });

      async function syncedOpsPage(confluenceId: string): Promise<number> {
        const pageId = await insertConfluencePage(confluenceId, 'Shared runbook', 'OPS');
        await setPageContent(pageId, '<p>Shared runbook body</p>', 5, '<p>Shared storage</p>');
        return pageId;
      }

      it('answers a caller without a space role exactly like a missing page and changes nothing', async () => {
        const pageId = await syncedOpsPage('page-outsider');
        const improvementId = await insertAcceptedImprovement(outsiderId, pageId, improvedMarkdown);
        userId = outsiderId;
        await setIntegration(outsiderId, false);

        const missing = await apply({ pageId: '987654', improvedMarkdown, version: 5 });
        const denied = await apply({ pageId: String(pageId), improvedMarkdown, version: 5, title: 'Taken over' });
        const deniedByConfluenceId = await apply({ pageId: 'page-outsider', improvedMarkdown });

        expect(missing.statusCode).toBe(404);
        expect(denied.statusCode).toBe(missing.statusCode);
        expect(denied.json()).toEqual(missing.json());
        expect(deniedByConfluenceId.statusCode).toBe(404);
        expect(deniedByConfluenceId.json()).toEqual(missing.json());
        expect(mockHttpRequest).not.toHaveBeenCalled();
        expect(await readPage(pageId)).toMatchObject({
          title: 'Shared runbook',
          body_html: '<p>Shared runbook body</p>',
          body_text: 'Shared runbook body',
          version: 5,
          local_modified_at: null,
          local_modified_by: null,
          embedding_dirty: false,
        });
        expect(await improvementStatus(improvementId)).toBe('completed');
        expect(await pageUpdateAuditCount(pageId)).toBe(0);
      });

      it('denies before any content-dependent answer: stale version and lost layout both read as missing', async () => {
        const layoutHtml = '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="two_equal"><div class="confluence-layout-cell"><p>Left</p></div><div class="confluence-layout-cell"><p>Right</p></div></div></div>';
        const stalePage = await syncedOpsPage('page-stale');
        const layoutPage = await insertConfluencePage('page-layout-oracle', 'Layout', 'OPS');
        await setPageContent(layoutPage, layoutHtml, 4, '<p>layout storage</p>');
        userId = outsiderId;
        await setIntegration(outsiderId, false);

        const stale = await apply({ pageId: String(stalePage), improvedMarkdown, version: 1 });
        const layout = await apply({ pageId: String(layoutPage), improvedMarkdown: 'Flattened.', version: 4 });

        expect(stale.statusCode).toBe(404);
        expect(stale.json()).toEqual({ error: 'Page not found' });
        expect(layout.statusCode).toBe(404);
        expect(layout.json()).toEqual({ error: 'Page not found' });
        expect(await readPage(stalePage)).toMatchObject({ version: 5, body_text: 'Shared runbook body' });
        expect(await readPage(layoutPage)).toMatchObject({ version: 4, body_html: layoutHtml });
      });

      it('requires both the space role and, on a restricted page, an ACE', async () => {
        const pageId = await syncedOpsPage('page-restricted');
        await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [pageId]);
        await query(
          `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
           VALUES ('page', $1, 'user', $2, 'edit')`,
          [pageId, outsiderId],
        );
        userId = outsiderId;
        await setIntegration(outsiderId, false);

        const aceWithoutRole = await apply({ pageId: String(pageId), improvedMarkdown, version: 5 });
        expect(aceWithoutRole.statusCode).toBe(404);

        await grantSpace(outsiderId, 'OPS');
        await query('DELETE FROM access_control_entries WHERE resource_id = $1', [pageId]);
        const roleWithoutAce = await apply({ pageId: String(pageId), improvedMarkdown, version: 5 });
        expect(roleWithoutAce.statusCode).toBe(404);
        expect(await readPage(pageId)).toMatchObject({ version: 5, body_text: 'Shared runbook body' });

        await query(
          `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
           VALUES ('page', $1, 'user', $2, 'edit')`,
          [pageId, outsiderId],
        );
        const granted = await apply({ pageId: String(pageId), improvedMarkdown, version: 5 });
        expect(granted.statusCode, granted.body).toBe(200);
        expect(await readPage(pageId)).toMatchObject({ version: 6, local_modified_by: outsiderId });
      });

      it('lets a caller with a space role apply locally and marks their improvement applied', async () => {
        const pageId = await syncedOpsPage('page-authorized');
        await grantSpace(outsiderId, 'OPS');
        const improvementId = await insertAcceptedImprovement(outsiderId, pageId, improvedMarkdown);
        userId = outsiderId;
        await setIntegration(outsiderId, false);

        const response = await apply({ pageId: String(pageId), improvedMarkdown, version: 5, title: 'Improved runbook' });

        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ id: pageId, title: 'Improved runbook', version: 6 });
        expect(mockHttpRequest).not.toHaveBeenCalled();
        expect(await readPage(pageId)).toMatchObject({
          title: 'Improved runbook',
          body_text: 'Outsider rewrite Replaced shared content.',
          body_storage: '<p>Shared storage</p>',
          version: 6,
          local_modified_by: outsiderId,
        });
        expect(await improvementStatus(improvementId)).toBe('applied');
        expect(await pageUpdateAuditCount(pageId)).toBe(1);
      });

      it('re-checks authority inside the write transaction after the role is revoked', async () => {
        const pageId = await syncedOpsPage('page-revoked');
        await grantSpace(outsiderId, 'OPS');
        const improvementId = await insertAcceptedImprovement(outsiderId, pageId, improvedMarkdown);
        userId = outsiderId;
        await setIntegration(outsiderId, false);
        const blocker = await getPool().connect();
        await blocker.query('BEGIN');
        await lockPageLifecycle(blocker, [pageId]);
        try {
          const pending = apply({ pageId: String(pageId), improvedMarkdown, version: 5 });
          await waitForBlockedLifecycleLock();
          await blocker.query(
            `DELETE FROM space_role_assignments WHERE principal_type = 'user' AND principal_id = $1`,
            [outsiderId],
          );
          await blocker.query('COMMIT');

          const response = await pending;
          expect(response.statusCode).toBe(404);
          expect(response.json()).toEqual({ error: 'Page not found' });
        } catch (error) {
          await blocker.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          blocker.release();
        }
        expect(await readPage(pageId)).toMatchObject({ version: 5, body_text: 'Shared runbook body', local_modified_by: null });
        expect(await improvementStatus(improvementId)).toBe('completed');
      });

      it('keeps the enabled-integration answer for a caller without a space role', async () => {
        const pageId = await syncedOpsPage('page-enabled-outsider');
        userId = outsiderId;
        await setIntegration(outsiderId, true);

        const response = await apply({ pageId: String(pageId), improvedMarkdown, version: 5 });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ reason: 'not_authorized' });
        expect(mockHttpRequest).not.toHaveBeenCalled();
        expect(await readPage(pageId)).toMatchObject({ version: 5, body_text: 'Shared runbook body' });
        // #1958 r1 CM-2: denied before any evidence is read, so nothing is reserved at all.
        expect((await query(
          `SELECT status FROM page_write_intents
            WHERE kind = 'page.ai_apply' AND page_ids = ARRAY[$1]::integer[]`,
          [pageId],
        )).rows).toEqual([]);
      });
    });

    describe('code-block title and options through Apply (#1958)', () => {
      const CODE = '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>'
        + '<ac:parameter ac:name="title">Startup.cs</ac:parameter><ac:parameter ac:name="linenumbers">true</ac:parameter>'
        + '<ac:plain-text-body><![CDATA[const a = "x" & 1;]]></ac:plain-text-body></ac:structured-macro>';
      const MERMAID = '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter>'
        + '<ac:parameter ac:name="title">Flow</ac:parameter><ac:parameter ac:name="theme">dark</ac:parameter>'
        + '<ac:plain-text-body><![CDATA[graph TD\n  A --> B]]></ac:plain-text-body></ac:structured-macro>';
      const STORAGE = `<p>Intro</p>${CODE}<p>Mid</p>${MERMAID}`;

      async function seed(confluenceId = 'page-code-meta'): Promise<{ pageId: number; markdown: string; bodyHtml: string }> {
        const pageId = await insertConfluencePage(confluenceId, 'Code article', 'OPS');
        const bodyHtml = confluenceToHtml(STORAGE, confluenceId, 'OPS');
        await setPageContent(pageId, bodyHtml, 7, STORAGE);
        await enableConfluence(true);
        return { pageId, bodyHtml, markdown: htmlToMarkdown(protectMedia(bodyHtml).html, { layoutTokens: true }) };
      }

      const sentStorage = (): string =>
        (JSON.parse(String(lastConfluenceRequest?.options.body)) as { body: { storage: { value: string } } }).body.storage.value;

      /** [language, title, other parameters, code] of every code macro, read by the independent XML oracle. */
      const codeMacros = (storage: string): unknown[] => oracleElements(storage, 'ac', 'structured-macro')
        .filter((macro) => macro.getAttribute('ac:name') === 'code')
        .map((macro) => {
          const parameters = Array.from(macro.children).filter((child) => child.localName === 'parameter')
            .map((child) => [child.getAttribute('ac:name'), child.textContent]);
          const code = Array.from(macro.children).find((child) => child.localName === 'plain-text-body')?.textContent;
          return [parameters, code];
        });

      async function expectNothingDispatched(pageId: number, before: unknown): Promise<void> {
        expect(mockHttpRequest).not.toHaveBeenCalled();
        expect(await readPage(pageId)).toEqual(before);
        expect((await query("SELECT 1 FROM page_write_intents WHERE kind = 'page.ai_apply'")).rowCount).toBe(0);
      }

      it('keeps title and options of a code and a mermaid block on an unchanged echo (criteria 1, 4)', async () => {
        const { pageId, markdown } = await seed();
        expect(markdown).toContain('[[[CODE-META n=0 title=Startup%2Ecs params=%7B%22linenumbers%22%3A%22true%22%7D]]]');
        acceptNextConfluenceUpdate();

        const response = await apply({ pageId: 'page-code-meta', improvedMarkdown: markdown.replace('Intro', 'Introduction'), version: 7 });

        expect(response.statusCode, response.body).toBe(200);
        expect(codeMacros(sentStorage())).toEqual([
          [[['language', 'js'], ['title', 'Startup.cs'], ['linenumbers', 'true']], 'const a = "x" & 1;'],
          [[['language', 'mermaid'], ['title', 'Flow'], ['theme', 'dark']], 'graph TD\n  A --> B'],
        ]);
        expect(sentStorage()).not.toMatch(/CODE-META|data-cq-/);
        const saved = await readPage(pageId);
        expect(saved.body_html).toBe(confluenceToHtml(sentStorage(), 'page-code-meta', 'OPS'));
        expect(saved.body_text).toBe(htmlToText(saved.body_html));
      });

      it('attaches nothing to an edited block and nothing for an invented token', async () => {
        const { markdown } = await seed();
        acceptNextConfluenceUpdate();
        // An invented ordinal binds nothing (a copied `n=1` would instead void both, G0).
        const improved = markdown.replace('const a = "x" & 1;', 'const a = 2;') + '\n\n[[[CODE-META n=5 title=Flow]]]\n```js\nnew()\n```\n';

        const response = await apply({ pageId: 'page-code-meta', improvedMarkdown: improved, version: 7 });

        expect(response.statusCode, response.body).toBe(200);
        expect(codeMacros(sentStorage())).toEqual([
          [[['language', 'js']], 'const a = 2;\n'],
          [[['language', 'mermaid'], ['title', 'Flow'], ['theme', 'dark']], 'graph TD\n  A --> B'],
          [[['language', 'js']], 'new()\n'],
        ]);
      });

      it('refuses a model code placeholder with a large parameter object before its values reach the serializer (Y2)', async () => {
        const { pageId, markdown } = await seed();
        const before = await readPage(pageId);
        const params = JSON.stringify(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`p${i}`, 'v'.repeat(40)])));
        const parse = vi.spyOn(JSON, 'parse');
        const improved = `${markdown}\n\n<div class="confluence-macro-unknown" data-macro-name="code" data-macro-params="${params.replace(/"/g, '&quot;')}">x</div>\n`;

        const response = await apply({ pageId: 'page-code-meta', improvedMarkdown: improved, version: 7 });

        expect(response.statusCode, response.body).toBe(422);
        expect(response.json()).toEqual({ error: 'ConfluenceStorageRefusedError', reason: 'unapproved-code-macro' });
        expect(parse.mock.calls.some(([value]) => value === params)).toBe(false);
        parse.mockRestore();
        await expectNothingDispatched(pageId, before);
      });

      it.each([
        ['canonical bare raw macro markup', '<div><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro></div>'],
        ['macro markup inside a raw-text element', '<div><xmp><ac:structured-macro ac:name="code"><ac:parameter ac:name="title">T</ac:parameter><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></xmp></div>'],
      ])('refuses %s before any effect (R2)', async (_name, markup) => {
        const { pageId, markdown } = await seed();
        const before = await readPage(pageId);

        const response = await apply({ pageId: 'page-code-meta', improvedMarkdown: `${markdown}\n\n${markup}\n`, version: 7 });

        expect(response.statusCode, response.body).toBe(422);
        expect(response.json()).toMatchObject({ reason: 'unapproved-code-macro' });
        await expectNothingDispatched(pageId, before);
      });

      it('keeps a fence that shows macro syntax as code text', async () => {
        const { markdown } = await seed();
        acceptNextConfluenceUpdate();
        const sample = '<ac:structured-macro ac:name="code"><ac:parameter ac:name="title">T</ac:parameter></ac:structured-macro>';

        const response = await apply({ pageId: 'page-code-meta', improvedMarkdown: `${markdown}\n\n\`\`\`xml\n${sample}\n\`\`\`\n`, version: 7 });

        expect(response.statusCode, response.body).toBe(200);
        expect(codeMacros(sentStorage())[2]).toEqual([[['language', 'xml']], `${sample}\n`]);
      });

      it('answers a caller without page access before a content-dependent refusal (Y3)', async () => {
        const { pageId, markdown } = await seed();
        const before = await readPage(pageId);
        userId = otherUserId;
        await setIntegration(otherUserId, true);

        const response = await apply({
          pageId: 'page-code-meta', improvedMarkdown: `${markdown}\n\n<div class="panel-info" data-macro-name="code">x</div>\n`, version: 7,
        });

        expect(response.statusCode, response.body).toBe(403);
        expect(response.json()).toMatchObject({ reason: 'not_authorized' });
        await expectNothingDispatched(pageId, before);
      });

      it('denies a deactivated actor with otherwise valid Markdown before any preparation or reservation (r1 CM-2)', async () => {
        const { pageId, markdown } = await seed();
        const before = await readPage(pageId);
        await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);

        const response = await apply({ pageId: 'page-code-meta', improvedMarkdown: markdown, version: 7 });

        expect(response.statusCode, response.body).toBe(403);
        expect(response.json()).toMatchObject({ reason: 'not_authorized' });
        await expectNothingDispatched(pageId, before);
      });

      it('denies a caller without page access whose Markdown the previous release generated, before the format check (r1 CM-2)', async () => {
        const { pageId } = await seed();
        const before = await readPage(pageId);
        userId = otherUserId;
        await setIntegration(otherUserId, true);

        const response = await apply({ pageId: 'page-code-meta', improvedMarkdown: 'Plain text from anywhere', version: 7 });

        expect(response.statusCode, response.body).toBe(403);
        await expectNothingDispatched(pageId, before);
      });

      it('refuses a non-ASCII-prefixed code macro the CDATA pass would make live on a page without annotated blocks (r1 CM-8)', async () => {
        const pageId = await insertConfluencePage('page-no-skeleton', 'Plain article', 'OPS');
        const storage = '<p>Plain</p>';
        const bodyHtml = confluenceToHtml(storage, 'page-no-skeleton', 'OPS');
        await setPageContent(pageId, bodyHtml, 7, storage);
        await enableConfluence(true);
        const markdown = htmlToMarkdown(protectMedia(bodyHtml).html, { layoutTokens: true });
        const before = await readPage(pageId);
        const prefix = 'a\u1680b';
        const comment = `<!-- <ac:plain-text-body>&#45;&#45;&gt;&lt;${prefix}:structured-macro xmlns:${prefix}="urn:z" ${prefix}:name="code"&gt;`
          + `&lt;ac:plain-text-body&gt;&lt;![CDATA[x</ac:plain-text-body></${prefix}:structured-macro> -->`;

        const refused = await apply({ pageId: 'page-no-skeleton', improvedMarkdown: `${markdown}\n\n${comment}\n`, version: 7 });

        expect(refused.statusCode, refused.body).toBe(422);
        expect(refused.json()).toMatchObject({ reason: 'unapproved-code-macro' });
        await expectNothingDispatched(pageId, before);

        acceptNextConfluenceUpdate();
        const clean = await apply({ pageId: 'page-no-skeleton', improvedMarkdown: markdown.replace('Plain', 'Clear'), version: 7 });
        expect(clean.statusCode, clean.body).toBe(200);
        expect(sentStorage()).toBe('<p>Clear</p>\n');
      });

      describe('the local write of a synced page while the integration is off', () => {
        it('judges the projections with the stored storage and keeps the metadata', async () => {
          const { pageId, markdown } = await seed('page-code-local');
          await setIntegration(userId, false);

          const response = await apply({ pageId: String(pageId), improvedMarkdown: markdown, version: 7 });

          expect(response.statusCode, response.body).toBe(200);
          const saved = await readPage(pageId);
          expect(saved.body_storage).toBe(STORAGE);
          expect(codeMacros(htmlToConfluence(saved.body_html, { previousStorage: STORAGE }))).toEqual(codeMacros(STORAGE));
          expect(mockHttpRequest).not.toHaveBeenCalled();
        });

        it('refuses an unreadable projection before the write transaction', async () => {
          const { pageId, markdown } = await seed('page-code-local-bad');
          await setIntegration(userId, false);
          const before = await readPage(pageId);

          const response = await apply({ pageId: String(pageId), improvedMarkdown: `${markdown}\n\n<p title="a<b">t</p>\n`, version: 7 });

          expect(response.statusCode, response.body).toBe(422);
          expect(response.json()).toMatchObject({ reason: 'not-well-formed' });
          expect(await readPage(pageId)).toEqual(before);
        });

        it('answers 409 when the stored storage the projections were judged with changed while it waited', async () => {
          const { pageId, markdown } = await seed('page-code-local-race');
          await setIntegration(userId, false);
          const blocker = await getPool().connect();
          await blocker.query('BEGIN');
          await lockPageLifecycle(blocker, [pageId]);
          try {
            const pending = apply({ pageId: String(pageId), improvedMarkdown: markdown, version: 7 });
            await waitForBlockedLifecycleLock();
            await blocker.query('UPDATE pages SET body_storage = $2 WHERE id = $1', [pageId, '<p>re-synced</p>']);
            await blocker.query('COMMIT');

            const response = await pending;
            expect(response.statusCode).toBe(409);
          } catch (error) {
            await blocker.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            blocker.release();
          }
          expect(await readPage(pageId)).toMatchObject({ version: 7, body_storage: '<p>re-synced</p>', local_modified_by: null });
        });
      });
    });

    it('validates the required request fields at the route boundary', async () => {
      const missingPage = await apply({ improvedMarkdown: 'Better' });
      const missingMarkdown = await apply({ pageId: '1' });
      expect(missingPage.statusCode).toBe(400);
      expect(missingMarkdown.statusCode).toBe(400);
    });
  },
);
