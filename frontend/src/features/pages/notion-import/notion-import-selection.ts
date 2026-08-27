import type { NotionTreeNode, NotionTreePageNode } from '@compendiq/contracts';

/** Matches `NotionImportRequestSchema.pageIds.max(200)`. */
export const NOTION_IMPORT_MAX_PAGES = 200;

export type NotionImportStep = 'connect' | 'pick' | 'confirm' | 'result';

/** Drop an in-flight import POST if the wizard left confirm before it resolved. */
export function shouldCommitImportResult(step: NotionImportStep, open: boolean): boolean {
  return open && step === 'confirm';
}

export function exceedsImportPageCap(importCount: number): boolean {
  return importCount > NOTION_IMPORT_MAX_PAGES;
}

export function canContinueNotionPick(importCount: number): boolean {
  return importCount > 0 && !exceedsImportPageCap(importCount);
}

export type ImportSummary = {
  importCount: number;
  importIds: string[];
  skippedDatabaseCount: number;
  skippedUnsupportedCount: number;
};

export function isSelectablePage(node: NotionTreeNode): node is NotionTreePageNode {
  return node.type === 'page' && node.selectable === true;
}

export type GroupSelectionState = 'none' | 'some' | 'all';

function selectableIdsInGroup(node: NotionTreeNode): string[] {
  const ids: string[] = [];
  walk([node], (candidate) => {
    if (isSelectablePage(candidate)) ids.push(candidate.id);
  });
  return ids;
}

export function groupSelectionState(
  node: NotionTreeNode,
  selected: ReadonlySet<string>,
): GroupSelectionState {
  const ids = selectableIdsInGroup(node);
  if (ids.length === 0) return 'none';
  const selectedCount = ids.reduce((count, id) => count + Number(selected.has(id)), 0);
  if (selectedCount === 0) return 'none';
  return selectedCount === ids.length ? 'all' : 'some';
}

export function toggleSelectedPageGroup(
  selected: ReadonlySet<string>,
  node: NotionTreeNode,
): { selected: Set<string>; limitExceeded: boolean } {
  const next = new Set(selected);
  if (!isSelectablePage(node)) return { selected: next, limitExceeded: false };

  const groupIds = selectableIdsInGroup(node);
  const allSelected = groupIds.every((id) => next.has(id));
  if (allSelected) {
    groupIds.forEach((id) => next.delete(id));
    return { selected: next, limitExceeded: false };
  }

  groupIds.forEach((id) => next.add(id));
  if (next.size > NOTION_IMPORT_MAX_PAGES) {
    return { selected: new Set(selected), limitExceeded: true };
  }
  return { selected: next, limitExceeded: false };
}

function walk(nodes: NotionTreeNode[], visit: (node: NotionTreeNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.children.length > 0) walk(node.children, visit);
  }
}

export function selectablePageIds(nodes: NotionTreeNode[], selected: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  walk(nodes, (node) => {
    if (isSelectablePage(node) && selected.has(node.id)) ids.push(node.id);
  });
  return ids;
}

export function summarizeImport(nodes: NotionTreeNode[], selected: ReadonlySet<string>): ImportSummary {
  const importIds = selectablePageIds(nodes, selected);
  const skippedDatabases = new Set<string>();
  let skippedUnsupportedCount = 0;
  walk(nodes, (node) => {
    if (isSelectablePage(node)) return;
    if (node.type === 'database') skippedDatabases.add(node.linkedFromId ?? node.id);
    else skippedUnsupportedCount += 1;
  });
  return {
    importCount: importIds.length,
    importIds,
    skippedDatabaseCount: skippedDatabases.size,
    skippedUnsupportedCount,
  };
}

export function notionTitleById(nodes: NotionTreeNode[]): Map<string, string> {
  const titles = new Map<string, string>();
  walk(nodes, (node) => {
    titles.set(node.id, node.title);
  });
  return titles;
}

export function formatConfirmCopy(summary: Pick<ImportSummary, 'importCount' | 'skippedDatabaseCount'>): string {
  const pages =
    summary.importCount === 1 ? '1 page will import' : `${summary.importCount} pages will import`;
  const databases =
    summary.skippedDatabaseCount === 0
      ? 'no databases in this tree will be imported'
      : summary.skippedDatabaseCount === 1
        ? '1 database skipped (including its rows)'
        : `${summary.skippedDatabaseCount} databases skipped (including their rows)`;
  return `${pages}, ${databases}. Database rows stay in Notion unless they appear as their own page in this tree and you selected them.`;
}
