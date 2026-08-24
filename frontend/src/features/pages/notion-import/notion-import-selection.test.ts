import { describe, expect, it } from 'vitest';
import { NOTION_UNSUPPORTED_LABEL, type NotionTreeNode } from '@compendiq/contracts';
import {
  formatConfirmCopy,
  selectablePageIds,
  summarizeImport,
  toggleSelectedPage,
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

describe('toggleSelectedPage', () => {
  it('refuses to select a database or other unsupported node', () => {
    const empty = new Set<string>();
    expect(toggleSelectedPage(empty, database('crm', 'CRM'))).toEqual(empty);
    expect(toggleSelectedPage(empty, unsupported('board', 'Whiteboard'))).toEqual(empty);
  });

  it('selects a parent without its children', () => {
    const selected = toggleSelectedPage(new Set(), page('handbook', 'Handbook', [
      page('onboarding', 'Onboarding'),
      database('crm', 'CRM'),
    ]));
    expect([...selected]).toEqual(['handbook']);
  });

  it('lets nested children be selected independently of the parent', () => {
    let selected = toggleSelectedPage(new Set(), page('nested', 'Nested notes'));
    selected = toggleSelectedPage(selected, page('onboarding', 'Onboarding', [page('nested', 'Nested notes')]));
    expect(selected).toEqual(new Set(['nested', 'onboarding']));
    expect(selected.has('handbook')).toBe(false);
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
    expect(summary.skippedDatabaseCount).toBe(2);
    expect(summary.skippedUnsupportedCount).toBe(1);

    const copy = formatConfirmCopy(summary);
    expect(copy).toContain('2 pages will import');
    expect(copy).toContain('2 databases skipped');
    expect(copy).toMatch(/including their rows/);
    expect(copy).toMatch(/stay in Notion/i);
    expect(copy).not.toMatch(/token|secret_|ntn_/i);
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
