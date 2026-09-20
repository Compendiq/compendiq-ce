import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { attachmentCacheDir } from '../../../core/services/attachment-store.js';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { ConfluenceClient, type ConfluencePage } from './confluence-client.js';
import { __internal, getSyncStatus, syncUser } from './sync-service.js';

// The ordinary Confluence cache captures its root at module initialization.
// Set the fixture root before the production import graph is evaluated.
// Vitest runs this before static imports, so its built-ins must load here.
const { attachmentsRoot, originalAttachmentsRoot } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const attachmentsRoot = join(tmpdir(), `sync-embedding-${globalThis.crypto.randomUUID()}`);
  const originalAttachmentsRoot = process.env.ATTACHMENTS_DIR;
  process.env.ATTACHMENTS_DIR = attachmentsRoot;
  return { attachmentsRoot, originalAttachmentsRoot };
});

const canRun = await isDbAvailable();
const SPACE_KEY = 'DEV';
const EMBEDDING_MODEL = 'fixture-embedding-model';
const requestedPaths: string[] = [];
const embeddingModels: string[] = [];
const embeddingInputs: string[][] = [];
const upstreamPages = new Map<string, ConfluencePage>();
const upstreamAttachments = new Map<string, Map<string, Buffer>>();
let modifiedPages: ConfluencePage[] = [];
let embeddingWait: Promise<void> | null = null;
let releaseEmbeddingWait: (() => void) | null = null;
let embeddingFailureStatus: number | null = null;
let baseUrl: string;
let client: ConfluenceClient;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function pageResponse(results: unknown[]): Record<string, unknown> {
  return { results, start: 0, limit: 200, size: results.length, _links: {} };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://fixture.test');
  requestedPaths.push(url.pathname);

  if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
    const body = JSON.parse(await requestBody(request)) as { model: string; input: string[] };
    embeddingModels.push(body.model);
    embeddingInputs.push(body.input);
    if (embeddingFailureStatus !== null) {
      json(response, embeddingFailureStatus, { error: { message: 'fixture provider unavailable' } });
      return;
    }
    const gate = embeddingWait;
    if (gate) await gate;
    json(response, 200, {
      data: body.input.map((text, inputIndex) => ({
        embedding: Array.from(
          { length: 1024 },
          (_, dimension) => ((text.length + inputIndex + dimension) % 31) / 100,
        ),
      })),
    });
    return;
  }

  if (url.pathname === '/rest/api/space') {
    json(response, 200, pageResponse([
      { key: SPACE_KEY, name: 'Development', type: 'global', status: 'current' },
    ]));
    return;
  }

  if (url.pathname === '/rest/api/content/search') {
    json(response, 200, pageResponse(modifiedPages));
    return;
  }

  if (url.pathname === '/rest/api/content') {
    const pages = [...upstreamPages.values()];
    if (url.searchParams.has('expand')) json(response, 200, pageResponse(pages));
    else json(response, 200, pageResponse(pages.map(({ id }) => ({ id }))));
    return;
  }

  const attachmentList = url.pathname.match(/^\/rest\/api\/content\/([^/]+)\/child\/attachment$/);
  if (attachmentList) {
    const pageId = decodeURIComponent(attachmentList[1]!);
    const files = upstreamAttachments.get(pageId) ?? new Map<string, Buffer>();
    json(response, 200, pageResponse([...files].map(([filename, bytes], index) => ({
      id: `attachment-${index + 1}`,
      title: filename,
      mediaType: 'image/png',
      metadata: { mediaType: 'image/png' },
      extensions: { mediaType: 'image/png', fileSize: bytes.length },
      _links: { download: `/download/${encodeURIComponent(pageId)}/${encodeURIComponent(filename)}` },
      version: { number: 1, when: '2026-09-01T00:00:00.000Z' },
    }))));
    return;
  }

  const download = url.pathname.match(/^\/download\/([^/]+)\/([^/]+)$/);
  if (download) {
    const pageId = decodeURIComponent(download[1]!);
    const filename = decodeURIComponent(download[2]!);
    const bytes = upstreamAttachments.get(pageId)?.get(filename);
    if (!bytes) {
      json(response, 404, { message: 'Missing fixture attachment' });
      return;
    }
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length });
    response.end(bytes);
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

const upstream = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
  });
});

function remotePage(id: string, version: number, bodyStorage: string, title = `Page ${id}`): ConfluencePage {
  return {
    id,
    title,
    status: 'current',
    type: 'page',
    version: {
      number: version,
      when: '2026-09-01T00:00:00.000Z',
      by: { displayName: 'Fixture Author' },
    },
    body: { storage: { value: bodyStorage } },
    ancestors: [],
    metadata: { labels: { results: [{ name: 'fixture' }] } },
  };
}

async function seedActor(): Promise<string> {
  const user = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('sync-embedding-actor', 'unused', 'admin')
     RETURNING id`,
  );
  const userId = user.rows[0]!.id;
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, $2, $3, TRUE)`,
    [userId, baseUrl, encryptPat('fixture-pat')],
  );
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ($1, 'Development')`,
    [SPACE_KEY],
  );
  return userId;
}

async function seedEmbeddingProvider(): Promise<void> {
  const provider = await query<{ id: string }>(
    `INSERT INTO llm_providers
       (name, base_url, auth_type, verify_ssl, is_default, default_model)
     VALUES ('sync-embedding-fixture', $1, 'none', TRUE, TRUE, $2)
     RETURNING id`,
    [`${baseUrl}/v1`, EMBEDDING_MODEL],
  );
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
     VALUES ('embedding', $1, $2)
     ON CONFLICT (usecase) DO UPDATE
       SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`,
    [provider.rows[0]!.id, EMBEDDING_MODEL],
  );
}

async function seedSyncedPage(options: {
  confluenceId: string;
  version: number;
  bodyStorage: string;
  bodyHtml?: string;
  bodyText?: string;
  source?: 'confluence' | 'standalone';
  embeddingDirty?: boolean;
}): Promise<number> {
  const bodyHtml = options.bodyHtml
    ?? confluenceToHtml(options.bodyStorage, options.confluenceId, SPACE_KEY);
  const result = await query<{ id: number }>(
    `INSERT INTO pages
       (source, confluence_id, space_key, title, body_storage, body_html, body_text,
        version, embedding_dirty, embedding_status, image_analysis_dirty, last_synced)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             CASE WHEN $9 THEN 'not_embedded' ELSE 'embedded' END, FALSE, NOW())
     RETURNING id`,
    [
      options.source ?? 'confluence',
      options.confluenceId,
      SPACE_KEY,
      `Stored ${options.confluenceId}`,
      options.bodyStorage,
      bodyHtml,
      options.bodyText ?? htmlToText(bodyHtml),
      options.version,
      options.embeddingDirty ?? false,
    ],
  );
  return result.rows[0]!.id;
}

async function readPage(confluenceId: string): Promise<{
  body_storage: string;
  body_html: string;
  body_text: string;
  version: number;
  source: string;
  embedding_dirty: boolean;
  embedding_status: string;
  image_analysis_dirty: boolean;
}> {
  const result = await query<{
    body_storage: string;
    body_html: string;
    body_text: string;
    version: number;
    source: string;
    embedding_dirty: boolean;
    embedding_status: string;
    image_analysis_dirty: boolean;
  }>(
    `SELECT body_storage, body_html, body_text, version, source,
            embedding_dirty, embedding_status, image_analysis_dirty
       FROM pages WHERE confluence_id = $1`,
    [confluenceId],
  );
  return result.rows[0]!;
}

function counts(): { pagesCreated: number; pagesUpdated: number; pagesDeleted: number } {
  return { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };
}

describe.skipIf(!canRun)('sync and embedding persistence boundaries', () => {
  beforeAll(async () => {
    await setupTestDb();
    await mkdir(attachmentsRoot, { recursive: true });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Confluence fixture did not bind TCP');
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = new ConfluenceClient(baseUrl, 'fixture-pat');
  }, 30_000);

  beforeEach(async () => {
    releaseEmbeddingWait?.();
    releaseEmbeddingWait = null;
    embeddingWait = null;
    embeddingFailureStatus = null;
    await truncateAllTables();
    await rm(attachmentsRoot, { recursive: true, force: true });
    await mkdir(attachmentsRoot, { recursive: true });
    requestedPaths.length = 0;
    embeddingModels.length = 0;
    embeddingInputs.length = 0;
    upstreamPages.clear();
    upstreamAttachments.clear();
    modifiedPages = [];
  });

  afterEach(() => {
    releaseEmbeddingWait?.();
    releaseEmbeddingWait = null;
    embeddingWait = null;
  });

  afterAll(async () => {
    releaseEmbeddingWait?.();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await teardownTestDb();
    if (originalAttachmentsRoot === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsRoot;
    await rm(attachmentsRoot, { recursive: true, force: true });
  });

  it('keeps the sync in embedding state until the configured provider has indexed the dirty page', async () => {
    const userId = await seedActor();
    await seedEmbeddingProvider();
    const page = remotePage(
      'embed-1',
      1,
      '<h1>Indexing contract</h1><p>This substantive fixture text must reach the configured embedding provider and become searchable.</p>',
      'Indexing contract',
    );
    upstreamPages.set(page.id, page);

    embeddingWait = new Promise<void>((resolve) => { releaseEmbeddingWait = resolve; });
    try {
      await syncUser(userId);
      await expect.poll(() => embeddingInputs.length, { timeout: 10_000 }).toBe(1);

      expect((await getSyncStatus(userId)).status).toBe('embedding');
      expect(await readPage(page.id)).toMatchObject({
        source: 'confluence',
        version: 1,
        embedding_dirty: true,
        embedding_status: 'embedding',
      });
      expect(embeddingModels).toEqual([EMBEDDING_MODEL]);
      expect(embeddingInputs[0]!.join('\n')).toContain('substantive fixture text');
    } finally {
      releaseEmbeddingWait?.();
      releaseEmbeddingWait = null;
      embeddingWait = null;
    }

    await expect.poll(async () => {
      const pageState = await readPage(page.id);
      const embeddings = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM page_embeddings pe JOIN pages p ON p.id = pe.page_id WHERE p.confluence_id = $1',
        [page.id],
      );
      return {
        dirty: pageState.embedding_dirty,
        status: pageState.embedding_status,
        embeddings: Number(embeddings.rows[0]!.count),
        syncStatus: (await getSyncStatus(userId)).status,
      };
    }, { timeout: 10_000 }).toEqual({
      dirty: false,
      status: 'embedded',
      embeddings: 1,
      syncStatus: 'idle',
    });
  }, 20_000);

  it('settles the sync to idle while retaining a dirty failed page when the provider rejects indexing', async () => {
    const userId = await seedActor();
    await seedEmbeddingProvider();
    const page = remotePage(
      'embed-failure',
      1,
      '<p>This page is persisted even when the configured embedding provider rejects the indexing request.</p>',
      'Provider failure boundary',
    );
    upstreamPages.set(page.id, page);
    embeddingFailureStatus = 500;

    await syncUser(userId);

    await expect.poll(async () => {
      const pageState = await readPage(page.id);
      const embeddings = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM page_embeddings pe JOIN pages p ON p.id = pe.page_id WHERE p.confluence_id = $1',
        [page.id],
      );
      return {
        requests: embeddingInputs.length,
        dirty: pageState.embedding_dirty,
        status: pageState.embedding_status,
        embeddings: Number(embeddings.rows[0]!.count),
        syncStatus: (await getSyncStatus(userId)).status,
      };
    }, { timeout: 10_000 }).toEqual({
      requests: 1,
      dirty: true,
      status: 'failed',
      embeddings: 0,
      syncStatus: 'idle',
    });
    expect(embeddingModels).toEqual([EMBEDDING_MODEL]);
  }, 20_000);

  it('replaces an existing page attachment cache when a newer upstream version arrives', async () => {
    const userId = await seedActor();
    const pageId = 'cache-replace';
    const filename = 'evidence.png';
    const oldBody = '<p>Old body</p>';
    const newBody = `<p>New body</p><ac:image><ri:attachment ri:filename="${filename}" /></ac:image>`;
    await seedSyncedPage({ confluenceId: pageId, version: 1, bodyStorage: oldBody });
    const cacheDir = attachmentCacheDir(pageId);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, filename), Buffer.from('old cached bytes'));

    const page = remotePage(pageId, 2, newBody);
    upstreamPages.set(pageId, page);
    upstreamAttachments.set(pageId, new Map([[filename, Buffer.from('new upstream bytes')]]));
    const syncCounts = counts();

    await __internal.syncPage(
      client,
      userId,
      SPACE_KEY,
      page,
      new Date(),
      new Map(),
      syncCounts,
      randomUUID(),
    );

    expect(await readFile(join(cacheDir, filename), 'utf8')).toBe('new upstream bytes');
    expect(await readPage(pageId)).toMatchObject({
      body_storage: newBody,
      version: 2,
      source: 'confluence',
      embedding_dirty: true,
      image_analysis_dirty: true,
    });
    expect(syncCounts).toEqual({ pagesCreated: 0, pagesUpdated: 1, pagesDeleted: 0 });
    expect(requestedPaths).toContain(`/rest/api/content/${pageId}/child/attachment`);
    expect(requestedPaths).toContain(`/download/${pageId}/${filename}`);
  });

  it('recovers a missing file during an incremental scan without re-dirtying text or scanning standalone rows', async () => {
    const userId = await seedActor();
    const pageId = 'missing-cache';
    const standaloneId = 'standalone-historical-id';
    const filename = 'lost.png';
    const bodyStorage = `<p>Unchanged body</p><ac:image><ri:attachment ri:filename="${filename}" /></ac:image>`;
    await seedSyncedPage({ confluenceId: pageId, version: 4, bodyStorage });
    await seedSyncedPage({
      confluenceId: standaloneId,
      version: 4,
      bodyStorage: '<ac:image><ri:attachment ri:filename="local-only.png" /></ac:image>',
      source: 'standalone',
    });
    await query(
      `UPDATE spaces SET last_synced = NOW() - INTERVAL '5 minutes' WHERE space_key = $1`,
      [SPACE_KEY],
    );

    upstreamPages.set(pageId, remotePage(pageId, 4, bodyStorage));
    upstreamAttachments.set(pageId, new Map([[filename, Buffer.from('recovered bytes')]]));

    await __internal.syncSpace(
      client,
      userId,
      SPACE_KEY,
      undefined,
      new Date(),
      new Map(),
      randomUUID(),
    );

    expect(await readFile(join(attachmentCacheDir(pageId), filename), 'utf8')).toBe('recovered bytes');
    expect(await readPage(pageId)).toMatchObject({
      version: 4,
      body_storage: bodyStorage,
      embedding_dirty: false,
      embedding_status: 'embedded',
      image_analysis_dirty: true,
    });
    expect(await readPage(standaloneId)).toMatchObject({
      source: 'standalone',
      embedding_dirty: false,
      image_analysis_dirty: false,
    });
    expect(requestedPaths).toContain(`/rest/api/content/${pageId}/child/attachment`);
    expect(requestedPaths).not.toContain(`/rest/api/content/${standaloneId}/child/attachment`);
  });

  it('persists a changed rendered body at the same upstream version and marks it for re-indexing', async () => {
    const userId = await seedActor();
    const pageId = 'render-refresh';
    const bodyStorage = '<p>Converter output now contains the current rendered content.</p>';
    await seedSyncedPage({
      confluenceId: pageId,
      version: 7,
      bodyStorage,
      bodyHtml: '<p>stale rendered body</p>',
      bodyText: 'stale rendered body',
    });
    const page = remotePage(pageId, 7, bodyStorage, 'Refreshed rendering');
    upstreamPages.set(pageId, page);
    const expectedHtml = confluenceToHtml(bodyStorage, pageId, SPACE_KEY);
    const expectedText = htmlToText(expectedHtml);
    const syncCounts = counts();

    await __internal.syncPage(
      client,
      userId,
      SPACE_KEY,
      page,
      new Date(),
      new Map(),
      syncCounts,
      randomUUID(),
    );

    expect(await readPage(pageId)).toMatchObject({
      body_storage: bodyStorage,
      body_html: expectedHtml,
      body_text: expectedText,
      version: 7,
      embedding_dirty: true,
    });
    expect(syncCounts).toEqual({ pagesCreated: 0, pagesUpdated: 1, pagesDeleted: 0 });
  });
});
