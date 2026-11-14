import { describe, expect, it } from 'vitest';
import {
  ConnectNotionSchema,
  NOTION_BOARD_REASON,
  NOTION_UNSUPPORTED_LABEL,
  NotionConnectionResponseSchema,
  NotionImportAcceptedSchema,
  NotionImportRequestSchema,
  NotionImportResponseSchema,
  NotionImportStatusSchema,
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

  it('accepts a Board database marked incompatible with selectable row children', () => {
    expect(NOTION_BOARD_REASON).toBe('Board view is not compatible — import cards as articles');
    const tree = NotionTreeResponseSchema.parse({
      nodes: [
        {
          id: 'sprint',
          title: 'Sprint board',
          type: 'unsupported',
          selectable: false,
          skipReason: NOTION_BOARD_REASON,
          reasonCode: 'board_layout',
          children: [
            {
              id: 'card-1',
              title: 'Ship login',
              type: 'page',
              selectable: true,
              isDatabaseRow: true,
              children: [],
            },
          ],
        },
      ],
    });
    const board = tree.nodes[0]!;
    expect(board.type).toBe('unsupported');
    expect(board.selectable).toBe(false);
    if (board.selectable) throw new Error('expected skipped node');
    expect(board.skipReason).toBe(NOTION_BOARD_REASON);
    expect(board.children[0]).toMatchObject({ type: 'page', selectable: true, isDatabaseRow: true });
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

describe('NotionImportAcceptedSchema', () => {
  it('is only the 202 body — no items, no token', () => {
    expect(NotionImportAcceptedSchema.parse({ status: 'importing' })).toEqual({ status: 'importing' });
    expect(() => NotionImportAcceptedSchema.parse({ status: 'importing', items: [] })).toThrow();
    expect(() => NotionImportAcceptedSchema.parse({ status: 'complete', items: [] })).toThrow();
  });
});

describe('NotionImportStatusSchema', () => {
  it('discriminates idle, importing, complete, and error without a token', () => {
    expect(NotionImportStatusSchema.parse({ status: 'idle' })).toEqual({ status: 'idle' });
    expect(NotionImportStatusSchema.parse({ status: 'importing' })).toEqual({ status: 'importing' });
    expect(
      NotionImportStatusSchema.parse({
        status: 'complete',
        items: [{ notionPageId: 'p1', status: 'success', localPageId: 9 }],
      }),
    ).toEqual({
      status: 'complete',
      items: [{ notionPageId: 'p1', status: 'success', localPageId: 9 }],
    });
    expect(NotionImportStatusSchema.parse({ status: 'error', error: 'Notion resource not found' })).toEqual({
      status: 'error',
      error: 'Notion resource not found',
    });
    expect(() => NotionImportStatusSchema.parse({ status: 'complete' })).toThrow();
    expect(() => NotionImportStatusSchema.parse({ status: 'error' })).toThrow();
    expect(() => NotionImportStatusSchema.parse({ status: 'idle', token: 'secret' })).toThrow();
  });
});

describe('#1739 existing Notion local-parent contract', () => {
  const accepted = [
    { name: 'one-number', input: 1, value: '1', red: false },
    { name: 'max-number', input: 2_147_483_647, value: '2147483647', red: false },
    { name: 'one-string', input: '1', value: '1', red: false },
    { name: 'max-string', input: '2147483647', value: '2147483647', red: false },
    { name: 'padded-one', input: '0001', value: '1', red: true },
    { name: 'padded-max', input: '0002147483647', value: '2147483647', red: true },
    { name: 'long-padded-one', input: `${'0'.repeat(256)}1`, value: '1', red: true },
    { name: 'long-padded-max', input: `${'0'.repeat(256)}2147483647`, value: '2147483647', red: true },
  ];
  const rejected: Array<{ name: string; input: unknown; red?: boolean }> = [
    { name: 'zero-number', input: 0, red: true },
    { name: 'zero-string', input: '0', red: true },
    { name: 'negative-number', input: -1, red: true },
    { name: 'negative-string', input: '-1', red: true },
    { name: 'overbound-number', input: 2_147_483_648, red: true },
    { name: 'overbound-string', input: '2147483648', red: true },
    { name: 'unsafe-number', input: 9_007_199_254_740_992, red: true },
    { name: 'unsafe-string', input: '9007199254740993', red: true },
    { name: 'fraction-number', input: 1.5, red: true },
    { name: 'nan', input: NaN },
    { name: 'positive-infinity', input: Infinity },
    { name: 'negative-infinity', input: -Infinity },
    { name: 'rounded-fraction-string', input: '2147483647.00000001', red: true },
    { name: 'decimal-string', input: '1.0', red: true },
    { name: 'exponent-string', input: '1e3', red: true },
    { name: 'hex-string', input: '0x10', red: true },
    { name: 'plus-sign', input: '+1', red: true },
    { name: 'surrounding-space', input: ' 1 ', red: true },
    { name: 'trailing-newline', input: '1\n', red: true },
    { name: 'alphabetic', input: 'abc', red: true },
    { name: 'empty', input: '', red: true },
    { name: 'unicode-digit', input: '١', red: true },
    { name: 'true', input: true },
    { name: 'false', input: false },
    { name: 'null', input: null },
    { name: 'object', input: {} },
    { name: 'empty-array', input: [] },
    { name: 'singleton-array', input: [1] },
    { name: 'overbound-decimal', input: '2147483648.0', red: true },
    { name: 'negative-zero-string', input: '-0', red: true },
    { name: 'leading-tab', input: '\t1', red: true },
    { name: 'padded-zero', input: '000', red: true },
    { name: 'infinity-string', input: 'Infinity', red: true },
  ];
  for (const entry of accepted) {
    it(`#1739 ${entry.red ? 'RED' : 'CONTROL'} Notion parent normalizes ${entry.name}`, () => {
      const parsed = NotionImportRequestSchema.parse({ pageIds: ['notes'], parentId: entry.input });
      expect(parsed.parentId).toBe(entry.value);
      expect(typeof parsed.parentId).toBe('string');
      expect(parsed.pageIds).toEqual(['notes']);
      expect(parsed.visibility).toBe('shared');
    });
  }
  for (const entry of rejected) {
    it(`#1739 ${entry.red ? 'RED' : 'CONTROL'} Notion parent rejects ${entry.name}`, () => {
      expect(NotionImportRequestSchema.safeParse({ pageIds: ['notes'], parentId: entry.input }).success).toBe(false);
    });
  }
  it('#1739 CONTROL Notion parent omission remains optional', () => {
    expect(NotionImportRequestSchema.parse({ pageIds: ['notes'] })).not.toHaveProperty('parentId');
  });
  it('#1739 CONTROL explicit undefined Notion parent remains optional', () => {
    expect(NotionImportRequestSchema.parse({ pageIds: ['notes'], parentId: undefined }).parentId).toBeUndefined();
  });
  for (const pageIds of [['notes', 'crm'], ['9007199254740993']]) {
    it(`#1739 CONTROL Notion external resource IDs remain literal (${pageIds.join(',')})`, () => {
      expect(NotionImportRequestSchema.parse({ pageIds, parentId: '1' }).pageIds).toEqual(pageIds);
    });
  }
});
