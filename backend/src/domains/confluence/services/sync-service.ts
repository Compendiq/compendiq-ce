import { randomUUID } from 'node:crypto';
import { query, getPool } from '../../../core/db/postgres.js';
import {
  ConfluenceClient,
  ConfluencePage,
  ConfluenceSpace,
  ConfluenceRestriction,
  ConfluenceError,
} from './confluence-client.js';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { syncDrawioAttachments, syncImageAttachments, cleanPageAttachments, getMissingAttachments } from './attachment-handler.js';
import { saveVersionSnapshot } from '../../../core/services/version-snapshot.js';
import { processDirtyPages } from '../../llm/services/embedding-service.js';
import { getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import { logAuditEvent } from '../../../core/services/audit-service.js';
import { emitWebhookEvent } from '../../../core/services/webhook-emit-hook.js';
import { getSyncConflictPolicy } from '../../../core/services/sync-conflict-policy-service.js';
import { decryptPat } from '../../../core/utils/crypto.js';
import { addAllowedBaseUrlSilent } from '../../../core/utils/ssrf-guard.js';
import { logger } from '../../../core/utils/logger.js';
import { isFeatureEnabled } from '../../../core/enterprise/loader.js';
import { ENTERPRISE_FEATURES } from '../../../core/enterprise/features.js';
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

  // Per-run state for the per-page restriction sync (EE #112 Phase C). Shared
  // across every space/page processed in this sync run so:
  //   - the stale-ACE sweep can identify rows that weren't re-written by
  //     comparing their `synced_at` to `syncRunStartedAt`;
  //   - repeated restriction fetches against the same ancestor page (common
  //     when siblings share a parent) collapse into a single HTTP call.
  // Both are inert when `RAG_PERMISSION_ENFORCEMENT` is disabled — the
  // restriction branch short-circuits before writing to the cache or the DB.
  const syncRunStartedAt = new Date();
  const ancestorCache = new Map<string, ConfluenceRestriction[]>();

  // Sync run id (Compendiq/compendiq-ee#118). Stamped onto every
  // `pending_sync_versions` row inserted during this run so the conflict-
  // resolution UI / retention sweep can group rows by run ("the 12
  // conflicts detected during yesterday's 14:00 sync"). One UUID per
  // syncUser invocation across all spaces — a sync run is logically the
  // user's invocation, not the per-space loop.
  const syncRunId = randomUUID();

  try {
    // Fetch all spaces once to avoid redundant API calls per space
    const allSpaces = await client.getAllSpaces();
    const spacesByKey = new Map(allSpaces.map((s) => [s.key, s]));

    for (const spaceKey of spaces) {
      await syncSpace(
        client,
        userId,
        spaceKey,
        spacesByKey.get(spaceKey),
        syncRunStartedAt,
        ancestorCache,
        syncRunId,
      );
    }

    // Sweep stale Confluence-sourced ACEs for all pages that were (re-)synced
    // in this run. Rows whose `synced_at` is older than `syncRunStartedAt`
    // were not refreshed by `syncPageRestrictions`, which means either the
    // page no longer has restrictions or a principal was removed from the
    // Confluence restriction list. Either way the stale row is no longer
    // authoritative and must be removed. Admin-authored rows have
    // `source='local'` and never appear in this sweep.
    if (isFeatureEnabled(ENTERPRISE_FEATURES.RAG_PERMISSION_ENFORCEMENT)) {
      await sweepStaleConfluenceAces(syncRunStartedAt);
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

/**
 * Per-space counters for the `sync.completed` webhook event (#114).
 * Mutated in-place by `syncPage` / `detectDeletedPages` so the totals visible
 * to `emitWebhookEvent` cover every page touched in this sync run for this
 * space.
 */
interface SyncSpaceCounts {
  pagesCreated: number;
  pagesUpdated: number;
  pagesDeleted: number;
}

async function syncSpace(
  client: ConfluenceClient,
  userId: string,
  spaceKey: string,
  space: ConfluenceSpace | undefined,
  syncRunStartedAt: Date,
  ancestorCache: Map<string, ConfluenceRestriction[]>,
  syncRunId: string,
): Promise<void> {
  const spaceStartedAt = Date.now();
  const counts: SyncSpaceCounts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };

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

    const page = pages[i]!;
    await syncPage(client, userId, spaceKey, page, syncRunStartedAt, ancestorCache, counts, syncRunId);
  }

  // During incremental sync, also check for pages with missing attachments
  // that weren't in the modified list. This catches pages whose content
  // was synced previously but attachment downloads failed.
  if (lastSynced && (Date.now() - lastSynced.getTime()) < 24 * 60 * 60 * 1000) {
    await syncMissingAttachments(client, userId, spaceKey);
  }

  // Detect deleted pages (only during full sync)
  if (!lastSynced || (Date.now() - lastSynced.getTime()) >= 24 * 60 * 60 * 1000) {
    await detectDeletedPages(client, spaceKey, pages, counts);
  }

  // Purge pages that have been soft-deleted for more than 30 days
  await purgeDeletedPages(spaceKey);

  // Update space sync timestamp (shared table)
  await query(
    'UPDATE spaces SET last_synced = NOW() WHERE space_key = $1',
    [spaceKey],
  );

  // Emit sync.completed webhook for this space (#114). Aggregate counters
  // mean receivers don't need per-page page.created/updated/deleted from
  // sync (those would double-fire alongside this event).
  emitWebhookEvent({
    eventType: 'sync.completed',
    payload: {
      spaceKey,
      pagesCreated: counts.pagesCreated,
      pagesUpdated: counts.pagesUpdated,
      pagesDeleted: counts.pagesDeleted,
      durationMs: Date.now() - spaceStartedAt,
      completedAt: new Date().toISOString(),
    },
  });
}

async function syncPage(
  client: ConfluenceClient,
  userId: string,
  spaceKey: string,
  pageSummary: ConfluencePage,
  syncRunStartedAt: Date,
  ancestorCache: Map<string, ConfluenceRestriction[]>,
  counts: SyncSpaceCounts,
  syncRunId: string,
): Promise<void> {
  // Fetch full page content
  const page = await client.getPage(pageSummary.id);
  const bodyStorage = page.body?.storage?.value ?? '';

  // Convert to HTML
  const bodyHtml = confluenceToHtml(bodyStorage, page.id, spaceKey);
  const bodyText = htmlToText(bodyHtml);

  // Extract metadata
  const labels = page.metadata?.labels?.results?.map((l) => l.name) ?? [];
  const parentId = page.ancestors?.length ? page.ancestors[page.ancestors.length - 1]!.id : null;
  const author = page.version?.by?.displayName ?? null;
  const lastModified = page.version?.when ? new Date(page.version.when) : new Date();

  // Check if page exists and has changed (shared table, no user_id).
  //
  // SELECT-list extended (Compendiq/compendiq-ee#118) to also fetch
  // `local_modified_at` (CE #305) + `last_synced` so the conflict-detection
  // branch below can decide whether a Confluence version delta is actually
  // a conflict (local edits exist) or a routine inbound update (no local
  // edits, just a remote change to apply).
  //
  // Lost-update fix (Compendiq/compendiq-ee#118 reviewer finding): the
  // SELECT used to be a bare read; a second concurrent `syncPage` call on
  // the same Confluence page (e.g. two pods running the sync scheduler at
  // the same time for users with overlapping spaces, or a manual sync
  // racing the scheduler) could each read the same `version` /
  // `local_modified_at`, each decide independently to apply the
  // policy-driven UPDATE, and clobber each other's writes. We close the
  // race by reading the row with a row-level lock inside a transaction:
  // the second concurrent caller blocks on `FOR UPDATE` until the first
  // commits — its subsequent SELECT then sees the post-write state
  // (incremented version, cleared `local_modified_at`) and either
  // short-circuits the htmlChanged comparison or queues a fresh
  // pending_sync_versions row reflecting the post-merge truth.
  //
  // The full htmlChanged-path UPDATE / pending-version INSERT runs inside
  // this transaction. Subsequent post-commit work (attachment download,
  // restriction sync) runs unlocked — those are HTTP calls and we don't
  // want to hold the row lock for the duration.
  const existing = await query<{
    version: number;
    title: string;
    body_html: string;
    body_text: string;
    local_modified_at: Date | null;
    last_synced: Date | null;
  }>(
    `SELECT version, title, body_html, body_text, local_modified_at, last_synced
       FROM pages
      WHERE confluence_id = $1`,
    [page.id],
  );

  if (existing.rows.length > 0 && existing.rows[0]!.version >= page.version.number) {
    const existingRow = existing.rows[0]!;
    const htmlChanged = existingRow.body_html !== bodyHtml || existingRow.body_text !== bodyText;

    // Page content hasn't changed, but check if all expected attachments are cached.
    // Previous syncs may have failed to download some/all attachments (transient errors).
    // Compare expected filenames (from XHTML) against files on disk, per-file.
    const missing = await getMissingAttachments(userId, page.id, bodyStorage, spaceKey);
    if (missing.length === 0 && !htmlChanged) {
      // Content + attachments both fully up to date. Still re-evaluate the
      // Confluence-side view restrictions: they can change independently of
      // page content (an admin adds/removes a user from the read list
      // without editing the page), and the conditional-fetch optimization
      // from the plan is not wired (see §1.4 TODO below). `syncPageRestrictions`
      // is a no-op when the feature flag is disabled, so CE builds pay zero
      // extra cost here.
      await syncPageRestrictions(client, page, syncRunStartedAt, ancestorCache);
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
      await applyConflictPolicyForExistingPage({
        confluenceId: page.id,
        confluenceVersion: page.version.number,
        pageDbTitle: page.title,
        bodyStorage,
        bodyHtml,
        bodyText,
        parentId,
        labels,
        author,
        lastModified,
        syncRunId,
        counts,
      });
    }

    // Version-unchanged branch: still re-evaluate restrictions. See note at
    // the earlier early-return above. Safe/cheap because `syncPageRestrictions`
    // short-circuits on the feature flag.
    await syncPageRestrictions(client, page, syncRunStartedAt, ancestorCache);
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
      existing.rows[0]!.version,
      existing.rows[0]!.title,
      existing.rows[0]!.body_html,
      existing.rows[0]!.body_text,
    );
  }

  // Upsert page (shared table, no user_id)
  // deleted_at = NULL restores pages that were previously soft-deleted
  // (e.g. page was restored from Confluence trash)
  const wasFreshCreate = existing.rows.length === 0;
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
       summary_status = 'pending',
       -- Clear local-edit markers (#305) — see matching note in the
       -- version-mismatch branch above.
       local_modified_at = NULL,
       local_modified_by = NULL,
       deleted_at = NULL`,
    [page.id, spaceKey, page.title, bodyStorage, bodyHtml, bodyText,
     page.version.number, parentId, labels, author, lastModified],
  );
  if (wasFreshCreate) {
    counts.pagesCreated++;
  } else {
    counts.pagesUpdated++;
  }

  // Sync Confluence view restrictions → access_control_entries. Runs after
  // the page upsert so `pages.id` is guaranteed to exist (the ACE foreign
  // key on `resource_id` points at that SERIAL). No-op when the
  // `RAG_PERMISSION_ENFORCEMENT` feature flag is off.
  await syncPageRestrictions(client, page, syncRunStartedAt, ancestorCache);
}

// ─────────────────────────────────────────────────────────────────────────
//  Conflict-detection branch (Compendiq/compendiq-ee#118)
// ─────────────────────────────────────────────────────────────────────────

interface ApplyConflictPolicyArgs {
  confluenceId: string;
  /** Incoming Confluence version (`page.version.number`) — recorded on
   *  the queued pending-version row so the resolution UI knows which
   *  upstream version the stashed content reflects. */
  confluenceVersion: number;
  pageDbTitle: string;
  bodyStorage: string;
  bodyHtml: string;
  bodyText: string;
  parentId: string | null;
  labels: string[];
  author: string | null;
  lastModified: Date;
  syncRunId: string;
  counts: SyncSpaceCounts;
}

/**
 * Apply the active sync-conflict policy to a single page where the
 * Confluence-side body has diverged from the local body.
 *
 * Runs inside a single transaction with `SELECT … FOR UPDATE` on the
 * target page row, which closes the lost-update race the EE #118 reviewer
 * flagged: two concurrent `syncPage` calls on the same page would
 * otherwise both read the same `local_modified_at` snapshot, both decide
 * (independently) to overwrite the local row, and the second commit
 * silently clobbers the first (or vice-versa). With `FOR UPDATE`, the
 * second caller blocks until the first commits and then sees the
 * post-write state — its conflict check now reflects the resolved row
 * and either short-circuits (htmlChanged false post-write) or queues a
 * fresh pending_sync_versions row reflecting the new truth.
 *
 * Three policy branches:
 *   - 'confluence-wins' (default): apply the incoming Confluence content
 *     to the live row, exactly as before #118. If `local_modified_at >
 *     last_synced` we additionally emit `SYNC_OVERWROTE_LOCAL_EDITS` so
 *     the audit trail records that we discarded an unpublished local
 *     edit. No event when there were no local edits — that path is
 *     simply "routine inbound sync."
 *   - 'compendiq-wins': skip the inbound write, leaving the local row
 *     intact. If `local_modified_at > last_synced` we emit
 *     `SYNC_CONFLICT_DETECTED` with `{ resolution: 'kept_local' }`. If
 *     there were no local edits we transparently fall through to
 *     confluence-wins behaviour — there's nothing local to preserve, so
 *     the incoming change should land.
 *   - 'manual-review': only kicks in when `local_modified_at >
 *     last_synced`. Inserts the full incoming Confluence content into
 *     `pending_sync_versions`, flips `pages.conflict_pending = TRUE`,
 *     stamps `pages.conflict_detected_at = NOW()`, and emits
 *     `SYNC_CONFLICT_DETECTED`. The live row stays unchanged. When there
 *     are no local edits we again fall through to confluence-wins so the
 *     queue isn't padded with non-conflicts.
 *
 * Test coverage lives in `sync-service-conflicts.integration.test.ts`.
 */
async function applyConflictPolicyForExistingPage(
  args: ApplyConflictPolicyArgs,
): Promise<void> {
  const policy = getSyncConflictPolicy();

  const pool = getPool();
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');

    // Re-read the row inside the lock. The outer SELECT (in `syncPage`)
    // was unlocked because we couldn't know yet whether to take the lock
    // — taking it on every page would serialise the entire sync against
    // every other write to `pages` (editor saves, AI write-backs).
    // Locking only when we've established htmlChanged keeps the lock
    // window tight: we hold it for one SELECT + one UPDATE / INSERT.
    const locked = await conn.query<{
      id: number;
      version: number;
      body_html: string;
      body_text: string;
      local_modified_at: Date | null;
      last_synced: Date | null;
    }>(
      `SELECT id, version, body_html, body_text, local_modified_at, last_synced
         FROM pages
        WHERE confluence_id = $1
        FOR UPDATE`,
      [args.confluenceId],
    );

    if (locked.rows.length === 0) {
      // Page disappeared between the outer SELECT and the lock acquisition
      // (e.g. a concurrent DELETE or hard purge). Nothing to do.
      await conn.query('COMMIT');
      return;
    }

    const row = locked.rows[0]!;

    // Re-test htmlChanged inside the lock. A concurrent syncPage on the
    // same page may have already applied the incoming version; in that
    // case our outer-SELECT snapshot is stale and the work is done.
    const htmlChangedNow =
      row.body_html !== args.bodyHtml || row.body_text !== args.bodyText;
    if (!htmlChangedNow) {
      await conn.query('COMMIT');
      return;
    }

    const hasLocalEdits =
      row.local_modified_at !== null
      && row.last_synced !== null
      && row.local_modified_at.getTime() > row.last_synced.getTime();

    // Three-way branch on policy.
    if (policy === 'manual-review' && hasLocalEdits) {
      // Stash the Confluence version, do NOT touch the live row. The
      // admin resolves via the EE conflicts UI (`/api/admin/sync-
      // conflicts/:id/resolve`). pending_sync_versions has no UNIQUE
      // constraint on (page_id, confluence_version) so multiple inbound
      // versions stack up if the admin is slow to react — the resolver
      // takes the most-recent row and discards older queued ones.
      await conn.query(
        `INSERT INTO pending_sync_versions
           (page_id, confluence_version, body_storage, body_html, body_text, sync_run_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          row.id,
          args.confluenceVersion,
          args.bodyStorage,
          args.bodyHtml,
          args.bodyText,
          args.syncRunId,
        ],
      );
      await conn.query(
        `UPDATE pages
            SET conflict_pending = TRUE,
                conflict_detected_at = NOW()
          WHERE id = $1`,
        [row.id],
      );
      await conn.query('COMMIT');

      // Fire-and-forget audit. logAuditEvent is fire-and-forget by design
      // (it never throws) so the caller doesn't need to await it inside
      // the lock window — but doing the await OUTSIDE the transaction
      // means the audit row hits the audit_log on its own connection,
      // independent of our transaction's commit/abort. That's the right
      // semantic: the conflict was detected, full stop, regardless of
      // any later step.
      await logAuditEvent(
        null,
        'SYNC_CONFLICT_DETECTED',
        'page',
        String(row.id),
        {
          confluence_id: args.confluenceId,
          policy,
          resolution: 'queued_for_review',
          sync_run_id: args.syncRunId,
        },
      );
      return;
    }

    if (policy === 'compendiq-wins' && hasLocalEdits) {
      // Keep the local row, do NOT apply the incoming Confluence content.
      // No DB write — the COMMIT just closes the lock cleanly.
      await conn.query('COMMIT');

      await logAuditEvent(
        null,
        'SYNC_CONFLICT_DETECTED',
        'page',
        String(row.id),
        {
          confluence_id: args.confluenceId,
          policy,
          resolution: 'kept_local',
          sync_run_id: args.syncRunId,
        },
      );
      return;
    }

    // Default (confluence-wins, OR a non-default policy with no local
    // edits to preserve). Apply the incoming Confluence content, then
    // emit `SYNC_OVERWROTE_LOCAL_EDITS` only when we actually overwrote
    // a local edit — the no-local-edits path is routine sync, not a
    // conflict, and would be log-noise if every inbound update audited.
    await conn.query(
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
           END,
           -- Clear local-edit markers (#305): the page is now back in
           -- sync with the upstream Confluence version. The BEFORE
           -- UPDATE trigger on pages only stamps when the caller leaves
           -- local_modified_by non-null or local_modified_at unchanged;
           -- setting both to NULL here suppresses the stamp.
           local_modified_at = NULL,
           local_modified_by = NULL,
           deleted_at = NULL
       WHERE confluence_id = $1`,
      [
        args.confluenceId,
        args.pageDbTitle,
        args.bodyStorage,
        args.bodyHtml,
        args.bodyText,
        args.parentId,
        args.labels,
        args.author,
        args.lastModified,
      ],
    );
    await conn.query('COMMIT');
    args.counts.pagesUpdated++;

    if (hasLocalEdits) {
      await logAuditEvent(
        null,
        'SYNC_OVERWROTE_LOCAL_EDITS',
        'page',
        String(row.id),
        {
          confluence_id: args.confluenceId,
          policy,
          local_modified_at: row.local_modified_at?.toISOString() ?? null,
          last_synced: row.last_synced?.toISOString() ?? null,
          sync_run_id: args.syncRunId,
        },
      );
    }
  } catch (err) {
    try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Per-page restriction sync (EE #112 Phase C)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compute the effective `read` restriction for a Confluence page.
 *
 * Confluence view restrictions are inherited DOWN the ancestor chain (unlike
 * edit restrictions). A page's OWN `read` restriction overrides anything
 * inherited; only when the page has no own read restriction do we walk its
 * ancestors nearest-first and use the first non-empty read restriction we
 * find. Returns `null` when nothing in the chain is restricted — i.e. the
 * page is effectively public.
 *
 * `ancestorCache` is shared across the whole sync run so siblings that share
 * a parent only fetch that parent's restrictions once.
 */
async function computeEffectivePageReadRestrictions(
  page: ConfluencePage,
  client: ConfluenceClient,
  ancestorCache: Map<string, ConfluenceRestriction[]>,
): Promise<{
  users: Array<{ userKey: string; username: string }>;
  groups: Array<{ name: string }>;
  inheritedFromAncestor: string | null;
} | null> {
  const own = await client.getPageRestrictions(page.id);
  const ownRead = own.find((r) => r.operation === 'read');
  if (
    ownRead &&
    ownRead.restrictions.users.length + ownRead.restrictions.groups.length > 0
  ) {
    return {
      users: ownRead.restrictions.users.map((u) => ({ userKey: u.userKey, username: u.username })),
      groups: ownRead.restrictions.groups.map((g) => ({ name: g.name })),
      inheritedFromAncestor: null,
    };
  }

  // No own restriction — walk ancestors nearest-first. Confluence returns
  // ancestors root-first, so reverse to put the immediate parent at index 0.
  const ancestors = await client.getPageAncestors(page.id);
  for (const a of [...ancestors].reverse()) {
    let arestr = ancestorCache.get(a.id);
    if (!arestr) {
      arestr = await client.getPageRestrictions(a.id);
      ancestorCache.set(a.id, arestr);
    }
    const aread = arestr.find((r) => r.operation === 'read');
    if (aread && aread.restrictions.users.length + aread.restrictions.groups.length > 0) {
      return {
        users: aread.restrictions.users.map((u) => ({ userKey: u.userKey, username: u.username })),
        groups: aread.restrictions.groups.map((g) => ({ name: g.name })),
        inheritedFromAncestor: a.id,
      };
    }
  }

  return null;
}

/**
 * Mirror the effective Confluence read restriction for a single page into
 * `access_control_entries`. Gated by the `RAG_PERMISSION_ENFORCEMENT` feature
 * flag — CE builds and un-licensed EE builds skip the fetch and the DB write
 * entirely (preserves v0.3 behaviour exactly).
 *
 * Behaviour:
 *  - Effective restriction is null (no own restriction, no restricted
 *    ancestor): set `pages.inherit_perms = TRUE` and write no ACEs. The
 *    stale-sweep at the end of `syncUser` removes any leftover ACEs from a
 *    prior run.
 *  - Effective restriction is non-null: resolve each userKey/group name to
 *    Compendiq `users.id` / `groups.id`. Unmapped principals are SKIPPED and
 *    audited as `ACE_SYNC_SKIPPED_UNMAPPED_USER` — NOT persisted, because
 *    creating an ACE for an unknown principal would grant access to nobody
 *    (safer default: implicitly deny by omission). UPSERT each resolved
 *    principal and bump `synced_at` so the sweep preserves it. Set
 *    `pages.inherit_perms = FALSE` so `userCanAccessPage()` consults the
 *    page-level ACEs instead of the space-level roles.
 *
 * TODO(EE #112 Phase C): the plan's §1.4 conditional-fetch optimization
 * ("skip when `pages.metadata.restrictions.updated` hasn't changed since
 * `pages.last_synced`") is not wired. The `ConfluencePage` type in
 * `confluence-client.ts` does not expose the `metadata.restrictions.updated`
 * timestamp, and adding it requires changing both the type and the
 * `expand=` query string used by `getPage` / `getAllPagesInSpace` /
 * `getModifiedPages`. Out of scope for Phase C (the brief explicitly
 * forbids touching `confluence-client.ts`). Effect: one extra
 * `getPageRestrictions` call per page per sync run, plus potentially one
 * per ancestor. Bounded by the 60 RPM rate limiter and collapsed by the
 * `ancestorCache`; acceptable for v0.4, flagged here for the follow-up.
 *
 * On a `ConfluenceError` from `getPageRestrictions` / `getPageAncestors` we
 * log + continue — the sync run completes, this page's ACEs just aren't
 * written this round and the stale-sweep leaves any pre-existing ACEs
 * alone (their `synced_at` hasn't been bumped but hasn't been aged out
 * either — they stay authoritative until a later successful sync rewrites
 * them). Non-ConfluenceError exceptions propagate; they indicate a bug or
 * DB outage the caller must see.
 */
async function syncPageRestrictions(
  client: ConfluenceClient,
  page: ConfluencePage,
  syncRunStartedAt: Date,
  ancestorCache: Map<string, ConfluenceRestriction[]>,
): Promise<void> {
  if (!isFeatureEnabled(ENTERPRISE_FEATURES.RAG_PERMISSION_ENFORCEMENT)) {
    return;
  }

  // Resolve the INTEGER `pages.id` for this Confluence page. The INSERT/
  // UPDATE paths in `syncPage` run before this call so the row is
  // guaranteed to exist. A missing row means the INSERT silently failed
  // upstream — log and bail rather than plough on with a bogus resource_id.
  const pageRow = await query<{ id: number }>(
    `SELECT id FROM pages WHERE confluence_id = $1`,
    [page.id],
  );
  if (pageRow.rows.length === 0) {
    logger.warn(
      { confluenceId: page.id },
      'Page restriction sync: pages row not found after upsert — skipping',
    );
    return;
  }
  const pageDbId = pageRow.rows[0]!.id;

  let effective: Awaited<ReturnType<typeof computeEffectivePageReadRestrictions>>;
  try {
    effective = await computeEffectivePageReadRestrictions(page, client, ancestorCache);
  } catch (err) {
    if (err instanceof ConfluenceError) {
      logger.warn(
        {
          err: err.message,
          statusCode: err.statusCode,
          confluenceId: page.id,
          pageDbId,
        },
        'Failed to fetch Confluence restrictions for page — skipping this round; pre-existing ACEs untouched',
      );
      return;
    }
    throw err;
  }

  if (effective === null) {
    // Page is effectively public: no own restriction, no ancestor
    // restriction. Flip `inherit_perms` back to TRUE — `userCanAccessPage`
    // will fall through to the space-level role check. No ACE writes; the
    // end-of-run sweep cleans up any leftover rows from a prior sync.
    await query(`UPDATE pages SET inherit_perms = TRUE WHERE id = $1`, [pageDbId]);
    return;
  }

  // Resolve principals → compendiq IDs. Unmapped = skip with audit; do NOT
  // write an ACE for a userKey/username that doesn't correspond to a
  // Compendiq user. Doing so would either fail the FK check or — worse —
  // silently grant access to nobody (UUID mismatch).
  const resolvedUsers: string[] = [];
  for (const u of effective.users) {
    const uid = await resolveConfluenceUser(u.userKey, u.username);
    if (uid === null) {
      await logAuditEvent(null, 'ACE_SYNC_SKIPPED_UNMAPPED_USER', 'page', String(pageDbId), {
        userKey: u.userKey,
        username: u.username,
        pageId: pageDbId,
        pageConfluenceId: page.id,
      });
      continue;
    }
    resolvedUsers.push(uid);
  }

  const resolvedGroups: number[] = [];
  for (const g of effective.groups) {
    const gid = await resolveConfluenceGroup(g.name);
    if (gid === null) {
      await logAuditEvent(null, 'ACE_SYNC_SKIPPED_UNMAPPED_USER', 'page', String(pageDbId), {
        groupName: g.name,
        pageId: pageDbId,
        pageConfluenceId: page.id,
      });
      continue;
    }
    resolvedGroups.push(gid);
  }

  // Open a short transaction so a crash mid-resolve doesn't leave a
  // half-written ACE set visible to the RAG post-filter. Both principal
  // tables (users, groups) are read-only here; the only writes are against
  // `access_control_entries` and `pages.inherit_perms`.
  const pool = getPool();
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    for (const uid of resolvedUsers) {
      await dbClient.query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id,
            permission, source, synced_at)
         VALUES ('page', $1, 'user', $2, 'read', 'confluence', $3)
         ON CONFLICT (resource_type, resource_id, principal_type,
                      principal_id, permission)
         DO UPDATE SET synced_at = EXCLUDED.synced_at,
                       source = EXCLUDED.source`,
        [pageDbId, uid, syncRunStartedAt],
      );
    }
    for (const gid of resolvedGroups) {
      await dbClient.query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id,
            permission, source, synced_at)
         VALUES ('page', $1, 'group', $2, 'read', 'confluence', $3)
         ON CONFLICT (resource_type, resource_id, principal_type,
                      principal_id, permission)
         DO UPDATE SET synced_at = EXCLUDED.synced_at,
                       source = EXCLUDED.source`,
        [pageDbId, String(gid), syncRunStartedAt],
      );
    }
    await dbClient.query(
      `UPDATE pages SET inherit_perms = FALSE WHERE id = $1`,
      [pageDbId],
    );
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {
      /* rollback failures are not actionable; original error already surfacing */
    });
    throw err;
  } finally {
    dbClient.release();
  }

  await logAuditEvent(null, 'ACE_SYNCED', 'page', String(pageDbId), {
    pageId: pageDbId,
    pageConfluenceId: page.id,
    userCount: resolvedUsers.length,
    groupCount: resolvedGroups.length,
    inheritedFromAncestor: effective.inheritedFromAncestor,
  });
}

/**
 * Resolve a Confluence userKey/username pair to a Compendiq `users.id`.
 *
 * Compendiq has no dedicated `confluence_user_key` column; the closest
 * invariant is `users.username`, which matches the Confluence username used
 * for PAT issuance and — for OIDC-provisioned users — the OIDC `preferred_username`.
 * Returns `null` when no user matches (callers skip + emit
 * `ACE_SYNC_SKIPPED_UNMAPPED_USER`).
 */
async function resolveConfluenceUser(
  _userKey: string,
  username: string,
): Promise<string | null> {
  const res = await query<{ id: string }>(
    `SELECT id FROM users WHERE username = $1`,
    [username],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * Resolve a Confluence group name to a Compendiq `groups.id` (SERIAL). The
 * `groups.name` column is UNIQUE. Returns `null` when no group matches.
 */
async function resolveConfluenceGroup(name: string): Promise<number | null> {
  const res = await query<{ id: number }>(
    `SELECT id FROM groups WHERE name = $1`,
    [name],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * Delete Confluence-sourced ACEs that weren't refreshed by this sync run.
 *
 * "Page no longer restricted" AND "a specific principal was removed from a
 * restriction list" collapse to the same condition: their ACE's `synced_at`
 * stays behind `syncRunStartedAt` because nothing re-UPSERTed them. The
 * partial index on `(source, synced_at) WHERE source = 'confluence'` keeps
 * this scan O(stale rows) regardless of how many admin-authored ACEs
 * exist. Runs once at the end of `syncUser`, outside any per-page
 * transaction, so a partial sync doesn't wipe ACEs for pages we never got
 * to.
 */
async function sweepStaleConfluenceAces(syncRunStartedAt: Date): Promise<void> {
  const res = await query(
    `DELETE FROM access_control_entries
     WHERE resource_type = 'page'
       AND source = 'confluence'
       AND (synced_at IS NULL OR synced_at < $1)`,
    [syncRunStartedAt],
  );
  if (res.rowCount && res.rowCount > 0) {
    logger.info(
      { deleted: res.rowCount, cutoff: syncRunStartedAt.toISOString() },
      'Stale Confluence ACEs swept',
    );
  }
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
  counts: SyncSpaceCounts,
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

  // Query shared table by space_key only (exclude already soft-deleted pages)
  const existingResult = await query<{ confluence_id: string }>(
    'SELECT confluence_id FROM pages WHERE space_key = $1 AND deleted_at IS NULL',
    [spaceKey],
  );

  for (const { confluence_id } of existingResult.rows) {
    if (!currentIds.has(confluence_id)) {
      logger.info({ spaceKey, confluenceId: confluence_id }, 'Soft-deleting stale page');
      await query(
        'UPDATE pages SET deleted_at = NOW() WHERE confluence_id = $1 AND deleted_at IS NULL',
        [confluence_id],
      );
      await cleanPageAttachments('', confluence_id);
      await clearPageFailures(confluence_id);
      counts.pagesDeleted++;
    }
  }
}

/**
 * Permanently remove pages that were soft-deleted more than 30 days ago.
 * page_embeddings are removed by CASCADE on the pages table FK.
 */
async function purgeDeletedPages(spaceKey: string): Promise<void> {
  const result = await query<{ confluence_id: string }>(
    `DELETE FROM pages WHERE space_key = $1 AND deleted_at < NOW() - INTERVAL '30 days' RETURNING confluence_id`,
    [spaceKey],
  );
  if (result.rowCount && result.rowCount > 0) {
    for (const { confluence_id } of result.rows) {
      await cleanPageAttachments('', confluence_id);
      await clearPageFailures(confluence_id);
    }
    logger.info({ spaceKey, purged: result.rowCount }, 'Purged expired soft-deleted pages');
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
 * Run a single scheduled sync cycle across all users.
 * Extracted from the setInterval callback for use by BullMQ workers.
 * Returns the number of users synced.
 */
export async function runScheduledSync(): Promise<number> {
  const lockId = await acquireSyncLock();
  if (!lockId) return 0;

  try {
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
    return users.rows.length;
  } catch (err) {
    logger.error({ err }, 'Background sync worker error');
    return 0;
  } finally {
    await releaseSyncLock(lockId);
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
      // Silent variant: bootstrap on every pod is expected; re-broadcasting
      // N add events on every startup would just be noise.
      addAllowedBaseUrlSilent(row.confluence_url);
    }
    logger.info({ count: result.rows.length }, 'SSRF allowlist bootstrapped from user_settings');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to bootstrap SSRF allowlist from user_settings — allowlist will be populated lazily on first sync',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Test-only exports (EE #112 Phase C)
// ─────────────────────────────────────────────────────────────────────────
// These helpers stay private to the module for production callers — they
// are only invoked indirectly via `syncUser`/`syncPage`. The integration
// test file reaches into them directly so the test matrix (inheritance,
// ancestor cache, stale sweep, unmapped principals) can exercise each
// branch without spinning up an entire Confluence sync harness.
export const __internal = {
  syncPageRestrictions,
  sweepStaleConfluenceAces,
  computeEffectivePageReadRestrictions,
  // Exposed for the EE #118 conflict-detection integration tests so the
  // policy branches can be exercised directly against a real Postgres
  // (with the real `pending_sync_versions` table, the real `pages`
  // trigger from #305, and the real `FOR UPDATE` lock semantic) without
  // having to stub a Confluence client + attachment handler + version-
  // snapshot writer just to reach this branch via syncUser.
  applyConflictPolicyForExistingPage,
};
