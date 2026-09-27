import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { encryptPat } from '../../core/utils/crypto.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { insertUser } from './pages.test-helpers.js';
import { pagesCrudRoutes } from './pages-crud.js';

interface CreateResponse {
  id: number | string;
  source: 'standalone' | 'confluence';
}

interface ErrorResponse {
  error: string;
}

interface PersistedPage {
  confluence_id: string | null;
  source: string;
  space_key: string | null;
  title: string;
}

interface UpstreamRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

const ConfluenceCreatePayloadSchema = z.object({
  title: z.string(),
  body: z.object({ storage: z.object({ value: z.string() }) }),
});

const available = (await isDbAvailable()) && (await isRedisAvailable());
const upstreamRequests: UpstreamRequest[] = [];

let app: FastifyInstance;
let redis: RedisClientType;
let upstream: Server;
let upstreamBaseUrl = '';
let currentUserId = '';

async function readJson(request: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) raw += chunk.toString();
  return raw.length === 0 ? null : JSON.parse(raw);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function handleUpstream(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const payload = await readJson(request);
    upstreamRequests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      authorization: request.headers.authorization,
      body: payload,
    });
    if (request.method !== 'POST' || request.url !== '/rest/api/content') {
      sendJson(response, 404, { message: 'Unexpected Confluence fixture request' });
      return;
    }
    const create = ConfluenceCreatePayloadSchema.parse(payload);
    sendJson(response, 200, {
      id: 'rbac-created-page',
      title: create.title,
      status: 'current',
      type: 'page',
      version: { number: 1, when: '2026-09-20T00:00:00.000Z' },
      body: { storage: { value: create.body.storage.value } },
    });
  } catch (error) {
    sendJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
  }
}

async function startUpstream(): Promise<void> {
  upstream = createServer((request, response) => {
    void handleUpstream(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    upstream.once('error', onError);
    upstream.listen(0, '127.0.0.1', () => {
      upstream.off('error', onError);
      resolve();
    });
  });
  const address = upstream.address();
  if (address === null || typeof address === 'string') throw new Error('Confluence fixture did not bind a TCP port');
  upstreamBaseUrl = `http://127.0.0.1:${address.port}`;
}

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  instance.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.status(400).send({ error: 'Validation failed' });
    return reply.status(error.statusCode ?? 500).send({ error: error.message });
  });
  instance.decorate('authenticate', async (request) => {
    request.userId = currentUserId;
    request.username = 'rbac-create-user';
    request.userRole = 'user';
  });
  instance.decorate('requireAdmin', async (request) => {
    request.userId = currentUserId;
    request.username = 'rbac-create-user';
    request.userRole = 'admin';
  });
  instance.decorate('redis', redis);
  await instance.register(pagesCrudRoutes, { prefix: '/api' });
  await instance.ready();
  return instance;
}

async function insertSpace(spaceKey: string, source: 'confluence' | 'local'): Promise<void> {
  await query(
    `INSERT INTO spaces (space_key, space_name, source, last_synced)
     VALUES ($1, $1, $2, NOW())`,
    [spaceKey, source],
  );
}

async function configureConfluence(): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, $2, $3, TRUE)`,
    [currentUserId, upstreamBaseUrl, encryptPat('rbac-fixture-confluence-pat')],
  );
}

async function grantSpace(spaceKey: string): Promise<void> {
  const roleResult = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('rbac_create_writer', 'RBAC create writer', FALSE, ARRAY['read', 'write'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  const role = roleResult.rows[0];
  if (!role) throw new Error('RBAC role fixture was not created');
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, currentUserId, role.id],
  );
}

async function persistedPages(): Promise<PersistedPage[]> {
  const result = await query<PersistedPage>(
    'SELECT confluence_id, source, space_key, title FROM pages ORDER BY id',
  );
  return result.rows;
}

describe.skipIf(!available)('POST /api/pages Confluence RBAC admission with real grants', () => {
  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);
    await startUpstream();
    app = await buildApp();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await truncateAllTables();
    await redis.flushDb();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
      upstream.closeAllConnections();
    });
    setRedisClient(null);
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    upstreamRequests.length = 0;
    currentUserId = await insertUser('rbac_create_user');
    await insertSpace('DEV', 'confluence');
    await insertSpace('HR', 'confluence');
    await configureConfluence();
  });

  it('returns 403 before transport or persistence when the user has no grant for the target space', async () => {
    await grantSpace('DEV');
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Forbidden HR page', bodyHtml: '<p>x</p>', source: 'confluence', spaceKey: 'HR' },
    });
    const error = response.json<ErrorResponse>();
    const pages = await persistedPages();

    expect(response.statusCode).toBe(403);
    expect(error.error).toBe('Access denied to this space');
    expect(upstreamRequests).toEqual([]);
    expect(pages).toEqual([]);
  });

  it('creates upstream and persists locally when an actual space grant admits the request', async () => {
    await grantSpace('HR');
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Permitted HR page', bodyHtml: '<p>allowed</p>', source: 'confluence', spaceKey: 'HR' },
    });
    const body = response.json<CreateResponse>();
    const pages = await persistedPages();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ id: 'rbac-created-page', source: 'confluence' });
    expect(upstreamRequests).toHaveLength(1);
    const request = upstreamRequests[0];
    if (!request) throw new Error('Expected one Confluence create request');
    expect(request).toMatchObject({
      method: 'POST',
      url: '/rest/api/content',
      authorization: 'Bearer rbac-fixture-confluence-pat',
      body: {
        title: 'Permitted HR page',
        space: { key: 'HR' },
        body: { storage: { value: '<p>allowed</p>', representation: 'storage' } },
      },
    });
    expect(pages).toEqual([
      {
        confluence_id: 'rbac-created-page',
        source: 'confluence',
        space_key: 'HR',
        title: 'Permitted HR page',
      },
    ]);
  });

  it('creates standalone content without any space grant or external request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/pages',
      payload: { title: 'Standalone note', bodyHtml: '<p>local</p>', source: 'standalone' },
    });
    const body = response.json<CreateResponse>();
    const pages = await persistedPages();

    expect(response.statusCode).toBe(200);
    expect(body.source).toBe('standalone');
    expect(upstreamRequests).toEqual([]);
    expect(pages).toEqual([
      {
        confluence_id: null,
        source: 'standalone',
        space_key: null,
        title: 'Standalone note',
      },
    ]);
  });
});
