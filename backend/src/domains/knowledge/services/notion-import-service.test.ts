import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { getPool, query } from '../../../core/db/postgres.js';
import { ATTACHMENT_SNAPSHOT_LOCK_ID, NOTION_IMPORT_LOCK_KEY } from '../../../core/db/advisory-locks.js';
import {
  exportPostgresSnapshot,
  type ExportedBackupSnapshot,
} from '../../../core/services/backup-service.js';
import {
  completePageWriteIntent,
  reservePageWriteIntent,
  reconcilePageWriteIntent,
  runPageWriteIntentEffect,
  withPageHierarchyWriteTransaction,
} from '../../../core/services/page-write-admission.js';
import { NOTION_BOARD_REASON, NOTION_UNSUPPORTED_LABEL, type NotionImportItem } from '@compendiq/contracts';
import { startFakeNotionServer, type FakeNotionServer } from './__fixtures__/fake-notion-server.js';
import { NotionClient, setNotionApiBaseUrlForTests } from './notion-client.js';
import {
  NOTION_DISCOVERY_LIMIT_REASON,
  NOTION_TABLE_DOWNGRADE_REASON,
  NOTION_TABLE_ROW_SKIP_REASON,
  extractWikiPageProperties,
  runNotionImport,
  setNotionDiscoveryLimitForTests,
} from './notion-import-service.js';
import { notionImportLockId } from './notion-import-lock.js';

const dbAvailable = await isDbAvailable();
const TOKEN = 'secret_import_ntn_must_never_appear';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function titleProp(text: string) {
  return {
    title: {
      type: 'title',
      title: [{ type: 'text', plain_text: text, text: { content: text } }],
    },
  };
}

function paragraph(id: string, text: string, extra?: Record<string, unknown>) {
  return {
    object: 'block',
    id,
    type: 'paragraph',
    has_children: false,
    paragraph: {
      rich_text: [{ type: 'text', plain_text: text, text: { content: text }, ...extra }],
    },
  };
}

function rowTitleProp(text: string) {
  return { type: 'title', title: [{ type: 'text', plain_text: text, text: { content: text } }] };
}

function richTextProp(text: string) {
  return { type: 'rich_text', rich_text: [{ type: 'text', plain_text: text, text: { content: text } }] };
}

function selectProp(name: string) {
  return { type: 'select', select: { name } };
}

/**
 * A non-wiki `crm` database whose schema is a title column plus one rich_text
 * and one select, so a flattened table has non-title columns to carry.
 */
function crmDatabase(extra?: Record<string, unknown>) {
  return {
    object: 'database',
    id: 'crm',
    title: [{ type: 'text', plain_text: 'CRM' }],
    properties: {
      Name: { id: 'title', name: 'Name', type: 'title', title: {} },
      Notes: { id: 'nts', name: 'Notes', type: 'rich_text', rich_text: {} },
      Stage: { id: 'stg', name: 'Stage', type: 'select', select: {} },
    },
    ...extra,
  };
}

/** A `crm` row page — usable both as a query result and as a selectable page. */
function crmRow(id: string, name: string, notes: string, stage: string) {
  return {
    object: 'page',
    id,
    parent: { type: 'database_id', database_id: 'crm' },
    properties: { Name: rowTitleProp(name), Notes: richTextProp(notes), Stage: selectProp(stage) },
  };
}

const CRM_LEAD = '<p class="text-muted-foreground italic">Imported from the Notion database “CRM”.</p>';

describe.skipIf(!dbAvailable)('runNotionImport (#1465)', () => {
  let server: FakeNotionServer;
  let userId: string;
  let attachmentsDir: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    setNotionApiBaseUrlForTests(null);
    await teardownTestDb();
  });

  beforeEach(async () => {
    attachmentsDir = await mkdtemp(join(tmpdir(), 'notion-import-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
    await truncateAllTables();
    const user = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('notion-import-user', 'ni@test', 'x', 'user') RETURNING id",
    );
    userId = user.rows[0]!.id;
    await query('INSERT INTO spaces (space_key, space_name, source, created_by, last_synced) VALUES ($1, $1, $2, $3, NOW())', [
      'wiki',
      'local',
      userId,
    ]);
  });

  afterEach(async () => {
    setNotionApiBaseUrlForTests(null);
    setNotionDiscoveryLimitForTests(null);
    await server?.close();
    await rm(attachmentsDir, { recursive: true, force: true });
    expect(JSON.stringify(server?.requests.map((r) => r.url) ?? [])).not.toContain('api.notion.com');
    // A selected database legitimately enumerates its rows now: `table` mode
    // flattens all of them and inline `child_database` blocks read theirs, so
    // "no POST /v1/databases/:id/query" is no longer an invariant. Each test
    // asserts instead that no UNSELECTED row reaches the pages table.
  });

  async function start(state: Parameters<typeof startFakeNotionServer>[0]): Promise<NotionClient> {
    server = await startFakeNotionServer(state);
    setNotionApiBaseUrlForTests(server.baseUrl);
    return new NotionClient(TOKEN, { baseUrl: server.baseUrl });
  }

  async function waitForNotionRequest(path: string): Promise<void> {
    while (!server.requests.some((request) => request.url.includes(path))) {
      await setImmediate();
    }
  }
  async function freezeImportedPage(pageId: number): Promise<void> {
    const revisions = await query<{ content_revision: string; lifecycle_revision: string }>(
      'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1',
      [pageId],
    );
    const baselineId = randomUUID();
    const intent = await reservePageWriteIntent({
      pageIds: [pageId],
      kind: 'baseline.prepare',
      actorId: userId,
      effect: { effectClass: 'local', baselineId },
    });
    await runPageWriteIntentEffect(intent, { kind: 'local' }, async () => ({ baselineId }));
    await completePageWriteIntent(intent, async () => undefined);
    await query(
      `INSERT INTO page_baselines
         (id, page_id, original_page_id, page_identity, version, content_revision,
          lifecycle_revision, manifest_digest, manifest, manifest_bytes, title,
          body_html, body_storage, body_text, labels, attachments, total_bytes,
          reserved_bytes, status, prepared_by_user_id, prepared_by_name,
          published_by_user_id, published_by_name, published_at, provenance,
          freeze_reason, preparation_intent_id)
       VALUES ($1,$2,$2,'[]'::jsonb,1,$3::bigint,$4::bigint,$5,'[]'::jsonb,$6,
               'Frozen imported page','<p>body</p>','<p>body</p>','body','{}','[]'::jsonb,
               0,0,'published',$7,'Notion owner',$7,'Notion owner',NOW(),'manual_assertion',
               'Notion hierarchy regression',$8)`,
      [
        baselineId,
        pageId,
        revisions.rows[0]!.content_revision,
        revisions.rows[0]!.lifecycle_revision,
        'a'.repeat(64),
        Buffer.from('[]'),
        userId,
        intent.id,
      ],
    );
    await query(
      `UPDATE pages
          SET baseline_id = $2, frozen_version = version, frozen_at = NOW(),
              frozen_by_user_id = $3, frozen_by_name = 'Notion owner',
              freeze_reason = 'Notion hierarchy regression',
              freeze_provenance = 'manual_assertion',
              freeze_reported_signatories = '[]'::jsonb
        WHERE id = $1`,
      [pageId, baselineId, userId],
    );
  }

  it('keeps the selected Knowledge Base body and nests a wiki database before its rows regardless of input order', async () => {
    const rootId = 'aabbccdd-1122-3344-5566-778899aabbcc';
    const rootAlias = rootId.replace(/-/g, '').toUpperCase();
    const root = { object: 'page', id: rootId, properties: titleProp('Knowledge Base') };
    const wiki = {
      ...crmDatabase(), id: 'linux', is_inline: true,
      parent: { type: 'page_id', page_id: rootId },
      title: [{ plain_text: 'Linux' }],
      properties: { Name: { type: 'title', title: {} }, Verification: { type: 'verification', verification: {} } },
    };
    const client = await start({
      validToken: TOKEN,
      pages: {
        [rootId]: root, [rootAlias]: root,
        guide: { ...crmRow('guide', 'Guide', '', ''), parent: { type: 'database_id', database_id: 'linux' } },
      },
      // Some wiki-backed pages can also be retrieved through /databases.
      databases: { [rootId]: { ...wiki, id: rootId }, linux: wiki },
      pageErrors: { linux: 400 },
      blockChildren: {
        [rootId]: [
          paragraph('welcome', 'Knowledge Base introduction'),
          { id: 'linux', type: 'child_database', child_database: { title: 'Linux' } },
        ],
        [rootAlias]: [
          paragraph('welcome', 'Knowledge Base introduction'),
          { id: 'linux', type: 'child_database', child_database: { title: 'Linux' } },
        ],
        linux: [paragraph('wiki-home', 'Linux home instructions')],
        guide: [paragraph('guide-body', 'Package management')],
      },
    });
    const first = await runNotionImport({
      userId, client, pageIds: ['guide', 'linux', rootId, rootAlias, rootId], visibility: 'shared',
    });
    expect(first.every((item) => item.status === 'success')).toBe(true);
    expect(first.map((item) => item.notionPageId)).toEqual(['guide', 'linux', rootId]);
    const pages = await query<{ id: number; notion_page_id: string; parent_id: string | null; body_html: string; depth: number }>(
      'SELECT id, notion_page_id, parent_id, body_html, depth FROM pages ORDER BY depth',
    );
    expect(pages.rows.map((row) => row.notion_page_id)).toEqual([rootId, 'linux', 'guide']);
    expect(pages.rows[0]!.body_html).toContain('Knowledge Base introduction');
    expect(pages.rows[1]!.body_html).toContain('Linux home instructions');
    expect(pages.rows[0]!.body_html).not.toContain('<table>');
    expect(pages.rows[0]!.body_html).toContain('confluence-children-macro');
    expect(pages.rows[1]!.parent_id).toBe(String(pages.rows[0]!.id));
    expect(pages.rows[2]!.parent_id).toBe(String(pages.rows[1]!.id));
    expect(pages.rows.map((row) => row.depth)).toEqual([0, 1, 2]);
    const repeated = await runNotionImport({
      userId, client, pageIds: [rootAlias, 'linux', 'guide'], visibility: 'shared',
    });
    expect(repeated.every((item) => item.status === 'already_imported')).toBe(true);
    expect(repeated.map((item) => item.notionPageId)).toEqual([rootAlias, 'linux', 'guide']);
    expect((await query('SELECT id FROM pages')).rows).toHaveLength(3);
  });

  it('embeds property-only databases as host tables and article-bearing database rows as real host children', async () => {
    const tableRow = crmRow('contact', 'Ada', 'Visible contact note', 'Won');
    const article = {
      ...crmRow('runbook', 'Runbook', 'Metadata only', 'Won'),
      parent: { type: 'database_id', database_id: 'articles' },
    };
    const client = await start({
      validToken: TOKEN,
      pages: {
        host: { object: 'page', id: 'host', properties: titleProp('Operations') },
        contact: tableRow, runbook: article,
      },
      databases: {
        crm: crmDatabase({ parent: { type: 'page_id', page_id: 'host' } }),
        articles: crmDatabase({ id: 'articles', parent: { type: 'page_id', page_id: 'host' } }),
        excluded: crmDatabase({ id: 'excluded' }),
      },
      databaseQueryResults: { crm: [tableRow], articles: [article] },
      blockChildren: {
        host: [
          paragraph('intro', 'Operations introduction'),
          ...['crm', 'articles', 'excluded'].map((id) => ({ id, type: 'child_database', child_database: { title: id } })),
        ],
        contact: [], runbook: [paragraph('runbook-body', 'Restart the service safely')],
      },
    });
    const items = await runNotionImport({
      userId, client, pageIds: ['contact', 'articles', 'crm', 'runbook', 'host', 'excluded'],
      databaseModes: { excluded: 'skip' }, visibility: 'shared',
    });
    expect(items[0]).toMatchObject({ status: 'skip', reason: NOTION_TABLE_ROW_SKIP_REASON });
    expect(items[3]).toMatchObject({ status: 'success', importedAs: 'article' });
    const rows = await query<{ id: number; notion_page_id: string; parent_id: string | null; body_html: string }>(
      'SELECT id, notion_page_id, parent_id, body_html FROM pages ORDER BY notion_page_id',
    );
    expect(rows.rows.map((row) => row.notion_page_id)).toEqual(['host', 'runbook']);
    const host = rows.rows[0]!;
    const runbook = rows.rows[1]!;
    expect(host.body_html).toContain('<table>');
    expect(host.body_html).toContain('Ada');
    expect(host.body_html).toContain('Visible contact note');
    expect(host.body_html).not.toContain('Restart the service safely');
    expect(host.body_html).not.toContain('Metadata only');
    expect(host.body_html.match(/confluence-children-macro/g)).toHaveLength(1);
    expect(runbook.body_html).toContain('Restart the service safely');
    expect(runbook.parent_id).toBe(String(host.id));
    expect(server.requests.some((request) => request.url.includes('/databases/excluded'))).toBe(false);
    const nextBatch = await runNotionImport({
      userId, client, pageIds: ['contact'], databaseModes: { excluded: 'skip' }, visibility: 'shared',
    });
    expect(nextBatch[0]).toMatchObject({ status: 'skip', reason: NOTION_TABLE_ROW_SKIP_REASON });
    expect((await query('SELECT id FROM pages')).rows).toHaveLength(2);
  });

  it('gives a hosted database its own article with row articles beneath it when Pages was requested', async () => {
    // The picker offers Table | Pages | Skip on a database nested in a page and
    // `requestDatabaseModes` sends the shape for every selected one, so folding
    // it into the host regardless would make that control decorative.
    const row = crmRow('contact', 'Ada', 'Visible contact note', 'Won');
    const client = await start({
      validToken: TOKEN,
      pages: {
        host: { object: 'page', id: 'host', properties: titleProp('Operations') },
        contact: row,
      },
      databases: { crm: crmDatabase({ parent: { type: 'page_id', page_id: 'host' } }) },
      databaseQueryResults: { crm: [row] },
      blockChildren: {
        host: [{ id: 'crm', type: 'child_database', child_database: { title: 'CRM' } }],
        contact: [],
      },
    });

    const items = await runNotionImport({
      userId, client, pageIds: ['host', 'crm'],
      databaseModes: { crm: 'pages' }, visibility: 'shared',
    });

    expect(items).toEqual([
      expect.objectContaining({ notionPageId: 'host', status: 'success' }),
      expect.objectContaining({ notionPageId: 'crm', status: 'success', importedAs: 'page' }),
      expect.objectContaining({ notionPageId: 'contact', status: 'success', importedAs: 'article' }),
    ]);
    const rows = await query<{ id: number; notion_page_id: string; parent_id: string | null; body_html: string }>(
      'SELECT id, notion_page_id, parent_id, body_html FROM pages ORDER BY depth',
    );
    expect(rows.rows.map((r) => r.notion_page_id)).toEqual(['host', 'crm', 'contact']);
    const [host, crm, contact] = rows.rows as [typeof rows.rows[0], typeof rows.rows[0], typeof rows.rows[0]];
    // Nothing was flattened: the rows the operator asked to keep as articles
    // must not also appear as a table in the host.
    expect(host.body_html).not.toContain('<table>');
    expect(host.body_html).not.toContain('Visible contact note');
    expect(host.body_html).toContain('confluence-children-macro');
    expect(crm.parent_id).toBe(String(host.id));
    expect(crm.body_html).toContain('Imported from the Notion database “CRM”.');
    expect(crm.body_html).not.toContain('<table>');
    expect(contact.parent_id).toBe(String(crm.id));
    expect(contact.body_html).toContain('Visible contact note');
  });

  it('reports a discovered page past the ceiling as a skip that names its remedy', async () => {
    setNotionDiscoveryLimitForTests(2);
    const client = await start({
      validToken: TOKEN,
      pages: {
        root: { object: 'page', id: 'root', properties: titleProp('Root') },
        first: { object: 'page', id: 'first', parent: { type: 'page_id', page_id: 'root' }, properties: titleProp('First') },
        second: { object: 'page', id: 'second', parent: { type: 'page_id', page_id: 'root' }, properties: titleProp('Second') },
      },
      blockChildren: {
        root: [
          { id: 'first', type: 'child_page', child_page: { title: 'First' } },
          { id: 'second', type: 'child_page', child_page: { title: 'Second' } },
        ],
        first: [paragraph('f1', 'First body')],
        second: [paragraph('s1', 'Second body')],
      },
    });

    const items = await runNotionImport({ userId, client, pageIds: ['root'], visibility: 'shared' });

    expect(items).toEqual([
      expect.objectContaining({ notionPageId: 'root', status: 'success' }),
      expect.objectContaining({ notionPageId: 'first', status: 'success' }),
      { notionPageId: 'second', status: 'skip', reason: NOTION_DISCOVERY_LIMIT_REASON },
    ]);
    const stored = await query<{ notion_page_id: string }>('SELECT notion_page_id FROM pages ORDER BY id');
    expect(stored.rows.map((r) => r.notion_page_id)).toEqual(['root', 'first']);

    // The run stays idempotent, so the remedy the skip names actually works.
    setNotionDiscoveryLimitForTests(null);
    const retry = await runNotionImport({ userId, client, pageIds: ['second'], visibility: 'shared' });
    expect(retry).toEqual([expect.objectContaining({ notionPageId: 'second', status: 'success' })]);
    expect((await query('SELECT id FROM pages')).rows).toHaveLength(3);
  });

  it('imports an embedded wiki and its row articles when only the Knowledge Base root was selected', async () => {
    const guide = {
      ...crmRow('guide', 'Guide', '', ''),
      parent: { type: 'database_id', database_id: 'linux' },
    };
    const client = await start({
      validToken: TOKEN,
      pages: { root: { object: 'page', id: 'root', properties: titleProp('Knowledge Base') } },
      databases: {
        linux: {
          ...crmDatabase(), id: 'linux', is_inline: true,
          parent: { type: 'page_id', page_id: 'root' },
          properties: { Name: { type: 'title', title: {} }, Verification: { type: 'verification', verification: {} } },
        },
      },
      databaseQueryResults: { linux: [guide] },
      blockChildren: {
        root: [{ id: 'linux', type: 'child_database', child_database: { title: 'Linux' } }],
        linux: [paragraph('home', 'Wiki home body')],
        guide: [paragraph('guide-body', 'A real article body')],
      },
    });
    const items = await runNotionImport({ userId, client, pageIds: ['root'], visibility: 'shared' });
    expect(items[0]).toMatchObject({ status: 'success' });
    const rows = await query<{ id: number; notion_page_id: string; parent_id: string | null; body_html: string }>(
      'SELECT id, notion_page_id, parent_id, body_html FROM pages ORDER BY depth',
    );
    expect(rows.rows.map((row) => row.notion_page_id)).toEqual(['root', 'linux', 'guide']);
    expect(rows.rows[1]!.parent_id).toBe(String(rows.rows[0]!.id));
    expect(rows.rows[2]!.parent_id).toBe(String(rows.rows[1]!.id));
    expect(rows.rows[1]!.body_html).toContain('Wiki home body');
    expect(rows.rows[2]!.body_html).toContain('A real article body');
    expect(rows.rows[0]!.body_html).toContain('confluence-children-macro');
    expect(rows.rows[1]!.body_html).toContain('confluence-children-macro');
    expect(rows.rows.every((row) => !row.body_html.includes('<table>'))).toBe(true);
  });

  it('still indexes children of a page whose own prose names the children-macro class', async () => {
    // The macro used to be appended only when the converted HTML did not already
    // contain `confluence-children-macro` as a SUBSTRING, so a page documenting
    // that class suppressed its own child index.
    const guide = {
      ...crmRow('guide', 'Guide', '', ''),
      parent: { type: 'database_id', database_id: 'linux' },
    };
    const client = await start({
      validToken: TOKEN,
      pages: { root: { object: 'page', id: 'root', properties: titleProp('Knowledge Base') } },
      databases: {
        linux: {
          ...crmDatabase(), id: 'linux', is_inline: true,
          parent: { type: 'page_id', page_id: 'root' },
          properties: { Name: { type: 'title', title: {} }, Verification: { type: 'verification', verification: {} } },
        },
      },
      databaseQueryResults: { linux: [guide] },
      blockChildren: {
        root: [{ id: 'linux', type: 'child_database', child_database: { title: 'Linux' } }],
        linux: [paragraph('home', 'Confluence renders div.confluence-children-macro as a child index.')],
        guide: [paragraph('guide-body', 'A real article body')],
      },
    });

    await runNotionImport({ userId, client, pageIds: ['root'], visibility: 'shared' });

    const wiki = await query<{ body_html: string }>(
      "SELECT body_html FROM pages WHERE notion_page_id = 'linux'",
    );
    expect(wiki.rows[0]!.body_html).toContain('as a child index');
    expect(wiki.rows[0]!.body_html).toContain('<div class="confluence-children-macro"');
  });

  it('keeps a database with its own body and table in one child article rather than duplicating its table in the host', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: { host: { object: 'page', id: 'host', properties: titleProp('Host') } },
      databases: { crm: crmDatabase({ parent: { type: 'page_id', page_id: 'host' } }) },
      databaseQueryResults: { crm: [crmRow('contact', 'Ada', 'Contact details', 'Won')] },
      blockChildren: {
        host: [{ id: 'crm', type: 'child_database', child_database: { title: 'CRM' } }],
        crm: [paragraph('database-intro', 'Database-specific instructions')],
        contact: [],
      },
    });
    const items = await runNotionImport({ userId, client, pageIds: ['host'], visibility: 'shared' });
    expect(items).toEqual([
      expect.objectContaining({ notionPageId: 'host', status: 'success' }),
      expect.objectContaining({ notionPageId: 'crm', status: 'success', importedAs: 'table' }),
    ]);
    const rows = await query<{ notion_page_id: string; body_html: string; parent_id: string | null }>(
      'SELECT notion_page_id, body_html, parent_id FROM pages ORDER BY depth',
    );
    expect(rows.rows.map((row) => row.notion_page_id)).toEqual(['host', 'crm']);
    expect(rows.rows[0]!.body_html).not.toContain('<table>');
    expect(rows.rows[0]!.body_html).not.toContain('Contact details');
    expect(rows.rows[0]!.body_html).toContain('confluence-children-macro');
    expect(rows.rows[1]!.parent_id).toBe(String(items[0]!.localPageId));
    expect(rows.rows[1]!.body_html).toContain('Database-specific instructions');
    expect(rows.rows[1]!.body_html).toContain('Contact details');
    expect(rows.rows[1]!.body_html.match(/<table>/g)).toHaveLength(1);
  });

  it('reports discovered failures and newly imported children behind an already imported root', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: { root: { object: 'page', id: 'root', properties: titleProp('Root') } },
      blockChildren: {
        root: [
          paragraph('root-body', 'Root body stays intact'),
          { id: 'unavailable', type: 'child_page', child_page: { title: 'Unavailable' } },
        ],
      },
    });
    const first = await runNotionImport({ userId, client, pageIds: ['root'], visibility: 'shared' });
    expect(first).toEqual([
      expect.objectContaining({ notionPageId: 'root', status: 'success' }),
      expect.objectContaining({ notionPageId: 'unavailable', status: 'fail' }),
    ]);
    server.state.pages!.newChild = {
      object: 'page', id: 'newChild', properties: titleProp('New child'),
      parent: { type: 'page_id', page_id: 'root' },
    };
    server.state.blockChildren!.root = [
      paragraph('root-body', 'Changed source body must not overwrite local content'),
      { id: 'newChild', type: 'child_page', child_page: { title: 'New child' } },
    ];
    server.state.blockChildren!.newChild = [paragraph('child-body', 'New child body')];
    const repeated = await runNotionImport({ userId, client, pageIds: ['root'], visibility: 'shared' });
    expect(repeated).toEqual([
      expect.objectContaining({ notionPageId: 'root', status: 'already_imported', localPageId: first[0]!.localPageId }),
      expect.objectContaining({ notionPageId: 'newChild', status: 'success', localPageId: expect.any(Number) }),
    ]);
    const child = await query<{ parent_id: string; body_html: string }>(
      'SELECT parent_id, body_html FROM pages WHERE id = $1', [repeated[1]!.localPageId],
    );
    expect(child.rows[0]!.parent_id).toBe(String(first[0]!.localPageId));
    expect(child.rows[0]!.body_html).toContain('New child body');
    const root = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [first[0]!.localPageId]);
    expect(root.rows[0]!.body_html).toContain('Root body stays intact');
    expect(root.rows[0]!.body_html).not.toContain('Changed source body');
  });

  it('discovers nested embedded pages with host evidence overriding wiki parents without following ordinary links', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        host: { object: 'page', id: 'host', properties: titleProp('Host') },
        child: { object: 'page', id: 'child', parent: { type: 'database_id', database_id: 'wiki-db' }, properties: titleProp('Child') },
        grandchild: { object: 'page', id: 'grandchild', parent: { type: 'page_id', page_id: 'child' }, properties: titleProp('Grandchild') },
        linked: { object: 'page', id: 'linked', properties: titleProp('Not owned') },
      },
      blockChildren: {
        host: [
          { id: 'toggle', type: 'toggle', has_children: true, toggle: { rich_text: [] } },
          { id: 'link', type: 'link_to_page', link_to_page: { type: 'page_id', page_id: 'linked' } },
        ],
        toggle: [{ id: 'child', type: 'child_page', child_page: { title: 'Child' } }],
        child: [
          paragraph('child-body', 'Owned child body'),
          { id: 'grandchild', type: 'child_page', child_page: { title: 'Grandchild' } },
        ],
        grandchild: [paragraph('grandchild-body', 'Owned grandchild body')],
      },
    });
    const items = await runNotionImport({ userId, client, pageIds: ['host'], visibility: 'shared' });
    expect(items[0]).toMatchObject({ status: 'success' });
    const rows = await query<{ id: number; notion_page_id: string; parent_id: string | null; body_html: string }>(
      'SELECT id, notion_page_id, parent_id, body_html FROM pages ORDER BY depth',
    );
    expect(rows.rows.map((row) => row.notion_page_id)).toEqual(['host', 'child', 'grandchild']);
    expect(rows.rows[1]!.parent_id).toBe(String(rows.rows[0]!.id));
    expect(rows.rows[2]!.parent_id).toBe(String(rows.rows[1]!.id));
    expect(rows.rows[0]!.body_html).toContain('confluence-children-macro');
    expect(rows.rows[1]!.body_html).toContain('Owned child body');
    expect(rows.rows[1]!.body_html).toContain('confluence-children-macro');
    expect(server.requests.some((request) => request.url.includes('/pages/linked'))).toBe(false);
  });

  it('serializes an embedded-child import against a concurrent direct selection of that child', async () => {
    const fileRequested = Promise.withResolvers<void>();
    const releaseFile = Promise.withResolvers<void>();
    const client = await start({
      validToken: TOKEN,
      pages: {
        host: { object: 'page', id: 'host', properties: titleProp('Host') },
        child: { object: 'page', id: 'child', parent: { type: 'page_id', page_id: 'host' }, properties: titleProp('Child') },
      },
      blockChildren: {
        host: [{ id: 'child', type: 'child_page', child_page: { title: 'Child' } }],
        child: [],
      },
      files: { '/files/child.png': { contentType: 'image/png', body: PNG } },
      beforeFileResponse: async () => { fileRequested.resolve(); await releaseFile.promise; },
    });
    server.state.blockChildren!.child = [{
      id: 'image', type: 'image', image: { type: 'file', file: { url: `${server.baseUrl}/files/child.png` } },
    }];
    const winner = runNotionImport({ userId, client, pageIds: ['host'], visibility: 'shared' });
    let waiter: Promise<NotionImportItem[]> | undefined;
    try {
      await fileRequested.promise;
      waiter = runNotionImport({ userId, client, pageIds: ['child'], visibility: 'shared' });
      await expect.poll(async () => (await query(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid::bigint = $1 AND objid::bigint = $2 AND NOT granted`,
        [NOTION_IMPORT_LOCK_KEY, notionImportLockId(`notion-import-owner:${userId}`) >>> 0],
      )).rows.length).toBe(1);
      releaseFile.resolve();
      const [winnerItems, waiterItems] = await Promise.all([winner, waiter]);
      expect(winnerItems[0]).toMatchObject({ status: 'success' });
      expect(waiterItems[0]).toMatchObject({ status: 'already_imported' });
      const child = await query<{ parent_id: string; body_html: string }>(
        "SELECT parent_id, body_html FROM pages WHERE notion_page_id = 'child'",
      );
      expect(child.rows).toHaveLength(1);
      expect(child.rows[0]!.parent_id).toBe(String(winnerItems[0]!.localPageId));
      expect(child.rows[0]!.body_html).toContain('/api/local-attachments/');
      expect((await query('SELECT id FROM pages')).rows).toHaveLength(2);
    } finally {
      releaseFile.resolve();
      await Promise.allSettled([winner, ...(waiter ? [waiter] : [])]);
    }
  });

  it('persists selected pages as standalone under the local destination and keeps hierarchy among them', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        parent: {
          object: 'page',
          id: 'parent',
          parent: { type: 'workspace', workspace: true },
          url: 'https://www.notion.so/parent',
          properties: titleProp('Parent'),
        },
        child: {
          object: 'page',
          id: 'child',
          parent: { type: 'page_id', page_id: 'parent' },
          url: 'https://www.notion.so/child',
          properties: titleProp('Child'),
        },
        sibling: {
          object: 'page',
          id: 'sibling',
          parent: { type: 'workspace', workspace: true },
          url: 'https://www.notion.so/sibling',
          properties: titleProp('Sibling'),
        },
      },
      blockChildren: {
        parent: [paragraph('p1', 'Hello parent')],
        child: [paragraph('c1', 'Hello child')],
        sibling: [paragraph('s1', 'Hello sibling')],
      },
    });

    const dest = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, space_key, visibility)
       VALUES ('Dest', '', '', 1, 'standalone', $1, 'wiki', 'private') RETURNING id`,
      [userId],
    );
    const destId = dest.rows[0]!.id;

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['parent', 'child'],
      spaceKey: 'wiki',
      parentId: String(destId),
      visibility: 'private',
    });

    expect(items.map((i) => i.status)).toEqual(['success', 'success']);
    const rows = await query<{
      id: number;
      title: string;
      source: string;
      visibility: string;
      space_key: string | null;
      parent_id: string | null;
      notion_page_id: string | null;
      created_by_user_id: string | null;
      body_html: string;
    }>('SELECT id, title, source, visibility, space_key, parent_id, notion_page_id, created_by_user_id, body_html FROM pages WHERE notion_page_id IS NOT NULL ORDER BY title');
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.source === 'standalone')).toBe(true);
    expect(rows.rows.every((r) => r.visibility === 'private')).toBe(true);
    expect(rows.rows.every((r) => r.space_key === 'wiki')).toBe(true);
    expect(rows.rows.every((r) => r.created_by_user_id === userId)).toBe(true);

    const parent = rows.rows.find((r) => r.title === 'Parent')!;
    const child = rows.rows.find((r) => r.title === 'Child')!;
    expect(parent.parent_id).toBe(String(destId));
    expect(child.parent_id).toBe(String(parent.id));
    expect(parent.body_html).toContain('Hello parent');
    expect(child.body_html).toContain('Hello child');

    const leftover = await query('SELECT 1 FROM pages WHERE title = $1', ['Sibling']);
    expect(leftover.rows).toHaveLength(0);
  });

  it('nests a page whose Notion parent is a toggle block under the selected host', async () => {
    const dest = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, space_key, visibility, path)
       VALUES ('Dest', '<p>d</p>', 'd', 1, 'standalone', $1, 'wiki', 'private', '/0') RETURNING id`,
      [userId],
    );
    const destId = dest.rows[0]!.id;
    const client = await start({
      validToken: TOKEN,
      pages: {
        host: {
          object: 'page',
          id: 'host',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Host'),
        },
        nested: {
          object: 'page',
          id: 'nested',
          parent: { type: 'block_id', block_id: 'toggle-1' },
          properties: titleProp('Nested'),
        },
      },
      blocks: {
        'toggle-1': {
          object: 'block',
          id: 'toggle-1',
          type: 'toggle',
          parent: { type: 'page_id', page_id: 'host' },
        },
      },
      blockChildren: {
        host: [
          {
            object: 'block',
            id: 'toggle-1',
            type: 'toggle',
            has_children: true,
            toggle: { rich_text: [{ type: 'text', plain_text: 'More', text: { content: 'More' } }] },
          },
        ],
        'toggle-1': [
          {
            object: 'block',
            id: 'nested',
            type: 'child_page',
            child_page: { title: 'Nested' },
          },
        ],
        nested: [paragraph('n1', 'inside toggle')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['host', 'nested'],
      spaceKey: 'wiki',
      parentId: String(destId),
      visibility: 'private',
    });
    expect(items.every((i) => i.status === 'success')).toBe(true);
    const host = await query<{ id: number }>('SELECT id FROM pages WHERE notion_page_id = $1', ['host']);
    const nested = await query<{ parent_id: string | null }>(
      'SELECT parent_id FROM pages WHERE notion_page_id = $1',
      ['nested'],
    );
    expect(nested.rows[0]!.parent_id).toBe(String(host.rows[0]!.id));
    expect(nested.rows[0]!.parent_id).not.toBe(String(destId));
  });

  it('nests a block_id child under the selected host when the child_page block is absent from the host tree', async () => {
    const dest = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, space_key, visibility, path)
       VALUES ('Dest', '<p>d</p>', 'd', 1, 'standalone', $1, 'wiki', 'private', '/0') RETURNING id`,
      [userId],
    );
    const destId = dest.rows[0]!.id;
    const client = await start({
      validToken: TOKEN,
      pages: {
        host: {
          object: 'page',
          id: 'host',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Host'),
        },
        nested: {
          object: 'page',
          id: 'nested',
          parent: { type: 'block_id', block_id: 'toggle-1' },
          properties: titleProp('Nested'),
        },
      },
      blocks: {
        'toggle-1': {
          object: 'block',
          id: 'toggle-1',
          type: 'toggle',
          parent: { type: 'page_id', page_id: 'host' },
        },
      },
      blockChildren: {
        host: [paragraph('h1', 'host body')],
        nested: [paragraph('n1', 'nested body')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['host', 'nested'],
      spaceKey: 'wiki',
      parentId: String(destId),
      visibility: 'private',
    });
    expect(items.every((i) => i.status === 'success')).toBe(true);
    const host = await query<{ id: number }>('SELECT id FROM pages WHERE notion_page_id = $1', ['host']);
    const nested = await query<{ parent_id: string | null }>(
      'SELECT parent_id FROM pages WHERE notion_page_id = $1',
      ['nested'],
    );
    expect(nested.rows[0]!.parent_id).toBe(String(host.rows[0]!.id));
    expect(nested.rows[0]!.parent_id).not.toBe(String(destId));
  });
  it('nests a wiki sub-item under its parent page via relation property', async () => {
    const dest = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, space_key, visibility, path)
       VALUES ('Dest', '<p>d</p>', 'd', 1, 'standalone', $1, 'wiki', 'private', '/0') RETURNING id`,
      [userId],
    );
    const destId = dest.rows[0]!.id;
    const client = await start({
      validToken: TOKEN,
      pages: {
        ansible: {
          object: 'page',
          id: 'ansible',
          parent: { type: 'database_id', database_id: 'linux-wiki' },
          properties: titleProp('Ansible Playbooks'),
        },
        modules: {
          object: 'page',
          id: 'modules',
          parent: { type: 'database_id', database_id: 'linux-wiki' },
          properties: {
            ...titleProp('Modules'),
            'Parent item': {
              type: 'relation',
              relation: [{ id: 'ansible' }],
            },
          },
        },
      },
      blockChildren: {
        ansible: [paragraph('a1', 'ansible body')],
        modules: [paragraph('m1', 'modules body')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['ansible', 'modules'],
      spaceKey: 'wiki',
      parentId: String(destId),
      visibility: 'private',
    });
    expect(items.every((i) => i.status === 'success')).toBe(true);
    const ansible = await query<{ id: number }>('SELECT id FROM pages WHERE notion_page_id = $1', ['ansible']);
    const modules = await query<{ parent_id: string | null }>(
      'SELECT parent_id FROM pages WHERE notion_page_id = $1',
      ['modules'],
    );
    expect(modules.rows[0]!.parent_id).toBe(String(ansible.rows[0]!.id));
  });

  it('updates an existing page when overwriteExisting is true', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        doc: {
          object: 'page',
          id: 'doc',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Updated Document'),
        },
      },
      blockChildren: {
        doc: [paragraph('p1', 'Fresh updated content from Notion')],
      },
    });

    const orig = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, notion_page_id, embedding_dirty)
       VALUES ('Old Document', '<p>old</p>', 'old', 1, 'standalone', $1, 'doc', FALSE) RETURNING id`,
      [userId],
    );

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['doc'],
      visibility: 'shared',
      overwriteExisting: true,
    });

    expect(items).toEqual([
      expect.objectContaining({ notionPageId: 'doc', status: 'success', localPageId: orig.rows[0]!.id }),
    ]);
    const updated = await query<{ title: string; body_text: string; embedding_dirty: boolean }>(
      'SELECT title, body_text, embedding_dirty FROM pages WHERE id = $1',
      [orig.rows[0]!.id],
    );
    expect(updated.rows[0]!.title).toBe('Updated Document');
    expect(updated.rows[0]!.body_text).toContain('Fresh updated content from Notion');
    expect(updated.rows[0]!.embedding_dirty).toBe(true);
  });

  it('keeps the originally observed content and lifecycle revisions through read-only block work', async () => {
    const client = await start({
      validToken: TOKEN,
      lookupDelayMs: 150,
      pages: {
        'revision-race': {
          object: 'page',
          id: 'revision-race',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Remote replacement'),
        },
      },
      blockChildren: {
        'revision-race': [paragraph('replacement', 'Remote replacement body')],
      },
    });
    const original = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id, notion_page_id)
       VALUES ('Original', '<p>Original</p>', 'Original', 1, 'standalone', $1, 'revision-race')
       RETURNING id`,
      [userId],
    );
    const pageId = original.rows[0]!.id;

    const importing = runNotionImport({
      userId,
      client,
      pageIds: ['revision-race'],
      visibility: 'shared',
      overwriteExisting: true,
    });
    await waitForNotionRequest('/v1/blocks/revision-race/children');
    await query(
      `UPDATE pages
          SET title = 'Intervening edit',
              body_html = '<p>Intervening edit</p>',
              body_text = 'Intervening edit',
              content_revision = content_revision + 1,
              lifecycle_revision = lifecycle_revision + 1
        WHERE id = $1`,
      [pageId],
    );

    const result = await importing;
    expect(result[0]?.status).toBe('fail');
    const preserved = await query<{ title: string; body_text: string }>(
      'SELECT title, body_text FROM pages WHERE id = $1',
      [pageId],
    );
    expect(preserved.rows[0]).toEqual({
      title: 'Intervening edit',
      body_text: 'Intervening edit',
    });
  });

  it('does not adopt a stale incomplete target after it becomes authored during remote reads', async () => {
    const client = await start({
      validToken: TOKEN,
      lookupDelayMs: 150,
      pages: {
        'authored-placeholder': {
          object: 'page',
          id: 'authored-placeholder',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Remote title'),
        },
      },
      blockChildren: {
        'authored-placeholder': [paragraph('remote', 'Remote body')],
      },
    });
    const placeholder = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id, notion_page_id)
       VALUES ('Incomplete', '', '', 1, 'standalone', $1, 'authored-placeholder')
       RETURNING id`,
      [userId],
    );
    const pageId = placeholder.rows[0]!.id;

    const importing = runNotionImport({
      userId,
      client,
      pageIds: ['authored-placeholder'],
      visibility: 'shared',
    });
    await waitForNotionRequest('/v1/blocks/authored-placeholder/children');
    await query(
      `UPDATE pages
          SET title = 'Locally authored',
              body_html = '<p>Locally authored</p>',
              body_text = 'Locally authored',
              content_revision = content_revision + 1
        WHERE id = $1`,
      [pageId],
    );

    const result = await importing;
    expect(result[0]?.status).toBe('fail');
    const preserved = await query<{ title: string; body_text: string }>(
      'SELECT title, body_text FROM pages WHERE id = $1',
      [pageId],
    );
    expect(preserved.rows[0]).toEqual({
      title: 'Locally authored',
      body_text: 'Locally authored',
    });
  });

  it('rechecks ownership under admission immediately before the final overwrite', async () => {
    const client = await start({
      validToken: TOKEN,
      lookupDelayMs: 150,
      pages: {
        'ownership-race': {
          object: 'page',
          id: 'ownership-race',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Remote replacement'),
        },
      },
      blockChildren: {
        'ownership-race': [paragraph('replacement', 'Remote replacement body')],
      },
    });
    const other = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('notion-new-owner', 'new-owner@test', 'x', 'user') RETURNING id",
    );
    const original = await query<{
      id: number;
      content_revision: string;
      lifecycle_revision: string;
    }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id, notion_page_id)
       VALUES ('Owned original', '<p>Owned original</p>', 'Owned original', 1, 'standalone', $1, 'ownership-race')
       RETURNING id, content_revision::text, lifecycle_revision::text`,
      [userId],
    );
    const pageId = original.rows[0]!.id;

    const importing = runNotionImport({
      userId,
      client,
      pageIds: ['ownership-race'],
      visibility: 'shared',
      overwriteExisting: true,
    });
    await waitForNotionRequest('/v1/blocks/ownership-race/children');
    await query('UPDATE pages SET created_by_user_id = $1 WHERE id = $2', [
      other.rows[0]!.id,
      pageId,
    ]);
    const revoked = await query<{
      content_revision: string;
      lifecycle_revision: string;
    }>(
      'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1',
      [pageId],
    );
    expect(revoked.rows[0]).toEqual({
      content_revision: original.rows[0]!.content_revision,
      lifecycle_revision: original.rows[0]!.lifecycle_revision,
    });

    const result = await importing;
    expect(result[0]?.status).toBe('fail');
    const preserved = await query<{ created_by_user_id: string; title: string; body_text: string }>(
      'SELECT created_by_user_id, title, body_text FROM pages WHERE id = $1',
      [pageId],
    );
    expect(preserved.rows[0]).toEqual({
      created_by_user_id: other.rows[0]!.id,
      title: 'Owned original',
      body_text: 'Owned original',
    });
  });

  it('does not publish fetched media after a shared Notion page changes owner', async () => {
    const fileRequested = Promise.withResolvers<void>();
    const releaseFile = Promise.withResolvers<void>();
    const client = await start({
      validToken: TOKEN,
      pages: {
        'media-owner-race': {
          object: 'page',
          id: 'media-owner-race',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Remote media replacement'),
        },
      },
      blockChildren: {
        'media-owner-race': [],
      },
      files: {
        '/files/media-owner-race.png': { contentType: 'image/png', body: PNG },
      },
      beforeFileResponse: async (path) => {
        if (path === '/files/media-owner-race.png') {
          fileRequested.resolve();
          await releaseFile.promise;
        }
      },
    });
    server.state.blockChildren!['media-owner-race'] = [{
      id: 'remote-image',
      type: 'image',
      image: {
        type: 'file',
        file: { url: `${server.baseUrl}/files/media-owner-race.png` },
      },
    }];
    const nextOwner = await query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ($1, $2, 'x', 'user')
       RETURNING id`,
      [`notion-media-owner-${Date.now()}`, `notion-media-owner-${Date.now()}@test`],
    );
    const original = await query<{
      id: number;
      content_revision: string;
      lifecycle_revision: string;
    }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, visibility,
          created_by_user_id, notion_page_id)
       VALUES ('Prior media page', '<p>Prior media page</p>', 'Prior media page',
               1, 'standalone', 'shared', $1, 'media-owner-race')
       RETURNING id, content_revision::text, lifecycle_revision::text`,
      [userId],
    );
    const pageId = original.rows[0]!.id;
    const priorBytes = Buffer.from('prior attachment bytes');
    const pageDir = join(attachmentsDir, 'local', String(pageId));
    await mkdir(pageDir, { recursive: true });
    await writeFile(join(pageDir, 'prior.png'), priorBytes);
    await query(
      `INSERT INTO local_attachments
         (page_id, filename, content_type, size_bytes, sha256, created_by)
       VALUES ($1, 'prior.png', 'image/png', $2, $3, $4)`,
      [pageId, priorBytes.length, '0'.repeat(64), userId],
    );

    const importing = runNotionImport({
      userId,
      client,
      pageIds: ['media-owner-race'],
      visibility: 'shared',
      overwriteExisting: true,
    });
    try {
      await fileRequested.promise;
      await query('UPDATE pages SET created_by_user_id = $1 WHERE id = $2', [
        nextOwner.rows[0]!.id,
        pageId,
      ]);
      releaseFile.resolve();

      const result = await importing;
      expect(result[0]).toMatchObject({
        notionPageId: 'media-owner-race',
        status: 'fail',
      });
      const page = await query<{
        created_by_user_id: string;
        body_html: string;
        content_revision: string;
        lifecycle_revision: string;
      }>(
        `SELECT created_by_user_id, body_html,
                content_revision::text, lifecycle_revision::text
           FROM pages
          WHERE id = $1`,
        [pageId],
      );
      expect(page.rows[0]).toEqual({
        created_by_user_id: nextOwner.rows[0]!.id,
        body_html: '<p>Prior media page</p>',
        content_revision: original.rows[0]!.content_revision,
        lifecycle_revision: original.rows[0]!.lifecycle_revision,
      });
      const attachments = await query<{
        filename: string;
        size_bytes: string;
        created_by: string;
      }>(
        `SELECT filename, size_bytes::text, created_by
           FROM local_attachments
          WHERE page_id = $1
          ORDER BY filename`,
        [pageId],
      );
      expect(attachments.rows).toEqual([{
        filename: 'prior.png',
        size_bytes: String(priorBytes.length),
        created_by: userId,
      }]);
      expect(await readdir(pageDir)).toEqual(['prior.png']);
      expect(readFileSync(join(pageDir, 'prior.png'))).toEqual(priorBytes);
    } finally {
      releaseFile.resolve();
      await importing.catch(() => undefined);
    }
  });

  it('denies a deactivated actor immediately before the final authored overwrite', async () => {
    const client = await start({
      validToken: TOKEN,
      lookupDelayMs: 150,
      pages: {
        'inactive-race': {
          object: 'page',
          id: 'inactive-race',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Remote replacement'),
        },
      },
      blockChildren: {
        'inactive-race': [paragraph('replacement', 'Remote replacement body')],
      },
    });
    const original = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id, notion_page_id)
       VALUES ('Active original', '<p>Active original</p>', 'Active original', 1, 'standalone', $1, 'inactive-race')
       RETURNING id`,
      [userId],
    );
    const pageId = original.rows[0]!.id;

    const importing = runNotionImport({
      userId,
      client,
      pageIds: ['inactive-race'],
      visibility: 'shared',
      overwriteExisting: true,
    });
    await waitForNotionRequest('/v1/blocks/inactive-race/children');
    await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);

    const result = await importing;
    expect(result[0]).toMatchObject({
      notionPageId: 'inactive-race',
      status: 'fail',
    });
    const preserved = await query<{ title: string; body_text: string }>(
      'SELECT title, body_text FROM pages WHERE id = $1',
      [pageId],
    );
    expect(preserved.rows[0]).toEqual({
      title: 'Active original',
      body_text: 'Active original',
    });
  });


  it('does not delete a complete page when overwriteExisting hits a Notion 404', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {},
    });

    const orig = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, notion_page_id, embedding_dirty)
       VALUES ('Old Document', '<p>old</p>', 'old', 1, 'standalone', $1, 'doc', FALSE) RETURNING id`,
      [userId],
    );
    const pageId = orig.rows[0]!.id;

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['doc'],
      visibility: 'shared',
      overwriteExisting: true,
    });

    expect(items).toEqual([
      expect.objectContaining({ notionPageId: 'doc', status: 'fail' }),
    ]);
    const kept = await query<{ title: string; body_text: string }>(
      'SELECT title, body_text FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [pageId],
    );
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]!.title).toBe('Old Document');
    expect(kept.rows[0]!.body_text).toBe('old');
  });

  it('does not delete a complete page when overwriteExisting cannot fetch blocks', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        doc: {
          object: 'page',
          id: 'doc',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Updated Document'),
        },
      },
      blockChildrenErrors: { doc: 503 },
    });

    const orig = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, notion_page_id, embedding_dirty)
       VALUES ('Old Document', '<p>old</p>', 'old', 1, 'standalone', $1, 'doc', FALSE) RETURNING id`,
      [userId],
    );
    const pageId = orig.rows[0]!.id;

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['doc'],
      visibility: 'shared',
      overwriteExisting: true,
    });

    expect(items).toEqual([
      expect.objectContaining({ notionPageId: 'doc', status: 'fail' }),
    ]);
    const kept = await query<{ title: string; body_text: string }>(
      'SELECT title, body_text FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [pageId],
    );
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]!.title).toBe('Old Document');
    expect(kept.rows[0]!.body_text).toBe('old');
  });

  it('skips pages belonging to databases configured with skip mode', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        'row-1': {
          object: 'page',
          id: 'row-1',
          parent: { type: 'database_id', database_id: 'db-tracker' },
          properties: titleProp('Task 1'),
        },
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['row-1'],
      visibility: 'shared',
      databaseModes: { 'db-tracker': 'skip' },
    });

    expect(items).toEqual([expect.objectContaining({ notionPageId: 'row-1', status: 'skip' })]);
  });

  it('skips database rows when databaseModes keys differ only by dashes', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        'row-1': {
          object: 'page',
          id: 'row-1',
          parent: { type: 'database_id', database_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
          properties: titleProp('Task 1'),
        },
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['row-1'],
      visibility: 'shared',
      databaseModes: { aaaaaaaabbbbccccddddeeeeeeeeeeee: 'skip' },
    });

    expect(items).toEqual([expect.objectContaining({ notionPageId: 'row-1', status: 'skip' })]);
  });


  it('continues the run past a data_source selection that has no local shape', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        'ds-1': {
          object: 'data_source',
          id: 'ds-1',
          title: [{ type: 'text', plain_text: 'CRM rows' }],
        },
        notes: {
          object: 'page',
          id: 'notes',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Notes'),
        },
      },
      blockChildren: {
        notes: [paragraph('n1', 'Just notes')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['ds-1', 'notes'],
      visibility: 'shared',
    });

    expect(items[0]).toEqual({
      notionPageId: 'ds-1',
      status: 'skip',
      reason: NOTION_UNSUPPORTED_LABEL,
    });
    expect(items[1]).toMatchObject({ notionPageId: 'notes', status: 'success' });
    const pages = await query<{ title: string; source: string }>('SELECT title, source FROM pages');
    expect(pages.rows.map((r) => r.title)).toEqual(['Notes']);
    expect(pages.rows[0]!.source).toBe('standalone');
  });

  it('imports a database row only when it was selected as a page object', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        'row-listed': {
          object: 'page',
          id: 'row-listed',
          parent: { type: 'database_id', database_id: 'crm' },
          properties: titleProp('Acme Corp'),
        },
      },
      databases: {
        crm: { object: 'database', id: 'crm', title: [{ type: 'text', plain_text: 'CRM' }] },
      },
      databaseQueryResults: {
        crm: [{ object: 'page', id: 'hidden-row', properties: titleProp('Hidden') }],
      },
      blockChildren: {
        'row-listed': [paragraph('r1', 'Row body')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['row-listed'],
      visibility: 'shared',
    });
    expect(items).toEqual([
      expect.objectContaining({ notionPageId: 'row-listed', status: 'success' }),
      expect.objectContaining({ notionPageId: 'crm', status: 'success' }),
    ]);
    const pages = await query<{ id: number; title: string; parent_id: string | null }>('SELECT id, title, parent_id FROM pages ORDER BY id');
    expect(pages.rows.map((r) => r.title)).toEqual(['CRM', 'Acme Corp']);
    const crmId = pages.rows.find((r) => r.title === 'CRM')!.id;
    const acme = pages.rows.find((r) => r.title === 'Acme Corp')!;
    expect(acme.parent_id).toBe(String(crmId));
  });

  it('imports a table-mode database as one page and never stubs its rows', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: { crm: crmDatabase() },
      databaseQueryResults: {
        crm: [
          crmRow('row-a', 'Acme Corp', 'First note', 'Won'),
          crmRow('row-b', 'Globex', 'Second note', 'Lost'),
        ],
      },
      blockChildren: { 'row-a': [], 'row-b': [] },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
      databaseModes: { crm: 'table' },
    });

    expect(items).toEqual([
      { notionPageId: 'crm', status: 'success', localPageId: expect.any(Number), importedAs: 'table' },
    ]);

    const pages = await query<{
      id: number;
      title: string;
      notion_page_id: string | null;
      labels: string[];
      body_html: string;
    }>('SELECT id, title, notion_page_id, labels, body_html FROM pages');
    expect(pages.rows).toHaveLength(1);
    const table = pages.rows[0]!;
    expect(table.id).toBe(items[0]!.localPageId);
    expect(table.notion_page_id).toBe('crm');
    expect(table.title).toBe('CRM');
    expect(table.labels).toEqual(expect.arrayContaining(['notion-import']));
    expect(table.body_html).toContain('<table>');
    expect(table.body_html).toContain('Acme Corp');
    expect(table.body_html).toContain('Globex');

    const rowPages = await query('SELECT 1 FROM pages WHERE notion_page_id IN ($1, $2)', ['row-a', 'row-b']);
    expect(rowPages.rows).toHaveLength(0);
  });

  it('carries non-title row property values and their headers into the flattened table', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: { crm: crmDatabase() },
      databaseQueryResults: { crm: [crmRow('row-a', 'Acme Corp', 'First note', 'Won')] },
      blockChildren: { 'row-a': [] },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
      databaseModes: { crm: 'table' },
    });
    expect(items[0]).toMatchObject({ status: 'success', importedAs: 'table' });

    const stored = await query<{ body_html: string }>(
      'SELECT body_html FROM pages WHERE notion_page_id = $1',
      ['crm'],
    );
    const bodyHtml = stored.rows[0]!.body_html;
    expect(bodyHtml).toContain('<th>Notes</th>');
    expect(bodyHtml).toContain('<th>Stage</th>');
    expect(bodyHtml).toContain('<td>First note</td>');
    expect(bodyHtml).toContain('<td>Won</td>');
  });

  it('reports rows folded into a table-mode database as skipped instead of importing them', async () => {
    const rowA = crmRow('row-a', 'Acme Corp', 'First note', 'Won');
    const rowB = crmRow('row-b', 'Globex', 'Second note', 'Lost');
    const client = await start({
      validToken: TOKEN,
      pages: { 'row-a': rowA, 'row-b': rowB },
      databases: { crm: crmDatabase() },
      databaseQueryResults: { crm: [rowA, rowB] },
      blockChildren: { 'row-a': [], 'row-b': [] },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm', 'row-a', 'row-b'],
      visibility: 'shared',
      databaseModes: { crm: 'table' },
    });

    expect(items[0]).toMatchObject({ notionPageId: 'crm', status: 'success', importedAs: 'table' });
    expect(items[1]).toEqual({
      notionPageId: 'row-a',
      status: 'skip',
      reason: NOTION_TABLE_ROW_SKIP_REASON,
    });
    expect(items[2]).toEqual({
      notionPageId: 'row-b',
      status: 'skip',
      reason: NOTION_TABLE_ROW_SKIP_REASON,
    });

    const pages = await query<{ notion_page_id: string | null }>('SELECT notion_page_id FROM pages');
    expect(pages.rows.map((r) => r.notion_page_id)).toEqual(['crm']);
  });

  it('downgrades a table-mode database to a container page when a row carries body content', async () => {
    const rowA = crmRow('row-a', 'Acme Corp', 'First note', 'Won');
    const rowB = crmRow('row-b', 'Globex', 'Second note', 'Lost');
    const client = await start({
      validToken: TOKEN,
      pages: { 'row-a': rowA, 'row-b': rowB },
      databases: { crm: crmDatabase() },
      databaseQueryResults: { crm: [rowA, rowB] },
      blockChildren: {
        'row-a': [paragraph('ra1', 'Acme meeting notes')],
        'row-b': [],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm', 'row-a', 'row-b'],
      visibility: 'shared',
      databaseModes: { crm: 'table' },
    });

    expect(items[0]).toEqual({
      notionPageId: 'crm',
      status: 'success',
      localPageId: expect.any(Number),
      importedAs: 'page',
      reason: NOTION_TABLE_DOWNGRADE_REASON,
    });
    // Lossless: the table the picker offered is gone, but every row arrives as
    // its own article under the container instead of vanishing.
    expect(items[1]).toMatchObject({ notionPageId: 'row-a', status: 'success', importedAs: 'article' });
    expect(items[2]).toMatchObject({ notionPageId: 'row-b', status: 'success', importedAs: 'article' });

    const containerId = items[0]!.localPageId!;
    const pages = await query<{
      id: number;
      parent_id: string | null;
      notion_page_id: string | null;
      body_html: string;
    }>('SELECT id, parent_id, notion_page_id, body_html FROM pages ORDER BY id');
    expect(pages.rows).toHaveLength(3);
    const container = pages.rows.find((r) => r.notion_page_id === 'crm')!;
    expect(container.id).toBe(containerId);
    expect(container.body_html).not.toContain('<table>');
    expect(container.body_html).toContain(CRM_LEAD);
    const storedRowA = pages.rows.find((r) => r.notion_page_id === 'row-a')!;
    const storedRowB = pages.rows.find((r) => r.notion_page_id === 'row-b')!;
    expect(storedRowA.parent_id).toBe(String(containerId));
    expect(storedRowB.parent_id).toBe(String(containerId));
    expect(storedRowA.body_html).toContain('Acme meeting notes');
  });

  it('still imports row articles when table mode is requested without the row ids', async () => {
    const rowA = crmRow('row-a', 'Acme Corp', 'First note', 'Won');
    const rowB = crmRow('row-b', 'Globex', 'Second note', 'Lost');
    const client = await start({
      validToken: TOKEN,
      pages: { 'row-a': rowA, 'row-b': rowB },
      databases: { crm: crmDatabase() },
      databaseQueryResults: { crm: [rowA, rowB] },
      blockChildren: {
        'row-a': [paragraph('ra1', 'Acme meeting notes')],
        'row-b': [],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
      databaseModes: { crm: 'table' },
    });

    expect(items[0]).toMatchObject({
      notionPageId: 'crm',
      status: 'success',
      importedAs: 'page',
      reason: NOTION_TABLE_DOWNGRADE_REASON,
    });

    const pages = await query<{
      parent_id: string | null;
      notion_page_id: string | null;
      body_html: string;
    }>('SELECT parent_id, notion_page_id, body_html FROM pages ORDER BY id');
    expect(pages.rows.map((r) => r.notion_page_id).sort()).toEqual(['crm', 'row-a', 'row-b']);
    const container = pages.rows.find((r) => r.notion_page_id === 'crm')!;
    expect(container.body_html).not.toContain('<table>');
    const storedRowA = pages.rows.find((r) => r.notion_page_id === 'row-a')!;
    expect(storedRowA.parent_id).toBe(String(items[0]!.localPageId));
    expect(storedRowA.body_html).toContain('Acme meeting notes');
  });

  it('gives a zero-row table-mode database a container page and no downgrade explanation', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: { crm: crmDatabase() },
      databaseQueryResults: { crm: [] },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
      databaseModes: { crm: 'table' },
    });

    // Exact shape on purpose: a database with no rows lost nothing, so the
    // downgrade sentence would be a lie. There must be no `reason` at all.
    expect(items).toEqual([
      { notionPageId: 'crm', status: 'success', localPageId: expect.any(Number), importedAs: 'page' },
    ]);

    const pages = await query<{ notion_page_id: string | null; body_html: string }>(
      'SELECT notion_page_id, body_html FROM pages',
    );
    expect(pages.rows).toHaveLength(1);
    expect(pages.rows[0]!.notion_page_id).toBe('crm');
    expect(pages.rows[0]!.body_html).not.toContain('<table>');
  });

  it('imports a pages-mode database as a container page with its selected rows nested underneath', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        'row-a': crmRow('row-a', 'Acme Corp', 'First note', 'Won'),
        'row-b': crmRow('row-b', 'Globex', 'Second note', 'Lost'),
      },
      databases: {
        crm: crmDatabase({ description: [{ type: 'text', plain_text: 'Customer pipeline' }] }),
      },
      blockChildren: {
        'row-a': [paragraph('ra1', 'Acme meeting notes')],
        'row-b': [paragraph('rb1', 'Globex intro call')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm', 'row-a', 'row-b'],
      visibility: 'shared',
      databaseModes: { crm: 'pages' },
    });

    expect(items[0]).toEqual({
      notionPageId: 'crm',
      status: 'success',
      localPageId: expect.any(Number),
      importedAs: 'page',
    });
    expect(items[1]).toMatchObject({ notionPageId: 'row-a', status: 'success', importedAs: 'article' });
    expect(items[2]).toMatchObject({ notionPageId: 'row-b', status: 'success', importedAs: 'article' });

    const containerId = items[0]!.localPageId!;
    const pages = await query<{
      id: number;
      parent_id: string | null;
      notion_page_id: string | null;
      body_html: string;
    }>('SELECT id, parent_id, notion_page_id, body_html FROM pages ORDER BY id');
    expect(pages.rows).toHaveLength(3);
    const container = pages.rows.find((r) => r.notion_page_id === 'crm')!;
    expect(container.id).toBe(containerId);
    expect(pages.rows.find((r) => r.notion_page_id === 'row-a')!.parent_id).toBe(String(containerId));
    expect(pages.rows.find((r) => r.notion_page_id === 'row-b')!.parent_id).toBe(String(containerId));
  });

  it('writes nothing for a skip-mode database', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: { crm: crmDatabase() },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
      databaseModes: { crm: 'skip' },
    });

    expect(items).toEqual([
      { notionPageId: 'crm', status: 'skip', reason: 'Database is excluded from import' },
    ]);
    expect((await query('SELECT 1 FROM pages')).rows).toHaveLength(0);
  });

  it('skips a Board database and does not flatten it into a table', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: { sprint: crmDatabase({ id: 'sprint', title: [{ type: 'text', plain_text: 'Sprint' }], layout: 'board' }) },
      pages: {
        'card-a': {
          object: 'page',
          id: 'card-a',
          parent: { type: 'database_id', database_id: 'sprint' },
          properties: titleProp('Ship login'),
        },
      },
      blockChildren: { 'card-a': [paragraph('c1', 'Login checklist')] },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['sprint'],
      visibility: 'private',
      databaseModes: { sprint: 'table' },
    });

    expect(items).toEqual([
      { notionPageId: 'sprint', status: 'skip', reason: NOTION_BOARD_REASON },
    ]);
    expect((await query('SELECT 1 FROM pages')).rows).toHaveLength(0);
  });

  it('imports Board cards as articles under a namesake of the containing Notion page', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: {
        sprint: crmDatabase({
          id: 'sprint',
          title: [{ type: 'text', plain_text: 'Sprint' }],
          layout: 'board',
          parent: { type: 'workspace', workspace: true },
        }),
      },
      pages: {
        'card-a': {
          object: 'page',
          id: 'card-a',
          parent: { type: 'database_id', database_id: 'sprint' },
          properties: titleProp('Ship login'),
        },
        'card-b': {
          object: 'page',
          id: 'card-b',
          parent: { type: 'database_id', database_id: 'sprint' },
          properties: titleProp('Write RFC'),
        },
      },
      blockChildren: {
        'card-a': [paragraph('c1', 'Login checklist')],
        'card-b': [paragraph('c2', 'RFC draft')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['card-a', 'card-b'],
      visibility: 'private',
    });

    const byId = Object.fromEntries(items.map((item) => [item.notionPageId, item]));
    expect(byId['card-a']).toMatchObject({ status: 'success', importedAs: 'article' });
    expect(byId['card-b']).toMatchObject({ status: 'success', importedAs: 'article' });
    expect(byId.sprint).toMatchObject({ status: 'success', importedAs: 'page' });

    const pages = await query<{ title: string; notion_page_id: string; parent_id: string | null; body_html: string }>(
      'SELECT title, notion_page_id, parent_id, body_html FROM pages ORDER BY title',
    );
    const container = pages.rows.find((row) => row.notion_page_id === 'sprint')!;
    expect(container.title).toBe('Sprint');
    expect(container.body_html).toContain('Imported from the Notion board');
    expect(container.body_html).not.toContain('<table>');
    const cards = pages.rows.filter((row) => row.notion_page_id !== 'sprint');
    expect(cards).toHaveLength(2);
    expect(cards.every((row) => row.parent_id === String(byId.sprint.localPageId))).toBe(true);
  });

  it('nests inline Board cards under an article named after the host Notion page', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        projects: {
          object: 'page',
          id: 'projects',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Projects'),
        },
        'card-1': {
          object: 'page',
          id: 'card-1',
          parent: { type: 'database_id', database_id: 'kanban' },
          properties: titleProp('Write RFC'),
        },
      },
      databases: {
        kanban: crmDatabase({
          id: 'kanban',
          title: [{ type: 'text', plain_text: 'Delivery' }],
          layout: 'board',
          is_inline: true,
          parent: { type: 'page_id', page_id: 'projects' },
        }),
      },
      blockChildren: {
        'card-1': [paragraph('c1', 'RFC draft')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['card-1'],
      visibility: 'private',
    });

    const byId = Object.fromEntries(items.map((item) => [item.notionPageId, item]));
    expect(byId['card-1']).toMatchObject({ status: 'success', importedAs: 'article' });
    expect(byId.projects).toMatchObject({ status: 'success', importedAs: 'page' });
    expect(byId.kanban).toMatchObject({ status: 'skip', reason: NOTION_BOARD_REASON });

    const pages = await query<{ title: string; notion_page_id: string; parent_id: string | null; body_html: string }>(
      'SELECT title, notion_page_id, parent_id, body_html FROM pages',
    );
    const host = pages.rows.find((row) => row.notion_page_id === 'projects')!;
    expect(host.title).toBe('Projects');
    expect(host.body_html).toContain('Imported from the Notion board “Delivery”');
    expect(host.body_html).not.toContain('<table>');
    const card = pages.rows.find((row) => row.notion_page_id === 'card-1')!;
    expect(card.parent_id).toBe(String(byId.projects.localPageId));
    expect(pages.rows.some((row) => row.notion_page_id === 'kanban')).toBe(false);
  });

  it('defaults a wiki database to a container page whose lead says wiki, not database', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: {
        'team-wiki': {
          object: 'database',
          id: 'team-wiki',
          title: [{ type: 'text', plain_text: 'Team Wiki' }],
          properties: {
            Name: { id: 'title', name: 'Name', type: 'title', title: {} },
            Verification: { id: 'ver', name: 'Verification', type: 'verification', verification: {} },
          },
        },
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['team-wiki'],
      visibility: 'shared',
    });

    expect(items).toEqual([
      { notionPageId: 'team-wiki', status: 'success', localPageId: expect.any(Number), importedAs: 'page' },
    ]);

    const stored = await query<{ body_html: string }>(
      'SELECT body_html FROM pages WHERE notion_page_id = $1',
      ['team-wiki'],
    );
    const bodyHtml = stored.rows[0]!.body_html;
    expect(bodyHtml).not.toContain('<table>');
    expect(bodyHtml).not.toContain('Notion database');
  });

  it('imports a wiki database when Notion refuses GET /v1/pages with 400', async () => {
    const client = await start({
      validToken: TOKEN,
      pageErrors: { linux: 400 },
      databases: {
        linux: {
          object: 'database',
          id: 'linux',
          title: [{ type: 'text', plain_text: 'Linux' }],
          properties: {
            Name: { id: 'title', name: 'Name', type: 'title', title: {} },
            Verification: { id: 'ver', name: 'Verification', type: 'verification', verification: {} },
          },
        },
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['linux'],
      visibility: 'shared',
    });

    expect(items).toEqual([
      { notionPageId: 'linux', status: 'success', localPageId: expect.any(Number), importedAs: 'page' },
    ]);
    const stored = await query<{ body_html: string }>(
      'SELECT body_html FROM pages WHERE notion_page_id = $1',
      ['linux'],
    );
    expect(stored.rows[0]!.body_html).toContain('Notion wiki “Linux”');
    expect(stored.rows[0]!.body_html).not.toContain('<table>');
  });

  it('defaults a non-wiki database with body-less rows to one table', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: { crm: crmDatabase() },
      databaseQueryResults: { crm: [crmRow('row-a', 'Acme Corp', 'First note', 'Won')] },
      blockChildren: { 'row-a': [] },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
    });

    expect(items).toEqual([
      { notionPageId: 'crm', status: 'success', localPageId: expect.any(Number), importedAs: 'table' },
    ]);
    const stored = await query<{ body_html: string }>(
      'SELECT body_html FROM pages WHERE notion_page_id = $1',
      ['crm'],
    );
    expect(stored.rows[0]!.body_html).toContain('<table>');
  });

  it('flattens a simple database whose rows only have empty template blocks', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: { crm: crmDatabase() },
      databaseQueryResults: { crm: [crmRow('row-a', 'Acme Corp', 'First note', 'Won')] },
      blockChildren: {
        'row-a': [
          {
            object: 'block',
            id: 'row-a-heading',
            type: 'heading_2',
            heading_2: { rich_text: [] },
          },
        ],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
    });

    expect(items[0]).toMatchObject({ notionPageId: 'crm', status: 'success', importedAs: 'table' });
    expect((await query('SELECT notion_page_id FROM pages')).rows.map((r) => r.notion_page_id)).toEqual(['crm']);
  });

  it('refuses to flatten a database whose row body hides inside a blank toggle', async () => {
    const rowA = crmRow('row-a', 'Acme Corp', 'First note', 'Won');
    const client = await start({
      validToken: TOKEN,
      pages: { 'row-a': rowA },
      databases: { crm: crmDatabase() },
      databaseQueryResults: { crm: [rowA] },
      blockChildren: {
        // The row reads as a lone untitled toggle; the prose is one level down.
        'row-a': [
          { object: 'block', id: 'row-a-toggle', type: 'toggle', has_children: true, toggle: { rich_text: [] } },
        ],
        'row-a-toggle': [paragraph('ra1', 'Acme meeting notes')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
      databaseModes: { crm: 'table' },
    });

    expect(items[0]).toMatchObject({
      notionPageId: 'crm',
      status: 'success',
      importedAs: 'page',
      reason: NOTION_TABLE_DOWNGRADE_REASON,
    });
    const pages = await query<{ notion_page_id: string | null; body_html: string }>(
      'SELECT notion_page_id, body_html FROM pages ORDER BY id',
    );
    expect(pages.rows.map((r) => r.notion_page_id)).toEqual(['crm', 'row-a']);
    // The body the flatten would have dropped.
    expect(pages.rows.find((r) => r.notion_page_id === 'row-a')!.body_html).toContain('Acme meeting notes');
  });

  it('re-runs a table-mode database against the same page instead of creating a second one', async () => {
    const client = await start({
      validToken: TOKEN,
      databases: { crm: crmDatabase() },
      databaseQueryResults: { crm: [crmRow('row-a', 'Acme Corp', 'First note', 'Won')] },
      blockChildren: { 'row-a': [] },
    });
    const databaseModes = { crm: 'table' } as const;

    const first = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
      databaseModes,
    });
    expect(first[0]).toMatchObject({ status: 'success', importedAs: 'table' });
    const localPageId = first[0]!.localPageId!;

    const second = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
      databaseModes,
    });
    expect(second).toEqual([{ notionPageId: 'crm', status: 'already_imported', localPageId }]);
    expect((await query('SELECT 1 FROM pages')).rows).toHaveLength(1);

    const third = await runNotionImport({
      userId,
      client,
      pageIds: ['crm'],
      visibility: 'shared',
      databaseModes,
      overwriteExisting: true,
    });
    expect(third).toEqual([
      { notionPageId: 'crm', status: 'success', localPageId, importedAs: 'table', updated: true },
    ]);
    const pages = await query<{ id: number }>('SELECT id FROM pages');
    expect(pages.rows).toHaveLength(1);
    expect(pages.rows[0]!.id).toBe(localPageId);
  });
  it('rewrites mentions of imported pages and leaves skipped ones as Notion URLs', async () => {
    const importedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const skippedId = '11111111-2222-3333-4444-555555555555';
    const client = await start({
      validToken: TOKEN,
      pages: {
        [importedId]: {
          object: 'page',
          id: importedId,
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Imported'),
        },
        host: {
          object: 'page',
          id: 'host',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Host'),
        },
      },
      blockChildren: {
        [importedId]: [paragraph('i1', 'Imported body')],
        host: [
          {
            object: 'block',
            id: 'mention',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'mention',
                  mention: { type: 'page', page: { id: importedId } },
                  plain_text: 'Imported',
                  href: `https://www.notion.so/${importedId.replace(/-/g, '')}`,
                },
                {
                  type: 'mention',
                  mention: { type: 'page', page: { id: skippedId } },
                  plain_text: 'Skipped',
                  href: `https://www.notion.so/${skippedId.replace(/-/g, '')}`,
                },
              ],
            },
          },
        ],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: [importedId, 'host'],
      visibility: 'shared',
    });
    expect(items.every((i) => i.status === 'success')).toBe(true);
    const host = await query<{ body_html: string; id: number }>(
      `SELECT id, body_html FROM pages WHERE notion_page_id = 'host'`,
    );
    const imported = await query<{ id: number }>(
      `SELECT id FROM pages WHERE notion_page_id = $1`,
      [importedId],
    );
    expect(host.rows[0]!.body_html).toContain(`/pages/${imported.rows[0]!.id}`);
    expect(host.rows[0]!.body_html).toContain(`https://www.notion.so/${skippedId.replace(/-/g, '')}`);
  });

  it('sanitizes Notion HTML before persist', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        dirty: {
          object: 'page',
          id: 'dirty',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Dirty'),
        },
      },
      blockChildren: {
        dirty: [
          {
            object: 'block',
            id: 'xss',
            type: 'paragraph',
            paragraph: {
              rich_text: [
                {
                  type: 'text',
                  plain_text: 'click',
                  text: { content: 'click', link: { url: 'javascript:alert(1)' } },
                  href: 'javascript:alert(1)',
                },
              ],
            },
          },
        ],
      },
    });

    await runNotionImport({ userId, client, pageIds: ['dirty'], visibility: 'shared' });
    const row = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE notion_page_id = $1', ['dirty']);
    expect(row.rows[0]!.body_html).not.toMatch(/javascript:/i);
    expect(row.rows[0]!.body_html).not.toMatch(/<script/i);
  });

  it('reports per-item fail without aborting the rest of the run', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        ok: {
          object: 'page',
          id: 'ok',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Ok'),
        },
      },
      blockChildren: {
        ok: [paragraph('o1', 'survives')],
      },
      blockChildrenErrors: {
        boom: 500,
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['missing', 'ok'],
      visibility: 'shared',
    });
    const byId = Object.fromEntries(items.map((i) => [i.notionPageId, i]));
    expect(byId.missing?.status).toBe('fail');
    expect(byId.ok?.status).toBe('success');
    const pages = await query<{ title: string }>('SELECT title FROM pages');
    expect(pages.rows.map((r) => r.title)).toEqual(['Ok']);
  });

  it('fills an empty live stub on retry instead of reporting already_imported', async () => {
    await query(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, visibility, notion_page_id)
       VALUES ('Once', '', '', 1, 'standalone', $1, 'shared', 'once')`,
      [userId],
    );
    const client = await start({
      validToken: TOKEN,
      pages: {
        once: {
          object: 'page',
          id: 'once',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Once'),
        },
      },
      blockChildren: { once: [paragraph('x', 'filled on retry')] },
    });

    const items = await runNotionImport({ userId, client, pageIds: ['once'], visibility: 'shared' });
    expect(items[0]?.status).toBe('success');
    const rows = await query<{ n: string; body_html: string }>(
      `SELECT count(*)::text AS n, max(body_html) AS body_html FROM pages WHERE notion_page_id = 'once'`,
    );
    expect(rows.rows[0]!.n).toBe('1');
    expect(rows.rows[0]!.body_html).toContain('filled on retry');
  });

  it('does not leave selected children pointing at a parent whose content failed', async () => {
    const dest = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, space_key, visibility)
       VALUES ('Dest', '<p>d</p>', 'd', 1, 'standalone', $1, 'wiki', 'private') RETURNING id`,
      [userId],
    );
    const destId = dest.rows[0]!.id;
    const client = await start({
      validToken: TOKEN,
      pages: {
        parent: {
          object: 'page',
          id: 'parent',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Parent'),
        },
        child: {
          object: 'page',
          id: 'child',
          parent: { type: 'page_id', page_id: 'parent' },
          properties: titleProp('Child'),
        },
      },
      blockChildren: {
        child: [paragraph('c1', 'child body')],
      },
      blockChildrenErrors: { parent: 500 },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['parent', 'child'],
      spaceKey: 'wiki',
      parentId: String(destId),
      visibility: 'private',
    });
    const byId = Object.fromEntries(items.map((i) => [i.notionPageId, i]));
    expect(byId.parent?.status).toBe('fail');
    expect(byId.child?.status).toBe('success');

    const child = await query<{ parent_id: string | null; path: string | null }>(
      `SELECT parent_id, path FROM pages WHERE notion_page_id = 'child'`,
    );
    expect(child.rows[0]!.parent_id).toBe(String(destId));
    expect(child.rows[0]!.path).toBe(`/${destId}/${byId.child!.localPageId}`);
    const leftoverParent = await query(`SELECT 1 FROM pages WHERE notion_page_id = 'parent'`);
    expect(leftoverParent.rows).toHaveLength(0);
  });

  it('on retry, re-nests an already_imported child under a parent that failed last run', async () => {
    const dest = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, space_key, visibility, path)
       VALUES ('Dest', '<p>d</p>', 'd', 1, 'standalone', $1, 'wiki', 'private', '/0') RETURNING id`,
      [userId],
    );
    const destId = dest.rows[0]!.id;
    const pages = {
      parent: {
        object: 'page',
        id: 'parent',
        parent: { type: 'workspace', workspace: true },
        properties: titleProp('Parent'),
      },
      child: {
        object: 'page',
        id: 'child',
        parent: { type: 'page_id', page_id: 'parent' },
        properties: titleProp('Child'),
      },
    };
    const first = await start({
      validToken: TOKEN,
      pages,
      blockChildren: {
        child: [paragraph('c1', 'child body')],
      },
      blockChildrenErrors: { parent: 500 },
    });
    await runNotionImport({
      userId,
      client: first,
      pageIds: ['parent', 'child'],
      spaceKey: 'wiki',
      parentId: String(destId),
      visibility: 'private',
    });
    await server.close();

    const client = await start({
      validToken: TOKEN,
      pages,
      blockChildren: {
        parent: [paragraph('p1', 'parent body')],
        child: [paragraph('c1', 'child body')],
      },
    });
    const second = await runNotionImport({
      userId,
      client,
      pageIds: ['parent', 'child'],
      spaceKey: 'wiki',
      parentId: String(destId),
      visibility: 'private',
    });
    const byId = Object.fromEntries(second.map((i) => [i.notionPageId, i]));
    expect(byId.parent?.status).toBe('success');
    expect(byId.child?.status).toBe('already_imported');
    const child = await query<{ parent_id: string | null }>(
      `SELECT parent_id FROM pages WHERE notion_page_id = 'child'`,
    );
    expect(child.rows[0]!.parent_id).toBe(String(byId.parent!.localPageId));
  });

  it('does not un-nest an already_imported child when the subset reimport omits the parent', async () => {
    const dest = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, space_key, visibility, path)
       VALUES ('Dest', '<p>d</p>', 'd', 1, 'standalone', $1, 'wiki', 'private', '/0') RETURNING id`,
      [userId],
    );
    const destId = dest.rows[0]!.id;
    const pages = {
      parent: {
        object: 'page',
        id: 'parent',
        parent: { type: 'workspace', workspace: true },
        properties: titleProp('Parent'),
      },
      child: {
        object: 'page',
        id: 'child',
        parent: { type: 'page_id', page_id: 'parent' },
        properties: titleProp('Child'),
      },
    };
    const first = await start({
      validToken: TOKEN,
      pages,
      blockChildren: {
        parent: [paragraph('p1', 'parent body')],
        child: [paragraph('c1', 'child body')],
      },
    });
    const imported = await runNotionImport({
      userId,
      client: first,
      pageIds: ['parent', 'child'],
      spaceKey: 'wiki',
      parentId: String(destId),
      visibility: 'private',
    });
    const parentLocalId = imported.find((i) => i.notionPageId === 'parent')!.localPageId;
    await server.close();

    const otherDest = await query<{ id: number }>(
      `INSERT INTO pages (title, body_html, body_text, version, source, created_by_user_id, space_key, visibility, path)
       VALUES ('Other', '<p>o</p>', 'o', 1, 'standalone', $1, 'wiki', 'private', '/1') RETURNING id`,
      [userId],
    );
    const client = await start({
      validToken: TOKEN,
      pages,
      blockChildren: {
        child: [paragraph('c1', 'child body')],
      },
    });
    const second = await runNotionImport({
      userId,
      client,
      pageIds: ['child'],
      spaceKey: 'wiki',
      parentId: String(otherDest.rows[0]!.id),
      visibility: 'private',
    });
    expect(second[0]).toMatchObject({ notionPageId: 'child', status: 'already_imported' });
    const child = await query<{ parent_id: string | null }>(
      `SELECT parent_id FROM pages WHERE notion_page_id = 'child'`,
    );
    expect(child.rows[0]!.parent_id).toBe(String(parentLocalId));
    expect(child.rows[0]!.parent_id).not.toBe(String(otherDest.rows[0]!.id));
  });

  it('rebuilds descendant paths from canonical parent links when cached paths are stale', async () => {
    const pages = {
      root: {
        object: 'page', id: 'root',
        parent: { type: 'workspace', workspace: true },
        properties: titleProp('Root'),
      },
      child: {
        object: 'page', id: 'child',
        parent: { type: 'page_id', page_id: 'root' },
        properties: titleProp('Child'),
      },
    };
    const first = await start({
      validToken: TOKEN,
      pages,
      blockChildren: {
        root: [paragraph('root-body', 'root body')],
        child: [paragraph('child-body', 'child body')],
      },
    });
    const imported = await runNotionImport({
      userId, client: first, pageIds: ['root', 'child'], visibility: 'private',
    });
    const rootId = imported.find((item) => item.notionPageId === 'root')!.localPageId!;
    const childId = imported.find((item) => item.notionPageId === 'child')!.localPageId!;
    await query('UPDATE pages SET path = $2 WHERE id = $1', [rootId, '/stale/root/cache']);
    await query('UPDATE pages SET path = $2 WHERE id = $1', [childId, '/not-rooted-at-the-parent']);
    await server.close();

    const second = await start({
      validToken: TOKEN,
      pages: {
        ...pages,
        root: { ...pages.root, parent: { type: 'page_id', page_id: 'new-parent' } },
        'new-parent': {
          object: 'page', id: 'new-parent',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('New parent'),
        },
      },
      blockChildren: {
        root: [paragraph('root-body', 'root body')],
        child: [paragraph('child-body', 'child body')],
        'new-parent': [paragraph('new-parent-body', 'new parent body')],
      },
    });
    const repeated = await runNotionImport({
      userId,
      client: second,
      pageIds: ['new-parent', 'root', 'child'],
      visibility: 'private',
    });
    const newParentId = repeated.find((item) => item.notionPageId === 'new-parent')!.localPageId!;
    const rows = await query<{ id: number; parent_id: string | null; path: string; depth: number }>(
      'SELECT id, parent_id, path, depth FROM pages WHERE id = ANY($1::integer[]) ORDER BY id',
      [[rootId, childId]],
    );
    expect(rows.rows).toEqual([
      { id: rootId, parent_id: String(newParentId), path: `/${newParentId}/${rootId}`, depth: 1 },
      { id: childId, parent_id: String(rootId), path: `/${newParentId}/${rootId}/${childId}`, depth: 2 },
    ].sort((left, right) => left.id - right.id));
  });

  it('refuses to reparent an imported page beneath its own canonical subtree', async () => {
    const pages = {
      parent: {
        object: 'page', id: 'cycle-parent',
        parent: { type: 'workspace', workspace: true },
        properties: titleProp('Cycle parent'),
      },
      child: {
        object: 'page', id: 'cycle-child',
        parent: { type: 'page_id', page_id: 'cycle-parent' },
        properties: titleProp('Cycle child'),
      },
    };
    const first = await start({
      validToken: TOKEN,
      pages: { 'cycle-parent': pages.parent, 'cycle-child': pages.child },
      blockChildren: {
        'cycle-parent': [paragraph('cp', 'parent')],
        'cycle-child': [paragraph('cc', 'child')],
      },
    });
    const initial = await runNotionImport({
      userId, client: first, pageIds: ['cycle-parent', 'cycle-child'], visibility: 'private',
    });
    const parentId = initial.find((item) => item.notionPageId === 'cycle-parent')!.localPageId!;
    const childId = initial.find((item) => item.notionPageId === 'cycle-child')!.localPageId!;
    await server.close();

    const second = await start({
      validToken: TOKEN,
      pages: {
        'cycle-parent': {
          ...pages.parent,
          parent: { type: 'page_id', page_id: 'cycle-child' },
        },
        'cycle-child': pages.child,
      },
      blockChildren: {
        'cycle-parent': [paragraph('cp', 'parent')],
        'cycle-child': [paragraph('cc', 'child')],
      },
    });
    const result = await runNotionImport({
      userId, client: second, pageIds: ['cycle-parent', 'cycle-child'], visibility: 'private',
    });
    expect(result.find((item) => item.notionPageId === 'cycle-parent')).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/own subtree/i),
    });
    expect((await query<{ parent_id: string | null; path: string }>(
      'SELECT parent_id, path FROM pages WHERE id = $1',
      [parentId],
    )).rows[0]).toEqual({ parent_id: null, path: `/${parentId}` });
    expect((await query<{ parent_id: string | null }>(
      'SELECT parent_id FROM pages WHERE id = $1',
      [childId],
    )).rows[0]!.parent_id).toBe(String(parentId));
  });

  it('lets a frozen descendant block the whole imported component reparent', async () => {
    const originalPages = {
      'frozen-root': {
        object: 'page', id: 'frozen-root',
        parent: { type: 'workspace', workspace: true },
        properties: titleProp('Frozen root'),
      },
      'frozen-child': {
        object: 'page', id: 'frozen-child',
        parent: { type: 'page_id', page_id: 'frozen-root' },
        properties: titleProp('Frozen child'),
      },
    };
    const first = await start({
      validToken: TOKEN,
      pages: originalPages,
      blockChildren: {
        'frozen-root': [paragraph('fr', 'root')],
        'frozen-child': [paragraph('fc', 'child')],
      },
    });
    const initial = await runNotionImport({
      userId, client: first, pageIds: ['frozen-root', 'frozen-child'], visibility: 'private',
    });
    const rootId = initial.find((item) => item.notionPageId === 'frozen-root')!.localPageId!;
    const childId = initial.find((item) => item.notionPageId === 'frozen-child')!.localPageId!;
    await freezeImportedPage(childId);
    await server.close();

    const second = await start({
      validToken: TOKEN,
      pages: {
        ...originalPages,
        'frozen-root': {
          ...originalPages['frozen-root'],
          parent: { type: 'page_id', page_id: 'fresh-parent' },
        },
        'fresh-parent': {
          object: 'page', id: 'fresh-parent',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Fresh parent'),
        },
      },
      blockChildren: {
        'frozen-root': [paragraph('fr', 'root')],
        'frozen-child': [paragraph('fc', 'child')],
        'fresh-parent': [paragraph('fp', 'new parent')],
      },
    });
    const result = await runNotionImport({
      userId,
      client: second,
      pageIds: ['fresh-parent', 'frozen-root', 'frozen-child'],
      visibility: 'private',
    });
    expect(result.find((item) => item.notionPageId === 'frozen-root')?.status).toBe('fail');
    expect((await query<{ parent_id: string | null; path: string }>(
      'SELECT parent_id, path FROM pages WHERE id = $1',
      [rootId],
    )).rows[0]).toEqual({ parent_id: null, path: `/${rootId}` });
  });

  it('uses source-aware Confluence parent keys while deriving canonical paths', async () => {
    await query(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId]);
    const ancestor = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id, visibility, path)
       VALUES ('Local ancestor', '<p>a</p>', 'a', 1, 'standalone', $1, 'shared', '/stale')
       RETURNING id`,
      [userId],
    );
    const synced = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, confluence_id, parent_id,
          space_key, visibility, path)
       VALUES ('Synced parent', '<p>p</p>', 'p', 1, 'confluence', 'conf-parent-key',
               $1, 'SYNC', 'shared', '/also-stale')
       RETURNING id`,
      [String(ancestor.rows[0]!.id)],
    );
    const client = await start({
      validToken: TOKEN,
      pages: {
        'under-confluence': {
          object: 'page', id: 'under-confluence',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Under Confluence'),
        },
      },
      blockChildren: {
        'under-confluence': [paragraph('uc', 'body')],
      },
    });
    const result = await runNotionImport({
      userId,
      client,
      pageIds: ['under-confluence'],
      parentId: String(synced.rows[0]!.id),
      visibility: 'shared',
    });
    const importedId = result[0]!.localPageId!;
    expect((await query<{ parent_id: string | null; path: string; depth: number }>(
      'SELECT parent_id, path, depth FROM pages WHERE id = $1',
      [importedId],
    )).rows[0]).toEqual({
      parent_id: 'conf-parent-key',
      path: `/${ancestor.rows[0]!.id}/${synced.rows[0]!.id}/${importedId}`,
      depth: 2,
    });
  });

  it('refuses a destination key that ambiguously names local and Confluence parents', async () => {
    const localParent = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id, visibility)
       VALUES ('Local collision', '<p>l</p>', 'l', 1, 'standalone', $1, 'shared')
       RETURNING id`,
      [userId],
    );
    await query(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, confluence_id, space_key, visibility)
       VALUES ('Confluence collision', '<p>c</p>', 'c', 1, 'confluence', $1, 'SYNC', 'shared')`,
      [String(localParent.rows[0]!.id)],
    );
    const client = await start({
      validToken: TOKEN,
      pages: {
        ambiguous: {
          object: 'page', id: 'ambiguous',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Ambiguous child'),
        },
      },
      blockChildren: { ambiguous: [paragraph('ambiguous-body', 'body')] },
    });
    const result = await runNotionImport({
      userId,
      client,
      pageIds: ['ambiguous'],
      parentId: String(localParent.rows[0]!.id),
      visibility: 'shared',
    });
    expect(result[0]).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/destination parent|ambiguous/i),
    });
    expect((await query(
      `SELECT 1 FROM pages WHERE notion_page_id = 'ambiguous'`,
    )).rows).toEqual([]);
  });

  it('rechecks the destination parent after remote reads before an overwrite move', async () => {
    const destination = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id, visibility, path)
       VALUES ('Racing parent', '<p>p</p>', 'p', 1, 'standalone', $1, 'private', '/racing')
       RETURNING id`,
      [userId],
    );
    const original = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id,
          visibility, notion_page_id, path)
       VALUES ('Original', '<p>original</p>', 'original', 1, 'standalone', $1,
               'private', 'parent-race', '/original')
       RETURNING id`,
      [userId],
    );
    const client = await start({
      validToken: TOKEN,
      lookupDelayMs: 150,
      pages: {
        'parent-race': {
          object: 'page', id: 'parent-race',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Remote replacement'),
        },
      },
      blockChildren: {
        'parent-race': [paragraph('race-body', 'replacement')],
      },
    });
    const importing = runNotionImport({
      userId,
      client,
      pageIds: ['parent-race'],
      parentId: String(destination.rows[0]!.id),
      visibility: 'private',
      overwriteExisting: true,
    });
    await waitForNotionRequest('/v1/blocks/parent-race/children');
    await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [destination.rows[0]!.id]);
    const result = await importing;
    expect(result[0]?.status).toBe('fail');
    expect((await query<{ parent_id: string | null; body_text: string }>(
      'SELECT parent_id, body_text FROM pages WHERE id = $1',
      [original.rows[0]!.id],
    )).rows[0]).toEqual({ parent_id: null, body_text: 'original' });
  });

  it('holds the hierarchy fence through an overwrite reparent against a concurrent parent mutation', async () => {
    const destination = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id, visibility, path)
       VALUES ('Fence parent', '<p>p</p>', 'p', 1, 'standalone', $1, 'private', '/fence-parent')
       RETURNING id`,
      [userId],
    );
    const original = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id,
          visibility, notion_page_id, path)
       VALUES ('Fence child', '<p>old</p>', 'old', 1, 'standalone', $1,
               'private', 'fenced-reparent', '/fence-child')
       RETURNING id`,
      [userId],
    );
    const client = await start({
      validToken: TOKEN,
      pages: {
        'fenced-reparent': {
          object: 'page', id: 'fenced-reparent',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Fence child updated'),
        },
      },
      blockChildren: {
        'fenced-reparent': [paragraph('fenced-body', 'updated')],
      },
    });
    const triggerLock = 276_002;
    const blocker = await getPool().connect();
    let blockerReleased = false;
    let importing: Promise<NotionImportItem[]> | undefined;
    let contender: Promise<void> | undefined;
    try {
      await blocker.query('SET statement_timeout = 0');
      await blocker.query('SELECT pg_advisory_lock($1)', [triggerLock]);
      const blockerPid = (await blocker.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0]!.pid;
      await query(`
        CREATE OR REPLACE FUNCTION test_pause_notion_reparent()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.id = ${original.rows[0]!.id}
             AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
            PERFORM pg_advisory_xact_lock(${triggerLock});
          END IF;
          RETURN NEW;
        END
        $$`);
      await query(`
        CREATE TRIGGER test_pause_notion_reparent
        BEFORE UPDATE OF parent_id ON pages
        FOR EACH ROW EXECUTE FUNCTION test_pause_notion_reparent()`);

      importing = runNotionImport({
        userId,
        client,
        pageIds: ['fenced-reparent'],
        parentId: String(destination.rows[0]!.id),
        visibility: 'private',
        overwriteExisting: true,
      });
      await expect.poll(async () => (await query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND NOT granted
              AND classid = 0 AND objid = $1 AND $2 = ANY(pg_blocking_pids(pid))
         ) AS waiting`,
        [triggerLock, blockerPid],
      )).rows[0]!.waiting).toBe(true);

      let contenderEntered = false;
      contender = withPageHierarchyWriteTransaction(async (writeClient) => {
        contenderEntered = true;
        await writeClient.query(
          `UPDATE pages SET title = 'Fence parent changed after reparent' WHERE id = $1`,
          [destination.rows[0]!.id],
        );
      });
      await setImmediate();
      expect(contenderEntered).toBe(false);

      await blocker.query('SELECT pg_advisory_unlock($1)', [triggerLock]);
      blockerReleased = true;
      const result = await importing;
      expect(result[0]?.status).toBe('success');
      await contender;
      expect(contenderEntered).toBe(true);
      expect((await query<{ parent_id: string | null; path: string }>(
        'SELECT parent_id, path FROM pages WHERE id = $1',
        [original.rows[0]!.id],
      )).rows[0]).toEqual({
        parent_id: String(destination.rows[0]!.id),
        path: `/${destination.rows[0]!.id}/${original.rows[0]!.id}`,
      });
    } finally {
      if (!blockerReleased) {
        await blocker.query('SELECT pg_advisory_unlock($1)', [triggerLock]).catch(() => undefined);
      }
      blocker.release();
      await Promise.allSettled([importing, contender].filter(
        (value): value is Promise<NotionImportItem[]> | Promise<void> => value !== undefined,
      ));
      await query('DROP TRIGGER IF EXISTS test_pause_notion_reparent ON pages');
      await query('DROP FUNCTION IF EXISTS test_pause_notion_reparent()');
    }
  });

  it('does not abort the run when getBlock for a block_id parent returns 500', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        ok: {
          object: 'page',
          id: 'ok',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Ok'),
        },
        nested: {
          object: 'page',
          id: 'nested',
          parent: { type: 'block_id', block_id: 'toggle-1' },
          properties: titleProp('Nested'),
        },
      },
      blockErrors: { 'toggle-1': 500 },
      blockChildren: {
        ok: [paragraph('o1', 'survives')],
        nested: [paragraph('n1', 'nested body')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['ok', 'nested'],
      visibility: 'shared',
    });
    const byId = Object.fromEntries(items.map((i) => [i.notionPageId, i]));
    expect(byId.ok?.status).toBe('success');
    expect(byId.nested?.status).toBe('success');
    const pages = await query<{ title: string }>('SELECT title FROM pages ORDER BY title');
    expect(pages.rows.map((r) => r.title)).toEqual(['Nested', 'Ok']);
  });

  it('fails the item when block children are 403 rather than importing an empty body', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        forbidden: {
          object: 'page',
          id: 'forbidden',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Forbidden'),
        },
      },
      blockChildrenErrors: { forbidden: 403 },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['forbidden'],
      visibility: 'shared',
    });
    expect(items[0]?.status).toBe('fail');
    const pages = await query(`SELECT 1 FROM pages WHERE notion_page_id = 'forbidden'`);
    expect(pages.rows).toHaveLength(0);
  });

  it('fails the item when an image download fails instead of succeeding with a broken img', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        pic: {
          object: 'page',
          id: 'pic',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Pic'),
        },
      },
      blockChildren: { pic: [] },
    });
    server.state.blockChildren = {
      pic: [
        {
          object: 'block',
          id: 'img-1',
          type: 'image',
          image: {
            type: 'file',
            file: { url: `${server.baseUrl}/files/missing.png` },
            caption: [{ type: 'text', plain_text: 'gone', text: { content: 'gone' } }],
          },
        },
      ],
    };

    const items = await runNotionImport({ userId, client, pageIds: ['pic'], visibility: 'shared' });
    expect(items[0]?.status).toBe('fail');
    const pages = await query(`SELECT 1 FROM pages WHERE notion_page_id = 'pic'`);
    expect(pages.rows).toHaveLength(0);
  });

  it('removes written attachment files when a later image download fails', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        pic: {
          object: 'page',
          id: 'pic',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Pic'),
        },
      },
      files: {
        '/files/one.png': { contentType: 'image/png', body: PNG },
      },
      blockChildren: { pic: [] },
    });
    server.state.blockChildren = {
      pic: [
        {
          object: 'block',
          id: 'img-ok',
          type: 'image',
          image: {
            type: 'file',
            file: { url: `${server.baseUrl}/files/one.png` },
            caption: [],
          },
        },
        {
          object: 'block',
          id: 'img-miss',
          type: 'image',
          image: {
            type: 'file',
            file: { url: `${server.baseUrl}/files/missing.png` },
            caption: [],
          },
        },
      ],
    };

    const items = await runNotionImport({ userId, client, pageIds: ['pic'], visibility: 'shared' });
    expect(items[0]?.status).toBe('fail');
    const pages = await query(`SELECT 1 FROM pages WHERE notion_page_id = 'pic'`);
    expect(pages.rows).toHaveLength(0);
    const localRoot = join(attachmentsDir, 'local');
    const leftovers = await readdir(localRoot).catch(() => [] as string[]);
    expect(leftovers).toEqual([]);
  });

  it('keeps the winner page and files when a same-page waiter has a media failure', async () => {
    const dashedId = 'a1b2c3d4-e5f6-47a8-90bc-def123456789';
    const undashedId = 'a1b2c3d4e5f647a890bcdef123456789';
    const winnerFileRequested = Promise.withResolvers<void>();
    const releaseWinnerFile = Promise.withResolvers<void>();
    const winnerServer = await startFakeNotionServer({
      validToken: TOKEN,
      pages: {
        [dashedId]: {
          object: 'page',
          id: dashedId,
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Concurrent'),
        },
      },
      blockChildren: { [dashedId]: [] },
      files: {
        '/files/winner.png': { contentType: 'image/png', body: PNG },
      },
      beforeFileResponse: async () => {
        winnerFileRequested.resolve();
        await releaseWinnerFile.promise;
      },
    });
    server = winnerServer;
    const waiterServer = await startFakeNotionServer({
      validToken: TOKEN,
      pages: {
        [undashedId]: {
          object: 'page',
          id: undashedId,
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Concurrent'),
        },
      },
      blockChildren: { [undashedId]: [] },
    });
    winnerServer.state.blockChildren = {
      [dashedId]: [{
        object: 'block',
        id: 'winner-image',
        type: 'image',
        image: {
          type: 'file',
          file: { url: `${winnerServer.baseUrl}/files/winner.png` },
          caption: [],
        },
      }],
    };
    waiterServer.state.blockChildren = {
      [undashedId]: [{
        object: 'block',
        id: 'waiter-image',
        type: 'image',
        image: {
          type: 'file',
          file: { url: `${waiterServer.baseUrl}/files/missing.png` },
          caption: [],
        },
      }],
    };

    const winnerClient = new NotionClient(TOKEN, { baseUrl: winnerServer.baseUrl });
    const waiterClient = new NotionClient(TOKEN, { baseUrl: waiterServer.baseUrl });
    try {
      const winner = runNotionImport({
        userId,
        client: winnerClient,
        pageIds: [dashedId],
        visibility: 'shared',
      });
      await winnerFileRequested.promise;

      const waiter = runNotionImport({
        userId,
        client: waiterClient,
        pageIds: [undashedId],
        visibility: 'shared',
      });
      let waiterSettled = false;
      void waiter.then(
        () => { waiterSettled = true; },
        () => { waiterSettled = true; },
      );
      const lockId = notionImportLockId(undashedId);
      let waiterWasBlocked = false;
      while (!waiterSettled) {
        const waiting = await query(
          `SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid::bigint = $1
              AND objid::bigint = ANY($2::bigint[])
              AND granted = FALSE`,
          [NOTION_IMPORT_LOCK_KEY, [lockId >>> 0, notionImportLockId(`notion-import-owner:${userId}`) >>> 0]],
        );
        if (waiting.rows.length > 0) {
          waiterWasBlocked = true;
          break;
        }
        await setImmediate();
      }

      releaseWinnerFile.resolve();
      const [winnerItems, waiterItems] = await Promise.all([winner, waiter]);

      expect(waiterWasBlocked).toBe(true);
      expect(winnerItems[0]).toMatchObject({ notionPageId: dashedId, status: 'success' });
      expect(waiterItems[0]).toMatchObject({
        notionPageId: undashedId,
        status: 'already_imported',
        localPageId: winnerItems[0]?.localPageId,
      });
      const pages = await query<{ id: number; body_html: string }>(
        `SELECT id, body_html FROM pages
          WHERE lower(replace(notion_page_id, '-', '')) = $1`,
        [undashedId],
      );
      expect(pages.rows).toHaveLength(1);
      expect(pages.rows[0]!.body_html).toContain('/api/local-attachments/');
      const files = await query<{ filename: string }>(
        'SELECT filename FROM local_attachments WHERE page_id = $1',
        [pages.rows[0]!.id],
      );
      expect(files.rows).toHaveLength(1);
      expect(readFileSync(join(attachmentsDir, 'local', String(pages.rows[0]!.id), files.rows[0]!.filename)))
        .toEqual(PNG);
    } finally {
      releaseWinnerFile.resolve();
      await waiterServer.close();
    }
  });

  it('keeps every selected page locked between allocation and attachment preparation', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const allocationGateKey = 1_420_098;
    const client = await start({
      validToken: TOKEN,
      pages: {
        [firstId]: {
          object: 'page',
          id: firstId,
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('First'),
        },
        [secondId]: {
          object: 'page',
          id: secondId,
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Second'),
        },
      },
      blockChildren: {
        [firstId]: [paragraph('first-body', 'First body')],
        [secondId]: [paragraph('second-body', 'Second body')],
      },
    });
    const gateClient = await getPool().connect();
    let gateHeld = false;
    let winner: Promise<NotionImportItem[]> | undefined;
    let waiter: Promise<NotionImportItem[]> | undefined;
    try {
      await gateClient.query('SELECT pg_advisory_lock($1)', [allocationGateKey]);
      gateHeld = true;
      await query(`
        CREATE OR REPLACE FUNCTION delay_second_notion_allocation() RETURNS trigger AS $$
        BEGIN
          IF NEW.notion_page_id = '${secondId}' AND NEW.body_html = '' THEN
            PERFORM pg_advisory_xact_lock(${allocationGateKey});
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await query(`
        CREATE TRIGGER delay_second_notion_allocation
        BEFORE INSERT ON pages
        FOR EACH ROW EXECUTE FUNCTION delay_second_notion_allocation()
      `);

      winner = runNotionImport({
        userId,
        client,
        pageIds: [firstId, secondId],
        visibility: 'shared',
      });
      let secondAllocationBlocked = false;
      while (!secondAllocationBlocked) {
        const waiting = await query(
          `SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid::bigint = 0
              AND objid::bigint = $1
              AND granted = FALSE`,
          [allocationGateKey],
        );
        secondAllocationBlocked = waiting.rows.length > 0;
        if (!secondAllocationBlocked) await setImmediate();
      }

      const firstPlaceholder = await query(
        'SELECT 1 FROM pages WHERE notion_page_id = $1 AND body_html = $2',
        [firstId, ''],
      );
      expect(firstPlaceholder.rows).toHaveLength(1);

      waiter = runNotionImport({
        userId,
        client,
        pageIds: [firstId],
        visibility: 'shared',
      });
      let waiterSettled = false;
      void waiter.then(
        () => { waiterSettled = true; },
        () => { waiterSettled = true; },
      );
      let waiterBlockedOnFirstPage = false;
      while (!waiterSettled && !waiterBlockedOnFirstPage) {
        const waiting = await query(
          `SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid::bigint = $1
              AND objid::bigint = ANY($2::bigint[])
              AND granted = FALSE`,
          [NOTION_IMPORT_LOCK_KEY, [notionImportLockId(firstId) >>> 0, notionImportLockId(`notion-import-owner:${userId}`) >>> 0]],
        );
        waiterBlockedOnFirstPage = waiting.rows.length > 0;
        if (!waiterSettled && !waiterBlockedOnFirstPage) await setImmediate();
      }

      expect(waiterSettled).toBe(false);
      expect(waiterBlockedOnFirstPage).toBe(true);
      await gateClient.query('SELECT pg_advisory_unlock($1)', [allocationGateKey]);
      gateHeld = false;

      const [winnerItems, waiterItems] = await Promise.all([winner, waiter]);
      expect(winnerItems.every((item) => item.status === 'success')).toBe(true);
      expect(waiterItems[0]).toMatchObject({
        notionPageId: firstId,
        status: 'already_imported',
        localPageId: winnerItems[0]?.localPageId,
      });
    } finally {
      if (gateHeld) {
        await gateClient.query('SELECT pg_advisory_unlock($1)', [allocationGateKey]);
      }
      await Promise.allSettled([winner, waiter].filter((run): run is Promise<NotionImportItem[]> => Boolean(run)));
      await query('DROP TRIGGER IF EXISTS delay_second_notion_allocation ON pages');
      await query('DROP FUNCTION IF EXISTS delay_second_notion_allocation()');
      gateClient.release();
    }
  });

  it('does not let a same-page waiter return before the final mention rewrite commits', async () => {
    const targetId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const hostId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const rewriteGateKey = 1_420_099;
    const client = await start({
      validToken: TOKEN,
      pages: {
        [hostId]: {
          object: 'page',
          id: hostId,
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Host'),
        },
        [targetId]: {
          object: 'page',
          id: targetId,
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Target'),
        },
      },
      blockChildren: {
        [hostId]: [{
          object: 'block',
          id: 'forward-mention',
          type: 'paragraph',
          paragraph: {
            rich_text: [{
              type: 'mention',
              mention: { type: 'page', page: { id: targetId } },
              plain_text: 'Target',
              href: `https://www.notion.so/${targetId.replace(/-/g, '')}`,
            }],
          },
        }],
        [targetId]: [paragraph('target-body', 'Target body')],
      },
    });
    const gateClient = await getPool().connect();
    let gateHeld = false;
    let winner: Promise<NotionImportItem[]> | undefined;
    let waiter: Promise<NotionImportItem[]> | undefined;
    try {
      await gateClient.query('SELECT pg_advisory_lock($1)', [rewriteGateKey]);
      gateHeld = true;
      await query(`
        CREATE OR REPLACE FUNCTION delay_notion_final_rewrite() RETURNS trigger AS $$
        BEGIN
          IF NEW.notion_page_id = '${hostId}' AND NEW.body_html LIKE '%/pages/%' THEN
            PERFORM pg_advisory_xact_lock(${rewriteGateKey});
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await query(`
        CREATE TRIGGER delay_notion_final_rewrite
        BEFORE UPDATE OF body_html ON pages
        FOR EACH ROW EXECUTE FUNCTION delay_notion_final_rewrite()
      `);

      winner = runNotionImport({
        userId,
        client,
        pageIds: [hostId, targetId],
        visibility: 'shared',
      });
      let finalRewriteBlocked = false;
      while (!finalRewriteBlocked) {
        const waiting = await query(
          `SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid::bigint = 0
              AND objid::bigint = $1
              AND granted = FALSE`,
          [rewriteGateKey],
        );
        finalRewriteBlocked = waiting.rows.length > 0;
        if (!finalRewriteBlocked) await setImmediate();
      }

      waiter = runNotionImport({
        userId,
        client,
        pageIds: [hostId],
        visibility: 'shared',
      });
      let waiterSettled = false;
      void waiter.then(
        () => { waiterSettled = true; },
        () => { waiterSettled = true; },
      );
      let waiterBlockedOnPageLock = false;
      while (!waiterSettled && !waiterBlockedOnPageLock) {
        const waiting = await query(
          `SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid::bigint = $1
              AND objid::bigint = ANY($2::bigint[])
              AND granted = FALSE`,
          [NOTION_IMPORT_LOCK_KEY, [notionImportLockId(hostId) >>> 0, notionImportLockId(`notion-import-owner:${userId}`) >>> 0]],
        );
        waiterBlockedOnPageLock = waiting.rows.length > 0;
        if (!waiterSettled && !waiterBlockedOnPageLock) await setImmediate();
      }

      expect(waiterSettled).toBe(false);
      expect(waiterBlockedOnPageLock).toBe(true);
      await gateClient.query('SELECT pg_advisory_unlock($1)', [rewriteGateKey]);
      gateHeld = false;

      const [winnerItems, waiterItems] = await Promise.all([winner, waiter]);
      expect(winnerItems.every((item) => item.status === 'success')).toBe(true);
      expect(waiterItems[0]).toMatchObject({
        notionPageId: hostId,
        status: 'already_imported',
        localPageId: winnerItems[0]?.localPageId,
      });
      const host = await query<{ body_html: string }>(
        'SELECT body_html FROM pages WHERE notion_page_id = $1',
        [hostId],
      );
      expect(host.rows[0]!.body_html).toContain(`/pages/${winnerItems[1]!.localPageId}`);
      expect(host.rows[0]!.body_html).not.toContain('notion.so');
    } finally {
      if (gateHeld) {
        await gateClient.query('SELECT pg_advisory_unlock($1)', [rewriteGateKey]);
      }
      await Promise.allSettled([winner, waiter].filter((run): run is Promise<NotionImportItem[]> => Boolean(run)));
      await query('DROP TRIGGER IF EXISTS delay_notion_final_rewrite ON pages');
      await query('DROP FUNCTION IF EXISTS delay_notion_final_rewrite()');
      gateClient.release();
    }
  });

  it('does not duplicate on a second run of the same Notion ids', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        once: {
          object: 'page',
          id: 'once',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Once'),
        },
      },
      blockChildren: { once: [paragraph('x', 'body')] },
    });

    const first = await runNotionImport({ userId, client, pageIds: ['once'], visibility: 'shared' });
    const second = await runNotionImport({ userId, client, pageIds: ['once'], visibility: 'shared' });
    expect(first[0]?.status).toBe('success');
    expect(second[0]?.status).toBe('already_imported');
    expect(second[0]?.localPageId).toBe(first[0]?.localPageId);
    const count = await query<{ n: string }>('SELECT count(*)::text AS n FROM pages WHERE notion_page_id = $1', ['once']);
    expect(count.rows[0]!.n).toBe('1');
  });

  it('does not publish attachment references in PostgreSQL before their files exist', async () => {
    const fileRequested = Promise.withResolvers<void>();
    const releaseFile = Promise.withResolvers<void>();
    const client = await start({
      validToken: TOKEN,
      pages: {
        ordered: {
          object: 'page',
          id: 'ordered',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Ordered'),
        },
      },
      files: {
        '/files/ordered.png': { contentType: 'image/png', body: PNG },
      },
      blockChildren: { ordered: [] },
      beforeFileResponse: async () => {
        fileRequested.resolve();
        await releaseFile.promise;
      },
    });
    const imageUrl = `${server.baseUrl}/files/ordered.png`;
    server.state.blockChildren = {
      ordered: [{
        object: 'block',
        id: 'img-ordered',
        type: 'image',
        image: {
          type: 'file',
          file: { url: imageUrl },
          caption: [],
        },
      }],
    };

    const importing = runNotionImport({
      userId,
      client,
      pageIds: ['ordered'],
      visibility: 'shared',
    });
    await fileRequested.promise;
    const inFlight = await query<{ body_html: string }>(
      'SELECT body_html FROM pages WHERE notion_page_id = $1',
      ['ordered'],
    );
    releaseFile.resolve();
    await importing;
    expect(inFlight.rows[0]!.body_html).not.toContain('/api/local-attachments/');
    const complete = await query<{ body_html: string }>(
      'SELECT body_html FROM pages WHERE notion_page_id = $1',
      ['ordered'],
    );
    expect(complete.rows[0]!.body_html).toContain('/api/local-attachments/');
  });

  it('refuses to reacquire a newer page revision after a read-only media download', async () => {
    const fileRequested = Promise.withResolvers<void>();
    const releaseFile = Promise.withResolvers<void>();
    const client = await start({
      validToken: TOKEN,
      pages: {
        fenced: {
          object: 'page',
          id: 'fenced',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Fenced'),
        },
      },
      files: {
        '/files/fenced.png': { contentType: 'image/png', body: PNG },
      },
      blockChildren: { fenced: [] },
      beforeFileResponse: async () => {
        fileRequested.resolve();
        await releaseFile.promise;
      },
    });
    const imageUrl = `${server.baseUrl}/files/fenced.png`;
    server.state.blockChildren = {
      fenced: [{
        object: 'block',
        id: 'img-fenced',
        type: 'image',
        image: {
          type: 'file',
          file: { url: imageUrl },
          caption: [],
        },
      }],
    };

    const importing = runNotionImport({
      userId,
      client,
      pageIds: ['fenced'],
      visibility: 'shared',
    });
    await fileRequested.promise;
    const page = await query<{ id: number }>(
      'SELECT id FROM pages WHERE notion_page_id = $1',
      ['fenced'],
    );
    await query(
      `UPDATE pages
          SET body_html = '<p>User edit</p>', body_text = 'User edit',
              content_revision = content_revision + 1
        WHERE id = $1`,
      [page.rows[0]!.id],
    );
    releaseFile.resolve();

    const result = await importing;
    expect(result[0]?.status).toBe('fail');
    const preserved = await query<{ body_html: string }>(
      'SELECT body_html FROM pages WHERE id = $1',
      [page.rows[0]!.id],
    );
    expect(preserved.rows[0]!.body_html).toBe('<p>User edit</p>');
    const attachments = await query(
      'SELECT 1 FROM local_attachments WHERE page_id = $1',
      [page.rows[0]!.id],
    );
    expect(attachments.rows).toHaveLength(0);
  });

  it('stores image bytes through the local attachment store', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        pic: {
          object: 'page',
          id: 'pic',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Pic'),
        },
      },
      files: {
        '/files/hero.png': { contentType: 'image/png', body: PNG },
      },
      blockChildren: { pic: [] },
    });
    const imageUrl = `${server.baseUrl}/files/hero.png`;
    server.state.blockChildren = {
      pic: [
        {
          object: 'block',
          id: 'img-1',
          type: 'image',
          image: {
            type: 'file',
            file: { url: imageUrl },
            caption: [{ type: 'text', plain_text: 'hero', text: { content: 'hero' } }],
          },
        },
      ],
    };

    const items = await runNotionImport({ userId, client, pageIds: ['pic'], visibility: 'shared' });
    expect(items[0]?.status).toBe('success');
    const page = await query<{ id: number; body_html: string }>('SELECT id, body_html FROM pages WHERE notion_page_id = $1', ['pic']);
    expect(page.rows[0]!.body_html).toContain(`/api/local-attachments/${page.rows[0]!.id}/`);
    const att = await query<{ filename: string }>('SELECT filename FROM local_attachments WHERE page_id = $1', [page.rows[0]!.id]);
    expect(att.rows).toHaveLength(1);
  });

  it('stores PDF bytes through the local attachment store', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        docs: {
          object: 'page',
          id: 'docs',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Docs'),
        },
      },
      files: {
        '/files/spec.pdf': { contentType: 'application/pdf', body: PDF },
      },
      blockChildren: { docs: [] },
    });
    const pdfUrl = `${server.baseUrl}/files/spec.pdf`;
    server.state.blockChildren = {
      docs: [
        {
          object: 'block',
          id: 'pdf-1',
          type: 'pdf',
          pdf: {
            type: 'file',
            file: { url: pdfUrl },
            caption: [{ type: 'text', plain_text: 'spec', text: { content: 'spec' } }],
          },
        },
        {
          object: 'block',
          id: 'file-1',
          type: 'file',
          file: {
            type: 'file',
            file: { url: pdfUrl },
            name: 'Handbook.pdf',
            caption: [],
          },
        },
      ],
    };

    const items = await runNotionImport({ userId, client, pageIds: ['docs'], visibility: 'shared' });
    expect(items[0]?.status).toBe('success');
    const page = await query<{ id: number; body_html: string }>(
      'SELECT id, body_html FROM pages WHERE notion_page_id = $1',
      ['docs'],
    );
    const pageId = page.rows[0]!.id;
    expect(page.rows[0]!.body_html).toContain(`/api/local-attachments/${pageId}/`);
    expect(page.rows[0]!.body_html).toContain('Handbook.pdf');
    expect(page.rows[0]!.body_html).not.toContain('<img');
    const att = await query<{ filename: string; content_type: string }>(
      'SELECT filename, content_type FROM local_attachments WHERE page_id = $1 ORDER BY filename',
      [pageId],
    );
    expect(att.rows).toHaveLength(2);
    expect(att.rows.every((row) => row.content_type === 'application/pdf')).toBe(true);
    expect(att.rows.every((row) => row.filename.toLowerCase().endsWith('.pdf'))).toBe(true);
    for (const row of att.rows) {
      expect(readFileSync(join(attachmentsDir, 'local', String(pageId), row.filename))).toEqual(PDF);
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'imports a page when ATTACHMENTS_DIR is not writable',
    async () => {
      await chmod(attachmentsDir, 0o555);
      try {
        const client = await start({
          validToken: TOKEN,
          pages: {
            home: {
              object: 'page',
              id: 'home',
              parent: { type: 'workspace', workspace: true },
              properties: titleProp('Knowledge Page'),
            },
          },
          files: {
            '/files/hero.png': { contentType: 'image/png', body: PNG },
          },
          blockChildren: { home: [] },
        });
        const imageUrl = `${server.baseUrl}/files/hero.png`;
        server.state.blockChildren = {
          home: [
            paragraph('intro', 'Text survives unavailable attachment storage'),
            {
              object: 'block',
              id: 'img-1',
              type: 'image',
              image: {
                type: 'file',
                file: { url: imageUrl },
                caption: [],
              },
            },
          ],
        };

        const items = await runNotionImport({
          userId, client, pageIds: ['home'], visibility: 'shared',
        });
        expect(items[0]?.status).toBe('success');
        expect(items[0]?.reason).toMatch(/EACCES|permission denied/i);
        const pages = await query<{ id: number; body_text: string }>(
          'SELECT id, body_text FROM pages WHERE notion_page_id = $1', ['home'],
        );
        expect(pages.rows).toHaveLength(1);
        expect(pages.rows[0]!.body_text).toContain('Text survives unavailable attachment storage');
        expect((await query(
          "SELECT id FROM page_write_intents WHERE kind = 'attachment.local.put' AND page_ids @> ARRAY[$1]::integer[]",
          [pages.rows[0]!.id],
        )).rows).toEqual([]);
      } finally {
        await chmod(attachmentsDir, 0o755);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)('does not publish a text-only fallback after attachment staging has begun', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        home: {
          object: 'page', id: 'home',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Retained original'),
        },
      },
      files: { '/files/hero.png': { contentType: 'image/png', body: PNG } },
      blockChildren: { home: [paragraph('original', 'Original authored text')] },
    });
    const initial = await runNotionImport({ userId, client, pageIds: ['home'], visibility: 'shared' });
    expect(initial[0]?.status).toBe('success');
    const pageId = initial[0]!.localPageId!;
    const pageDir = join(attachmentsDir, 'local', String(pageId));
    await mkdir(pageDir, { recursive: true });
    server.state.blockChildren = {
      home: [
        paragraph('replacement', 'Must not replace the original'),
        {
          object: 'block', id: 'image', type: 'image',
          image: { type: 'file', file: { url: `${server.baseUrl}/files/hero.png` }, caption: [] },
        },
      ],
    };
    const snapshot = await exportPostgresSnapshot();
    const blocker = (await snapshot.client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    let released = false;
    const importing = runNotionImport({
      userId, client, pageIds: ['home'], visibility: 'shared', overwriteExisting: true,
    });
    try {
      // The file has staged and the metadata/activation phase is waiting on
      // the real backup barrier. No guessed elapsed delay separates phases.
      await expect.poll(async () => (await query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND mode = 'ShareLock' AND NOT granted
              AND classid = 0 AND objid = $1 AND $2 = ANY(pg_blocking_pids(pid))
         ) AS waiting`,
        [ATTACHMENT_SNAPSHOT_LOCK_ID, blocker],
      )).rows[0]!.waiting).toBe(true);
      const stagedNames = await readdir(pageDir);
      expect(stagedNames.some((name) => name.endsWith('.stage'))).toBe(true);
      await chmod(pageDir, 0o555);
      await snapshot.close();
      released = true;

      const result = await importing;
      expect(result[0]?.status).toBe('fail');
      expect(result[0]?.reason).toMatch(/EACCES|permission denied/i);
      expect((await query<{ body_text: string }>('SELECT body_text FROM pages WHERE id = $1', [pageId])).rows)
        .toEqual([{ body_text: 'Original authored text' }]);
      expect((await query(
        "SELECT status FROM page_write_intents WHERE kind = 'attachment.local.put' AND page_ids @> ARRAY[$1]::integer[]",
        [pageId],
      )).rows).toEqual([{ status: 'pending' }]);
      expect(await readdir(pageDir)).toEqual(stagedNames);
    } finally {
      await chmod(pageDir, 0o755);
      if (!released) await snapshot.close();
      await importing.catch(() => undefined);
    }
  });

  it('keeps a failed placeholder cleanup pending after its SQL deletion commits', async () => {
      const firstFileRequested = Promise.withResolvers<void>();
      const releaseFirstFile = Promise.withResolvers<void>();
      const client = await start({
        validToken: TOKEN,
        pages: {
          'cleanup-failure': {
            object: 'page', id: 'cleanup-failure',
            parent: { type: 'workspace', workspace: true },
            properties: titleProp('Cleanup failure'),
          },
        },
        files: {
          '/files/first.png': { contentType: 'image/png', body: PNG },
        },
        beforeFileResponse: async (path) => {
          if (path === '/files/first.png') {
            firstFileRequested.resolve();
            await releaseFirstFile.promise;
          }
        },
        blockChildren: { 'cleanup-failure': [] },
      });
      server.state.blockChildren = {
        'cleanup-failure': [
          {
            object: 'block',
            id: 'first-image',
            type: 'image',
            image: {
              type: 'file',
              file: { url: `${server.baseUrl}/files/first.png` },
              caption: [],
            },
          },
          {
            object: 'block',
            id: 'missing-image',
            type: 'image',
            image: {
              type: 'file',
              file: { url: `${server.baseUrl}/files/missing.png` },
              caption: [],
            },
          },
        ],
      };

      const importing = runNotionImport({
        userId,
        client,
        pageIds: ['cleanup-failure'],
        visibility: 'private',
      });
      const localRoot = join(attachmentsDir, 'local');
      const displacedLocalRoot = join(attachmentsDir, 'local-before-cleanup-fault');
      let localRootDisplaced = false;
      let snapshot: ExportedBackupSnapshot | undefined;
      let snapshotReleased = false;
      try {
        await firstFileRequested.promise;
        const placeholder = await query<{ id: number }>(
          `SELECT id FROM pages
            WHERE notion_page_id = 'cleanup-failure' AND body_html = ''`,
        );
        const pageId = placeholder.rows[0]!.id;
        const pageDir = join(localRoot, String(pageId));
        await mkdir(pageDir, { recursive: true });
        await writeFile(join(pageDir, 'uncertain.bin'), Buffer.from('must remain for recovery'));
        await rename(localRoot, displacedLocalRoot);
        localRootDisplaced = true;
        await writeFile(localRoot, Buffer.from('not a directory'));
        const displacedPageDir = join(displacedLocalRoot, String(pageId));
        snapshot = await exportPostgresSnapshot();
        const blocker = (await snapshot.client.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;
        releaseFirstFile.resolve();
        await expect.poll(async () => (await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND mode = 'ShareLock' AND NOT granted
                AND classid = 0 AND objid = $1 AND $2 = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [ATTACHMENT_SNAPSHOT_LOCK_ID, blocker],
        )).rows[0]!.waiting).toBe(true);
        expect((await query('SELECT 1 FROM pages WHERE id = $1', [pageId])).rows)
          .toHaveLength(1);
        expect(readFileSync(join(displacedPageDir, 'uncertain.bin'))).toEqual(
          Buffer.from('must remain for recovery'),
        );
        await snapshot.close();
        snapshotReleased = true;

        const result = await importing;
        expect(result[0]?.status).toBe('fail');
        expect((await query('SELECT 1 FROM pages WHERE id = $1', [pageId])).rows).toEqual([]);
        const pending = await query<{
          id: string;
          status: string;
          effect_started_at: Date | null;
          effect_finished_at: Date | null;
        }>(
          `SELECT id, status, effect_started_at, effect_finished_at
             FROM page_write_intents
            WHERE kind = 'import.notion.placeholder.delete'
              AND page_ids @> ARRAY[$1]::integer[]`,
          [pageId],
        );
        expect(pending.rows).toEqual([{
          id: expect.any(String),
          status: 'pending',
          effect_started_at: expect.any(Date),
          effect_finished_at: null,
        }]);
        expect(readFileSync(join(displacedPageDir, 'uncertain.bin'))).toEqual(
          Buffer.from('must remain for recovery'),
        );
        await rm(localRoot, { force: true });
        await rename(displacedLocalRoot, localRoot);
        localRootDisplaced = false;
        const retiredRuntime = `retired-notion-${randomUUID()}`;
        await query(
          `INSERT INTO page_writer_runtimes
             (runtime_id, deployment_identity, fenced_at, fence_reason, fence_proof)
           VALUES ($1, '{"fixture":"terminated Notion writer"}'::jsonb, NOW(),
                   'Integration test simulates a terminated Notion writer',
                   '{"kind":"verified_local_termination"}'::jsonb)`,
          [retiredRuntime],
        );
        await query(
          `UPDATE page_write_intents
              SET runtime_id = $2
            WHERE id = $1 AND recovery_started_at IS NULL`,
          [pending.rows[0]!.id, retiredRuntime],
        );
        const recoveryAdmin = await query<{ id: string }>(
          `INSERT INTO users (username, email, password_hash, role)
           VALUES ($1, $2, 'x', 'admin') RETURNING id`,
          [`notion-recovery-${Date.now()}`, `notion-recovery-${Date.now()}@test`],
        );
        const rogue = await query<{ id: number }>(
          `INSERT INTO pages
             (title, body_html, body_text, version, source, created_by_user_id,
              visibility, parent_id)
           VALUES ('Unadmitted descendant', '<p>rogue</p>', 'rogue', 1,
                   'standalone', $1, 'private', $2)
           RETURNING id`,
          [userId, String(pageId)],
        );
        await expect(reconcilePageWriteIntent(pending.rows[0]!.id, {
          actorId: recoveryAdmin.rows[0]!.id,
          reason: 'Verify the complete Notion component before cleanup repair',
        })).rejects.toThrow(/outside its admitted component/i);
        expect((await query('SELECT 1 FROM pages WHERE id = $1', [rogue.rows[0]!.id])).rows)
          .toHaveLength(1);
        expect(readFileSync(join(pageDir, 'uncertain.bin'))).toEqual(
          Buffer.from('must remain for recovery'),
        );

        await query('DELETE FROM pages WHERE id = $1', [rogue.rows[0]!.id]);
        await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);
        await expect(reconcilePageWriteIntent(pending.rows[0]!.id, {
          actorId: recoveryAdmin.rows[0]!.id,
          reason: 'Recheck the original importer authority before cleanup repair',
        })).rejects.toThrow(/can no longer be changed by this account/i);
      } finally {
        releaseFirstFile.resolve();
        if (snapshot && !snapshotReleased) await snapshot.close().catch(() => undefined);
        if (localRootDisplaced) {
          await rm(localRoot, { recursive: true, force: true }).catch(() => undefined);
          await rename(displacedLocalRoot, localRoot).catch(() => undefined);
        }
        await importing.catch(() => undefined);
      }
    });

  it('never logs the integration token', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        quiet: {
          object: 'page',
          id: 'quiet',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Quiet'),
        },
      },
      blockChildren: { quiet: [paragraph('q', 'ok')] },
    });
    const { logger } = await import('../../../core/utils/logger.js');
    const lines: string[] = [];
    const handler = (obj: object) => lines.push(JSON.stringify(obj));
    logger.on('log', handler);
    try {
      await runNotionImport({ userId, client, pageIds: ['quiet'], visibility: 'shared' });
    } finally {
      logger.off('log', handler);
    }
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('extracts wiki page attributes (owner, verified, tags, category mapped to tags, status) and persists them', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        'wiki-page-1': {
          object: 'page',
          id: 'wiki-page-1',
          parent: { type: 'workspace', workspace: true },
          properties: {
            ...titleProp('System Architecture & Invariants'),
            Owner: {
              type: 'people',
              people: [{ object: 'user', name: 'Alice Engineer', person: { email: 'alice@example.com' } }],
            },
            Verification: {
              type: 'verification',
              verification: {
                state: 'verified',
                verified_by: { name: 'Security Lead' },
                date: { start: '2026-08-15' },
              },
            },
            Tags: {
              type: 'multi_select',
              multi_select: [{ name: 'core' }, { name: 'backend' }],
            },
            Category: {
              type: 'select',
              select: { name: 'Architecture' },
            },
            Status: {
              type: 'status',
              status: { name: 'Published' },
            },
            'Review Cycle': {
              type: 'select',
              select: { name: 'Quarterly' },
            },
          },
        },
      },
      blockChildren: {
        'wiki-page-1': [paragraph('w1', 'Core architectural principles.')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['wiki-page-1'],
      visibility: 'shared',
    });

    expect(items[0]?.status).toBe('success');

    const pageRow = await query<{
      title: string;
      author: string | null;
      verified_at: Date | null;
      labels: string[];
      body_html: string;
    }>(
      'SELECT title, author, verified_at, labels, body_html FROM pages WHERE notion_page_id = $1',
      ['wiki-page-1'],
    );

    expect(pageRow.rows).toHaveLength(1);
    const row = pageRow.rows[0]!;
    expect(row.title).toBe('System Architecture & Invariants');
    expect(row.author).toBe('Alice Engineer');
    expect(row.verified_at).not.toBeNull();
    // Category 'Architecture' mapped into tags along with 'core' and 'backend'
    expect(row.labels).toEqual(expect.arrayContaining(['core', 'backend', 'Architecture']));
    // Metadata callout block prepended with status and custom properties
    expect(row.body_html).toContain('notion-wiki-metadata');
    expect(row.body_html).toContain('Published');
    expect(row.body_html).toContain('Quarterly');
    expect(row.body_html).toContain('Core architectural principles.');
  });

  it('preserves multi-level hierarchy among sub-wiki pages when importing', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        'wiki-root': {
          object: 'page',
          id: 'wiki-root',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Engineering Wiki'),
        },
        'wiki-doc': {
          object: 'page',
          id: 'wiki-doc',
          parent: { type: 'page_id', page_id: 'wiki-root' },
          properties: titleProp('RFC 100'),
        },
        'wiki-subdoc': {
          object: 'page',
          id: 'wiki-subdoc',
          parent: { type: 'page_id', page_id: 'wiki-doc' },
          properties: titleProp('RFC 100 Appendix'),
        },
      },
      blockChildren: {
        'wiki-root': [paragraph('r1', 'Wiki Home')],
        'wiki-doc': [paragraph('d1', 'RFC Content')],
        'wiki-subdoc': [paragraph('sd1', 'Appendix Content')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['wiki-root', 'wiki-doc', 'wiki-subdoc'],
      visibility: 'shared',
    });

    expect(items.map((i) => i.status)).toEqual(['success', 'success', 'success']);

    const pages = await query<{ id: number; title: string; parent_id: string | null; depth: number; path: string }>(
      'SELECT id, title, parent_id, depth, path FROM pages WHERE notion_page_id IN ($1, $2, $3) ORDER BY depth ASC',
      ['wiki-root', 'wiki-doc', 'wiki-subdoc'],
    );

    expect(pages.rows).toHaveLength(3);
    const rootPage = pages.rows.find((p) => p.title === 'Engineering Wiki')!;
    const docPage = pages.rows.find((p) => p.title === 'RFC 100')!;
    const subDocPage = pages.rows.find((p) => p.title === 'RFC 100 Appendix')!;

    expect(rootPage.parent_id).toBeNull();
    expect(docPage.parent_id).toBe(String(rootPage.id));
    expect(subDocPage.parent_id).toBe(String(docPage.id));
    expect(subDocPage.depth).toBe(2);
    expect(subDocPage.path).toBe(`/${rootPage.id}/${docPage.id}/${subDocPage.id}`);
  });

  it('fetches sibling discovered page bodies concurrently', async () => {
    const children = ['a', 'b', 'c', 'd'];
    const client = await start({
      validToken: TOKEN,
      lookupDelayMs: 80,
      pages: {
        host: { object: 'page', id: 'host', properties: titleProp('Host') },
        ...Object.fromEntries(children.map((id) => [id, {
          object: 'page',
          id,
          parent: { type: 'page_id', page_id: 'host' },
          properties: titleProp(id.toUpperCase()),
        }])),
      },
      blockChildren: {
        host: children.map((id) => ({ id, type: 'child_page', child_page: { title: id } })),
        ...Object.fromEntries(children.map((id) => [id, [paragraph(`${id}-p`, id)]])),
      },
    });
    const items = await runNotionImport({
      userId, client, pageIds: ['host'], visibility: 'shared',
    });
    expect(items.filter((item) => item.status === 'success')).toHaveLength(5);
    // Sequential discovery peaked at 1 here and left the 3 req/s budget idle.
    expect(server.peakConcurrentLookups).toBeGreaterThan(1);
  });
});

describe('extractWikiPageProperties', () => {
  it('does not treat a non-owner people property as author', () => {
    const extracted = extractWikiPageProperties({
      properties: {
        Assignee: {
          type: 'people',
          people: [{ object: 'user', name: 'Bob Reviewer' }],
        },
      },
    });
    expect(extracted.author).toBeNull();
  });

  it('maps Owner people and ignores other people fields', () => {
    const extracted = extractWikiPageProperties({
      properties: {
        Assignee: {
          type: 'people',
          people: [{ object: 'user', name: 'Bob Reviewer' }],
        },
        Owner: {
          type: 'people',
          people: [{ object: 'user', name: 'Alice Engineer' }],
        },
      },
    });
    expect(extracted.author).toBe('Alice Engineer');
  });

  it('does not copy unrelated multi_select values into labels', () => {
    const extracted = extractWikiPageProperties({
      properties: {
        Stakeholders: {
          type: 'multi_select',
          multi_select: [{ name: 'Legal' }, { name: 'Security' }],
        },
        Tags: {
          type: 'multi_select',
          multi_select: [{ name: 'core' }],
        },
      },
    });
    expect(extracted.labels).toEqual(['core']);
  });

  it('leaves verifiedAt null when verification has no date', () => {
    const extracted = extractWikiPageProperties({
      properties: {
        Verification: {
          type: 'verification',
          verification: { state: 'verified' },
        },
      },
    });
    expect(extracted.verifiedAt).toBeNull();
  });

  it('leaves verifiedAt null for a checked verification checkbox', () => {
    const extracted = extractWikiPageProperties({
      properties: {
        Verified: { type: 'checkbox', checkbox: true },
      },
    });
    expect(extracted.verifiedAt).toBeNull();
  });

  it('keeps a verification timestamp when date.start is present', () => {
    const extracted = extractWikiPageProperties({
      properties: {
        Verification: {
          type: 'verification',
          verification: { state: 'verified', date: { start: '2026-08-15' } },
        },
      },
    });
    expect(extracted.verifiedAt?.toISOString().slice(0, 10)).toBe('2026-08-15');
  });

  it('dedupes tags and category case-insensitively, keeping first casing', () => {
    const extracted = extractWikiPageProperties({
      properties: {
        Tags: {
          type: 'multi_select',
          multi_select: [{ name: 'Architecture' }],
        },
        Category: {
          type: 'select',
          select: { name: 'architecture' },
        },
      },
    });
    expect(extracted.labels).toEqual(['Architecture']);
  });

  it('carries formula, files, people, and rich_text into custom properties as plain text', () => {
    const extracted = extractWikiPageProperties({
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Doc' }] },
        Summary: { type: 'rich_text', rich_text: [{ type: 'text', plain_text: 'Hello' }] },
        Score: { type: 'formula', formula: { type: 'number', number: 4 } },
        Attachments: { type: 'files', files: [{ name: 'spec.pdf' }] },
        Reviewer: { type: 'people', people: [{ name: 'Ada' }] },
      },
    });
    expect(extracted.customProperties).toEqual({
      Summary: 'Hello',
      Score: '4',
      Attachments: 'spec.pdf',
      Reviewer: 'Ada',
    });
  });
});



