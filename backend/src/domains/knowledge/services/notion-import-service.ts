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
import { cleanupStandalonePageAttachmentDirs } from '../../../core/services/standalone-attachment-cleanup.js';
import { logger } from '../../../core/utils/logger.js';
import { withNotionImportLock } from './notion-import-lock.js';
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
  const jobs: ImportJob[] = [];
  const alreadyImported: AlreadyImported[] = [];

  for (const rawId of input.pageIds) {
    if (items.has(rawId)) continue;
    if (rawId.startsWith('linked:')) {
      items.set(rawId, { notionPageId: rawId, status: 'skip', reason: NOTION_UNSUPPORTED_LABEL });
      continue;
    }
    const existing = await withNotionImportLock(
      rawId,
      async () => findImportedPage(input.userId, rawId),
    );
    if (existing?.complete) {
      items.set(rawId, {
        notionPageId: rawId,
        status: 'already_imported',
        localPageId: existing.id,
      });
      const page = await getPageQuietly(input.client, rawId);
      alreadyImported.push({
        notionPageId: rawId,
        localPageId: existing.id,
        parentNotionId: page ? parentPageIdOf(page) : null,
        page,
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
    jobs.push({
      id: rawId,
      page: classified.page,
      title: extractTitle(classified.page),
      parentNotionId: parentPageIdOf(classified.page),
    });
  }

  const importedPages = new Map<string, number>();
  for (const item of items.values()) {
    if (item.status === 'already_imported' && item.localPageId) {
      importedPages.set(normalizeNotionId(item.notionPageId), item.localPageId);
    }
  }

  for (const job of jobs) {
    try {
      job.blocks = await fetchBlocksDeep(input.client, job.id);
    } catch (err) {
      items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
    }
  }

  const toPersist = jobs.filter((job) => !items.has(job.id));
  const selectedKeys = new Set([
    ...toPersist.map((j) => normalizeNotionId(j.id)),
    ...alreadyImported.map((row) => normalizeNotionId(row.notionPageId)),
  ]);
  applyChildPageHosts(toPersist, alreadyImported);
  await resolveRemainingBlockParents(input.client, toPersist, alreadyImported, selectedKeys);
  const ordered = topoBySelectedParent(
    toPersist,
    new Set(toPersist.map((j) => normalizeNotionId(j.id))),
  );

  // Allocate every local ID before converting any final body. This makes forward
  // mention rewrites deterministic without holding more than one page lock.
  for (const job of ordered) {
    await withNotionImportLock(job.id, async () => {
      const existing = await findImportedPage(input.userId, job.id);
      if (existing?.complete) {
        importedPages.set(normalizeNotionId(job.id), existing.id);
        items.set(job.id, {
          notionPageId: job.id,
          status: 'already_imported',
          localPageId: existing.id,
        });
        alreadyImported.push({
          notionPageId: job.id,
          localPageId: existing.id,
          parentNotionId: job.parentNotionId,
          page: job.page,
        });
        return;
      }

      try {
        const localPageId = existing?.id ?? await nextPageId();
        const parentLocal = resolveParentLocalId(job.parentNotionId, importedPages, destination.parentId);
        await persistStandalonePage({
          id: localPageId,
          reuse: Boolean(existing),
          userId: input.userId,
          title: job.title,
          spaceKey: destination.spaceKey,
          parentId: parentLocal,
          visibility: destination.visibility,
          notionPageId: job.id,
          bodyHtml: '',
          bodyText: '',
        });
        job.localPageId = localPageId;
        job.createdPlaceholder = !existing;
        importedPages.set(normalizeNotionId(job.id), localPageId);
      } catch (err) {
        if (isUniqueViolation(err)) {
          const concurrent = await findImportedPage(input.userId, job.id);
          if (concurrent) {
            job.localPageId = concurrent.id;
            importedPages.set(normalizeNotionId(job.id), concurrent.id);
            if (concurrent.complete) {
              items.set(job.id, {
                notionPageId: job.id,
                status: 'already_imported',
                localPageId: concurrent.id,
              });
            }
            return;
          }
        }
        items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
      }
    });
  }

  // Prepare attachments while every page remains observably incomplete. Failed
  // pages leave the mention map before any final body is written.
  for (const job of ordered) {
    if (!job.localPageId || items.has(job.id)) continue;
    await withNotionImportLock(job.id, async () => {
      const existing = await findImportedPage(input.userId, job.id);
      if (existing?.complete) {
        importedPages.set(normalizeNotionId(job.id), existing.id);
        items.set(job.id, {
          notionPageId: job.id,
          status: 'already_imported',
          localPageId: existing.id,
        });
        alreadyImported.push({
          notionPageId: job.id,
          localPageId: existing.id,
          parentNotionId: job.parentNotionId,
          page: job.page,
        });
        return;
      }

      if (existing && existing.id !== job.localPageId) {
        job.localPageId = existing.id;
        job.createdPlaceholder = false;
        importedPages.set(normalizeNotionId(job.id), existing.id);
      }
      try {
        const converted = convertNotionBlocks(job.blocks ?? [], {
          localPageId: job.localPageId,
          importedPages,
        });
        await storeAttachments(input.client, input.userId, job.localPageId, converted.attachments);
        job.prepared = true;
      } catch (err) {
        if (job.createdPlaceholder) {
          const placeholder = await findImportedPage(input.userId, job.id);
          if (placeholder?.id === job.localPageId && !placeholder.complete) {
            await abandonPage(job.localPageId, destination.parentId);
          }
        }
        importedPages.delete(normalizeNotionId(job.id));
        items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
      }
    });
  }

  // The final body write is the completion boundary and therefore remains in
  // the same keyed critical section observed by every completed-page fast path.
  for (const job of ordered) {
    if (!job.prepared || !job.localPageId || items.has(job.id)) continue;
    await withNotionImportLock(job.id, async () => {
      const existing = await findImportedPage(input.userId, job.id);
      if (existing?.complete) {
        importedPages.set(normalizeNotionId(job.id), existing.id);
        items.set(job.id, {
          notionPageId: job.id,
          status: 'already_imported',
          localPageId: existing.id,
        });
        alreadyImported.push({
          notionPageId: job.id,
          localPageId: existing.id,
          parentNotionId: job.parentNotionId,
          page: job.page,
        });
        return;
      }

      try {
        if (!existing || existing.id !== job.localPageId) {
          throw new Error('Notion import placeholder disappeared before finalization');
        }
        const converted = convertNotionBlocks(job.blocks ?? [], {
          localPageId: job.localPageId,
          importedPages,
        });
        await query(
          'UPDATE pages SET body_html = $2, body_text = $3 WHERE id = $1',
          [job.localPageId, converted.bodyHtml, converted.bodyText],
        );
        items.set(job.id, {
          notionPageId: job.id,
          status: 'success',
          localPageId: job.localPageId,
        });
      } catch (err) {
        if (job.createdPlaceholder) {
          const placeholder = await findImportedPage(input.userId, job.id);
          if (placeholder?.id === job.localPageId && !placeholder.complete) {
            await abandonPage(job.localPageId, destination.parentId);
          }
        }
        importedPages.delete(normalizeNotionId(job.id));
        items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
      }
    });
  }

  await rehomeAlreadyImported(alreadyImported, importedPages);

  return input.pageIds.map((id) => items.get(id) ?? { notionPageId: id, status: 'fail', reason: 'Unknown item' });
}

interface ImportJob {
  id: string;
  page: Record<string, unknown>;
  title: string;
  parentNotionId: string | null;
  blocks?: NotionBlock[];
  localPageId?: number;
  createdPlaceholder?: boolean;
  prepared?: boolean;
}

interface AlreadyImported {
  notionPageId: string;
  localPageId: number;
  parentNotionId: string | null;
  page: Record<string, unknown> | null;
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

async function nextPageId(): Promise<number> {
  const result = await query<{ id: string }>('SELECT nextval(\'pages_id_seq\')::text AS id');
  return Number.parseInt(result.rows[0]!.id, 10);
}

async function persistStandalonePage(opts: {
  id: number;
  reuse: boolean;
  userId: string;
  title: string;
  spaceKey: string | null;
  parentId: string | null;
  visibility: 'private' | 'shared';
  notionPageId: string;
  bodyHtml: string;
  bodyText: string;
}): Promise<void> {
  let parentPath: string | null = null;
  if (opts.parentId) {
    const parentResult = await query<{ path: string | null }>(
      'SELECT path FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [opts.parentId],
    );
    parentPath = parentResult.rows[0]?.path ?? `/${opts.parentId}`;
  }
  const newPath = parentPath ? `${parentPath}/${opts.id}` : `/${opts.id}`;
  const depth = newPath.split('/').filter(Boolean).length - 1;

  if (opts.reuse) {
    await query(
      `UPDATE pages
          SET title = $2, body_html = $3, body_text = $4, space_key = $5, parent_id = $6,
              visibility = $7, path = $8, depth = $9, embedding_dirty = TRUE, image_embedding_dirty = TRUE
        WHERE id = $1 AND deleted_at IS NULL`,
      [opts.id, opts.title, opts.bodyHtml, opts.bodyText, opts.spaceKey, opts.parentId, opts.visibility, newPath, depth],
    );
    return;
  }

  await query(
    `INSERT INTO pages
       (id, title, body_html, body_text, body_storage, source, created_by_user_id,
        visibility, version, space_key, confluence_id, parent_id,
        page_type, embedding_dirty, image_embedding_dirty, embedding_status, last_synced, labels, notion_page_id, path, depth)
     VALUES ($1, $2, $3, $4, NULL, 'standalone', $5, $6, 1, $7, NULL, $8,
             'page', TRUE, TRUE, 'not_embedded', NOW(), '{}', $9, $10, $11)`,
    [
      opts.id, opts.title, opts.bodyHtml, opts.bodyText, opts.userId,
      opts.visibility, opts.spaceKey, opts.parentId, opts.notionPageId, newPath, depth,
    ],
  );
}

async function findImportedPage(
  userId: string,
  notionPageId: string,
): Promise<{ id: number; complete: boolean } | null> {
  const result = await query<{ id: number; body_html: string | null }>(
    `SELECT id, body_html FROM pages
      WHERE created_by_user_id = $1
        AND deleted_at IS NULL
        AND notion_page_id IS NOT NULL
        AND lower(replace(notion_page_id, '-', '')) = $2
      LIMIT 1`,
    [userId, normalizeNotionId(notionPageId)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, complete: Boolean(row.body_html && row.body_html.trim().length > 0) };
}

async function abandonPage(pageId: number, destinationParentId: string | null): Promise<void> {
  const page = await query<{ path: string | null }>(
    'SELECT path FROM pages WHERE id = $1',
    [pageId],
  );
  const oldPath = page.rows[0]?.path ?? `/${pageId}`;
  let destPath = '';
  if (destinationParentId) {
    const dest = await query<{ path: string | null }>(
      'SELECT path FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [destinationParentId],
    );
    destPath = dest.rows[0]?.path ?? `/${destinationParentId}`;
  }
  const descendants = await query<{ id: number; parent_id: string | null; path: string }>(
    `SELECT id, parent_id, path FROM pages
      WHERE deleted_at IS NULL AND path IS NOT NULL AND path LIKE $1`,
    [`${oldPath}/%`],
  );
  for (const kid of descendants.rows) {
    const suffix = kid.path.slice(oldPath.length);
    const newPath = `${destPath}${suffix}` || `/${kid.id}`;
    const depth = newPath.split('/').filter(Boolean).length - 1;
    const parentId = kid.parent_id === String(pageId) ? destinationParentId : kid.parent_id;
    await query('UPDATE pages SET parent_id = $1, path = $2, depth = $3 WHERE id = $4', [
      parentId,
      newPath,
      depth,
      kid.id,
    ]);
  }
  await query('DELETE FROM pages WHERE id = $1', [pageId]);
  await cleanupStandalonePageAttachmentDirs(pageId);
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
        return { kind: 'fail', reason: failReason(dbErr) };
      }
    }
    return { kind: 'fail', reason: failReason(err) };
  }
}

async function fetchBlocksDeep(client: NotionClient, blockId: string): Promise<NotionBlock[]> {
  const raw = await client.getAllBlockChildren(blockId);
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
      logger.warn({ pageId, filename: att.filename, err: failReason(err) }, 'notion-import: attachment download failed');
      throw err instanceof Error ? err : new Error(failReason(err));
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

function parentBlockIdOf(page: Record<string, unknown> | null): string | null {
  if (!page) return null;
  const parent = isRecord(page.parent) ? page.parent : null;
  if (!parent || parent.type !== 'block_id') return null;
  return typeof parent.block_id === 'string' ? parent.block_id : null;
}

function applyChildPageHosts(jobs: ImportJob[], already: AlreadyImported[]): void {
  const hostByChild = new Map<string, string>();
  for (const job of jobs) {
    if (job.blocks) collectChildPageHosts(job.blocks, job.id, hostByChild);
  }
  for (const job of jobs) {
    const host = hostByChild.get(normalizeNotionId(job.id));
    if (host) job.parentNotionId = host;
  }
  for (const row of already) {
    const host = hostByChild.get(normalizeNotionId(row.notionPageId));
    if (host) row.parentNotionId = host;
  }
}

function collectChildPageHosts(blocks: readonly NotionBlock[], hostId: string, out: Map<string, string>): void {
  for (const block of blocks) {
    if (block.type === 'child_page' && typeof block.id === 'string') {
      out.set(normalizeNotionId(block.id), hostId);
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      collectChildPageHosts(block.children, hostId, out);
    }
  }
}

async function resolveRemainingBlockParents(
  client: NotionClient,
  jobs: ImportJob[],
  already: AlreadyImported[],
  selectedKeys: Set<string>,
): Promise<void> {
  for (const job of jobs) {
    if (job.parentNotionId) continue;
    const blockId = parentBlockIdOf(job.page);
    if (!blockId) continue;
    const host = await resolveHostPageId(client, blockId, selectedKeys);
    if (host) job.parentNotionId = host;
  }
  for (const row of already) {
    if (row.parentNotionId) continue;
    const blockId = parentBlockIdOf(row.page);
    if (!blockId) continue;
    const host = await resolveHostPageId(client, blockId, selectedKeys);
    if (host) row.parentNotionId = host;
  }
}

async function resolveHostPageId(
  client: NotionClient,
  startBlockId: string,
  selectedKeys: Set<string>,
): Promise<string | null> {
  const seen = new Set<string>();
  let current = startBlockId;
  for (let i = 0; i < 25; i++) {
    const key = normalizeNotionId(current);
    if (seen.has(key)) return null;
    seen.add(key);
    if (selectedKeys.has(key)) return current;
    let block: Record<string, unknown>;
    try {
      block = await client.getBlock(current);
    } catch {
      return null;
    }
    const parent = isRecord(block.parent) ? block.parent : null;
    if (!parent || typeof parent.type !== 'string') return null;
    if (parent.type === 'page_id' && typeof parent.page_id === 'string') {
      return selectedKeys.has(normalizeNotionId(parent.page_id)) ? parent.page_id : null;
    }
    if (parent.type === 'block_id' && typeof parent.block_id === 'string') {
      current = parent.block_id;
      continue;
    }
    return null;
  }
  return null;
}

async function getPageQuietly(client: NotionClient, id: string): Promise<Record<string, unknown> | null> {
  try {
    return await client.getPage(id);
  } catch {
    return null;
  }
}

async function rehomeAlreadyImported(
  already: AlreadyImported[],
  importedPages: Map<string, number>,
): Promise<void> {
  for (const row of already) {
    if (!row.parentNotionId) continue;
    const parentLocal = importedPages.get(normalizeNotionId(row.parentNotionId));
    if (typeof parentLocal !== 'number') continue;
    await rehomePage(row.localPageId, String(parentLocal));
  }
}

async function rehomePage(pageId: number, parentId: string | null): Promise<void> {
  const current = await query<{ parent_id: string | null; path: string | null }>(
    'SELECT parent_id, path FROM pages WHERE id = $1 AND deleted_at IS NULL',
    [pageId],
  );
  const row = current.rows[0];
  if (!row) return;
  if ((row.parent_id ?? null) === (parentId ?? null)) return;

  let parentPath: string | null = null;
  if (parentId) {
    const parent = await query<{ path: string | null }>(
      'SELECT path FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [parentId],
    );
    parentPath = parent.rows[0]?.path ?? `/${parentId}`;
  }
  const oldPath = row.path ?? `/${pageId}`;
  const newPath = parentPath ? `${parentPath}/${pageId}` : `/${pageId}`;
  const depth = newPath.split('/').filter(Boolean).length - 1;
  await query('UPDATE pages SET parent_id = $1, path = $2, depth = $3 WHERE id = $4', [
    parentId,
    newPath,
    depth,
    pageId,
  ]);
  const descendants = await query<{ id: number; path: string }>(
    `SELECT id, path FROM pages WHERE deleted_at IS NULL AND path IS NOT NULL AND path LIKE $1`,
    [`${oldPath}/%`],
  );
  for (const kid of descendants.rows) {
    const suffix = kid.path.slice(oldPath.length);
    const kidPath = `${newPath}${suffix}`;
    const kidDepth = kidPath.split('/').filter(Boolean).length - 1;
    await query('UPDATE pages SET path = $1, depth = $2 WHERE id = $3', [kidPath, kidDepth, kid.id]);
  }
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
