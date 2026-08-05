import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The store holds Buffers, matching what a real node-redis client returns once
 * `withTypeMapping({ [BLOB_STRING]: Buffer })` is applied. A test double that
 * kept strings would hide exactly the mangling that mapping exists to prevent.
 */
const store = new Map<string, Buffer>();

const MAXMEMORY_256MB = 256 * 1024 * 1024;

/**
 * A realistic `INFO memory` reply. The decoy lines are the point: `maxmemory`
 * shares its prefix with `maxmemory_human`, `maxmemory_policy` and
 * `maxmemory_clients`, and `used_memory` with `used_memory_rss` — a substring
 * match would read the wrong number and silently mis-size the ceiling.
 */
function memoryInfo({ used, max }: { used: number; max: number }): string {
  return [
    '# Memory',
    `used_memory:${used}`,
    'used_memory_human:1.00M',
    `used_memory_rss:${used * 3}`,
    `maxmemory:${max}`,
    'maxmemory_human:256.00M',
    'maxmemory_clients:0',
    'maxmemory_policy:noeviction',
    '',
  ].join('\r\n');
}

let infoReply = memoryInfo({ used: 1024 * 1024, max: MAXMEMORY_256MB });

const mockRedis = {
  set: vi.fn(async (k: string, v: Buffer) => { store.set(k, v); return 'OK'; }),
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  del: vi.fn(async (keys: string[]) => {
    for (const k of keys) store.delete(k);
    return keys.length;
  }),
  scan: vi.fn(async (_cursor: string, opts: { MATCH: string }) => {
    const prefix = opts.MATCH.replace(/\*$/, '');
    return { cursor: 0, keys: [...store.keys()].filter((k) => k.startsWith(prefix)) };
  }),
  exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
  info: vi.fn(async (_section: string) => infoReply),
  withTypeMapping: vi.fn(() => mockRedis),
};
let redisAvailable = true;

vi.mock('./redis-cache.js', () => ({
  getRedisClient: () => (redisAvailable ? mockRedis : null),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  stageImage,
  loadStagedImage,
  parseRedisMemory,
  STAGED_IMAGE_TTL_SECONDS,
  DEFAULT_MAX_REDIS_PERCENT,
  ImageStagingUnavailableError,
  ImageStagingCapacityError,
} from './image-staging.js';
import { buildPng } from './test-image-fixtures.js';

beforeEach(() => {
  store.clear();
  mockRedis.set.mockClear();
  mockRedis.del.mockClear();
  mockRedis.scan.mockClear();
  mockRedis.exists.mockClear();
  mockRedis.info.mockClear();
  infoReply = memoryInfo({ used: 1024 * 1024, max: MAXMEMORY_256MB });
  redisAvailable = true;
  vi.unstubAllEnvs();
});

describe('image staging', () => {
  it('returns a 64-char lowercase hex handle', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is content-addressed — identical bytes yield the same handle', async () => {
    const a = await stageImage('u1', buildPng(8, 8), 'png');
    const b = await stageImage('u1', buildPng(8, 8), 'png');
    expect(a).toBe(b);
  });

  it('gives different handles to different images', async () => {
    const a = await stageImage('u1', buildPng(8, 8), 'png');
    const b = await stageImage('u1', buildPng(16, 16), 'png');
    expect(a).not.toBe(b);
  });

  it('scopes the key by user id', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(mockRedis.set.mock.calls[0]![0]).toBe(`llm:img:u1:${handle}`);
  });

  it('sets the TTL', async () => {
    await stageImage('u1', buildPng(8, 8), 'png');
    expect(mockRedis.set.mock.calls[0]![2]).toEqual({ EX: STAGED_IMAGE_TTL_SECONDS });
  });

  it('round-trips bytes and format', async () => {
    const png = buildPng(8, 8);
    const handle = await stageImage('u1', png, 'png');
    const loaded = await loadStagedImage('u1', handle);
    expect(loaded!.format).toBe('png');
    expect(loaded!.bytes.equals(png)).toBe(true);
  });

  /**
   * Base64-in-JSON cost ~1.34x the raw size and three passes over the image.
   * The stored value is now the bytes plus a short ASCII format header.
   */
  it('stores the raw bytes, not base64', async () => {
    const png = buildPng(8, 8);
    await stageImage('u1', png, 'png');
    const stored = mockRedis.set.mock.calls[0]![1];
    expect(Buffer.isBuffer(stored)).toBe(true);
    expect(stored.length).toBe(png.length + 'png\n'.length);
    expect(stored.subarray(0, 4).toString('ascii')).toBe('png\n');
    expect(stored.subarray(4).equals(png)).toBe(true);
  });

  it('preserves a non-png format across the round-trip', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x0a, 0x0a]);
    const handle = await stageImage('u1', bytes, 'jpeg');
    const loaded = await loadStagedImage('u1', handle);
    expect(loaded!.format).toBe('jpeg');
    expect(loaded!.bytes.equals(bytes)).toBe(true);
  });

  /** One user must never be able to reference another's staged bytes. */
  it('does not load another user\'s handle', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(await loadStagedImage('u2', handle)).toBeNull();
  });

  it('returns null for an unknown handle', async () => {
    expect(await loadStagedImage('u1', 'f'.repeat(64))).toBeNull();
  });

  it('does not consume the entry on load, so a retry works', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(await loadStagedImage('u1', handle)).not.toBeNull();
    expect(await loadStagedImage('u1', handle)).not.toBeNull();
  });

  it('throws when Redis is unavailable', async () => {
    redisAvailable = false;
    await expect(stageImage('u1', buildPng(8, 8), 'png')).rejects.toThrow(/unavailable/i);
  });

  /**
   * A read against a down Redis is not an expiry. Returning null here would
   * tell the user to re-attach, and the re-attach would fail too.
   */
  it('throws ImageStagingUnavailableError on load when Redis is unavailable', async () => {
    redisAvailable = false;
    await expect(loadStagedImage('u1', 'a'.repeat(64)))
      .rejects.toBeInstanceOf(ImageStagingUnavailableError);
  });
});

/**
 * Redis is shared with BullMQ and runs `noeviction`, so unbounded staging is an
 * application-wide write outage, not just wasted memory.
 */
describe('per-user staging cap', () => {
  it('keeps only the newest handle for a user', async () => {
    const first = await stageImage('u1', buildPng(8, 8), 'png');
    const second = await stageImage('u1', buildPng(16, 16), 'png');

    expect(await loadStagedImage('u1', second)).not.toBeNull();
    expect(await loadStagedImage('u1', first)).toBeNull();
  });

  it('does not touch another user\'s staged image', async () => {
    const theirs = await stageImage('u2', buildPng(8, 8), 'png');
    await stageImage('u1', buildPng(16, 16), 'png');
    expect(await loadStagedImage('u2', theirs)).not.toBeNull();
  });

  it('re-staging identical bytes leaves the entry in place', async () => {
    const a = await stageImage('u1', buildPng(8, 8), 'png');
    const b = await stageImage('u1', buildPng(8, 8), 'png');
    expect(a).toBe(b);
    expect(await loadStagedImage('u1', a)).not.toBeNull();
  });

  it('uses SCAN rather than KEYS', async () => {
    await stageImage('u1', buildPng(8, 8), 'png');
    expect(mockRedis.scan).toHaveBeenCalledWith('0', expect.objectContaining({
      MATCH: 'llm:img:u1:*',
    }));
  });

  it('still returns the handle when the prune fails', async () => {
    mockRedis.scan.mockRejectedValueOnce(new Error('READONLY'));
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadStagedImage('u1', handle)).not.toBeNull();
  });
});

/** A corrupt value is a miss (410 "attach it again"), never an uncaught 500. */
describe('malformed stored values', () => {
  it.each([
    ['no format terminator', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['empty value', Buffer.alloc(0)],
    ['unknown format header', Buffer.from('svg\n<svg/>', 'ascii')],
    ['leading terminator', Buffer.from('\npng', 'ascii')],
    ['header longer than any format name', Buffer.concat([Buffer.alloc(64, 0x61), Buffer.from('\n')])],
    ['legacy base64-in-JSON value', Buffer.from(JSON.stringify({ format: 'png', base64: 'AAAA' }))],
    // Otherwise this resolves to `data:image/png;base64,` — a valid-looking
    // empty image handed to the provider.
    ['a valid header with no bytes behind it', Buffer.from('png\n', 'ascii')],
  ])('treats %s as a miss', async (_label, value) => {
    store.set('llm:img:u1:deadbeef', value);
    await expect(loadStagedImage('u1', 'deadbeef')).resolves.toBeNull();
  });
});

/**
 * Two uploads racing for one user each prune with a different `keepKey`, so
 * without the post-prune repair each deletes what the other just wrote and
 * BOTH callers get a handle that 410s — punishing the one who did nothing
 * wrong.
 */
describe('concurrent uploads from one user', () => {
  it('leaves both handles resolvable rather than deleting both', async () => {
    const [a, b] = await Promise.all([
      stageImage('u1', buildPng(8, 8), 'png'),
      stageImage('u1', buildPng(16, 16), 'png'),
    ]);

    expect(await loadStagedImage('u1', a)).not.toBeNull();
    expect(await loadStagedImage('u1', b)).not.toBeNull();
  });

  it('restores an entry a concurrent prune deleted', async () => {
    const png = buildPng(8, 8);
    // Simulate the loser of the race: the prune wipes everything, including the
    // key this call just wrote.
    mockRedis.scan.mockImplementationOnce(async () => {
      store.clear();
      return { cursor: 0, keys: [] };
    });

    const handle = await stageImage('u1', png, 'png');
    const loaded = await loadStagedImage('u1', handle);
    expect(loaded).not.toBeNull();
    expect(loaded!.bytes.equals(png)).toBe(true);
  });

  it('still returns the handle when the survival check itself fails', async () => {
    mockRedis.exists.mockRejectedValueOnce(new Error('READONLY'));
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseRedisMemory', () => {
  it('reads used_memory and maxmemory, not their prefixed neighbours', () => {
    const parsed = parseRedisMemory(memoryInfo({ used: 12345, max: MAXMEMORY_256MB }));
    expect(parsed).toEqual({ usedMemory: 12345, maxMemory: MAXMEMORY_256MB });
  });

  it('reads a reply with bare LF line endings', () => {
    const parsed = parseRedisMemory('# Memory\nused_memory:5\nmaxmemory:10\n');
    expect(parsed).toEqual({ usedMemory: 5, maxMemory: 10 });
  });

  it.each([
    ['an empty reply', ''],
    ['a reply with no maxmemory line', '# Memory\r\nused_memory:5\r\n'],
    ['a reply with no used_memory line', '# Memory\r\nmaxmemory:10\r\n'],
    ['a non-numeric value', '# Memory\r\nused_memory:abc\r\nmaxmemory:10\r\n'],
  ])('returns null for %s', (_label, reply) => {
    expect(parseRedisMemory(reply)).toBeNull();
  });
});

/**
 * #1183. The per-user cap above bounds the namespace to `users x
 * MAX_IMAGE_BYTES`, which is a mitigation but not a bound — enough people
 * staging inside one TTL window still fills a 256 MB `noeviction` instance,
 * and a full instance rejects *writes* for BullMQ too. So the write is
 * pre-flighted against `INFO memory` and refused before it can be the thing
 * that fills Redis.
 */
describe('Redis memory pre-flight', () => {
  const png = buildPng(8, 8);

  it('stages normally when there is headroom', async () => {
    const handle = await stageImage('u1', png, 'png');
    expect(await loadStagedImage('u1', handle)).not.toBeNull();
    expect(mockRedis.info).toHaveBeenCalledWith('memory');
  });

  it('refuses and writes nothing when the instance is past the threshold', async () => {
    infoReply = memoryInfo({ used: MAXMEMORY_256MB * 0.95, max: MAXMEMORY_256MB });
    await expect(stageImage('u1', png, 'png')).rejects.toBeInstanceOf(ImageStagingCapacityError);
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('names the wait and the operator remedy in the refusal', async () => {
    infoReply = memoryInfo({ used: MAXMEMORY_256MB, max: MAXMEMORY_256MB });
    await expect(stageImage('u1', png, 'png')).rejects.toThrow(/15 minutes/);
    await expect(stageImage('u1', png, 'png')).rejects.toThrow(/maxmemory/);
  });

  /**
   * The bytes about to be written count towards the projection — otherwise an
   * instance sitting just under the threshold accepts the very write that
   * crosses it, which is the whole failure being prevented.
   */
  it('counts the incoming bytes, not just what is already used', async () => {
    const big = Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024, 0x00)]);
    const ceiling = MAXMEMORY_256MB * (DEFAULT_MAX_REDIS_PERCENT / 100);
    infoReply = memoryInfo({ used: Math.floor(ceiling) - 1024, max: MAXMEMORY_256MB });

    await expect(stageImage('u1', big, 'png')).rejects.toBeInstanceOf(ImageStagingCapacityError);
    // The same instance state accepts a write that actually fits.
    await expect(stageImage('u1', png, 'png')).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * `maxmemory:0` is Redis for "no limit". There is nothing to be near the top
   * of, and refusing would break every deployment that runs Redis uncapped.
   */
  it('stages when maxmemory is unset', async () => {
    infoReply = memoryInfo({ used: 8 * 1024 * 1024 * 1024, max: 0 });
    await expect(stageImage('u1', png, 'png')).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * Fail OPEN, deliberately. `INFO` is renamed or ACL-blocked on plenty of
   * hardened and managed Redis deployments, and an unreadable reply is not
   * evidence that memory is short — failing closed would make the feature
   * permanently 503 on an instance that is perfectly healthy. The write itself
   * is the backstop: a genuinely full `noeviction` instance refuses the SET
   * with `OOM`, which is caught below.
   */
  it('stages when INFO is unparseable', async () => {
    infoReply = 'ERR unknown command';
    await expect(stageImage('u1', png, 'png')).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('stages when INFO itself fails', async () => {
    mockRedis.info.mockRejectedValueOnce(new Error('ERR unknown command `info`'));
    await expect(stageImage('u1', png, 'png')).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The backstop for every fail-open path above: Redis refused the write, so
   * nothing was stored and nothing else was displaced. That must read as the
   * same "come back later" 503 as the pre-flight, not as a 500.
   */
  it('maps an OOM rejection from the write itself to the capacity error', async () => {
    mockRedis.set.mockRejectedValueOnce(
      new Error("OOM command not allowed when used memory > 'maxmemory'."),
    );
    await expect(stageImage('u1', png, 'png')).rejects.toBeInstanceOf(ImageStagingCapacityError);
  });

  it('does not swallow an unrelated write failure', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('READONLY You can\'t write against a replica.'));
    await expect(stageImage('u1', png, 'png')).rejects.toThrow(/READONLY/);
  });

  describe('IMAGE_STAGING_MAX_REDIS_PERCENT', () => {
    it('honours a lower threshold', async () => {
      vi.stubEnv('IMAGE_STAGING_MAX_REDIS_PERCENT', '25');
      infoReply = memoryInfo({ used: MAXMEMORY_256MB * 0.5, max: MAXMEMORY_256MB });
      await expect(stageImage('u1', png, 'png')).rejects.toBeInstanceOf(ImageStagingCapacityError);
    });

    it('honours a higher threshold', async () => {
      vi.stubEnv('IMAGE_STAGING_MAX_REDIS_PERCENT', '99');
      infoReply = memoryInfo({ used: MAXMEMORY_256MB * 0.9, max: MAXMEMORY_256MB });
      await expect(stageImage('u1', png, 'png')).resolves.toMatch(/^[0-9a-f]{64}$/);
    });

    /**
     * Both directions, because at 90% used they do not discriminate on their
     * own: a regression that *accepted* `garbage` (NaN ceiling), `0` (zero
     * ceiling) or `-10` (negative ceiling) also refuses, so "rejects" alone
     * would stay green while every upload 503'd against an empty Redis. The
     * 10%-used half is what separates the two — the default admits it, and any
     * of those three ceilings does not.
     */
    it.each([['garbage'], ['0'], ['-10'], ['101'], ['']])(
      'falls back to the default for %s, refusing above 80%%', async (raw) => {
        vi.stubEnv('IMAGE_STAGING_MAX_REDIS_PERCENT', raw);
        infoReply = memoryInfo({ used: MAXMEMORY_256MB * 0.9, max: MAXMEMORY_256MB });
        await expect(stageImage('u1', png, 'png'))
          .rejects.toBeInstanceOf(ImageStagingCapacityError);
      },
    );

    it.each([['garbage'], ['0'], ['-10'], ['101'], ['']])(
      'falls back to the default for %s, still staging below 80%%', async (raw) => {
        vi.stubEnv('IMAGE_STAGING_MAX_REDIS_PERCENT', raw);
        infoReply = memoryInfo({ used: MAXMEMORY_256MB * 0.1, max: MAXMEMORY_256MB });
        await expect(stageImage('u1', png, 'png')).resolves.toMatch(/^[0-9a-f]{64}$/);
      },
    );
  });
});
