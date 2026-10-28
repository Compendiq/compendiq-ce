import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { ConfluenceClient, type ConfluencePage } from './confluence-client.js';

const available = await isDbAvailable();
const xml = '<mxfile><diagram>editable source</diagram></mxfile>';
const storage = '<p>Before</p><ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">flow</ac:parameter></ac:structured-macro><p>After</p>';
const page: ConfluencePage = { id: '179201', title: 'Diagram', type: 'page', status: 'current', version: { number: 1, when: '2026-01-01T00:00:00.000Z' }, body: { storage: { value: storage } } };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture');
  if (url.pathname === '/download/source') { res.end(xml); return; }
  res.setHeader('content-type', 'application/json');
  if (url.pathname.endsWith('/child/attachment')) {
    res.end(JSON.stringify({ results: [{ id: '1', title: 'flow.xml', _links: { download: '/download/source' } }] }));
  } else if (url.pathname === '/rest/api/content/179201') {
    res.end(JSON.stringify(page));
  } else { res.statusCode = 404; res.end('{}'); }
});

describe.skipIf(!available)('source-only draw.io sync', () => {
  let root: string;
  let oldRoot: string | undefined;
  let client: ConfluenceClient;
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    root = await mkdtemp(join(tmpdir(), 'drawio-sync-'));
    oldRoot = process.env.ATTACHMENTS_DIR;
    process.env.ATTACHMENTS_DIR = root;
    const ready = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', ready.resolve);
    await ready.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    client = new ConfluenceClient(`http://127.0.0.1:${address.port}`, 'fixture');
  });
  afterAll(async () => {
    const closed = Promise.withResolvers<void>();
    server.close((err) => err ? closed.reject(err) : closed.resolve());
    await closed.promise;
    if (oldRoot === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
    await teardownTestDb();
  });
  it('stores source, publishes an unavailable presentation, and keeps surrounding content', async () => {
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };
    // The attachment store captures ATTACHMENTS_DIR at module load.
    const { __internal } = await import('./sync-service.js');
    await __internal.syncPage(client, 'fixture', 'TEST', page, new Date(), new Map(), counts, 'drawio-test');
    const result = await query<{ body_html: string; body_storage: string }>('SELECT body_html, body_storage FROM pages WHERE confluence_id = $1', [page.id]);
    expect(result.rows[0]!.body_storage).toBe(storage);
    expect(result.rows[0]!.body_html).toContain('Before');
    expect(result.rows[0]!.body_html).toContain('After');
    expect(result.rows[0]!.body_html).toContain('Draw.io preview unavailable: flow');
    expect(result.rows[0]!.body_html).toContain('data-drawio-source="/api/attachments/179201/flow.drawio"');
    expect(result.rows[0]!.body_html).not.toContain('<img');
    expect(await readFile(join(root, page.id, 'flow.drawio'), 'utf8')).toBe(xml);
  });
});
