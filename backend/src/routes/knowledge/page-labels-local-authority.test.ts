import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type { FastifyInstance } from 'fastify';
import type * as Undici from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Label writes on a synced page while the CALLER's Confluence integration is
// off take the local branch of applyLabelChanges. That branch must enforce the
// page-edit rule itself; the Confluence REST boundary is the only mock.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return { ...actual, request: vi.fn() };
});

import { request } from 'undici';
import { getPool, query } from '../../core/db/postgres.js';
import { lockPageLifecycle } from '../../core/services/page-write-admission.js';
import { invalidateRbacCache } from '../../core/services/rbac-service.js';
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
} from './pages.test-helpers.js';
import { pagesTagRoutes } from './pages-tags.js';

const SPACE = 'LABEL-OPS';
const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
const mockRequest = vi.mocked(request);

async function labelsFor(pageId: number): Promise<string[]> {
  const result = await query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [pageId]);
  return result.rows[0]!.labels;
}

async function waitForBlockedLifecycleLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
            AND query LIKE '%pg_advisory_xact_lock%'
       ) AS waiting`,
    );
    if (waiting.rows[0]?.waiting) return;
  }
  throw new Error('Label writer did not reach the lifecycle admission barrier');
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'label writes on a synced page while the caller has Confluence switched off',
  () => {
    let app: FastifyInstance;
    let redis: RedisClientType;
    let actorId: string;
    let memberId: string;
    let outsiderId: string;
    let pageId: number;

    async function setIntegration(user: string, enabled: boolean): Promise<void> {
      await query(
        `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
         VALUES ($1, 'https://confluence-labels.example.test', $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET confluence_enabled = EXCLUDED.confluence_enabled`,
        [user, encryptPat('label-authority-pat'), enabled],
      );
    }

    async function grantSpace(user: string): Promise<void> {
      const role = await query<{ id: number }>(
        `INSERT INTO roles (name, display_name, permissions)
         VALUES ('label-authority-editor', 'Label authority editor', ARRAY['read', 'write'])
         ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
         RETURNING id`,
      );
      await query(
        `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
         VALUES ($1, 'user', $2, $3) ON CONFLICT DO NOTHING`,
        [SPACE, user, role.rows[0]!.id],
      );
      // The role-assignment routes clear the RBAC space cache the same way.
      await invalidateRbacCache(user);
    }

    async function grantAce(user: string): Promise<void> {
      await query(
        `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'read')`,
        [pageId, user],
      );
    }

    function putLabels() {
      return app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}/labels`,
        payload: { addLabels: ['taken-over'], removeLabels: ['runbook'] },
      });
    }

    function applyTags() {
      return app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/apply-tags`,
        payload: { tags: ['troubleshooting'] },
      });
    }

    beforeAll(async () => {
      await setupTestDb();
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      }) as RedisClientType;
      await redis.connect();
      setRedisClient(redis);
      app = await buildKnowledgeTestApp(() => actorId, async (instance) => {
        instance.redis = redis;
        await instance.register(pagesTagRoutes, { prefix: '/api' });
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
      mockRequest.mockReset();
      memberId = await insertUser(`label-member-${randomUUID()}`);
      outsiderId = await insertUser(`label-outsider-${randomUUID()}`);
      await query(
        `INSERT INTO spaces (space_key, space_name, source, last_synced)
         VALUES ($1, $1, 'confluence', NOW())`,
        [SPACE],
      );
      await grantSpace(memberId);
      pageId = await insertConfluencePage('label-authority-page', 'Restricted runbook', SPACE);
      await query(
        `UPDATE pages SET inherit_perms = FALSE, labels = ARRAY['runbook']::text[] WHERE id = $1`,
        [pageId],
      );
    });

    it('keeps the enabled-integration refusal for an ACE holder without a space role', async () => {
      await grantAce(outsiderId);
      await setIntegration(outsiderId, true);
      actorId = outsiderId;

      const response = await putLabels();

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ reason: 'intent_access_changed' });
      expect(mockRequest).not.toHaveBeenCalled();
      expect(await labelsFor(pageId)).toEqual(['runbook']);
    });

    it('conceals the page from an ACE holder without a space role who switched the integration off', async () => {
      await grantAce(outsiderId);
      await setIntegration(outsiderId, false);
      actorId = outsiderId;

      const labels = await putLabels();
      const tags = await applyTags();

      expect(labels.statusCode).toBe(404);
      expect(labels.json()).toEqual({ error: 'Page not found' });
      expect(tags.statusCode).toBe(404);
      expect(tags.json()).toEqual({ error: 'Page not found' });
      expect(mockRequest).not.toHaveBeenCalled();
      expect(await labelsFor(pageId)).toEqual(['runbook']);
    });

    it('writes locally for a space member holding the page ACE, without contacting Confluence', async () => {
      await grantAce(memberId);
      await setIntegration(memberId, false);
      actorId = memberId;

      const labels = await putLabels();
      const tags = await applyTags();

      expect(labels.statusCode, labels.body).toBe(200);
      expect(labels.json()).toEqual({ labels: ['taken-over'] });
      expect(tags.statusCode, tags.body).toBe(200);
      expect(await labelsFor(pageId)).toEqual(['taken-over', 'troubleshooting']);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('re-checks authority inside the write transaction after the space role is revoked', async () => {
      await grantAce(memberId);
      await setIntegration(memberId, false);
      actorId = memberId;
      const blocker = await getPool().connect();
      await blocker.query('BEGIN');
      await lockPageLifecycle(blocker, [pageId]);
      try {
        const pending = putLabels();
        await waitForBlockedLifecycleLock();
        await blocker.query(
          `DELETE FROM space_role_assignments WHERE principal_type = 'user' AND principal_id = $1`,
          [memberId],
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
      expect(await labelsFor(pageId)).toEqual(['runbook']);
    });

    it('keeps the standalone rule: a non-owner may relabel a shared article, not a private one', async () => {
      await insertLocalSpace('LABEL-LOCAL', memberId);
      const shared = await insertStandalonePage('Shared notes', 'shared', memberId, 'LABEL-LOCAL');
      const privatePage = await insertStandalonePage('Private notes', 'private', memberId, 'LABEL-LOCAL');
      await setIntegration(outsiderId, false);
      actorId = outsiderId;

      const sharedResponse = await app.inject({
        method: 'PUT',
        url: `/api/pages/${shared}/labels`,
        payload: { addLabels: ['team'] },
      });
      const privateResponse = await app.inject({
        method: 'PUT',
        url: `/api/pages/${privatePage}/labels`,
        payload: { addLabels: ['team'] },
      });

      expect(sharedResponse.statusCode, sharedResponse.body).toBe(200);
      expect(await labelsFor(shared)).toEqual(['team']);
      expect(privateResponse.statusCode).toBe(404);
      expect(await labelsFor(privatePage)).toEqual([]);
    });
  },
);
