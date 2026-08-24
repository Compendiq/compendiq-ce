import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NOTION_UNSUPPORTED_LABEL, NotionTreeResponseSchema } from '@compendiq/contracts';
import { startFakeNotionServer, type FakeNotionServer } from './__fixtures__/fake-notion-server.js';
import { NotionClient, setNotionApiBaseUrlForTests } from './notion-client.js';
import { fetchNotionWorkspaceTree } from './notion-tree.js';

const TOKEN = 'secret_tree_ntn_never_echo';

type TreeNode = {
  id: string;
  title: string;
  type: string;
  selectable: boolean;
  skipReason?: string;
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

  it('builds a mixed tree: pages selectable, databases and unsupported not', async () => {
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
      selectable: false,
      skipReason: NOTION_UNSUPPORTED_LABEL,
      title: 'CRM',
    });
    expect(linked).toMatchObject({
      type: 'database',
      selectable: false,
      skipReason: NOTION_UNSUPPORTED_LABEL,
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

  it('source never queries databases and never talks to api.notion.com', () => {
    const src = readFileSync(new URL('./notion-tree.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/databases\/.*query/);
    expect(src).not.toContain('queryDatabase');
    expect(src).not.toContain('api.notion.com');
  });
});
