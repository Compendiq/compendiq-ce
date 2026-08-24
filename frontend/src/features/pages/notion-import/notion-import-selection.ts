import type { NotionTreeNode, NotionTreePageNode } from '@compendiq/contracts';

export type ImportSummary = {
  importCount: number;
  importIds: string[];
  skippedDatabaseCount: number;
  skippedUnsupportedCount: number;
};

export function isSelectablePage(node: NotionTreeNode): node is NotionTreePageNode {
  return node.type === 'page' && node.selectable === true;
}

export function toggleSelectedPage(
  selected: ReadonlySet<string>,
  node: NotionTreeNode,
): Set<string> {
  const next = new Set(selected);
  if (!isSelectablePage(node)) return next;
  if (next.has(node.id)) next.delete(node.id);
  else next.add(node.id);
  return next;
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
  let skippedDatabaseCount = 0;
  let skippedUnsupportedCount = 0;
  walk(nodes, (node) => {
    if (isSelectablePage(node)) return;
    if (node.type === 'database') skippedDatabaseCount += 1;
    else skippedUnsupportedCount += 1;
  });
  return {
    importCount: importIds.length,
    importIds,
    skippedDatabaseCount,
    skippedUnsupportedCount,
  };
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
