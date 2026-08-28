import { describe, expect, it } from 'vitest';
import { NOTION_UNSUPPORTED_LABEL, type NotionTreeNode } from '@compendiq/contracts';
import {
  calculateBatchCount,
  canContinueNotionPick,
  chunkPageIds,
  databaseRowIds,
  documentPageIds,
  filterTreeNodes,
  formatConfirmCopy,
  formatNodeBadge,
  groupSelectionState,
  importedPageIds,
  NOTION_IMPORT_MAX_PAGES,
  selectablePageIds,
  shouldCommitImportResult,
  summarizeImport,
  toggleSelectedPageGroup,
  unimportedPageIds,
} from './notion-import-selection';
const SKIP = NOTION_UNSUPPORTED_LABEL;

function page(id: string, title: string, children: NotionTreeNode[] = []): NotionTreeNode {
  return { id, title, type: 'page', selectable: true, children };
}

function database(id: string, title: string, children: NotionTreeNode[] = []): NotionTreeNode {
  return {
    id,
    title,
    type: 'database',
    selectable: false,
    skipReason: SKIP,
    children,
  };
}

function unsupported(id: string, title: string): NotionTreeNode {
  return {
    id,
    title,
    type: 'unsupported',
    selectable: false,
    skipReason: SKIP,
    children: [],
  };
}

/** Mixed workspace: pages + a database + an independently listed row-page. */
const MIXED: NotionTreeNode[] = [
  page('handbook', 'Handbook', [
    page('onboarding', 'Onboarding', [page('nested', 'Nested notes')]),
    database('crm', 'CRM'),
    {
      id: 'linked:handbook:crm',
      title: 'CRM (linked view)',
      type: 'database',
      selectable: false,
      skipReason: SKIP,
      linkedFromId: 'crm',
      children: [],
    },
    unsupported('board', 'Whiteboard'),
  ]),
  page('row-listed', 'Customer Acme (row listed independently)'),
];

describe('toggleSelectedPageGroup', () => {
  it('refuses to select a database or other unsupported node', () => {
    const empty = new Set<string>();
    expect(toggleSelectedPageGroup(empty, database('crm', 'CRM'))).toEqual({
      selected: empty,
      limitExceeded: false,
    });
    expect(toggleSelectedPageGroup(empty, unsupported('board', 'Whiteboard'))).toEqual({
      selected: empty,
      limitExceeded: false,
    });
  });
  it('toggles all child pages when a database contains pages', () => {
    const wikiDb = database('wiki', 'Engineering Wiki', [
      page('p1', 'Architecture'),
      page('p2', 'Runbook'),
    ]);
    const res = toggleSelectedPageGroup(new Set<string>(), wikiDb);
    expect(Array.from(res.selected)).toEqual(['p1', 'p2']);
    expect(res.limitExceeded).toBe(false);

    const unselect = toggleSelectedPageGroup(new Set(['p1', 'p2']), wikiDb);
    expect(Array.from(unselect.selected)).toEqual([]);
  });


  it('selects and deselects every supported page in a parent group', () => {
    const handbook = page('handbook', 'Handbook', [
      page('onboarding', 'Onboarding', [page('nested', 'Nested notes')]),
      database('crm', 'CRM'),
    ]);

    const selected = toggleSelectedPageGroup(new Set(), handbook);
    expect(selected).toEqual({
      selected: new Set(['handbook', 'onboarding', 'nested']),
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
describe('formatNodeBadge', () => {
  it('returns null for pages', () => {
    expect(formatNodeBadge(page('p1', 'Page'))).toBeNull();
  });

  it('formats badges for databases, linked views, and unsupported types', () => {
    expect(formatNodeBadge(database('db1', 'DB'))).toBe('Database');
    expect(
      formatNodeBadge({
        id: 'l1',
        title: 'L',
        type: 'database',
        selectable: false,
        skipReason: SKIP,
        linkedFromId: 'db1',
        children: [],
      }),
    ).toBe('Linked View');
    expect(
      formatNodeBadge({
        id: 'ds1',
        title: 'DS',
        type: 'database',
        selectable: false,
        skipReason: SKIP,
        reasonCode: 'data_source',
        children: [],
      }),
    ).toBe('Data Source');
    expect(
      formatNodeBadge({
        id: 'c1',
        title: 'C',
        type: 'unsupported',
        selectable: false,
        skipReason: SKIP,
        reasonCode: 'canvas',
        children: [],
      }),
    ).toBe('Canvas');
  });
});

describe('selectablePageIds', () => {
  it('drops database ids even if they were stuffed into the selection set', () => {
    expect(selectablePageIds(MIXED, new Set(['handbook', 'crm', 'linked:handbook:crm', 'board']))).toEqual([
      'handbook',
    ]);
  });
});

describe('summarizeImport / formatConfirmCopy', () => {
  it('counts selected pages and names skipped databases including their rows', () => {
    const summary = summarizeImport(MIXED, new Set(['handbook', 'nested']));
    expect(summary.importCount).toBe(2);
    expect(summary.importIds).toEqual(['handbook', 'nested']);
    expect(summary.skippedDatabaseCount).toBe(1);
    expect(summary.skippedUnsupportedCount).toBe(1);

    const copy = formatConfirmCopy(summary);
    expect(copy).toContain('2 pages will import');
    expect(copy).toContain('1 database skipped (including its rows)');
    expect(copy).toMatch(/stay in Notion/i);
    expect(copy).not.toMatch(/token|secret_|ntn_/i);
  });

  it('does not count a linked-view clone as a second database', () => {
    const summary = summarizeImport(MIXED, new Set(['handbook']));
    expect(summary.skippedDatabaseCount).toBe(1);
    expect(formatConfirmCopy(summary)).toContain('1 database skipped (including its rows)');
  });

  it('uses singular copy for one page and one database', () => {
    const copy = formatConfirmCopy({
      importCount: 1,
      importIds: ['handbook'],
      skippedDatabaseCount: 1,
      skippedUnsupportedCount: 0,
    });
    expect(copy).toContain('1 page will import');
    expect(copy).toContain('1 database skipped (including its rows)');
  });

  it('still names the rows rule when no database is in the tree', () => {
    const summary = summarizeImport([page('solo', 'Solo')], new Set(['solo']));
    expect(summary.skippedDatabaseCount).toBe(0);
    const copy = formatConfirmCopy(summary);
    expect(copy).toContain('1 page will import');
    expect(copy).toMatch(/rows/i);
    expect(copy).toMatch(/appear as their own page/i);
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
    const p1: NotionTreeNode = { id: 'p1', title: 'P1', type: 'page', selectable: true, alreadyImported: true, children: [] };
    const p2: NotionTreeNode = { id: 'p2', title: 'P2', type: 'page', selectable: true, alreadyImported: false, children: [] };
    const tree = [p1, p2];

    expect(unimportedPageIds(tree)).toEqual(['p2']);
    expect(importedPageIds(tree)).toEqual(['p1']);

    const filtered = filterTreeNodes(tree, true);
    expect(filtered).toEqual([p2]);
  });
  it('filters document pages vs database rows and supports hideDatabaseRows', () => {
    const doc: NotionTreeNode = { id: 'd1', title: 'Doc', type: 'page', selectable: true, isDatabaseRow: false, children: [] };
    const row: NotionTreeNode = { id: 'r1', title: 'Row', type: 'page', selectable: true, isDatabaseRow: true, children: [] };
    const db: NotionTreeNode = { id: 'db1', title: 'DB', type: 'database', selectable: false, skipReason: 'skip', children: [row] };
    const tree = [doc, db];

    expect(documentPageIds(tree)).toEqual(['d1']);
    expect(databaseRowIds(tree)).toEqual(['r1']);

    const filtered = filterTreeNodes(tree, { hideDatabaseRows: true });
    expect(filtered).toEqual([doc]);
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
