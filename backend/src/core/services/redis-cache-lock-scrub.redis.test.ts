/**
 * Atomic stale embedding-lock scrub against a REAL Redis (#1759).
 *
 * `listActiveEmbeddingLocks` used to classify a member as stale from a GET
 * and later SREM it in a separate command, so an `acquireEmbeddingLock` that
 * landed in between was removed from the set while its key was live
 * (`{ held: true, member: false }`). The scrub is now one Lua script that
 * re-checks `EXISTS` inside Redis.
 *
 * The race is made exact, not probabilistic: the client handed to
 * `setRedisClient` runs a real acquire immediately before the listing's scrub
 * command (`eval` of the scrub script, or `sRem` on the pre-fix code), then
 * forwards the command to the real client.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  setRedisClient,
  acquireEmbeddingLock,
  listActiveEmbeddingLocks,
} from './redis-cache.js';

const redisAvailable = await isRedisAvailable();

const SET_KEY = 'embedding:locks:active';
const lockKey = (id: string): string => `embedding:lock:${id}`;
const TRIAL_IDS_PREFIX = 'e1759-scrub-';

let real: RedisClientType;

/** Ids used by this file; removed again after every test. */
const touched = new Set<string>();

function trackedId(name: string): string {
  const id = `${TRIAL_IDS_PREFIX}${name}`;
  touched.add(id);
  return id;
}

async function seedStaleMember(id: string): Promise<void> {
  await real.del(lockKey(id));
  await real.sAdd(SET_KEY, id);
}

interface ScrubClient {
  client: RedisClientType;
  /** Settles when every scrub command the listing issued has completed. */
  scrubsDone: () => Promise<unknown>;
}

/**
 * Wraps the real client so the test can await the fire-and-forget scrub. When
 * `acquireFor` is given, a real `acquireEmbeddingLock` runs immediately before
 * the first scrub command (`eval` of the scrub script, or `sRem` on pre-fix
 * code), which is the exact interleaving of the bug.
 */
function scrubClient(acquireFor?: { id: string; onAcquired: (lockId: string | null) => void }): ScrubClient {
  const scrubs: Promise<unknown>[] = [];
  let armed = acquireFor !== undefined;
  const run = <T>(command: () => Promise<T>): Promise<T> => {
    const p = (async () => {
      if (armed && acquireFor) {
        armed = false;
        setRedisClient(real);
        acquireFor.onAcquired(await acquireEmbeddingLock(acquireFor.id));
      }
      return command();
    })();
    scrubs.push(p.catch(() => undefined));
    return p;
  };
  const hooked = {
    sMembers: (...a: Parameters<RedisClientType['sMembers']>) => real.sMembers(...a),
    multi: () => real.multi(),
    eval: (...a: Parameters<RedisClientType['eval']>) => run(() => real.eval(...a)),
    sRem: (...a: Parameters<RedisClientType['sRem']>) => run(() => real.sRem(...a)),
  };
  return { client: hooked as unknown as RedisClientType, scrubsDone: () => Promise.all(scrubs) };
}

describe.skipIf(!redisAvailable)('listActiveEmbeddingLocks stale scrub (real Redis)', () => {
  beforeAll(async () => {
    real = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
    await real.connect();
  }, 15_000);

  beforeEach(() => {
    setRedisClient(real);
  });

  afterAll(async () => {
    setRedisClient(null);
    for (const id of touched) {
      await real.del(lockKey(id));
      await real.sRem(SET_KEY, id);
    }
    await real.quit();
  });

  it('keeps a stale member whose key is created by a real acquire before the scrub runs, and lists it live', async () => {
    const id = trackedId('race');
    await seedStaleMember(id);

    let lockId: string | null = null;
    const hooked = scrubClient({ id, onAcquired: (l) => { lockId = l; } });
    setRedisClient(hooked.client);
    const first = await listActiveEmbeddingLocks();
    await hooked.scrubsDone();
    setRedisClient(real);

    // The snapshot taken before the acquire still reports the stale placeholder.
    expect(first.find((l) => l.userId === id)).toEqual({ userId: id, holderEpoch: '', ttlRemainingMs: -2 });
    expect(lockId).toEqual(expect.any(String));
    expect(Number(await real.sIsMember(SET_KEY, id))).toBe(1);
    expect(await real.exists(lockKey(id))).toBe(1);

    const second = await listActiveEmbeddingLocks();
    const entry = second.find((l) => l.userId === id);
    expect(entry?.holderEpoch).toBe(lockId);
    expect(entry!.ttlRemainingMs).toBeGreaterThan(0);
  });

  it('removes a stale member whose key stays absent', async () => {
    const id = trackedId('gone');
    await seedStaleMember(id);

    const hooked = scrubClient();
    setRedisClient(hooked.client);
    const first = await listActiveEmbeddingLocks();
    expect(first.find((l) => l.userId === id)).toEqual({ userId: id, holderEpoch: '', ttlRemainingMs: -2 });
    await hooked.scrubsDone();
    setRedisClient(real);

    expect(Number(await real.sIsMember(SET_KEY, id))).toBe(0);
    const second = await listActiveEmbeddingLocks();
    expect(second.find((l) => l.userId === id)).toBeUndefined();
  });

  it('120 interleaved trials hide no live lock', async () => {
    const id = trackedId('probe');
    let hidden = 0;
    for (let trial = 0; trial < 120; trial++) {
      await real.del(lockKey(id));
      await real.sRem(SET_KEY, id);
      await seedStaleMember(id);

      let lockId: string | null = null;
      const hooked = scrubClient({ id, onAcquired: (l) => { lockId = l; } });
      setRedisClient(hooked.client);
      await listActiveEmbeddingLocks();
      await hooked.scrubsDone();
      setRedisClient(real);

      const held = (await real.get(lockKey(id))) === lockId && lockId !== null;
      const member = Number(await real.sIsMember(SET_KEY, id)) === 1;
      const visible = (await listActiveEmbeddingLocks()).some((l) => l.userId === id && l.holderEpoch === lockId);
      if (held && (!member || !visible)) hidden++;
    }
    expect(hidden).toBe(0);
  }, 60_000);
});
