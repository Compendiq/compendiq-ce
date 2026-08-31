import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
import { NOTION_IMPORT_LOCK_KEY } from '../../../core/db/advisory-locks.js';
import { NOTION_UNSUPPORTED_LABEL, type NotionImportItem } from '@compendiq/contracts';
import { startFakeNotionServer, type FakeNotionServer } from './__fixtures__/fake-notion-server.js';
import { NotionClient, setNotionApiBaseUrlForTests } from './notion-client.js';
import {
  NOTION_TABLE_DOWNGRADE_REASON,
  NOTION_TABLE_ROW_SKIP_REASON,
  extractWikiPageProperties,
  runNotionImport,
} from './notion-import-service.js';
import { notionImportLockId } from './notion-import-lock.js';

const dbAvailable = await isDbAvailable();
const TOKEN = 'secret_import_ntn_must_never_appear';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

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
    attachmentsDir = await mkdtemp(join(tmpdir(), 'notion-import-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
  });

  afterAll(async () => {
    setNotionApiBaseUrlForTests(null);
    await teardownTestDb();
    await rm(attachmentsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
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
    await server?.close();
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
    expect(items).toEqual([expect.objectContaining({ notionPageId: 'row-listed', status: 'success' })]);
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
    expect(pages.rows[0]!.body_html).toBe(CRM_LEAD);
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
    expect(container.body_html).toBe(`<p>Customer pipeline</p>${CRM_LEAD}`);
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
    expect(bodyHtml).toBe(
      '<p class="text-muted-foreground italic">Imported from the Notion wiki “Team Wiki”.</p>',
    );
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
              AND objid::bigint = $2
              AND granted = FALSE`,
          [NOTION_IMPORT_LOCK_KEY, lockId >>> 0],
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
              AND objid::bigint = $2
              AND granted = FALSE`,
          [NOTION_IMPORT_LOCK_KEY, notionImportLockId(firstId) >>> 0],
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
              AND objid::bigint = $2
              AND granted = FALSE`,
          [NOTION_IMPORT_LOCK_KEY, notionImportLockId(hostId) >>> 0],
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

describe('notion-import-service isolation', () => {
  it('never names api.notion.com or the retired notion page source', () => {
    const src = readFileSync(new URL('./notion-import-service.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // `queryDatabase` used to be forbidden here. It is deliberate now: `table`
    // mode flattens every row and inline `child_database` blocks enumerate
    // theirs, so the database query endpoint is a required call. What must stay
    // absent is any hardcoded api.notion.com host (every request goes through
    // the injected base URL) and the retired `pages.source = 'notion'` shape.
    expect(src).not.toMatch(/api\.notion\.com/);
    expect(src).not.toMatch(/pages\.source\s*=\s*['"]notion['"]/);
  });
});


