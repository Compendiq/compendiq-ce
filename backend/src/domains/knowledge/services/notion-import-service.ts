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
import { htmlToText } from '../../../core/services/content-converter.js';
import { putLocalAttachment } from '../../../core/services/local-attachment-service.js';
import { cleanupStandalonePageAttachmentDirs } from '../../../core/services/standalone-attachment-cleanup.js';
import { logger } from '../../../core/utils/logger.js';
import { NotionClient, NotionError } from './notion-client.js';
import {
  convertNotionBlocks,
  formatWikiMetadataCallout,
  type NotionBlock,
} from './notion-block-converter.js';
import { extractParentRelationId } from './notion-tree.js';
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
  overwriteExisting?: boolean;
  databaseModes?: Record<string, 'table' | 'articles' | 'skip'>;
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
    if (input.databaseModes && input.databaseModes[rawId] === 'skip') {
      items.set(rawId, { notionPageId: rawId, status: 'skip', reason: 'Database is excluded from import' });
      continue;
    }
    const existing = await findImportedPage(input.userId, rawId);
    if (existing?.complete && !input.overwriteExisting) {
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
      if (existing) await abandonPage(existing.id, destination.parentId);
      items.set(rawId, { notionPageId: rawId, status: 'skip', reason: classified.reason });
      continue;
    }
    if (classified.kind === 'fail') {
      if (existing) await abandonPage(existing.id, destination.parentId);
      items.set(rawId, { notionPageId: rawId, status: 'fail', reason: classified.reason });
      continue;
    }

    const parentNotionId = parentPageIdOf(classified.page);
    if (
      parentNotionId &&
      input.databaseModes &&
      input.databaseModes[parentNotionId] === 'skip'
    ) {
      items.set(rawId, {
        notionPageId: rawId,
        status: 'skip',
        reason: 'Parent database is excluded from import',
      });
      continue;
    }

    jobs.push({
      id: rawId,
      page: classified.page,
      title: extractTitle(classified.page),
      parentNotionId,
      reuseId: existing?.id,
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
      if (job.reuseId) await abandonPage(job.reuseId, destination.parentId);
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

  // Ensure container pages for database parents so child pages nest properly
  for (const job of toPersist) {
    if (job.parentNotionId && !importedPages.has(normalizeNotionId(job.parentNotionId))) {
      await ensureDatabaseContainerPage({
        client: input.client,
        userId: input.userId,
        databaseId: job.parentNotionId,
        destination,
        importedPages,
      });
    }
  }
  for (const row of alreadyImported) {
    if (row.parentNotionId && !importedPages.has(normalizeNotionId(row.parentNotionId))) {
      await ensureDatabaseContainerPage({
        client: input.client,
        userId: input.userId,
        databaseId: row.parentNotionId,
        destination,
        importedPages,
      });
    }
  }

  const ordered = topoBySelectedParent(
    toPersist,
    new Set(toPersist.map((j) => normalizeNotionId(j.id))),
  );

  for (const job of ordered) {
    let localPageId: number | undefined = job.reuseId;
    try {
      const parentLocal = await resolveParentLocalId(
        job.parentNotionId,
        importedPages,
        destination.parentId,
        input.userId,
      );
      localPageId = job.reuseId ?? (await nextPageId());

      const converted = convertNotionBlocks(job.blocks ?? [], {
        localPageId,
        importedPages,
      });
      const { wikiProps, bodyHtml: finalHtml, bodyText: finalBodyText } = wikiConvertedBody(job.page, converted);

      await persistStandalonePage({
        id: localPageId,
        reuse: Boolean(job.reuseId),
        userId: input.userId,
        title: job.title,
        spaceKey: destination.spaceKey,
        parentId: parentLocal,
        visibility: destination.visibility,
        notionPageId: job.id,
        bodyHtml: finalHtml,
        bodyText: finalBodyText,
        labels: wikiProps.labels,
        author: wikiProps.author,
        verifiedAt: wikiProps.verifiedAt,
      });
      await storeAttachments(input.client, input.userId, localPageId, converted.attachments);
      importedPages.set(normalizeNotionId(job.id), localPageId);
      items.set(job.id, { notionPageId: job.id, status: 'success', localPageId });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await findImportedPage(input.userId, job.id);
        if (existing?.complete) {
          importedPages.set(normalizeNotionId(job.id), existing.id);
          items.set(job.id, {
            notionPageId: job.id,
            status: 'already_imported',
            localPageId: existing.id,
          });
          continue;
        }
      }
      if (localPageId) {
        await abandonPage(localPageId, destination.parentId);
        importedPages.delete(normalizeNotionId(job.id));
      }
      items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
    }
  }

  await rewriteImportedMentions(ordered, items, importedPages);
  await rehomeAlreadyImported(alreadyImported, importedPages, input.userId);
  return input.pageIds.map((id) => items.get(id) ?? { notionPageId: id, status: 'fail', reason: 'Unknown item' });
}

interface ImportJob {
  id: string;
  page: Record<string, unknown>;
  title: string;
  parentNotionId: string | null;
  reuseId?: number;
  blocks?: NotionBlock[];
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
  labels?: string[];
  author?: string | null;
  verifiedAt?: Date | null;
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
              visibility = $7, path = $8, depth = $9, labels = $10,
              author = COALESCE($11, author),
              verified_at = COALESCE($12, verified_at),
              embedding_dirty = TRUE, image_embedding_dirty = TRUE
        WHERE id = $1 AND deleted_at IS NULL`,
      [
        opts.id, opts.title, opts.bodyHtml, opts.bodyText, opts.spaceKey,
        opts.parentId, opts.visibility, newPath, depth,
        opts.labels ?? [], opts.author ?? null, opts.verifiedAt ?? null,
      ],
    );
    return;
  }

  await query(
    `INSERT INTO pages
       (id, title, body_html, body_text, body_storage, source, created_by_user_id,
        visibility, version, space_key, confluence_id, parent_id,
        page_type, embedding_dirty, image_embedding_dirty, embedding_status,
        last_synced, labels, author, verified_at, notion_page_id, path, depth)
     VALUES ($1, $2, $3, $4, NULL, 'standalone', $5, $6, 1, $7, NULL, $8,
             'page', TRUE, TRUE, 'not_embedded',
             NOW(), $9, $10, $11, $12, $13, $14)`,
    [
      opts.id, opts.title, opts.bodyHtml, opts.bodyText, opts.userId,
      opts.visibility, opts.spaceKey, opts.parentId,
      opts.labels ?? [], opts.author ?? null, opts.verifiedAt ?? null,
      opts.notionPageId, newPath, depth,
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

async function rewriteImportedMentions(
  jobs: ImportJob[],
  items: Map<string, NotionImportItem>,
  importedPages: Map<string, number>,
): Promise<void> {
  for (const job of jobs) {
    const current = items.get(job.id);
    if (current?.status !== 'success' || !current.localPageId || !job.blocks) continue;
    const converted = convertNotionBlocks(job.blocks, {
      localPageId: current.localPageId,
      importedPages,
    });
    const { bodyHtml: finalHtml, bodyText: finalBodyText } = wikiConvertedBody(job.page, converted);

    await query(
      `UPDATE pages SET body_html = $2, body_text = $3 WHERE id = $1`,
      [current.localPageId, finalHtml, finalBodyText],
    );
  }
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
    if (block.type === 'child_database' && typeof block.id === 'string') {
      try {
        const searchRes = await client.search({
          filter: { property: 'object', value: 'page' },
        });
        const rows = searchRes.results.filter(
          (it) =>
            it.parent &&
            typeof it.parent === 'object' &&
            (it.parent as { database_id?: string }).database_id === block.id,
        );
        try {
          const dbDef = await client.getDatabase(block.id);
          if (dbDef && isRecord(dbDef.properties)) {
            block.databaseColumns = Object.keys(dbDef.properties);
          }
        } catch {
          // ignore
        }
        block.databaseRows = rows;
      } catch {
        // ignore
      }
    } else if (block.has_children === true && typeof block.id === 'string' && !NO_RECURSE_TYPES.has(block.type)) {
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

async function resolveParentLocalId(
  parentNotionId: string | null,
  importedPages: Map<string, number>,
  destinationParentId: string | null,
  userId: string,
): Promise<string | null> {
  if (parentNotionId) {
    const local = importedPages.get(normalizeNotionId(parentNotionId));
    if (typeof local === 'number') return String(local);

    const found = await findImportedPage(userId, parentNotionId);
    if (found?.complete) {
      importedPages.set(normalizeNotionId(parentNotionId), found.id);
      return String(found.id);
    }
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
  const relationParent = extractParentRelationId(page);
  if (relationParent) return relationParent;

  const parent = isRecord(page.parent) ? page.parent : null;
  if (!parent || typeof parent.type !== 'string') return null;
  if (parent.type === 'page_id' && typeof parent.page_id === 'string') return parent.page_id;
  if (parent.type === 'database_id' && typeof parent.database_id === 'string') return parent.database_id;
  if (parent.type === 'data_source_id' && typeof parent.data_source_id === 'string') return parent.data_source_id;
  return null;
}

async function ensureDatabaseContainerPage(opts: {
  client: NotionClient;
  userId: string;
  databaseId: string;
  destination: Destination;
  importedPages: Map<string, number>;
}): Promise<number | null> {
  const normId = normalizeNotionId(opts.databaseId);
  const existingLocal = opts.importedPages.get(normId);
  if (typeof existingLocal === 'number') return existingLocal;

  const found = await findImportedPage(opts.userId, opts.databaseId);
  if (found?.complete) {
    opts.importedPages.set(normId, found.id);
    return found.id;
  }

  try {
    let db: Record<string, unknown>;
    try {
      db = await opts.client.getDatabase(opts.databaseId);
    } catch {
      return null;
    }
    if (!db || isTrashed(db)) return null;
    const title = extractTitle(db) || 'Database';
    const pageId = found?.id ?? (await nextPageId());

    await persistStandalonePage({
      id: pageId,
      reuse: Boolean(found?.id),
      userId: opts.userId,
      title,
      spaceKey: opts.destination.spaceKey,
      parentId: opts.destination.parentId,
      visibility: opts.destination.visibility,
      notionPageId: opts.databaseId,
      bodyHtml: `<p class="text-muted-foreground italic">Notion database collection</p>`,
      bodyText: `Notion database collection: ${title}`,
      labels: ['notion-import', 'database'],
      author: null,
      verifiedAt: null,
    });

    opts.importedPages.set(normId, pageId);
    return pageId;
  } catch (err) {
    logger.warn(
      { databaseId: opts.databaseId, err: failReason(err) },
      'notion-import: failed to ensure database container page',
    );
    return null;
  }
}

function isTrashed(item: Record<string, unknown>): boolean {
  return item.in_trash === true || item.archived === true;
}


export interface ExtractedWikiProperties {
  author: string | null;
  verifiedAt: Date | null;
  labels: string[];
  status: string | null;
  customProperties: Record<string, string>;
}

export function extractWikiPageProperties(page: Record<string, unknown>): ExtractedWikiProperties {
  let author: string | null = null;
  let verifiedAt: Date | null = null;
  const labelsByLower = new Map<string, string>();
  let status: string | null = null;
  const customProperties: Record<string, string> = {};

  const props = isRecord(page.properties) ? page.properties : {};

  const addLabel = (name: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!labelsByLower.has(key)) labelsByLower.set(key, trimmed);
  };

  // 1. Author / Owner
  for (const [key, prop] of Object.entries(props)) {
    if (!isRecord(prop)) continue;
    const propType = typeof prop.type === 'string' ? prop.type : '';
    const lowerKey = key.toLowerCase();

    if (propType === 'people' && Array.isArray(prop.people) && prop.people.length > 0) {
      const person = prop.people[0];
      if (isRecord(person)) {
        const name = typeof person.name === 'string' && person.name.trim() ? person.name.trim() : null;
        if (name && (lowerKey.includes('owner') || lowerKey.includes('author'))) {
          author = name;
        }
      }
    } else if (propType === 'created_by' && isRecord(prop.created_by)) {
      const name = typeof prop.created_by.name === 'string' && prop.created_by.name.trim() ? prop.created_by.name.trim() : null;
      if (name && !author) {
        author = name;
      }
    }
  }

  if (!author && isRecord(page.created_by) && typeof page.created_by.name === 'string' && page.created_by.name.trim()) {
    author = page.created_by.name.trim();
  }

  // 2. Verification — only persist a real verification date, never import-time
  for (const [, prop] of Object.entries(props)) {
    if (!isRecord(prop)) continue;
    const propType = typeof prop.type === 'string' ? prop.type : '';

    if (propType === 'verification' && isRecord(prop.verification)) {
      const v = prop.verification;
      if (v.state === 'verified' && isRecord(v.date) && typeof v.date.start === 'string') {
        const dateObj = new Date(v.date.start);
        if (!isNaN(dateObj.getTime())) verifiedAt = dateObj;
      }
    }
  }

  // 3. Tags & Category (Category is mapped to tags)
  for (const [key, prop] of Object.entries(props)) {
    if (!isRecord(prop)) continue;
    const propType = typeof prop.type === 'string' ? prop.type : '';
    const lowerKey = key.toLowerCase();
    const isLabelKey = lowerKey.includes('tag') || lowerKey.includes('category') || lowerKey.includes('label');

    if (propType === 'multi_select' && Array.isArray(prop.multi_select) && isLabelKey) {
      for (const item of prop.multi_select) {
        if (isRecord(item) && typeof item.name === 'string') addLabel(item.name);
      }
    } else if (propType === 'select' && isRecord(prop.select) && isLabelKey) {
      const selName = typeof prop.select.name === 'string' ? prop.select.name : null;
      if (selName) addLabel(selName);
    }
  }

  // 4. Status
  for (const [key, prop] of Object.entries(props)) {
    if (!isRecord(prop)) continue;
    const propType = typeof prop.type === 'string' ? prop.type : '';
    const lowerKey = key.toLowerCase();

    if (propType === 'status' && isRecord(prop.status)) {
      const stName = typeof prop.status.name === 'string' && prop.status.name.trim() ? prop.status.name.trim() : null;
      if (stName) status = stName;
    } else if (lowerKey === 'status' && propType === 'select' && isRecord(prop.select)) {
      const stName = typeof prop.select.name === 'string' && prop.select.name.trim() ? prop.select.name.trim() : null;
      if (stName) status = stName;
    }
  }

  // 5. Custom / extended properties
  for (const [key, prop] of Object.entries(props)) {
    if (!isRecord(prop)) continue;
    const propType = typeof prop.type === 'string' ? prop.type : '';
    const lowerKey = key.toLowerCase();

    if (propType === 'title' || propType === 'status' || propType === 'verification') continue;
    if (lowerKey.includes('owner') || lowerKey.includes('author') || lowerKey.includes('tag') || lowerKey.includes('category') || lowerKey.includes('label')) continue;

    if (propType === 'number' && typeof prop.number === 'number') {
      customProperties[key] = String(prop.number);
    } else if (propType === 'url' && typeof prop.url === 'string' && prop.url.trim()) {
      customProperties[key] = prop.url.trim();
    } else if (propType === 'email' && typeof prop.email === 'string' && prop.email.trim()) {
      customProperties[key] = prop.email.trim();
    } else if (propType === 'phone_number' && typeof prop.phone_number === 'string' && prop.phone_number.trim()) {
      customProperties[key] = prop.phone_number.trim();
    } else if (propType === 'date' && isRecord(prop.date) && typeof prop.date.start === 'string') {
      customProperties[key] = prop.date.start;
    } else if (propType === 'checkbox' && typeof prop.checkbox === 'boolean') {
      customProperties[key] = prop.checkbox ? 'Yes' : 'No';
    } else if (propType === 'select' && isRecord(prop.select) && typeof prop.select.name === 'string') {
      customProperties[key] = prop.select.name;
    }
  }

  return {
    author,
    verifiedAt,
    labels: Array.from(labelsByLower.values()),
    status,
    customProperties,
  };
}

function wikiConvertedBody(
  page: Record<string, unknown>,
  converted: { bodyHtml: string; bodyText: string },
): { wikiProps: ExtractedWikiProperties; bodyHtml: string; bodyText: string } {
  const wikiProps = extractWikiPageProperties(page);
  const metaCalloutHtml = formatWikiMetadataCallout({
    status: wikiProps.status,
    author: wikiProps.author,
    verifiedAt: wikiProps.verifiedAt,
    tags: wikiProps.labels,
    customProperties: wikiProps.customProperties,
  });
  return {
    wikiProps,
    bodyHtml: metaCalloutHtml ? `${metaCalloutHtml}${converted.bodyHtml}` : converted.bodyHtml,
    bodyText: metaCalloutHtml ? `${htmlToText(metaCalloutHtml)}\n\n${converted.bodyText}` : converted.bodyText,
  };
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
  userId: string,
): Promise<void> {
  for (const row of already) {
    if (!row.parentNotionId) continue;
    let parentLocal = importedPages.get(normalizeNotionId(row.parentNotionId));
    if (typeof parentLocal !== 'number') {
      const found = await findImportedPage(userId, row.parentNotionId);
      if (found?.complete) {
        parentLocal = found.id;
        importedPages.set(normalizeNotionId(row.parentNotionId), found.id);
      }
    }
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
