/**
 * Bulk-selection identity tests against real PostgreSQL, Redis, RBAC,
 * admission, audit, attachment cleanup, and Confluence client wiring.
 *
 * Confluence is represented by a loopback HTTP server: it is the only external
 * system in this suite. Numeric Confluence ids must reach the mixed-id resolver,
 * while an id that names two visible rows must be refused rather than guessed.
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { lockPageLifecycle } from '../../core/services/page-write-admission.js';
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
  insertLocalSpace,
  insertUser,
} from './pages.test-helpers.js';

const NUMERIC_CONFLUENCE_ID = '12345';
const COLLIDING_ID = 777777;
const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);

type ExternalRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
};

let app: FastifyInstance;
let redis: RedisClientType;
let confluence: Server;
let confluenceBaseUrl: string;
let externalRequests: ExternalRequest[] = [];
let userId: string;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;
let originalPatEncryptionKey: string | undefined;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function assignSpace(user: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ($1, 'Bulk identity editor', ARRAY['read', 'comment', 'edit', 'delete'])
     RETURNING id`,
    [`bulk-identity-${randomUUID()}`],
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, user, role.rows[0]!.id],
  );
}

async function insertSynced(opts: {
  confluenceId: string;
  title?: string;
  id?: number;
}): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO pages (${opts.id !== undefined ? 'id, ' : ''}confluence_id, source, space_key,
                        title, body_text, body_storage, body_html, inherit_perms, version,
                        embedding_dirty, image_analysis_dirty)
     VALUES (${opts.id !== undefined ? `${opts.id}, ` : ''}$1, 'confluence', 'DEV', $2,
             'text', '<p>x</p>', '<p>x</p>', TRUE, 1, FALSE, FALSE)
     RETURNING id`,
    [opts.confluenceId, opts.title ?? `Synced ${opts.confluenceId}`],
  );
  return result.rows[0]!.id;
}

async function insertStandalone(opts: { title: string; id?: number }): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO pages (${opts.id !== undefined ? 'id, ' : ''}source, space_key, title, body_text,
                        body_storage, body_html, created_by_user_id, visibility, version,
                        page_type, embedding_dirty, embedding_status, last_synced)
     VALUES (${opts.id !== undefined ? `${opts.id}, ` : ''}'standalone', 'LOCAL', $1, 'text', NULL,
             '<p>x</p>', $2, 'private', 1, 'page', FALSE, 'not_embedded', NOW())
     RETURNING id`,
    [opts.title, userId],
  );
  return result.rows[0]!.id;
}

async function liveIds(): Promise<number[]> {
  const result = await query<{ id: number }>(
    'SELECT id FROM pages WHERE deleted_at IS NULL ORDER BY id',
  );
  return result.rows.map((row) => row.id);
}

function providerDeleteIds(): string[] {
  return externalRequests.flatMap((request) => {
    if (request.method !== 'DELETE') return [];
    const match = request.url.match(/^\/rest\/api\/content\/([^/]+)$/);
    return match ? [decodeURIComponent(match[1]!)] : [];
  });
}

async function auditMetadata(action: string): Promise<Record<string, unknown>[]> {
  const result = await query<{ metadata: Record<string, unknown> }>(
    'SELECT metadata FROM audit_log WHERE action = $1 ORDER BY created_at, id',
    [action],
  );
  return result.rows.map((row) => row.metadata);
}

async function waitForBlockedLifecycleLock(holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_locks held
           JOIN pg_locks waiting
             ON waiting.locktype = held.locktype
            AND waiting.database IS NOT DISTINCT FROM held.database
            AND waiting.classid IS NOT DISTINCT FROM held.classid
            AND waiting.objid IS NOT DISTINCT FROM held.objid
            AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
          WHERE held.pid = $1
            AND held.locktype = 'advisory'
            AND held.granted
            AND NOT waiting.granted
       ) AS waiting`,
      [holderPid],
    );
    if (result.rows[0]?.waiting) return;
  }
  throw new Error('bulk delete did not reach the held page lifecycle lock');
}

async function pageState(id: number): Promise<{
  source: string;
  confluence_id: string | null;
  space_key: string | null;
  body_html: string;
  labels: string[];
  deleted_at: Date | null;
} | undefined> {
  return (
    await query<{
      source: string;
      confluence_id: string | null;
      space_key: string | null;
      body_html: string;
      labels: string[];
      deleted_at: Date | null;
    }>(
      `SELECT source, confluence_id, space_key, body_html, labels, deleted_at
         FROM pages WHERE id = $1`,
      [id],
    )
  ).rows[0];
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'bulk selection addressing by confluence_id — real infrastructure',
  () => {
    beforeAll(async () => {
      originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
      originalPatEncryptionKey = process.env.PAT_ENCRYPTION_KEY;
      attachmentsDir = await mkdtemp(join(tmpdir(), 'bulk-confluence-id-'));
      process.env.ATTACHMENTS_DIR = attachmentsDir;
      process.env.PAT_ENCRYPTION_KEY = 'bulk-identity-encryption-key-at-least-32-bytes';

      await setupTestDb();
      confluence = createServer(async (request, response) => {
        const body = await readBody(request);
        externalRequests.push({
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          authorization: typeof request.headers.authorization === 'string'
            ? request.headers.authorization
            : undefined,
          body,
        });
        if (
          request.url?.startsWith('/rest/api/content/') &&
          (request.method === 'DELETE' || request.method === 'POST')
        ) {
          response.writeHead(204).end();
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'unexpected test request' }));
      });
      await new Promise<void>((resolve) => confluence.listen(0, '127.0.0.1', resolve));
      confluenceBaseUrl = `http://127.0.0.1:${(confluence.address() as AddressInfo).port}`;

      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      await redis.connect();
      setRedisClient(redis);

      app = await buildKnowledgeTestApp(() => userId, async (instance) => {
        instance.redis = redis;
        // This integration test intentionally loads the route graph only after
        // its call-time filesystem sandbox and real Redis client are installed.
        const { pagesCrudRoutes } = await import('./pages-crud.js');
        await instance.register(pagesCrudRoutes, { prefix: '/api' });
      });
    });

    afterAll(async () => {
      await app.close();
      if (redis.isOpen) await redis.quit();
      await new Promise<void>((resolve, reject) => {
        confluence.close((error) => error ? reject(error) : resolve());
      });
      await teardownTestDb();
      await rm(attachmentsDir, { recursive: true, force: true });
      if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
      else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
      if (originalPatEncryptionKey === undefined) delete process.env.PAT_ENCRYPTION_KEY;
      else process.env.PAT_ENCRYPTION_KEY = originalPatEncryptionKey;
    });

    beforeEach(async () => {
      await truncateAllTables();
      await redis.flushDb();
      await rm(attachmentsDir, { recursive: true, force: true });
      await mkdir(attachmentsDir, { recursive: true });
      externalRequests = [];

      userId = await insertUser(`bulk-identity-${randomUUID()}`);
      await insertLocalSpace('LOCAL', userId);
      await query(
        `INSERT INTO spaces (space_key, space_name, source, last_synced)
         VALUES ('DEV', 'Development', 'confluence', NOW())`,
      );
      await assignSpace(userId, 'DEV');
      await query(
        `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
         VALUES ($1, $2, $3, TRUE)`,
        [userId, confluenceBaseUrl, encryptPat('bulk-identity-test-pat')],
      );
    });

    it('deletes a page addressed by its numeric Confluence id and leaves adjacent state alone', async () => {
      const target = await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      const bystander = await insertSynced({ confluenceId: '54321' });
      const attachmentPath = join(attachmentsDir, NUMERIC_CONFLUENCE_ID);
      await mkdir(attachmentPath, { recursive: true });
      await writeFile(join(attachmentPath, 'evidence.png'), 'real attachment bytes');
      await redis.set('kb:another-user:pages:list', 'stale');
      await redis.set('kb:another-user:spaces:list', 'stale');

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [NUMERIC_CONFLUENCE_ID] },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(providerDeleteIds()).toEqual([NUMERIC_CONFLUENCE_ID]);
      expect(externalRequests[0]?.authorization).toBe('Bearer bulk-identity-test-pat');
      expect(await liveIds()).toEqual([bystander]);
      expect(target).not.toBe(bystander);
      await expect(access(attachmentPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await redis.exists('kb:another-user:pages:list')).toBe(0);
      expect(await redis.exists('kb:another-user:spaces:list')).toBe(0);
      expect(await auditMetadata('PAGE_DELETED')).toEqual([
        expect.objectContaining({ affectedCount: 1, succeeded: 1, failed: 0 }),
      ]);
    });

    it('deduplicates repeated input and the same page named by both identifiers', async () => {
      const pageId = await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      const other = await insertSynced({ confluenceId: '54321' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: {
          ids: [NUMERIC_CONFLUENCE_ID, NUMERIC_CONFLUENCE_ID, String(pageId), String(pageId)],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(providerDeleteIds()).toEqual([NUMERIC_CONFLUENCE_ID]);
      expect(await liveIds()).toEqual([other]);
    });

    it('treats a page whose PK equals its numeric Confluence id as one target', async () => {
      await insertSynced({ id: COLLIDING_ID, confluenceId: String(COLLIDING_ID) });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(COLLIDING_ID)] },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(providerDeleteIds()).toEqual([String(COLLIDING_ID)]);
      expect(await liveIds()).toEqual([]);
    });

    async function seedCollision(): Promise<{ byPk: number; byConfluenceId: number }> {
      const byPk = await insertStandalone({ title: 'Standalone collision', id: COLLIDING_ID });
      const byConfluenceId = await insertSynced({ confluenceId: String(COLLIDING_ID) });
      return { byPk, byConfluenceId };
    }

    it('refuses an ambiguous visible identifier without deleting either candidate', async () => {
      const { byPk, byConfluenceId } = await seedCollision();

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(COLLIDING_ID)] },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
      expect(response.json().errors).toEqual([
        `Page ${COLLIDING_ID}: ambiguous identifier — it is one page's id and another page's Confluence id; no action taken`,
      ]);
      expect(providerDeleteIds()).toEqual([]);
      expect(await liveIds()).toEqual([byConfluenceId, byPk].sort((a, b) => a - b));
    });

    it('keeps partial success when an ambiguous member accompanies a valid member', async () => {
      const { byPk, byConfluenceId } = await seedCollision();
      await insertSynced({ confluenceId: '54321' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(COLLIDING_ID), '54321'] },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 1 });
      expect(response.json().errors[0]).toMatch(/ambiguous identifier/);
      expect(providerDeleteIds()).toEqual(['54321']);
      expect(await liveIds()).toEqual([byConfluenceId, byPk].sort((a, b) => a - b));
    });

    it('does not treat a soft-deleted row as an ambiguity candidate', async () => {
      await insertStandalone({ title: 'Trashed collision', id: COLLIDING_ID });
      await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [COLLIDING_ID]);
      await insertSynced({ confluenceId: String(COLLIDING_ID) });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(COLLIDING_ID)] },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(providerDeleteIds()).toEqual([String(COLLIDING_ID)]);
      expect(await liveIds()).toEqual([]);
    });

    it('does not disclose an ambiguity candidate outside the actor RBAC scope', async () => {
      await query(
        `INSERT INTO spaces (space_key, space_name, source, last_synced)
         VALUES ('SECRET', 'Secret', 'confluence', NOW())`,
      );
      await query(
        `INSERT INTO pages (id, confluence_id, source, space_key, title, body_text,
                            body_storage, body_html, inherit_perms, version)
         VALUES ($1, 'secret-page', 'confluence', 'SECRET', 'Hidden', 'text',
                 '<p>x</p>', '<p>x</p>', TRUE, 1)`,
        [COLLIDING_ID],
      );
      const visible = await insertSynced({ confluenceId: String(COLLIDING_ID) });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [String(COLLIDING_ID)] },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 0, errors: [] });
      expect(providerDeleteIds()).toEqual([String(COLLIDING_ID)]);
      expect(await pageState(visible)).toBeUndefined();
      expect(await liveIds()).toEqual([COLLIDING_ID]);
    });

    it('bounds deletion blast radius to one resolved page per supplied identifier', async () => {
      const namedSynced = await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      const namedStandalone = await insertStandalone({ title: 'Named standalone' });
      const decoyByConfluenceId = await insertSynced({
        confluenceId: String(namedStandalone),
        title: 'Decoy by Confluence id',
      });
      const untouchedSynced = await insertSynced({ confluenceId: '99999' });
      const untouchedStandalone = await insertStandalone({ title: 'Untouched standalone' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: { ids: [NUMERIC_CONFLUENCE_ID, String(namedStandalone)] },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 1, failed: 1 });
      expect(response.json().errors).toEqual([
        `Page ${namedStandalone}: ambiguous identifier — it is one page's id and another page's Confluence id; no action taken`,
      ]);
      expect(providerDeleteIds()).toEqual([NUMERIC_CONFLUENCE_ID]);
      expect(await liveIds()).toEqual(
        [namedStandalone, decoyByConfluenceId, untouchedSynced, untouchedStandalone].sort(
          (left, right) => left - right,
        ),
      );
      expect(namedSynced).not.toBe(decoyByConfluenceId);
    });

    it('never deletes more live rows than the distinct identifiers supplied', async () => {
      await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });
      await insertSynced({ confluenceId: '54321' });
      const standalone = await insertStandalone({ title: 'Named standalone' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/delete',
        payload: {
          ids: [NUMERIC_CONFLUENCE_ID, '54321', String(standalone), NUMERIC_CONFLUENCE_ID],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ succeeded: 3, failed: 0, errors: [] });
      expect(providerDeleteIds().sort()).toEqual(['12345', '54321']);
      expect(await liveIds()).toEqual([]);
    });

    it.each([
      {
        name: 'content revision',
        mutate: async (client: PoolClient, pageId: number) => {
          await client.query(
            "UPDATE pages SET body_html = '<p>replacement body</p>' WHERE id = $1",
            [pageId],
          );
        },
        error: /page content changed/i,
        expected: {
          source: 'confluence',
          confluence_id: '707070',
          space_key: 'DEV',
          body_html: '<p>replacement body</p>',
          labels: [],
          deleted_at: null,
        },
      },
      {
        name: 'source and Confluence identity',
        mutate: async (client: PoolClient, pageId: number) => {
          await client.query(
            `UPDATE pages
                SET source = 'standalone', confluence_id = 'replacement-707070',
                    space_key = 'LOCAL', created_by_user_id = $2, visibility = 'private'
              WHERE id = $1`,
            [pageId, userId],
          );
        },
        error: /page content changed/i,
        expected: {
          source: 'standalone',
          confluence_id: 'replacement-707070',
          space_key: 'LOCAL',
          body_html: '<p>x</p>',
          labels: [],
          deleted_at: null,
        },
      },
      {
        name: 'actor space authority',
        mutate: async (client: PoolClient, _pageId: number) => {
          await client.query(
            `DELETE FROM space_role_assignments
              WHERE principal_type = 'user' AND principal_id = $1 AND space_key = 'DEV'`,
            [userId],
          );
        },
        error: /access denied|not authorized/i,
        expected: {
          source: 'confluence',
          confluence_id: '707070',
          space_key: 'DEV',
          body_html: '<p>x</p>',
          labels: [],
          deleted_at: null,
        },
      },
    ])(
      'refuses a stale numeric selection when $name changes behind lifecycle admission',
      async ({ mutate, error, expected }) => {
        const pageId = await insertSynced({ confluenceId: '707070', title: 'Original target' });
        const attachmentPath = join(attachmentsDir, '707070');
        await mkdir(attachmentPath, { recursive: true });
        await writeFile(join(attachmentPath, 'keep.txt'), 'must survive stale selection');

        const blocker = await getPool().connect();
        await blocker.query('BEGIN');
        await lockPageLifecycle(blocker, [pageId]);
        const holder = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        try {
          const pendingDelete = app.inject({
            method: 'POST',
            url: '/api/pages/bulk/delete',
            payload: { ids: ['707070'] },
          });
          await waitForBlockedLifecycleLock(holder.rows[0]!.pid);
          await mutate(blocker, pageId);
          await blocker.query('COMMIT');

          const response = await pendingDelete;
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
          expect(response.json().errors[0]).toMatch(error);
          expect(await pageState(pageId)).toEqual(expected);
          expect(providerDeleteIds()).toEqual([]);
          const unresolved = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM page_write_intents
              WHERE settled_at IS NULL`,
          );
          expect(unresolved.rows[0]!.count).toBe('0');
          await expect(access(join(attachmentPath, 'keep.txt'))).resolves.toBeUndefined();
        } catch (error) {
          await blocker.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          blocker.release();
        }
      },
    );

    it.each([
      {
        surface: 'add/remove',
        url: '/api/pages/bulk/tag',
        payload: (pageId: number) => ({
          ids: [String(pageId)],
          addTags: ['new'],
          removeTags: ['old'],
        }),
        expected: ['new'],
      },
      {
        surface: 'replacement',
        url: '/api/pages/bulk/replace-tags',
        payload: (pageId: number) => ({
          ids: [String(pageId)],
          tags: ['replacement'],
        }),
        expected: ['replacement'],
      },
    ])(
      'keeps the $surface label operation local when Confluence was already disabled',
      async ({ url, payload, expected }) => {
        const pageId = await insertSynced({ confluenceId: '797979', title: 'Local labels' });
        await query("UPDATE pages SET labels = ARRAY['old'] WHERE id = $1", [pageId]);
        await query(
          'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
          [userId],
        );

        const response = await app.inject({
          method: 'POST',
          url,
          payload: payload(pageId),
        });

        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ succeeded: 1, failed: 0 });
        expect((await pageState(pageId))?.labels).toEqual(expected);
        expect(externalRequests).toEqual([]);
        const intents = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM page_write_intents`,
        );
        expect(intents.rows[0]!.count).toBe('0');
      },
    );

    it.each([
      {
        surface: 'add/remove',
        change: 'integration mode is disabled',
        url: '/api/pages/bulk/tag',
        payload: (pageId: number) => ({
          ids: [String(pageId)],
          addTags: ['new'],
          removeTags: ['old'],
        }),
        mutate: async (client: PoolClient) => {
          await client.query(
            'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
            [userId],
          );
        },
        error: 'Confluence integration is disabled',
      },
      {
        surface: 'replacement',
        change: 'integration mode is disabled',
        url: '/api/pages/bulk/replace-tags',
        payload: (pageId: number) => ({
          ids: [String(pageId)],
          tags: ['replacement'],
        }),
        mutate: async (client: PoolClient) => {
          await client.query(
            'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
            [userId],
          );
        },
        error: 'Confluence integration is disabled',
      },
      {
        surface: 'add/remove',
        change: 'credentials are revoked',
        url: '/api/pages/bulk/tag',
        payload: (pageId: number) => ({
          ids: [String(pageId)],
          addTags: ['new'],
          removeTags: ['old'],
        }),
        mutate: async (client: PoolClient) => {
          await client.query(
            `UPDATE user_settings
                SET confluence_url = NULL, confluence_pat = NULL
              WHERE user_id = $1`,
            [userId],
          );
        },
        error: 'Confluence credentials changed before the remote write',
      },
      {
        surface: 'replacement',
        change: 'credentials are revoked',
        url: '/api/pages/bulk/replace-tags',
        payload: (pageId: number) => ({
          ids: [String(pageId)],
          tags: ['replacement'],
        }),
        mutate: async (client: PoolClient) => {
          await client.query(
            `UPDATE user_settings
                SET confluence_url = NULL, confluence_pat = NULL
              WHERE user_id = $1`,
            [userId],
          );
        },
        error: 'Confluence credentials changed before the remote write',
      },
    ])(
      'keeps $surface labels unchanged and settles the unused intent when $change',
      async ({ url, payload, mutate, error }) => {
        const pageId = await insertSynced({ confluenceId: '808080', title: 'Label admission' });
        await query("UPDATE pages SET labels = ARRAY['old'] WHERE id = $1", [pageId]);

        const blocker = await getPool().connect();
        await blocker.query('BEGIN');
        await lockPageLifecycle(blocker, [pageId]);
        const holder = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        try {
          const pending = app.inject({
            method: 'POST',
            url,
            payload: payload(pageId),
          });
          await waitForBlockedLifecycleLock(holder.rows[0]!.pid);
          await mutate(blocker);
          await blocker.query('COMMIT');

          const response = await pending;
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
          expect(response.json().errors[0]).toContain(error);
          expect((await pageState(pageId))?.labels).toEqual(['old']);
          expect(externalRequests).toEqual([]);
          const unresolved = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM page_write_intents
              WHERE settled_at IS NULL`,
          );
          expect(unresolved.rows[0]!.count).toBe('0');
        } catch (error) {
          await blocker.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          blocker.release();
        }
      },
    );

    it.each([
      {
        surface: 'add/remove',
        url: '/api/pages/bulk/tag',
        payload: (pageId: number) => ({ ids: [String(pageId)], addTags: ['new'] }),
      },
      {
        surface: 'replacement',
        url: '/api/pages/bulk/replace-tags',
        payload: (pageId: number) => ({ ids: [String(pageId)], tags: ['replacement'] }),
      },
    ])(
      'keeps $surface labels unchanged and settles the unused intent when space authority is revoked',
      async ({ url, payload }) => {
        const pageId = await insertSynced({ confluenceId: '818181', title: 'Label authority' });
        await query("UPDATE pages SET labels = ARRAY['old'] WHERE id = $1", [pageId]);

        const blocker = await getPool().connect();
        await blocker.query('BEGIN');
        await lockPageLifecycle(blocker, [pageId]);
        const holder = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        try {
          const pending = app.inject({
            method: 'POST',
            url,
            payload: payload(pageId),
          });
          await waitForBlockedLifecycleLock(holder.rows[0]!.pid);
          await blocker.query(
            `DELETE FROM space_role_assignments
              WHERE principal_type = 'user' AND principal_id = $1 AND space_key = 'DEV'`,
            [userId],
          );
          await blocker.query('COMMIT');

          const response = await pending;
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
          expect(response.json().errors[0]).toMatch(/access denied|not authorized/i);
          expect((await pageState(pageId))?.labels).toEqual(['old']);
          expect(externalRequests).toEqual([]);
          const unresolved = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM page_write_intents
              WHERE settled_at IS NULL`,
          );
          expect(unresolved.rows[0]!.count).toBe('0');
        } catch (error) {
          await blocker.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          blocker.release();
        }
      },
    );

    it("keeps the numeric-only tag surface keyed by the page PK", async () => {
      const pageId = await insertSynced({ confluenceId: NUMERIC_CONFLUENCE_ID });

      const byConfluenceId = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: { ids: [NUMERIC_CONFLUENCE_ID], addTags: ['wrong'] },
      });
      const byPk = await app.inject({
        method: 'POST',
        url: '/api/pages/bulk/tag',
        payload: { ids: [String(pageId)], addTags: ['right'] },
      });

      expect(byConfluenceId.statusCode, byConfluenceId.body).toBe(200);
      expect(byConfluenceId.json()).toMatchObject({ succeeded: 0, failed: 1 });
      expect(byConfluenceId.json().errors).toEqual([`Page ${NUMERIC_CONFLUENCE_ID} not found`]);
      expect(byPk.statusCode, byPk.body).toBe(200);
      expect(byPk.json()).toMatchObject({ succeeded: 1, failed: 0 });
      const labels = await query<{ labels: string[] }>(
        'SELECT labels FROM pages WHERE id = $1',
        [pageId],
      );
      expect(labels.rows[0]!.labels).toEqual(['right']);
      expect(externalRequests).toEqual([
        expect.objectContaining({
          method: 'POST',
          url: `/rest/api/content/${NUMERIC_CONFLUENCE_ID}/label`,
        }),
      ]);
    });
  },
);
