import { createHash } from 'crypto';
import { RESP_TYPES, type RedisClientType } from 'redis';
import { SUPPORTED_IMAGE_FORMATS, type ImageFormat } from '@compendiq/contracts';
import { getRedisClient } from './redis-cache.js';
import { logger } from '../utils/logger.js';

/**
 * #1154: short-lived staging for an image awaiting a generate/improve call.
 *
 * Content-addressed and scoped by user: `llm:img:<userId>:<sha256>`. The user
 * scope is what makes cross-user reference impossible, so a handle leak can't
 * expose another user's bytes and the 410/422 paths can't probe for them.
 *
 * The entry is NOT consumed on read — a regenerate or retry inside the TTL
 * should not require re-uploading. Expiry and the per-user cap below are the
 * only removal paths.
 *
 * **Memory shape matters here.** Redis is shared with BullMQ, the LLM response
 * cache, the embedding locks and the cache-bus, and is deployed with
 * `--maxmemory-policy noeviction` — a full instance rejects *writes*, which
 * takes down job enqueue application-wide. Three things keep staged images from
 * being able to do that:
 *
 *   1. Only the newest handle per user survives (`pruneOlderStagedImages`), so
 *      the ceiling is `users x MAX_IMAGE_BYTES`, not `uploads x
 *      MAX_IMAGE_BYTES`. The design commits to exactly one image per request
 *      and the composer shows a single preview, so a depth of 1 costs nothing.
 *      Two uploads racing for one user can transiently leave two entries (see
 *      the repair in `stageImage`) — bounded overshoot, not unbounded growth.
 *   2. The bytes are stored raw, not base64 inside JSON — ~25% less memory and
 *      no encode/decode/re-encode passes over up to `MAX_IMAGE_BYTES`.
 *   3. The write is pre-flighted against `INFO memory` and refused (503) when
 *      it would push the instance past `IMAGE_STAGING_MAX_REDIS_PERCENT` of
 *      `maxmemory` (#1183). (1) is a mitigation, not a bound — `users x 5 MB`
 *      still fills a 256 MB instance if enough people upload inside one TTL
 *      window — and this is what turns that from an app-wide enqueue outage
 *      into one degraded feature.
 */

export const STAGED_IMAGE_TTL_SECONDS = 900; // 15 minutes

/**
 * Refuse to stage when the write would leave Redis above this percent of its
 * `maxmemory`. The remainder is headroom for the co-tenants — BullMQ enqueue,
 * the LLM response cache, the embedding locks, the cache-bus — to keep writing
 * for the lifetime of the staged entry. 20% of the shipped 256 MB is ~51 MB,
 * far more than 15 minutes of job payloads and cache entries need.
 *
 * Applied regardless of `maxmemory_policy`: under `allkeys-lru` a full instance
 * evicts instead of refusing, but what it evicts is BullMQ's job data, which is
 * a worse outcome wearing a quieter failure mode.
 */
export const DEFAULT_MAX_REDIS_PERCENT = 80;

export class ImageStagingUnavailableError extends Error {
  constructor() {
    super('Image staging is unavailable because Redis is not reachable');
    this.name = 'ImageStagingUnavailableError';
  }
}

/**
 * Redis has no room for the image. Distinct from
 * `ImageStagingUnavailableError` (Redis is *down*) because the remedy differs:
 * this one resolves on its own as staged entries expire, and the message says
 * so rather than sending the user into an immediate retry.
 *
 * Both map to 503 — the feature degrades, the application keeps running.
 */
export class ImageStagingCapacityError extends Error {
  constructor() {
    super(
      'Image staging is temporarily unavailable: the Redis instance is near its memory limit. ' +
      `Staged images expire after ${Math.round(STAGED_IMAGE_TTL_SECONDS / 60)} minutes, so try ` +
      'again shortly — or ask an administrator to raise Redis maxmemory.',
    );
    this.name = 'ImageStagingCapacityError';
  }
}

function keyFor(userId: string, handle: string): string {
  return `llm:img:${userId}:${handle}`;
}

/**
 * Stored value layout: `<format>\n<raw image bytes>`.
 *
 * One key, one TTL, one round-trip — and the header is ASCII, so the format
 * survives without a second key or a JSON envelope wrapping `MAX_IMAGE_BYTES`
 * of base64.
 */
const FORMAT_TERMINATOR = 0x0a; // '\n'
/** Longest supported format name is 4 chars ('jpeg'/'webp'); bound the scan anyway. */
const MAX_FORMAT_HEADER_BYTES = 16;

function encodeStoredImage(bytes: Buffer, format: ImageFormat): Buffer {
  return Buffer.concat([Buffer.from(`${format}\n`, 'ascii'), bytes]);
}

/**
 * Returns null for anything that is not a well-formed stored image. A value
 * written by an older build, truncated by a crash, or clobbered by an
 * unrelated writer must read as a cache miss (410 "attach it again"), never as
 * a 500.
 */
function decodeStoredImage(stored: Buffer): { bytes: Buffer; format: ImageFormat } | null {
  const terminator = stored.indexOf(FORMAT_TERMINATOR);
  if (terminator <= 0 || terminator > MAX_FORMAT_HEADER_BYTES) return null;

  const format = stored.subarray(0, terminator).toString('ascii');
  if (!(SUPPORTED_IMAGE_FORMATS as readonly string[]).includes(format)) return null;

  // A header with nothing behind it is as unusable as no header at all — it
  // would resolve to `data:image/png;base64,` and be sent to the provider as a
  // valid-looking empty image. Treat it as the miss it is.
  const bytes = stored.subarray(terminator + 1);
  if (bytes.length === 0) return null;

  return { bytes, format: format as ImageFormat };
}

/**
 * Drop every staged image for this user except `keepKey`.
 *
 * SCAN, never KEYS — the namespace shares the instance with BullMQ and the
 * caches, and a blocking keyspace walk on every upload is its own outage.
 * Failures here are logged, not thrown: the image the user just uploaded is
 * already staged, and losing the prune is a memory problem, not a request one.
 */
async function pruneOlderStagedImages(userId: string, keepKey: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, {
        MATCH: `llm:img:${userId}:*`,
        COUNT: 100,
      });
      cursor = String(result.cursor);
      const stale = result.keys.filter((k) => k !== keepKey);
      if (stale.length > 0) await redis.del(stale);
    } while (cursor !== '0');
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to prune superseded staged images');
  }
}

/**
 * Pull `used_memory` and `maxmemory` out of an `INFO memory` reply, or null if
 * either is missing or non-numeric.
 *
 * Line-anchored on purpose: the same section carries `used_memory_rss`,
 * `maxmemory_human`, `maxmemory_clients` and `maxmemory_policy`, and a
 * substring match would happily read one of those and size the ceiling off a
 * number that means something else entirely.
 */
export function parseRedisMemory(
  info: string,
): { usedMemory: number; maxMemory: number } | null {
  const read = (field: string): number | null => {
    const match = new RegExp(`^${field}:(\\d+)`, 'm').exec(info);
    if (!match) return null;
    const value = Number.parseInt(match[1]!, 10);
    return Number.isFinite(value) ? value : null;
  };

  const usedMemory = read('used_memory');
  const maxMemory = read('maxmemory');
  if (usedMemory === null || maxMemory === null) return null;
  return { usedMemory, maxMemory };
}

/** Read per call rather than at import so a restart is not needed to retune. */
function resolveMaxRedisPercent(): number {
  const raw = process.env.IMAGE_STAGING_MAX_REDIS_PERCENT;
  if (raw === undefined || raw === '') return DEFAULT_MAX_REDIS_PERCENT;

  const percent = Number.parseInt(raw, 10);
  if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
    logger.warn(
      { raw, using: DEFAULT_MAX_REDIS_PERCENT },
      'IMAGE_STAGING_MAX_REDIS_PERCENT must be between 1 and 100; using the default',
    );
    return DEFAULT_MAX_REDIS_PERCENT;
  }
  return percent;
}

/**
 * Refuse the write when it would leave Redis above the configured share of
 * `maxmemory`.
 *
 * One `INFO memory` per upload, uncached. A short cache would save an O(1)
 * command on a path that already streams up to `MAX_IMAGE_BYTES` through
 * multipart, hashes it and SETs it — unmeasurable next to that — while a stale
 * "there is room" is exactly the overshoot this exists to prevent: every upload
 * inside the cache window would be admitted on one reading. The check is
 * already optimistic by whatever is in flight beside it; a time window
 * multiplies that.
 *
 * **Fails open, so the bound is conditional on `INFO` being readable.** `INFO`
 * is renamed or ACL-blocked on plenty of hardened and managed Redis
 * deployments, and an unreadable reply is not evidence that memory is short —
 * failing closed would 503 the feature forever on a healthy instance. Per
 * request that is cheap, because the write is its own backstop: a full
 * `noeviction` instance rejects the SET with `OOM`, which `stageImage` maps to
 * the same error. Per *deployment* it is weaker, and worth being honest about:
 * where `INFO` never answers, the ceiling never engages, staging is admitted
 * until Redis is hard-full, and `OOM` only arrives once the co-tenant headroom
 * is gone — BullMQ enqueue failing beside it. Those deployments are back to the
 * per-user cap alone and their operators have to watch `used_memory`.
 */
async function assertStagingHeadroom(
  redis: RedisClientType,
  incomingBytes: number,
): Promise<void> {
  let memory: { usedMemory: number; maxMemory: number } | null;
  try {
    memory = parseRedisMemory(String(await redis.info('memory')));
  } catch (err) {
    logger.warn({ err }, 'Could not read Redis memory before staging an image; proceeding');
    return;
  }

  if (!memory) {
    logger.warn('Redis INFO memory did not report used_memory/maxmemory; proceeding');
    return;
  }
  // 0 is Redis for "no limit" — there is no ceiling to be near the top of.
  if (memory.maxMemory === 0) return;

  const percent = resolveMaxRedisPercent();
  const ceiling = Math.floor((memory.maxMemory * percent) / 100);
  if (memory.usedMemory + incomingBytes <= ceiling) return;

  logger.warn(
    { ...memory, incomingBytes, ceiling, percent },
    'Refusing to stage an image: Redis is near its memory limit',
  );
  throw new ImageStagingCapacityError();
}

/**
 * Redis error replies lead with their code, and `OOM` is the one a `noeviction`
 * instance returns when a write would exceed `maxmemory`. Nothing was written,
 * so this is a refusal rather than a failure.
 */
function isRedisOomError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('OOM');
}

export async function stageImage(
  userId: string,
  bytes: Buffer,
  format: ImageFormat,
): Promise<string> {
  const redis = getRedisClient();
  if (!redis) throw new ImageStagingUnavailableError();

  const handle = createHash('sha256').update(bytes).digest('hex');
  const key = keyFor(userId, handle);
  const value = encodeStoredImage(bytes, format);

  // Before the write, so a full instance is never the thing this request fills.
  // Conservative by exactly this user's previous image, which the prune below
  // would have freed — worth it, because pruning first would leave a caller
  // whose write is then refused with neither the new image nor the old one.
  await assertStagingHeadroom(redis, value.length);
  try {
    await redis.set(key, value, { EX: STAGED_IMAGE_TTL_SECONDS });
  } catch (err) {
    if (isRedisOomError(err)) throw new ImageStagingCapacityError();
    throw err;
  }

  // After the write, so a prune failure can never leave the user with nothing.
  await pruneOlderStagedImages(userId, key);

  // Two uploads racing for one user each prune with a *different* `keepKey`, so
  // each can delete what the other just wrote and both handles would 410 —
  // failing the one caller who did nothing wrong. Detecting it costs one
  // EXISTS; repairing it costs one SET. Repaired unconditionally rather than in
  // a loop: the worst case is both images surviving, which overshoots the
  // depth-1 cap by exactly one entry and expires on its own.
  try {
    if (!(await redis.exists(key))) {
      logger.debug({ userId }, 'Staged image was pruned by a concurrent upload; restoring');
      await redis.set(key, value, { EX: STAGED_IMAGE_TTL_SECONDS });
    }
  } catch (err) {
    logger.warn({ err, userId }, 'Could not confirm the staged image survived pruning');
  }

  return handle;
}

/**
 * Throws `ImageStagingUnavailableError` when Redis is unreachable, so the
 * caller can answer 503 rather than 410 — telling a user to "attach it again"
 * when the store is down sends them into a retry that cannot succeed.
 * A missing or unreadable entry is a plain `null` (a genuine 410).
 */
export async function loadStagedImage(
  userId: string,
  handle: string,
): Promise<{ bytes: Buffer; format: ImageFormat } | null> {
  const redis = getRedisClient();
  if (!redis) throw new ImageStagingUnavailableError();

  // node-redis decodes blob replies as UTF-8 by default, which would mangle
  // image bytes; this asks for the raw Buffer instead.
  const stored = await redis
    .withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
    .get(keyFor(userId, handle));
  if (!stored) return null;

  if (!Buffer.isBuffer(stored)) {
    logger.warn({ userId }, 'Staged image did not decode as a Buffer; treating as a miss');
    return null;
  }

  const decoded = decodeStoredImage(stored);
  if (!decoded) {
    logger.warn({ userId }, 'Staged image value is malformed; treating as a miss');
    return null;
  }
  return decoded;
}
