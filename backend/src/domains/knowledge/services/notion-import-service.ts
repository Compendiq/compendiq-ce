/**
 * One-shot Notion → standalone page import (#1465 / #1459).
 *
 * Creates `source = 'standalone'` rows under a local destination. Databases
 * and other unsupported types are skipped (no stub). A stored
 * `notion_page_id` makes a re-run report `already_imported` instead of
 * duplicating. There is no `pages.source = 'notion'` and no database query.
 */
import {
  NOTION_UNSUPPORTED_LABEL,
  type NotionImportItem,
} from '@compendiq/contracts';
import { query } from '../../../core/db/postgres.js';
import { putLocalAttachment } from '../../../core/services/local-attachment-service.js';
import { logger } from '../../../core/utils/logger.js';
import { NotionClient, NotionError } from './notion-client.js';
import {
  convertNotionBlocks,
  type NotionBlock,
} from './notion-block-converter.js';

const NO_RECURSE_TYPES = new Set(['child_page', 'child_database']);

export class NotionImportError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'NotionImportError';
  }
}

export interface RunNotionImportInput {
  userId: string;
  client: NotionClient;
  pageIds: string[];
  spaceKey?: string;
  parentId?: string;
  visibility: 'private' | 'shared';
}

export async function runNotionImport(input: RunNotionImportInput): Promise<NotionImportItem[]> {
  const destination = await resolveDestination(input);
  const items = new Map<string, NotionImportItem>();
  const fetched = new Map<string, Record<string, unknown>>();

  for (const rawId of input.pageIds) {
    if (items.has(rawId)) continue;
    if (rawId.startsWith('linked:')) {
      items.set(rawId, { notionPageId: rawId, status: 'skip', reason: NOTION_UNSUPPORTED_LABEL });
      continue;
    }
    const existing = await findImportedPage(input.userId, rawId);
    if (existing) {
      items.set(rawId, {
        notionPageId: rawId,
        status: 'already_imported',
        localPageId: existing.id,
      });
      continue;
    }
    const classified = await classifySelection(input.client, rawId);
    if (classified.kind === 'skip') {
      items.set(rawId, { notionPageId: rawId, status: 'skip', reason: classified.reason });
      continue;
    }
    if (classified.kind === 'fail') {
      items.set(rawId, { notionPageId: rawId, status: 'fail', reason: classified.reason });
      continue;
    }
    fetched.set(rawId, classified.page);
  }

  const importedPages = new Map<string, number>();
  for (const item of items.values()) {
    if ((item.status === 'already_imported' || item.status === 'success') && item.localPageId) {
      importedPages.set(normalizeNotionId(item.notionPageId), item.localPageId);
    }
  }

  const toCreate = [...fetched.entries()].map(([id, page]) => ({
    id,
    page,
    title: extractTitle(page),
    parentNotionId: parentPageIdOf(page),
  }));
  const ordered = topoBySelectedParent(toCreate, new Set(toCreate.map((j) => normalizeNotionId(j.id))));

  for (const job of ordered) {
    try {
      const parentLocal = resolveParentLocalId(job.parentNotionId, importedPages, destination.parentId);
      const created = await insertStandalonePage({
        userId: input.userId,
        title: job.title,
        spaceKey: destination.spaceKey,
        parentId: parentLocal,
        visibility: destination.visibility,
        notionPageId: job.id,
      });
      importedPages.set(normalizeNotionId(job.id), created.id);
      items.set(job.id, { notionPageId: job.id, status: 'success', localPageId: created.id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await findImportedPage(input.userId, job.id);
        if (existing) {
          importedPages.set(normalizeNotionId(job.id), existing.id);
          items.set(job.id, {
            notionPageId: job.id,
            status: 'already_imported',
            localPageId: existing.id,
          });
          continue;
        }
      }
      items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
    }
  }

  for (const job of ordered) {
    const current = items.get(job.id);
    if (current?.status !== 'success' || !current.localPageId) continue;
    const localPageId = current.localPageId;
    try {
      const blocks = await fetchBlocksDeep(input.client, job.id);
      const converted = convertNotionBlocks(blocks, { localPageId, importedPages });
      await query(
        `UPDATE pages
            SET body_html = $2, body_text = $3, embedding_dirty = TRUE, image_embedding_dirty = TRUE
          WHERE id = $1`,
        [localPageId, converted.bodyHtml, converted.bodyText],
      );
      await storeAttachments(input.client, input.userId, localPageId, converted.attachments);
    } catch (err) {
      await query('DELETE FROM pages WHERE id = $1', [localPageId]);
      importedPages.delete(normalizeNotionId(job.id));
      items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
    }
  }

  return input.pageIds.map((id) => items.get(id) ?? { notionPageId: id, status: 'fail', reason: 'Unknown item' });
}

interface Destination {
  spaceKey: string | null;
  parentId: string | null;
  visibility: 'private' | 'shared';
}

async function resolveDestination(input: RunNotionImportInput): Promise<Destination> {
  let spaceSource: string | null = null;
  if (input.spaceKey && input.spaceKey !== '__local__') {
    const spaceRow = await query<{ source: string }>(
      'SELECT source FROM spaces WHERE space_key = $1',
      [input.spaceKey],
    );
    if (spaceRow.rows.length > 0) spaceSource = spaceRow.rows[0]!.source;
  }
  const spaceKey: string | null = spaceSource === 'local' ? input.spaceKey! : null;

  if (input.parentId) {
    const parentResult = await query<{ path: string | null; space_key: string | null }>(
      'SELECT path, space_key FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [input.parentId],
    );
    if (parentResult.rows.length === 0) {
      throw new NotionImportError('Parent page not found', 400);
    }
    if (spaceKey && parentResult.rows[0]!.space_key !== spaceKey) {
      throw new NotionImportError('Parent page must belong to the same space', 400);
    }
  }

  return { spaceKey, parentId: input.parentId ?? null, visibility: input.visibility };
}

async function insertStandalonePage(opts: {
  userId: string;
  title: string;
  spaceKey: string | null;
  parentId: string | null;
  visibility: 'private' | 'shared';
  notionPageId: string;
}): Promise<{ id: number }> {
  let parentPath: string | null = null;
  if (opts.parentId) {
    const parentResult = await query<{ path: string | null }>(
      'SELECT path FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [opts.parentId],
    );
    parentPath = parentResult.rows[0]?.path ?? null;
  }

  const result = await query<{ id: number }>(
    `INSERT INTO pages
       (title, body_html, body_text, body_storage, source, created_by_user_id,
        visibility, version, space_key, confluence_id, parent_id,
        page_type, embedding_dirty, image_embedding_dirty, embedding_status, last_synced, labels, notion_page_id)
     VALUES ($1, '', '', NULL, 'standalone', $2, $3, 1, $4, NULL, $5,
             'page', TRUE, TRUE, 'not_embedded', NOW(), '{}', $6)
     RETURNING id`,
    [opts.title, opts.userId, opts.visibility, opts.spaceKey, opts.parentId, opts.notionPageId],
  );
  const id = result.rows[0]!.id;
  const newPath = parentPath ? `${parentPath}/${id}` : `/${id}`;
  const depth = newPath.split('/').filter(Boolean).length - 1;
  await query('UPDATE pages SET path = $1, depth = $2 WHERE id = $3', [newPath, depth, id]);
  return { id };
}

async function findImportedPage(userId: string, notionPageId: string): Promise<{ id: number } | null> {
  const result = await query<{ id: number }>(
    `SELECT id FROM pages
      WHERE created_by_user_id = $1
        AND deleted_at IS NULL
        AND notion_page_id IS NOT NULL
        AND lower(replace(notion_page_id, '-', '')) = $2
      LIMIT 1`,
    [userId, normalizeNotionId(notionPageId)],
  );
  return result.rows[0] ?? null;
}

type Classified =
  | { kind: 'page'; page: Record<string, unknown> }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

async function classifySelection(client: NotionClient, id: string): Promise<Classified> {
  try {
    const page = await client.getPage(id);
    if (page.object === 'database' || page.object === 'data_source') {
      return { kind: 'skip', reason: NOTION_UNSUPPORTED_LABEL };
    }
    return { kind: 'page', page };
  } catch (err) {
    if (isMissing(err)) {
      try {
        await client.getDatabase(id);
        return { kind: 'skip', reason: NOTION_UNSUPPORTED_LABEL };
      } catch (dbErr) {
        if (isMissing(dbErr)) return { kind: 'fail', reason: failReason(dbErr) };
        return { kind: 'fail', reason: failReason(dbErr) };
      }
    }
    return { kind: 'fail', reason: failReason(err) };
  }
}

async function fetchBlocksDeep(client: NotionClient, blockId: string): Promise<NotionBlock[]> {
  let raw: Array<Record<string, unknown>>;
  try {
    raw = await client.getAllBlockChildren(blockId);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const out: NotionBlock[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;
    const block = item as NotionBlock;
    if (block.has_children === true && typeof block.id === 'string' && !NO_RECURSE_TYPES.has(block.type)) {
      block.children = await fetchBlocksDeep(client, block.id);
    }
    out.push(block);
  }
  return out;
}

async function storeAttachments(
  client: NotionClient,
  userId: string,
  pageId: number,
  attachments: Array<{ filename: string; sourceUrl: string }>,
): Promise<void> {
  for (const att of attachments) {
    try {
      const media = await client.fetchMedia(att.sourceUrl);
      await putLocalAttachment({
        pageId,
        filename: att.filename,
        contentType: media.contentType || 'application/octet-stream',
        data: media.bytes,
        userId,
      });
    } catch (err) {
      logger.warn({ pageId, filename: att.filename, err: failReason(err) }, 'notion-import: attachment download skipped');
    }
  }
}

function resolveParentLocalId(
  parentNotionId: string | null,
  importedPages: Map<string, number>,
  destinationParentId: string | null,
): string | null {
  if (parentNotionId) {
    const local = importedPages.get(normalizeNotionId(parentNotionId));
    if (typeof local === 'number') return String(local);
  }
  return destinationParentId;
}

function topoBySelectedParent<T extends { id: string; parentNotionId: string | null }>(
  jobs: T[],
  selected: Set<string>,
): T[] {
  const byNorm = new Map(jobs.map((j) => [normalizeNotionId(j.id), j]));
  const remaining = new Set(byNorm.keys());
  const out: T[] = [];
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const key of remaining) {
      const job = byNorm.get(key)!;
      const parent = job.parentNotionId ? normalizeNotionId(job.parentNotionId) : null;
      if (!parent || !selected.has(parent) || !remaining.has(parent)) ready.push(key);
    }
    if (ready.length === 0) {
      out.push(...[...remaining].map((k) => byNorm.get(k)!));
      break;
    }
    ready.sort();
    for (const key of ready) {
      out.push(byNorm.get(key)!);
      remaining.delete(key);
    }
  }
  return out;
}

function parentPageIdOf(page: Record<string, unknown>): string | null {
  const parent = isRecord(page.parent) ? page.parent : null;
  if (!parent || typeof parent.type !== 'string') return null;
  if (parent.type === 'page_id' && typeof parent.page_id === 'string') return parent.page_id;
  return null;
}

function extractTitle(item: Record<string, unknown>): string {
  const props = item.properties;
  if (props && typeof props === 'object') {
    for (const prop of Object.values(props as Record<string, unknown>)) {
      if (prop && typeof prop === 'object' && (prop as { type?: string }).type === 'title') {
        const t = richTextToPlain((prop as { title?: unknown }).title);
        if (t.trim()) return t;
      }
    }
  }
  const direct = richTextToPlain(item.title);
  if (direct.trim()) return direct;
  return 'Untitled';
}

function richTextToPlain(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (item && typeof item === 'object' && 'plain_text' in item && typeof (item as { plain_text: unknown }).plain_text === 'string') {
        return (item as { plain_text: string }).plain_text;
      }
      return '';
    })
    .join('');
}

function normalizeNotionId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

function isMissing(err: unknown): boolean {
  return err instanceof NotionError && (err.statusCode === 404 || err.statusCode === 403);
}

function failReason(err: unknown): string {
  if (err instanceof NotionError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Import failed';
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
