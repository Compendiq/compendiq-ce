import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { resolveUsecase } from '../../domains/llm/services/llm-provider-resolver.js';
import {
  listModels as providerListModels,
  checkHealth as providerCheckHealth,
  type ProviderConfig,
} from '../../domains/llm/services/openai-compatible-client.js';
import { decryptPat } from '../../core/utils/crypto.js';
import { listProviderBreakers } from '../../core/services/circuit-breaker.js';
import { logger } from '../../core/utils/logger.js';

async function getDefaultProviderConfig(): Promise<ProviderConfig | null> {
  const row = await query<{
    id: string; base_url: string; api_key: string | null;
    auth_type: 'bearer' | 'none'; verify_ssl: boolean;
  }>(`SELECT id, base_url, api_key, auth_type, verify_ssl
      FROM llm_providers WHERE is_default = TRUE LIMIT 1`);
  const p = row.rows[0];
  if (!p) return null;
  let apiKey: string | null = null;
  try { apiKey = p.api_key ? decryptPat(p.api_key) : null; } catch { /* treat as no key */ }
  return {
    providerId: p.id,
    baseUrl: p.base_url,
    apiKey,
    authType: p.auth_type,
    verifySsl: p.verify_ssl,
  };
}

export async function llmModelRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/ollama/models - list models from the default provider
  // (or a specific use-case's provider when ?usecase=… is supplied).
  fastify.get('/ollama/models', async (request) => {
    const { usecase } = z.object({ usecase: z.enum(['chat', 'summary', 'quality', 'auto_tag', 'embedding']).optional() }).parse(request.query);

    let cfg: ProviderConfig | null;
    try {
      if (usecase) {
        const { config } = await resolveUsecase(usecase);
        cfg = config;
      } else {
        cfg = await getDefaultProviderConfig();
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to resolve provider for /ollama/models');
      return [];
    }
    if (!cfg) return [];

    try {
      return await providerListModels(cfg);
    } catch (err) {
      logger.warn({ err }, 'Failed to list models — returning empty list');
      return [];
    }
  });

  // GET /api/ollama/status - health of the default (or use-case-specific) provider.
  fastify.get('/ollama/status', async (request) => {
    const { usecase } = z.object({ usecase: z.enum(['chat', 'summary', 'quality', 'auto_tag', 'embedding']).optional() }).parse(request.query);

    let cfg: ProviderConfig | null;
    let providerName = '';
    try {
      if (usecase) {
        const { config } = await resolveUsecase(usecase);
        cfg = config;
        providerName = (config as ProviderConfig & { name?: string }).name ?? '';
      } else {
        cfg = await getDefaultProviderConfig();
        if (cfg) {
          const r = await query<{ name: string }>(
            `SELECT name FROM llm_providers WHERE id = $1`, [cfg.providerId],
          );
          providerName = r.rows[0]?.name ?? '';
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to resolve provider for /ollama/status');
      return { connected: false, error: 'No default provider configured' };
    }

    if (!cfg) {
      return { connected: false, error: 'No default provider configured' };
    }

    const health = await providerCheckHealth(cfg);
    return {
      connected: health.connected,
      error: health.error,
      provider: providerName,
      baseUrl: cfg.baseUrl,
      authType: cfg.authType,
      verifySsl: cfg.verifySsl,
      authConfigured: !!cfg.apiKey,
    };
  });

  // GET /api/llm/circuit-breaker-status — provider-keyed flat map of live
  // circuit-breaker state. Only providers that have actually been contacted
  // show up (see core/services/circuit-breaker.ts → listProviderBreakers).
  fastify.get('/llm/circuit-breaker-status', async () => {
    const out: Record<
      string,
      { state: string; failureCount: number; nextRetryTime: number | null }
    > = {};
    for (const snap of listProviderBreakers()) {
      out[snap.providerId] = {
        state: snap.state,
        failureCount: snap.failureCount,
        nextRetryTime: snap.nextRetryTime,
      };
    }
    return out;
  });
}
