import { describe, expect, it } from 'vitest';
import {
  ConnectNotionSchema,
  NOTION_UNSUPPORTED_LABEL,
  NotionConnectionResponseSchema,
  NotionImportRequestSchema,
  NotionImportResponseSchema,
  NotionTreeResponseSchema,
} from './notion.js';

describe('ConnectNotionSchema', () => {
  it('accepts a non-empty token', () => {
    expect(ConnectNotionSchema.parse({ token: 'secret_test_token' })).toEqual({
      token: 'secret_test_token',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(ConnectNotionSchema.parse({ token: '  ntn_abc  ' })).toEqual({ token: 'ntn_abc' });
  });

  it('rejects an empty or whitespace-only token', () => {
    expect(() => ConnectNotionSchema.parse({ token: '' })).toThrow();
    expect(() => ConnectNotionSchema.parse({ token: '   ' })).toThrow();
  });
});

describe('NotionConnectionResponseSchema', () => {
  it('exposes only hasToken — never a token field', () => {
    expect(NotionConnectionResponseSchema.parse({ hasToken: true })).toEqual({ hasToken: true });
    expect(Object.keys(NotionConnectionResponseSchema.shape)).toEqual(['hasToken']);
  });

  it('strips unknown keys including a leaked token (strict)', () => {
    expect(() =>
      NotionConnectionResponseSchema.parse({ hasToken: true, token: 'secret_should_not_pass' }),
    ).toThrow();
  });
});

describe('NotionTreeResponseSchema', () => {
  const page = {
    id: 'page-1',
    title: 'Handbook',
    type: 'page' as const,
    selectable: true as const,
    children: [],
  };

  const database = {
    id: 'db-1',
    title: 'Filesystem Hierarchy',
    type: 'database' as const,
    selectable: true as const,
    recommendedMode: 'table' as const,
    rowContent: 'none' as const,
    isWiki: false,
    rowCount: 12,
    columns: ['Name', 'Purpose'],
    children: [],
  };

  it('uses the exact skip label on non-selectable nodes', () => {
    expect(NOTION_UNSUPPORTED_LABEL).toBe('Not supported — stays in Notion');
    const tree = NotionTreeResponseSchema.parse({
      nodes: [
        {
          ...page,
          children: [
            {
              id: 'canvas-1',
              title: 'Sketches',
              type: 'unsupported',
              selectable: false,
              skipReason: NOTION_UNSUPPORTED_LABEL,
              reasonCode: 'canvas',
              children: [],
            },
          ],
        },
      ],
    });
    const skipped = tree.nodes[0]!.children[0]!;
    expect(skipped.type).toBe('unsupported');
    expect(skipped.selectable).toBe(false);
    if (skipped.selectable) throw new Error('expected skipped node');
    expect(skipped.skipReason).toBe(NOTION_UNSUPPORTED_LABEL);
  });

  it('accepts a selectable database carrying its import shape', () => {
    const tree = NotionTreeResponseSchema.parse({ nodes: [database] });
    const node = tree.nodes[0]!;
    expect(node.type).toBe('database');
    if (!node.selectable || node.type !== 'database') throw new Error('expected database node');
    expect(node.recommendedMode).toBe('table');
    expect(node.rowContent).toBe('none');
    expect(node.isWiki).toBe(false);
    expect(node.rowCount).toBe(12);
    expect(node.columns).toEqual(['Name', 'Purpose']);
  });

  it('rejects a database missing its import shape, and a page carrying skipReason', () => {
    expect(() =>
      NotionTreeResponseSchema.parse({
        nodes: [{ id: 'db-1', title: 'CRM', type: 'database', selectable: true, children: [] }],
      }),
    ).toThrow();
    expect(() =>
      NotionTreeResponseSchema.parse({ nodes: [{ ...database, recommendedMode: 'skip' }] }),
    ).toThrow();
    expect(() =>
      NotionTreeResponseSchema.parse({
        nodes: [
          {
            id: 'page-1',
            title: 'Handbook',
            type: 'page',
            selectable: true,
            skipReason: NOTION_UNSUPPORTED_LABEL,
            children: [],
          },
        ],
      }),
    ).toThrow();
  });

  it('strips a leaked token on the tree document (strict)', () => {
    expect(() =>
      NotionTreeResponseSchema.parse({
        nodes: [page],
        token: 'secret_should_not_pass',
      }),
    ).toThrow();
  });

  it('accepts a linked-view clone with linkedFromId and a distinct id', () => {
    const tree = NotionTreeResponseSchema.parse({
      nodes: [
        {
          id: 'linked:handbook:db-1',
          title: 'CRM',
          type: 'unsupported',
          selectable: false,
          skipReason: NOTION_UNSUPPORTED_LABEL,
          reasonCode: 'linked_database',
          linkedFromId: 'db-1',
          children: [],
        },
      ],
    });
    const node = tree.nodes[0]!;
    if (node.selectable) throw new Error('expected skipped node');
    expect(node.linkedFromId).toBe('db-1');
    expect(node.id).toBe('linked:handbook:db-1');
  });
});

describe('NotionImportRequestSchema', () => {
  it('requires a non-empty pageIds list and defaults visibility to shared', () => {
    expect(NotionImportRequestSchema.parse({ pageIds: ['page-1'] })).toEqual({
      pageIds: ['page-1'],
      visibility: 'shared',
    });
  });

  it('accepts local destination fields like standalone create', () => {
    expect(
      NotionImportRequestSchema.parse({
        pageIds: ['a', 'b'],
        spaceKey: 'wiki',
        parentId: 12,
        visibility: 'private',
      }),
    ).toEqual({
      pageIds: ['a', 'b'],
      spaceKey: 'wiki',
      parentId: '12',
      visibility: 'private',
    });
  });

  it('rejects an empty selection and a leaked token field (strict)', () => {
    expect(() => NotionImportRequestSchema.parse({ pageIds: [] })).toThrow();
    expect(() =>
      NotionImportRequestSchema.parse({ pageIds: ['page-1'], token: 'secret_should_not_pass' }),
    ).toThrow();
  });

  it('accepts overwriteExisting and every implemented databaseMode', () => {
    expect(
      NotionImportRequestSchema.parse({
        pageIds: ['page-1'],
        overwriteExisting: true,
        databaseModes: { 'db-1': 'skip', 'db-2': 'table', 'db-3': 'pages' },
      }),
    ).toEqual({
      pageIds: ['page-1'],
      visibility: 'shared',
      overwriteExisting: true,
      databaseModes: { 'db-1': 'skip', 'db-2': 'table', 'db-3': 'pages' },
    });
  });

  it('rejects a database mode outside skip/table/pages', () => {
    expect(() =>
      NotionImportRequestSchema.parse({ pageIds: ['page-1'], databaseModes: { crm: 'articles' } }),
    ).toThrow();
    expect(() =>
      NotionImportRequestSchema.parse({ pageIds: ['page-1'], databaseModes: { crm: 'collection' } }),
    ).toThrow();
  });
});

describe('NotionImportResponseSchema', () => {
  it('reports per-item success, skip, fail, and already_imported without a token', () => {
    const parsed = NotionImportResponseSchema.parse({
      items: [
        { notionPageId: 'p1', status: 'success', localPageId: 9 },
        { notionPageId: 'db1', status: 'skip', reason: NOTION_UNSUPPORTED_LABEL },
        { notionPageId: 'p2', status: 'fail', reason: 'Notion resource not found' },
        { notionPageId: 'p3', status: 'already_imported', localPageId: 4 },
      ],
    });
    expect(parsed.items.map((i) => i.status)).toEqual([
      'success',
      'skip',
      'fail',
      'already_imported',
    ]);
    expect(() =>
      NotionImportResponseSchema.parse({
        items: [{ notionPageId: 'p1', status: 'success', localPageId: 1 }],
        token: 'secret_should_not_pass',
      }),
    ).toThrow();
  });
});
