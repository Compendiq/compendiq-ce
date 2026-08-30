import type {
  NotionDatabaseMode,
  NotionTreeDatabaseNode,
  NotionTreeNode,
  NotionTreePageNode,
} from '@compendiq/contracts';

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
export type DatabaseModes = Record<string, NotionDatabaseMode>;

export type ImportSummary = {
  importCount: number;
  importIds: string[];
  /** Ordinary pages. */
  pageCount: number;
  /** Database rows, which carry their properties as a metadata callout. */
  articleCount: number;
  /** Databases flattening into one table page. */
  tableCount: number;
  /** Databases becoming a container page for their rows. */
  collectionCount: number;
  skippedDatabaseCount: number;
  unsupportedCount: number;
};

export function isSelectablePage(node: NotionTreeNode): node is NotionTreePageNode {
  return node.type === 'page' && node.selectable === true;
}

export function isDatabaseNode(node: NotionTreeNode): node is NotionTreeDatabaseNode {
  return node.type === 'database';
}

/** The mode in force for a database: the operator's override, else the scan's. */
export function effectiveDatabaseMode(
  node: NotionTreeDatabaseNode,
  modes?: DatabaseModes,
): NotionDatabaseMode {
  return modes?.[node.id] ?? node.recommendedMode;
}

/**
 * `table` flattens a database's rows into cells, so offering it for a wiki would
 * invite dropping article bodies. Every other database may take either shape.
 */
export function availableDatabaseModes(node: NotionTreeDatabaseNode): NotionDatabaseMode[] {
  return node.isWiki ? ['pages', 'skip'] : ['table', 'pages', 'skip'];
}

/**
 * What an ancestor database has already decided for everything under it.
 * `table` folds descendants into that database's table; `skip` leaves them in
 * Notion. Either way the descendant is no longer a choice of its own.
 */
export type InheritedFold = 'table' | 'skip' | undefined;

/** The fold in force for a node's children, given the fold it inherited itself. */
export function foldForChildren(
  node: NotionTreeNode,
  modes?: DatabaseModes,
  inherited?: InheritedFold,
): InheritedFold {
  if (inherited) return inherited;
  if (!isDatabaseNode(node)) return undefined;
  const mode = effectiveDatabaseMode(node, modes);
  return mode === 'table' || mode === 'skip' ? mode : undefined;
}

export type GroupSelectionState = 'none' | 'some' | 'all';

/**
 * Ids the checkbox on this node governs.
 *
 * A database in `table` mode governs only itself: its rows ARE the table, so
 * selecting them as pages too would import the same content twice. A skipped
 * database governs nothing.
 */
export function selectableIdsInGroup(node: NotionTreeNode, modes?: DatabaseModes): string[] {
  const ids: string[] = [];
  collectImportIds([node], modes, ids);
  return ids;
}

function collectImportIds(nodes: NotionTreeNode[], modes: DatabaseModes | undefined, out: string[]): void {
  for (const node of nodes) {
    if (isDatabaseNode(node)) {
      const mode = effectiveDatabaseMode(node, modes);
      if (mode === 'skip') continue;
      out.push(node.id);
      if (mode === 'table') continue;
    } else if (isSelectablePage(node)) {
      out.push(node.id);
    }
    collectImportIds(node.children, modes, out);
  }
}

export function groupSelectionState(
  node: NotionTreeNode,
  selected: ReadonlySet<string>,
  modes?: DatabaseModes,
): GroupSelectionState {
  const ids = selectableIdsInGroup(node, modes);
  if (ids.length === 0) return 'none';
  const selectedCount = ids.reduce((count, id) => count + Number(selected.has(id)), 0);
  if (selectedCount === 0) return 'none';
  return selectedCount === ids.length ? 'all' : 'some';
}

export function toggleSelectedPageGroup(
  selected: ReadonlySet<string>,
  node: NotionTreeNode,
  modes?: DatabaseModes,
): { selected: Set<string>; limitExceeded: boolean } {
  const next = new Set(selected);
  const groupIds = selectableIdsInGroup(node, modes);
  if (groupIds.length === 0) return { selected: next, limitExceeded: false };

  const allSelected = groupIds.every((id) => next.has(id));
  if (allSelected) {
    groupIds.forEach((id) => next.delete(id));
    return { selected: next, limitExceeded: false };
  }

  groupIds.forEach((id) => next.add(id));
  return { selected: next, limitExceeded: false };
}

/** The Notion object type, named the way Notion names it. */
export function formatNodeBadge(node: NotionTreeNode): string {
  if (node.type === 'page') return node.isDatabaseRow === true ? 'Database row' : 'Page';
  if (node.type === 'database') return node.isWiki ? 'Wiki' : 'Database';
  if (node.reasonCode === 'linked_database' || Boolean(node.linkedFromId)) return 'Linked view';
  if (node.reasonCode === 'data_source') return 'Data source';
  if (node.reasonCode === 'inline_database') return 'Inline database';
  if (node.reasonCode === 'child_database') return 'Nested database';
  if (node.reasonCode && node.reasonCode !== 'unsupported') {
    return node.reasonCode.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
  return 'Unsupported';
}

/**
 * What the picker states about one row: whether the importer can take it, the
 * Notion object type, and the shape it will land in. Every row gets one, so no
 * node can render without saying what happens to it.
 */
export type NodeSupport = {
  supported: boolean;
  badge: string;
  action: string;
  /** A consequence of an override the scan would not have recommended. */
  caution?: string;
};

export function describeNode(
  node: NotionTreeNode,
  modes?: DatabaseModes,
  inherited?: InheritedFold,
): NodeSupport {
  const badge = formatNodeBadge(node);

  if (node.type === 'unsupported') {
    return { supported: false, badge, action: node.skipReason };
  }
  // An ancestor database already answered for this node, so it must not claim a
  // shape of its own — a row folded into a table is not importing as an article.
  if (inherited === 'table') {
    return { supported: true, badge, action: 'Included in the table above' };
  }
  if (inherited === 'skip') {
    return { supported: true, badge, action: 'Excluded — stays in Notion' };
  }
  if (node.type === 'page') {
    return {
      supported: true,
      badge,
      action: node.isDatabaseRow === true ? 'Imports as an article' : 'Imports as a page',
    };
  }

  const mode = effectiveDatabaseMode(node, modes);
  if (mode === 'skip') {
    return { supported: true, badge, action: 'Excluded — stays in Notion' };
  }
  if (mode === 'table') {
    return {
      supported: true,
      badge,
      action: `Imports as one table · ${node.rowCount} ${node.rowCount === 1 ? 'row' : 'rows'}`,
      ...(node.rowContent === 'some'
        ? { caution: 'Some rows have page content — the whole database imports as pages instead' }
        : node.rowContent === 'unknown'
          ? { caution: 'Row content was not checked — a row with a page body sends the whole database to pages' }
          : {}),
    };
  }
  return {
    supported: true,
    badge,
    action:
      node.rowCount === 0
        ? 'Imports as one page'
        : `Imports as one page with ${node.rowCount} ${node.rowCount === 1 ? 'article' : 'articles'}`,
  };
}

function walk(nodes: NotionTreeNode[], visit: (node: NotionTreeNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.children.length > 0) walk(node.children, visit);
  }
}

/** Every id the import request may carry under the current modes. */
export function allImportIds(nodes: NotionTreeNode[], modes?: DatabaseModes): string[] {
  const ids: string[] = [];
  collectImportIds(nodes, modes, ids);
  return ids;
}

/**
 * The confirmed selection, pruned to what the modes allow. Switching a database
 * to `table` after ticking its rows must not still send those rows.
 */
export function selectedImportIds(
  nodes: NotionTreeNode[],
  selected: ReadonlySet<string>,
  modes?: DatabaseModes,
): string[] {
  return allImportIds(nodes, modes).filter((id) => selected.has(id));
}

/**
 * The mode to send for every database in the request. Explicit beats implicit:
 * without it the server re-derives a default from the database alone and can
 * land on a different shape than the row the operator just read.
 */
export function requestDatabaseModes(
  nodes: NotionTreeNode[],
  selected: ReadonlySet<string>,
  modes?: DatabaseModes,
): DatabaseModes {
  const out: DatabaseModes = {};
  walk(nodes, (node) => {
    if (isDatabaseNode(node) && selected.has(node.id)) {
      out[node.id] = effectiveDatabaseMode(node, modes);
    }
  });
  return out;
}

export function unimportedPageIds(nodes: NotionTreeNode[], modes?: DatabaseModes): string[] {
  const importable = new Set(allImportIds(nodes, modes));
  const ids: string[] = [];
  walk(nodes, (node) => {
    if (importable.has(node.id) && node.type !== 'unsupported' && node.alreadyImported !== true) {
      ids.push(node.id);
    }
  });
  return ids;
}

export function importedPageIds(nodes: NotionTreeNode[], modes?: DatabaseModes): string[] {
  const importable = new Set(allImportIds(nodes, modes));
  const ids: string[] = [];
  walk(nodes, (node) => {
    if (importable.has(node.id) && node.type !== 'unsupported' && node.alreadyImported === true) {
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
    // A database is importable in its own right, so an empty child list is no
    // reason to hide it. Only an unsupported node with nothing under it is noise.
    if (node.type === 'unsupported' && filteredChildren.length === 0) {
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

  function filterRecursive(node: NotionTreeNode, ancestors: string[]): NotionTreeNode | null {
    const titles = [...ancestors, node.title.toLowerCase()];
    const isSelfMatch =
      node.title.toLowerCase().includes(trimmed) || titles.join(' / ').includes(trimmed);
    const filteredChildren = node.children
      .map((child) => filterRecursive(child, titles))
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
    .map((node) => filterRecursive(node, []))
    .filter((node): node is NotionTreeNode => node !== null);

  return { filtered, matchedIds };
}

export function summarizeImport(
  nodes: NotionTreeNode[],
  selected: ReadonlySet<string>,
  databaseModes?: DatabaseModes,
): ImportSummary {
  const importIds = selectedImportIds(nodes, selected, databaseModes);
  const importing = new Set(importIds);

  let pageCount = 0;
  let articleCount = 0;
  let tableCount = 0;
  let collectionCount = 0;
  let skippedDatabaseCount = 0;
  let unsupportedCount = 0;

  walk(nodes, (node) => {
    if (node.type === 'unsupported') {
      unsupportedCount += 1;
      return;
    }
    if (isDatabaseNode(node)) {
      const mode = effectiveDatabaseMode(node, databaseModes);
      if (mode === 'skip') {
        skippedDatabaseCount += 1;
        return;
      }
      if (!importing.has(node.id)) return;
      if (mode === 'table' && (node.rowContent === 'some' || node.rowContent === 'unknown')) {
        collectionCount += 1;
        articleCount += node.rowCount;
        return;
      }
      if (mode === 'table') tableCount += 1;
      else collectionCount += 1;
      return;
    }
    if (!importing.has(node.id)) return;
    if (node.isDatabaseRow === true) articleCount += 1;
    else pageCount += 1;
  });

  return {
    importCount: importIds.length,
    importIds,
    pageCount,
    articleCount,
    tableCount,
    collectionCount,
    skippedDatabaseCount,
    unsupportedCount,
  };
}

export function notionTitleById(nodes: NotionTreeNode[]): Map<string, string> {
  const titles = new Map<string, string>();
  walk(nodes, (node) => {
    titles.set(node.id, node.title);
  });
  return titles;
}

/** Plain-language list of what confirming will produce, and what it will not. */
export function formatConfirmCopy(
  summary: Pick<
    ImportSummary,
    | 'importCount'
    | 'pageCount'
    | 'articleCount'
    | 'tableCount'
    | 'collectionCount'
    | 'skippedDatabaseCount'
    | 'unsupportedCount'
  >,
): string {
  if (summary.importCount === 0) return 'Nothing is selected.';

  const parts: string[] = [];
  if (summary.pageCount > 0) {
    parts.push(`${summary.pageCount} ${summary.pageCount === 1 ? 'page' : 'pages'}`);
  }
  if (summary.articleCount > 0) {
    parts.push(`${summary.articleCount} ${summary.articleCount === 1 ? 'article' : 'articles'}`);
  }
  if (summary.tableCount > 0) {
    parts.push(`${summary.tableCount} ${summary.tableCount === 1 ? 'table' : 'tables'}`);
  }
  if (summary.collectionCount > 0) {
    parts.push(
      `${summary.collectionCount} ${summary.collectionCount === 1 ? 'database page' : 'database pages'}`,
    );
  }
  const listed =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  const batchCount = calculateBatchCount(summary.importCount);
  const batchText =
    batchCount > 1 ? ` in ${batchCount} batches (${NOTION_IMPORT_MAX_PAGES} items/batch)` : '';

  const tail: string[] = [];
  if (summary.skippedDatabaseCount > 0) {
    tail.push(
      `${summary.skippedDatabaseCount} ${summary.skippedDatabaseCount === 1 ? 'database is' : 'databases are'} excluded`,
    );
  }
  if (summary.unsupportedCount > 0) {
    tail.push(
      `${summary.unsupportedCount} ${summary.unsupportedCount === 1 ? 'item' : 'items'} cannot be imported and stay in Notion`,
    );
  }

  return `${listed} will import${batchText}.${tail.length > 0 ? ` ${tail.join(', ')}.` : ''}`;
}
