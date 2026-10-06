/**
 * Sync webhook integration coverage (#114).
 *
 * The producer is exercised through real PostgreSQL mutations and a real
 * ConfluenceClient talking to the HTTP fixture below. Events cross the public
 * webhook extension point and an actual HTTP hop before assertions inspect
 * the receiver-visible Standard Webhooks body.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { query } from '../../../core/db/postgres.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import {
  _resetWebhookEmitHookForTests,
  setWebhookEmitHook,
  type WebhookEvent,
} from '../../../core/services/webhook-emit-hook.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { getSyncStatus, syncUser } from './sync-service.js';

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);

interface RemotePage {
  id: string;
  title: string;
  status: 'current';
  type: 'page';
  version: {
    number: number;
    when: string;
    by: { displayName: string };
  };
  body: { storage: { value: string } };
  ancestors: Array<{ id: string; title: string }>;
  metadata: { labels: { results: Array<{ name: string }> } };
}

interface FixtureSpace {
  name: string;
  pages: Map<string, RemotePage>;
}

interface SyncCompletedPayload {
  spaceKey: string;
  pagesCreated: number;
  pagesUpdated: number;
  pagesDeleted: number;
  durationMs: number;
  completedAt: string;
}

interface DeliveredWebhook {
  type: string;
  data: SyncCompletedPayload;
}

interface PersistedPage {
  confluence_id: string;
  source: string;
  space_key: string;
  title: string;
  version: number;
  deleted_at: Date | null;
}

const spaces = new Map<string, FixtureSpace>();
const rejectPageFetch = new Set<string>();
const requestedPaths: string[] = [];
const receivedWebhooks: DeliveredWebhook[] = [];
const pendingDeliveries: Promise<void>[] = [];

let fixtureBaseUrl = '';
let attachmentRoot = '';
let redis: RedisClientType;
let originalAttachmentRoot: string | undefined;
let originalPatEncryptionKey: string | undefined;

function page(id: string, title: string, version = 1): RemotePage {
  return {
    id,
    title,
    status: 'current',
    type: 'page',
    version: {
      number: version,
      when: `2026-09-${String(version).padStart(2, '0')}T12:00:00.000Z`,
      by: { displayName: 'Fixture Author' },
    },
    body: { storage: { value: `<p>${title} body</p>` } },
    ancestors: [],
    metadata: { labels: { results: [] } },
  };
}

function addSpace(spaceKey: string, name: string, remotePages: RemotePage[]): void {
  spaces.set(spaceKey, {
    name,
    pages: new Map(remotePages.map((remotePage) => [remotePage.id, remotePage])),
  });
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function findPage(id: string): RemotePage | undefined {
  for (const fixtureSpace of spaces.values()) {
    const found = fixtureSpace.pages.get(id);
    if (found) return found;
  }
  return undefined;
}

const fixture = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.test');
  requestedPaths.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`);

  if (request.method === 'POST' && url.pathname === '/webhooks') {
    const body = await readRequestBody(request);
    const delivered: DeliveredWebhook = JSON.parse(body);
    receivedWebhooks.push(delivered);
    json(response, 202, { accepted: true });
    return;
  }

  if (request.method !== 'GET') {
    json(response, 405, { message: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/rest/api/space') {
    const results = Array.from(spaces, ([key, fixtureSpace]) => ({
      key,
      name: fixtureSpace.name,
      type: 'global',
      status: 'current',
    }));
    json(response, 200, {
      results,
      start: 0,
      limit: 100,
      size: results.length,
      _links: {},
    });
    return;
  }

  if (url.pathname === '/rest/api/content') {
    const spaceKey = url.searchParams.get('spaceKey');
    const fixtureSpace = spaceKey ? spaces.get(spaceKey) : undefined;
    if (!spaceKey || !fixtureSpace) {
      json(response, 404, { message: 'Unknown space' });
      return;
    }
    const results = Array.from(fixtureSpace.pages.values());
    json(response, 200, {
      results,
      start: 0,
      limit: Number(url.searchParams.get('limit') ?? results.length),
      size: results.length,
      _links: {},
    });
    return;
  }

  const contentPrefix = '/rest/api/content/';
  if (url.pathname.startsWith(contentPrefix)) {
    const contentPath = url.pathname.slice(contentPrefix.length);
    const attachmentSuffix = '/child/attachment';
    if (contentPath.endsWith(attachmentSuffix)) {
      json(response, 200, {
        results: [],
        start: 0,
        limit: 100,
        size: 0,
        _links: {},
      });
      return;
    }

    const pageId = decodeURIComponent(contentPath);
    if (rejectPageFetch.has(pageId)) {
      json(response, 401, { message: 'PAT rejected during page fetch' });
      return;
    }
    const remotePage = findPage(pageId);
    if (remotePage) json(response, 200, remotePage);
    else json(response, 404, { message: 'Page not found' });
    return;
  }

  json(response, 404, { message: 'Fixture route not found' });
});

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

function deliverThroughHttp(event: WebhookEvent): Promise<void> {
  const delivery = fetch(`${fixtureBaseUrl}/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-compendiq-event': event.eventType,
    },
    body: JSON.stringify({ type: event.eventType, data: event.payload }),
  }).then((response) => {
    if (!response.ok) throw new Error(`Webhook receiver answered ${response.status}`);
  });
  pendingDeliveries.push(delivery);
  return delivery;
}

async function seedUser(accessibleSpaces: string[]): Promise<string> {
  const user = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'unused', 'user')
     RETURNING id`,
    [`sync-webhook-${randomUUID()}`],
  );
  const userId = user.rows[0]!.id;
  await query(
    `INSERT INTO user_settings
       (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, $2, $3, TRUE)`,
    [userId, fixtureBaseUrl, encryptPat('fixture-pat')],
  );
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ($1, 'Sync webhook reader', ARRAY['read'])
     RETURNING id`,
    [`sync-webhook-reader-${randomUUID()}`],
  );
  const roleId = role.rows[0]!.id;

  for (const [spaceKey, fixtureSpace] of spaces) {
    await query(
      `INSERT INTO spaces (space_key, space_name)
       VALUES ($1, $2)`,
      [spaceKey, fixtureSpace.name],
    );
  }
  for (const spaceKey of accessibleSpaces) {
    await query(
      `INSERT INTO space_role_assignments
         (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)`,
      [spaceKey, userId, roleId],
    );
  }
  return userId;
}

async function seedExistingPage(
  userId: string,
  spaceKey: string,
  confluenceId: string,
  title: string,
): Promise<void> {
  await query(
    `INSERT INTO pages
       (source, confluence_id, space_key, title, body_storage, body_html,
        body_text, version, visibility, created_by_user_id, embedding_dirty)
     VALUES
       ('confluence', $1, $2, $3, '<p>old body</p>', '<p>old body</p>',
        'old body', 1, 'shared', $4, FALSE)`,
    [confluenceId, spaceKey, title, userId],
  );
}

async function waitForEmbeddingToSettle(userId: string): Promise<void> {
  await vi.waitFor(async () => {
    const status = await getSyncStatus(userId);
    expect(status.status).toBe('idle');
  }, { timeout: 10_000 });
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'sync-service webhook delivery — real PostgreSQL, Redis, and HTTP',
  () => {
    beforeAll(async () => {
      originalAttachmentRoot = process.env.ATTACHMENTS_DIR;
      originalPatEncryptionKey = process.env.PAT_ENCRYPTION_KEY;
      process.env.PAT_ENCRYPTION_KEY = 'sync-webhook-test-key-at-least-32-bytes';
      attachmentRoot = await mkdtemp(join(tmpdir(), 'sync-webhook-'));
      process.env.ATTACHMENTS_DIR = attachmentRoot;

      await setupTestDb();
      await listen(fixture);
      const address = fixture.address();
      if (!address || typeof address === 'string') {
        throw new Error('Webhook/Confluence fixture did not bind TCP');
      }
      fixtureBaseUrl = `http://127.0.0.1:${address.port}`;

      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      redis.on('error', () => undefined);
      await redis.connect();
      setRedisClient(redis);
    }, 30_000);

    beforeEach(async () => {
      await Promise.allSettled(pendingDeliveries);
      pendingDeliveries.length = 0;
      _resetWebhookEmitHookForTests();
      spaces.clear();
      rejectPageFetch.clear();
      requestedPaths.length = 0;
      receivedWebhooks.length = 0;
      await truncateAllTables();
      await redis.flushDb();
      setWebhookEmitHook(deliverThroughHttp);
    });

    afterAll(async () => {
      await Promise.allSettled(pendingDeliveries);
      _resetWebhookEmitHookForTests();
      setRedisClient(null);
      if (redis.isOpen) await redis.quit();
      await close(fixture);
      await teardownTestDb();
      await rm(attachmentRoot, { recursive: true, force: true });

      if (originalAttachmentRoot === undefined) delete process.env.ATTACHMENTS_DIR;
      else process.env.ATTACHMENTS_DIR = originalAttachmentRoot;
      if (originalPatEncryptionKey === undefined) delete process.env.PAT_ENCRYPTION_KEY;
      else process.env.PAT_ENCRYPTION_KEY = originalPatEncryptionKey;
    });

    it('delivers one aggregate completion per accessible space from the rows actually created, updated, and deleted', async () => {
      addSpace('ALPHA', 'Alpha', [
        page('alpha-new', 'Alpha new'),
        page('alpha-updated', 'Alpha updated', 2),
      ]);
      addSpace('BETA', 'Beta', [page('beta-new', 'Beta new')]);
      addSpace('HIDDEN', 'Hidden', [page('hidden-new', 'Hidden new')]);
      const userId = await seedUser(['ALPHA', 'BETA']);
      await seedExistingPage(userId, 'ALPHA', 'alpha-updated', 'Alpha old');
      await seedExistingPage(userId, 'ALPHA', 'alpha-gone', 'Alpha gone');

      await syncUser(userId);

      await vi.waitFor(() => expect(receivedWebhooks).toHaveLength(2));
      await Promise.allSettled(pendingDeliveries);
      await waitForEmbeddingToSettle(userId);

      const completions = [...receivedWebhooks].sort(
        (left, right) => left.data.spaceKey.localeCompare(right.data.spaceKey),
      );
      expect(completions.map((event) => ({ type: event.type, ...event.data }))).toEqual([
        expect.objectContaining({
          type: 'sync.completed',
          spaceKey: 'ALPHA',
          pagesCreated: 1,
          pagesUpdated: 1,
          pagesDeleted: 1,
        }),
        expect.objectContaining({
          type: 'sync.completed',
          spaceKey: 'BETA',
          pagesCreated: 1,
          pagesUpdated: 0,
          pagesDeleted: 0,
        }),
      ]);
      for (const completion of completions) {
        expect(completion.data.durationMs).toBeGreaterThanOrEqual(0);
        expect(Number.isNaN(Date.parse(completion.data.completedAt))).toBe(false);
      }

      const persisted = await query<PersistedPage>(
        `SELECT confluence_id, source, space_key, title, version, deleted_at
           FROM pages
          ORDER BY confluence_id`,
      );
      expect(persisted.rows.map((row) => ({
        confluenceId: row.confluence_id,
        source: row.source,
        spaceKey: row.space_key,
        title: row.title,
        version: row.version,
        deleted: row.deleted_at !== null,
      }))).toEqual([
        {
          confluenceId: 'alpha-gone', source: 'confluence', spaceKey: 'ALPHA',
          title: 'Alpha gone', version: 1, deleted: true,
        },
        {
          confluenceId: 'alpha-new', source: 'confluence', spaceKey: 'ALPHA',
          title: 'Alpha new', version: 1, deleted: false,
        },
        {
          confluenceId: 'alpha-updated', source: 'confluence', spaceKey: 'ALPHA',
          title: 'Alpha updated', version: 2, deleted: false,
        },
        {
          confluenceId: 'beta-new', source: 'confluence', spaceKey: 'BETA',
          title: 'Beta new', version: 1, deleted: false,
        },
      ]);
      expect(receivedWebhooks.every((event) => event.type === 'sync.completed')).toBe(true);
    });

    it('does not tell the receiver a space completed when a fatal page fetch follows a real insert', async () => {
      addSpace('FAIL', 'Failure boundary', [
        page('partially-created', 'Partially created'),
        page('fatal-page', 'Fatal page'),
      ]);
      rejectPageFetch.add('fatal-page');
      const userId = await seedUser(['FAIL']);

      await expect(syncUser(userId)).rejects.toThrow('Invalid or expired PAT');
      await Promise.allSettled(pendingDeliveries);

      const inserted = await query<{ confluence_id: string }>(
        `SELECT confluence_id FROM pages WHERE confluence_id = 'partially-created'`,
      );
      const syncStamp = await query<{ last_synced: Date | null }>(
        `SELECT last_synced FROM spaces WHERE space_key = 'FAIL'`,
      );
      expect(inserted.rows).toEqual([{ confluence_id: 'partially-created' }]);
      expect(syncStamp.rows[0]!.last_synced).toBeNull();
      expect(receivedWebhooks).toEqual([]);
    });

    it('does not contact Confluence or deliver a completion when real RBAC grants no spaces', async () => {
      addSpace('UNASSIGNED', 'Unassigned', [page('never-read', 'Never read')]);
      const userId = await seedUser([]);

      await syncUser(userId);
      await Promise.allSettled(pendingDeliveries);

      const upstreamRequests = requestedPaths.filter((path) => path.includes('/rest/api/'));
      const persisted = await query<{ confluence_id: string }>(
        `SELECT confluence_id FROM pages WHERE confluence_id = 'never-read'`,
      );
      expect(upstreamRequests).toEqual([]);
      expect(persisted.rows).toEqual([]);
      expect(receivedWebhooks).toEqual([]);
    });
  },
);
