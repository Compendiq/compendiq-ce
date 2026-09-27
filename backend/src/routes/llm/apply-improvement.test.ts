import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type * as Undici from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getPool, query } from '../../core/db/postgres.js';
import { confluenceToHtml, htmlToMarkdown, protectMedia } from '../../core/services/content-converter.js';
import {
  lockPageLifecycle,
  reconcilePageWriteIntent,
} from '../../core/services/page-write-admission.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
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

function acceptNextConfluenceUpdate(): void {
  mockHttpRequest.mockImplementationOnce(async (url: string, options: Record<string, unknown>) => {
    lastConfluenceRequest = { url, options };
    const sent = JSON.parse(String(options.body)) as {
      title: string;
      version: { number: number };
      body: { storage: { value: string } };
    };
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

    it('pushes production XHTML and commits the accepted body, exact improvement status, and audit row', async () => {
      const pageId = await insertConfluencePage('page-1', 'Synced article', 'OPS');
      await setPageContent(pageId, '<p>Old body</p>', 5, '<p>Old storage</p>');
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
      acceptNextConfluenceUpdate();

      const response = await apply({
        pageId: 'page-1',
        improvedMarkdown,
        version: 5,
        title: 'Improved title',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ id: pageId, title: 'Improved title', version: 6 });
      expect(lastConfluenceRequest?.url).toBe('https://confluence.example.test/rest/api/content/page-1');
      const sent = JSON.parse(String(lastConfluenceRequest?.options.body));
      expect(sent).toMatchObject({ title: 'Improved title', version: { number: 6 } });
      expect(sent.body.storage.value).toContain('<h2>Improved</h2>');
      expect(sent.body.storage.value).toContain('<strong>content</strong>');

      const saved = await readPage(pageId);
      expect(saved).toMatchObject({
        title: 'Improved title',
        version: 6,
        body_storage: sent.body.storage.value,
        local_modified_at: null,
        local_modified_by: null,
        embedding_dirty: true,
        image_analysis_dirty: true,
      });
      expect(saved.body_html).toContain('<h2>Improved</h2>');
      expect(saved.body_text).toContain('Improved Better content.');

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
          intendedStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(Object.keys(intent.rows[0]!.effect).sort()).toEqual([
        'confluenceId',
        'effectClass',
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

    it('validates the required request fields at the route boundary', async () => {
      const missingPage = await apply({ improvedMarkdown: 'Better' });
      const missingMarkdown = await apply({ pageId: '1' });
      expect(missingPage.statusCode).toBe(400);
      expect(missingMarkdown.statusCode).toBe(400);
    });
  },
);
