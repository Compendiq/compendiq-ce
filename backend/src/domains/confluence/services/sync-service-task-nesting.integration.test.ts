/**
 * #1957 — a page whose task lists nest deeper than MAX_TASK_LIST_NESTING is
 * converted exactly as before #1957 (coordinator decision D13): sync stores it
 * through the ordinary path, with its labels, like every other page, and the
 * attachment repair of an incremental run goes over it without a special case.
 *
 * Real PostgreSQL and Redis; the real `ConfluenceClient` against an
 * in-process HTTP fixture, the only stand-in for Confluence.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createClient, type RedisClientType } from 'redis';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { query } from '../../../core/db/postgres.js';
import { MAX_TASK_LIST_NESTING } from '../../../core/services/content-converter.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { logger } from '../../../core/utils/logger.js';
import { ConfluenceClient, type ConfluencePage } from './confluence-client.js';
import { __internal } from './sync-service.js';

// `vi.hoisted` runs before the static imports, so its built-ins load here: the
// attachment root must be set before the production import graph reads it.
const { attachmentsRoot, originalAttachmentsRoot } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const attachmentsRoot = join(tmpdir(), `sync-task-nesting-${globalThis.crypto.randomUUID()}`);
  const originalAttachmentsRoot = process.env.ATTACHMENTS_DIR;
  process.env.ATTACHMENTS_DIR = attachmentsRoot;
  return { attachmentsRoot, originalAttachmentsRoot };
});

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
const SPACE_KEY = 'NEST';
const PAGE_FAILED = 'Page sync failed — skipping page and continuing sync';
/** sha256 of what bff6d4ec's confluenceToHtml wrote for nestedTasks(33), captured at that commit. */
const BASE_FORWARD_33 = '52ef2667b202d2649ad40b51d95cfa7e30ef7ec0734406651e7fdf94622da12a';

const upstreamPages = new Map<string, ConfluencePage>();
let baseUrl = '';
let client: ConfluenceClient;
let redis: RedisClientType;
let userId = '';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `depth` tasks, each nested in the previous one's body (even levels complete). */
function nestedTasks(depth: number): string {
  let storage = '';
  for (let level = depth; level >= 1; level -= 1) {
    storage = `<ac:task-list><ac:task><ac:task-id>${level}</ac:task-id>`
      + `<ac:task-status>${level % 2 === 0 ? 'complete' : 'incomplete'}</ac:task-status>`
      + `<ac:task-body>t${level}${storage}</ac:task-body></ac:task></ac:task-list>`;
  }
  return storage;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function listing(results: unknown[]): Record<string, unknown> {
  return { results, start: 0, limit: 200, size: results.length, _links: {} };
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://fixture.test');
  if (url.pathname === '/rest/api/space') {
    json(response, 200, listing([{ key: SPACE_KEY, name: 'Nesting', type: 'global', status: 'current' }]));
    return;
  }
  if (url.pathname === '/rest/api/content') {
    const pages = [...upstreamPages.values()];
    json(response, 200, listing(url.searchParams.has('expand') ? pages : pages.map(({ id }) => ({ id }))));
    return;
  }
  if (url.pathname === '/rest/api/content/search') {
    json(response, 200, listing([]));
    return;
  }
  if (/^\/rest\/api\/content\/[^/]+\/child\/attachment$/.test(url.pathname)) {
    json(response, 200, listing([]));
    return;
  }
  const pageMatch = url.pathname.match(/^\/rest\/api\/content\/([^/]+)$/);
  if (pageMatch) {
    const page = upstreamPages.get(decodeURIComponent(pageMatch[1]!));
    if (page) json(response, 200, page);
    else json(response, 404, { message: 'Not found upstream' });
    return;
  }
  json(response, 404, { message: `Unhandled fixture path ${url.pathname}` });
}

const upstream = createServer(handleRequest);

function remotePage(id: string, version: number, storage: string, labels: string[] = []): ConfluencePage {
  return {
    id,
    title: `Page ${id}`,
    status: 'current',
    type: 'page',
    version: { number: version, when: '2026-11-20T10:00:00.000Z', by: { displayName: 'Fixture Author' } },
    body: { storage: { value: storage } },
    ancestors: [],
    metadata: { labels: { results: labels.map((name) => ({ name })) } },
  };
}

/** A Confluence page row as an earlier sync stored it. */
async function seedPage(confluenceId: string, storage: string, bodyHtml: string): Promise<void> {
  await query(
    `INSERT INTO pages
       (source, confluence_id, space_key, title, body_storage, body_html, body_text, version, visibility, inherit_perms, last_synced)
     VALUES ('confluence', $1, $2, $3, $4, $5, 'stored', 1, 'shared', TRUE, NOW())`,
    [confluenceId, SPACE_KEY, `Page ${confluenceId}`, storage, bodyHtml],
  );
}

async function row(confluenceId: string): Promise<
  { version: number; body_html: string; body_storage: string; labels: string[] } | undefined
> {
  const result = await query<{ version: number; body_html: string; body_storage: string; labels: string[] }>(
    'SELECT version, body_html, body_storage, labels FROM pages WHERE confluence_id = $1 AND deleted_at IS NULL',
    [confluenceId],
  );
  return result.rows[0];
}

async function lastSynced(): Promise<Date | null> {
  const result = await query<{ last_synced: Date | null }>('SELECT last_synced FROM spaces WHERE space_key = $1', [SPACE_KEY]);
  return result.rows[0]?.last_synced ?? null;
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  '#1957 sync refuses a page whose task lists nest too deep — real PostgreSQL, Redis and HTTP',
  () => {
    beforeAll(async () => {
      await setupTestDb();
      const listening = Promise.withResolvers<void>();
      upstream.listen(0, '127.0.0.1', listening.resolve);
      await listening.promise;
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('Confluence fixture did not bind TCP');
      baseUrl = `http://127.0.0.1:${address.port}`;
      client = new ConfluenceClient(baseUrl, 'fixture-pat');
      redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1_000 } });
      await redis.connect();
      setRedisClient(redis);
    }, 30_000);

    beforeEach(async () => {
      await truncateAllTables();
      await redis.flushDb();
      await rm(attachmentsRoot, { recursive: true, force: true });
      await mkdir(attachmentsRoot, { recursive: true });
      upstreamPages.clear();
      const suffix = randomUUID();
      const user = await query<{ id: string }>(
        `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id`,
        [`nest-${suffix}`, `nest-${suffix}@test.invalid`],
      );
      userId = user.rows[0]!.id;
      await query(
        `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled) VALUES ($1, $2, $3, TRUE)`,
        [userId, baseUrl, encryptPat('fixture-pat')],
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      setRedisClient(null);
      if (redis?.isOpen) await redis.quit();
      const closed = Promise.withResolvers<void>();
      upstream.close(() => closed.resolve());
      upstream.closeAllConnections();
      await closed.promise;
      await teardownTestDb();
      await rm(attachmentsRoot, { recursive: true, force: true });
      if (originalAttachmentsRoot === undefined) delete process.env.ATTACHMENTS_DIR;
      else process.env.ATTACHMENTS_DIR = originalAttachmentsRoot;
    });

    it('syncs a page nested one level past the limit exactly as before #1957, with its labels, and the rest of the space', async () => {
      await query(`INSERT INTO spaces (space_key, space_name) VALUES ($1, 'Nesting')`, [SPACE_KEY]);
      await seedPage('nest-deep', nestedTasks(2), '<p>stored before</p>');
      upstreamPages.set('nest-deep', remotePage('nest-deep', 2, nestedTasks(MAX_TASK_LIST_NESTING + 1), ['nesting-check']));
      upstreamPages.set('nest-new-deep', remotePage('nest-new-deep', 1, nestedTasks(MAX_TASK_LIST_NESTING + 1)));
      upstreamPages.set('nest-limit', remotePage('nest-limit', 1, nestedTasks(MAX_TASK_LIST_NESTING)));
      const warn = vi.spyOn(logger, 'warn');

      await __internal.syncSpace(client, userId, SPACE_KEY, undefined, new Date(), new Map(), randomUUID());

      expect(warn.mock.calls.filter(([, message]) => message === PAGE_FAILED)).toEqual([]);
      const deep = await row('nest-deep');
      expect(deep?.version).toBe(2);
      expect(deep?.body_storage).toBe(nestedTasks(MAX_TASK_LIST_NESTING + 1));
      expect(sha256(deep!.body_html)).toBe(BASE_FORWARD_33);
      expect(deep?.labels).toEqual(['nesting-check']);
      expect(sha256((await row('nest-new-deep'))!.body_html)).toBe(BASE_FORWARD_33);
      expect((await row('nest-limit'))?.body_html.match(/data-type="taskItem"/g)).toHaveLength(MAX_TASK_LIST_NESTING);
      expect(await lastSynced()).not.toBeNull();
    });

    it('finishes the attachment repair of an incremental run over a stored row nested past the limit', async () => {
      const before = new Date(Date.now() - 60 * 60 * 1000);
      await query(`INSERT INTO spaces (space_key, space_name, last_synced) VALUES ($1, 'Nesting', $2)`, [SPACE_KEY, before]);
      const storage = `<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">arch</ac:parameter></ac:structured-macro>${nestedTasks(MAX_TASK_LIST_NESTING + 1)}`;
      await seedPage('nest-legacy', storage, '<p>stored before #1957</p>');
      upstreamPages.set('nest-legacy', remotePage('nest-legacy', 1, storage));
      const warn = vi.spyOn(logger, 'warn');

      await __internal.syncSpace(client, userId, SPACE_KEY, undefined, new Date(), new Map(), randomUUID());

      expect(warn.mock.calls.filter(([, message]) => message === PAGE_FAILED)).toEqual([]);
      expect((await lastSynced())!.getTime()).toBeGreaterThan(before.getTime());
    });
  },
);
