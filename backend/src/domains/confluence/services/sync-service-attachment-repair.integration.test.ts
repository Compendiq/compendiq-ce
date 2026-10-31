/**
 * Integration tests for the routine missing-attachment repair pass
 * (`syncMissingAttachments`, #1799).
 *
 * The repair discovery query must only select live pages (soft-delete
 * invariant: `deleted_at IS NULL`) so trashed rows cost zero Confluence
 * attachment-list requests and zero error logs per cycle, while a page whose
 * soft-delete is cleared (revival cross-check) is discovered again. A thrown
 * attachment-list request must also advance the per-filename Redis retry
 * counter so a permanently failing page stops being retried.
 *
 * Real PostgreSQL + real Redis; only the ConfluenceClient is faked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  setRedisClient,
  getAttachmentFailureCount,
  clearAttachmentFailures,
} from '../../../core/services/redis-cache.js';
import { logger } from '../../../core/utils/logger.js';
import { getExpectedAttachmentFilenames } from './attachment-handler.js';

const { __internal } = await import('./sync-service.js');
const { syncMissingAttachments, detectDeletedPages } = __internal;

const dbAvailable = await isDbAvailable();

async function connectRedis(): Promise<RedisClientType | null> {
  try {
    const client = createClient({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    }) as RedisClientType;
    client.on('error', () => undefined);
    await client.connect();
    return client;
  } catch {
    return null;
  }
}
const redis = dbAvailable ? await connectRedis() : null;

const BODY = '<p><ac:image><ri:attachment ri:filename="pic.png" /></ac:image></p>';

async function insertPage(confluenceId: string, spaceKey: string): Promise<void> {
  await query(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                         body_storage, body_html, inherit_perms)
     VALUES ($1, 'confluence', $2, $3, 'text', $4, '', TRUE)`,
    [confluenceId, spaceKey, `Page ${confluenceId}`, BODY],
  );
}

function makeClient(opts: { failListing?: boolean } = {}) {
  const attachmentListCalls: string[] = [];
  return {
    attachmentListCalls,
    async getPageAttachments(id: string): Promise<{ results: unknown[] }> {
      attachmentListCalls.push(id);
      if (opts.failListing) throw new Error('attachment listing boom');
      return { results: [] };
    },
    async getAllPageIds(): Promise<Set<string>> {
      return new Set(['live-1', 'trashed-1']);
    },
    async getPage(id: string): Promise<unknown> {
      return { id, status: 'current' };
    },
  };
}

describe.skipIf(!dbAvailable)('sync-service missing-attachment repair (#1799)', () => {
  let attachmentsDir: string;
  let previousDir: string | undefined;

  beforeAll(async () => {
    await setupTestDb();
    setRedisClient(redis);
  });
  afterAll(async () => {
    setRedisClient(null);
    if (redis?.isOpen) await redis.quit();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    previousDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-repair-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousDir;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
  });

  it('repairs live pages only: trashed rows cause no attachment-list request and no error log; a restored page is discovered again', async () => {
    await insertPage('live-1', 'DEV');
    await insertPage('trashed-1', 'DEV');
    await query(
      `UPDATE pages SET deleted_at = NOW() - INTERVAL '1 day' WHERE confluence_id = 'trashed-1'`,
    );
    const errorSpy = vi.spyOn(logger, 'error');

    const client = makeClient();
    await syncMissingAttachments(client as never, 'user-1', 'DEV');

    expect(client.attachmentListCalls).toEqual(['live-1']);
    expect(errorSpy).not.toHaveBeenCalled();

    // Revival cross-check: trashed-1 is live upstream again → soft-delete cleared.
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };
    await detectDeletedPages(client as never, 'DEV', counts);
    const restored = await query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE confluence_id = 'trashed-1'`,
    );
    expect(restored.rows[0]!.deleted_at).toBeNull();

    client.attachmentListCalls.length = 0;
    await syncMissingAttachments(client as never, 'user-1', 'DEV');
    expect(client.attachmentListCalls.sort()).toEqual(['live-1', 'trashed-1']);
  });

  it.skipIf(!redis)('a thrown attachment-list request advances the per-filename Redis retry counter', async () => {
    await insertPage('live-1', 'DEV');
    const [filename] = getExpectedAttachmentFilenames(BODY, 'DEV');
    expect(filename).toBeDefined();
    await clearAttachmentFailures(redis, 'live-1');
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    try {
      expect(await getAttachmentFailureCount(redis, 'live-1', filename!)).toBe(0);
      await syncMissingAttachments(makeClient({ failListing: true }) as never, 'user-1', 'DEV');
      expect(await getAttachmentFailureCount(redis, 'live-1', filename!)).toBe(1);
      await syncMissingAttachments(makeClient({ failListing: true }) as never, 'user-1', 'DEV');
      expect(await getAttachmentFailureCount(redis, 'live-1', filename!)).toBe(2);
    } finally {
      await clearAttachmentFailures(redis, 'live-1');
    }
  });
});
