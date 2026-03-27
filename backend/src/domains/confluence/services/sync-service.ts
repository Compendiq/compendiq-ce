import { randomUUID } from 'node:crypto';
import { query } from '../../../core/db/postgres.js';
import { ConfluenceClient, ConfluencePage, ConfluenceSpace } from './confluence-client.js';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { syncDrawioAttachments, syncImageAttachments, cleanPageAttachments, getMissingAttachments } from './attachment-handler.js';
import { saveVersionSnapshot } from '../../../core/services/version-snapshot.js';
import { processDirtyPages } from '../../llm/services/embedding-service.js';
import { getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import { decryptPat } from '../../../core/utils/crypto.js';
import { addAllowedBaseUrl } from '../../../core/utils/ssrf-guard.js';
import { logger } from '../../../core/utils/logger.js';
import {
  getRedisClient,
  recordAttachmentFailure,
  getAttachmentFailureCount,
  clearAttachmentFailures,
  MAX_ATTACHMENT_FAILURES as REDIS_MAX_ATTACHMENT_FAILURES,
} from '../../../core/services/redis-cache.js';

interface SyncStatus {
  userId: string;
  status: 'idle' | 'syncing' | 'embedding' | 'error';
  progress?: { current: number; total: number; space?: string };
  lastSynced?: Date;
  error?: string;
}

/** In-memory cache for sync statuses; Redis is the source of truth when available. */
const syncStatusesLocal = new Map<string, SyncStatus>();
let syncIntervalHandle: ReturnType<typeof setInterval> | null = null;

// ── Redis keys ────────────────────────────────────────────────────────────────
const SYNC_LOCK_KEY = 'sync:worker:lock';
const SYNC_LOCK_TTL = 600; // 10 min safety TTL
const SYNC_STATUS_PREFIX = 'sync:status:';
const SYNC_STATUS_TTL = 86_400; // 24 h

/** Lua script: only delete the lock if the caller owns it (value matches). */
const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Attempt to acquire the sync worker lock via Redis SET NX EX.
 * Returns a unique lock id if acquired, or null if already held.
 * Falls back to a generated id when Redis is unavailable.
 */
async function acquireSyncLock(): Promise<string | null> {
  const lockId = randomUUID();
  const redis = getRedisClient();
  if (!redis) {
    logger.warn('Redis not available for sync lock, proceeding without lock');
    return lockId;
  }
  try {
    const result = await redis.set(SYNC_LOCK_KEY, lockId, { NX: true, EX: SYNC_LOCK_TTL });
    return result !== null ? lockId : null;
  } catch (err) {
    logger.error({ err }, 'Failed to acquire sync lock');
    return null;
  }
}

/** Release the sync worker lock using Lua ownership check. */
async function releaseSyncLock(lockId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [SYNC_LOCK_KEY], arguments: [lockId] });
  } catch (err) {
    logger.error({ err }, 'Failed to release sync lock');
  }
}

const MAX_ATTACHMENT_FAILURES = REDIS_MAX_ATTACHMENT_FAILURES;

/** Clear all attachment failure counters for a page (delegates to Redis). */
async function clearPageFailures(pageId: string): Promise<void> {
  const redis = getRedisClient();
  await clearAttachmentFailures(redis, pageId);
}

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
    await setSyncStatus(userId, { userId, status: 'idle' });
    return;
  }

  // Read accessible spaces from RBAC
  const spaces = await getUserAccessibleSpaces(userId);
  if (spaces.length === 0) {
    logger.info({ userId }, 'No spaces selected, skipping sync');
    await setSyncStatus(userId, { userId, status: 'idle' });
    return;
  }

  await setSyncStatus(userId, { userId, status: 'syncing' });

  try {
    // Fetch all spaces once to avoid redundant API calls per space
    const allSpaces = await client.getAllSpaces();
    const spacesByKey = new Map(allSpaces.map((s) => [s.key, s]));

    for (const spaceKey of spaces) {
      await syncSpace(client, userId, spaceKey, spacesByKey.get(spaceKey));
    }

    // Set status to 'embedding' while processing dirty pages
    await setSyncStatus(userId, {
      userId,
      status: 'embedding',
      lastSynced: new Date(),
    });

    // Trigger embedding for dirty pages; update status when complete
    processDirtyPages(userId).then(async ({ processed, errors }) => {
      if (processed > 0 || errors > 0) {
        logger.info({ userId, processed, errors }, 'Post-sync embedding completed');
      }
      await setSyncStatus(userId, {
        userId,
        status: 'idle',
        lastSynced: new Date(),
      });
    }).catch(async (err) => {
      logger.error({ err, userId }, 'Post-sync embedding failed');
      await setSyncStatus(userId, {
        userId,
        status: 'idle',
        lastSynced: new Date(),
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, userId }, 'Sync failed');
    await setSyncStatus(userId, { userId, status: 'error', error: message });
    throw err;
  }
}

async function syncSpace(client: ConfluenceClient, userId: string, spaceKey: string, space?: ConfluenceSpace): Promise<void> {
  logger.info({ userId, spaceKey }, 'Syncing space');

  // Upsert shared space metadata (no user_id)
  if (space) {
    const homepageId = space.homepage?.id ?? null;
    await query(
      `INSERT INTO spaces (space_key, space_name, homepage_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (space_key)
       DO UPDATE SET space_name = $2, homepage_id = $3, last_synced = NOW()`,
      [spaceKey, space.name, homepageId],
    );
  }

  // Check last sync time for incremental sync (global, not per-user)
  const lastSyncResult = await query<{ last_synced: Date }>(
    'SELECT last_synced FROM spaces WHERE space_key = $1',
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
    await setSyncStatus(userId, {
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
    'UPDATE spaces SET last_synced = NOW() WHERE space_key = $1',
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
    'SELECT version, title, body_html, body_text FROM pages WHERE confluence_id = $1',
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
      const redis = getRedisClient();
      // Filter out attachments that have exceeded the failure threshold
      const retriableChecks = await Promise.all(
        missing.map(async (f) => ({
          filename: f,
          count: await getAttachmentFailureCount(redis, page.id, f),
        })),
      );
      const retriable = retriableChecks
        .filter((c) => c.count < MAX_ATTACHMENT_FAILURES)
        .map((c) => c.filename);

      if (retriable.length > 0) {
        logger.info({ pageId: page.id, missing: retriable.length }, 'Page unchanged but some attachments missing — re-syncing');
        const { results: attachments } = await client.getPageAttachments(page.id);
        await syncDrawioAttachments(client, userId, page.id, bodyStorage, attachments);
        await syncImageAttachments(client, userId, page.id, bodyStorage, attachments, spaceKey);

        // Track which are still missing
        const stillMissing = new Set(
          await getMissingAttachments(userId, page.id, bodyStorage, spaceKey),
        );
        for (const f of retriable) {
          if (stillMissing.has(f)) {
            await recordAttachmentFailure(redis, page.id, f);
            const count = await getAttachmentFailureCount(redis, page.id, f);
            if (count >= MAX_ATTACHMENT_FAILURES) {
              logger.warn(
                { pageId: page.id, filename: f, failures: count },
                'Attachment permanently failed — skipping until TTL expiry',
              );
            }
          }
          // No explicit delete needed: Redis keys expire via TTL
        }
      }
    }

    if (htmlChanged) {
      await query(
        `UPDATE pages
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
             END,
             summary_status = CASE
               WHEN body_text IS DISTINCT FROM $5 THEN 'pending'
               ELSE summary_status
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
    // Reset failure tracking — new version may have fixed broken attachments
    await clearPageFailures(page.id);
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
    `INSERT INTO pages
       (confluence_id, space_key, title, body_storage, body_html, body_text,
        version, parent_id, labels, author, last_modified_at, embedding_dirty,
        summary_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, 'pending')
     ON CONFLICT (confluence_id) WHERE confluence_id IS NOT NULL DO UPDATE SET
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
       embedding_dirty = TRUE,
       summary_status = 'pending'`,
    [page.id, spaceKey, page.title, bodyStorage, bodyHtml, bodyText,
     page.version.number, parentId, labels, author, lastModified],
  );
}

/**
 * Find cached pages in a space that have missing attachment files and re-sync them.
 * This covers the gap where incremental sync skips unchanged pages whose
 * attachment downloads previously failed.
 *
 * Attachments that fail repeatedly (e.g. Confluence returns 500 for old files
 * with problematic filenames) are tracked via Redis and skipped
 * after MAX_ATTACHMENT_FAILURES consecutive failures to avoid log noise.
 */
async function syncMissingAttachments(
  client: ConfluenceClient,
  userId: string,
  spaceKey: string,
): Promise<void> {
  const redis = getRedisClient();

  // Query pages in this space that have XHTML content (body_storage)
  const pagesResult = await query<{ confluence_id: string; body_storage: string }>(
    'SELECT confluence_id, body_storage FROM pages WHERE space_key = $1 AND body_storage IS NOT NULL',
    [spaceKey],
  );

  let retried = 0;
  for (const row of pagesResult.rows) {
    const allMissing = await getMissingAttachments(userId, row.confluence_id, row.body_storage, spaceKey);
    if (allMissing.length === 0) continue;

    // Filter out attachments that have exceeded the failure threshold
    const retriableChecks = await Promise.all(
      allMissing.map(async (f) => ({
        filename: f,
        count: await getAttachmentFailureCount(redis, row.confluence_id, f),
      })),
    );
    const retriable = retriableChecks
      .filter((c) => c.count < MAX_ATTACHMENT_FAILURES)
      .map((c) => c.filename);

    if (retriable.length === 0) continue;

    logger.info(
      { pageId: row.confluence_id, missing: retriable.length },
      'Retrying missing attachments for unchanged page',
    );

    try {
      const { results: attachments } = await client.getPageAttachments(row.confluence_id);
      await syncDrawioAttachments(client, userId, row.confluence_id, row.body_storage, attachments);
      await syncImageAttachments(client, userId, row.confluence_id, row.body_storage, attachments, spaceKey);

      // Check which are still missing and update failure counts
      const stillMissing = new Set(
        await getMissingAttachments(userId, row.confluence_id, row.body_storage, spaceKey),
      );

      for (const f of retriable) {
        if (stillMissing.has(f)) {
          await recordAttachmentFailure(redis, row.confluence_id, f);
          const count = await getAttachmentFailureCount(redis, row.confluence_id, f);
          if (count >= MAX_ATTACHMENT_FAILURES) {
            logger.warn(
              { pageId: row.confluence_id, filename: f, failures: count },
              'Attachment permanently failed — skipping until TTL expiry',
            );
          }
        }
        // No explicit delete needed: Redis keys expire via TTL
      }

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
  // Only delete pages when exactly one user has this space assigned via RBAC.
  // If multiple users share the space, one user's limited-permission sync
  // could incorrectly delete pages still visible to another user.
  const selectionCount = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT principal_id) AS count FROM space_role_assignments
     WHERE space_key = $1 AND principal_type = 'user'`,
    [spaceKey],
  );
  if (parseInt(selectionCount.rows[0]?.count ?? '0', 10) !== 1) {
    logger.info({ spaceKey }, 'Skipping stale-page detection: space is shared by multiple users');
    return;
  }

  const currentIds = new Set(currentPages.map((p) => p.id));

  // Query shared table by space_key only
  const existingResult = await query<{ confluence_id: string }>(
    'SELECT confluence_id FROM pages WHERE space_key = $1',
    [spaceKey],
  );

  for (const { confluence_id } of existingResult.rows) {
    if (!currentIds.has(confluence_id)) {
      logger.info({ spaceKey, confluenceId: confluence_id }, 'Deleting stale page');
      // page_embeddings are deleted by CASCADE on pages
      await query('DELETE FROM pages WHERE confluence_id = $1', [confluence_id]);
      await cleanPageAttachments('', confluence_id);
      await clearPageFailures(confluence_id);
    }
  }
}

/**
 * Get sync status for a user.
 *
 * Reads from Redis first, then falls back to the in-memory cache, and finally
 * to the database (MAX(last_synced) across the user's RBAC-accessible spaces).
 * The result is always stored in both Redis and the in-memory cache.
 */
export async function getSyncStatus(userId: string): Promise<SyncStatus> {
  // 1. Try Redis
  const redis = getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get(`${SYNC_STATUS_PREFIX}${userId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as SyncStatus;
        // Revive lastSynced from string to Date
        if (parsed.lastSynced && typeof parsed.lastSynced === 'string') {
          parsed.lastSynced = new Date(parsed.lastSynced as string);
        }
        syncStatusesLocal.set(userId, parsed);
        return parsed;
      }
    } catch (err) {
      logger.error({ err, userId }, 'Failed to read sync status from Redis');
    }
  }

  // 2. Try in-memory cache
  const cached = syncStatusesLocal.get(userId);
  if (cached) return cached;

  // 3. Fall back to DB — find the most recent space sync for this user's spaces
  const result = await query<{ last_synced: Date | null }>(
    `SELECT MAX(s.last_synced) AS last_synced
     FROM spaces s
     INNER JOIN space_role_assignments sra
       ON sra.space_key = s.space_key
       AND sra.principal_type = 'user'
       AND sra.principal_id = $1`,
    [userId],
  );

  const lastSynced = result.rows[0]?.last_synced ?? undefined;
  const status: SyncStatus = { userId, status: 'idle', lastSynced };

  // Seed both caches
  syncStatusesLocal.set(userId, status);
  await setSyncStatus(userId, status);
  return status;
}

/**
 * Set sync status for a user.
 * Writes to both Redis (source of truth) and in-memory cache (fast reads).
 */
export async function setSyncStatus(userId: string, status: SyncStatus): Promise<void> {
  syncStatusesLocal.set(userId, status);
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(`${SYNC_STATUS_PREFIX}${userId}`, JSON.stringify(status), { EX: SYNC_STATUS_TTL });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to write sync status to Redis');
  }
}

/**
 * Start the background sync worker.
 */
export function startSyncWorker(intervalMinutes = 15): void {
  if (syncIntervalHandle) return;

  const intervalMs = intervalMinutes * 60 * 1000;

  syncIntervalHandle = setInterval(async () => {
    const lockId = await acquireSyncLock();
    if (!lockId) return; // another process holds the lock

    try {
      // Get all users with configured connections and RBAC space assignments
      const users = await query<{ user_id: string }>(
        `SELECT DISTINCT us.user_id FROM user_settings us
         WHERE us.confluence_url IS NOT NULL AND us.confluence_pat IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM space_role_assignments sra
             WHERE sra.principal_type = 'user' AND sra.principal_id = us.user_id::TEXT
           )`,
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
      await releaseSyncLock(lockId);
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

/**
 * Server-startup bootstrap: pre-populate the SSRF allowlist with all
 * Confluence URLs already stored in user_settings.
 *
 * This is best-effort — a database failure is logged as a warning and
 * startup continues. The ConfluenceClient constructor self-registers its
 * base URL on every sync cycle, so each sync will still work even if this
 * bootstrap query fails.
 *
 * Placed here for co-location with other Confluence credential queries;
 * it is not sync logic but startup sequence logic.
 */
export async function bootstrapSsrfAllowlist(): Promise<void> {
  try {
    const result = await query<{ confluence_url: string }>(
      'SELECT DISTINCT confluence_url FROM user_settings WHERE confluence_url IS NOT NULL',
    );
    for (const row of result.rows) {
      addAllowedBaseUrl(row.confluence_url);
    }
    logger.info({ count: result.rows.length }, 'SSRF allowlist bootstrapped from user_settings');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to bootstrap SSRF allowlist from user_settings — allowlist will be populated lazily on first sync',
    );
  }
}
