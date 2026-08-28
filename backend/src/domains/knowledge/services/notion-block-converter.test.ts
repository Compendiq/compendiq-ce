import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertNotionBlocks, formatWikiMetadataCallout } from './notion-block-converter.js';
import { htmlToText } from '../../../core/services/content-converter.js';
import { buildPageImageUrl } from '../../../core/services/image-references.js';

const LOCAL_PAGE_ID = 42;

function convert(blocks: Parameters<typeof convertNotionBlocks>[0], importedPages?: ReadonlyMap<string, number>) {
  return convertNotionBlocks(blocks, { localPageId: LOCAL_PAGE_ID, importedPages });
}

function rich(content: string, extras: Record<string, unknown> = {}) {
  return {
    type: 'text' as const,
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
    },
    plain_text: content,
    href: null,
    ...extras,
  };
}

function block(id: string, type: string, payload: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  return { object: 'block', id, type, has_children: false, [type]: payload, ...extras };
}

describe('convertNotionBlocks', () => {
  it('maps headings, paragraphs, quotes, code, and dividers into editor HTML', () => {
    const result = convert([
      block('h1', 'heading_1', { rich_text: [rich('Title')] }),
      block('h2', 'heading_2', { rich_text: [rich('Section')] }),
      block('h3', 'heading_3', { rich_text: [rich('Sub')] }),
      block('p', 'paragraph', { rich_text: [rich('Hello world')] }),
      block('q', 'quote', { rich_text: [rich('Cited')] }),
      block('c', 'code', { rich_text: [rich('const a = 1')], language: 'javascript', caption: [] }),
      block('d', 'divider', {}),
    ]);

    expect(result.bodyHtml).toContain('<h1>Title</h1>');
    expect(result.bodyHtml).toContain('<h2>Section</h2>');
    expect(result.bodyHtml).toContain('<h3>Sub</h3>');
    expect(result.bodyHtml).toContain('<p>Hello world</p>');
    expect(result.bodyHtml).toContain('<blockquote><p>Cited</p></blockquote>');
    expect(result.bodyHtml).toContain('<pre><code class="language-javascript">const a = 1</code></pre>');
    expect(result.bodyHtml).toContain('<hr>');
    expect(result.skips).toEqual([]);
  });

  it('renders bold, italic, strike, code, and links inside rich text', () => {
    const result = convert([
      block('p', 'paragraph', {
        rich_text: [
          { ...rich('bold'), annotations: { ...rich('bold').annotations, bold: true } },
          rich(' '),
          { ...rich('italic'), annotations: { ...rich('italic').annotations, italic: true } },
          rich(' '),
          { ...rich('gone'), annotations: { ...rich('gone').annotations, strikethrough: true } },
          rich(' '),
          { ...rich('code'), annotations: { ...rich('code').annotations, code: true } },
          rich(' '),
          {
            ...rich('docs'),
            text: { content: 'docs', link: { url: 'https://example.com/docs' } },
            href: 'https://example.com/docs',
          },
        ],
      }),
    ]);

    expect(result.bodyHtml).toContain('<strong>bold</strong>');
    expect(result.bodyHtml).toContain('<em>italic</em>');
    expect(result.bodyHtml).toContain('<del>gone</del>');
    expect(result.bodyHtml).toContain('<code>code</code>');
    expect(result.bodyHtml).toContain('<a href="https://example.com/docs">docs</a>');
  });

  it('groups consecutive bullets and numbers, and nests children', () => {
    const result = convert([
      block('b1', 'bulleted_list_item', {
        rich_text: [rich('One')],
        children: [block('b1a', 'bulleted_list_item', { rich_text: [rich('Nested')] })],
      }),
      block('b2', 'bulleted_list_item', { rich_text: [rich('Two')] }),
      block('n1', 'numbered_list_item', { rich_text: [rich('First')] }),
      block('n2', 'numbered_list_item', { rich_text: [rich('Second')] }),
    ]);

    expect(result.bodyHtml).toMatch(/<ul><li>One<ul><li>Nested<\/li><\/ul><\/li><li>Two<\/li><\/ul>/);
    expect(result.bodyHtml).toMatch(/<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  });

  it('maps to-do blocks onto the editor task-list shape', () => {
    const result = convert([
      block('t1', 'to_do', { rich_text: [rich('Open')], checked: false }),
      block('t2', 'to_do', { rich_text: [rich('Done')], checked: true }),
    ]);

    expect(result.bodyHtml).toContain('data-type="taskList"');
    expect(result.bodyHtml).toContain('data-type="taskItem"');
    expect(result.bodyHtml).toContain('data-checked="false"');
    expect(result.bodyHtml).toContain('data-checked="true"');
    expect(result.bodyHtml).toContain('Open');
    expect(result.bodyHtml).toContain('Done');
  });

  it('maps callouts onto panel-* classes the editor already knows', () => {
    const info = convert([block('c1', 'callout', { rich_text: [rich('Note')], color: 'blue_background' })]);
    const warn = convert([block('c2', 'callout', { rich_text: [rich('Danger')], color: 'red' })]);
    const tip = convert([block('c3', 'callout', { rich_text: [rich('Hint')], color: 'green' })]);
    const note = convert([block('c4', 'callout', { rich_text: [rich('Watch')], color: 'yellow_background' })]);

    expect(info.bodyHtml).toContain('class="panel-info"');
    expect(info.bodyHtml).toContain('Note');
    expect(warn.bodyHtml).toContain('class="panel-warning"');
    expect(tip.bodyHtml).toContain('class="panel-tip"');
    expect(note.bodyHtml).toContain('class="panel-note"');
  });

  it('converts a simple Notion table into an HTML table', () => {
    const result = convert([
      block('tbl', 'table', {
        table_width: 2,
        has_column_header: true,
        has_row_header: false,
        children: [
          block('r1', 'table_row', { cells: [[rich('Name')], [rich('Role')]] }),
          block('r2', 'table_row', { cells: [[rich('Ada')], [rich('Engineer')]] }),
        ],
      }),
    ]);

    expect(result.bodyHtml).toContain('<table>');
    expect(result.bodyHtml).toContain('<th>Name</th>');
    expect(result.bodyHtml).toContain('<th>Role</th>');
    expect(result.bodyHtml).toContain('<td>Ada</td>');
    expect(result.bodyHtml).toContain('<td>Engineer</td>');
  });

  it('turns images into local-attachment URLs and records download intents without fetching', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sourceUrl = 'https://files.example.test/photo.png?sig=1';
    const result = convert([
      block('img', 'image', {
        type: 'file',
        file: { url: sourceUrl, expiry_time: '2099-01-01T00:00:00.000Z' },
        caption: [rich('A photo')],
      }),
    ]);

    const filename = 'img-photo.png';
    const expectedSrc = buildPageImageUrl({
      source: 'local',
      key: filename,
      pageId: LOCAL_PAGE_ID,
      pageSource: 'standalone',
    });
    expect(result.bodyHtml).toContain(`<img src="${expectedSrc}" alt="A photo">`);
    expect(result.attachments).toEqual([
      {
        blockId: 'img',
        kind: 'image',
        filename,
        sourceUrl,
        alt: 'A photo',
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rewrites mentions of imported pages to /pages/:id and leaves skipped ones as Notion URLs', () => {
    const importedId = '3c612f56-fdd0-4a30-a4d6-bda7d7426309';
    const skippedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const skippedHref = 'https://www.notion.so/aaaaaaaabbbbccccddddeeeeeeeeeeee';
    const result = convert(
      [
        block('p', 'paragraph', {
          rich_text: [
            {
              type: 'mention',
              mention: { type: 'page', page: { id: importedId } },
              annotations: rich('Imported').annotations,
              plain_text: 'Imported',
              href: `https://www.notion.so/${importedId.replace(/-/g, '')}`,
            },
            rich(' and '),
            {
              type: 'mention',
              mention: { type: 'page', page: { id: skippedId } },
              annotations: rich('Skipped').annotations,
              plain_text: 'Skipped',
              href: skippedHref,
            },
            rich(' and '),
            {
              type: 'mention',
              mention: { type: 'database', database: { id: 'db-1' } },
              annotations: rich('Tracker').annotations,
              plain_text: 'Tracker',
              href: 'https://www.notion.so/db1db1db1db1db1db1db1db1db1db1db',
            },
          ],
        }),
      ],
      new Map([[importedId, 99]]),
    );

    expect(result.bodyHtml).toContain('<a href="/pages/99">Imported</a>');
    expect(result.bodyHtml).toContain(`<a href="${skippedHref}">Skipped</a>`);
    expect(result.bodyHtml).toContain('href="https://www.notion.so/db1db1db1db1db1db1db1db1db1db1db"');
    expect(result.bodyHtml).not.toContain('/pages/db');
  });

  it('turns a child_page into a link and does not pull nested unsupported children', () => {
    const pageId = '11111111-2222-3333-4444-555555555555';
    const result = convert([
      block(pageId, 'child_page', { title: 'Nested notes' }, {
        has_children: true,
        children: [
          block('db', 'child_database', { title: 'Rows' }),
        ],
      }),
    ]);

    expect(result.bodyHtml).toContain(`<a href="https://www.notion.so/${pageId.replace(/-/g, '')}">Nested notes</a>`);
    expect(result.bodyHtml).not.toContain('Rows');
    expect(result.skips).toEqual([]);
  });

  it('rewrites an imported child_page to /pages/:id', () => {
    const pageId = '11111111-2222-3333-4444-555555555555';
    const result = convert(
      [block(pageId, 'child_page', { title: 'Nested notes' })],
      new Map([[pageId, 7]]),
    );
    expect(result.bodyHtml).toContain('<a href="/pages/7">Nested notes</a>');
  });

  it('renders child_database with attached rows into an HTML table on the host page', () => {
    const result = convert([
      {
        id: 'db-1',
        type: 'child_database',
        child_database: { title: 'Ports' },
        databaseColumns: ['Port', 'Service'],
        databaseRows: [
          {
            properties: {
              Port: { type: 'number', number: 22 },
              Service: { type: 'title', title: [{ plain_text: 'SSH' }] },
            },
          },
          {
            properties: {
              Port: { type: 'number', number: 80 },
              Service: { type: 'title', title: [{ plain_text: 'HTTP' }] },
            },
          },
        ],
      },
    ]);

    expect(result.bodyHtml).toContain('<h3>Ports</h3>');
    expect(result.bodyHtml).toContain('<table>');
    expect(result.bodyHtml).toContain('<th>Port</th>');
    expect(result.bodyHtml).toContain('<th>Service</th>');
    expect(result.bodyHtml).toContain('<td>22</td>');
    expect(result.bodyHtml).toContain('<td>SSH</td>');
    expect(result.bodyHtml).toContain('<td>80</td>');
    expect(result.bodyHtml).toContain('<td>HTTP</td>');
  });

  it('skips unsupported blocks without flattening or stubbing them, and lists them in the report', () => {
    const result = convert([
      block('p', 'paragraph', { rich_text: [rich('Keep')] }),
      block('db', 'child_database', { title: 'CRM' }),
      block('btn', 'unsupported', { block_type: 'button' }),
      block('wb', 'unsupported', { block_type: 'board' }),
      block('ai', 'meeting_notes', { title: [rich('Standup')] }),
      block('vid', 'video', { type: 'external', external: { url: 'https://example.com/v.mp4' } }),
    ]);

    expect(result.bodyHtml).toContain('<p>Keep</p>');
    expect(result.bodyHtml).not.toContain('CRM');
    expect(result.bodyHtml).not.toContain('Standup');
    expect(result.bodyHtml).not.toContain('button');
    expect(result.bodyHtml).not.toContain('v.mp4');
    expect(result.skips.map((s) => s.type).sort()).toEqual(
      ['child_database', 'meeting_notes', 'unsupported', 'unsupported', 'video'].sort(),
    );
    expect(result.skips.every((s) => s.reason === 'unsupported')).toBe(true);
  });

  it('strips script tags and event-handler attributes before returning body_html', () => {
    const result = convert([
      block('p', 'paragraph', {
        rich_text: [
          rich('<script>alert(1)</script>'),
          {
            ...rich('click me'),
            text: { content: 'click me', link: { url: 'javascript:alert(1)' } },
            href: 'javascript:alert(1)',
          },
        ],
      }),
    ]);

    expect(result.bodyHtml.toLowerCase()).not.toContain('<script');
    expect(result.bodyHtml.toLowerCase()).not.toContain('javascript:');
    expect(result.bodyHtml.toLowerCase()).not.toContain('onerror=');
    expect(result.bodyHtml).toContain('alert(1)');
  });

  it('derives body_text from the same sanitized HTML the editor will store', () => {
    const result = convert([
      block('h', 'heading_1', { rich_text: [rich('Title')] }),
      block('p', 'paragraph', { rich_text: [rich('Body copy')] }),
    ]);

    expect(result.bodyText).toBe(htmlToText(result.bodyHtml));
    expect(result.bodyText).toContain('Title');
    expect(result.bodyText).toContain('Body copy');
  });

  it('walks column_list, column, toggle, and synced_block so nested supported blocks survive', () => {
    const result = convert([
      block('cols', 'column_list', {
        children: [
          block('col-a', 'column', {
            children: [block('p-a', 'paragraph', { rich_text: [rich('Left col')] })],
          }),
          block('col-b', 'column', {
            children: [block('p-b', 'paragraph', { rich_text: [rich('Right col')] })],
          }),
        ],
      }),
      block('tog', 'toggle', {
        rich_text: [rich('Toggle title')],
        children: [block('p-t', 'paragraph', { rich_text: [rich('Hidden body')] })],
      }),
      block('sync', 'synced_block', {
        children: [block('p-s', 'paragraph', { rich_text: [rich('Synced copy')] })],
      }),
    ]);

    expect(result.bodyHtml).toContain('<p>Left col</p>');
    expect(result.bodyHtml).toContain('<p>Right col</p>');
    expect(result.bodyHtml).toContain('Toggle title');
    expect(result.bodyHtml).toContain('<p>Hidden body</p>');
    expect(result.bodyHtml).toContain('<p>Synced copy</p>');
    expect(result.skips.filter((s) => s.type === 'child_database')).toEqual([]);
  });

  it('does not flatten a child_database nested in a column, but still imports sibling paragraphs', () => {
    const result = convert([
      block('cols', 'column_list', {
        children: [
          block('col-a', 'column', {
            children: [
              block('p-a', 'paragraph', { rich_text: [rich('Keep')] }),
              block('db', 'child_database', { title: 'CRM' }),
            ],
          }),
        ],
      }),
    ]);

    expect(result.bodyHtml).toContain('<p>Keep</p>');
    expect(result.bodyHtml).not.toContain('CRM');
    expect(result.skips.map((s) => s.type)).toEqual(['child_database']);
  });

  it('emits nested children of a toggle heading and of a paragraph', () => {
    const result = convert([
      block('h2', 'heading_2', {
        rich_text: [rich('Open me')],
        is_toggleable: true,
        children: [block('p-h', 'paragraph', { rich_text: [rich('Under heading')] })],
      }),
      block('p', 'paragraph', {
        rich_text: [rich('Lead')],
        children: [block('p-n', 'paragraph', { rich_text: [rich('Nested para')] })],
      }),
    ]);

    expect(result.bodyHtml).toContain('<h2>Open me</h2>');
    expect(result.bodyHtml).toContain('<p>Under heading</p>');
    expect(result.bodyHtml).toContain('<p>Lead</p>');
    expect(result.bodyHtml).toContain('<p>Nested para</p>');
    expect(result.skips).toEqual([]);
  });

  it('namespaces image filenames so two blocks sharing a basename do not collide', () => {
    const result = convert([
      block('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'image', {
        type: 'file',
        file: { url: 'https://files.example.test/a/image.png' },
        caption: [],
      }),
      block('11111111-2222-3333-4444-555555555555', 'image', {
        type: 'external',
        external: { url: 'https://cdn.example.test/b/image.png' },
        caption: [],
      }),
    ]);

    const names = result.attachments.map((a) => a.filename);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toContain('image.png');
    expect(names[1]).toContain('image.png');
    const srcs = [...result.bodyHtml.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toHaveLength(2);
    expect(srcs[0]).not.toBe(srcs[1]);
  });

  it('skips image blocks whose sourceUrl is not http(s) and records no attachment', () => {
    const js = convert([
      block('bad-js', 'image', {
        type: 'external',
        external: { url: 'javascript:alert(1)' },
        caption: [rich('nope')],
      }),
    ]);
    const file = convert([
      block('bad-file', 'image', {
        type: 'file',
        file: { url: 'file:///etc/passwd' },
        caption: [],
      }),
    ]);

    expect(js.bodyHtml).not.toContain('<img');
    expect(js.bodyHtml.toLowerCase()).not.toContain('javascript:');
    expect(js.attachments).toEqual([]);
    expect(js.skips.map((s) => s.blockId)).toEqual(['bad-js']);
    expect(file.bodyHtml).not.toContain('<img');
    expect(file.attachments).toEqual([]);
    expect(file.skips.map((s) => s.blockId)).toEqual(['bad-file']);
  });

  it('turns link_to_page into a Notion URL, or /pages/:id when that page is imported', () => {
    const pageId = '3c612f56-fdd0-4a30-a4d6-bda7d7426309';
    const skippedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const dbId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const result = convert(
      [
        block('l1', 'link_to_page', { type: 'page_id', page_id: pageId }),
        block('l2', 'link_to_page', { type: 'page_id', page_id: skippedId }),
        block('l3', 'link_to_page', { type: 'database_id', database_id: dbId }),
      ],
      new Map([[pageId, 99]]),
    );

    expect(result.bodyHtml).toContain('<a href="/pages/99">');
    expect(result.bodyHtml).toContain(`href="https://www.notion.so/${skippedId.replace(/-/g, '')}"`);
    expect(result.bodyHtml).toContain(`href="https://www.notion.so/${dbId.replace(/-/g, '')}"`);
    expect(result.bodyHtml).not.toContain(`/pages/${dbId}`);
    expect(result.skips).toEqual([]);
  });

  it('does not treat a Notion-authored /pages/ path as an internal Compendiq URL', () => {
    const result = convert([
      block('p', 'paragraph', {
        rich_text: [
          {
            ...rich('trap'),
            text: { content: 'trap', link: { url: '/pages/1' } },
            href: '/pages/1',
          },
        ],
      }),
    ]);

    expect(result.bodyHtml).not.toContain('href="/pages/1"');
    expect(result.bodyHtml).toContain('trap');
  });
});

describe('formatWikiMetadataCallout', () => {
  it('renders status, owner, verified, tags, and custom properties in a callout', () => {
    const html = formatWikiMetadataCallout({
      status: 'In Review',
      author: 'Alice & Bob',
      verifiedAt: new Date('2026-08-15T00:00:00.000Z'),
      tags: ['security', 'core'],
      customProperties: {
        'Jira Epic': 'PROJ-123',
        'Risk Level': 'Low',
      },
    });

    expect(html).toContain('data-type="callout"');
    expect(html).toContain('class="notion-wiki-metadata"');
    expect(html).toContain('<strong>Status:</strong> In Review');
    expect(html).toContain('<strong>Owner:</strong> Alice &amp; Bob');
    expect(html).toContain('<strong>Verified:</strong> 2026-08-15');
    expect(html).toContain('<strong>Tags:</strong> security, core');
    expect(html).toContain('<strong>Jira Epic:</strong> PROJ-123');
    expect(html).toContain('<strong>Risk Level:</strong> Low');
  });

  it('returns empty string when no metadata is provided', () => {
    const html = formatWikiMetadataCallout({});
    expect(html).toBe('');
  });
});

describe('notion-block-converter isolation', () => {
  it('never talks to api.notion.com or issues HTTP from the converter module', () => {
    const src = readFileSync(new URL('./notion-block-converter.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/api\.notion\.com/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/@notionhq\/client/);
    expect(src).not.toMatch(/\bundici\b/);
    expect(src).toContain("from 'isomorphic-dompurify'");
  });
});
