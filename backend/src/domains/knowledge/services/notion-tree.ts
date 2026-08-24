/**
 * Workspace tree for selective Notion import (#1463 / #1459).
 *
 * Discovery is Search (pages + databases) plus `child_database` blocks
 * under pages (linked views that Search omits as duplicates). There is
 * no database-query: a row is in the tree only when Search returned it
 * as a page object.
 */
import { NOTION_UNSUPPORTED_LABEL, type NotionTreeNode } from '@compendiq/contracts';
import { NotionClient, NotionError } from './notion-client.js';
import { logger } from '../../../core/utils/logger.js';

export { NOTION_UNSUPPORTED_LABEL };

function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

function richTextToPlain(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        'plain_text' in item &&
        typeof (item as { plain_text: unknown }).plain_text === 'string'
      ) {
        return (item as { plain_text: string }).plain_text;
      }
      return '';
    })
    .join('');
}

function extractTitle(item: Record<string, unknown>): string {
  const direct = richTextToPlain(item.title);
  if (direct.trim()) return direct;

  const props = item.properties;
  if (props && typeof props === 'object') {
    for (const prop of Object.values(props as Record<string, unknown>)) {
      if (prop && typeof prop === 'object' && (prop as { type?: string }).type === 'title') {
        const t = richTextToPlain((prop as { title?: unknown }).title);
        if (t.trim()) return t;
      }
    }
  }

  if (item.object === 'block') {
    const nested = item[item.type as string];
    if (nested && typeof nested === 'object' && 'title' in nested) {
      const t = (nested as { title?: unknown }).title;
      if (typeof t === 'string' && t.trim()) return t;
    }
  }

  return 'Untitled';
}

function isTrashed(item: Record<string, unknown>): boolean {
  return item.in_trash === true || item.archived === true;
}

function parentIdOf(item: Record<string, unknown>): string | null {
  const parent = item.parent;
  if (!parent || typeof parent !== 'object') return null;
  const p = parent as Record<string, unknown>;
  if (p.type === 'page_id' && typeof p.page_id === 'string') return p.page_id;
  if (p.type === 'database_id' && typeof p.database_id === 'string') return p.database_id;
  if (p.type === 'block_id' && typeof p.block_id === 'string') return p.block_id;
  return null;
}

function toNode(item: Record<string, unknown>): NotionTreeNode | null {
  if (typeof item.id !== 'string' || item.id.length === 0) return null;
  const title = extractTitle(item);
  const url = typeof item.url === 'string' ? item.url : undefined;
  const extras = url ? { url } : {};

  if (item.object === 'page' || (item.object === 'block' && item.type === 'child_page')) {
    return { id: item.id, title, type: 'page', selectable: true, ...extras, children: [] };
  }
  if (
    item.object === 'database' ||
    item.object === 'data_source' ||
    (item.object === 'block' && item.type === 'child_database')
  ) {
    return {
      id: item.id,
      title,
      type: 'database',
      selectable: false,
      skipReason: NOTION_UNSUPPORTED_LABEL,
      ...extras,
      children: [],
    };
  }
  return {
    id: item.id,
    title,
    type: 'unsupported',
    selectable: false,
    skipReason: NOTION_UNSUPPORTED_LABEL,
    ...extras,
    children: [],
  };
}

function hasChild(parent: NotionTreeNode, id: string): boolean {
  const key = normalizeId(id);
  return parent.children.some((c) => normalizeId(c.id) === key);
}

function attach(parent: NotionTreeNode, child: NotionTreeNode): void {
  if (parent === child) return;
  if (hasChild(parent, child.id)) return;
  parent.children.push(child);
}

export async function fetchNotionWorkspaceTree(client: NotionClient): Promise<NotionTreeNode[]> {
  const results = await client.searchAll();
  const nodes = new Map<string, NotionTreeNode>();
  const rawByKey = new Map<string, Record<string, unknown>>();

  for (const raw of results) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (isTrashed(item)) continue;
    const node = toNode(item);
    if (!node) continue;
    const key = normalizeId(node.id);
    if (nodes.has(key)) continue;
    nodes.set(key, node);
    rawByKey.set(key, item);
  }

  const roots: NotionTreeNode[] = [];
  for (const [key, node] of nodes) {
    const parentId = parentIdOf(rawByKey.get(key)!);
    if (!parentId) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(normalizeId(parentId));
    if (parent && parent !== node) {
      attach(parent, node);
    } else {
      roots.push(node);
    }
  }

  const pages = [...nodes.values()].filter((n) => n.type === 'page');
  for (const page of pages) {
    let blocks: Array<Record<string, unknown>>;
    try {
      blocks = await client.getAllBlockChildren(page.id);
    } catch (err) {
      if (err instanceof NotionError && (err.statusCode === 404 || err.statusCode === 403)) {
        continue;
      }
      logger.warn({ err: err instanceof Error ? err.name : 'Error', pageId: page.id }, 'Notion block children failed during tree walk');
      continue;
    }

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type !== 'child_database') continue;
      if (typeof block.id !== 'string') continue;
      if (hasChild(page, block.id)) continue;

      const existing = nodes.get(normalizeId(block.id));
      if (existing && existing.type !== 'page') {
        // Linked view of a database already in the tree: visible here, no rows.
        attach(page, {
          id: existing.id,
          title: existing.title,
          type: existing.type,
          selectable: false,
          skipReason: NOTION_UNSUPPORTED_LABEL,
          ...(existing.url ? { url: existing.url } : {}),
          children: [],
        });
        continue;
      }

      const node = toNode(block);
      if (!node || node.type === 'page') continue;
      nodes.set(normalizeId(node.id), node);
      attach(page, node);
    }
  }

  return roots;
}
