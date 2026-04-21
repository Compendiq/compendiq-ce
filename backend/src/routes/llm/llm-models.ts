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

// ─── Deprecation header constants — single source of truth (issue #266) ────
//
// The /api/ollama/circuit-breaker-status route is a deprecated alias for
// /api/llm/circuit-breaker-status. These constants MUST stay consistent:
//   - `DEPRECATION_EPOCH` is the moment this alias was marked deprecated. It is
//     the `@`-prefixed Structured Date value per RFC 9745 §2 (Structured Item
//     form) — NOT the non-spec "true" sentinel.
//   - `SUNSET_HTTP_DATE` is the HTTP-date per RFC 8594, strictly later than
//     `DEPRECATION_EPOCH`. After this moment the follow-up PR removes the
//     alias entirely (see docs/issues/266-implementation-plan.md §3).
//   - `SUCCESSOR_URL` is the canonical replacement route; surfaced via a
//     `Link: <…>; rel="successor-version"` header per RFC 9745 §2.
//
// Grace window: 6 months (2026-04-21 → 2026-10-21) per implementer directive.
const DEPRECATION_EPOCH = 1776729600; // 2026-04-21T00:00:00Z
const SUNSET_HTTP_DATE = 'Wed, 21 Oct 2026 00:00:00 GMT';
const SUCCESSOR_URL = '/api/llm/circuit-breaker-status';

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

  // Shared handler for both the canonical route and its deprecated alias.
  // Returns a provider-keyed flat map of live circuit-breaker state — only
  // providers that have actually been contacted show up (see
  // core/services/circuit-breaker.ts → listProviderBreakers).
  function buildBreakerStatus(): Record<
    string,
    { state: string; failureCount: number; nextRetryTime: number | null }
  > {
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
  }

  // GET /api/llm/circuit-breaker-status — canonical (issue #266).
  fastify.get('/llm/circuit-breaker-status', async () => buildBreakerStatus());

  // GET /api/ollama/circuit-breaker-status — DEPRECATED alias. Removed after
  // sunset (see docs/issues/266-implementation-plan.md §3, follow-up PR).
  fastify.get('/ollama/circuit-breaker-status', async (_request, reply) => {
    // RFC 9745 §2 Structured Item form — `@`-prefixed Unix epoch. NOT "true".
    reply.header('Deprecation', `@${DEPRECATION_EPOCH}`);
    // RFC 8594 — HTTP-date, strictly later than Deprecation (asserted in tests).
    reply.header('Sunset', SUNSET_HTTP_DATE);
    // RFC 9745 §2 — canonical field for tooling auto-migration to the successor.
    reply.header('Link', `<${SUCCESSOR_URL}>; rel="successor-version"`);
    return buildBreakerStatus();
  });
}
