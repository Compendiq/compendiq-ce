import { FastifyInstance } from 'fastify';
import { checkConnection as checkPg } from '../db/postgres.js';
import { checkRedisConnection } from '../plugins/redis.js';
import { getOllamaCircuitBreakerStatus, getOpenaiCircuitBreakerStatus } from '../services/circuit-breaker.js';
import { checkHealth as checkLlmHealth, getActiveProviderType } from '../services/ollama-service.js';
import { logger } from '../utils/logger.js';

// Track whether startup checks have passed
let startupComplete = false;

export function markStartupComplete(): void {
  startupComplete = true;
}

/** Check LLM connectivity using the active provider's health check. */
async function checkLlm(): Promise<boolean> {
  try {
    const result = await checkLlmHealth();
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
      version: '1.0.0',
      uptime: process.uptime(),
    });
  });

  // GET /api/health/start - Startup probe
  // Has the service completed initialization?
  // Checks migrations ran + LLM provider reachable.
  // Used by k8s startup probe.
  fastify.get('/health/start', async (_request, reply) => {
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
        llmProvider: getActiveProviderType(),
      },
      version: '1.0.0',
    });
  });

  // GET /api/health - backward compatibility alias for /api/health/ready
  // Also includes LLM status for full picture.
  fastify.get('/health', async (_request, reply) => {
    const [postgres, redis, llm] = await Promise.all([
      checkPg(),
      checkRedisConnection(fastify.redis),
      checkLlm(),
    ]);

    const allHealthy = postgres && redis;
    const status = allHealthy ? 'ok' : (postgres || redis) ? 'degraded' : 'error';
    const providerType = getActiveProviderType();

    reply.status(allHealthy ? 200 : 503).send({
      status,
      services: { postgres, redis, llm },
      llmProvider: providerType,
      circuitBreakers: {
        ollama: getOllamaCircuitBreakerStatus(),
        openai: getOpenaiCircuitBreakerStatus(),
      },
      version: '1.0.0',
      uptime: process.uptime(),
    });
  });
}
