import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import correlationIdPlugin from './core/plugins/correlation-id.js';
import authPlugin from './core/plugins/auth.js';
import redisPlugin from './core/plugins/redis.js';
// Foundation routes
import { healthRoutes } from './routes/foundation/health.js';
import { authRoutes } from './routes/foundation/auth.js';
import { settingsRoutes } from './routes/foundation/settings.js';
import { adminRoutes } from './routes/foundation/admin.js';
import { adminEmbeddingLocksRoutes } from './routes/foundation/admin-embedding-locks.js';
import { adminIpAllowlistRoutes } from './routes/foundation/admin-ip-allowlist.js';
import { rbacRoutes } from './routes/foundation/rbac.js';
import { adminUsersRoutes } from './routes/foundation/admin-users.js';
// Confluence routes
import { spacesRoutes } from './routes/confluence/spaces.js';
import { syncRoutes } from './routes/confluence/sync.js';
import { attachmentRoutes } from './routes/confluence/attachments.js';
// LLM routes
import { llmImproveRoutes } from './routes/llm/llm-improve.js';
import { llmGenerateRoutes } from './routes/llm/llm-generate.js';
import { llmSummarizeRoutes } from './routes/llm/llm-summarize.js';
import { llmDiagramRoutes } from './routes/llm/llm-diagram.js';
import { llmQualityRoutes } from './routes/llm/llm-quality.js';
import { llmAskRoutes } from './routes/llm/llm-ask.js';
import { llmConversationRoutes } from './routes/llm/llm-conversations.js';
import { llmEmbeddingRoutes } from './routes/llm/llm-embeddings.js';
import { llmModelRoutes } from './routes/llm/llm-models.js';
import { llmAdminRoutes } from './routes/llm/llm-admin.js';
import { llmProviderRoutes } from './routes/llm/llm-providers.js';
import { llmUsecaseRoutes } from './routes/llm/llm-usecases.js';
import { llmEmbeddingReembedRoutes } from './routes/llm/llm-embedding-reembed.js';
import { llmEmbeddingProbeRoutes } from './routes/llm/llm-embedding-probe.js';
import { llmPdfRoutes } from './routes/llm/llm-pdf.js';
// Knowledge routes
import { pagesCrudRoutes } from './routes/knowledge/pages-crud.js';
import { pagesPresenceRoutes } from './routes/knowledge/pages-presence.js';
import { pagesVersionRoutes } from './routes/knowledge/pages-versions.js';
import { pagesTagRoutes } from './routes/knowledge/pages-tags.js';
import { pagesEmbeddingRoutes } from './routes/knowledge/pages-embeddings.js';
import { pagesDuplicateRoutes } from './routes/knowledge/pages-duplicates.js';
import { pinnedPagesRoutes } from './routes/knowledge/pinned-pages.js';
import { analyticsRoutes } from './routes/knowledge/analytics.js';
import { knowledgeAdminRoutes } from './routes/knowledge/knowledge-admin.js';
import { templateRoutes } from './routes/knowledge/templates.js';
import { pagesExportRoutes } from './routes/knowledge/pages-export.js';
import { commentsRoutes } from './routes/knowledge/comments.js';
import { pagesImportRoutes } from './routes/knowledge/pages-import.js';
import { contentAnalyticsRoutes } from './routes/knowledge/content-analytics.js';
import { verificationRoutes } from './routes/knowledge/verification.js';
import { notificationRoutes } from './routes/foundation/notifications.js';
import { setupRoutes } from './routes/foundation/setup.js';
import { knowledgeRequestRoutes } from './routes/knowledge/knowledge-requests.js';
import { searchRoutes } from './routes/knowledge/search.js';
import { localSpacesRoutes } from './routes/knowledge/local-spaces.js';
import { localAttachmentsRoutes } from './routes/knowledge/local-attachments.js';

import { ZodError } from 'zod';
import { trackError } from './core/services/error-tracker.js';
import { logger } from './core/utils/logger.js';
import { APP_VERSION } from './core/utils/version.js';
import { loadEnterprisePlugin, setCurrentLicense } from './core/enterprise/loader.js';
import { bootstrapLlmProviders } from './domains/llm/services/llm-provider-bootstrap.js';
import { bootstrapSsrfAllowlist } from './domains/confluence/services/sync-service.js';
import { initSsrfAllowlistBus } from './core/services/ssrf-allowlist-bus.js';
import { initPresenceBus } from './core/services/presence-service.js';
import { initCacheBus, close as closeCacheBus } from './core/services/redis-cache-bus.js';
import { buildTrustProxyFn } from './core/utils/trusted-proxy.js';
import {
  initIpAllowlistService,
  loadTrustedProxiesFromAdminSettings,
} from './core/services/ip-allowlist-service.js';
import ipAllowlistHook from './core/plugins/ip-allowlist-hook.js';
import { initSyncConflictPolicyService } from './core/services/sync-conflict-policy-service.js';
import { ENTERPRISE_FEATURES } from './core/enterprise/features.js';

export async function buildApp() {
  // v0.4 epic §3.4 — replace the previous blanket `trustProxy: true` with a
  // CIDR-bounded function. Default when the IP-allowlist feature is off /
  // unconfigured: loopback only (127.0.0.1/32, ::1/128). Deployments behind
  // a non-loopback reverse proxy must populate `trusted_proxies` in
  // admin_settings explicitly — see CHANGELOG entry for v0.4 for migration.
  const trustedProxies = await loadTrustedProxiesFromAdminSettings();

  const app = Fastify({
    logger: false, // We use our own pino instance
    trustProxy: buildTrustProxyFn(trustedProxies),
  });

  // Zod type provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Core plugins — CORS origin supports comma-separated FRONTEND_URL
  const frontendUrls = (process.env.FRONTEND_URL ?? 'http://localhost:5273')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const corsOrigin = frontendUrls.length === 1 ? frontendUrls[0] : frontendUrls;

  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });

  // Security headers (CSP handled by nginx in production)
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    hsts: process.env.NODE_ENV === 'production',
  });

  await app.register(sensible);
  await app.register(cookie);
  await app.register(compress);
  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20 MB
      files: 1,
      fields: 0,
    },
  });

  // Global rate limit — max is dynamic via admin settings (60s cache)
  const { getRateLimits: getRateLimitsForGlobal } = await import('./core/services/rate-limit-service.js');
  await app.register(rateLimit, {
    global: true,
    max: async () => (await getRateLimitsForGlobal()).global.max,
    timeWindow: '1 minute',
  });

  // Only register Swagger/OpenAPI docs in non-production environments.
  // Exposing the full API schema in production is an information disclosure risk.
  if (process.env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Compendiq API',
          version: APP_VERSION,
        },
      },
    });

    await app.register(swaggerUi, {
      routePrefix: '/api/docs',
    });
  }

  // Custom plugins (correlation-id first so all subsequent requests have it)
  await app.register(correlationIdPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // ── Enterprise Plugin Bootstrap ──────────────────────────────────
  const enterprise = await loadEnterprisePlugin();
  const licenseKey = process.env.COMPENDIQ_LICENSE_KEY ?? process.env.ATLASMIND_LICENSE_KEY;
  const license = enterprise.validateLicense(licenseKey);

  app.decorate('license', license);
  app.decorate('enterprise', enterprise);

  // Publish the license to module-scope callers (background workers, the
  // Confluence sync loop, BullMQ jobs) that cannot reach `app.license`.
  // Mirrors the decorate call above — EE paths that hot-reload the license
  // via `PUT /api/admin/license` are expected to call this again themselves.
  setCurrentLicense(license);

  // Let the enterprise plugin register its own routes (e.g., full license endpoint)
  await enterprise.registerRoutes(app, license);

  // ── SSRF Allowlist Bus (issue #306) ──────────────────────────────
  // Wire Redis pub/sub so mutations on one pod propagate to peer pods.
  // Fails soft: if Redis is unavailable the allowlist still works in
  // single-pod mode via the local `Set<string>`.
  const teardownSsrfBus = await initSsrfAllowlistBus(app.redis);
  app.addHook('onClose', async () => {
    await teardownSsrfBus();
  });

  // ── Presence bus (issue #301) ────────────────────────────────────
  // Duplicated Redis subscriber running PSUBSCRIBE presence:page:* so
  // SSE streams can fan out heartbeats across pods. Fails soft into
  // single-pod mode if Redis is unreachable.
  const teardownPresenceBus = await initPresenceBus(app.redis);
  app.addHook('onClose', async () => {
    await teardownPresenceBus();
  });

  // ── Generic cache-bus (v0.4 epic §3.1) ───────────────────────────
  // Cluster-wide invalidation channel used by cached admin_settings
  // (see makeCachedSetting) and future hot-reload consumers. Fails soft
  // into single-pod mode if Redis is unreachable.
  await initCacheBus(app.redis);
  app.addHook('onClose', async () => {
    await closeCacheBus();
  });

  // ── IP Allowlist (EE #111) ───────────────────────────────────────
  // Cold-load the persisted config + subscribe the cache-bus for cluster
  // hot-reload. Must run AFTER initCacheBus. Register the onRequest hook
  // only when the enterprise feature flag is on — CE builds and EE builds
  // without the feature never pay the per-request cost.
  //
  // Hook-ordering note: the plan (.plans/111-ip-allowlist.md §0.1 / §1.6)
  // calls for registering this hook BEFORE authPlugin so JWT decode never
  // runs for blocked IPs. This file registers it AFTER authPlugin, which
  // is functionally equivalent because authPlugin only decorates Fastify
  // with `authenticate` / `requireAdmin` — it does NOT install a global
  // onRequest hook. The only global onRequest hooks in the chain are
  // correlationIdPlugin (above) and ipAllowlistHook (here), so a blocked
  // IP short-circuits with 403 before any per-route `authenticate`
  // preHandler runs. No JWT decode, no business logic, same result.
  await initIpAllowlistService();
  if (enterprise.isFeatureEnabled(ENTERPRISE_FEATURES.IP_ALLOWLISTING, license)) {
    await app.register(ipAllowlistHook);
    logger.info('IP allowlist hook registered (enterprise feature active)');
  }

  // Sync-conflict policy cache (Compendiq/compendiq-ee#118). Always
  // initialised — CE-only deployments use the default 'confluence-wins'
  // value, which preserves the legacy sync behaviour. The EE overlay's
  // PUT handler writes to admin_settings + publishes on the cache-bus;
  // CE pods receive the invalidation and re-read just like any other
  // pod. The cold-load happens here before sync workers can run.
  await initSyncConflictPolicyService();

  // ── LLM Provider Bootstrap ───────────────────────────────────────
  // Seed llm_providers from env on fresh installs, rewrite the Ollama
  // sentinel if OLLAMA_BASE_URL changed, and allowlist every provider
  // URL with the SSRF guard. Runs after migrations (index.ts) so the
  // llm_providers table exists.
  await bootstrapLlmProviders();

  // ── Confluence URL SSRF Allowlist Bootstrap (issue #306) ─────────
  // Read every user-configured Confluence URL into the local allowlist.
  // Uses the silent variant internally so starting a pod does not flood
  // the pub/sub channel with N redundant add events (other pods already
  // populated their sets from the same DB rows on their own boot).
  await bootstrapSsrfAllowlist();

  // Known Fastify HTTP error names that are safe to expose to clients.
  // Anything not in this set could leak internal details (e.g. TypeError, RangeError).
  const KNOWN_HTTP_ERROR_NAMES = new Set([
    'BadRequestError',
    'UnauthorizedError',
    'ForbiddenError',
    'NotFoundError',
    'MethodNotAllowedError',
    'NotAcceptableError',
    'ConflictError',
    'GoneError',
    'PayloadTooLargeError',
    'UnsupportedMediaTypeError',
    'UnprocessableEntityError',
    'TooManyRequestsError',
    'ServiceUnavailableError',
    'GatewayTimeoutError',
  ]);

  /** Map status code range to a generic error name when the real name is not safe to expose. */
  function safeErrorName(statusCode: number, errorName?: string): string {
    if (statusCode === 500) return 'InternalServerError';
    if (errorName && KNOWN_HTTP_ERROR_NAMES.has(errorName)) return errorName;
    // Generic fallback based on status code range
    if (statusCode >= 400 && statusCode < 500) return 'ClientError';
    return 'InternalServerError';
  }

  // Error handler
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    // Zod validation errors → 400
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: 'ValidationError',
        message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        statusCode: 400,
      });
      return;
    }

    const statusCode = error.statusCode ?? 500;

    // Log auth errors at warn level to reduce noise from expected 401/403 responses
    if (statusCode === 401 || statusCode === 403) {
      logger.warn({ err: error }, 'Auth error');
    } else {
      logger.error({ err: error }, 'Request error');
    }

    // Auto-track 500 errors in the database
    if (statusCode === 500) {
      trackError(error, {
        userId: request.userId,
        requestPath: `${request.method} ${request.url}`,
        correlationId: (request.headers as Record<string, string>)['x-correlation-id'],
      });
    }

    reply.status(statusCode).send({
      error: safeErrorName(statusCode, error.name),
      message: statusCode === 500 ? 'Internal Server Error' : error.message,
      statusCode,
    });
  });

  // Foundation routes
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(adminEmbeddingLocksRoutes, { prefix: '/api' });
  await app.register(adminIpAllowlistRoutes, { prefix: '/api' });
  await app.register(rbacRoutes, { prefix: '/api' });
  await app.register(adminUsersRoutes, { prefix: '/api' });

  // Community-mode license endpoint fallback.
  // Skip if the enterprise plugin registered its own richer version via registerRoutes().
  if (enterprise.version === 'community') {
    app.get('/api/admin/license', { onRequest: [app.requireAdmin] }, async () => ({
      edition: 'community',
      tier: 'community',
      valid: true,
      features: [],
    }));
  }

  // ── Conditional Enterprise Route Registration ────────────────────
  // OIDC routes would be registered here when the enterprise plugin
  // enables the OIDC_SSO feature. The OIDC code itself lives in the
  // open repo but is only activated with a valid enterprise license.
  //
  // if (enterprise.isFeatureEnabled(ENTERPRISE_FEATURES.OIDC_SSO, license)) {
  //   const { oidcRoutes } = await import('./routes/foundation/oidc.js');
  //   await app.register(oidcRoutes, { prefix: '/api' });
  //   logger.info('OIDC routes registered (enterprise license active)');
  // }

  // Confluence routes
  await app.register(spacesRoutes, { prefix: '/api' });
  await app.register(syncRoutes, { prefix: '/api' });
  await app.register(attachmentRoutes, { prefix: '/api' });

  // LLM routes
  await app.register(llmImproveRoutes, { prefix: '/api' });
  await app.register(llmGenerateRoutes, { prefix: '/api' });
  await app.register(llmSummarizeRoutes, { prefix: '/api' });
  await app.register(llmDiagramRoutes, { prefix: '/api' });
  await app.register(llmQualityRoutes, { prefix: '/api' });
  await app.register(llmAskRoutes, { prefix: '/api' });
  await app.register(llmConversationRoutes, { prefix: '/api' });
  await app.register(llmEmbeddingRoutes, { prefix: '/api' });
  await app.register(llmModelRoutes, { prefix: '/api' });
  await app.register(llmAdminRoutes, { prefix: '/api' });
  await app.register(llmProviderRoutes, { prefix: '/api' });
  await app.register(llmUsecaseRoutes, { prefix: '/api' });
  await app.register(llmEmbeddingReembedRoutes, { prefix: '/api' });
  await app.register(llmEmbeddingProbeRoutes, { prefix: '/api' });
  await app.register(llmPdfRoutes, { prefix: '/api' });

  // Knowledge routes
  await app.register(pagesCrudRoutes, { prefix: '/api' });
  await app.register(pagesPresenceRoutes, { prefix: '/api' });
  await app.register(pagesVersionRoutes, { prefix: '/api' });
  await app.register(pagesTagRoutes, { prefix: '/api' });
  await app.register(pagesEmbeddingRoutes, { prefix: '/api' });
  await app.register(pagesDuplicateRoutes, { prefix: '/api' });
  await app.register(pinnedPagesRoutes, { prefix: '/api' });
  await app.register(analyticsRoutes, { prefix: '/api' });
  await app.register(knowledgeAdminRoutes, { prefix: '/api' });
  await app.register(templateRoutes, { prefix: '/api' });
  await app.register(pagesExportRoutes, { prefix: '/api' });
  await app.register(commentsRoutes, { prefix: '/api' });
  await app.register(pagesImportRoutes, { prefix: '/api' });
  await app.register(contentAnalyticsRoutes, { prefix: '/api' });
  await app.register(verificationRoutes, { prefix: '/api' });
  await app.register(notificationRoutes, { prefix: '/api' });
  await app.register(setupRoutes, { prefix: '/api' });
  await app.register(knowledgeRequestRoutes, { prefix: '/api' });
  await app.register(searchRoutes, { prefix: '/api' });
  await app.register(localSpacesRoutes, { prefix: '/api' });
  await app.register(localAttachmentsRoutes, { prefix: '/api' });

  return app;
}
