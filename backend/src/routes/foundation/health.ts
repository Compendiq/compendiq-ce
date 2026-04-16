import { FastifyInstance } from 'fastify';
import { checkConnection as checkPg } from '../../core/db/postgres.js';
import { checkRedisConnection } from '../../core/plugins/redis.js';
import { getOllamaCircuitBreakerStatus, getOpenaiCircuitBreakerStatus } from '../../core/services/circuit-breaker.js';
import { getProvider } from '../../domains/llm/services/ollama-service.js';
import { logger } from '../../core/utils/logger.js';
import { getMetrics as getLlmQueueMetrics } from '../../domains/llm/services/llm-queue.js';
import { getSharedLlmSettings } from '../../core/services/admin-settings-service.js';
import { APP_VERSION, APP_BUILD_INFO } from '../../core/utils/version.js';
import { getQueueMetrics, isBullMQEnabled } from '../../core/services/queue-service.js';

// Track whether startup checks have passed
let startupComplete = false;

export function markStartupComplete(): void {
  startupComplete = true;
}

/** Check LLM connectivity using the active provider's health check. */
async function checkLlm(): Promise<boolean> {
  try {
    const sharedLlmSettings = await getSharedLlmSettings();
    const result = await Promise.race([
      getProvider(sharedLlmSettings.llmProvider).checkHealth(),
      new Promise<{ connected: false }>((_resolve, reject) =>
        setTimeout(() => reject(new Error('LLM health check timed out')), 5000),
      ),
    ]);
    return result.connected;
  } catch {
    logger.debug('LLM health check failed');
    return false;
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
    const status = allHealthy ? 'ok' : (postgres || redis) ? 'degraded' : 'error';

    reply.status(allHealthy ? 200 : 503).send({
      status,
      services: {
        postgres,
        redis,
      },
      version: APP_VERSION,
      edition: APP_BUILD_INFO.edition,
      commit: APP_BUILD_INFO.commit,
      builtAt: APP_BUILD_INFO.builtAt,
      uptime: process.uptime(),
    });
  });

  // GET /api/health/start - Startup probe
  // Has the service completed initialization?
  // Checks migrations ran + LLM provider reachable.
  // Used by k8s startup probe.
  fastify.get('/health/start', async (_request, reply) => {
    const sharedLlmSettings = await getSharedLlmSettings();
    const [postgres, llmReady] = await Promise.all([
      checkPg(),
      checkLlm(),
    ]);

    const ready = startupComplete && postgres;

    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'starting',
      checks: {
        startupComplete,
        postgres,
        llmAvailable: llmReady,
        llmProvider: sharedLlmSettings.llmProvider,
      },
      version: APP_VERSION,
      edition: APP_BUILD_INFO.edition,
      commit: APP_BUILD_INFO.commit,
      builtAt: APP_BUILD_INFO.builtAt,
    });
  });

  // GET /api/health - backward compatibility alias for /api/health/ready
  // Also includes LLM status for full picture.
  fastify.get('/health', async (_request, reply) => {
    try {
      const [sharedLlmSettings, postgres, redis, llm] = await Promise.all([
        getSharedLlmSettings(),
        checkPg(),
        checkRedisConnection(fastify.redis),
        checkLlm(),
      ]);

      const allHealthy = postgres && redis;
      const status = allHealthy ? 'ok' : (postgres || redis) ? 'degraded' : 'error';

      const queueMetrics = isBullMQEnabled() ? await getQueueMetrics() : undefined;

      reply.status(allHealthy ? 200 : 503).send({
        status,
        services: { postgres, redis, llm },
        llmProvider: sharedLlmSettings.llmProvider,
        circuitBreakers: {
          ollama: getOllamaCircuitBreakerStatus(),
          openai: getOpenaiCircuitBreakerStatus(),
        },
        llmQueue: getLlmQueueMetrics(),
        ...(queueMetrics && { queues: queueMetrics }),
        version: APP_VERSION,
        edition: APP_BUILD_INFO.edition,
        commit: APP_BUILD_INFO.commit,
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
        builtAt: APP_BUILD_INFO.builtAt,
        uptime: process.uptime(),
      });
    }
  });
}
