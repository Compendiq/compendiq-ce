/**
 * Workspace tree for selective Notion import (#1463 / #1459).
 *
 * Discovery is Search (pages + databases) plus `child_database` /
 * `child_page` blocks under ordinary pages (linked views that Search
 * omits as duplicates; pages nested under toggles/columns). There is no
 * database-query: a row is in the tree only when Search returned it as a
 * page object. Database row-pages are not walked for linked views.
 */
import {
  NOTION_UNSUPPORTED_LABEL,
  type NotionTreeNode,
  type NotionTreeSkippedNode,
} from '@compendiq/contracts';
import { NotionClient, NotionError } from './notion-client.js';

export { NOTION_UNSUPPORTED_LABEL };

/** Blocks whose children can include `child_database` / `child_page`. */
const LAYOUT_BLOCK_TYPES = new Set([
  'toggle',
  'column_list',
  'column',
  'callout',
  'synced_block',
  'heading_1',
  'heading_2',
  'heading_3',
  'quote',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'template',
]);

export function linkedViewNodeId(hostPageId: string, databaseId: string): string {
  return `linked:${hostPageId}:${databaseId}`;
}

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

function parentRecord(item: Record<string, unknown>): Record<string, unknown> | null {
  const parent = item.parent;
  if (!parent || typeof parent !== 'object') return null;
  return parent as Record<string, unknown>;
}

function parentTypeOf(item: Record<string, unknown>): string | null {
  const p = parentRecord(item);
  return p && typeof p.type === 'string' ? p.type : null;
}

function parentIdOf(item: Record<string, unknown>): string | null {
  const p = parentRecord(item);
  if (!p) return null;
  if (p.type === 'page_id' && typeof p.page_id === 'string') return p.page_id;
  if (p.type === 'database_id' && typeof p.database_id === 'string') return p.database_id;
  if (p.type === 'block_id' && typeof p.block_id === 'string') return p.block_id;
  return null;
}

function isDatabaseRowPage(item: Record<string, unknown>): boolean {
  return item.object === 'page' && parentTypeOf(item) === 'database_id';
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

function notionObjectId(node: NotionTreeNode): string {
  if (node.type !== 'page' && node.linkedFromId) return node.linkedFromId;
  return node.id;
}

function hasChildRef(parent: NotionTreeNode, notionId: string): boolean {
  const key = normalizeId(notionId);
  return parent.children.some((c) => normalizeId(notionObjectId(c)) === key);
}

function attach(parent: NotionTreeNode, child: NotionTreeNode, attached: Set<string>): void {
  if (parent === child) return;
  if (hasChildRef(parent, notionObjectId(child))) return;
  parent.children.push(child);
  attached.add(normalizeId(child.id));
}

function makeLinkedView(hostPageId: string, existing: NotionTreeSkippedNode): NotionTreeSkippedNode {
  return {
    id: linkedViewNodeId(hostPageId, existing.id),
    title: existing.title,
    type: existing.type,
    selectable: false,
    skipReason: NOTION_UNSUPPORTED_LABEL,
    linkedFromId: existing.id,
    ...(existing.url ? { url: existing.url } : {}),
    children: [],
  };
}

function isMissing(err: unknown): boolean {
  return err instanceof NotionError && (err.statusCode === 404 || err.statusCode === 403);
}

async function listChildren(client: NotionClient, blockId: string): Promise<Array<Record<string, unknown>>> {
  try {
    return await client.getAllBlockChildren(blockId);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

async function resolveHostPageId(
  client: NotionClient,
  startBlockId: string,
  nodes: Map<string, NotionTreeNode>,
): Promise<string | null> {
  const seen = new Set<string>();
  let current = startBlockId;
  for (let i = 0; i < 25; i++) {
    const key = normalizeId(current);
    if (seen.has(key)) return null;
    seen.add(key);
    const known = nodes.get(key);
    if (known?.type === 'page') return known.id;

    let block: Record<string, unknown>;
    try {
      block = await client.getBlock(current);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    const type = parentTypeOf(block);
    const id = parentIdOf(block);
    if (type === 'page_id' && id) return id;
    if (type === 'block_id' && id) {
      current = id;
      continue;
    }
    return null;
  }
  return null;
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

  const attached = new Set<string>();

  for (const [key, node] of nodes) {
    const raw = rawByKey.get(key)!;
    if (parentTypeOf(raw) === 'block_id') continue;
    const parentId = parentIdOf(raw);
    if (!parentId) continue;
    const parent = nodes.get(normalizeId(parentId));
    if (parent && parent !== node) {
      attach(parent, node, attached);
    }
  }

  for (const [key, node] of nodes) {
    if (attached.has(key)) continue;
    const raw = rawByKey.get(key);
    if (!raw || parentTypeOf(raw) !== 'block_id') continue;
    const blockId = parentIdOf(raw);
    if (!blockId) continue;
    const hostId = await resolveHostPageId(client, blockId, nodes);
    if (!hostId) continue;
    const host = nodes.get(normalizeId(hostId));
    if (host && host.type === 'page') {
      attach(host, node, attached);
    }
  }

  async function walkHosted(blockId: string, hostPage: NotionTreeNode): Promise<void> {
    const blocks = await listChildren(client, blockId);
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || typeof block.id !== 'string') continue;

      if (block.type === 'child_page') {
        const existing = nodes.get(normalizeId(block.id));
        const pageNode =
          existing && existing.type === 'page' ? existing : toNode({ ...block, object: 'block', type: 'child_page' });
        if (pageNode && pageNode.type === 'page') {
          if (!nodes.has(normalizeId(pageNode.id))) {
            nodes.set(normalizeId(pageNode.id), pageNode);
          }
          attach(hostPage, pageNode, attached);
        }
        continue;
      }

      if (block.type === 'child_database') {
        if (hasChildRef(hostPage, block.id)) continue;
        const existing = nodes.get(normalizeId(block.id));
        if (existing && existing.type !== 'page') {
          // Search already owns this object; this host only linked it.
          hostPage.children.push(makeLinkedView(hostPage.id, existing));
        } else {
          const node = toNode(block);
          if (node && node.type !== 'page') {
            nodes.set(normalizeId(node.id), node);
            attach(hostPage, node, attached);
          }
        }
        continue;
      }

      if (
        typeof block.type === 'string' &&
        LAYOUT_BLOCK_TYPES.has(block.type) &&
        block.has_children !== false
      ) {
        await walkHosted(block.id, hostPage);
      }
    }
  }

  for (const [key, node] of nodes) {
    if (node.type !== 'page') continue;
    const raw = rawByKey.get(key);
    if (raw && isDatabaseRowPage(raw)) continue;
    await walkHosted(node.id, node);
  }

  return [...nodes.values()].filter((n) => !attached.has(normalizeId(n.id)));
}
