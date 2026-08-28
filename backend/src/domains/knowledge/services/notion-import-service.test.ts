import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { NOTION_UNSUPPORTED_LABEL } from '@compendiq/contracts';
import { startFakeNotionServer, type FakeNotionServer } from './__fixtures__/fake-notion-server.js';
import { NotionClient, setNotionApiBaseUrlForTests } from './notion-client.js';
import { extractWikiPageProperties, runNotionImport } from './notion-import-service.js';

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
    expect(server?.requests.some((r) => r.method === 'POST' && /\/v1\/databases\/.+\/query/.test(r.url))).toBe(false);
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

  it('skips databases in the payload without stubbing a page and continues the run', async () => {
    const client = await start({
      validToken: TOKEN,
      pages: {
        notes: {
          object: 'page',
          id: 'notes',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Notes'),
        },
      },
      databases: {
        crm: { object: 'database', id: 'crm', title: [{ type: 'text', plain_text: 'CRM' }] },
      },
      databaseQueryResults: {
        crm: [{ object: 'page', id: 'hidden-row', properties: titleProp('Should not appear') }],
      },
      blockChildren: {
        notes: [paragraph('n1', 'Just notes')],
      },
    });

    const items = await runNotionImport({
      userId,
      client,
      pageIds: ['crm', 'notes'],
      visibility: 'shared',
    });

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ notionPageId: 'crm', status: 'skip', reason: NOTION_UNSUPPORTED_LABEL }),
      expect.objectContaining({ notionPageId: 'notes', status: 'success' }),
    ]));
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
    const pages = await query<{ title: string }>('SELECT title FROM pages');
    expect(pages.rows.map((r) => r.title)).toEqual(['Acme Corp']);
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
});

describe('notion-import-service isolation', () => {
  it('does not query databases or talk to api.notion.com from source', () => {
    const src = readFileSync(new URL('./notion-import-service.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/queryDatabase/);
    expect(src).not.toMatch(/\/v1\/databases\/.*\/query/);
    expect(src).not.toMatch(/api\.notion\.com/);
    expect(src).not.toMatch(/pages\.source\s*=\s*['"]notion['"]/);
  });
});


