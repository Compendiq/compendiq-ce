/**
 * Shared REDIS_URL → ioredis connection-options parser for BullMQ.
 *
 * Single source of truth for every BullMQ `Queue`/`Worker` connection
 * (queue-service.ts, webhook-outbox-poller.ts). The node-redis client
 * (core/plugins/redis.ts) consumes REDIS_URL verbatim, so this parser must
 * honor the full URL surface — `rediss://` (TLS), the ACL username, and the
 * `/N` database index — or the two clients silently diverge (issue #742:
 * TLS downgrade, wrong-user auth failures, cross-db key collisions).
 *
 * Option names per ioredis `RedisOptions`: `tls` (empty object enables TLS,
 * equivalent to a `rediss://` URL), `username`, `password`, `db` (number).
 * Credentials are percent-decoded to match node-redis URL semantics.
 */

export interface RedisConnectionOpts {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Redis logical database index from the URL path (`/N`). */
  db?: number;
  /** Empty object = enable TLS with default verification (`rediss://`). */
  tls?: Record<string, never>;
  /** Required by BullMQ: blocking commands must never exhaust retries. */
  maxRetriesPerRequest: null;
}

/**
 * Parse a Redis URL (defaults to `REDIS_URL`, falling back to
 * `redis://localhost:6379`) into ioredis/BullMQ connection options.
 * Unparseable URLs fall back to localhost defaults.
 */
export function getRedisConnectionOpts(
  url: string = process.env.REDIS_URL ?? 'redis://localhost:6379',
): RedisConnectionOpts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }

  const opts: RedisConnectionOpts = {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    maxRetriesPerRequest: null,
  };

  if (parsed.protocol === 'rediss:') {
    opts.tls = {};
  }
  if (parsed.username) {
    opts.username = decodeURIComponent(parsed.username);
  }
  if (parsed.password) {
    opts.password = decodeURIComponent(parsed.password);
  }

  const dbMatch = /^\/(\d+)$/.exec(parsed.pathname);
  if (dbMatch) {
    opts.db = parseInt(dbMatch[1]!, 10);
  }

  return opts;
}
