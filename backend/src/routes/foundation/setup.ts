/**
 * First-run setup wizard endpoints.
 *
 * These endpoints power the initial setup flow when Compendiq is deployed for
 * the first time. They allow detecting whether setup is complete, creating the
 * initial admin account, and testing LLM connectivity before persisting config.
 */

import { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import {
  generateAccessToken,
  generateRefreshToken,
} from '../../core/plugins/auth.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import {
  checkHealth as providerCheckHealth,
  listModels as providerListModels,
  type ProviderConfig,
} from '../../domains/llm/services/openai-compatible-client.js';
import { decryptPat } from '../../core/utils/crypto.js';
import { logger } from '../../core/utils/logger.js';

const SALT_ROUNDS = 12;
const REFRESH_COOKIE = 'kb_refresh';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

import { getRateLimits } from '../../core/services/rate-limit-service.js';
// Rate limit config for setup endpoints (uses auth category — both are security-sensitive)
const SETUP_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).auth.max, timeWindow: '1 minute' } } };
const SETUP_STATUS_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

// ─── Validation schemas ───────────────────────────────────────────────────

const SetupAdminSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8).max(128),
});

const LlmTestSchema = z.object({
  provider: z.enum(['ollama', 'openai']),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────

export async function setupRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/health/setup-status
   *
   * Public endpoint (no auth required) that reports whether the first-run
   * setup has been completed. The frontend uses this on every app mount to
   * decide whether to show the setup wizard or the normal UI.
   */
  fastify.get('/health/setup-status', SETUP_STATUS_RATE_LIMIT, async () => {
    const [adminResult, confluenceResult] = await Promise.all([
      query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM users WHERE role = $1 AND id != '00000000-0000-0000-0000-000000000000'`,
        ['admin'],
      ),
      query<{ count: string }>('SELECT COUNT(*) AS count FROM pages WHERE source = $1 LIMIT 1', ['confluence']),
    ]);

    // Fail-open for unauthenticated setup status endpoint: if the DB query
    // somehow returns no rows, treat as "not configured" rather than crashing.
    const adminExists = parseInt(adminResult.rows[0]?.count ?? '0', 10) > 0;
    const confluenceConnected = parseInt(confluenceResult.rows[0]?.count ?? '0', 10) > 0;

    // Check LLM health — best-effort, don't let it fail the whole response.
    // Uses the currently default provider from `llm_providers` (if any).
    let llmConnected = false;
    try {
      const row = await query<{
        base_url: string; api_key: string | null;
        auth_type: 'bearer' | 'none'; verify_ssl: boolean;
      }>(
        `SELECT id, base_url, api_key, auth_type, verify_ssl
         FROM llm_providers WHERE is_default = TRUE LIMIT 1`,
      );
      const p = row.rows[0];
      if (p) {
        let apiKey: string | null = null;
        try { apiKey = p.api_key ? decryptPat(p.api_key) : null; } catch { /* treat as no key */ }
        const cfg: ProviderConfig = {
          providerId: 'bootstrap',
          baseUrl: p.base_url,
          apiKey,
          authType: p.auth_type,
          verifySsl: p.verify_ssl,
        };
        const health = await Promise.race([
          providerCheckHealth(cfg),
          new Promise<{ connected: false }>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 5000),
          ),
        ]);
        llmConnected = health.connected;
      }
    } catch {
      // llmConnected remains false
    }

    return {
      setupComplete: adminExists,
      steps: {
        admin: adminExists,
        llm: llmConnected,
        confluence: confluenceConnected,
      },
    };
  });

  /**
   * POST /api/setup/admin
   *
   * Creates the initial admin account. Only works when no admin user exists
   * yet. Returns JWT tokens so the wizard can proceed to authenticated steps.
   */
  fastify.post('/setup/admin', SETUP_RATE_LIMIT, async (request, reply) => {
    const body = SetupAdminSchema.parse(request.body);

    const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);

    try {
      // Atomic admin creation: INSERT only if no admin exists (prevents TOCTOU race)
      const result = await query<{ id: string; username: string; role: string }>(
        `INSERT INTO users (username, password_hash, role)
         SELECT $1, $2, 'admin'
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND id != '00000000-0000-0000-0000-000000000000')
         RETURNING id, username, role`,
        [body.username, passwordHash],
      );
      if (result.rows.length === 0) {
        throw fastify.httpErrors.conflict('Admin account already exists');
      }
      const user = result.rows[0]!;

      // Create default user_settings row
      await query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);

      const accessToken = await generateAccessToken({
        sub: user.id,
        username: user.username,
        role: 'admin',
      });
      const { token: refreshToken } = await generateRefreshToken({
        sub: user.id,
        username: user.username,
        role: 'admin',
      });

      await logAuditEvent(user.id, 'REGISTER', 'user', user.id, {
        username: user.username,
        source: 'setup-wizard',
      }, request);

      logger.info({ userId: user.id, username: user.username }, 'Admin account created via setup wizard');

      reply
        .setCookie(REFRESH_COOKIE, refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          path: '/api/auth',
          maxAge: REFRESH_MAX_AGE,
        })
        .status(201)
        .send({
          accessToken,
          user: { id: user.id, username: user.username, role: user.role },
        });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        throw fastify.httpErrors.conflict('Username already taken');
      }
      throw err;
    }
  });

  /**
   * POST /api/setup/llm-test
   *
   * Tests LLM connectivity without persisting any configuration.
   * Requires authentication (admin must be created first).
   */
  fastify.post('/setup/llm-test', {
    preHandler: fastify.authenticate,
  }, async (request) => {
    const body = LlmTestSchema.parse(request.body);

    // Normalize the base URL to end in /v1 — all providers expose OpenAI-
    // compatible endpoints under /v1 (Ollama's /v1 shim is also OK).
    let baseUrl = (body.baseUrl ?? '').replace(/\/+$/, '');
    if (!baseUrl) {
      baseUrl = body.provider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:11434/v1';
    }
    if (!baseUrl.endsWith('/v1')) baseUrl += '/v1';

    const cfg: ProviderConfig = {
      providerId: 'setup-wizard',
      baseUrl,
      apiKey: body.apiKey ?? null,
      authType: body.apiKey ? 'bearer' : 'none',
      verifySsl: true,
    };

    try {
      const [health, models] = await Promise.all([
        providerCheckHealth(cfg),
        providerListModels(cfg).catch(() => []),
      ]);

      return {
        success: health.connected,
        error: health.error,
        models: models.map((m) => ({ name: m.name, size: 0 })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection test failed';
      logger.debug({ err, provider: body.provider }, 'LLM connection test failed');
      return {
        success: false,
        error: message,
        models: [],
      };
    }
  });
}
