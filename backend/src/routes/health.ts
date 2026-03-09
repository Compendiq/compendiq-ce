import { FastifyInstance } from 'fastify';
import { Agent } from 'undici';
import { checkConnection as checkPg } from '../db/postgres.js';
import { checkRedisConnection } from '../plugins/redis.js';
import { getOllamaCircuitBreakerStatus } from '../services/circuit-breaker.js';
import { logger } from '../utils/logger.js';

// Track whether startup checks have passed
let startupComplete = false;

export function markStartupComplete(): void {
  startupComplete = true;
}

function getOllamaFetchHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const authType = (process.env.LLM_AUTH_TYPE ?? 'bearer').toLowerCase();
  if (authType === 'bearer' && process.env.LLM_BEARER_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.LLM_BEARER_TOKEN}`;
  }
  return headers;
}

/**
 * Build an undici Agent that disables TLS verification when LLM_VERIFY_SSL=false.
 * Must match the behaviour of ollama-service.ts so health checks agree with
 * the actual Ollama SDK client.
 */
function buildHealthDispatcher(): Agent | undefined {
  if (process.env.LLM_VERIFY_SSL === 'false') {
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  return undefined;
}

const healthDispatcher = buildHealthDispatcher();

/** Build the Ollama API URL, stripping any trailing slash from the base. */
function ollamaApiUrl(path: string): string {
  const base = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  return `${base}${path}`;
}

/** Perform a fetch to Ollama that respects LLM_VERIFY_SSL and LLM_AUTH_TYPE. */
function ollamaFetch(url: string, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: getOllamaFetchHeaders(),
    ...(healthDispatcher ? { dispatcher: healthDispatcher } : {}),
  } as RequestInit);
}

async function checkOllama(): Promise<boolean> {
  try {
    const res = await ollamaFetch(ollamaApiUrl('/api/tags'), 3000);
    return res.ok;
  } catch {
    logger.debug('Ollama health check failed');
    return false;
  }
}

async function checkOllamaModels(): Promise<boolean> {
  try {
    const res = await ollamaFetch(ollamaApiUrl('/api/tags'), 5000);
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return Array.isArray(data.models) && data.models.length > 0;
  } catch {
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
  // Checks migrations ran + at least one Ollama model available.
  // Used by k8s startup probe.
  fastify.get('/health/start', async (_request, reply) => {
    const postgres = await checkPg();
    const ollamaReady = await checkOllamaModels();

    const ready = startupComplete && postgres && ollamaReady;

    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'starting',
      checks: {
        startupComplete,
        postgres,
        ollamaModelsAvailable: ollamaReady,
      },
      version: '1.0.0',
    });
  });

  // GET /api/health - backward compatibility alias for /api/health/ready
  // Also includes Ollama status for full picture.
  fastify.get('/health', async (_request, reply) => {
    const [postgres, redis, ollama] = await Promise.all([
      checkPg(),
      checkRedisConnection(fastify.redis),
      checkOllama(),
    ]);

    const allHealthy = postgres && redis;
    const status = allHealthy ? 'ok' : (postgres || redis) ? 'degraded' : 'error';

    const circuitBreakers = getOllamaCircuitBreakerStatus();

    reply.status(allHealthy ? 200 : 503).send({
      status,
      services: { postgres, redis, ollama },
      circuitBreakers,
      version: '1.0.0',
      uptime: process.uptime(),
    });
  });
}
