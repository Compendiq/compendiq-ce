/**
 * Internal health-API endpoint for the compendiq-mgmt instance poller.
 * Scope: Compendiq/compendiq-ee#113 Part A.
 *
 * Contract (from issue body):
 *   GET /api/internal/health?token=${HEALTH_API_TOKEN}
 *   → { version, edition, tier, userCount, dirtyPages, lastSyncAt, errorRate24h, ... }
 *
 * Auth model
 * ──────────
 * A per-instance opaque bearer token in `admin_settings.health_api_token`,
 * seeded by migration 072 (`encode(gen_random_bytes(32),'hex')`). The token
 * is compared with `crypto.timingSafeEqual` against the `?token=` query
 * param. Length-mismatched comparisons still spend the same compare work
 * to keep the endpoint timing-flat. This route deliberately does NOT use
 * `fastify.authenticate` — the mgmt poller is machine-to-machine and has
 * no JWT cookie. Token rotation is a manual `UPDATE admin_settings ...`
 * for now (the rotation route is a follow-up slice).
 *
 * Why not Authorization: Bearer header
 * ────────────────────────────────────
 * The issue body explicitly specifies the `?token=` query-string contract.
 * Query strings are visible in upstream proxy access logs, so operators
 * pointing at this endpoint should ensure the mgmt-side fetcher disables
 * URL logging for it. A header-based variant is a reasonable follow-up
 * but is intentionally out-of-scope here to keep the contract surface
 * stable while the mgmt-side poller is being built.
 *
 * Failure modes
 * ─────────────
 *   401 — token missing, malformed, or wrong
 *   503 — token row missing (migration didn't run; fail closed)
 *   500 — unexpected error assembling the report (logged with correlation id)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { APP_VERSION, APP_BUILD_INFO } from '../../core/utils/version.js';

interface HealthQueryString {
  token?: unknown;
}

/**
 * Length of the seeded token in characters (64 lowercase hex from 32 raw
 * bytes). Used as the size of the dummy buffers for length-mismatch
 * compares so timing stays constant regardless of presented-token size.
 */
const TOKEN_HEX_LEN = 64;

/**
 * Audit actions counted in the `errorRate24h` numerator. Pairs with the
 * closed `AuditAction` union in `audit-service.ts`; adding a new
 * error-shaped action requires updating BOTH the union and this list.
 *
 * Excludes events that aren't true operational errors (e.g.
 * `SYNC_CONFLICT_DETECTED` is a workflow signal, not a failure;
 * `PROMPT_INJECTION_DETECTED` is a security observation worth surfacing
 * separately, not lumped into the generic error rate).
 */
const ERROR_AUDIT_ACTIONS = [
  'LOGIN_FAILED',
  'ADMIN_ACCESS_DENIED',
  'IP_ALLOWLIST_BLOCKED',
  'WEBHOOK_DELIVERY_FAILED',
  'WEBHOOK_DELIVERY_DEAD',
  'EMBEDDING_RESET_FAILED',
] as const;

async function readHealthApiToken(): Promise<string | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = 'health_api_token'`,
  );
  return r.rows[0]?.setting_value ?? null;
}

/**
 * Constant-time string equality. On length mismatch, performs an
 * equivalent fixed-length compare against zeroed buffers so the response
 * timing does not leak the expected token's length.
 */
export function constantTimeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(Buffer.alloc(TOKEN_HEX_LEN), Buffer.alloc(TOKEN_HEX_LEN));
    return false;
  }
  return timingSafeEqual(a, b);
}

interface HealthReport {
  version: string;
  edition: string;
  tier: string;
  commit: string;
  builtAt: string;
  userCount: number;
  activeUserCount: number;
  dirtyPages: number;
  lastSyncAt: string | null;
  errorRate24h: number;
  uptime: number;
  collectedAt: string;
}

/**
 * Aggregate the lifecycle/health snapshot the mgmt poller stores in
 * `instance_metrics`. Each scalar comes from a small, indexed query;
 * everything runs in parallel.
 */
async function buildHealthReport(fastify: FastifyInstance): Promise<HealthReport> {
  const [users, dirty, lastSync, errors] = await Promise.all([
    query<{ total: string; active: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE deactivated_at IS NULL)::text AS active
         FROM users`,
    ),
    query<{ c: string }>(
      // `pages.embedding_status = 'not_embedded'` is the modern "needs
      // embedding" predicate (migration 017). `cached_pages` was renamed
      // to `pages` in migration 028. Indexed by `idx_cached_pages_embedding_status`.
      `SELECT COUNT(*)::text AS c FROM pages WHERE embedding_status = 'not_embedded'`,
    ),
    query<{ ts: Date | null }>(
      // `cached_spaces` was renamed to `spaces` in migration 040.
      `SELECT MAX(last_synced) AS ts FROM spaces`,
    ),
    // Error-rate window: count rows with one of the explicitly-listed
    // error-shaped actions over total audit rows in the last 24 h.
    // Indexed by `idx_audit_log_created`. Returns 0 when total is 0
    // (no audit activity in the window).
    //
    // Why an explicit allowlist instead of `LIKE '%FAILED%' OR LIKE '%DENIED%'`:
    // the substring filter caught most error-shaped actions but missed
    // BLOCKED-suffixed ones (IP_ALLOWLIST_BLOCKED) and would silently
    // drift as the audit-action vocabulary grows. The explicit list
    // pairs with the closed `AuditAction` union in `audit-service.ts`;
    // adding a new error-shaped action requires updating both.
    query<{ failed: string; total: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE action = ANY($1::text[]))::text AS failed,
         COUNT(*)::text AS total
       FROM audit_log
       WHERE created_at > NOW() - INTERVAL '24 hours'`,
      [ERROR_AUDIT_ACTIONS],
    ),
  ]);

  const total = parseInt(users.rows[0]?.total ?? '0', 10);
  const active = parseInt(users.rows[0]?.active ?? '0', 10);
  const dirtyPages = parseInt(dirty.rows[0]?.c ?? '0', 10);
  const failedCount = parseInt(errors.rows[0]?.failed ?? '0', 10);
  const totalAudit = parseInt(errors.rows[0]?.total ?? '0', 10);
  const errorRate24h = totalAudit > 0 ? failedCount / totalAudit : 0;

  return {
    version: APP_VERSION,
    edition: APP_BUILD_INFO.edition,
    tier: fastify.license?.tier ?? 'community',
    commit: APP_BUILD_INFO.commit,
    builtAt: APP_BUILD_INFO.builtAt,
    userCount: total,
    activeUserCount: active,
    dirtyPages,
    lastSyncAt: lastSync.rows[0]?.ts ? lastSync.rows[0]!.ts!.toISOString() : null,
    errorRate24h: Number(errorRate24h.toFixed(4)),
    uptime: process.uptime(),
    collectedAt: new Date().toISOString(),
  };
}

export async function healthApiRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/internal/health',
    async (
      request: FastifyRequest<{ Querystring: HealthQueryString }>,
      reply: FastifyReply,
    ) => {
      const presented = typeof request.query.token === 'string' ? request.query.token : '';
      if (presented.length === 0) {
        return reply.status(401).send({ error: 'token required' });
      }
      const expected = await readHealthApiToken();
      if (!expected) {
        // Migration didn't run / row missing — fail closed rather than 200.
        logger.error('health-api: admin_settings.health_api_token row missing');
        return reply.status(503).send({ error: 'health token not initialised' });
      }
      if (!constantTimeEqual(presented, expected)) {
        return reply.status(401).send({ error: 'invalid token' });
      }

      try {
        const report = await buildHealthReport(fastify);
        return reply.status(200).send(report);
      } catch (err) {
        logger.error({ err }, 'health-api: failed to assemble report');
        return reply.status(500).send({ error: 'failed to assemble health report' });
      }
    },
  );
}
