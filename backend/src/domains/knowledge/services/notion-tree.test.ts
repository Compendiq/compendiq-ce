import { afterEach, describe, expect, it } from 'vitest';
import { NOTION_UNSUPPORTED_LABEL, NotionTreeResponseSchema } from '@compendiq/contracts';
import { startFakeNotionServer, type FakeNotionServer } from './__fixtures__/fake-notion-server.js';
import {
  NOTION_RATE_LIMIT_MAX_ATTEMPTS,
  NotionClient,
  setNotionApiBaseUrlForTests,
} from './notion-client.js';
import {
  NOTION_INLINE_DATABASE_REASON,
  NOTION_ROW_SAMPLE_SIZE,
  fetchNotionWorkspaceTree,
  rowHasBodyContent,
} from './notion-tree.js';

const TOKEN = 'secret_tree_ntn_never_echo';

type TreeNode = {
  id: string;
  title: string;
  type: string;
  selectable: boolean;
  skipReason?: string;
  reasonCode?: string;
  isDatabaseRow?: boolean;
  recommendedMode?: 'table' | 'pages';
  rowContent?: 'none' | 'some' | 'unknown';
  isWiki?: boolean;
  rowCount?: number;
  columns?: string[];
  children: TreeNode[];
};

function titleProp(text: string) {
  return {
    title: {
      id: 'title',
      type: 'title',
      title: [{ type: 'text', plain_text: text, text: { content: text } }],
    },
  };
}

function richTitle(text: string) {
  return [{ type: 'text', plain_text: text, text: { content: text } }];
}

/** Mixed workspace: pages, nested pages, database, linked database, unsupported node. */
function mixedSearchResults(): Array<Record<string, unknown>> {
  return [
    {
      object: 'page',
      id: 'handbook',
      url: 'https://www.notion.so/handbook',
      parent: { type: 'workspace', workspace: true },
      properties: titleProp('Handbook'),
    },
    {
      object: 'page',
      id: 'onboarding',
      url: 'https://www.notion.so/onboarding',
      parent: { type: 'page_id', page_id: 'handbook' },
      properties: titleProp('Onboarding'),
    },
    {
      object: 'database',
      id: 'crm',
      url: 'https://www.notion.so/crm',
      parent: { type: 'page_id', page_id: 'handbook' },
      title: richTitle('CRM'),
    },
    {
      object: 'database',
      id: 'crm-linked',
      url: 'https://www.notion.so/crm-linked',
      parent: { type: 'page_id', page_id: 'onboarding' },
      is_inline: true,
      title: richTitle('CRM (linked)'),
    },
    {
      object: 'page',
      id: 'row-listed',
      url: 'https://www.notion.so/row-listed',
      parent: { type: 'database_id', database_id: 'crm' },
      properties: titleProp('Acme Corp'),
    },
    {
      object: 'block',
      id: 'whiteboard-1',
      type: 'unsupported',
      unsupported: { block_type: 'whiteboard' },
      parent: { type: 'workspace', workspace: true },
      title: richTitle('Workshop canvas'),
    },
  ];
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

function findById(nodes: TreeNode[], id: string): TreeNode | undefined {
  return flatten(nodes).find((n) => n.id === id);
}

describe('fetchNotionWorkspaceTree (fake Notion HTTP)', () => {
  let server: FakeNotionServer | undefined;

  afterEach(async () => {
    setNotionApiBaseUrlForTests(null);
    await server?.close();
    server = undefined;
  });

  async function treeFor(state: Parameters<typeof startFakeNotionServer>[0]) {
    server = await startFakeNotionServer(state);
    expect(server.baseUrl).not.toContain('api.notion.com');
    const client = new NotionClient(TOKEN, { baseUrl: server.baseUrl });
    return fetchNotionWorkspaceTree(client);
  }

  /**
   * Every `GET /v1/blocks/:id/children` the tree issued, sorted by block id
   * because samples are issued concurrently. Row sampling is the only
   * legitimate caller, so the shape of this log is the invariant: page bodies
   * are never walked (`page_size=100`), rows are only peeked at
   * (`page_size=2`).
   */
  function childRequests(): Array<{ blockId: string; pageSize: number | null }> {
    return server!.requests
      .filter((request) => request.url.includes('/children'))
      .map((request) => {
        const { pathname, searchParams } = new URL(request.url, 'http://127.0.0.1');
        const size = searchParams.get('page_size');
        return {
          blockId: /^\/v1\/blocks\/([^/]+)\/children$/.exec(pathname)?.[1] ?? pathname,
          pageSize: size === null ? null : Number.parseInt(size, 10),
        };
      })
      .sort((a, b) => a.blockId.localeCompare(b.blockId));
  }

  it('builds a mixed tree: pages and standalone databases selectable, inline databases and unsupported blocks not', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: mixedSearchResults(),
      blockChildren: {
        handbook: [
          {
            object: 'block',
            id: 'onboarding',
            type: 'child_page',
            child_page: { title: 'Onboarding' },
          },
          {
            object: 'block',
            id: 'crm',
            type: 'child_database',
            child_database: { title: 'CRM' },
          },
          {
            object: 'block',
            id: 'btn-in-body',
            type: 'unsupported',
            unsupported: { block_type: 'button' },
          },
        ],
        onboarding: [
          {
            object: 'block',
            id: 'crm-linked',
            type: 'child_database',
            child_database: { title: 'CRM (linked)' },
          },
        ],
      },
      databaseQueryResults: {
        crm: [
          {
            object: 'page',
            id: 'row-only-via-query',
            parent: { type: 'database_id', database_id: 'crm' },
            properties: titleProp('Secret row'),
          },
        ],
      },
    });

    const parsed = NotionTreeResponseSchema.parse({ nodes });
    const handbook = findById(parsed.nodes as TreeNode[], 'handbook');
    const onboarding = findById(parsed.nodes as TreeNode[], 'onboarding');
    const crm = findById(parsed.nodes as TreeNode[], 'crm');
    const linked = findById(parsed.nodes as TreeNode[], 'crm-linked');
    const listedRow = findById(parsed.nodes as TreeNode[], 'row-listed');
    const queriedRow = findById(parsed.nodes as TreeNode[], 'row-only-via-query');
    const canvas = findById(parsed.nodes as TreeNode[], 'whiteboard-1');
    const button = findById(parsed.nodes as TreeNode[], 'btn-in-body');

    expect(handbook).toMatchObject({ type: 'page', selectable: true, title: 'Handbook' });
    expect(handbook?.skipReason).toBeUndefined();
    expect(onboarding).toMatchObject({ type: 'page', selectable: true, title: 'Onboarding' });
    expect(handbook?.children.map((c) => c.id)).toEqual(expect.arrayContaining(['onboarding', 'crm']));

    expect(crm).toMatchObject({
      type: 'database',
      selectable: true,
      title: 'CRM',
      isWiki: false,
      rowCount: 1,
      rowContent: 'none',
      recommendedMode: 'table',
      columns: [],
    });
    expect(crm?.skipReason).toBeUndefined();
    expect(linked).toMatchObject({
      type: 'unsupported',
      selectable: false,
      reasonCode: 'inline_database',
      skipReason: NOTION_INLINE_DATABASE_REASON,
      title: 'CRM (linked)',
    });
    expect(canvas).toMatchObject({
      type: 'unsupported',
      selectable: false,
      skipReason: NOTION_UNSUPPORTED_LABEL,
    });

    expect(listedRow).toMatchObject({ type: 'page', selectable: true, title: 'Acme Corp' });
    expect(crm?.children.map((c) => c.id)).toContain('row-listed');
    expect(queriedRow).toBeUndefined();
    expect(button).toBeUndefined();

    const queryHits = server!.requests.filter((r) => r.method === 'POST' && /\/v1\/databases\/[^/]+\/query$/.test(r.url));
    expect(queryHits).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
    expect(JSON.stringify(server!.requests.map((r) => r.url))).not.toContain('api.notion.com');
  });

  it('treats parent-without-children as a valid selection — children listed separately', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: mixedSearchResults(),
    });
    const handbook = findById(nodes as TreeNode[], 'handbook');
    expect(handbook?.selectable).toBe(true);
    expect(handbook?.children.length).toBeGreaterThan(0);
    expect(handbook).not.toHaveProperty('importSubtree');
    expect(handbook).not.toHaveProperty('selectedChildIds');
    expect(Object.keys(handbook!)).not.toContain('includesChildren');
  });

  it('builds the initial tree without listing every page body', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'handbook',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Handbook'),
        },
        {
          object: 'page',
          id: 'onboarding',
          parent: { type: 'page_id', page_id: 'handbook' },
          properties: titleProp('Onboarding'),
        },
      ],
      blockChildren: {
        handbook: [
          {
            object: 'block',
            id: 'slow-body-content',
            type: 'toggle',
            has_children: true,
            toggle: { rich_text: [] },
          },
        ],
      },
    });

    expect(findById(nodes as TreeNode[], 'onboarding')).toMatchObject({
      type: 'page',
      selectable: true,
    });
    expect(server!.requests.filter((request) => request.url.includes('/children'))).toEqual([]);
  });

  it('does not invent row-pages from database block children', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'crm',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('CRM'),
        },
      ],
      blockChildren: {
        crm: [
          {
            object: 'block',
            id: 'row-as-child-block',
            type: 'child_page',
            child_page: { title: 'Should not appear' },
          },
        ],
      },
      databaseQueryResults: {
        crm: [
          {
            object: 'page',
            id: 'row-only-via-query',
            properties: titleProp('Secret row'),
          },
        ],
      },
    });

    expect(findById(nodes as TreeNode[], 'row-as-child-block')).toBeUndefined();
    expect(findById(nodes as TreeNode[], 'row-only-via-query')).toBeUndefined();
    expect(server!.requests.some((r) => r.url.includes('/blocks/crm/children'))).toBe(false);
    expect(server!.requests.some((r) => r.url.includes('/query'))).toBe(false);
  });


  it('groups a Search-listed page under its host when Notion reports a block parent', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'handbook',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Handbook'),
        },
        {
          object: 'page',
          id: 'nested-in-toggle',
          parent: { type: 'block_id', block_id: 'toggle-1' },
          properties: titleProp('Nested under toggle'),
        },
      ],
      blocks: {
        'toggle-1': {
          object: 'block',
          id: 'toggle-1',
          type: 'toggle',
          parent: { type: 'page_id', page_id: 'handbook' },
          has_children: true,
        },
      },
    });

    expect(nodes.map((node) => node.id)).toEqual(['handbook']);
    expect(findById(nodes as TreeNode[], 'nested-in-toggle')).toMatchObject({
      type: 'page',
      selectable: true,
      title: 'Nested under toggle',
    });
    expect(server!.requests.filter((request) => request.url.includes('/children'))).toEqual([]);
  });

  it('keeps a Search-listed database and its rows on the resolved host page', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'real-host',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Real host'),
        },
        {
          object: 'database',
          id: 'crm',
          parent: { type: 'block_id', block_id: 'toggle-on-real' },
          title: richTitle('CRM'),
        },
        {
          object: 'page',
          id: 'row-listed',
          parent: { type: 'database_id', database_id: 'crm' },
          properties: titleProp('Acme Corp'),
        },
      ],
      blocks: {
        'toggle-on-real': {
          object: 'block',
          id: 'toggle-on-real',
          type: 'toggle',
          parent: { type: 'page_id', page_id: 'real-host' },
          has_children: true,
        },
      },
    });

    const realHost = findById(nodes as TreeNode[], 'real-host');
    const canonical = realHost?.children.find((child) => child.id === 'crm');
    expect(canonical).toMatchObject({
      id: 'crm',
      type: 'database',
      selectable: true,
      rowCount: 1,
    });
    expect(canonical?.skipReason).toBeUndefined();
    expect(canonical?.children.map((child) => child.id)).toContain('row-listed');
    // Classification peeks at the row; nothing walks a page body.
    expect(childRequests()).toEqual([{ blockId: 'row-listed', pageSize: 2 }]);
  });


  it('samples a Search-listed database row without turning its blocks into nodes', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'handbook',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Handbook'),
        },
        {
          object: 'database',
          id: 'crm',
          parent: { type: 'page_id', page_id: 'handbook' },
          title: richTitle('CRM'),
        },
        {
          object: 'page',
          id: 'row-listed',
          parent: { type: 'database_id', database_id: 'crm' },
          properties: titleProp('Acme Corp'),
        },
      ],
      blockChildren: {
        'row-listed': [
          {
            object: 'block',
            id: 'should-not-fetch',
            type: 'child_database',
            child_database: { title: 'Hidden linked' },
          },
        ],
      },
    });

    expect(findById(nodes as TreeNode[], 'should-not-fetch')).toBeUndefined();
    expect(findById(nodes as TreeNode[], 'crm')).toMatchObject({
      rowContent: 'some',
      recommendedMode: 'pages',
    });
    expect(childRequests()).toEqual([{ blockId: 'row-listed', pageSize: 2 }]);
  });

  it('spends no row sample on a wiki database — its rows are articles by definition', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'linux-wiki',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Linux'),
          properties: {
            Name: { id: 'title', type: 'title' },
            Verification: { id: 'ver%3A', type: 'verification' },
          },
        },
        {
          object: 'page',
          id: 'wiki-row',
          parent: { type: 'database_id', database_id: 'linux-wiki' },
          properties: titleProp('Ansible Playbooks'),
        },
      ],
      // The row has real content, so a sample would have answered 'some'.
      blockChildren: {
        'wiki-row': [
          {
            object: 'block',
            id: 'wiki-row-heading',
            type: 'heading_2',
            heading_2: { rich_text: richTitle('Install') },
          },
        ],
      },
    });

    expect(findById(nodes as TreeNode[], 'linux-wiki')).toMatchObject({
      type: 'database',
      selectable: true,
      isWiki: true,
      rowCount: 1,
      rowContent: 'unknown',
      recommendedMode: 'pages',
    });
    expect(childRequests()).toEqual([]);
  });

  it('recommends a table when every sampled row is empty', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'contacts',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Contacts'),
        },
        ...['acme', 'globex'].map((id) => ({
          object: 'page',
          id,
          parent: { type: 'database_id', database_id: 'contacts' },
          properties: titleProp(id),
        })),
      ],
    });

    expect(findById(nodes as TreeNode[], 'contacts')).toMatchObject({
      isWiki: false,
      rowCount: 2,
      rowContent: 'none',
      recommendedMode: 'table',
    });
    expect(childRequests()).toEqual([
      { blockId: 'acme', pageSize: 2 },
      { blockId: 'globex', pageSize: 2 },
    ]);
  });

  it('recommends pages when a single sampled row carries body content', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'projects',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Projects'),
        },
        ...['apollo', 'gemini', 'mercury'].map((id) => ({
          object: 'page',
          id,
          parent: { type: 'database_id', database_id: 'projects' },
          properties: titleProp(id),
        })),
      ],
      blockChildren: {
        gemini: [
          {
            object: 'block',
            id: 'gemini-heading',
            type: 'heading_2',
            heading_2: { rich_text: richTitle('Retrospective') },
          },
        ],
      },
    });

    expect(findById(nodes as TreeNode[], 'projects')).toMatchObject({
      rowCount: 3,
      rowContent: 'some',
      recommendedMode: 'pages',
    });
    expect(childRequests()).toEqual([
      { blockId: 'apollo', pageSize: 2 },
      { blockId: 'gemini', pageSize: 2 },
      { blockId: 'mercury', pageSize: 2 },
    ]);
  });

  it('reads a lone blank paragraph as an empty row, and a filled one as content', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'blank-db',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Untouched rows'),
        },
        {
          object: 'page',
          id: 'blank-row',
          parent: { type: 'database_id', database_id: 'blank-db' },
          properties: titleProp('Never opened'),
        },
        {
          object: 'database',
          id: 'filled-db',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Written rows'),
        },
        {
          object: 'page',
          id: 'filled-row',
          parent: { type: 'database_id', database_id: 'filled-db' },
          properties: titleProp('Has notes'),
        },
      ],
      blockChildren: {
        // Notion leaves an empty paragraph behind on a row nobody wrote in.
        'blank-row': [
          {
            object: 'block',
            id: 'blank-row-para',
            type: 'paragraph',
            paragraph: { rich_text: [] },
          },
        ],
        'filled-row': [
          {
            object: 'block',
            id: 'filled-row-para',
            type: 'paragraph',
            paragraph: { rich_text: richTitle('Signed on Tuesday.') },
          },
        ],
      },
    });

    expect(findById(nodes as TreeNode[], 'blank-db')).toMatchObject({
      rowContent: 'none',
      recommendedMode: 'table',
    });
    expect(findById(nodes as TreeNode[], 'filled-db')).toMatchObject({
      rowContent: 'some',
      recommendedMode: 'pages',
    });
    expect(childRequests()).toEqual([
      { blockId: 'blank-row', pageSize: 2 },
      { blockId: 'filled-row', pageSize: 2 },
    ]);
  });

  it('recommends a table when sampled rows only have empty headings or callouts', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'fhs',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Filesystem Hierarchy'),
        },
        {
          object: 'page',
          id: 'bin',
          parent: { type: 'database_id', database_id: 'fhs' },
          properties: titleProp('/bin'),
        },
      ],
      blockChildren: {
        bin: [
          {
            object: 'block',
            id: 'bin-heading',
            type: 'heading_2',
            heading_2: { rich_text: [] },
          },
          {
            object: 'block',
            id: 'bin-callout',
            type: 'callout',
            callout: { rich_text: [], icon: { type: 'emoji', emoji: '📝' } },
          },
        ],
      },
    });

    expect(findById(nodes as TreeNode[], 'fhs')).toMatchObject({
      isWiki: false,
      rowContent: 'none',
      recommendedMode: 'table',
    });
  });

  it('still resolves the tree when every row sample fails', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'contacts',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Contacts'),
        },
        ...['acme', 'globex'].map((id) => ({
          object: 'page',
          id,
          parent: { type: 'database_id', database_id: 'contacts' },
          properties: titleProp(id),
        })),
      ],
      blockChildrenErrors: { acme: 500, globex: 500 },
    });

    expect(findById(nodes as TreeNode[], 'contacts')).toMatchObject({
      selectable: true,
      rowCount: 2,
      rowContent: 'unknown',
      recommendedMode: 'pages',
    });
    // Both rows are sampled, each climbing the full retry ladder for its 500.
    expect([...new Set(childRequests().map((request) => request.blockId))].sort()).toEqual(['acme', 'globex']);
    expect(childRequests().every((request) => request.pageSize === 2)).toBe(true);
    expect(childRequests()).toHaveLength(2 * NOTION_RATE_LIMIT_MAX_ATTEMPTS);
  });

  it('samples at most NOTION_ROW_SAMPLE_SIZE rows of a large database', async () => {
    const rowIds = Array.from({ length: 12 }, (_, i) => `row-${i}`);
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'inventory',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Inventory'),
        },
        ...rowIds.map((id) => ({
          object: 'page',
          id,
          parent: { type: 'database_id', database_id: 'inventory' },
          properties: titleProp(id),
        })),
      ],
    });

    expect(findById(nodes as TreeNode[], 'inventory')).toMatchObject({
      rowCount: 12,
      rowContent: 'none',
      recommendedMode: 'table',
    });
    const sampled = childRequests();
    expect(sampled.length).toBeLessThanOrEqual(NOTION_ROW_SAMPLE_SIZE);
    expect(sampled.length).toBeGreaterThan(0);
    expect(sampled.filter((request) => request.pageSize === 2 && rowIds.includes(request.blockId))).toEqual(sampled);
  });

  it('reports columns in schema order and counts only direct row pages', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'catalog',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Catalog'),
          properties: {
            Name: { id: 'title', type: 'title' },
            Status: { id: 'st%40', type: 'status' },
            Owner: { id: 'ow%40', type: 'people' },
          },
        },
        {
          object: 'page',
          id: 'catalog-row',
          parent: { type: 'database_id', database_id: 'catalog' },
          properties: titleProp('Acme Corp'),
        },
        {
          // Notion parents this to the database object itself — not a row.
          object: 'page',
          id: 'catalog-sidebar',
          parent: { type: 'page_id', page_id: 'catalog' },
          properties: titleProp('Catalog notes'),
        },
        {
          object: 'page',
          id: 'row-subpage',
          parent: { type: 'page_id', page_id: 'catalog-row' },
          properties: titleProp('Meeting notes'),
        },
      ],
    });

    const catalog = findById(nodes as TreeNode[], 'catalog');
    expect(catalog?.columns).toEqual(['Name', 'Status', 'Owner']);
    expect(catalog?.rowCount).toBe(1);
    expect(catalog?.children.map((child) => child.id)).toEqual(['catalog-row', 'catalog-sidebar']);
    expect(findById(nodes as TreeNode[], 'catalog-row')?.children.map((child) => child.id)).toEqual(['row-subpage']);
    expect(childRequests()).toEqual([{ blockId: 'catalog-row', pageSize: 2 }]);
  });

  it('does not fetch children of nested list items — Search already listed the pages', async () => {
    const listItems = Array.from({ length: 25 }, (_, i) => ({
      object: 'block',
      id: `li-${i}`,
      type: 'bulleted_list_item',
      has_children: true,
      bulleted_list_item: { rich_text: [] },
    }));
    const blockChildren: Record<string, Array<Record<string, unknown>>> = {
      handbook: listItems,
    };
    for (const item of listItems) {
      blockChildren[item.id] = [
        {
          object: 'block',
          id: `${item.id}-para`,
          type: 'paragraph',
          has_children: false,
          paragraph: { rich_text: [] },
        },
      ];
    }

    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'handbook',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Handbook'),
        },
        {
          object: 'page',
          id: 'onboarding',
          parent: { type: 'page_id', page_id: 'handbook' },
          properties: titleProp('Onboarding'),
        },
      ],
      blockChildren,
    });

    expect(findById(nodes as TreeNode[], 'onboarding')).toMatchObject({
      type: 'page',
      selectable: true,
      title: 'Onboarding',
    });
    const childUrls = server!.requests.filter((request) => request.url.includes('/children'));
    expect(childUrls).toEqual([]);
  });

  it('does not loop forever when synced blocks point at each other', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'handbook',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Handbook'),
        },
      ],
      blockChildren: {
        handbook: [
          {
            object: 'block',
            id: 'sync-a',
            type: 'synced_block',
            has_children: true,
            synced_block: {},
          },
        ],
        'sync-a': [
          {
            object: 'block',
            id: 'sync-b',
            type: 'synced_block',
            has_children: true,
            synced_block: {},
          },
        ],
        'sync-b': [
          {
            object: 'block',
            id: 'sync-a',
            type: 'synced_block',
            has_children: true,
            synced_block: {},
          },
        ],
      },
    });

    expect(findById(nodes as TreeNode[], 'handbook')).toMatchObject({ type: 'page', selectable: true });
    const childFetches = server!.requests.filter((request) => request.url.includes('/children'));
    expect(childFetches).toEqual([]);
  });

  it('returns every Search page without one body request per page', async () => {
    const pageCount = 500;
    const searchResults = Array.from({ length: pageCount }, (_, i) => ({
      object: 'page',
      id: `page-${i}`,
      parent: { type: 'workspace', workspace: true },
      properties: titleProp(`Page ${i}`),
    }));

    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults,
    });

    expect(nodes).toHaveLength(pageCount);
    expect(nodes.map((node) => node.id)).toEqual(searchResults.map((page) => page.id));
    expect(server!.requests.filter((request) => request.url.includes('/children'))).toEqual([]);
  });

  it('does not fail initial discovery when a page body endpoint is unavailable', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'handbook',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Handbook'),
        },
      ],
      blockChildrenErrors: { handbook: 503 },
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: 'handbook', selectable: true });
    expect(server!.requests.filter((request) => request.url.includes('/children'))).toEqual([]);
  });

  it('attaches wiki sub-items to their parent page via relation property', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'linux-wiki',
          title: richTitle('Linux'),
          parent: { type: 'workspace', workspace: true },
        },
        {
          object: 'page',
          id: 'ansible',
          parent: { type: 'database_id', database_id: 'linux-wiki' },
          properties: titleProp('Ansible Playbooks'),
        },
        {
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
      ],
    });

    const linux = findById(nodes as TreeNode[], 'linux-wiki');
    expect(linux).toBeDefined();
    expect(linux?.children.map((c) => c.id)).toContain('ansible');
    const ansible = findById(linux?.children ?? [], 'ansible');
    expect(ansible).toBeDefined();
    expect(ansible?.children.map((c) => c.id)).toContain('modules');
  });

  it('fetches a missing parent database on-demand and attaches children to it', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      databases: {
        'linux-wiki': {
          object: 'database',
          id: 'linux-wiki',
          title: richTitle('Linux'),
          parent: { type: 'workspace', workspace: true },
        },
      },
      searchResults: [
        {
          object: 'page',
          id: 'tmux',
          parent: { type: 'database_id', database_id: 'linux-wiki' },
          properties: titleProp('TMUX'),
        },
      ],
    });

    const linux = findById(nodes as TreeNode[], 'linux-wiki');
    expect(linux).toBeDefined();
    expect(linux?.children.map((c) => c.id)).toContain('tmux');
  });

  it('attaches a child when the missing parent is a database that GET /v1/pages 400s', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      pageErrors: { linux: 400 },
      databases: {
        linux: {
          object: 'database',
          id: 'linux',
          title: richTitle('Linux'),
          parent: { type: 'workspace', workspace: true },
          properties: {
            Name: { id: 'title', type: 'title' },
            Verification: { id: 'ver', type: 'verification' },
          },
        },
      },
      searchResults: [
        {
          object: 'page',
          id: 'tmux',
          parent: { type: 'page_id', page_id: 'linux' },
          properties: titleProp('TMUX'),
        },
      ],
    });

    const linux = findById(nodes as TreeNode[], 'linux');
    expect(linux).toMatchObject({ type: 'database', isWiki: true });
    expect(linux?.children.map((c) => c.id)).toContain('tmux');
  });

  it('fails the tree when a block-parent walk hits a non-missing Notion error', async () => {
    await expect(
      treeFor({
        validToken: TOKEN,
        searchResults: [
          {
            object: 'page',
            id: 'handbook',
            parent: { type: 'workspace', workspace: true },
            properties: titleProp('Handbook'),
          },
          {
            object: 'page',
            id: 'nested-in-toggle',
            parent: { type: 'block_id', block_id: 'toggle-1' },
            properties: titleProp('Nested under toggle'),
          },
        ],
        blockErrors: { 'toggle-1': 500 },
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it('fails the tree when a missing-parent lookup is rate-limited', async () => {
    await expect(
      treeFor({
        validToken: TOKEN,
        searchResults: [
          {
            object: 'page',
            id: 'child',
            parent: { type: 'page_id', page_id: 'parent-busy' },
            properties: titleProp('Child'),
          },
        ],
        pages: {
          'parent-busy': {
            object: 'page',
            id: 'parent-busy',
            parent: { type: 'workspace', workspace: true },
            properties: titleProp('Busy parent'),
          },
        },
        pageErrors: { 'parent-busy': 429 },
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it('caps concurrent block-parent lookups', async () => {
    const nested = Array.from({ length: 8 }, (_, i) => `nested-${i}`);
    const nodes = await treeFor({
      validToken: TOKEN,
      lookupDelayMs: 40,
      searchResults: [
        {
          object: 'page',
          id: 'handbook',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Handbook'),
        },
        ...nested.map((id, i) => ({
          object: 'page',
          id,
          parent: { type: 'block_id', block_id: `toggle-${i}` },
          properties: titleProp(id),
        })),
      ],
      blocks: Object.fromEntries(
        nested.map((_, i) => [
          `toggle-${i}`,
          {
            object: 'block',
            id: `toggle-${i}`,
            type: 'toggle',
            parent: { type: 'page_id', page_id: 'handbook' },
            has_children: true,
          },
        ]),
      ),
    });

    expect(server!.peakConcurrentLookups).toBeLessThanOrEqual(5);
    // Pacing must not collapse the pLimit to one lane (#1553).
    expect(server!.peakConcurrentLookups).toBeGreaterThan(1);
    expect(flatten(nodes as TreeNode[]).filter((n) => n.id.startsWith('nested-'))).toHaveLength(8);
  });

  it('caps concurrent missing-parent lookups', async () => {
    const parentIds = Array.from({ length: 8 }, (_, i) => `parent-${i}`);
    const nodes = await treeFor({
      validToken: TOKEN,
      lookupDelayMs: 40,
      pages: Object.fromEntries(
        parentIds.map((id) => [
          id,
          {
            object: 'page',
            id,
            parent: { type: 'workspace', workspace: true },
            properties: titleProp(id),
          },
        ]),
      ),
      searchResults: parentIds.map((parentId, i) => ({
        object: 'page',
        id: `child-${i}`,
        parent: { type: 'page_id', page_id: parentId },
        properties: titleProp(`Child ${i}`),
      })),
    });

    expect(server!.peakConcurrentLookups).toBeLessThanOrEqual(5);
    expect(server!.peakConcurrentLookups).toBeGreaterThan(1);
    expect(flatten(nodes as TreeNode[]).filter((n) => n.id.startsWith('child-'))).toHaveLength(8);
  });
});

describe('rowHasBodyContent', () => {
  function list(results: Array<Record<string, unknown>>, hasMore = false) {
    return { object: 'list' as const, results, next_cursor: null, has_more: hasMore };
  }

  it('treats an empty heading, callout, or list item as no body', () => {
    expect(
      rowHasBodyContent(
        list([
          { type: 'heading_2', heading_2: { rich_text: [] } },
          { type: 'callout', callout: { rich_text: [], icon: { type: 'emoji', emoji: '📝' } } },
          { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [] } },
        ]),
      ),
    ).toBe(false);
  });

  it('still treats a heading with text as body content', () => {
    expect(
      rowHasBodyContent(
        list([{ type: 'heading_2', heading_2: { rich_text: [{ type: 'text', plain_text: 'Install' }] } }]),
      ),
    ).toBe(true);
  });
});
