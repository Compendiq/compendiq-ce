import { mkdtemp, rm } from 'node:fs/promises';
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
import { runNotionImport } from './notion-import-service.js';

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


