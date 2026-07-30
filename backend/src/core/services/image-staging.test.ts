import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The store holds Buffers, matching what a real node-redis client returns once
 * `withTypeMapping({ [BLOB_STRING]: Buffer })` is applied. A test double that
 * kept strings would hide exactly the mangling that mapping exists to prevent.
 */
const store = new Map<string, Buffer>();
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
  STAGED_IMAGE_TTL_SECONDS,
  ImageStagingUnavailableError,
} from './image-staging.js';
import { buildPng } from './test-image-fixtures.js';

beforeEach(() => {
  store.clear();
  mockRedis.set.mockClear();
  mockRedis.del.mockClear();
  mockRedis.scan.mockClear();
  redisAvailable = true;
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
   * Base64-in-JSON cost ~1.34x the raw size and three passes over up to 10 MB.
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
  ])('treats %s as a miss', async (_label, value) => {
    store.set('llm:img:u1:deadbeef', value);
    await expect(loadStagedImage('u1', 'deadbeef')).resolves.toBeNull();
  });
});
