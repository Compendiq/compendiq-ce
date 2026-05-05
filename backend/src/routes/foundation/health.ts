import { FastifyInstance } from 'fastify';
import { checkConnection as checkPg, query } from '../../core/db/postgres.js';
import { checkRedisConnection } from '../../core/plugins/redis.js';
import { listProviderBreakers } from '../../core/services/circuit-breaker.js';
import {
  checkHealth as providerCheckHealth,
  type ProviderConfig,
} from '../../domains/llm/services/openai-compatible-client.js';
import { listProviders } from '../../domains/llm/services/llm-provider-service.js';
import { decryptPat } from '../../core/utils/crypto.js';
import { logger } from '../../core/utils/logger.js';
import { getMetrics as getLlmQueueMetrics } from '../../domains/llm/services/llm-queue.js';
import { APP_VERSION, APP_BUILD_INFO } from '../../core/utils/version.js';
import { getQueueMetrics, isBullMQEnabled } from '../../core/services/queue-service.js';

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
  // Used by k8s readiness probe.
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

    reply.status(allHealthy ? 200 : 503).send({
      status,
      services: {
        postgres,
        redis,
      },
      version: APP_VERSION,
      edition: APP_BUILD_INFO.edition,
      commit: APP_BUILD_INFO.commit,
      ceCommit: APP_BUILD_INFO.ceCommit,
      builtAt: APP_BUILD_INFO.builtAt,
      uptime: process.uptime(),
    });
  });

  // GET /api/health/start - Startup probe
  // Has the service completed initialization?
  // Checks migrations ran + LLM provider reachable.
  // Used by k8s startup probe.
  fastify.get('/health/start', async (_request, reply) => {
    const [postgres, llmStatus] = await Promise.all([
      checkPg(),
      checkLlm(),
    ]);

    const ready = startupComplete && postgres;

    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'starting',
      checks: {
        startupComplete,
        postgres,
        llmAvailable: llmStatus.connected,
        llmProvider: llmStatus.providerName,
      },
      version: APP_VERSION,
      edition: APP_BUILD_INFO.edition,
      commit: APP_BUILD_INFO.commit,
      ceCommit: APP_BUILD_INFO.ceCommit,
      builtAt: APP_BUILD_INFO.builtAt,
    });
  });

  // GET /api/health - backward compatibility alias for /api/health/ready
  // Also includes LLM status for full picture.
  fastify.get('/health', async (_request, reply) => {
    try {
      const [postgres, redis, llmStatus] = await Promise.all([
        checkPg(),
        checkRedisConnection(fastify.redis),
        checkLlm(),
      ]);

      const allHealthy = postgres && redis;
      const status = allHealthy ? 'ok' : (postgres || redis) ? 'degraded' : 'error';

      const queueMetrics = isBullMQEnabled() ? await getQueueMetrics() : undefined;

      // Enrich per-provider breaker snapshots with human-readable provider names.
      // `listProviders()` is cheap (a single SELECT without secrets) and tolerates
      // providers that never booted a breaker (they simply don't appear here).
      let providerBreakerSnapshots: Array<{
        providerId: string; name: string | null; state: string; failures: number;
      }> = [];
      try {
        const breakers = listProviderBreakers();
        if (breakers.length > 0) {
          const providers = await listProviders().catch(() => []);
          const nameById = new Map(providers.map((p) => [p.id, p.name]));
          providerBreakerSnapshots = breakers.map((b) => ({
            providerId: b.providerId,
            name: nameById.get(b.providerId) ?? null,
            state: b.state,
            failures: b.failureCount,
          }));
        }
      } catch (err) {
        logger.debug({ err }, 'Failed to enrich circuit-breaker snapshots');
      }

      reply.status(allHealthy ? 200 : 503).send({
        status,
        services: { postgres, redis, llm: llmStatus.connected },
        llmProvider: llmStatus.providerName,
        circuitBreakers: {
          providers: providerBreakerSnapshots,
        },
        llmQueue: getLlmQueueMetrics(),
        ...(queueMetrics && { queues: queueMetrics }),
        version: APP_VERSION,
        edition: APP_BUILD_INFO.edition,
        commit: APP_BUILD_INFO.commit,
        ceCommit: APP_BUILD_INFO.ceCommit,
        builtAt: APP_BUILD_INFO.builtAt,
        uptime: process.uptime(),
      });
    } catch {
      // Fallback: if any check throws unexpectedly, report partial status
      const [postgres, redis] = await Promise.all([checkPg(), checkRedisConnection(fastify.redis)]).catch((error) => {
        logger.warn({ error }, 'Fallback health dependency checks failed');
        return [false, false] as const;
      });
      const allHealthy = postgres && redis;
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
