import type { NotionTreeNode, NotionTreePageNode } from '@compendiq/contracts';

/** Matches `NotionImportRequestSchema.pageIds.max(200)`. */
export const NOTION_IMPORT_MAX_PAGES = 200;

export type NotionImportStep = 'connect' | 'pick' | 'confirm' | 'result';

/** Drop an in-flight import POST if the wizard left confirm before it resolved. */
export function shouldCommitImportResult(step: NotionImportStep, open: boolean): boolean {
  return open && step === 'confirm';
}

export function exceedsImportPageCap(_importCount: number): boolean {
  return false;
}

export function canContinueNotionPick(importCount: number): boolean {
  return importCount > 0;
}

export function calculateBatchCount(importCount: number, batchSize = NOTION_IMPORT_MAX_PAGES): number {
  if (importCount <= 0) return 0;
  return Math.ceil(importCount / batchSize);
}

export function chunkPageIds(pageIds: string[], batchSize = NOTION_IMPORT_MAX_PAGES): string[][] {
  if (pageIds.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < pageIds.length; i += batchSize) {
    chunks.push(pageIds.slice(i, i + batchSize));
  }
  return chunks;
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

export function selectableIdsInGroup(node: NotionTreeNode): string[] {
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
  const groupIds = selectableIdsInGroup(node);
  if (groupIds.length === 0) return { selected: next, limitExceeded: false };

  const allSelected = groupIds.every((id) => next.has(id));
  if (allSelected) {
    groupIds.forEach((id) => next.delete(id));
    return { selected: next, limitExceeded: false };
  }

  groupIds.forEach((id) => next.add(id));
  return { selected: next, limitExceeded: false };
}
/** Formats a concise badge label describing the Notion object type for skipped nodes. */
export function formatNodeBadge(node: NotionTreeNode): string | null {
  if (node.type === 'page') return null;
  if (node.reasonCode === 'linked_database' || ('linkedFromId' in node && Boolean(node.linkedFromId))) {
    return 'Linked View';
  }
  if (node.reasonCode === 'data_source') return 'Data Source';
  if (node.reasonCode === 'inline_database') return 'Inline Database';
  if (node.reasonCode === 'child_database' || node.type === 'database') return 'Database';
  if (node.reasonCode === 'canvas') return 'Canvas';
  if (node.reasonCode === 'table') return 'Table';
  if (node.reasonCode && node.reasonCode !== 'unsupported') {
    return node.reasonCode
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return 'Database';
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
export function unimportedPageIds(nodes: NotionTreeNode[]): string[] {
  const ids: string[] = [];
  walk(nodes, (node) => {
    if (isSelectablePage(node) && node.alreadyImported !== true) {
      ids.push(node.id);
    }
  });
  return ids;
}

export function importedPageIds(nodes: NotionTreeNode[]): string[] {
  const ids: string[] = [];
  walk(nodes, (node) => {
    if (isSelectablePage(node) && node.alreadyImported === true) {
      ids.push(node.id);
    }
  });
  return ids;
}

export interface TreeFilterOptions {
  hideImported?: boolean;
  hideDatabaseRows?: boolean;
}

export function documentPageIds(nodes: NotionTreeNode[], unimportedOnly = false): string[] {
  const ids: string[] = [];
  walk(nodes, (node) => {
    if (isSelectablePage(node) && node.isDatabaseRow !== true) {
      if (!unimportedOnly || node.alreadyImported !== true) {
        ids.push(node.id);
      }
    }
  });
  return ids;
}

export function databaseRowIds(nodes: NotionTreeNode[]): string[] {
  const ids: string[] = [];
  walk(nodes, (node) => {
    if (isSelectablePage(node) && node.isDatabaseRow === true) {
      ids.push(node.id);
    }
  });
  return ids;
}

export function filterTreeNodes(
  nodes: NotionTreeNode[],
  options: TreeFilterOptions | boolean,
): NotionTreeNode[] {
  const hideImported = typeof options === 'boolean' ? options : Boolean(options.hideImported);
  const hideDatabaseRows = typeof options === 'object' ? Boolean(options.hideDatabaseRows) : false;

  if (!hideImported && !hideDatabaseRows) return nodes;

  function filterNode(node: NotionTreeNode): NotionTreeNode | null {
    if (node.type === 'page') {
      if (hideImported && node.alreadyImported === true && node.children.length === 0) {
        return null;
      }
      if (hideDatabaseRows && node.isDatabaseRow === true && node.children.length === 0) {
        return null;
      }
    }

    const filteredChildren = node.children
      .map(filterNode)
      .filter((child): child is NotionTreeNode => child !== null);

    if (node.type === 'page') {
      if (hideImported && node.alreadyImported === true && filteredChildren.length === 0) {
        return null;
      }
      if (hideDatabaseRows && node.isDatabaseRow === true && filteredChildren.length === 0) {
        return null;
      }
    }
    if (node.type !== 'page' && filteredChildren.length === 0) {
      if (hideDatabaseRows || (hideImported && selectableIdsInGroup(node).length > 0)) {
        return null;
      }
    }
    return {
      ...node,
      children: filteredChildren,
    };
  }

  return nodes.map(filterNode).filter((node): node is NotionTreeNode => node !== null);
}

export function searchTreeNodes(
  nodes: NotionTreeNode[],
  query: string,
): { filtered: NotionTreeNode[]; matchedIds: Set<string> } {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return { filtered: nodes, matchedIds: new Set() };
  }

  const matchedIds = new Set<string>();

  function filterRecursive(node: NotionTreeNode): NotionTreeNode | null {
    const isSelfMatch = node.title.toLowerCase().includes(trimmed);
    const filteredChildren = node.children
      .map(filterRecursive)
      .filter((child): child is NotionTreeNode => child !== null);

    const isChildMatch = filteredChildren.length > 0;
    if (isSelfMatch || isChildMatch) {
      matchedIds.add(node.id);
      return {
        ...node,
        children: filteredChildren,
      };
    }
    return null;
  }

  const filtered = nodes
    .map(filterRecursive)
    .filter((node): node is NotionTreeNode => node !== null);

  return { filtered, matchedIds };
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
  const batchCount = calculateBatchCount(summary.importCount);
  const batchText = batchCount > 1 ? ` in ${batchCount} batches (${NOTION_IMPORT_MAX_PAGES} pages/batch)` : '';
  const pages =
    summary.importCount === 1 ? '1 page will import' : `${summary.importCount} pages will import${batchText}`;
  const databases =
    summary.skippedDatabaseCount === 0
      ? 'no databases in this tree will be imported'
      : summary.skippedDatabaseCount === 1
        ? '1 database skipped (including its rows)'
        : `${summary.skippedDatabaseCount} databases skipped (including their rows)`;
  return `${pages}, ${databases}. Database rows stay in Notion unless they appear as their own page in this tree and you selected them.`;
}
