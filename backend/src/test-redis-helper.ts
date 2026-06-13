/**
 * Shared Redis availability probe for test suites that need a real Redis
 * (presence, webhooks, cache-bus, re-embed jobs). Mirrors `test-db-helper.ts`'s
 * `isDbAvailable()` contract: probe once, cache the answer, let suites gate
 * with `describe.skipIf(!available)`.
 *
 * Fail-fast is the whole point. node-redis's DEFAULT reconnectStrategy
 * retries forever, so a bare `createClient({ url }).connect()` never settles
 * when Redis is down — a test file probing that way hangs the entire vitest
 * run indefinitely instead of skipping. Every probe here disables reconnects
 * and bounds the initial connect.
 */

import { createClient } from 'redis';

let _redisAvailable: boolean | null = null;

/**
 * Check whether a Redis instance is reachable. Never throws, never retries,
 * settles within ~1s on dead targets.
 *
 * The no-argument form probes `REDIS_URL` (default `redis://localhost:6379`)
 * and caches the result for the lifetime of the process — vitest runs test
 * files sequentially in one process (`fileParallelism: false`), so one probe
 * serves every suite. Passing an explicit `url` always probes fresh.
 */
export async function isRedisAvailable(url?: string): Promise<boolean> {
  if (url === undefined && _redisAvailable !== null) return _redisAvailable;

  const target = url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  const result = await probe(target);
  if (url === undefined) _redisAvailable = result;
  return result;
}

async function probe(url: string): Promise<boolean> {
  let client: ReturnType<typeof createClient>;
  try {
    client = createClient({
      url,
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    });
  } catch {
    // Malformed URL — createClient throws synchronously.
    return false;
  }
  client.on('error', () => { /* swallow — we only care whether connect works */ });
  try {
    await client.connect();
    await client.ping();
    await client.quit();
    return true;
  } catch {
    try { await client.disconnect(); } catch { /* best effort */ }
    return false;
  }
}
