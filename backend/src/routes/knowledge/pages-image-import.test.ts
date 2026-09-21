import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  addAllowedBaseUrlSilent,
  clearAllowedBaseUrls,
} from '../../core/utils/ssrf-guard.js';
import {
  buildKnowledgeTestApp,
  insertConfluencePage,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from './pages.test-helpers.js';

const PUBLIC_ORIGIN = 'https://cdn.example.com';

// Tiny valid PNG (signature plus a minimal IHDR) used as the upstream body.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0xfa, 0xcf, 0x00, 0x00,
  0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

function publicUrl(path: string): string {
  return `${PUBLIC_ORIGIN}${path}`;
}

function upstreamResponse(
  options: {
    status?: number;
    contentType?: string;
    contentLength?: number;
    body?: Buffer;
  } = {},
): Response {
  const body = options.body ?? TINY_PNG;
  const headers = new Headers();
  headers.set('content-type', options.contentType ?? 'image/png');
  headers.set('content-length', String(options.contentLength ?? body.length));
  return new Response(body, {
    status: options.status ?? 200,
    headers,
  });
}

const [dbAvailable, redisAvailable] = await Promise.all([
  isDbAvailable(),
  isRedisAvailable(),
]);
const dependenciesAvailable = dbAvailable && redisAvailable;
let app: FastifyInstance;
let redis: RedisClientType;
let userId: string;
let ownedPageId: number;
let attachmentsDir: string;
let originalAttachmentsDir: string | undefined;
let originalFetch: typeof globalThis.fetch;
let fetchMock = vi.fn<typeof globalThis.fetch>();

async function expectAttachmentAbsent(pageKey: string, filename: string): Promise<void> {
  await expect(access(join(attachmentsDir, pageKey, filename))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}

async function expectPageDirectoryAbsent(pageKey: string): Promise<void> {
  await expect(access(join(attachmentsDir, pageKey))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}

async function expectStoredBytes(pageKey: string, filename: string): Promise<void> {
  await expect(readFile(join(attachmentsDir, pageKey, filename))).resolves.toEqual(TINY_PNG);
}

async function expectPageStillWritable(): Promise<void> {
  const nextWrite = await app.inject({
    method: 'POST',
    url: `/api/pages/${ownedPageId}/images`,
    payload: {
      filename: 'next-write.png',
      dataUri: `data:image/png;base64,${TINY_PNG.toString('base64')}`,
    },
  });
  expect(nextWrite.statusCode).toBe(200);
  await expectStoredBytes(String(ownedPageId), 'next-write.png');
}

async function grantSpaceAccess(spaceKey: string, actorId: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('image-import-reader', 'Image import reader', FALSE, ARRAY['read'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments
       (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, actorId, role.rows[0]!.id],
  );
}

describe.skipIf(!dependenciesAvailable)('POST /api/pages/:id/images/import — real persistence', () => {
  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
    originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await mkdtemp(join(tmpdir(), 'page-image-import-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
    originalFetch = globalThis.fetch;
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      instance.redis = redis;
      // The attachment handler captures ATTACHMENTS_DIR at module load.
      const { pagesCrudRoutes } = await import('./pages-crud.js');
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await teardownTestDb();
    globalThis.fetch = originalFetch;
    if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    clearAllowedBaseUrls();
    await rm(attachmentsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAllTables();
    await rm(attachmentsDir, { recursive: true, force: true });
    userId = await insertUser(`image-import-${randomUUID()}`);
    await insertLocalSpace('LOCAL', userId);
    ownedPageId = await insertStandalonePage('Owned image page', 'private', userId, 'LOCAL');
    clearAllowedBaseUrls();
    addAllowedBaseUrlSilent(PUBLIC_ORIGIN);
    fetchMock = vi.fn<typeof globalThis.fetch>();
    globalThis.fetch = fetchMock;
  });

  it('imports a valid PNG, returns its attachment URL, and stores the upstream bytes', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse());

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/hero.png') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: `/api/attachments/${ownedPageId}/hero.png` });
    await expectStoredBytes(String(ownedPageId), 'hero.png');
  });

  it('rejects a loopback source through the real SSRF guard without fetching or writing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: 'http://127.0.0.1/admin' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/not reachable or not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
    await expectPageDirectoryAbsent(String(ownedPageId));
  });

  it('rejects non-image content types with 415 without blocking later writes', async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse({ contentType: 'text/html', body: Buffer.from('<html>nope</html>') }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/index.html') },
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().message).toMatch(/must be an image/i);
    await expectAttachmentAbsent(String(ownedPageId), 'index.html');
    await expectPageStillWritable();
  });

  it('rejects unsupported image MIME types such as SVG with 415', async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse({ contentType: 'image/svg+xml', body: Buffer.from('<svg/>') }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/diagram.svg') },
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().message).toMatch(/not supported.*svg/i);
    await expectAttachmentAbsent(String(ownedPageId), 'diagram.svg');
    await expectPageStillWritable();
  });

  it('rejects oversized responses up front from Content-Length', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse({ contentLength: 50 * 1024 * 1024 }));

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/huge.png') },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().message).toMatch(/exceeds maximum size/i);
    await expectAttachmentAbsent(String(ownedPageId), 'huge.png');
    await expectPageStillWritable();
  });

  it('returns 502 for a non-success upstream response without storing it', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse({ status: 404, body: Buffer.alloc(0) }));

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/missing.png') },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().message).toMatch(/HTTP 404/);
    await expectAttachmentAbsent(String(ownedPageId), 'missing.png');
    await expectPageStillWritable();
  });

  it('returns 502 when the upstream response body fails while streaming', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error('upstream socket reset'));
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '100' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/interrupted.png') },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().message).toMatch(/failed to read source image body/i);
    await expectAttachmentAbsent(String(ownedPageId), 'interrupted.png');
    await expectPageStillWritable();
  });

  it('returns 502 for an empty upstream body without storing it', async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse({ body: Buffer.alloc(0), contentLength: 0 }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/empty.png') },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().message).toMatch(/empty body/i);
    await expectAttachmentAbsent(String(ownedPageId), 'empty.png');
    await expectPageStillWritable();
  });

  it('returns 502 when the upstream fetch fails and leaves no pending writer', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/down.png') },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().message).toMatch(/failed to fetch/i);
    await expectAttachmentAbsent(String(ownedPageId), 'down.png');
    await expectPageStillWritable();
  });

  it('returns 404 when the page does not exist', async () => {
    const missingId = 2_147_483_647;
    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${missingId}/images/import`,
      payload: { url: publicUrl('/x.png') },
    });

    expect(response.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    await expectPageDirectoryAbsent(String(missingId));
  });

  it('returns 403 when the user does not own a private standalone page', async () => {
    const ownerId = await insertUser(`image-owner-${randomUUID()}`);
    await insertLocalSpace('OTHER-PRIVATE', ownerId);
    const pageId = await insertStandalonePage('Private page', 'private', ownerId, 'OTHER-PRIVATE');

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images/import`,
      payload: { url: publicUrl('/x.png') },
    });

    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    await expectPageDirectoryAbsent(String(pageId));
  });

  it('imports onto a shared standalone page the user did not create', async () => {
    const ownerId = await insertUser(`image-owner-${randomUUID()}`);
    await insertLocalSpace('OTHER-SHARED', ownerId);
    const pageId = await insertStandalonePage('Shared page', 'shared', ownerId, 'OTHER-SHARED');
    fetchMock.mockResolvedValueOnce(upstreamResponse());

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images/import`,
      payload: { url: publicUrl('/shared.png') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: `/api/attachments/${pageId}/shared.png` });
    await expectStoredBytes(String(pageId), 'shared.png');
  });

  it('lets a system admin import onto a private standalone page they did not create', async () => {
    const ownerId = await insertUser(`image-owner-${randomUUID()}`);
    await insertLocalSpace('OTHER-ADMIN', ownerId);
    const pageId = await insertStandalonePage('Private admin page', 'private', ownerId, 'OTHER-ADMIN');
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
    fetchMock.mockResolvedValueOnce(upstreamResponse());

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/images/import`,
      payload: { url: publicUrl('/admin.png') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: `/api/attachments/${pageId}/admin.png` });
    await expectStoredBytes(String(pageId), 'admin.png');
  });

  it('rejects malformed URLs before fetching or creating writer state', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: 'not-a-real-url' },
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await expectPageDirectoryAbsent(String(ownedPageId));
    const intents = await query('SELECT id FROM page_write_intents WHERE actor_id = $1', [userId]);
    expect(intents.rows).toEqual([]);
  });

  it('generates a safe filename when the URL has no usable basename', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse());

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/') },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ url: string }>();
    expect(body.url).toMatch(new RegExp(`^/api/attachments/${ownedPageId}/imported-\\d+-[0-9a-f]+\\.png$`));
    const filename = decodeURIComponent(body.url.split('/').at(-1)!);
    await expectStoredBytes(String(ownedPageId), filename);
  });

  it('sanitizes the URL basename before writing the imported file', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse());

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/folder/hero_(final)!.png') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      url: `/api/attachments/${ownedPageId}/hero_final.png`,
    });
    await expectStoredBytes(String(ownedPageId), 'hero_final.png');
    await expectAttachmentAbsent(String(ownedPageId), 'hero_(final)!.png');
  });

  it('denies a redirect to a private address before fetching the forbidden destination', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://192.168.1.1/admin' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/redir.png') },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/redirects to a disallowed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(publicUrl('/redir.png'), expect.anything());
    await expectAttachmentAbsent(String(ownedPageId), 'redir.png');
    await expectPageStillWritable();
  });

  it('follows a safe public redirect chain and stores the final response bytes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: publicUrl('/final/hero.png') },
        }),
      )
      .mockResolvedValueOnce(upstreamResponse());

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/short') },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(publicUrl('/final/hero.png'));
    const body = response.json<{ url: string }>();
    expect(body.url).toMatch(new RegExp(`^/api/attachments/${ownedPageId}/imported-\\d+-[0-9a-f]+\\.png$`));
    const filename = decodeURIComponent(body.url.split('/').at(-1)!);
    await expectStoredBytes(String(ownedPageId), filename);
  });

  it('aborts when a lying Content-Length body exceeds the size cap mid-stream', async () => {
    const chunkBytes = 1024 * 1024;
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 15; i += 1) {
          controller.enqueue(new Uint8Array(chunkBytes));
        }
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '100' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/lying.png') },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().message).toMatch(/exceeds maximum size/i);
    await expectAttachmentAbsent(String(ownedPageId), 'lying.png');
    await expectPageStillWritable();
  });

  it('rejects bytes whose magic does not match the declared image type', async () => {
    fetchMock.mockResolvedValueOnce(
      upstreamResponse({
        contentType: 'image/png',
        body: Buffer.from('<!doctype html><script>alert(1)</script>'),
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${ownedPageId}/images/import`,
      payload: { url: publicUrl('/fake.png') },
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().message).toMatch(/does not match declared/i);
    await expectAttachmentAbsent(String(ownedPageId), 'fake.png');
    await expectPageStillWritable();
  });

  it('imports onto a Confluence page through a real current space assignment', async () => {
    await insertLocalSpace('DEV', userId);
    await grantSpaceAccess('DEV', userId);
    await insertConfluencePage('CONFL-100', 'Accessible Confluence page', 'DEV');
    fetchMock.mockResolvedValueOnce(upstreamResponse());

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/CONFL-100/images/import',
      payload: { url: publicUrl('/space-shot.png') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      url: '/api/attachments/CONFL-100/space-shot.png',
    });
    await expectStoredBytes('CONFL-100', 'space-shot.png');
  });

  it('denies a Confluence page when the user has no current page or space access', async () => {
    await insertLocalSpace('SECRET', userId);
    await insertConfluencePage('CONFL-200', 'Denied Confluence page', 'SECRET');

    const response = await app.inject({
      method: 'POST',
      url: '/api/pages/CONFL-200/images/import',
      payload: { url: publicUrl('/x.png') },
    });

    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    await expectPageDirectoryAbsent('CONFL-200');
  });
});
