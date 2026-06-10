/**
 * Shared REDIS_URL → ioredis connection-options parser for BullMQ.
 *
 * Single source of truth for every BullMQ `Queue`/`Worker` connection
 * (queue-service.ts, webhook-outbox-poller.ts, webhook-delivery.ts). The
 * node-redis client (core/plugins/redis.ts) consumes REDIS_URL verbatim,
 * so this parser must agree with it on the URL features we support, or
 * the two clients silently diverge (issue #742: TLS downgrade, wrong-user
 * auth failures, cross-db key collisions).
 *
 * Supported URL surface (deliberately narrow):
 *   - `redis://` and `rediss://` schemes (`rediss:` enables TLS)
 *   - optional `user:pass@` userinfo, percent-decoded
 *   - optional numeric `/N` path → `db` (non-numeric paths are ignored)
 *
 * NOT translated for ioredis: IPv6 bracket hosts and query parameters
 * (e.g. `?family=`). A URL that fails WHATWG parsing — or credentials
 * with malformed percent-encoding — falls back to the localhost defaults
 * instead of throwing at Queue/Worker construction time.
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
 * Unparseable URLs — including malformed percent-encoding in the
 * credentials — fall back to localhost defaults.
 */
export function getRedisConnectionOpts(
  url: string = process.env.REDIS_URL ?? 'redis://localhost:6379',
): RedisConnectionOpts {
  try {
    const parsed = new URL(url);

    const opts: RedisConnectionOpts = {
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379', 10),
      maxRetriesPerRequest: null,
    };

    if (parsed.protocol === 'rediss:') {
      opts.tls = {};
    }
    // decodeURIComponent stays inside this try block: WHATWG URL parsing
    // accepts invalid %-sequences in the userinfo, but decoding them throws
    // URIError — which must degrade to the documented fallback, not escape
    // into Queue/Worker construction.
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
  } catch {
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }
}
