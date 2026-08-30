/**
 * One-shot Notion → standalone page import (#1465 / #1459).
 *
 * Creates `source = 'standalone'` rows under a local destination. A stored
 * `notion_page_id` makes a re-run report `already_imported` instead of
 * duplicating. There is no `pages.source = 'notion'` and no live sync.
 *
 * A selected database takes one of two local shapes:
 *
 * - `table` — one page whose body is the rows × properties table. Offered only
 *   for a database whose row pages are all body-less, and VERIFIED here over
 *   every row rather than trusted from the picker's sample: flattening a row
 *   that has a body would drop that body, so a database that turns out to have
 *   one is imported as pages instead and says so on its result row.
 * - `pages` — a container page for the database, with the row pages imported as
 *   articles beneath it. The wiki shape. Which rows come along is the picker's
 *   selection, so the tree the operator confirmed is the tree they get.
 */
import {
  NOTION_UNSUPPORTED_LABEL,
  type NotionDatabaseMode,
  type NotionImportItem,
} from '@compendiq/contracts';
import pLimit from 'p-limit';
import { query } from '../../../core/db/postgres.js';
import { htmlToText } from '../../../core/services/content-converter.js';
import { putLocalAttachment } from '../../../core/services/local-attachment-service.js';
import { cleanupStandalonePageAttachmentDirs } from '../../../core/services/standalone-attachment-cleanup.js';
import { logger } from '../../../core/utils/logger.js';
import { withNotionImportLocks } from './notion-import-lock.js';
import { NotionClient, NotionError } from './notion-client.js';
import {
  convertNotionBlocks,
  escapeHtml,
  formatWikiMetadataCallout,
  renderDatabaseTable,
  type NotionBlock,
} from './notion-block-converter.js';
import { extractParentRelationId, isWikiDatabase, rowHasBodyContent } from './notion-tree.js';

const NO_RECURSE_TYPES = new Set(['child_page', 'child_database']);
/** Row-body checks run concurrently against Notion's per-integration rate limit. */
const NOTION_ROW_CHECK_CONCURRENCY = 5;

export const NOTION_TABLE_ROW_SKIP_REASON = 'Included in the database table' as const;
export const NOTION_TABLE_DOWNGRADE_REASON =
  'Rows have page content — imported as pages instead of one table' as const;

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
  databaseModes?: Record<string, NotionDatabaseMode>;
}
export async function runNotionImport(input: RunNotionImportInput): Promise<NotionImportItem[]> {
  return withNotionImportLocks(input.pageIds, async () => runLockedNotionImport(input));
}

async function runLockedNotionImport(input: RunNotionImportInput): Promise<NotionImportItem[]> {
  const destination = await resolveDestination(input);
  const items = new Map<string, NotionImportItem>();
  const jobs: ImportJob[] = [];
  const databaseJobs: DatabaseJob[] = [];
  const alreadyImported: AlreadyImported[] = [];
  const skippedDatabases = new Set(
    Object.entries(input.databaseModes ?? {})
      .filter(([, mode]) => mode === 'skip')
      .map(([id]) => normalizeNotionId(id)),
  );
  const isSkippedDatabase = (id: string | null | undefined): boolean =>
    Boolean(id && skippedDatabases.has(normalizeNotionId(id)));

  for (const rawId of input.pageIds) {
    if (items.has(rawId)) continue;
    if (rawId.startsWith('linked:')) {
      items.set(rawId, { notionPageId: rawId, status: 'skip', reason: NOTION_UNSUPPORTED_LABEL });
      continue;
    }
    if (isSkippedDatabase(rawId)) {
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
      if (existing && !existing.complete) await abandonPage(existing.id, destination.parentId);
      items.set(rawId, { notionPageId: rawId, status: 'skip', reason: classified.reason });
      continue;
    }
    if (classified.kind === 'fail') {
      if (existing && !existing.complete) await abandonPage(existing.id, destination.parentId);
      items.set(rawId, { notionPageId: rawId, status: 'fail', reason: classified.reason });
      continue;
    }
    if (classified.kind === 'database') {
      databaseJobs.push({
        id: rawId,
        database: classified.database,
        title: extractTitle(classified.database) || 'Database',
        requestedMode: input.databaseModes?.[rawId],
        reuseId: existing?.id,
        reuseComplete: existing?.complete === true,
      });
      continue;
    }

    const parentNotionId = parentPageIdOf(classified.page);
    if (isSkippedDatabase(parentNotionId)) {
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
      reuseComplete: existing?.complete === true,
    });
  }

  const importedPages = new Map<string, number>();
  for (const item of items.values()) {
    if (item.status === 'already_imported' && item.localPageId) {
      importedPages.set(normalizeNotionId(item.notionPageId), item.localPageId);
    }
  }

  // Databases resolve to their local shape first: a row selected alongside its
  // database must find the container page already placed, and a row belonging to
  // a database that became one table must not also arrive as its own page.
  const tableDatabases = new Set<string>();
  for (const dbJob of databaseJobs) {
    items.set(
      dbJob.id,
      await importDatabase({
        client: input.client,
        userId: input.userId,
        job: dbJob,
        destination,
        importedPages,
        tableDatabases,
      }),
    );
  }
  for (const job of jobs) {
    if (job.parentNotionId && tableDatabases.has(normalizeNotionId(job.parentNotionId))) {
      items.set(job.id, {
        notionPageId: job.id,
        status: 'skip',
        reason: NOTION_TABLE_ROW_SKIP_REASON,
      });
    }
  }

  for (const job of jobs) {
    try {
      job.blocks = await fetchBlocksDeep(input.client, job.id);
    } catch (err) {
      if (job.reuseId && !job.reuseComplete) await abandonPage(job.reuseId, destination.parentId);
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

  // Allocate every local ID before converting any final body. Forward mention
  // rewrites are deterministic, and the enclosing batch lock keeps every
  // selected page exclusively owned until finalization or cleanup.
  for (const job of ordered) {
    const existing = await findImportedPage(input.userId, job.id);
    if (existing?.complete && !input.overwriteExisting) {
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
      continue;
    }
    if (existing?.complete && input.overwriteExisting) {
      job.localPageId = existing.id;
      job.createdPlaceholder = false;
      job.reuseComplete = true;
      importedPages.set(normalizeNotionId(job.id), existing.id);
      continue;
    }

    try {
      const localPageId = existing?.id ?? await nextPageId();
      const parentLocal = await resolveParentLocalId(
        job.parentNotionId,
        importedPages,
        destination.parentId,
        input.userId,
      );
      const wikiProps = extractWikiPageProperties(job.page);
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
        labels: wikiProps.labels,
        author: wikiProps.author,
        verifiedAt: wikiProps.verifiedAt,
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
          if (concurrent.complete && !input.overwriteExisting) {
            items.set(job.id, {
              notionPageId: job.id,
              status: 'already_imported',
              localPageId: concurrent.id,
            });
          } else if (concurrent.complete && input.overwriteExisting) {
            job.createdPlaceholder = false;
            job.reuseComplete = true;
          }
          continue;
        }
      }
      items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
    }
  }

  // Prepare attachments while every page remains observably incomplete. Failed
  // pages leave the mention map before any final body is written.
  for (const job of ordered) {
    if (!job.localPageId || items.has(job.id)) continue;
    const existing = await findImportedPage(input.userId, job.id);
    if (existing?.complete && !job.reuseComplete) {
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
      continue;
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
  }

  // The final body write is the completion boundary and remains inside the
  // batch critical section observed by every completed-page fast path.
  for (const job of ordered) {
    if (!job.prepared || !job.localPageId || items.has(job.id)) continue;
    const existing = await findImportedPage(input.userId, job.id);
    if (existing?.complete && !job.reuseComplete) {
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
      continue;
    }

    try {
      if (!existing || existing.id !== job.localPageId) {
        throw new Error('Notion import placeholder disappeared before finalization');
      }
      const converted = convertNotionBlocks(job.blocks ?? [], {
        localPageId: job.localPageId,
        importedPages,
      });
      const { wikiProps, bodyHtml, bodyText } = wikiConvertedBody(job.page, converted);
      if (job.reuseComplete) {
        const parentLocal = await resolveParentLocalId(
          job.parentNotionId,
          importedPages,
          destination.parentId,
          input.userId,
        );
        await persistStandalonePage({
          id: job.localPageId,
          reuse: true,
          userId: input.userId,
          title: job.title,
          spaceKey: destination.spaceKey,
          parentId: parentLocal,
          visibility: destination.visibility,
          notionPageId: job.id,
          bodyHtml,
          bodyText,
          labels: wikiProps.labels,
          author: wikiProps.author,
          verifiedAt: wikiProps.verifiedAt,
        });
      } else {
        await query(
          'UPDATE pages SET body_html = $2, body_text = $3 WHERE id = $1',
          [job.localPageId, bodyHtml, bodyText],
        );
      }
      // A row page carries its properties as a metadata callout, which is what
      // makes it an article rather than a bare page.
      const rowParent = isRecord(job.page.parent) ? job.page.parent : null;
      const isRow = rowParent?.type === 'database_id' || rowParent?.type === 'data_source_id';
      items.set(job.id, {
        notionPageId: job.id,
        status: 'success',
        localPageId: job.localPageId,
        importedAs: isRow ? 'article' : 'page',
        ...(job.reuseComplete ? { updated: true } : {}),
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
  }

  await rehomeAlreadyImported(alreadyImported, importedPages, input.userId);
  return input.pageIds.map((id) => items.get(id) ?? { notionPageId: id, status: 'fail', reason: 'Unknown item' });
}

interface ImportJob {
  id: string;
  page: Record<string, unknown>;
  title: string;
  parentNotionId: string | null;
  reuseId?: number;
  reuseComplete?: boolean;
  blocks?: NotionBlock[];
  localPageId?: number;
  createdPlaceholder?: boolean;
  prepared?: boolean;
}

interface DatabaseJob {
  id: string;
  database: Record<string, unknown>;
  title: string;
  /** Mode the picker asked for. Absent falls back to the database's own shape. */
  requestedMode?: NotionDatabaseMode;
  reuseId?: number;
  reuseComplete?: boolean;
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



type Classified =
  | { kind: 'page'; page: Record<string, unknown> }
  | { kind: 'database'; database: Record<string, unknown> }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

async function classifySelection(client: NotionClient, id: string): Promise<Classified> {
  try {
    const page = await client.getPage(id);
    // A data source is the 2025 wire split of a database and has no counterpart
    // on the pinned API version, so it stays in Notion.
    if (page.object === 'data_source') {
      return { kind: 'skip', reason: NOTION_UNSUPPORTED_LABEL };
    }
    if (page.object === 'database') {
      return { kind: 'database', database: page };
    }
    return { kind: 'page', page };
  } catch (err) {
    if (isMissing(err)) {
      try {
        return { kind: 'database', database: await client.getDatabase(id) };
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
      // Query the database directly. Filtering a workspace-wide `search` by
      // `parent.database_id` read only the FIRST page of results, so any inline
      // table with rows past that window silently lost them.
      try {
        block.databaseRows = (await client.queryDatabaseAll(block.id)).filter(
          (row) => !isTrashed(row),
        );
      } catch {
        // An inline table nobody shared renders as skipped, not as a failure.
      }
      try {
        const dbDef = await client.getDatabase(block.id);
        if (dbDef && isRecord(dbDef.properties)) {
          block.databaseColumns = Object.keys(dbDef.properties);
        }
      } catch {
        // Columns fall back to the union of row property keys.
      }
    } else if (
      block.has_children === true &&
      typeof block.id === 'string' &&
      !NO_RECURSE_TYPES.has(block.type)
    ) {
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

/**
 * Lead copy for a database's own page. A container page must carry a body:
 * `findImportedPage` reads an empty `body_html` as an unfinished import, so a
 * description-less database would be re-created on every run.
 */
function databaseContainerBody(
  database: Record<string, unknown>,
  title: string,
): { bodyHtml: string; bodyText: string } {
  const description = richTextToPlain(database.description).trim();
  const lead = `Imported from the Notion ${isWikiDatabase(database) ? 'wiki' : 'database'} “${title}”.`;
  const descriptionHtml = description ? `<p>${escapeHtml(description)}</p>` : '';
  return {
    bodyHtml: `${descriptionHtml}<p class="text-muted-foreground italic">${escapeHtml(lead)}</p>`,
    bodyText: description ? `${description}\n\n${lead}` : lead,
  };
}

/**
 * Container page for a database that was never selected itself — it is only the
 * parent of a selected row, and the row needs somewhere to hang.
 */
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
      ...databaseContainerBody(db, title),
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

/**
 * Why a database may not be flattened. `empty` and `row-bodies` are distinct on
 * purpose: only the second one lost a candidate table, so only the second one
 * earns the downgrade explanation on the result row.
 */
type FlattenAttempt =
  | { kind: 'table'; columns: string[]; rows: Array<Record<string, unknown>> }
  | { kind: 'empty' }
  | { kind: 'row-bodies' };

/**
 * Every row of the database, but only when NOT ONE of them carries a page body.
 * An unreadable row counts as carrying one, because an import that cannot prove
 * a row is empty must not drop it.
 */
async function readFlattenableRows(
  client: NotionClient,
  database: Record<string, unknown>,
): Promise<FlattenAttempt> {
  const databaseId = typeof database.id === 'string' ? database.id : '';
  if (!databaseId) return { kind: 'empty' };
  const rows = (await client.queryDatabaseAll(databaseId)).filter((row) => !isTrashed(row));
  // Nothing to tabulate. The container page is the honest result.
  if (rows.length === 0) return { kind: 'empty' };

  const limit = pLimit(NOTION_ROW_CHECK_CONCURRENCY);
  const carriesBody = await Promise.all(
    rows.map((row) =>
      limit(async () => {
        const rowId = typeof row.id === 'string' ? row.id : '';
        if (!rowId) return true;
        try {
          return rowHasBodyContent(await client.getBlockChildren(rowId, { pageSize: 2 }));
        } catch {
          return true;
        }
      }),
    ),
  );
  if (carriesBody.includes(true)) return { kind: 'row-bodies' };

  const props = database.properties;
  return {
    kind: 'table',
    columns: props && typeof props === 'object' ? Object.keys(props) : [],
    rows,
  };
}

/**
 * Places a selected database and reports the shape it took.
 *
 * `table` is re-verified over every row here rather than trusted from the
 * picker, whose recommendation came from a bounded sample. A database that fails
 * that check becomes a container page instead — lossless — and says so on its
 * result row.
 */
async function importDatabase(opts: {
  client: NotionClient;
  userId: string;
  job: DatabaseJob;
  destination: Destination;
  importedPages: Map<string, number>;
  tableDatabases: Set<string>;
}): Promise<NotionImportItem> {
  const { job } = opts;
  const normId = normalizeNotionId(job.id);
  const mode: NotionDatabaseMode =
    job.requestedMode ?? (isWikiDatabase(job.database) ? 'pages' : 'table');
  if (mode === 'skip') {
    return { notionPageId: job.id, status: 'skip', reason: 'Database is excluded from import' };
  }
  const updated = job.reuseComplete ? { updated: true } : {};

  let downgraded = false;
  if (mode === 'table') {
    let attempt: FlattenAttempt;
    try {
      attempt = await readFlattenableRows(opts.client, job.database);
    } catch (err) {
      return { notionPageId: job.id, status: 'fail', reason: failReason(err) };
    }
    if (attempt.kind === 'table') {
      try {
        const pageId = job.reuseId ?? (await nextPageId());
        const lead = databaseContainerBody(job.database, job.title);
        const tableHtml = renderDatabaseTable({ columns: attempt.columns, rows: attempt.rows });
        await persistStandalonePage({
          id: pageId,
          reuse: Boolean(job.reuseId),
          userId: opts.userId,
          title: job.title,
          spaceKey: opts.destination.spaceKey,
          parentId: opts.destination.parentId,
          visibility: opts.destination.visibility,
          notionPageId: job.id,
          bodyHtml: `${tableHtml}${lead.bodyHtml}`,
          bodyText: `${htmlToText(tableHtml)}\n\n${lead.bodyText}`,
          labels: ['notion-import', 'database'],
          author: null,
          verifiedAt: null,
        });
        opts.importedPages.set(normId, pageId);
        opts.tableDatabases.add(normId);
        return {
          notionPageId: job.id,
          status: 'success',
          localPageId: pageId,
          importedAs: 'table',
          ...updated,
        };
      } catch (err) {
        return { notionPageId: job.id, status: 'fail', reason: failReason(err) };
      }
    }
    // Only a row body lost a table that was otherwise on offer. A database with
    // no rows at all lost nothing, so it gets no downgrade explanation.
    downgraded = attempt.kind === 'row-bodies';
  }

  const pageId = await ensureDatabaseContainerPage({
    client: opts.client,
    userId: opts.userId,
    databaseId: job.id,
    destination: opts.destination,
    importedPages: opts.importedPages,
  });
  if (pageId === null) {
    return { notionPageId: job.id, status: 'fail', reason: 'Could not create a page for this database' };
  }
  return {
    notionPageId: job.id,
    status: 'success',
    localPageId: pageId,
    importedAs: 'page',
    ...(downgraded ? { reason: NOTION_TABLE_DOWNGRADE_REASON } : {}),
    ...updated,
  };
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
