import { query } from '../db/postgres.js';
import { ConfluenceClient, ConfluencePage } from './confluence-client.js';
import { confluenceToHtml, htmlToText } from './content-converter.js';
import { syncDrawioAttachments, syncImageAttachments, cleanPageAttachments } from './attachment-handler.js';
import { saveVersionSnapshot } from './version-tracker.js';
import { processDirtyPages } from './embedding-service.js';
import { decryptPat } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

interface SyncStatus {
  userId: string;
  status: 'idle' | 'syncing' | 'error';
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

  const settingsResult = await query<{ selected_spaces: string[] }>(
    'SELECT selected_spaces FROM user_settings WHERE user_id = $1',
    [userId],
  );
  const spaces = settingsResult.rows[0]?.selected_spaces ?? [];
  if (spaces.length === 0) {
    logger.info({ userId }, 'No spaces selected, skipping sync');
    syncStatuses.set(userId, { userId, status: 'idle' });
    return;
  }

  syncStatuses.set(userId, { userId, status: 'syncing' });

  try {
    for (const spaceKey of spaces) {
      await syncSpace(client, userId, spaceKey);
    }

    // Trigger embedding for dirty pages asynchronously after sync
    processDirtyPages(userId).then(({ processed, errors }) => {
      if (processed > 0 || errors > 0) {
        logger.info({ userId, processed, errors }, 'Post-sync embedding completed');
      }
    }).catch((err) => {
      logger.error({ err, userId }, 'Post-sync embedding failed');
    });

    syncStatuses.set(userId, {
      userId,
      status: 'idle',
      lastSynced: new Date(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, userId }, 'Sync failed');
    syncStatuses.set(userId, { userId, status: 'error', error: message });
    throw err;
  }
}

async function syncSpace(client: ConfluenceClient, userId: string, spaceKey: string): Promise<void> {
  logger.info({ userId, spaceKey }, 'Syncing space');

  // Upsert space metadata
  const spaces = await client.getSpaces();
  const space = spaces.results.find((s) => s.key === spaceKey);
  if (space) {
    const homepageId = space.homepage?.id ?? null;
    await query(
      `INSERT INTO cached_spaces (user_id, space_key, space_name, homepage_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, space_key)
       DO UPDATE SET space_name = $3, homepage_id = $4, last_synced = NOW()`,
      [userId, spaceKey, space.name, homepageId],
    );
  }

  // Check last sync time for incremental sync
  const lastSyncResult = await query<{ last_synced: Date }>(
    'SELECT last_synced FROM cached_spaces WHERE user_id = $1 AND space_key = $2',
    [userId, spaceKey],
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

  // Detect deleted pages (only during full sync)
  if (!lastSynced || (Date.now() - lastSynced.getTime()) >= 24 * 60 * 60 * 1000) {
    await detectDeletedPages(client, userId, spaceKey, pages);
  }

  // Update space sync timestamp
  await query(
    'UPDATE cached_spaces SET last_synced = NOW() WHERE user_id = $1 AND space_key = $2',
    [userId, spaceKey],
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
  const bodyHtml = confluenceToHtml(bodyStorage, page.id);
  const bodyText = htmlToText(bodyHtml);

  // Sync draw.io and image attachments
  await syncDrawioAttachments(client, userId, page.id, bodyStorage);
  await syncImageAttachments(client, userId, page.id, bodyStorage);

  // Extract metadata
  const labels = page.metadata?.labels?.results?.map((l) => l.name) ?? [];
  const parentId = page.ancestors?.length ? page.ancestors[page.ancestors.length - 1].id : null;
  const author = page.version?.by?.displayName ?? null;
  const lastModified = page.version?.when ? new Date(page.version.when) : new Date();

  // Check if page exists and has changed
  const existing = await query<{ version: number; title: string; body_html: string; body_text: string }>(
    'SELECT version, title, body_html, body_text FROM cached_pages WHERE user_id = $1 AND confluence_id = $2',
    [userId, page.id],
  );

  if (existing.rows.length > 0 && existing.rows[0].version >= page.version.number) {
    // Page hasn't changed
    return;
  }

  // Save current version snapshot before updating (for version history / semantic diff)
  if (existing.rows.length > 0) {
    await saveVersionSnapshot(
      userId,
      page.id,
      existing.rows[0].version,
      existing.rows[0].title,
      existing.rows[0].body_html,
      existing.rows[0].body_text,
    );
  }

  // Upsert page
  await query(
    `INSERT INTO cached_pages
       (user_id, confluence_id, space_key, title, body_storage, body_html, body_text,
        version, parent_id, labels, author, last_modified_at, embedding_dirty)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE)
     ON CONFLICT (user_id, confluence_id) DO UPDATE SET
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
    [userId, page.id, spaceKey, page.title, bodyStorage, bodyHtml, bodyText,
     page.version.number, parentId, labels, author, lastModified],
  );
}

async function detectDeletedPages(
  _client: ConfluenceClient,
  userId: string,
  spaceKey: string,
  currentPages: ConfluencePage[],
): Promise<void> {
  const currentIds = new Set(currentPages.map((p) => p.id));

  const existingResult = await query<{ confluence_id: string }>(
    'SELECT confluence_id FROM cached_pages WHERE user_id = $1 AND space_key = $2',
    [userId, spaceKey],
  );

  for (const { confluence_id } of existingResult.rows) {
    if (!currentIds.has(confluence_id)) {
      logger.info({ userId, confluenceId: confluence_id }, 'Deleting stale page');
      await query('DELETE FROM page_embeddings WHERE user_id = $1 AND confluence_id = $2', [userId, confluence_id]);
      await query('DELETE FROM cached_pages WHERE user_id = $1 AND confluence_id = $2', [userId, confluence_id]);
      await cleanPageAttachments(userId, confluence_id);
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
      // Get all users with configured connections
      const users = await query<{ user_id: string }>(
        `SELECT us.user_id FROM user_settings us
         WHERE us.confluence_url IS NOT NULL AND us.confluence_pat IS NOT NULL
           AND array_length(us.selected_spaces, 1) > 0`,
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
