import { query } from '../db/postgres.js';
import { ConfluenceClient, ConfluencePage, ConfluenceSpace } from './confluence-client.js';
import { confluenceToHtml, htmlToText } from './content-converter.js';
import { syncDrawioAttachments, syncImageAttachments, cleanPageAttachments, getMissingAttachments } from './attachment-handler.js';
import { saveVersionSnapshot } from './version-tracker.js';
import { processDirtyPages } from './embedding-service.js';
import { decryptPat } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

interface SyncStatus {
  userId: string;
  status: 'idle' | 'syncing' | 'embedding' | 'error';
  progress?: { current: number; total: number; space?: string };
  lastSynced?: Date;
  error?: string;
}

const syncStatuses = new Map<string, SyncStatus>();
let syncIntervalHandle: ReturnType<typeof setInterval> | null = null;
let syncLock = false;

/**
 * Get a ConfluenceClient for a user by decrypting their stored credentials.
 */
export async function getClientForUser(userId: string): Promise<ConfluenceClient | null> {
  const result = await query<{ confluence_url: string | null; confluence_pat: string | null }>(
    'SELECT confluence_url, confluence_pat FROM user_settings WHERE user_id = $1',
    [userId],
  );

  const row = result.rows[0];
  if (!row?.confluence_url || !row?.confluence_pat) return null;

  const pat = decryptPat(row.confluence_pat);
  return new ConfluenceClient(row.confluence_url, pat);
}

/**
 * Sync all pages from a user's selected spaces.
 */
export async function syncUser(userId: string): Promise<void> {
  const client = await getClientForUser(userId);
  if (!client) {
    logger.warn({ userId }, 'No Confluence credentials configured, skipping sync');
    syncStatuses.set(userId, { userId, status: 'idle' });
    return;
  }

  // Read selected spaces from user_space_selections
  const settingsResult = await query<{ space_key: string }>(
    'SELECT space_key FROM user_space_selections WHERE user_id = $1',
    [userId],
  );
  const spaces = settingsResult.rows.map((r) => r.space_key);
  if (spaces.length === 0) {
    logger.info({ userId }, 'No spaces selected, skipping sync');
    syncStatuses.set(userId, { userId, status: 'idle' });
    return;
  }

  syncStatuses.set(userId, { userId, status: 'syncing' });

  try {
    // Fetch all spaces once to avoid redundant API calls per space
    const allSpaces = await client.getAllSpaces();
    const spacesByKey = new Map(allSpaces.map((s) => [s.key, s]));

    for (const spaceKey of spaces) {
      await syncSpace(client, userId, spaceKey, spacesByKey.get(spaceKey));
    }

    // Set status to 'embedding' while processing dirty pages
    syncStatuses.set(userId, {
      userId,
      status: 'embedding',
      lastSynced: new Date(),
    });

    // Trigger embedding for dirty pages; update status when complete
    processDirtyPages(userId).then(({ processed, errors }) => {
      if (processed > 0 || errors > 0) {
        logger.info({ userId, processed, errors }, 'Post-sync embedding completed');
      }
      syncStatuses.set(userId, {
        userId,
        status: 'idle',
        lastSynced: new Date(),
      });
    }).catch((err) => {
      logger.error({ err, userId }, 'Post-sync embedding failed');
      syncStatuses.set(userId, {
        userId,
        status: 'idle',
        lastSynced: new Date(),
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, userId }, 'Sync failed');
    syncStatuses.set(userId, { userId, status: 'error', error: message });
    throw err;
  }
}

async function syncSpace(client: ConfluenceClient, userId: string, spaceKey: string, space?: ConfluenceSpace): Promise<void> {
  logger.info({ userId, spaceKey }, 'Syncing space');

  // Upsert shared space metadata (no user_id)
  if (space) {
    const homepageId = space.homepage?.id ?? null;
    await query(
      `INSERT INTO cached_spaces (space_key, space_name, homepage_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (space_key)
       DO UPDATE SET space_name = $2, homepage_id = $3, last_synced = NOW()`,
      [spaceKey, space.name, homepageId],
    );
  }

  // Check last sync time for incremental sync (global, not per-user)
  const lastSyncResult = await query<{ last_synced: Date }>(
    'SELECT last_synced FROM cached_spaces WHERE space_key = $1',
    [spaceKey],
  );
  const lastSynced = lastSyncResult.rows[0]?.last_synced;

  let pages: ConfluencePage[];
  if (lastSynced && (Date.now() - lastSynced.getTime()) < 24 * 60 * 60 * 1000) {
    // Incremental: only modified pages
    pages = await client.getModifiedPages(lastSynced, spaceKey);
    logger.info({ userId, spaceKey, modified: pages.length }, 'Incremental sync');
  } else {
    // Full sync
    pages = await client.getAllPagesInSpace(spaceKey);
    logger.info({ userId, spaceKey, total: pages.length }, 'Full sync');
  }

  // Track progress
  const total = pages.length;
  for (let i = 0; i < pages.length; i++) {
    syncStatuses.set(userId, {
      userId,
      status: 'syncing',
      progress: { current: i + 1, total, space: spaceKey },
    });

    const page = pages[i];
    await syncPage(client, userId, spaceKey, page);
  }

  // During incremental sync, also check for pages with missing attachments
  // that weren't in the modified list. This catches pages whose content
  // was synced previously but attachment downloads failed.
  if (lastSynced && (Date.now() - lastSynced.getTime()) < 24 * 60 * 60 * 1000) {
    await syncMissingAttachments(client, userId, spaceKey);
  }

  // Detect deleted pages (only during full sync)
  if (!lastSynced || (Date.now() - lastSynced.getTime()) >= 24 * 60 * 60 * 1000) {
    await detectDeletedPages(client, spaceKey, pages);
  }

  // Update space sync timestamp (shared table)
  await query(
    'UPDATE cached_spaces SET last_synced = NOW() WHERE space_key = $1',
    [spaceKey],
  );
}

async function syncPage(
  client: ConfluenceClient,
  userId: string,
  spaceKey: string,
  pageSummary: ConfluencePage,
): Promise<void> {
  // Fetch full page content
  const page = await client.getPage(pageSummary.id);
  const bodyStorage = page.body?.storage?.value ?? '';

  // Convert to HTML
  const bodyHtml = confluenceToHtml(bodyStorage, page.id, spaceKey);
  const bodyText = htmlToText(bodyHtml);

  // Extract metadata
  const labels = page.metadata?.labels?.results?.map((l) => l.name) ?? [];
  const parentId = page.ancestors?.length ? page.ancestors[page.ancestors.length - 1].id : null;
  const author = page.version?.by?.displayName ?? null;
  const lastModified = page.version?.when ? new Date(page.version.when) : new Date();

  // Check if page exists and has changed (shared table, no user_id)
  const existing = await query<{ version: number; title: string; body_html: string; body_text: string }>(
    'SELECT version, title, body_html, body_text FROM cached_pages WHERE confluence_id = $1',
    [page.id],
  );

  if (existing.rows.length > 0 && existing.rows[0].version >= page.version.number) {
    const htmlChanged = existing.rows[0].body_html !== bodyHtml || existing.rows[0].body_text !== bodyText;

    // Page content hasn't changed, but check if all expected attachments are cached.
    // Previous syncs may have failed to download some/all attachments (transient errors).
    // Compare expected filenames (from XHTML) against files on disk, per-file.
    const missing = await getMissingAttachments(userId, page.id, bodyStorage, spaceKey);
    if (missing.length === 0 && !htmlChanged) {
      return;
    }

    if (missing.length > 0) {
      logger.info({ pageId: page.id, missing: missing.length }, 'Page unchanged but some attachments missing — re-syncing');
      const { results: attachments } = await client.getPageAttachments(page.id);
      await syncDrawioAttachments(client, userId, page.id, bodyStorage, attachments);
      await syncImageAttachments(client, userId, page.id, bodyStorage, attachments, spaceKey);
    }

    if (htmlChanged) {
      await query(
        `UPDATE cached_pages
         SET title = $2,
             body_storage = $3,
             body_html = $4,
             body_text = $5,
             parent_id = $6,
             labels = $7,
             author = $8,
             last_modified_at = $9,
             last_synced = NOW(),
             embedding_dirty = CASE
               WHEN body_text IS DISTINCT FROM $5 THEN TRUE
               ELSE embedding_dirty
             END
         WHERE confluence_id = $1`,
        [page.id, page.title, bodyStorage, bodyHtml, bodyText, parentId, labels, author, lastModified],
      );
    }

    return;
  }

  // Clear stale attachment cache when an existing page has a new version,
  // so updated diagrams/images are re-downloaded rather than served from cache.
  if (existing.rows.length > 0) {
    await cleanPageAttachments(userId, page.id);
  }

  // Fetch attachments once and sync after version guard to avoid API calls for unchanged pages
  const { results: attachments } = await client.getPageAttachments(page.id);
  await syncDrawioAttachments(client, userId, page.id, bodyStorage, attachments);
  await syncImageAttachments(client, userId, page.id, bodyStorage, attachments, spaceKey);

  // Save current version snapshot before updating (for version history / semantic diff)
  if (existing.rows.length > 0) {
    await saveVersionSnapshot(
      page.id,
      existing.rows[0].version,
      existing.rows[0].title,
      existing.rows[0].body_html,
      existing.rows[0].body_text,
    );
  }

  // Upsert page (shared table, no user_id)
  await query(
    `INSERT INTO cached_pages
       (confluence_id, space_key, title, body_storage, body_html, body_text,
        version, parent_id, labels, author, last_modified_at, embedding_dirty)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
     ON CONFLICT (confluence_id) DO UPDATE SET
       title = EXCLUDED.title,
       body_storage = EXCLUDED.body_storage,
       body_html = EXCLUDED.body_html,
       body_text = EXCLUDED.body_text,
       version = EXCLUDED.version,
       parent_id = EXCLUDED.parent_id,
       labels = EXCLUDED.labels,
       author = EXCLUDED.author,
       last_modified_at = EXCLUDED.last_modified_at,
       last_synced = NOW(),
       embedding_dirty = TRUE`,
    [page.id, spaceKey, page.title, bodyStorage, bodyHtml, bodyText,
     page.version.number, parentId, labels, author, lastModified],
  );
}

/**
 * Find cached pages in a space that have missing attachment files and re-sync them.
 * This covers the gap where incremental sync skips unchanged pages whose
 * attachment downloads previously failed.
 */
async function syncMissingAttachments(
  client: ConfluenceClient,
  userId: string,
  spaceKey: string,
): Promise<void> {
  // Query pages in this space that have XHTML content (body_storage)
  const pagesResult = await query<{ confluence_id: string; body_storage: string }>(
    'SELECT confluence_id, body_storage FROM cached_pages WHERE space_key = $1 AND body_storage IS NOT NULL',
    [spaceKey],
  );

  let retried = 0;
  for (const row of pagesResult.rows) {
    const missing = await getMissingAttachments(userId, row.confluence_id, row.body_storage, spaceKey);
    if (missing.length === 0) continue;

    logger.info(
      { pageId: row.confluence_id, missing: missing.length },
      'Retrying missing attachments for unchanged page',
    );

    try {
      const { results: attachments } = await client.getPageAttachments(row.confluence_id);
      await syncDrawioAttachments(client, userId, row.confluence_id, row.body_storage, attachments);
      await syncImageAttachments(client, userId, row.confluence_id, row.body_storage, attachments, spaceKey);
      retried++;
    } catch (err) {
      logger.error({ err, pageId: row.confluence_id }, 'Failed to retry missing attachments');
    }
  }

  if (retried > 0) {
    logger.info({ spaceKey, retried }, 'Retried missing attachments for pages');
  }
}

async function detectDeletedPages(
  _client: ConfluenceClient,
  spaceKey: string,
  currentPages: ConfluencePage[],
): Promise<void> {
  // Only delete pages when exactly one user has this space selected.
  // If multiple users share the space, one user's limited-permission sync
  // could incorrectly delete pages still visible to another user.
  const selectionCount = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM user_space_selections WHERE space_key = $1',
    [spaceKey],
  );
  if (parseInt(selectionCount.rows[0]?.count ?? '0', 10) !== 1) {
    logger.info({ spaceKey }, 'Skipping stale-page detection: space is shared by multiple users');
    return;
  }

  const currentIds = new Set(currentPages.map((p) => p.id));

  // Query shared table by space_key only
  const existingResult = await query<{ confluence_id: string }>(
    'SELECT confluence_id FROM cached_pages WHERE space_key = $1',
    [spaceKey],
  );

  for (const { confluence_id } of existingResult.rows) {
    if (!currentIds.has(confluence_id)) {
      logger.info({ spaceKey, confluenceId: confluence_id }, 'Deleting stale page');
      // page_embeddings are deleted by CASCADE on cached_pages
      await query('DELETE FROM cached_pages WHERE confluence_id = $1', [confluence_id]);
      await cleanPageAttachments('', confluence_id);
    }
  }
}

/**
 * Get sync status for a user.
 */
export function getSyncStatus(userId: string): SyncStatus {
  return syncStatuses.get(userId) ?? { userId, status: 'idle' };
}

/**
 * Set sync status for a user (used by route handler to set 'syncing' before dispatch).
 */
export function setSyncStatus(userId: string, status: SyncStatus): void {
  syncStatuses.set(userId, status);
}

/**
 * Start the background sync worker.
 */
export function startSyncWorker(intervalMinutes = 15): void {
  if (syncIntervalHandle) return;

  const intervalMs = intervalMinutes * 60 * 1000;

  syncIntervalHandle = setInterval(async () => {
    if (syncLock) return;
    syncLock = true;

    try {
      // Get all users with configured connections and space selections
      const users = await query<{ user_id: string }>(
        `SELECT DISTINCT us.user_id FROM user_settings us
         JOIN user_space_selections uss ON uss.user_id = us.user_id
         WHERE us.confluence_url IS NOT NULL AND us.confluence_pat IS NOT NULL`,
      );

      for (const { user_id } of users.rows) {
        try {
          await syncUser(user_id);
        } catch (err) {
          logger.error({ err, userId: user_id }, 'Background sync failed for user');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Background sync worker error');
    } finally {
      syncLock = false;
    }
  }, intervalMs);

  logger.info({ intervalMinutes }, 'Background sync worker started');
}

/**
 * Stop the background sync worker.
 */
export function stopSyncWorker(): void {
  if (syncIntervalHandle) {
    clearInterval(syncIntervalHandle);
    syncIntervalHandle = null;
    logger.info('Background sync worker stopped');
  }
}
