import { afterEach, describe, expect, it } from 'vitest';
import { NOTION_BOARD_REASON, NOTION_UNSUPPORTED_LABEL, NotionTreeResponseSchema } from '@compendiq/contracts';
import { startFakeNotionServer, type FakeNotionServer } from './__fixtures__/fake-notion-server.js';
import {
  NOTION_RATE_LIMIT_MAX_ATTEMPTS,
  NotionClient,
  setNotionApiBaseUrlForTests,
} from './notion-client.js';
import {
  NOTION_INLINE_DATABASE_REASON,
  NOTION_ROW_PROBE_BLOCKS,
  NOTION_ROW_SAMPLE_SIZE,
  fetchNotionWorkspaceTree,
  isBoardLayout,
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
   * (`page_size=NOTION_ROW_PROBE_BLOCKS`).
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
    expect(childRequests()).toEqual([{ blockId: 'row-listed', pageSize: NOTION_ROW_PROBE_BLOCKS }]);
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
    expect(childRequests()).toEqual([{ blockId: 'row-listed', pageSize: NOTION_ROW_PROBE_BLOCKS }]);
  });

  it('keeps an inline wiki selectable as an article container without sampling its rows', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'linux-wiki',
          is_inline: true,
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

  it('keeps ordinary inline database rows selectable without probing the host or row bodies', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'host',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Host'),
        },
        {
          object: 'database',
          id: 'inline',
          is_inline: true,
          title: richTitle('Inline table'),
          parent: { type: 'page_id', page_id: 'host' },
        },
        {
          object: 'page',
          id: 'row',
          parent: { type: 'database_id', database_id: 'inline' },
          properties: titleProp('Row with an article body'),
        },
      ],
    });

    expect(nodes).toMatchObject([{
      id: 'host',
      children: [{
        id: 'inline',
        type: 'unsupported',
        selectable: false,
        reasonCode: 'inline_database',
        children: [{ id: 'row', type: 'page', selectable: true, isDatabaseRow: true }],
      }],
    }]);
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
      { blockId: 'acme', pageSize: NOTION_ROW_PROBE_BLOCKS },
      { blockId: 'globex', pageSize: NOTION_ROW_PROBE_BLOCKS },
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
      { blockId: 'apollo', pageSize: NOTION_ROW_PROBE_BLOCKS },
      { blockId: 'gemini', pageSize: NOTION_ROW_PROBE_BLOCKS },
      { blockId: 'mercury', pageSize: NOTION_ROW_PROBE_BLOCKS },
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
      { blockId: 'blank-row', pageSize: NOTION_ROW_PROBE_BLOCKS },
      { blockId: 'filled-row', pageSize: NOTION_ROW_PROBE_BLOCKS },
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

  it('reads past a three-block row template instead of calling the remainder content', async () => {
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
        // Three blocks: at the old two-block probe the third was unread, and an
        // unread remainder is `has_more`, which counts as body content.
        bin: [
          { object: 'block', id: 'bin-heading', type: 'heading_2', heading_2: { rich_text: [] } },
          { object: 'block', id: 'bin-callout', type: 'callout', callout: { rich_text: [] } },
          { object: 'block', id: 'bin-divider', type: 'divider', divider: {} },
        ],
      },
    });

    expect(childRequests()).toEqual([{ blockId: 'bin', pageSize: NOTION_ROW_PROBE_BLOCKS }]);
    expect(findById(nodes as TreeNode[], 'fhs')).toMatchObject({
      rowContent: 'none',
      recommendedMode: 'table',
    });
  });

  it('recommends pages when a row body hides inside a blank toggle', async () => {
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
            id: 'bin-toggle',
            type: 'toggle',
            has_children: true,
            toggle: { rich_text: [] },
          },
        ],
      },
    });

    expect(findById(nodes as TreeNode[], 'fhs')).toMatchObject({
      rowContent: 'some',
      recommendedMode: 'pages',
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
    expect(childRequests().every((request) => request.pageSize === NOTION_ROW_PROBE_BLOCKS)).toBe(true);
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
    expect(sampled.filter((request) => request.pageSize === NOTION_ROW_PROBE_BLOCKS && rowIds.includes(request.blockId))).toEqual(sampled);
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
    expect(childRequests()).toEqual([{ blockId: 'catalog-row', pageSize: NOTION_ROW_PROBE_BLOCKS }]);
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

  it('recovers an omitted ancestor chain through an inline wiki up to its workspace root', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [{
        object: 'page',
        id: 'article',
        parent: { type: 'database_id', database_id: 'wiki' },
        properties: titleProp('Article'),
      }],
      databases: {
        wiki: {
          object: 'database',
          id: 'wiki',
          is_inline: true,
          title: richTitle('Knowledge Base'),
          parent: { type: 'page_id', page_id: 'department' },
          properties: { Verification: { type: 'verification' } },
        },
      },
      pages: {
        department: {
          object: 'page',
          id: 'department',
          parent: { type: 'page_id', page_id: 'workspace-home' },
          properties: titleProp('Department'),
        },
        'workspace-home': {
          object: 'page',
          id: 'workspace-home',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Home'),
        },
      },
    });

    expect(nodes).toMatchObject([{
      id: 'workspace-home',
      children: [{
        id: 'department',
        children: [{
          id: 'wiki',
          type: 'database',
          selectable: true,
          isWiki: true,
          children: [{ id: 'article', selectable: true }],
        }],
      }],
    }]);
    expect(childRequests()).toEqual([]);
    expect(server!.requests.some((request) => request.url.includes('/query'))).toBe(false);
  });

  it('recovers an omitted block host and its ancestors without reading page bodies', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [{
        object: 'page',
        id: 'nested',
        parent: { type: 'block_id', block_id: 'toggle' },
        properties: titleProp('Nested'),
      }],
      blocks: {
        toggle: {
          object: 'block',
          id: 'toggle',
          type: 'toggle',
          parent: { type: 'page_id', page_id: 'host' },
        },
      },
      pages: {
        host: {
          object: 'page',
          id: 'host',
          parent: { type: 'page_id', page_id: 'home' },
          properties: titleProp('Host'),
        },
        home: {
          object: 'page',
          id: 'home',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Home'),
        },
      },
    });

    expect(nodes).toMatchObject([{
      id: 'home',
      children: [{ id: 'host', children: [{ id: 'nested' }] }],
    }]);
    expect(childRequests()).toEqual([]);
  });

  it('resolves an omitted sub-item parent before applying native database ownership', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [{
        object: 'page',
        id: 'modules',
        parent: { type: 'database_id', database_id: 'wiki' },
        properties: {
          ...titleProp('Modules'),
          'Parent item': { type: 'relation', relation: [{ id: 'ansible' }] },
        },
      }],
      pages: {
        ansible: {
          object: 'page',
          id: 'ansible',
          parent: { type: 'database_id', database_id: 'wiki' },
          properties: titleProp('Ansible'),
        },
      },
      databases: {
        wiki: {
          object: 'database',
          id: 'wiki',
          title: richTitle('Wiki'),
          parent: { type: 'workspace', workspace: true },
          properties: { Verification: { type: 'verification' } },
        },
      },
    });

    expect(nodes).toMatchObject([{
      id: 'wiki',
      children: [{ id: 'ansible', children: [{ id: 'modules' }] }],
    }]);
    expect(childRequests()).toEqual([]);
    expect(server!.requests.filter((request) => request.url === '/v1/databases/wiki')).toHaveLength(1);
  });

  it('deduplicates UUID spellings and keeps full wiki metadata over a child-database block', async () => {
    const wikiId = 'abcdef12-1234-5678-9abc-def123456789';
    const compactWikiId = wikiId.replaceAll('-', '').toUpperCase();
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'block',
          id: compactWikiId,
          type: 'child_database',
          child_database: { title: 'Wiki' },
          parent: { type: 'workspace', workspace: true },
        },
        {
          object: 'database',
          id: wikiId,
          title: richTitle('Wiki'),
          is_inline: true,
          properties: { Verification: { type: 'verification' } },
          parent: { type: 'workspace', workspace: true },
        },
        {
          object: 'page',
          id: 'aabbccdd-1234-5678-9abc-def123456789',
          properties: titleProp('Article'),
          parent: { type: 'database_id', database_id: compactWikiId },
        },
        {
          object: 'page',
          id: 'AABBCCDD123456789ABCDEF123456789',
          properties: titleProp('Article duplicate'),
          parent: { type: 'database_id', database_id: wikiId },
        },
      ],
    });

    expect(nodes).toMatchObject([{
      id: wikiId,
      type: 'database',
      selectable: true,
      isWiki: true,
      rowCount: 1,
      children: [{ title: 'Article' }],
    }]);
    expect(flatten(nodes as TreeNode[])).toHaveLength(2);
    expect(server!.requests.filter((request) => request.method === 'GET')).toEqual([]);
  });

  it.each(['native', 'relation'] as const)('keeps every page reachable when %s parent edges form a normalized cycle', async (kind) => {
    const ids = ['aabbccdd-1234-5678-9abc-def123456789', 'bbccddee-1234-5678-9abc-def123456789'];
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: ids.map((id, index) => {
        const parentId = ids[1 - index].replaceAll('-', '').toUpperCase();
        return {
          object: 'page',
          id,
          parent: kind === 'native'
            ? { type: 'page_id', page_id: parentId }
            : { type: 'workspace', workspace: true },
          properties: {
            ...titleProp(id),
            ...(kind === 'relation' ? { 'Parent item': { type: 'relation', relation: [{ id: parentId }] } } : {}),
          },
        };
      }),
    });

    const parsed = NotionTreeResponseSchema.parse({ nodes });
    expect(parsed.nodes).toHaveLength(1);
    expect(flatten(parsed.nodes as TreeNode[]).map((node) => node.id).sort()).toEqual([...ids].sort());
    expect(childRequests()).toEqual([]);
    expect(server!.requests.filter((request) => request.method === 'GET')).toEqual([]);
  });

  it('stops ancestor discovery when an omitted parent points back to its child', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [{
        object: 'page',
        id: 'aabbccdd-1234-5678-9abc-def123456789',
        parent: { type: 'page_id', page_id: 'parent' },
        properties: titleProp('Child'),
      }],
      pages: {
        parent: {
          object: 'page',
          id: 'parent',
          parent: { type: 'page_id', page_id: 'AABBCCDD123456789ABCDEF123456789' },
          properties: titleProp('Parent'),
        },
      },
    });

    expect(nodes).toHaveLength(1);
    expect(flatten(nodes as TreeNode[]).map((node) => node.title).sort()).toEqual(['Child', 'Parent']);
    expect(server!.requests.filter((request) => request.method === 'GET').map((request) => request.url))
      .toEqual(['/v1/pages/parent']);
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

  it('marks a Board-layout database incompatible and keeps its cards selectable', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'ops',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Ops'),
        },
        {
          object: 'database',
          id: 'sprint',
          parent: { type: 'page_id', page_id: 'ops' },
          title: richTitle('Sprint'),
          layout: 'board',
        },
        {
          object: 'page',
          id: 'card-a',
          parent: { type: 'database_id', database_id: 'sprint' },
          properties: titleProp('Ship login'),
        },
      ],
    });

    const sprint = findById(nodes as TreeNode[], 'sprint');
    const card = findById(nodes as TreeNode[], 'card-a');
    const ops = findById(nodes as TreeNode[], 'ops');
    expect(sprint).toMatchObject({
      type: 'unsupported',
      selectable: false,
      reasonCode: 'board_layout',
      skipReason: NOTION_BOARD_REASON,
    });
    expect(card).toMatchObject({ type: 'page', selectable: true, isDatabaseRow: true, title: 'Ship login' });
    expect(sprint?.children.map((c) => c.id)).toEqual(['card-a']);
    expect(ops).toMatchObject({ type: 'page', selectable: true });
  });

  it('marks the host page of an inline Board incompatible', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'page',
          id: 'projects',
          parent: { type: 'workspace', workspace: true },
          properties: titleProp('Projects'),
        },
        {
          object: 'database',
          id: 'kanban',
          parent: { type: 'page_id', page_id: 'projects' },
          is_inline: true,
          title: richTitle('Delivery'),
          layout: 'board',
        },
        {
          object: 'page',
          id: 'card-1',
          parent: { type: 'database_id', database_id: 'kanban' },
          properties: titleProp('Write RFC'),
        },
      ],
    });

    expect(findById(nodes as TreeNode[], 'projects')).toMatchObject({
      type: 'unsupported',
      selectable: false,
      reasonCode: 'board_host',
      skipReason: NOTION_BOARD_REASON,
    });
    expect(findById(nodes as TreeNode[], 'kanban')).toMatchObject({
      type: 'unsupported',
      reasonCode: 'board_layout',
    });
    expect(findById(nodes as TreeNode[], 'card-1')).toMatchObject({
      type: 'page',
      selectable: true,
      isDatabaseRow: true,
    });
  });

  it('detects a Board from the views API when the database object has no layout field', async () => {
    const nodes = await treeFor({
      validToken: TOKEN,
      searchResults: [
        {
          object: 'database',
          id: 'tracker',
          parent: { type: 'workspace', workspace: true },
          title: richTitle('Tracker'),
        },
        {
          object: 'page',
          id: 'card-1',
          parent: { type: 'database_id', database_id: 'tracker' },
          properties: titleProp('Card'),
        },
      ],
      views: {
        tracker: [{ id: 'view-board', type: 'board', name: 'Board' }],
      },
    });

    expect(findById(nodes as TreeNode[], 'tracker')).toMatchObject({
      type: 'unsupported',
      reasonCode: 'board_layout',
      skipReason: NOTION_BOARD_REASON,
    });
    expect(findById(nodes as TreeNode[], 'card-1')).toMatchObject({ selectable: true, isDatabaseRow: true });
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

  it('treats a blank container that still has children as body content', () => {
    for (const block of [
      { type: 'toggle', toggle: { rich_text: [] }, has_children: true },
      { type: 'callout', callout: { rich_text: [], icon: { type: 'emoji', emoji: '📝' } }, has_children: true },
      { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [] }, has_children: true },
      { type: 'paragraph', paragraph: { rich_text: [] }, has_children: true },
    ]) {
      expect(rowHasBodyContent(list([block]))).toBe(true);
    }
  });

  it('treats a three-block empty template as no body once the probe reads it whole', () => {
    expect(
      rowHasBodyContent(
        list([
          { type: 'heading_2', heading_2: { rich_text: [] } },
          { type: 'callout', callout: { rich_text: [] } },
          { type: 'divider', divider: {} },
        ]),
      ),
    ).toBe(false);
  });

  it('still counts an unread remainder as body content', () => {
    expect(rowHasBodyContent(list([{ type: 'paragraph', paragraph: { rich_text: [] } }], true))).toBe(true);
  });
});

describe('isBoardLayout', () => {
  it('reads layout, views, and format.board_* without treating a wiki as a board', () => {
    expect(isBoardLayout({ object: 'database', layout: 'board' })).toBe(true);
    expect(isBoardLayout({ object: 'database', layout: { type: 'board' } })).toBe(true);
    expect(isBoardLayout({ object: 'database', views: [{ type: 'board' }] })).toBe(true);
    expect(isBoardLayout({ object: 'database', format: { board_columns: [] } })).toBe(true);
    expect(isBoardLayout({ object: 'database', type: 'board' })).toBe(true);
    expect(isBoardLayout({ object: 'database', layout: 'table' })).toBe(false);
    expect(isBoardLayout({
      object: 'database',
      layout: 'board',
      properties: { Verification: { type: 'verification' } },
    })).toBe(true);
  });
});
