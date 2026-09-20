import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { ConfluenceClient, type ConfluencePage } from './confluence-client.js';
import { __internal } from './sync-service.js';

const canRun = await isDbAvailable();
const spaceKey = 'LOCAL-HISTORICAL-ID';
const upstreamPages = new Map<string, ConfluencePage>();
const requestedPaths: string[] = [];
let listedIds: string[] = [];
let client: ConfluenceClient;
let root: string;
let originalRoot: string | undefined;
let ownerId: string;
let syncActorId: string;
const upstream = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://confluence.test');
  requestedPaths.push(url.pathname);
  response.setHeader('content-type', 'application/json');
  if (url.pathname === '/rest/api/content') {
    response.end(JSON.stringify({ results: listedIds.map((id) => ({ id })), _links: {} }));
    return;
  }
  if (url.pathname.endsWith('/child/attachment')) {
    response.end(JSON.stringify({ results: [], _links: {} }));
    return;
  }
  const page = upstreamPages.get(url.pathname.slice('/rest/api/content/'.length));
  if (page) response.end(JSON.stringify(page));
  else {
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'Not found upstream' }));
  }
});

function remotePage(id: string): ConfluencePage {
  return {
    id, title: 'Upstream title', status: 'current', type: 'page',
    version: { number: 2, when: '2026-09-01T00:00:00.000Z' },
    body: { storage: { value: '<p>Upstream replacement</p>' } },
  };
}

async function localPage(id: string, deleted = false): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO pages (source, confluence_id, space_key, title, body_html, body_storage,
                        body_text, version, visibility, created_by_user_id, deleted_at)
     VALUES ('standalone', $1, $2, 'Local title', '<p>Local authority</p>', '<p>Local authority</p>',
             'Local authority', 1, 'shared', $3,
             CASE WHEN $4 THEN NOW() - INTERVAL '20 minutes' ELSE NULL END)
     RETURNING id`,
    [id, spaceKey, ownerId, deleted],
  );
  return result.rows[0]!.id;
}

async function localState() {
  return (await query(
    `SELECT id, source, confluence_id, title, body_html, version, deleted_at
       FROM pages WHERE space_key = $1 ORDER BY id`,
    [spaceKey],
  )).rows;
}

describe.skipIf(!canRun)('Confluence sync does not own standalone historical identifiers', () => {
  beforeAll(async () => {
    await setupTestDb();
    root = await mkdtemp(join(tmpdir(), 'standalone-sync-'));
    originalRoot = process.env.ATTACHMENTS_DIR;
    process.env.ATTACHMENTS_DIR = root;
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Confluence fixture did not bind TCP');
    client = new ConfluenceClient(`http://127.0.0.1:${address.port}`, 'disposable-pat');
  });

  beforeEach(async () => {
    await truncateAllTables();
    upstreamPages.clear();
    requestedPaths.length = 0;
    listedIds = [];
    const users = await query<{ id: string; username: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('standalone-sync-owner', 'unused', 'user'),
              ('standalone-sync-actor', 'unused', 'user')
       RETURNING id, username`,
    );
    ownerId = users.rows.find((user) => user.username === 'standalone-sync-owner')!.id;
    syncActorId = users.rows.find((user) => user.username === 'standalone-sync-actor')!.id;
    await query(
      `INSERT INTO user_settings (user_id, confluence_enabled)
       VALUES ($1, FALSE), ($2, TRUE)`,
      [ownerId, syncActorId],
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await teardownTestDb();
    if (originalRoot === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('does not overwrite a local article or clean its cache when the upstream version advances', async () => {
    const id = '771001';
    await localPage(id);
    const before = await localState();
    const cache = join(root, id);
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'evidence.png'), 'local cached evidence');
    const page = remotePage(id);
    upstreamPages.set(id, page);
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await __internal.syncPage(client, syncActorId, spaceKey, page, new Date(), new Map(), counts, 'standalone-scope');

    expect(await localState()).toEqual(before);
    expect(await readFile(join(cache, 'evidence.png'), 'utf8')).toBe('local cached evidence');
    expect(counts).toEqual({ pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 });
    expect(requestedPaths).not.toContain(`/rest/api/content/${id}/child/attachment`);
  });

  it('does not trash a local article when its historical upstream identifier answers 404', async () => {
    const id = '771002';
    await localPage(id);
    const before = await localState();
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await __internal.syncPage(client, syncActorId, spaceKey, remotePage(id), new Date(), new Map(), counts, 'standalone-gone');

    expect(await localState()).toEqual(before);
    expect(counts.pagesDeleted).toBe(0);
  });

  it('neither deletes nor revives local articles from the upstream live-id listing', async () => {
    await localPage('771003');
    await localPage('771004', true);
    listedIds = ['771004'];
    const before = await localState();
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

    await __internal.detectDeletedPages(client, spaceKey, counts);

    expect(await localState()).toEqual(before);
    expect(counts.pagesDeleted).toBe(0);
    expect(requestedPaths).toEqual(['/rest/api/content']);
  });
});
