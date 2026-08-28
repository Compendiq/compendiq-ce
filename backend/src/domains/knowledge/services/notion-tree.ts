/**
 * Workspace tree for selective Notion import (#1463 / #1459).
 *
 * Initial discovery uses Search only, then resolves Search-listed pages whose
 * parent is a block back to their host page. It deliberately does not list the
 * body blocks of every page: on a large workspace that added up to 80 serial
 * requests against Notion's 3 req/s limit before the picker could render.
 *
 * There is no database query. A row is present only when Search returned it as
 * a page object.
 */
import {
  NOTION_UNSUPPORTED_LABEL,
  type NotionTreeNode,
} from '@compendiq/contracts';
import { NotionClient, NotionError } from './notion-client.js';

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
  if (p.type === 'data_source_id' && typeof p.data_source_id === 'string') return p.data_source_id;
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
      reasonCode: 'database',
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
    reasonCode: typeof item.type === 'string' ? item.type : 'unsupported',
    ...extras,
    children: [],
  };
}

function attach(parent: NotionTreeNode, child: NotionTreeNode, attached: Set<string>): void {
  if (parent === child) return;
  const childKey = normalizeId(child.id);
  if (parent.children.some((candidate) => normalizeId(candidate.id) === childKey)) return;
  parent.children.push(child);
  attached.add(childKey);
}

function isMissing(err: unknown): boolean {
  return err instanceof NotionError && (err.statusCode === 404 || err.statusCode === 403);
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


  return [...nodes.values()].filter((n) => !attached.has(normalizeId(n.id)));
}
