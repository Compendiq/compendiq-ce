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
 *
 * Databases ARE importable and say so. Each one is classified into the shape it
 * would take locally — one table, or a page per row — from its own property
 * schema plus a bounded sample of its row pages. The sample is advisory copy for
 * the picker; `notion-import-service` re-checks every row before it flattens a
 * database into a table, so a wrong guess here costs a recommendation, never
 * content.
 */
import pLimit from 'p-limit';
import {
  NOTION_UNSUPPORTED_LABEL,
  type NotionTreeDatabaseNode,
  type NotionTreeNode,
} from '@compendiq/contracts';
import { query } from '../../../core/db/postgres.js';
import { NotionClient, NotionError, type NotionListResponse } from './notion-client.js';

export { NOTION_UNSUPPORTED_LABEL };

/**
 * An inline database is already rendered as a table in its host page's body by
 * `notion-block-converter`, so offering it as a separate selection would import
 * the same rows twice.
 */
export const NOTION_INLINE_DATABASE_REASON = 'Imports inside its page as a table' as const;

const NOTION_LOOKUP_CONCURRENCY = 5;
/** Row pages sampled per database to guess whether rows carry body content. */
export const NOTION_ROW_SAMPLE_SIZE = 5;
/** Ceiling on row samples per tree build, so a database-heavy workspace still renders. */
export const NOTION_ROW_SAMPLE_BUDGET = 60;

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

export function extractParentRelationId(item: Record<string, unknown>): string | null {
  const props = item.properties;
  if (!props || typeof props !== 'object') return null;

  for (const [key, prop] of Object.entries(props as Record<string, unknown>)) {
    if (!prop || typeof prop !== 'object') continue;
    const lowerKey = key.toLowerCase();
    const isParentKey =
      lowerKey.includes('parent') ||
      lowerKey.includes('übergeordnet') ||
      lowerKey.includes('overordnet');

    const propType = typeof (prop as { type?: unknown }).type === 'string' ? (prop as { type: string }).type : '';

    if (propType === 'relation' && isParentKey) {
      const relation = (prop as { relation?: unknown }).relation;
      if (Array.isArray(relation) && relation.length > 0) {
        const first = relation[0];
        if (first && typeof first === 'object' && 'id' in first && typeof first.id === 'string' && first.id.trim()) {
          return first.id.trim();
        }
      }
    }
  }
  return null;
}

/**
 * Notion adds a `verification` property to the row pages of a wiki database and
 * nowhere else, so its presence in the schema identifies a wiki.
 * https://developers.notion.com/guides/data-apis/working-with-databases#wiki-databases
 */
export function isWikiDatabase(item: Record<string, unknown>): boolean {
  const props = item.properties;
  if (!props || typeof props !== 'object') return false;
  return Object.values(props).some(
    (prop) => Boolean(prop) && typeof prop === 'object' && 'type' in prop && prop.type === 'verification',
  );
}

function toNode(item: Record<string, unknown>): NotionTreeNode | null {
  if (typeof item.id !== 'string' || item.id.length === 0) return null;
  const title = extractTitle(item);
  const url = typeof item.url === 'string' ? item.url : undefined;
  const extras = url ? { url } : {};

  if (item.object === 'page' || (item.object === 'block' && item.type === 'child_page')) {
    const isDatabaseRow = parentTypeOf(item) === 'database_id' || parentTypeOf(item) === 'data_source_id';
    return {
      id: item.id,
      title,
      type: 'page',
      selectable: true,
      ...(isDatabaseRow ? { isDatabaseRow: true } : {}),
      ...extras,
      children: [],
    };
  }
  if (item.object === 'data_source') {
    return {
      id: item.id,
      title,
      type: 'unsupported',
      selectable: false,
      skipReason: NOTION_UNSUPPORTED_LABEL,
      reasonCode: 'data_source',
      ...extras,
      children: [],
    };
  }
  // A `child_database` block is a database nested in a page body, which the
  // host page's own conversion already renders as a table.
  if (item.is_inline === true || (item.object === 'block' && item.type === 'child_database')) {
    return {
      id: item.id,
      title,
      type: 'unsupported',
      selectable: false,
      skipReason: NOTION_INLINE_DATABASE_REASON,
      reasonCode: item.object === 'block' ? 'child_database' : 'inline_database',
      ...extras,
      children: [],
    };
  }
  if (item.object === 'database') {
    const props = item.properties;
    return {
      id: item.id,
      title,
      type: 'database',
      selectable: true,
      // Provisional. `classifyDatabases` settles these once rows are attached.
      recommendedMode: 'pages',
      rowContent: 'unknown',
      isWiki: isWikiDatabase(item),
      rowCount: 0,
      columns: props && typeof props === 'object' ? Object.keys(props) : [],
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
    if (known) return known.id;

    let block: Record<string, unknown>;
    try {
      block = await client.getBlock(current);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    const type = parentTypeOf(block);
    const id = parentIdOf(block);
    if ((type === 'page_id' || type === 'database_id' || type === 'data_source_id') && id) return id;
    if (type === 'block_id' && id) {
      current = id;
      continue;
    }
    return null;
  }
  return null;
}

export async function fetchNotionWorkspaceTree(
  client: NotionClient,
  options: { userId?: string } = {},
): Promise<NotionTreeNode[]> {
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

  // Pass 1: Sub-item parent relation properties (e.g. Wiki sub-pages)
  for (const [key, node] of nodes) {
    const raw = rawByKey.get(key);
    if (!raw) continue;
    const relationParentId = extractParentRelationId(raw);
    if (!relationParentId) continue;
    const parent = nodes.get(normalizeId(relationParentId));
    if (parent && parent !== node) {
      attach(parent, node, attached);
    }
  }

  // Pass 2: Direct parent relations (page_id, database_id, data_source_id)
  // Fetch missing parent databases/pages on-demand concurrently if omitted from search results
  const missingParentsToFetch = new Map<string, { parentId: string; type: string | null }>();
  for (const [key] of nodes) {
    if (attached.has(key)) continue;
    const raw = rawByKey.get(key);
    if (!raw || parentTypeOf(raw) === 'block_id') continue;
    const parentId = parentIdOf(raw);
    if (!parentId) continue;
    const parentKey = normalizeId(parentId);
    if (!nodes.has(parentKey) && !missingParentsToFetch.has(parentKey)) {
      missingParentsToFetch.set(parentKey, { parentId, type: parentTypeOf(raw) });
    }
  }

  if (missingParentsToFetch.size > 0) {
    const limit = pLimit(NOTION_LOOKUP_CONCURRENCY);
    await Promise.all(
      Array.from(missingParentsToFetch.entries()).map(([parentKey, { parentId, type }]) =>
        limit(async () => {
          try {
            let parentRaw: Record<string, unknown>;
            if (type === 'database_id' || type === 'data_source_id') {
              parentRaw = await client.getDatabase(parentId);
            } else {
              try {
                parentRaw = await client.getPage(parentId);
              } catch (err) {
                if (!isMissing(err)) throw err;
                parentRaw = await client.getDatabase(parentId);
              }
            }
            if (parentRaw && !isTrashed(parentRaw)) {
              const parentNode = toNode(parentRaw);
              if (parentNode) {
                nodes.set(parentKey, parentNode);
                rawByKey.set(parentKey, parentRaw);
              }
            }
          } catch (err) {
            if (isMissing(err)) return;
            throw err;
          }
        }),
      ),
    );
  }

  for (const [key, node] of nodes) {
    if (attached.has(key)) continue;
    const raw = rawByKey.get(key);
    if (!raw || parentTypeOf(raw) === 'block_id') continue;
    const parentId = parentIdOf(raw);
    if (!parentId) continue;
    const parentKey = normalizeId(parentId);
    const parent = nodes.get(parentKey);
    if (parent && parent !== node) {
      attach(parent, node, attached);
    }
  }

  // Pass 3: Block-parent walk for pages nested under blocks/toggles/columns (resolved concurrently)
  const blockParentNodes: Array<{ key: string; node: NotionTreeNode; blockId: string }> = [];
  for (const [key, node] of nodes) {
    if (attached.has(key)) continue;
    const raw = rawByKey.get(key);
    if (!raw || parentTypeOf(raw) !== 'block_id') continue;
    const blockId = parentIdOf(raw);
    if (blockId) {
      blockParentNodes.push({ key, node, blockId });
    }
  }

  if (blockParentNodes.length > 0) {
    const limit = pLimit(NOTION_LOOKUP_CONCURRENCY);
    const blockResolutions = await Promise.all(
      blockParentNodes.map(({ node, blockId }) =>
        limit(async () => {
          const hostId = await resolveHostPageId(client, blockId, nodes);
          return { node, hostId };
        }),
      ),
    );
    for (const { node, hostId } of blockResolutions) {
      if (hostId) {
        const host = nodes.get(normalizeId(hostId));
        if (host && host !== node) {
          attach(host, node, attached);
        }
      }
    }
  }

  // Pass 4: Attach any newly discovered parent nodes that themselves have parents
  for (const [key, node] of nodes) {
    if (attached.has(key)) continue;
    const raw = rawByKey.get(key);
    if (!raw) continue;
    const parentId = extractParentRelationId(raw) ?? parentIdOf(raw);
    if (!parentId) continue;
    const parent = nodes.get(normalizeId(parentId));
    if (parent && parent !== node) {
      attach(parent, node, attached);
    }
  }

  await classifyDatabases(client, nodes);

  if (options.userId) {
    try {
      const existing = await query<{ id: number; notion_page_id: string }>(
        `SELECT id, lower(replace(notion_page_id, '-', '')) AS notion_page_id
         FROM pages
         WHERE created_by_user_id = $1
           AND notion_page_id IS NOT NULL
           AND deleted_at IS NULL`,
        [options.userId],
      );
      const existingByNotionId = new Map<string, number>();
      for (const row of existing.rows) {
        existingByNotionId.set(row.notion_page_id, row.id);
      }
      for (const [key, node] of nodes) {
        if ((node.type === 'page' || node.type === 'database') && existingByNotionId.has(key)) {
          node.alreadyImported = true;
          node.localPageId = existingByNotionId.get(key);
        }
      }
    } catch {
      // Graceful fallback if database is not reachable (e.g. mock unit tests)
    }
  }

  return [...nodes.values()].filter((n) => !attached.has(normalizeId(n.id)));
}

/**
 * A row page counts as empty when it has no blocks at all, or only blank
 * paragraphs — Notion leaves one behind on a row nobody ever opened. More
 * blocks than the sample window reads as content, which is the safe direction:
 * it recommends articles rather than a table that would drop them.
 */
export function rowHasBodyContent(list: NotionListResponse<Record<string, unknown>>): boolean {
  for (const block of list.results) {
    if (block.type !== 'paragraph') return true;
    const paragraph = block.paragraph;
    if (!paragraph || typeof paragraph !== 'object' || !('rich_text' in paragraph)) continue;
    if (Array.isArray(paragraph.rich_text) && paragraph.rich_text.length > 0) return true;
  }
  return list.has_more;
}

/**
 * Settles every database node's import shape.
 *
 * `columns` and `isWiki` came free off the database object. The open question —
 * do the rows carry page content? — costs a request per row, so it is sampled
 * and capped. The answer only picks the picker's default: `notion-import-service`
 * re-reads every row before it flattens one into a table, so an unlucky sample
 * costs a recommendation and never content. Probe failures are swallowed for the
 * same reason; a picker that 500s over advisory copy is worse than one that
 * recommends articles.
 */
async function classifyDatabases(client: NotionClient, nodes: Map<string, NotionTreeNode>): Promise<void> {
  const databases: NotionTreeDatabaseNode[] = [];
  for (const node of nodes.values()) {
    if (node.type === 'database') databases.push(node);
  }
  if (databases.length === 0) return;

  const limit = pLimit(NOTION_LOOKUP_CONCURRENCY);
  const pending: Array<Promise<void>> = [];
  let budget = NOTION_ROW_SAMPLE_BUDGET;

  for (const database of databases) {
    const rows = database.children.filter(
      (child) => child.type === 'page' && child.isDatabaseRow === true,
    );
    database.rowCount = rows.length;
    database.recommendedMode = 'pages';

    // A wiki's rows are articles by definition, so nothing a sample could say
    // would turn one into a table. Spend no requests on it.
    if (database.isWiki || rows.length === 0 || budget === 0) {
      database.rowContent = 'unknown';
      continue;
    }

    const sample = rows.slice(0, Math.min(NOTION_ROW_SAMPLE_SIZE, budget));
    budget -= sample.length;
    pending.push(
      (async () => {
        const verdicts = await Promise.all(
          sample.map((row) =>
            limit(async () => {
              try {
                return rowHasBodyContent(await client.getBlockChildren(row.id, { pageSize: 2 }))
                  ? 'content'
                  : 'empty';
              } catch {
                return 'unreadable';
              }
            }),
          ),
        );
        if (verdicts.includes('content')) {
          database.rowContent = 'some';
        } else if (verdicts.includes('empty')) {
          database.rowContent = 'none';
          database.recommendedMode = 'table';
        } else {
          database.rowContent = 'unknown';
        }
      })(),
    );
  }

  await Promise.all(pending);
}
