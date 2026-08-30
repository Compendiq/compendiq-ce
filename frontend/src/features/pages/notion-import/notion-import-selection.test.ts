import { describe, expect, it } from 'vitest';
import {
  NOTION_UNSUPPORTED_LABEL,
  type NotionTreeDatabaseNode,
  type NotionTreeNode,
  type NotionTreePageNode,
  type NotionTreeSkippedNode,
} from '@compendiq/contracts';
import {
  allImportIds,
  availableDatabaseModes,
  calculateBatchCount,
  canContinueNotionPick,
  chunkPageIds,
  databaseRowIds,
  describeNode,
  documentPageIds,
  effectiveDatabaseMode,
  filterTreeNodes,
  foldForChildren,
  formatConfirmCopy,
  formatNodeBadge,
  groupSelectionState,
  importedPageIds,
  isDatabaseNode,
  NOTION_IMPORT_MAX_PAGES,
  requestDatabaseModes,
  searchTreeNodes,
  selectableIdsInGroup,
  selectedImportIds,
  shouldCommitImportResult,
  summarizeImport,
  toggleSelectedPageGroup,
  unimportedPageIds,
  type DatabaseModes,
} from './notion-import-selection';

const SKIP = NOTION_UNSUPPORTED_LABEL;

function page(id: string, title: string, children: NotionTreeNode[] = []): NotionTreePageNode {
  return { id, title, type: 'page', selectable: true, children };
}

/** A database row page: it imports as an article, not as a plain page. */
function row(id: string, title: string, children: NotionTreeNode[] = []): NotionTreePageNode {
  return { id, title, type: 'page', selectable: true, isDatabaseRow: true, children };
}

type DatabaseOverrides = Partial<
  Pick<
    NotionTreeDatabaseNode,
    | 'recommendedMode'
    | 'rowContent'
    | 'isWiki'
    | 'rowCount'
    | 'columns'
    | 'alreadyImported'
    | 'children'
  >
>;

/** An importable database. `rowCount` defaults to the rows actually listed. */
function database(id: string, title: string, overrides: DatabaseOverrides = {}): NotionTreeDatabaseNode {
  const children = overrides.children ?? [];
  return {
    id,
    title,
    type: 'database',
    selectable: true,
    recommendedMode: 'table',
    rowContent: 'none',
    isWiki: false,
    rowCount: children.length,
    columns: ['Name', 'Stage'],
    ...overrides,
    children,
  };
}

/** A wiki database: its rows carry bodies, so `table` is never on offer. */
function wiki(id: string, title: string, overrides: DatabaseOverrides = {}): NotionTreeDatabaseNode {
  return database(id, title, {
    isWiki: true,
    recommendedMode: 'pages',
    rowContent: 'some',
    ...overrides,
  });
}

type SkippedOverrides = Partial<
  Pick<NotionTreeSkippedNode, 'skipReason' | 'reasonCode' | 'linkedFromId' | 'children'>
>;

/** The only shape that cannot be imported at all. */
function unsupported(id: string, title: string, overrides: SkippedOverrides = {}): NotionTreeSkippedNode {
  return {
    id,
    title,
    type: 'unsupported',
    selectable: false,
    skipReason: SKIP,
    children: [],
    ...overrides,
  };
}

/** Mixed workspace: pages + an importable database + things with no local shape. */
const MIXED: NotionTreeNode[] = [
  page('handbook', 'Handbook', [
    page('onboarding', 'Onboarding', [page('nested', 'Nested notes')]),
    database('crm', 'CRM', { rowCount: 4 }),
    unsupported('linked:handbook:crm', 'CRM (linked view)', {
      reasonCode: 'linked_database',
      linkedFromId: 'crm',
    }),
    unsupported('board', 'Whiteboard', { reasonCode: 'canvas' }),
  ]),
  page('row-listed', 'Customer Acme (row listed independently)'),
];

describe('toggleSelectedPageGroup', () => {
  it('refuses to select an unsupported node with nothing importable under it', () => {
    const empty = new Set<string>();
    expect(toggleSelectedPageGroup(empty, unsupported('board', 'Whiteboard'))).toEqual({
      selected: empty,
      limitExceeded: false,
    });
  });

  it('refuses to select a skipped database or anything under it', () => {
    const crm = database('crm', 'CRM', { children: [row('row-1', 'Acme')] });
    expect(toggleSelectedPageGroup(new Set<string>(), crm, { crm: 'skip' })).toEqual({
      selected: new Set<string>(),
      limitExceeded: false,
    });
  });

  it('selects a pages-mode database and every one of its rows in one call', () => {
    const wikiDb = wiki('wiki', 'Engineering Wiki', {
      children: [row('p1', 'Architecture'), row('p2', 'Runbook')],
    });

    const res = toggleSelectedPageGroup(new Set<string>(), wikiDb);
    expect(Array.from(res.selected)).toEqual(['wiki', 'p1', 'p2']);
    expect(res.limitExceeded).toBe(false);

    const unselect = toggleSelectedPageGroup(res.selected, wikiDb);
    expect(Array.from(unselect.selected)).toEqual([]);
  });

  it('selects only the database itself when it imports as a table', () => {
    const crm = database('crm', 'CRM', { children: [row('row-1', 'Acme'), row('row-2', 'Globex')] });

    const res = toggleSelectedPageGroup(new Set<string>(), crm, { crm: 'table' });
    expect(Array.from(res.selected)).toEqual(['crm']);

    expect(Array.from(toggleSelectedPageGroup(res.selected, crm, { crm: 'table' }).selected)).toEqual([]);
  });

  it('selects and deselects every importable node in a parent group', () => {
    const handbook = page('handbook', 'Handbook', [
      page('onboarding', 'Onboarding', [page('nested', 'Nested notes')]),
      database('crm', 'CRM', { rowCount: 4 }),
    ]);

    const selected = toggleSelectedPageGroup(new Set(), handbook);
    expect(selected).toEqual({
      selected: new Set(['handbook', 'onboarding', 'nested', 'crm']),
      limitExceeded: false,
    });
    expect(toggleSelectedPageGroup(selected.selected, handbook)).toEqual({
      selected: new Set(),
      limitExceeded: false,
    });
  });

  it('reports partially selected groups independently from leaf selection', () => {
    const handbook = page('handbook', 'Handbook', [
      page('onboarding', 'Onboarding'),
      page('security', 'Security'),
    ]);

    expect(groupSelectionState(handbook, new Set())).toBe('none');
    expect(groupSelectionState(handbook, new Set(['onboarding']))).toBe('some');
    expect(groupSelectionState(handbook, new Set(['handbook', 'onboarding', 'security']))).toBe('all');
  });

  it('reads a group state through the modes in force', () => {
    const crm = database('crm', 'CRM', { children: [row('row-1', 'Acme'), row('row-2', 'Globex')] });

    expect(groupSelectionState(crm, new Set(['crm']), { crm: 'table' })).toBe('all');
    expect(groupSelectionState(crm, new Set(['crm']), { crm: 'pages' })).toBe('some');
    expect(groupSelectionState(crm, new Set(['crm', 'row-1', 'row-2']), { crm: 'pages' })).toBe('all');
    expect(groupSelectionState(crm, new Set(['crm', 'row-1']), { crm: 'skip' })).toBe('none');
  });

  it('allows groups exceeding 200 pages to be selected for multi-batch import', () => {
    const selected = new Set(Array.from({ length: NOTION_IMPORT_MAX_PAGES - 1 }, (_, i) => `existing-${i}`));
    const group = page('parent', 'Parent', [page('child', 'Child')]);

    const result = toggleSelectedPageGroup(selected, group);

    expect(result.limitExceeded).toBe(false);
    expect(result.selected.has('parent')).toBe(true);
    expect(result.selected.has('child')).toBe(true);
    expect(result.selected.size).toBe(NOTION_IMPORT_MAX_PAGES + 1);
  });
});

describe('describeNode', () => {
  it('states a plain page imports as a page', () => {
    expect(describeNode(page('p1', 'Doc'))).toEqual({
      supported: true,
      badge: 'Page',
      action: 'Imports as a page',
    });
  });

  it('states a database row imports as an article', () => {
    expect(describeNode(row('r1', 'Acme'))).toEqual({
      supported: true,
      badge: 'Database row',
      action: 'Imports as an article',
    });
  });

  it('names the row count of a table-mode database', () => {
    expect(describeNode(database('db', 'CRM', { rowCount: 4 }))).toEqual({
      supported: true,
      badge: 'Database',
      action: 'Imports as one table · 4 rows',
    });
    expect(describeNode(database('db', 'CRM', { rowCount: 1 })).action).toBe(
      'Imports as one table · 1 row',
    );
    expect(describeNode(database('db', 'CRM', { rowCount: 0 })).action).toBe(
      'Imports as one table · 0 rows',
    );
  });

  it('names the article count of a pages-mode database', () => {
    const pagesDb = (rowCount: number) =>
      describeNode(database('db', 'CRM', { recommendedMode: 'pages', rowCount })).action;

    expect(pagesDb(0)).toBe('Imports as one page');
    expect(pagesDb(1)).toBe('Imports as one page with 1 article');
    expect(pagesDb(7)).toBe('Imports as one page with 7 articles');
  });

  it('states a skipped database stays in Notion', () => {
    expect(describeNode(database('db', 'CRM', { rowCount: 4 }), { db: 'skip' })).toEqual({
      supported: true,
      badge: 'Database',
      action: 'Excluded — stays in Notion',
    });
  });

  it('reports an unsupported node as unsupported, with its own skip reason', () => {
    const board = unsupported('board', 'Whiteboard', {
      skipReason: 'Whiteboards have no local shape yet',
      reasonCode: 'canvas',
    });
    expect(describeNode(board)).toEqual({
      supported: false,
      badge: 'Canvas',
      action: 'Whiteboards have no local shape yet',
    });
  });
});

describe('describeNode cautions', () => {
  const someContent = database('db', 'CRM', { rowContent: 'some', rowCount: 3 });
  const unknownContent = database('db', 'CRM', { rowContent: 'unknown', rowCount: 3 });

  it('cautions when a table override would flatten rows that have content', () => {
    const support = describeNode(someContent, { db: 'table' });
    expect(support.action).toBe('Imports as one table · 3 rows');
    expect(support.caution).toBeTruthy();
    expect(support.caution).toMatch(/page content/i);
  });

  it('cautions differently when the row content was never checked', () => {
    const unchecked = describeNode(unknownContent, { db: 'table' }).caution;
    expect(unchecked).toBeTruthy();
    expect(unchecked).toMatch(/not checked/i);
    expect(unchecked).not.toBe(describeNode(someContent, { db: 'table' }).caution);
  });

  it('stays quiet when every sampled row is body-less', () => {
    expect(describeNode(database('db', 'CRM', { rowContent: 'none', rowCount: 3 }), { db: 'table' }).caution)
      .toBeUndefined();
  });

  it('never cautions in pages or skip mode, whatever the rows hold', () => {
    expect(describeNode(someContent, { db: 'pages' }).caution).toBeUndefined();
    expect(describeNode(someContent, { db: 'skip' }).caution).toBeUndefined();
    expect(describeNode(unknownContent, { db: 'pages' }).caution).toBeUndefined();
    expect(describeNode(unknownContent, { db: 'skip' }).caution).toBeUndefined();
  });
});

describe('describeNode under an inherited fold', () => {
  it('says a folded row is part of the table above', () => {
    expect(describeNode(row('r1', 'Acme'), {}, 'table')).toEqual({
      supported: true,
      badge: 'Database row',
      action: 'Included in the table above',
    });
  });

  it('says everything under a skipped database stays in Notion', () => {
    expect(describeNode(row('r1', 'Acme'), {}, 'skip')).toEqual({
      supported: true,
      badge: 'Database row',
      action: 'Excluded — stays in Notion',
    });
    expect(describeNode(page('p1', 'Doc'), {}, 'skip').action).toBe('Excluded — stays in Notion');
  });

  it('lets an unsupported node keep its own reason under either fold', () => {
    const linked = unsupported('linked:handbook:crm', 'CRM (linked view)', {
      reasonCode: 'linked_database',
      linkedFromId: 'crm',
      skipReason: 'Linked views point at a database elsewhere',
    });

    expect(describeNode(linked, {}, 'table')).toEqual({
      supported: false,
      badge: 'Linked view',
      action: 'Linked views point at a database elsewhere',
    });
    expect(describeNode(linked, {}, 'skip')).toEqual({
      supported: false,
      badge: 'Linked view',
      action: 'Linked views point at a database elsewhere',
    });
  });

  it('denies a nested database a shape of its own under a fold', () => {
    const nested = database('inner', 'Inner', { recommendedMode: 'pages', rowCount: 2 });

    expect(describeNode(nested, { inner: 'pages' })).toEqual({
      supported: true,
      badge: 'Database',
      action: 'Imports as one page with 2 articles',
    });
    expect(describeNode(nested, { inner: 'pages' }, 'table').action).toBe('Included in the table above');
    expect(describeNode(nested, { inner: 'pages' }, 'skip').action).toBe('Excluded — stays in Notion');
  });
});

describe('foldForChildren', () => {
  it('folds children under a table or skip database, never under pages', () => {
    const crm = database('crm', 'CRM', { rowCount: 2 });

    expect(foldForChildren(crm)).toBe('table');
    expect(foldForChildren(crm, { crm: 'table' })).toBe('table');
    expect(foldForChildren(crm, { crm: 'skip' })).toBe('skip');
    expect(foldForChildren(crm, { crm: 'pages' })).toBeUndefined();
    expect(foldForChildren(wiki('w', 'Engineering Wiki'))).toBeUndefined();
  });

  it('never folds under a page or an unsupported node', () => {
    expect(foldForChildren(page('p', 'Doc'))).toBeUndefined();
    expect(foldForChildren(row('r', 'Acme'))).toBeUndefined();
    expect(foldForChildren(unsupported('board', 'Whiteboard'))).toBeUndefined();
  });

  it('keeps an inherited fold in force beneath every node it reaches', () => {
    const nestedPages = database('inner', 'Inner', { recommendedMode: 'pages', rowCount: 2 });

    expect(foldForChildren(page('p', 'Doc'), {}, 'table')).toBe('table');
    expect(foldForChildren(row('r', 'Acme'), {}, 'table')).toBe('table');
    expect(foldForChildren(unsupported('board', 'Whiteboard'), {}, 'skip')).toBe('skip');
    expect(foldForChildren(nestedPages, { inner: 'pages' }, 'table')).toBe('table');
    expect(foldForChildren(nestedPages, { inner: 'pages' }, 'skip')).toBe('skip');
    expect(foldForChildren(nestedPages, { inner: 'skip' }, 'table')).toBe('table');
  });
});

describe('database modes', () => {
  it('withholds table from a wiki and offers all three otherwise', () => {
    expect(availableDatabaseModes(database('db', 'CRM'))).toEqual(['table', 'pages', 'skip']);
    expect(availableDatabaseModes(wiki('w', 'Engineering Wiki'))).toEqual(['pages', 'skip']);
  });

  it('prefers an override over the scan recommendation', () => {
    const crm = database('crm', 'CRM');
    expect(effectiveDatabaseMode(crm)).toBe('table');
    expect(effectiveDatabaseMode(crm, {})).toBe('table');
    expect(effectiveDatabaseMode(crm, { other: 'skip' })).toBe('table');
    expect(effectiveDatabaseMode(crm, { crm: 'pages' })).toBe('pages');

    const engineering = wiki('w', 'Engineering Wiki');
    expect(effectiveDatabaseMode(engineering)).toBe('pages');
    expect(effectiveDatabaseMode(engineering, { w: 'skip' })).toBe('skip');
  });

  it('governs only itself in table mode, itself plus its rows in pages, nothing in skip', () => {
    const crm = database('crm', 'CRM', { children: [row('row-1', 'Acme'), row('row-2', 'Globex')] });

    expect(selectableIdsInGroup(crm)).toEqual(['crm']);
    expect(selectableIdsInGroup(crm, { crm: 'table' })).toEqual(['crm']);
    expect(selectableIdsInGroup(crm, { crm: 'pages' })).toEqual(['crm', 'row-1', 'row-2']);
    expect(selectableIdsInGroup(crm, { crm: 'skip' })).toEqual([]);
  });

  it('recognises database nodes', () => {
    expect(isDatabaseNode(database('db', 'CRM'))).toBe(true);
    expect(isDatabaseNode(wiki('w', 'Wiki'))).toBe(true);
    expect(isDatabaseNode(page('p', 'Doc'))).toBe(false);
    expect(isDatabaseNode(unsupported('board', 'Whiteboard'))).toBe(false);
  });
});

describe('selectedImportIds', () => {
  const TREE: NotionTreeNode[] = [
    database('crm', 'CRM', { children: [row('row-1', 'Acme'), row('row-2', 'Globex')] }),
  ];

  it('prunes ticked rows when the mode flips from pages to table', () => {
    const ticked = toggleSelectedPageGroup(new Set<string>(), TREE[0]!, { crm: 'pages' }).selected;
    expect(Array.from(ticked)).toEqual(['crm', 'row-1', 'row-2']);

    expect(selectedImportIds(TREE, ticked, { crm: 'pages' })).toEqual(['crm', 'row-1', 'row-2']);
    expect(selectedImportIds(TREE, ticked, { crm: 'table' })).toEqual(['crm']);
    expect(selectedImportIds(TREE, ticked, { crm: 'skip' })).toEqual([]);
  });

  it('exposes the same ids through allImportIds', () => {
    expect(allImportIds(TREE, { crm: 'pages' })).toEqual(['crm', 'row-1', 'row-2']);
    expect(allImportIds(TREE, { crm: 'table' })).toEqual(['crm']);
    expect(allImportIds(TREE, { crm: 'skip' })).toEqual([]);
  });

  it('drops ids that no node in the tree can import', () => {
    expect(
      selectedImportIds(
        MIXED,
        new Set(['handbook', 'crm', 'linked:handbook:crm', 'board', 'ghost']),
      ),
    ).toEqual(['handbook', 'crm']);
  });
});

describe('requestDatabaseModes', () => {
  const TREE: NotionTreeNode[] = [
    page('handbook', 'Handbook', [database('crm', 'CRM', { rowCount: 2 })]),
    wiki('playbooks', 'Playbooks', { children: [row('play-1', 'Runbook')] }),
    database('archive', 'Archive', { rowCount: 9 }),
  ];

  it('names the effective mode of every selected database and omits the rest', () => {
    expect(requestDatabaseModes(TREE, new Set(['handbook', 'crm', 'playbooks', 'play-1']))).toEqual({
      crm: 'table',
      playbooks: 'pages',
    });
    expect(requestDatabaseModes(TREE, new Set(['crm']), { crm: 'pages' })).toEqual({ crm: 'pages' });
    expect(requestDatabaseModes(TREE, new Set(['handbook']))).toEqual({});
  });

  it('omits a skipped database because nothing can select it', () => {
    const modes: DatabaseModes = { archive: 'skip' };
    const selected = new Set(allImportIds(TREE, modes));

    expect(selected.has('archive')).toBe(false);
    expect(requestDatabaseModes(TREE, selected, modes)).toEqual({
      crm: 'table',
      playbooks: 'pages',
    });
  });
});

describe('formatNodeBadge', () => {
  it('names the Notion object type of every importable variant', () => {
    expect(formatNodeBadge(page('p', 'Doc'))).toBe('Page');
    expect(formatNodeBadge(row('r', 'Acme'))).toBe('Database row');
    expect(formatNodeBadge(database('db', 'CRM'))).toBe('Database');
    expect(formatNodeBadge(wiki('w', 'Engineering Wiki'))).toBe('Wiki');
  });

  it('names each unsupported reason code', () => {
    const badgeFor = (reasonCode: string) => formatNodeBadge(unsupported('u', 'U', { reasonCode }));

    expect(badgeFor('linked_database')).toBe('Linked view');
    expect(badgeFor('data_source')).toBe('Data source');
    expect(badgeFor('inline_database')).toBe('Inline database');
    expect(badgeFor('child_database')).toBe('Nested database');
    expect(badgeFor('canvas')).toBe('Canvas');
    expect(badgeFor('audio_block')).toBe('Audio block');
    expect(badgeFor('ai_block')).toBe('Ai block');
    expect(badgeFor('unsupported')).toBe('Unsupported');
    expect(formatNodeBadge(unsupported('l', 'L', { linkedFromId: 'crm' }))).toBe('Linked view');
    expect(formatNodeBadge(unsupported('u', 'U'))).toBe('Unsupported');
  });

  it('never leaves a row without a badge', () => {
    const nodes: NotionTreeNode[] = [
      ...MIXED,
      ...MIXED[0]!.children,
      page('p', 'Doc'),
      row('r', 'Acme'),
      database('db', 'CRM'),
      wiki('w', 'Engineering Wiki'),
      unsupported('u', 'U'),
      unsupported('u2', 'U2', { reasonCode: 'synced_block' }),
    ];

    for (const node of nodes) {
      const badge = formatNodeBadge(node);
      expect(badge, `no badge for ${node.id}`).not.toBeNull();
      expect(badge.length).toBeGreaterThan(0);
    }
  });
});

describe('summarizeImport / formatConfirmCopy', () => {
  const TREE: NotionTreeNode[] = [
    page('doc', 'Doc', [page('sub', 'Sub note')]),
    database('flat', 'Flat DB', { children: [row('f1', 'F1'), row('f2', 'F2')] }),
    wiki('wiki', 'Engineering Wiki', {
      children: [row('w1', 'Architecture'), row('w2', 'Runbook')],
    }),
    database('gone', 'Archive', { children: [row('g1', 'G1')] }),
    unsupported('board', 'Whiteboard', { reasonCode: 'canvas' }),
  ];
  const MODES: DatabaseModes = { gone: 'skip' };
  /** Everything ticked, including rows a table fold and a skip will drop. */
  const SELECTED = new Set(['doc', 'sub', 'flat', 'f1', 'wiki', 'w1', 'w2', 'gone', 'g1']);

  it('counts every shape the confirmed selection lands in', () => {
    expect(summarizeImport(TREE, SELECTED, MODES)).toEqual({
      importCount: 6,
      importIds: ['doc', 'sub', 'flat', 'wiki', 'w1', 'w2'],
      pageCount: 2,
      articleCount: 2,
      tableCount: 1,
      collectionCount: 1,
      skippedDatabaseCount: 1,
      unsupportedCount: 1,
    });
  });

  it('lists the shapes that import and names what stays behind', () => {
    const copy = formatConfirmCopy(summarizeImport(TREE, SELECTED, MODES));
    expect(copy).toBe(
      '2 pages, 2 articles, 1 table and 1 database page will import.' +
        ' 1 database is excluded, 1 item cannot be imported and stay in Notion.',
    );
    expect(copy).not.toMatch(/token|secret_|ntn_/i);
  });

  it('says nothing is selected when nothing is', () => {
    expect(
      formatConfirmCopy({
        importCount: 0,
        pageCount: 0,
        articleCount: 0,
        tableCount: 0,
        collectionCount: 0,
        skippedDatabaseCount: 2,
        unsupportedCount: 3,
      }),
    ).toBe('Nothing is selected.');
  });

  it('uses singular nouns for one of each shape', () => {
    expect(
      formatConfirmCopy({
        importCount: 4,
        pageCount: 1,
        articleCount: 1,
        tableCount: 1,
        collectionCount: 1,
        skippedDatabaseCount: 1,
        unsupportedCount: 1,
      }),
    ).toBe(
      '1 page, 1 article, 1 table and 1 database page will import.' +
        ' 1 database is excluded, 1 item cannot be imported and stay in Notion.',
    );
  });

  it('names a lone shape without a list, and plural leftovers', () => {
    expect(
      formatConfirmCopy({
        importCount: 1,
        pageCount: 1,
        articleCount: 0,
        tableCount: 0,
        collectionCount: 0,
        skippedDatabaseCount: 0,
        unsupportedCount: 0,
      }),
    ).toBe('1 page will import.');

    expect(
      formatConfirmCopy({
        importCount: 2,
        pageCount: 0,
        articleCount: 0,
        tableCount: 2,
        collectionCount: 0,
        skippedDatabaseCount: 2,
        unsupportedCount: 3,
      }),
    ).toBe('2 tables will import. 2 databases are excluded, 3 items cannot be imported and stay in Notion.');
  });

  it('announces batching once the selection outgrows one request', () => {
    expect(
      formatConfirmCopy({
        importCount: 250,
        pageCount: 250,
        articleCount: 0,
        tableCount: 0,
        collectionCount: 0,
        skippedDatabaseCount: 0,
        unsupportedCount: 0,
      }),
    ).toBe('250 pages will import in 2 batches (200 items/batch).');
  });

  it('does not count a linked-view clone as a second database', () => {
    const summary = summarizeImport(MIXED, new Set(['handbook']));
    expect(summary.skippedDatabaseCount).toBe(0);
    expect(summary.unsupportedCount).toBe(2);
    expect(formatConfirmCopy(summary)).toBe(
      '1 page will import. 2 items cannot be imported and stay in Notion.',
    );
  });

  it('excludes selected rows of skip-mode databases from importIds', () => {
    const tree = [page('handbook', 'Handbook', [database('crm', 'CRM', { children: [row('row-1', 'Row 1')] })])];
    const summary = summarizeImport(tree, new Set(['handbook', 'crm', 'row-1']), { crm: 'skip' });

    expect(summary.importIds).toEqual(['handbook']);
    expect(summary.importCount).toBe(1);
    expect(summary.skippedDatabaseCount).toBe(1);
  });
});

describe('searchTreeNodes', () => {
  it('keeps a child when the query matches the ancestor path', () => {
    const tree = [page('handbook', 'Handbook', [page('notes', 'Notes')])];
    const { filtered, matchedIds } = searchTreeNodes(tree, 'handbook / notes');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.children.map((c) => c.title)).toEqual(['Notes']);
    expect(matchedIds.has('handbook')).toBe(true);
    expect(matchedIds.has('notes')).toBe(true);
  });
});

describe('multi-batch and incremental helpers', () => {
  it('calculates batch counts and chunks page ids', () => {
    expect(calculateBatchCount(0)).toBe(0);
    expect(calculateBatchCount(100)).toBe(1);
    expect(calculateBatchCount(200)).toBe(1);
    expect(calculateBatchCount(201)).toBe(2);
    expect(calculateBatchCount(450)).toBe(3);

    const ids = Array.from({ length: 450 }, (_, i) => `p${i}`);
    const chunks = chunkPageIds(ids, 200);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(200);
    expect(chunks[1]).toHaveLength(200);
    expect(chunks[2]).toHaveLength(50);
  });

  it('filters unimported vs imported pages', () => {
    const p1: NotionTreeNode = { ...page('p1', 'P1'), alreadyImported: true };
    const p2: NotionTreeNode = { ...page('p2', 'P2'), alreadyImported: false };
    const tree = [p1, p2];

    expect(unimportedPageIds(tree)).toEqual(['p2']);
    expect(importedPageIds(tree)).toEqual(['p1']);

    const filtered = filterTreeNodes(tree, true);
    expect(filtered).toEqual([p2]);
  });

  it('counts databases as importable when splitting imported from unimported', () => {
    const tree: NotionTreeNode[] = [
      { ...page('p1', 'P1'), alreadyImported: true },
      page('p2', 'P2'),
      database('db-new', 'New DB', { rowCount: 2 }),
      database('db-old', 'Old DB', { rowCount: 2, alreadyImported: true }),
      database('db-gone', 'Gone DB', { rowCount: 2 }),
    ];

    expect(unimportedPageIds(tree, { 'db-gone': 'skip' })).toEqual(['p2', 'db-new']);
    expect(importedPageIds(tree, { 'db-gone': 'skip' })).toEqual(['p1', 'db-old']);
  });

  it('filters document pages vs database rows and keeps the database itself visible', () => {
    const doc: NotionTreeNode = { ...page('d1', 'Doc'), isDatabaseRow: false };
    const rowNode = row('r1', 'Row');
    const db = database('db1', 'DB', { children: [rowNode] });
    const board = unsupported('board', 'Whiteboard');
    const tree = [doc, db, board];

    expect(documentPageIds(tree)).toEqual(['d1']);
    expect(databaseRowIds(tree)).toEqual(['r1']);

    // Hiding rows hides the rows, not the database — a database imports on its
    // own. A childless unsupported node is pure noise and goes.
    const filtered = filterTreeNodes(tree, { hideDatabaseRows: true });
    expect(filtered.map((node) => node.id)).toEqual(['d1', 'db1']);
    expect(filtered[1]!.children).toEqual([]);
  });

  it('allows continue when any pages are selected', () => {
    expect(canContinueNotionPick(0)).toBe(false);
    expect(canContinueNotionPick(1)).toBe(true);
    expect(canContinueNotionPick(200)).toBe(true);
    expect(canContinueNotionPick(450)).toBe(true);
  });
});

describe('shouldCommitImportResult', () => {
  it('commits only while the wizard is still open on confirm', () => {
    expect(shouldCommitImportResult('confirm', true)).toBe(true);
    expect(shouldCommitImportResult('pick', true)).toBe(false);
    expect(shouldCommitImportResult('result', true)).toBe(false);
    expect(shouldCommitImportResult('confirm', false)).toBe(false);
  });
});
