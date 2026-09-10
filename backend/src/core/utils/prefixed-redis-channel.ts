/**
 * Redis pub/sub is process-global: logical database numbers isolate KEYS,
 * not channels. Parallel Vitest workers therefore have to namespace every
 * publish/subscribe name or they cross-talk.
 *
 * Production always gets an empty prefix. The prefix keys off
 * `VITEST_POOL_ID` (the reusable 1..maxWorkers slot), never
 * `VITEST_WORKER_ID` (that one increments per file).
 */
export function vitestRedisChannelPrefix(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  if (env.VITEST !== 'true') return '';
  const id = env.VITEST_POOL_ID;
  if (id === undefined || id === '' || id === 'undefined') return '';
  if (!/^\d+$/.test(id)) return '';
  return `vitest:w${id}:`;
}

export function prefixedRedisChannel(
  channel: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const prefix = vitestRedisChannelPrefix(env);
  return prefix ? `${prefix}${channel}` : channel;
}
