import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import {
  getEnabledProvider,
  getProvider,
  upsertProvider,
  buildAuthorizationUrl,
  consumeAuthSession,
  exchangeCodeForTokens,
  verifyIdToken,
  provisionOidcUser,
  syncOidcGroups,
  getDiscoveryDocument,
  listOidcGroupRoleMappings,
  createOidcGroupRoleMapping,
  deleteOidcGroupRoleMapping,
} from '../../core/services/oidc-service.js';
import {
  generateAccessToken,
  generateRefreshToken,
} from '../../core/plugins/auth.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { getRedisClient } from '../../core/services/redis-cache.js';
import { logger } from '../../core/utils/logger.js';

const REFRESH_COOKIE = 'kb_refresh';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * One-time login code: after OIDC callback succeeds, we store the auth result
 * in Redis keyed by a random code. The frontend exchanges this code for tokens
 * via POST /api/auth/oidc/exchange. This avoids putting tokens in redirect URLs
 * and eliminates open-redirect vulnerabilities.
 */
const LOGIN_CODE_PREFIX = 'oidc:login_code:';
const LOGIN_CODE_TTL = 60; // 1 minute — must be exchanged quickly

/**
 * Hardcoded redirect paths (never user-controlled).
 * The FRONTEND_URL env var is set by the server admin, not by user input.
 */
const CALLBACK_PATH = '/auth/oidc/callback';
const LOGIN_PATH = '/login';

// Rate limit for OIDC endpoints (dynamic via admin settings)
import { getRateLimits } from '../../core/services/rate-limit-service.js';
const OIDC_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).oidc.max, timeWindow: '1 minute' } } };
const OIDC_ADMIN_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } } };

// ── Zod schemas ────────────────────────────────────────────────────────────────

const OidcCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const OidcExchangeBodySchema = z.object({
  code: z.string().min(1).max(200),
});

const OidcProviderBodySchema = z.object({
  issuerUrl: z.string().url(),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(2000).optional(),
  redirectUri: z.string().url(),
  groupsClaim: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
});

const OidcMappingBodySchema = z.object({
  oidcGroup: z.string().min(1).max(200),
  roleId: z.coerce.number().int().positive(),
  spaceKey: z.string().min(1).max(100).nullable().optional(),
});

const OidcMappingDeleteParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Builds a redirect URL using only the server-controlled FRONTEND_URL
 * and a hardcoded path. Query parameters are built from known-safe values.
 * This prevents open-redirect attacks.
 */
function buildFrontendRedirect(path: string, params?: Record<string, string>): string {
  const origin = process.env.FRONTEND_URL ?? 'http://localhost:5273';
  const url = new URL(path, origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

// ── Public OIDC routes (no auth required) ──────────────────────────────────────

export async function oidcRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/auth/oidc/config
   * Returns public OIDC configuration (whether SSO is enabled, issuer name).
   * No authentication required — the login page needs this.
   */
  fastify.get('/auth/oidc/config', OIDC_RATE_LIMIT, async () => {
    const provider = await getEnabledProvider();
    return {
      enabled: !!provider,
      issuer: provider?.issuerUrl ?? null,
      name: provider?.name ?? null,
    };
  });

  /**
   * GET /api/auth/oidc/authorize
   * Generates the authorization URL and redirects the user to the IdP.
   * Stores state/nonce/PKCE verifier in Redis for callback validation.
   */
  fastify.get('/auth/oidc/authorize', OIDC_RATE_LIMIT, async (request, reply) => {
    const provider = await getEnabledProvider();
    if (!provider) {
      throw fastify.httpErrors.serviceUnavailable('OIDC is not configured or not enabled');
    }

    const { url } = await buildAuthorizationUrl(provider);
    // nosemgrep: open-redirect — url is built from IdP discovery document, not user input
    return reply.redirect(url);
  });

  /**
   * GET /api/auth/oidc/callback
   * Handles the IdP callback: exchanges code for tokens, verifies the ID token,
   * provisions the user, syncs groups, and stores the auth result in Redis.
   *
   * Security: does NOT put tokens in the redirect URL. Instead, stores them in
   * Redis with a one-time code. The frontend exchanges the code via POST /exchange.
   */
  fastify.get('/auth/oidc/callback', OIDC_RATE_LIMIT, async (request, reply) => {
    try {
      const { code, state } = OidcCallbackQuerySchema.parse(request.query);

      // 1. Retrieve and consume the auth session (validates state)
      const session = await consumeAuthSession(state);
      if (!session) {
        logger.warn({ state: state.slice(0, 10) }, 'OIDC callback: invalid or expired state');
        const target = buildFrontendRedirect(LOGIN_PATH, { error: 'oidc_state_invalid' });
        return reply.redirect(target);
      }

      // 2. Fetch the provider config
      const provider = await getEnabledProvider();
      if (!provider || provider.id !== session.providerId) {
        const target = buildFrontendRedirect(LOGIN_PATH, { error: 'oidc_provider_mismatch' });
        return reply.redirect(target);
      }

      // 3. Exchange authorization code for tokens at the IdP
      const tokenResponse = await exchangeCodeForTokens(provider, code, session.codeVerifier);

      // 4. Verify the ID token (signature, issuer, audience, nonce)
      const claims = await verifyIdToken(tokenResponse.id_token, provider, session.nonce);

      // 5. Provision or update user
      const user = await provisionOidcUser(claims);

      // 6. Sync OIDC group memberships
      await syncOidcGroups(user.id, claims, provider.groupsClaim);

      // 7. Issue our JWT tokens
      const accessToken = await generateAccessToken({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
      const { token: refreshToken } = await generateRefreshToken({
        sub: user.id,
        username: user.username,
        role: user.role,
      });

      await logAuditEvent(user.id, 'LOGIN', 'user', user.id, {
        method: 'oidc',
        oidcSub: claims.sub,
        oidcIssuer: claims.iss,
      }, request);

      // 8. Store auth result in Redis with a one-time login code.
      // The frontend exchanges this code for the actual tokens via POST /exchange.
      // This avoids putting tokens in redirect URLs (security best practice).
      const loginCode = randomBytes(32).toString('hex');
      const redis = getRedisClient();
      if (!redis) {
        throw new Error('Redis not available for OIDC login code storage');
      }
      await redis.set(
        `${LOGIN_CODE_PREFIX}${loginCode}`,
        JSON.stringify({
          accessToken,
          refreshToken,
          user: { id: user.id, username: user.username, role: user.role },
        }),
        { EX: LOGIN_CODE_TTL },
      );

      // 9. Set refresh token as httpOnly cookie
      reply.setCookie(REFRESH_COOKIE, refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax', // Lax required for cross-origin redirect from IdP
        path: '/api/auth',
        maxAge: REFRESH_MAX_AGE,
      });

      // 10. Redirect to fixed frontend path with the one-time code
      const target = buildFrontendRedirect(CALLBACK_PATH, { login_code: loginCode });
      return reply.redirect(target);
    } catch (err) {
      logger.error({ err }, 'OIDC callback failed');
      const target = buildFrontendRedirect(LOGIN_PATH, { error: 'oidc_callback_failed' });
      return reply.redirect(target);
    }
  });

  /**
   * POST /api/auth/oidc/exchange
   * Exchanges a one-time login code (from the callback redirect) for tokens.
   * The code is consumed (deleted from Redis) on first use.
   */
  fastify.post('/auth/oidc/exchange', OIDC_RATE_LIMIT, async (request) => {
    const { code } = OidcExchangeBodySchema.parse(request.body);

    const redis = getRedisClient();
    if (!redis) {
      throw fastify.httpErrors.serviceUnavailable('Service temporarily unavailable');
    }

    const key = `${LOGIN_CODE_PREFIX}${code}`;
    // Atomic get-and-delete prevents TOCTOU race (double-use of login codes)
    const data = await redis.getDel(key);
    if (!data) {
      throw fastify.httpErrors.unauthorized('Invalid or expired login code');
    }

    const result = JSON.parse(data) as {
      accessToken: string;
      refreshToken: string;
      user: { id: string; username: string; role: string };
    };

    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  });

  /**
   * POST /api/auth/oidc/logout
   * Clears session and returns the IdP logout URL if available.
   * Requires authentication to prevent abuse.
   */
  fastify.post('/auth/oidc/logout', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    let endSessionUrl: string | undefined;

    try {
      const provider = await getEnabledProvider();
      if (provider) {
        const discovery = await getDiscoveryDocument(provider.issuerUrl);
        if (discovery.end_session_endpoint) {
          const logoutUrl = new URL(discovery.end_session_endpoint);
          logoutUrl.searchParams.set(
            'post_logout_redirect_uri',
            process.env.FRONTEND_URL ?? 'http://localhost:5273',
          );
          logoutUrl.searchParams.set('client_id', provider.clientId);
          endSessionUrl = logoutUrl.toString();
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to build OIDC end-session URL');
    }

    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { message: 'Logged out', endSessionUrl: endSessionUrl ?? null };
  });
}

// ── Admin OIDC routes (require admin) ──────────────────────────────────────────

export async function oidcAdminRoutes(fastify: FastifyInstance) {
  // All admin OIDC routes require admin role
  fastify.addHook('onRequest', fastify.requireAdmin);

  /**
   * GET /api/admin/oidc
   * Returns OIDC provider configuration (without the client secret).
   */
  fastify.get('/admin/oidc', OIDC_ADMIN_RATE_LIMIT, async () => {
    const provider = await getProvider();
    if (!provider) {
      return {
        configured: false,
        provider: null,
      };
    }

    return {
      configured: true,
      provider: {
        id: provider.id,
        name: provider.name,
        issuerUrl: provider.issuerUrl,
        clientId: provider.clientId,
        redirectUri: provider.redirectUri,
        groupsClaim: provider.groupsClaim,
        enabled: provider.enabled,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
        // Never expose client secret
      },
    };
  });

  /**
   * PUT /api/admin/oidc
   * Creates or updates OIDC provider configuration.
   */
  fastify.put('/admin/oidc', OIDC_ADMIN_RATE_LIMIT, async (request) => {
    const body = OidcProviderBodySchema.parse(request.body);

    const provider = await upsertProvider({
      issuerUrl: body.issuerUrl,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      redirectUri: body.redirectUri,
      groupsClaim: body.groupsClaim,
      enabled: body.enabled,
    });

    await logAuditEvent(
      request.userId, 'ADMIN_ACTION', 'oidc_provider', String(provider.id),
      { action: 'upsert_oidc_provider', issuerUrl: body.issuerUrl },
      request,
    );

    return {
      configured: true,
      provider: {
        id: provider.id,
        name: provider.name,
        issuerUrl: provider.issuerUrl,
        clientId: provider.clientId,
        redirectUri: provider.redirectUri,
        groupsClaim: provider.groupsClaim,
        enabled: provider.enabled,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      },
    };
  });

  /**
   * POST /api/admin/oidc/test
   * Tests the OIDC discovery endpoint to validate configuration.
   */
  fastify.post('/admin/oidc/test', OIDC_ADMIN_RATE_LIMIT, async (request) => {
    const body = z.object({ issuerUrl: z.string().url() }).parse(request.body);

    try {
      const discovery = await getDiscoveryDocument(body.issuerUrl);
      return {
        success: true,
        issuer: discovery.issuer,
        authorizationEndpoint: discovery.authorization_endpoint,
        tokenEndpoint: discovery.token_endpoint,
        endSessionEndpoint: discovery.end_session_endpoint ?? null,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Discovery failed',
      };
    }
  });

  // ── Mappings ───────────────────────────────────────────────────────────────

  /**
   * GET /api/admin/oidc/mappings
   * Lists all OIDC group -> role mappings.
   */
  fastify.get('/admin/oidc/mappings', OIDC_ADMIN_RATE_LIMIT, async () => {
    return listOidcGroupRoleMappings();
  });

  /**
   * POST /api/admin/oidc/mappings
   * Creates a new OIDC group -> role mapping.
   */
  fastify.post('/admin/oidc/mappings', OIDC_ADMIN_RATE_LIMIT, async (request, reply) => {
    const body = OidcMappingBodySchema.parse(request.body);

    try {
      const mapping = await createOidcGroupRoleMapping({
        oidcGroup: body.oidcGroup,
        roleId: body.roleId,
        spaceKey: body.spaceKey ?? null,
      });

      await logAuditEvent(
        request.userId, 'ADMIN_ACTION', 'oidc_mapping', String(mapping.id),
        { action: 'create_oidc_mapping', oidcGroup: body.oidcGroup },
        request,
      );

      reply.status(201);
      return mapping;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw fastify.httpErrors.conflict(
          'A mapping already exists for this OIDC group and space',
        );
      }
      throw err;
    }
  });

  /**
   * DELETE /api/admin/oidc/mappings/:id
   * Deletes an OIDC group -> role mapping.
   */
  fastify.delete('/admin/oidc/mappings/:id', OIDC_ADMIN_RATE_LIMIT, async (request) => {
    const { id } = OidcMappingDeleteParamSchema.parse(request.params);

    const deleted = await deleteOidcGroupRoleMapping(id);
    if (!deleted) {
      throw fastify.httpErrors.notFound('Mapping not found');
    }

    await logAuditEvent(
      request.userId, 'ADMIN_ACTION', 'oidc_mapping', String(id),
      { action: 'delete_oidc_mapping' },
      request,
    );

    return { message: 'Mapping deleted' };
  });
}
