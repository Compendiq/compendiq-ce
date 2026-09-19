/**
 * One-shot Notion → standalone page import (#1465 / #1459).
 *
 * Creates `source = 'standalone'` rows under a local destination. A stored
 * `notion_page_id` makes a re-run report `already_imported` instead of
 * duplicating. There is no `pages.source = 'notion'` and no live sync.
 *
 * Pages and databases share one parent-first plan. Actual embedded child pages
 * and databases expand their owned descendants; ordinary links do not.
 *
 * Property-only databases fold into a host table without row articles, after
 * every row is verified empty. Without a host they own a table article.
 * Wikis and databases with their own body retain a container article; other
 * embedded article databases place row articles directly below the host.
 * Existing bodies stay intact unless overwrite is requested. Every discovered
 * outcome is returned for audit, cache invalidation and failure reporting.
 */
import { createHash } from 'node:crypto';
import {
  NOTION_BOARD_REASON,
  NOTION_UNSUPPORTED_LABEL,
  type NotionDatabaseMode,
  type NotionImportItem,
} from '@compendiq/contracts';
import pLimit from 'p-limit';
import type { PoolClient, QueryResultRow } from 'pg';
import { query } from '../../../core/db/postgres.js';
import { htmlToText } from '../../../core/services/content-converter.js';
import {
  LocalAttachmentError,
  putLocalAttachments,
  type LocalAttachmentWrite,
} from '../../../core/services/local-attachment-service.js';
import {
  advancePageWriteIntent,
  completePageWriteIntent,
  reservePageWriteIntent,
  registerPageWriteIntentReconciler,
  runPageWriteIntentEffect,
  type PageWriteIntent,
  type PageRevision,
  type PageWriteRecoveryIntent,
} from '../../../core/services/page-write-admission.js';
import {
  cleanupStandalonePageAttachmentDirs,
  deletedStandaloneNamespacesAbsent,
} from '../../../core/services/standalone-attachment-cleanup.js';
import { logger } from '../../../core/utils/logger.js';
import { withNotionImportLocks } from './notion-import-lock.js';
import { NotionClient, NotionError, isNotionObjectMissing } from './notion-client.js';
import {
  NOTION_CHILDREN_MACRO_HTML,
  convertNotionBlocks,
  escapeHtml,
  extractPropertyText,
  formatWikiMetadataCallout,
  renderDatabaseTable,
  type NotionBlock,
} from './notion-block-converter.js';
import {
  NOTION_ROW_PROBE_BLOCKS,
  extractParentRelationId,
  isBoardLayout,
  isWikiDatabase,
  rowHasBodyContent,
} from './notion-tree.js';

const NO_RECURSE_TYPES = new Set(['child_page', 'child_database']);
/** Row-body checks run concurrently against Notion's per-integration rate limit. */
const NOTION_ROW_CHECK_CONCURRENCY = 5;
/**
 * Ceiling on how many pages one request may pull in beyond its own selection.
 * Discovery follows every owned `child_page` / `child_database` transitively, so
 * one root can reach a whole workspace — minutes of paced Notion traffic inside
 * a single HTTP request that holds the import locks. Past the ceiling a
 * discovered page is reported as a skip naming its remedy rather than imported
 * silently or dropped: the run is idempotent, so selecting that branch directly
 * finishes it. An explicitly selected id is never refused.
 */
export const NOTION_DISCOVERY_LIMIT = 2000;
export const NOTION_DISCOVERY_LIMIT_REASON =
  'Import limit reached — select this branch directly to import it' as const;

let discoveryLimit: number = NOTION_DISCOVERY_LIMIT;

/** Test-only. Production always uses {@link NOTION_DISCOVERY_LIMIT}. */
export function setNotionDiscoveryLimitForTests(limit: number | null): void {
  discoveryLimit = limit ?? NOTION_DISCOVERY_LIMIT;
}

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
  // Descendants are discovered from page bodies after the request is locked.
  // A per-owner lock also protects overlapping imports whose selected IDs differ.
  return withNotionImportLocks(
    [...input.pageIds, `notion-import-owner:${input.userId}`],
    async () => runLockedNotionImport(input),
  );
}

async function runLockedNotionImport(input: RunNotionImportInput): Promise<NotionImportItem[]> {
  const destination = await resolveDestination(input);
  const items = new Map<string, NotionImportItem>();
  const jobs: ImportJob[] = [];
  const alreadyImported: AlreadyImported[] = [];
  const queued = new Map<string, string>();
  const explicitlySelected = new Set(input.pageIds.map(normalizeNotionId));
  const expandedDatabases = new Set<string>();
  const modes = new Map(Object.entries(input.databaseModes ?? {}).map(([id, mode]) => [normalizeNotionId(id), mode]));
  const importedPages = new Map<string, number>();
  const databaseHosts = new Map<string, string>();
  const childHosts = new Map<string, string>();
  const tableDatabases = new Set<string>();
  const boardByKey = new Map<string, Record<string, unknown>>();

  async function ensureBoardContainer(database: Record<string, unknown>): Promise<string | null> {
    const hostId = boardHostId(database);
    if (!hostId) return null;
    const hostKey = normalizeNotionId(hostId);
    if (jobs.some((job) => normalizeNotionId(job.id) === hostKey)) return hostId;
    const imported = importedPages.get(hostKey);
    if (typeof imported === 'number') return hostId;
    const existingHost = await findImportedPage(input.userId, hostId);
    if (existingHost?.complete) {
      importedPages.set(hostKey, existingHost.id);
      return hostId;
    }

    const boardTitle = extractTitle(database);
    let hostPage: Record<string, unknown> = database;
    let title = boardTitle;
    let parentNotionId = parentPageIdOf(database);
    if (hostKey !== normalizeNotionId(typeof database.id === 'string' ? database.id : '')) {
      const page = await getPageQuietly(input.client, hostId);
      if (page) {
        hostPage = page;
        title = extractTitle(page);
        parentNotionId = parentPageIdOf(page);
      } else {
        hostPage = {
          object: 'page',
          id: hostId,
          parent: isRecord(database.parent) ? database.parent : { type: 'workspace', workspace: true },
        };
      }
    }

    items.delete(queued.get(hostKey) ?? hostId);
    if (!queued.has(hostKey)) queued.set(hostKey, hostId);
    const existing = existingHost ?? await findImportedPage(input.userId, hostId);
    jobs.push({
      id: hostId,
      page: hostPage,
      title,
      parentNotionId,
      reuseId: existing?.id,
      reuseComplete: existing?.complete === true,
      expectedRevisions: existing?.revisions,
      boardContainer: true,
      boardTitle,
      blocks: [],
    });
    if (existing?.complete && !input.overwriteExisting) {
      importedPages.set(hostKey, existing.id);
      items.set(hostId, { notionPageId: hostId, status: 'already_imported', localPageId: existing.id });
      alreadyImported.push({
        notionPageId: hostId,
        localPageId: existing.id,
        parentNotionId,
        page: hostPage,
        expectedRevisions: existing.revisions,
      });
    }
    return hostId;
  }

  async function enqueue(id: string, page?: Record<string, unknown>): Promise<void> {
    const key = normalizeNotionId(id);
    if (queued.has(key)) return;
    queued.set(key, id);
    if (id.startsWith('linked:') || modes.get(key) === 'skip') {
      items.set(id, {
        notionPageId: id,
        status: 'skip',
        reason: id.startsWith('linked:') ? NOTION_UNSUPPORTED_LABEL : 'Database is excluded from import',
      });
      return;
    }
    if (!explicitlySelected.has(key) && queued.size > discoveryLimit) {
      items.set(id, { notionPageId: id, status: 'skip', reason: NOTION_DISCOVERY_LIMIT_REASON });
      return;
    }
    // Observe a pre-existing target before any remote classification work. Its
    // exact revision pair is the import's fence; a later SELECT must never
    // adopt an intervening local edit as permission to delete or overwrite.
    const initiallyExisting = await findImportedPage(input.userId, id);
    let classified: Classified = page
      ? page.object === 'database' ? { kind: 'database', database: page } : { kind: 'page', page }
      : await classifySelection(input.client, id);
    if (classified.kind === 'database' && await isBoardDatabase(input.client, classified.database)) {
      classified = { kind: 'board', database: classified.database };
    }
    if (classified.kind === 'board') {
      boardByKey.set(key, classified.database);
      items.set(id, { notionPageId: id, status: 'skip', reason: NOTION_BOARD_REASON });
      return;
    }
    if (classified.kind === 'fail' || classified.kind === 'skip') {
      if (initiallyExisting?.complete && !input.overwriteExisting) {
        importedPages.set(key, initiallyExisting.id);
        items.set(id, { notionPageId: id, status: 'already_imported', localPageId: initiallyExisting.id });
        return;
      }
      if (initiallyExisting && !initiallyExisting.complete) {
        await abandonPage({
          pageId: initiallyExisting.id,
          notionPageId: id,
          destinationParentId: destination.parentId,
          userId: input.userId,
          expectedRevisions: initiallyExisting.revisions,
        });
      }
      items.set(id, { notionPageId: id, status: classified.kind, reason: classified.reason });
      return;
    }
    const object = classified.kind === 'database' ? classified.database : classified.page;
    const parentNotionId = parentPageIdOf(object);
    const parent = isRecord(object.parent) ? object.parent : null;
    const databaseParent = parent?.type === 'database_id' ? parent.database_id : parent?.data_source_id;
    if (typeof databaseParent === 'string' && modes.get(normalizeNotionId(databaseParent)) === 'skip') {
      items.set(id, { notionPageId: id, status: 'skip', reason: 'Parent database is excluded from import' });
      return;
    }
    // A row absent before classification may legitimately have appeared since;
    // observe it once. A row already observed above always keeps that original
    // pair through the remaining read-only Notion walk.
    const existing = initiallyExisting ?? await findImportedPage(input.userId, id);
    const job: ImportJob = {
      id, page: object, title: extractTitle(object), parentNotionId,
      reuseId: existing?.id, reuseComplete: existing?.complete === true,
      expectedRevisions: existing?.revisions,
      ...(classified.kind === 'database' ? { database: classified.database } : {}),
    };
    jobs.push(job);
    if (existing?.complete && !input.overwriteExisting) {
      importedPages.set(key, existing.id);
      items.set(id, { notionPageId: id, status: 'already_imported', localPageId: existing.id });
      alreadyImported.push({
        notionPageId: id,
        localPageId: existing.id,
        parentNotionId,
        page: object,
        expectedRevisions: existing.revisions,
      });
    }
    // A later request batch may contain only a row of an inline table. Recover
    // its database and an already imported host before deciding to make an
    // article, rather than bypassing the table decision made in the first batch.
    if (typeof databaseParent === 'string') {
      const parentKey = normalizeNotionId(databaseParent);
      if (!queued.has(parentKey) && !boardByKey.has(parentKey)) {
        const database = await classifySelection(input.client, databaseParent);
        if (database.kind === 'board') {
          boardByKey.set(parentKey, database.database);
          queued.set(parentKey, databaseParent);
          items.set(databaseParent, { notionPageId: databaseParent, status: 'skip', reason: NOTION_BOARD_REASON });
        } else if (database.kind === 'database') {
          if (await isBoardDatabase(input.client, database.database)) {
            boardByKey.set(parentKey, database.database);
            queued.set(parentKey, databaseParent);
            items.set(databaseParent, { notionPageId: databaseParent, status: 'skip', reason: NOTION_BOARD_REASON });
          } else {
            await enqueue(databaseParent, database.database);
          }
        }
      }
      const board = boardByKey.get(parentKey);
      if (board) {
        const hostId = await ensureBoardContainer(board);
        if (hostId) job.parentNotionId = hostId;
      }
    }
    if (job.database && parent?.type === 'page_id' && typeof parent.page_id === 'string' &&
        !queued.has(normalizeNotionId(parent.page_id))) {
      const host = await findImportedPage(input.userId, parent.page_id);
      if (host?.complete) await enqueue(parent.page_id);
    }
  }

  for (const id of input.pageIds) await enqueue(id);

  // Read each owned body once. Only actual child_page blocks expand page
  // selection; mentions and linked-page references never establish ownership.
  async function discover(blocks: NotionBlock[], hostId: string): Promise<void> {
    for (const block of blocks) {
      if (block.type === 'child_page' && typeof block.id === 'string') {
        childHosts.set(normalizeNotionId(block.id), hostId);
        await enqueue(block.id);
      } else if (block.type === 'child_database' && typeof block.id === 'string') {
        databaseHosts.set(normalizeNotionId(block.id), hostId);
        await enqueue(block.id);
        const database = jobs.find((job) => normalizeNotionId(job.id) === normalizeNotionId(block.id!));
        if (database?.database) await planDatabase(database);
      }
      if (block.children) await discover(block.children, hostId);
    }
  }

  /**
   * `pages` is the one shape the picker promises that discovery cannot infer: an
   * explicit `pages` request keeps the database's own article with its rows
   * beneath it, even when the database sits inside an imported host. Folding a
   * hosted database into its host is the DEFAULT, never an override of a stated
   * choice — `requestDatabaseModes` sends a mode for every selected database, so
   * treating `hosted` as `table` made the picker's control decorative on every
   * nested database.
   */
  const keepsOwnArticle = (key: string): boolean => modes.get(key) === 'pages';

  async function planDatabase(job: ImportJob): Promise<void> {
    if (!job.database || job.boardContainer) return;
    if (isBoardLayout(job.database) || boardByKey.has(normalizeNotionId(job.id))) return;
    const key = normalizeNotionId(job.id);
    const hosted = databaseHosts.has(key);
    const mode = modes.get(key) ?? (explicitlySelected.has(key) ? 'table' : 'pages');
    const wiki = isWikiDatabase(job.database);
    if (!wiki && !job.flatten && (mode === 'table' || (hosted && !keepsOwnArticle(key)))) {
      job.flatten = await readFlattenableRows(input.client, job.database);
      if (job.flatten.kind === 'table') tableDatabases.add(key);
    }
    if (!expandedDatabases.has(key) && job.flatten?.kind !== 'table' &&
        (hosted || (mode === 'table' && job.flatten?.kind === 'row-bodies'))) {
      expandedDatabases.add(key);
      // The flatten attempt already paged every row. Querying the same database
      // a second time buys nothing but another round of paced requests.
      const rows = job.flatten?.kind === 'row-bodies'
        ? job.flatten.rows
        : (await input.client.queryDatabaseAll(job.id)).filter((row) => !isTrashed(row));
      for (const row of rows) {
        if (typeof row.id === 'string') await enqueue(row.id, row);
      }
    }
  }

  // Fetch one wave of already-queued jobs in parallel (the client still paces
  // starts at 3 req/s). Discover/plan stay sequential because they append jobs.
  const walkLimit = pLimit(NOTION_ROW_CHECK_CONCURRENCY);
  let cursor = 0;
  while (cursor < jobs.length) {
    const waveEnd = jobs.length;
    const wave = jobs.slice(cursor, waveEnd);
    const fetchErrors = await Promise.all(wave.map((job) => walkLimit(async (): Promise<unknown> => {
      try {
        if (job.boardContainer) {
          job.blocks = [];
          return null;
        }
        try {
          job.blocks = await fetchBlocksDeep(input.client, job.id);
        } catch (err) {
          // Ordinary databases have no block body, but wiki databases can have a
          // real home page. Attempt that body before falling back to metadata.
          if (!job.database || !isNotionObjectMissing(err)) throw err;
          job.blocks = [];
        }
        return null;
      } catch (err) {
        return err;
      }
    })));
    for (let i = 0; i < wave.length; i++) {
      const job = wave[i]!;
      try {
        const fetchErr = fetchErrors[i];
        if (fetchErr) throw fetchErr;
        await discover(job.blocks ?? [], job.id);
        await planDatabase(job);
      } catch (err) {
        if (job.reuseId && !job.reuseComplete && job.expectedRevisions) {
          try {
            await abandonPage({
              pageId: job.reuseId,
              notionPageId: job.id,
              destinationParentId: destination.parentId,
              userId: input.userId,
              expectedRevisions: job.expectedRevisions,
            });
          } catch (cleanupError) {
            logger.warn(
              { err: cleanupError, pageId: job.reuseId },
              'notion-import: could not safely remove an incomplete placeholder',
            );
          }
        }
        if (!job.reuseComplete || input.overwriteExisting) {
          items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
        }
      }
    }
    cursor = waveEnd;
  }

  // A database may have been visited before its host. Resolve shape and host
  // evidence only after discovery, never while persisting an earlier node.
  for (const job of jobs) {
    const key = normalizeNotionId(job.id);
    const host = databaseHosts.get(key);
    if (job.database && host && !isWikiDatabase(job.database)) {
      if (!job.flatten && items.get(job.id)?.status !== 'fail') {
        try {
          await planDatabase(job);
        } catch (err) {
          items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
        }
      }
      // A database with its own body is an article, not an empty intermediary,
      // and so is one the request explicitly asked to import as pages.
      if (!job.blocks?.length && !keepsOwnArticle(key)) job.foldedInto = host;
    }
    job.parentNotionId = childHosts.get(key) ?? host ?? job.parentNotionId;
  }

  const byKey = new Map(jobs.map((job) => [normalizeNotionId(job.id), job]));
  for (const job of jobs) {
    const parent = isRecord(job.page.parent) ? job.page.parent : null;
    const databaseId = parent?.type === 'database_id' ? parent.database_id : parent?.data_source_id;
    if (typeof databaseId === 'string' && tableDatabases.has(normalizeNotionId(databaseId)) &&
        !childHosts.has(normalizeNotionId(job.id))) {
      items.set(job.id, { notionPageId: job.id, status: 'skip', reason: NOTION_TABLE_ROW_SKIP_REASON });
      importedPages.delete(normalizeNotionId(job.id));
    }
    if (job.parentNotionId) {
      const parentJob = byKey.get(normalizeNotionId(job.parentNotionId));
      if (parentJob?.foldedInto) job.parentNotionId = parentJob.foldedInto;
    }
  }
  for (const row of alreadyImported) {
    const job = byKey.get(normalizeNotionId(row.notionPageId));
    if (job) row.parentNotionId = job.parentNotionId;
  }

  /**
   * The rows of one database, read off each row's own Notion parent. A folded
   * row's `parentNotionId` has already been rehomed onto the HOST, which cannot
   * tell these rows from a sibling database's rows under the same host.
   */
  function databaseRowIds(databaseId: string): string[] {
    const key = normalizeNotionId(databaseId);
    return jobs
      .filter((row) => {
        const parent = isRecord(row.page.parent) ? row.page.parent : null;
        const owner = parent?.type === 'database_id' ? parent.database_id : parent?.data_source_id;
        return typeof owner === 'string' && normalizeNotionId(owner) === key;
      })
      .map((row) => row.id);
  }

  function annotateDatabases(blocks: NotionBlock[]): void {
    for (const block of blocks) {
      if (block.type === 'child_database' && typeof block.id === 'string') {
        const db = byKey.get(normalizeNotionId(block.id));
        if (db && items.get(db.id)?.status !== 'fail') {
          if (db.flatten?.kind === 'table' && db.foldedInto) {
            block.databaseRows = db.flatten.rows;
            block.databaseColumns = db.flatten.columns;
          } else {
            block.databasePageIds = db.foldedInto ? databaseRowIds(db.id) : [db.id];
          }
        }
      }
      if (block.children) annotateDatabases(block.children);
    }
  }
  for (const job of jobs) annotateDatabases(job.blocks ?? []);

  const selectedKeys = new Set(jobs.map((job) => normalizeNotionId(job.id)));
  await resolveRemainingBlockParents(input.client, jobs, alreadyImported, selectedKeys);
  const toPersist = jobs.filter((job) => !items.has(job.id) && !job.foldedInto);
  const ordered = topoBySelectedParent(toPersist, new Set(toPersist.map((job) => normalizeNotionId(job.id))));

  function directChildIds(job: ImportJob): Set<string> {
    return new Set(jobs.filter((child) =>
      !child.foldedInto && child.parentNotionId &&
      normalizeNotionId(child.parentNotionId) === normalizeNotionId(job.id) &&
      ['success', 'already_imported'].includes(items.get(child.id)?.status ?? ''),
    ).map((child) => normalizeNotionId(child.id)));
  }

  // Allocate every local ID before converting any final body. Forward mention
  // rewrites are deterministic, and the enclosing batch lock keeps every
  // selected page exclusively owned until finalization or cleanup.
  for (const job of ordered) {
    const existing = job.reuseId === undefined
      ? null
      : {
          id: job.reuseId,
          complete: job.reuseComplete === true,
          revisions: job.expectedRevisions!,
        };
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
        expectedRevisions: existing.revisions,
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
      if (!existing) {
        const wikiProps = extractWikiPageProperties(job.page);
        const revision = await persistStandalonePage({
          id: localPageId,
          reuse: false,
          userId: input.userId,
          title: job.title,
          spaceKey: destination.spaceKey,
          parentId: parentLocal,
          visibility: destination.visibility,
          notionPageId: job.id,
          bodyHtml: '',
          bodyText: '',
          labels: job.database ? ['notion-import', 'database'] : wikiProps.labels,
          author: wikiProps.author,
          verifiedAt: wikiProps.verifiedAt,
        });
        job.expectedRevisions = { [localPageId]: revision };
      }
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
          } else {
            job.createdPlaceholder = false;
            job.reuseComplete = concurrent.complete;
            job.expectedRevisions = concurrent.revisions;
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
    if (!job.expectedRevisions) {
      items.set(job.id, {
        notionPageId: job.id,
        status: 'fail',
        reason: 'Notion import lost its original page revision fence',
      });
      continue;
    }
    const converted = convertNotionBlocks(job.blocks ?? [], {
      localPageId: job.localPageId,
      importedPages,
    });
    let files: LocalAttachmentWrite[];
    try {
      files = await downloadAttachments(input.client, job.localPageId, converted.attachments);
    } catch (err) {
      if (job.createdPlaceholder) {
        await abandonPage({
          pageId: job.localPageId,
          notionPageId: job.id,
          destinationParentId: destination.parentId,
          userId: input.userId,
          expectedRevisions: job.expectedRevisions,
        }).catch(() => undefined);
      }
      importedPages.delete(normalizeNotionId(job.id));
      items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
      continue;
    }
    try {
      if (files.length > 0) {
        const stored = await putLocalAttachments({
          pageId: job.localPageId,
          attachments: files,
          userId: input.userId,
          expectedRevisions: job.expectedRevisions,
        });
        job.expectedRevisions = stored.revisions;
      }
      job.prepared = true;
    } catch (err) {
      if (err instanceof LocalAttachmentError && err.code === 'STORAGE_UNWRITABLE') {
        // This verdict is emitted only by the read-only, pre-admission check.
        // Preserve the existing text-import fallback without settling or
        // bypassing a child whose filesystem effects may already have begun.
        const reason = failReason(err);
        job.attachmentWarning = files.length === 1
          ? `Could not save attachment ${files[0]!.filename}: ${reason}`
          : `Could not save ${files.length} attachments (${files[0]!.filename}: ${reason})`;
        job.prepared = true;
        continue;
      }
      // Once the attachment child has reserved its exact plan, its reconciler
      // owns every stage/final crash state. Do not bypass that unresolved
      // intent with placeholder deletion or filesystem rollback.
      importedPages.delete(normalizeNotionId(job.id));
      items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
    }
  }

  // The final body write is the completion boundary and remains inside the
  // batch critical section observed by every completed-page fast path.
  for (const job of [...ordered].reverse()) {
    if (!job.prepared || !job.localPageId || items.has(job.id)) continue;
    let finalIntent: PageWriteIntent | undefined;
    try {
      const childPageIds = directChildIds(job);
      const converted = convertNotionBlocks(job.blocks ?? [], {
        localPageId: job.localPageId,
        importedPages,
        childPageIds,
      });
      const wikiProps = extractWikiPageProperties(job.page);
      let { bodyHtml, bodyText } = job.database ? converted : wikiConvertedBody(job.page, converted);
      if (job.boardContainer) {
        const boardName = job.boardTitle || job.title;
        const lead = `Imported from the Notion board “${boardName}”.`;
        bodyHtml = `<p class="text-muted-foreground italic">${escapeHtml(lead)}</p>`;
        bodyText = lead;
      } else if (job.database) {
        const lead = databaseContainerBody(job.database, job.title);
        const tableHtml = job.flatten?.kind === 'table'
          ? renderDatabaseTable({ columns: job.flatten.columns, rows: job.flatten.rows })
          : '';
        bodyHtml = `${bodyHtml}${tableHtml}${lead.bodyHtml}`;
        bodyText = `${bodyText}\n\n${htmlToText(tableHtml)}\n\n${lead.bodyText}`.trim();
      }
      if (childPageIds.size > 0 && !converted.childrenMacroRendered) {
        bodyHtml += NOTION_CHILDREN_MACRO_HTML;
      }
      if (!job.expectedRevisions) {
        throw new Error('Notion import lost its original page revision fence');
      }
      const reusesExistingPage = job.createdPlaceholder === false;
      const parentLocal = reusesExistingPage
        ? await resolveParentLocalId(
            job.parentNotionId,
            importedPages,
            destination.parentId,
            input.userId,
          )
        : null;
      finalIntent = await reservePageWriteIntent({
        pageIds: [job.localPageId],
        kind: job.reuseComplete ? 'import.notion.overwrite' : 'import.notion.publish',
        actorId: input.userId,
        expectedRevisions: job.expectedRevisions,
        effect: notionBodyEffect({
          pageId: job.localPageId,
          notionPageId: job.id,
          bodyHtml,
          bodyText,
          ...(reusesExistingPage ? { title: job.title, parentId: parentLocal } : {}),
        }),
      });
      await completePageWriteIntent(finalIntent, async (client) => {
        await assertNotionTargetAuthority(client, {
          pageId: job.localPageId!,
          userId: input.userId,
          notionPageId: job.id,
          expectedState: job.reuseComplete ? 'complete' : 'incomplete',
        });
        if (reusesExistingPage) {
          await persistStandalonePage({
            id: job.localPageId!,
            reuse: true,
            userId: input.userId,
            title: job.title,
            spaceKey: destination.spaceKey,
            parentId: parentLocal,
            visibility: destination.visibility,
            notionPageId: job.id,
            bodyHtml,
            bodyText,
            labels: job.database ? ['notion-import', 'database'] : wikiProps.labels,
            author: wikiProps.author,
            verifiedAt: wikiProps.verifiedAt,
          }, client);
        } else {
          await client.query(
            `UPDATE pages
                SET body_html = $2, body_text = $3,
                    content_revision = content_revision + 1
              WHERE id = $1`,
            [job.localPageId, bodyHtml, bodyText],
          );
        }
      });
      // A row page carries its properties as a metadata callout, which is what
      // makes it an article rather than a bare page.
      const rowParent = isRecord(job.page.parent) ? job.page.parent : null;
      const isRow = rowParent?.type === 'database_id' || rowParent?.type === 'data_source_id';
      const reasons = [
        job.flatten?.kind === 'row-bodies' &&
        (modes.get(normalizeNotionId(job.id)) ?? 'table') === 'table'
          ? NOTION_TABLE_DOWNGRADE_REASON
          : undefined,
        job.attachmentWarning,
      ].filter((value): value is string => value !== undefined);
      items.set(job.id, {
        notionPageId: job.id,
        status: 'success',
        localPageId: job.localPageId,
        importedAs: job.flatten?.kind === 'table' ? 'table' : isRow ? 'article' : 'page',
        ...(reasons.length === 0 ? {} : { reason: reasons.join('; ') }),
        ...(job.reuseComplete ? { updated: true } : {}),
      });
    } catch (err) {
      if (job.createdPlaceholder && !finalIntent && job.expectedRevisions) {
        await abandonPage({
          pageId: job.localPageId!,
          notionPageId: job.id,
          destinationParentId: destination.parentId,
          userId: input.userId,
          expectedRevisions: job.expectedRevisions,
        }).catch(() => undefined);
      }
      importedPages.delete(normalizeNotionId(job.id));
      items.set(job.id, { notionPageId: job.id, status: 'fail', reason: failReason(err) });
    }
  }

  await rehomeAlreadyImported(
    alreadyImported.filter((row) => items.get(row.notionPageId)?.status === 'already_imported' &&
      !byKey.get(normalizeNotionId(row.notionPageId))?.foldedInto),
    importedPages,
    input.userId,
    items,
  );
  for (const job of jobs) {
    if (!job.foldedInto || items.get(job.id)?.status === 'fail') continue;
    const hostId = queued.get(normalizeNotionId(job.foldedInto));
    const host = hostId ? items.get(hostId) : undefined;
    items.set(job.id, host?.localPageId && (host.status === 'success' || host.status === 'already_imported')
      ? {
          notionPageId: job.id, status: 'skip', localPageId: host.localPageId,
          reason: job.flatten?.kind === 'table' ? NOTION_TABLE_ROW_SKIP_REASON : 'Included in the parent article',
        }
      : { notionPageId: job.id, status: 'fail', reason: 'Parent article could not be imported' });
  }
  // Results drive cache invalidation, auditing and the import report. Include
  // discovered descendants, especially failures behind a successful root.
  const resultIds = new Map<string, string>();
  for (const id of input.pageIds) {
    const key = normalizeNotionId(id);
    if (!resultIds.has(key)) resultIds.set(key, id);
  }
  for (const [key, id] of queued) {
    if (!resultIds.has(key)) resultIds.set(key, id);
  }
  return [...resultIds].map(([key, id]) => ({
    ...(items.get(queued.get(key) ?? id) ?? { status: 'fail' as const, reason: 'Unknown item' }),
    notionPageId: id,
  }));
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
  attachmentWarning?: string;
  expectedRevisions?: Readonly<Record<number, PageRevision>>;
  database?: Record<string, unknown>;
  flatten?: FlattenAttempt;
  foldedInto?: string;
  boardContainer?: boolean;
  boardTitle?: string;
}


interface AlreadyImported {
  notionPageId: string;
  localPageId: number;
  parentNotionId: string | null;
  page: Record<string, unknown> | null;
  expectedRevisions: Readonly<Record<number, PageRevision>>;
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
interface RevisionRow {
  content_revision: string;
  lifecycle_revision: string;
}

interface ImportedPage {
  id: number;
  complete: boolean;
  revisions: Readonly<Record<number, PageRevision>>;
}

function pageRevisionFromRow(row: RevisionRow | undefined): PageRevision {
  if (!row) throw new Error('Notion import target disappeared during persistence');
  return {
    contentRevision: row.content_revision,
    lifecycleRevision: row.lifecycle_revision,
  };
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
}, client?: PoolClient): Promise<PageRevision> {
  const runQuery = <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => client ? client.query<T>(text, values) : query<T>(text, values);
  let parentPath: string | null = null;
  if (opts.parentId) {
    const parentResult = await runQuery<{ path: string | null }>(
      'SELECT path FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [opts.parentId],
    );
    parentPath = parentResult.rows[0]?.path ?? `/${opts.parentId}`;
  }
  const newPath = parentPath ? `${parentPath}/${opts.id}` : `/${opts.id}`;
  const depth = newPath.split('/').filter(Boolean).length - 1;

  if (opts.reuse) {
    await rehomePage(opts.id, opts.parentId, client);
    const updated = await runQuery<RevisionRow>(
      `UPDATE pages
          SET title = $2, body_html = $3, body_text = $4, space_key = $5, parent_id = $6,
              visibility = $7, path = $8, depth = $9, labels = $10,
              author = COALESCE($11, author),
              verified_at = COALESCE($12, verified_at),
              embedding_dirty = TRUE, image_analysis_dirty = TRUE,
              content_revision = content_revision + 1
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING content_revision::text, lifecycle_revision::text`,
      [
        opts.id, opts.title, opts.bodyHtml, opts.bodyText, opts.spaceKey,
        opts.parentId, opts.visibility, newPath, depth,
        opts.labels ?? [], opts.author ?? null, opts.verifiedAt ?? null,
      ],
    );
    return pageRevisionFromRow(updated.rows[0]);
  }

  const inserted = await runQuery<RevisionRow>(
    `INSERT INTO pages
       (id, title, body_html, body_text, body_storage, source, created_by_user_id,
        visibility, version, space_key, confluence_id, parent_id,
        page_type, embedding_dirty, image_analysis_dirty, embedding_status,
        last_synced, labels, author, verified_at, notion_page_id, path, depth)
     VALUES ($1, $2, $3, $4, NULL, 'standalone', $5, $6, 1, $7, NULL, $8,
             'page', TRUE, TRUE, 'not_embedded',
             NOW(), $9, $10, $11, $12, $13, $14)
     RETURNING content_revision::text, lifecycle_revision::text`,
    [
      opts.id, opts.title, opts.bodyHtml, opts.bodyText, opts.userId,
      opts.visibility, opts.spaceKey, opts.parentId,
      opts.labels ?? [], opts.author ?? null, opts.verifiedAt ?? null,
      opts.notionPageId, newPath, depth,
    ],
  );
  return pageRevisionFromRow(inserted.rows[0]);
}

async function findImportedPage(
  userId: string,
  notionPageId: string,
): Promise<ImportedPage | null> {
  const result = await query<{
    id: number;
    body_html: string | null;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT p.id, p.body_html,
            p.content_revision::text, p.lifecycle_revision::text
       FROM pages p
       JOIN users u ON u.id = $1
      WHERE p.created_by_user_id = $1
        AND p.source = 'standalone'
        AND p.deleted_at IS NULL
        AND p.notion_page_id IS NOT NULL
        AND lower(replace(p.notion_page_id, '-', '')) = $2
      LIMIT 1`,
    [userId, normalizeNotionId(notionPageId)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    complete: Boolean(row.body_html && row.body_html.trim().length > 0),
    revisions: {
      [row.id]: pageRevisionFromRow(row),
    },
  };
}
type NotionTargetState = 'complete' | 'incomplete';

async function assertNotionTargetAuthority(
  client: PoolClient,
  input: {
    pageId: number;
    userId: string;
    notionPageId: string;
    expectedState: NotionTargetState;
  },
): Promise<void> {
  const result = await client.query<{ body_html: string | null }>(
    `SELECT p.body_html
       FROM pages p
       JOIN users u ON u.id = $2
      WHERE p.id = $1
        AND p.created_by_user_id = $2
        AND p.source = 'standalone'
        AND p.deleted_at IS NULL
        AND p.notion_page_id IS NOT NULL
        AND lower(replace(p.notion_page_id, '-', '')) = $3
      FOR UPDATE OF p, u`,
    [input.pageId, input.userId, normalizeNotionId(input.notionPageId)],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Notion import target authority changed before mutation');
  }
  const complete = Boolean(row.body_html && row.body_html.trim().length > 0);
  if ((input.expectedState === 'complete') !== complete) {
    throw new Error(
      input.expectedState === 'complete'
        ? 'Notion overwrite target is no longer complete'
        : 'Notion import target is no longer an incomplete placeholder',
    );
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function notionBodyEffect(input: {
  pageId: number;
  notionPageId: string;
  bodyHtml: string;
  bodyText: string;
  title?: string;
  parentId?: string | null;
}): Record<string, unknown> {
  return {
    effectClass: 'local',
    operation: 'write-notion-body',
    pageId: input.pageId,
    notionPageId: normalizeNotionId(input.notionPageId),
    bodyHtmlSha256: sha256(input.bodyHtml),
    bodyTextSha256: sha256(input.bodyText),
    bodyHtmlBytes: Buffer.byteLength(input.bodyHtml),
    bodyTextBytes: Buffer.byteLength(input.bodyText),
    ...(input.title === undefined ? {} : { titleSha256: sha256(input.title) }),
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
  };
}

function recoveryPageId(intent: PageWriteRecoveryIntent): number {
  const pageId = intent.effect.pageId;
  if (
    typeof pageId !== 'number' ||
    !Number.isSafeInteger(pageId) ||
    pageId <= 0 ||
    intent.pageIds.length !== 1 ||
    intent.pageIds[0] !== pageId
  ) {
    throw new Error('Notion recovery descriptor has an invalid page id');
  }
  return pageId;
}

function revisionMatches(
  row: { content_revision: string; lifecycle_revision: string },
  revision: PageRevision | undefined,
): boolean {
  return revision !== undefined &&
    row.content_revision === revision.contentRevision &&
    row.lifecycle_revision === revision.lifecycleRevision;
}

async function reconcileNotionBodyWrite(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
) {
  const pageId = recoveryPageId(intent);
  const effect = intent.effect;
  const bodyHtmlSha256 = effect.bodyHtmlSha256;
  const bodyTextSha256 = effect.bodyTextSha256;
  const titleSha256 = effect.titleSha256;
  const parentId = effect.parentId;
  const bodyHtmlBytes = effect.bodyHtmlBytes;
  const bodyTextBytes = effect.bodyTextBytes;
  const digestPattern = /^[0-9a-f]{64}$/;
  if (
    effect.operation !== 'write-notion-body' ||
    typeof bodyHtmlSha256 !== 'string' ||
    !digestPattern.test(bodyHtmlSha256) ||
    typeof bodyTextSha256 !== 'string' ||
    !digestPattern.test(bodyTextSha256) ||
    (titleSha256 !== undefined &&
      (typeof titleSha256 !== 'string' || !digestPattern.test(titleSha256))) ||
    (parentId !== undefined && parentId !== null && typeof parentId !== 'string') ||
    typeof bodyHtmlBytes !== 'number' ||
    !Number.isSafeInteger(bodyHtmlBytes) ||
    bodyHtmlBytes < 0 ||
    typeof bodyTextBytes !== 'number' ||
    !Number.isSafeInteger(bodyTextBytes) ||
    bodyTextBytes < 0
  ) {
    throw new Error('Notion body recovery descriptor is invalid');
  }
  const result = await client.query<{
    title: string;
    body_html: string | null;
    body_text: string | null;
    parent_id: string | null;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT title, body_html, body_text, parent_id,
            content_revision::text, lifecycle_revision::text
       FROM pages WHERE id = $1`,
    [pageId],
  );
  const row = result.rows[0];
  if (
    !intent.effectStartedAt &&
    row &&
    revisionMatches(row, intent.revisions[pageId])
  ) {
    return {
      outcome: 'not_applied' as const,
      proof: {
        kind: 'local_effect_absence_verified' as const,
        observedAt: new Date().toISOString(),
        reference: `notion-body:${pageId}`,
        details: { syscallSettled: true as const, observedAbsent: true as const },
      },
      result: { pageId },
    };
  }
  const bodyHtml = row?.body_html ?? '';
  const bodyText = row?.body_text ?? '';
  const matches = intent.effectStartedAt !== null &&
    row !== undefined &&
    sha256(bodyHtml) === bodyHtmlSha256 &&
    sha256(bodyText) === bodyTextSha256 &&
    (titleSha256 === undefined || sha256(row.title) === titleSha256) &&
    (parentId === undefined || row.parent_id === parentId);
  if (!matches) {
    throw new Error('Notion body state does not match its durable recovery descriptor');
  }
  const intendedStateDigest = sha256(
    [bodyHtmlSha256, bodyTextSha256, titleSha256 ?? '', parentId ?? ''].join(':'),
  );
  const intendedSize = bodyHtmlBytes + bodyTextBytes;
  return {
    outcome: 'applied' as const,
    proof: {
      kind: 'local_bytes_verified' as const,
      observedAt: new Date().toISOString(),
      reference: `notion-body:${pageId}`,
      details: {
        syscallSettled: true as const,
        intendedStateDigest,
        observedStateDigest: intendedStateDigest,
        intendedSize,
        observedSize: intendedSize,
      },
    },
    result: { pageId },
  };
}

async function reconcileNotionAtomicSql(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
) {
  const pageId = recoveryPageId(intent);
  if (
    intent.kind !== 'import.notion.reparent' ||
    intent.effect.operation !== 'reparent-notion-page' ||
    typeof intent.effect.parentId !== 'string'
  ) {
    throw new Error('Notion reparent recovery descriptor is invalid');
  }
  const result = await client.query<{
    content_revision: string;
    lifecycle_revision: string;
  }>(
    'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1',
    [pageId],
  );
  const row = result.rows[0];
  if (!intent.effectStartedAt && row && revisionMatches(row, intent.revisions[pageId])) {
    return {
      outcome: 'not_applied' as const,
      proof: {
        kind: 'local_effect_absence_verified' as const,
        observedAt: new Date().toISOString(),
        reference: `notion-sql:${pageId}:${intent.kind}`,
        details: { syscallSettled: true as const, observedAbsent: true as const },
      },
      result: { pageId },
    };
  }
  throw new Error('Notion SQL state cannot be proven from its durable descriptor');
}


async function reconcileNotionPlaceholderDelete(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
) {
  const pageId = recoveryPageId(intent);
  if (
    intent.effect.operation !== 'delete-standalone-namespaces' ||
    !intent.deletedPageIds.includes(pageId)
  ) {
    const page = await client.query('SELECT 1 FROM pages WHERE id = $1', [pageId]);
    if (
      !intent.effectStartedAt &&
      page.rowCount === 1
    ) {
      const revisions = await client.query<{
        content_revision: string;
        lifecycle_revision: string;
      }>(
        'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1',
        [pageId],
      );
      const row = revisions.rows[0];
      if (row && revisionMatches(row, intent.revisions[pageId])) {
        return {
          outcome: 'not_applied' as const,
          proof: {
            kind: 'local_effect_absence_verified' as const,
            observedAt: new Date().toISOString(),
            reference: `notion-placeholder-delete:${pageId}`,
            details: { syscallSettled: true as const, observedAbsent: true as const },
          },
          result: { pageId },
        };
      }
    }
    throw new Error('Notion deletion has no durable committed-page tombstone');
  }
  const absent = await deletedStandaloneNamespacesAbsent({ id: pageId }, client);
  if (!absent) {
    return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
  }
  return {
    outcome: 'applied' as const,
    proof: {
      kind: 'local_intended_absence_verified' as const,
      observedAt: new Date().toISOString(),
      reference: `notion-placeholder-delete:${pageId}`,
      details: {
        syscallSettled: true as const,
        observedAbsent: true as const,
        intendedIdentity: `deleted-page:${pageId}`,
      },
    },
    result: { pageId },
  };
}

async function repairNotionPlaceholderDelete(intent: PageWriteRecoveryIntent): Promise<void> {
  const pageId = recoveryPageId(intent);
  if (!intent.deletedPageIds.includes(pageId)) {
    throw new Error('Notion deletion repair has no durable committed-page tombstone');
  }
  await advancePageWriteIntent(intent, async (client) => {
    const deletion = { id: pageId };
    await cleanupStandalonePageAttachmentDirs(deletion, client);
    if (!await deletedStandaloneNamespacesAbsent(deletion, client)) {
      throw new Error('Notion deletion repair did not remove the intended namespaces');
    }
  });
}
async function abandonPage(input: {
  pageId: number;
  notionPageId: string;
  destinationParentId: string | null;
  userId: string;
  expectedRevisions: Readonly<Record<number, PageRevision>>;
}): Promise<void> {
  const { pageId, notionPageId, destinationParentId, userId, expectedRevisions } = input;
  const intent = await reservePageWriteIntent({
    pageIds: [pageId],
    kind: 'import.notion.placeholder.delete',
    actorId: userId,
    expectedRevisions,
    effect: {
      effectClass: 'local',
      pageId,
      notionPageId: normalizeNotionId(notionPageId),
      operation: 'delete-standalone-namespaces',
      namespaces: ['local-attachments', 'page-icons'],
    },
  });
  const deletion = await advancePageWriteIntent(intent, async (client) => {
    await assertNotionTargetAuthority(client, {
      pageId,
      userId,
      notionPageId,
      expectedState: 'incomplete',
    });
    const page = await client.query<{ path: string | null }>(
      'SELECT path FROM pages WHERE id = $1',
      [pageId],
    );
    const oldPath = page.rows[0]?.path ?? `/${pageId}`;
    let destPath = '';
    if (destinationParentId) {
      const dest = await client.query<{ path: string | null }>(
        'SELECT path FROM pages WHERE id = $1 AND deleted_at IS NULL',
        [destinationParentId],
      );
      destPath = dest.rows[0]?.path ?? `/${destinationParentId}`;
    }
    const descendants = await client.query<{ id: number; parent_id: string | null; path: string }>(
      `SELECT id, parent_id, path FROM pages
        WHERE deleted_at IS NULL AND path IS NOT NULL AND path LIKE $1`,
      [`${oldPath}/%`],
    );
    for (const kid of descendants.rows) {
      const suffix = kid.path.slice(oldPath.length);
      const newPath = `${destPath}${suffix}` || `/${kid.id}`;
      const depth = newPath.split('/').filter(Boolean).length - 1;
      const parentId = kid.parent_id === String(pageId) ? destinationParentId : kid.parent_id;
      await client.query('UPDATE pages SET parent_id = $1, path = $2, depth = $3 WHERE id = $4', [
        parentId,
        newPath,
        depth,
        kid.id,
      ]);
    }
    const deleted = await client.query<{ id: number }>(
      'DELETE FROM pages WHERE id = $1 RETURNING id',
      [pageId],
    );
    const row = deleted.rows[0];
    if (!row) {
      throw new Error('Notion import placeholder disappeared before cleanup');
    }
    return row;
  });
  await runPageWriteIntentEffect(intent, { kind: 'local' }, () => cleanupStandalonePageAttachmentDirs(deletion));
  await completePageWriteIntent(intent, async () => undefined);
}



type Classified =
  | { kind: 'page'; page: Record<string, unknown> }
  | { kind: 'database'; database: Record<string, unknown> }
  | { kind: 'board'; database: Record<string, unknown> }
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
      if (await isBoardDatabase(client, page)) return { kind: 'board', database: page };
      return { kind: 'database', database: page };
    }
    return { kind: 'page', page };
  } catch (err) {
    if (isNotionObjectMissing(err)) {
      try {
        const database = await client.getDatabase(id);
        if (await isBoardDatabase(client, database)) return { kind: 'board', database };
        return { kind: 'database', database };
      } catch (dbErr) {
        return { kind: 'fail', reason: failReason(dbErr) };
      }
    }
    return { kind: 'fail', reason: failReason(err) };
  }
}

async function fetchBlocksDeep(client: NotionClient, blockId: string): Promise<NotionBlock[]> {
  const raw = await client.getAllBlockChildren(blockId);
  const limit = pLimit(NOTION_ROW_CHECK_CONCURRENCY);
  const blocks = await Promise.all(raw.map((item) => limit(async (): Promise<NotionBlock | null> => {
    if (!isRecord(item) || typeof item.type !== 'string') return null;
    const block = item as NotionBlock;
    if (
      block.has_children === true &&
      typeof block.id === 'string' &&
      !NO_RECURSE_TYPES.has(block.type)
    ) {
      block.children = await fetchBlocksDeep(client, block.id);
    }
    return block;
  })));
  return blocks.filter((block): block is NotionBlock => block !== null);
}

async function downloadAttachments(
  client: NotionClient,
  pageId: number,
  attachments: Array<{ filename: string; sourceUrl: string }>,
): Promise<LocalAttachmentWrite[]> {
  const files: LocalAttachmentWrite[] = [];
  for (const attachment of attachments) {
    try {
      const media = await client.fetchMedia(attachment.sourceUrl);
      files.push({
        filename: attachment.filename,
        contentType: media.contentType || 'application/octet-stream',
        data: media.bytes,
      });
    } catch (err) {
      const reason = failReason(err);
      logger.warn(
        { pageId, filename: attachment.filename, err: reason },
        'notion-import: attachment download failed before page mutation',
      );
      throw err instanceof Error ? err : new Error(reason);
    }
  }
  return files;
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
 * Why a database may not be flattened. `empty` and `row-bodies` are distinct on
 * purpose: only the second one lost a candidate table, so only the second one
 * earns the downgrade explanation on the result row.
 */
type FlattenAttempt =
  | { kind: 'table'; columns: string[]; rows: Array<Record<string, unknown>> }
  | { kind: 'empty' }
  /** Rows are carried so the caller can place them without re-querying. */
  | { kind: 'row-bodies'; rows: Array<Record<string, unknown>> };

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

  // One row with a body settles the question, so the probe stops asking. Every
  // probe is a paced Notion request against a database of unbounded size, and
  // the queued remainder is exactly the work the answer already made pointless.
  const limit = pLimit(NOTION_ROW_CHECK_CONCURRENCY);
  let carriesBody = false;
  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        if (carriesBody) return;
        const rowId = typeof row.id === 'string' ? row.id : '';
        if (!rowId) {
          carriesBody = true;
          return;
        }
        try {
          if (rowHasBodyContent(await client.getBlockChildren(rowId, { pageSize: NOTION_ROW_PROBE_BLOCKS }))) {
            carriesBody = true;
          }
        } catch {
          carriesBody = true;
        }
      }),
    ),
  );
  if (carriesBody) return { kind: 'row-bodies', rows };

  const props = database.properties;
  return {
    kind: 'table',
    columns: props && typeof props === 'object' ? Object.keys(props) : [],
    rows,
  };
}


function isTrashed(item: Record<string, unknown>): boolean {
  return item.in_trash === true || item.archived === true;
}

function boardHostId(database: Record<string, unknown>): string {
  const parent = isRecord(database.parent) ? database.parent : null;
  if (parent?.type === 'page_id' && typeof parent.page_id === 'string') return parent.page_id;
  return typeof database.id === 'string' ? database.id : '';
}

async function isBoardDatabase(
  client: NotionClient,
  item: Record<string, unknown>,
): Promise<boolean> {
  if (isWikiDatabase(item)) return false;
  if (isBoardLayout(item)) return true;
  const id = typeof item.id === 'string' ? item.id : '';
  if (!id) return false;
  return client.databaseHasBoardView(id);
}

async function getPageQuietly(client: NotionClient, id: string): Promise<Record<string, unknown> | null> {
  try {
    return await client.getPage(id);
  } catch (err) {
    if (isNotionObjectMissing(err)) return null;
    throw err;
  }
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

    const text = extractPropertyText(prop).trim();
    if (text) customProperties[key] = text;
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

async function rehomeAlreadyImported(
  already: AlreadyImported[],
  importedPages: Map<string, number>,
  userId: string,
  items: Map<string, NotionImportItem>,
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
    try {
      const intent = await reservePageWriteIntent({
        pageIds: [row.localPageId],
        kind: 'import.notion.reparent',
        actorId: userId,
        expectedRevisions: row.expectedRevisions,
        effect: {
          effectClass: 'local',
          operation: 'reparent-notion-page',
          pageId: row.localPageId,
          parentId: String(parentLocal),
        },
      });
      await completePageWriteIntent(intent, async (client) => {
        await assertNotionTargetAuthority(client, {
          pageId: row.localPageId,
          userId,
          notionPageId: row.notionPageId,
          expectedState: 'complete',
        });
        if (await rehomePage(row.localPageId, String(parentLocal), client)) {
          await client.query(
            'UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1',
            [row.localPageId],
          );
        }
      });
    } catch (err) {
      items.set(row.notionPageId, {
        notionPageId: row.notionPageId,
        status: 'fail',
        localPageId: row.localPageId,
        reason: failReason(err),
      });
    }
  }
}

async function rehomePage(
  pageId: number,
  parentId: string | null,
  client?: PoolClient,
): Promise<boolean> {
  const runQuery = <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => client ? client.query<T>(text, values) : query<T>(text, values);
  const current = await runQuery<{ parent_id: string | null; path: string | null }>(
    'SELECT parent_id, path FROM pages WHERE id = $1 AND deleted_at IS NULL',
    [pageId],
  );
  const row = current.rows[0];
  if (!row || (row.parent_id ?? null) === (parentId ?? null)) return false;

  let parentPath: string | null = null;
  if (parentId) {
    const parent = await runQuery<{ path: string | null }>(
      'SELECT path FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [parentId],
    );
    parentPath = parent.rows[0]?.path ?? `/${parentId}`;
  }
  const oldPath = row.path ?? `/${pageId}`;
  const newPath = parentPath ? `${parentPath}/${pageId}` : `/${pageId}`;
  const depth = newPath.split('/').filter(Boolean).length - 1;
  await runQuery('UPDATE pages SET parent_id = $1, path = $2, depth = $3 WHERE id = $4', [
    parentId,
    newPath,
    depth,
    pageId,
  ]);
  const descendants = await runQuery<{ id: number; path: string }>(
    `SELECT id, path FROM pages WHERE deleted_at IS NULL AND path IS NOT NULL AND path LIKE $1`,
    [`${oldPath}/%`],
  );
  for (const kid of descendants.rows) {
    const suffix = kid.path.slice(oldPath.length);
    const kidPath = `${newPath}${suffix}`;
    const kidDepth = kidPath.split('/').filter(Boolean).length - 1;
    await runQuery('UPDATE pages SET path = $1, depth = $2 WHERE id = $3', [
      kidPath,
      kidDepth,
      kid.id,
    ]);
  }
  return true;
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

registerPageWriteIntentReconciler('import.notion.publish', reconcileNotionBodyWrite);
registerPageWriteIntentReconciler('import.notion.overwrite', reconcileNotionBodyWrite);
registerPageWriteIntentReconciler('import.notion.reparent', reconcileNotionAtomicSql);
registerPageWriteIntentReconciler(
  'import.notion.placeholder.delete',
  reconcileNotionPlaceholderDelete,
  repairNotionPlaceholderDelete,
);
