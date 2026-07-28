import { FastifyInstance } from 'fastify';
import { checkConnection as checkPg, query } from '../../core/db/postgres.js';
import { checkRedisConnection } from '../../core/plugins/redis.js';
import {
  checkHealth as providerCheckHealth,
  type ProviderConfig,
} from '../../domains/llm/services/openai-compatible-client.js';
import { decryptPat } from '../../core/utils/crypto.js';
import { logger } from '../../core/utils/logger.js';
import { APP_VERSION, APP_BUILD_INFO } from '../../core/utils/version.js';

// Track whether startup checks have passed
let startupComplete = false;

export function markStartupComplete(): void {
  startupComplete = true;
}

/**
 * Check LLM connectivity against the default provider configured in
 * `llm_providers` (if any). Returns false if no default provider is set.
 */
async function checkLlm(): Promise<{ connected: boolean; providerName: string | null }> {
  try {
    const row = await query<{
      name: string; base_url: string; api_key: string | null;
      auth_type: 'bearer' | 'none'; verify_ssl: boolean;
    }>(
      `SELECT id, name, base_url, api_key, auth_type, verify_ssl
       FROM llm_providers WHERE is_default = TRUE LIMIT 1`,
    );
    const p = row.rows[0];
    if (!p) return { connected: false, providerName: null };

    let apiKey: string | null = null;
    try { apiKey = p.api_key ? decryptPat(p.api_key) : null; } catch { /* treat as no key */ }
    const cfg: ProviderConfig = {
      providerId: 'health-probe',
      baseUrl: p.base_url,
      apiKey,
      authType: p.auth_type,
      verifySsl: p.verify_ssl,
    };

    const result = await Promise.race([
      providerCheckHealth(cfg),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('LLM health check timed out')), 5000),
      ),
    ]);
    return { connected: result.connected, providerName: p.name };
  } catch {
    logger.debug('LLM health check failed');
    return { connected: false, providerName: null };
  }
}

export async function healthRoutes(fastify: FastifyInstance) {
  // GET /api/health/live - Liveness probe
  // Is the process alive? Always returns 200.
  // Used by k8s liveness probe.
  fastify.get('/health/live', async () => {
    return { status: 'ok' };
  });

  // GET /api/health/ready - Readiness probe
  // Can the service accept traffic? Checks PostgreSQL + Redis.
  // Used by k8s readiness probe (unauthenticated). #1052: the response is
  // deliberately coarse — only `status` + the 200/503 code that orchestrators
  // consume. No services/version/edition/commit/uptime telemetry leaks here.
  fastify.get('/health/ready', async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      checkPg(),
      checkRedisConnection(fastify.redis),
    ]);

    const allHealthy = postgres && redis;
    let status: 'ok' | 'degraded' | 'error';
    if (allHealthy) {
      status = 'ok';
    } else if (postgres || redis) {
      status = 'degraded';
    } else {
      status = 'error';
    }

    reply.status(allHealthy ? 200 : 503).send({ status });
  });

  // GET /api/health/start - Startup probe
  // Has the service completed initialization? Readiness is gated on
  // `startupComplete && postgres` — the LLM probe never gated it, so #1052
  // drops the LLM check (and its provider-name leak) entirely. The response
  // is coarse: only the gating checks + the 200/503 code. Used by k8s startup
  // probe (unauthenticated).
  fastify.get('/health/start', async (_request, reply) => {
    const postgres = await checkPg();

    const ready = startupComplete && postgres;

    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'starting',
      checks: {
        startupComplete,
        postgres,
      },
    });
  });

  // GET /api/health - backward compatibility alias for /api/health/ready.
  //
  // #1052: this is a public, unauthenticated endpoint, so anonymous callers get
  // only the coarse `{ status }` (+ 200/503 code). Detailed operational
  // telemetry — per-service postgres/redis/llm status, the configured LLM
  // provider name, version/edition/commit/build metadata, and uptime — is
  // exposed ONLY to an authenticated ADMIN. We reuse the existing
  // `fastify.authenticate` decorator inside a swallow-try: anonymous or
  // non-admin callers silently fall through to the coarse response, so the
  // endpoint keeps working for unauthenticated docker/k8s health checks.
  fastify.get('/health', async (request, reply) => {
    let isAdmin = false;
    try {
      await fastify.authenticate(request);
      isAdmin = request.userRole === 'admin';
    } catch {
      // Anonymous or invalid token → coarse public response.
    }

    try {
      const [postgres, redis] = await Promise.all([
        checkPg(),
        checkRedisConnection(fastify.redis),
      ]);

      const allHealthy = postgres && redis;
      const status = allHealthy ? 'ok' : (postgres || redis) ? 'degraded' : 'error';

      if (!isAdmin) {
        reply.status(allHealthy ? 200 : 503).send({ status });
        return;
      }

      // Admin-only detail. The LLM probe (which reads the configured provider
      // name) runs only on this branch so its identity never leaks publicly.
      // #818: internal operational telemetry (circuit-breaker state, LLM queue
      // depth, BullMQ metrics) stays dropped — it had no consumers.
      const llmStatus = await checkLlm();
      reply.status(allHealthy ? 200 : 503).send({
        status,
        services: { postgres, redis, llm: llmStatus.connected },
        llmProvider: llmStatus.providerName,
        version: APP_VERSION,
        edition: APP_BUILD_INFO.edition,
        commit: APP_BUILD_INFO.commit,
        ceCommit: APP_BUILD_INFO.ceCommit,
        builtAt: APP_BUILD_INFO.builtAt,
        uptime: process.uptime(),
      });
    } catch {
      // Fallback: if any check throws unexpectedly, report partial status —
      // still tiered by admin so the fallback never leaks detail either.
      const [postgres, redis] = await Promise.all([checkPg(), checkRedisConnection(fastify.redis)]).catch((error) => {
        logger.warn({ error }, 'Fallback health dependency checks failed');
        return [false, false] as const;
      });
      const allHealthy = postgres && redis;
      if (!isAdmin) {
        reply.status(allHealthy ? 200 : 503).send({ status: allHealthy ? 'ok' : 'degraded' });
        return;
      }
      reply.status(allHealthy ? 200 : 503).send({
        status: allHealthy ? 'ok' : 'degraded',
        services: { postgres, redis, llm: false },
        version: APP_VERSION,
        edition: APP_BUILD_INFO.edition,
        commit: APP_BUILD_INFO.commit,
        ceCommit: APP_BUILD_INFO.ceCommit,
        builtAt: APP_BUILD_INFO.builtAt,
        uptime: process.uptime(),
      });
    }
  });
}
