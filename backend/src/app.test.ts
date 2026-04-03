import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mock all heavy dependencies before importing buildApp
vi.mock('./core/db/postgres.js', () => ({
  checkConnection: vi.fn().mockResolvedValue(true),
  getPool: vi.fn().mockReturnValue({}),
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('./core/plugins/redis.js', () => ({
  default: vi.fn(async (fastify: FastifyInstance) => {
    fastify.decorate('redis', {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn().mockResolvedValue({ cursor: '0', keys: [] }),
      keys: vi.fn().mockResolvedValue([]),
    });
  }),
  checkRedisConnection: vi.fn().mockResolvedValue(true),
}));

vi.mock('./core/plugins/auth.js', async () => {
  const { default: fp } = await import('fastify-plugin');
  return {
    default: fp(async (fastify: FastifyInstance) => {
      fastify.decorate('authenticate', vi.fn());
      fastify.decorate('requireAdmin', vi.fn());
    }),
  };
});

vi.mock('./core/plugins/correlation-id.js', () => ({
  default: vi.fn(async () => {}),
}));

vi.mock('./core/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
}));

vi.mock('./core/services/error-tracker.js', () => ({
  trackError: vi.fn(),
  listErrors: vi.fn(),
  resolveError: vi.fn(),
  getErrorSummary: vi.fn(),
}));

// Mock all route modules to avoid importing their dependencies
const noopRoute = vi.fn(async () => {});
vi.mock('./routes/foundation/health.js', () => ({ healthRoutes: noopRoute, markStartupComplete: vi.fn() }));
vi.mock('./routes/foundation/auth.js', () => ({ authRoutes: noopRoute }));
vi.mock('./routes/foundation/settings.js', () => ({ settingsRoutes: noopRoute }));
vi.mock('./routes/foundation/admin.js', () => ({ adminRoutes: noopRoute }));
vi.mock('./routes/foundation/rbac.js', () => ({ rbacRoutes: noopRoute }));
vi.mock('./routes/foundation/notifications.js', () => ({ notificationRoutes: noopRoute }));
vi.mock('./routes/confluence/spaces.js', () => ({ spacesRoutes: noopRoute }));
vi.mock('./routes/confluence/sync.js', () => ({ syncRoutes: noopRoute }));
vi.mock('./routes/confluence/attachments.js', () => ({ attachmentRoutes: noopRoute }));
vi.mock('./routes/llm/llm-improve.js', () => ({ llmImproveRoutes: noopRoute }));
vi.mock('./routes/llm/llm-generate.js', () => ({ llmGenerateRoutes: noopRoute }));
vi.mock('./routes/llm/llm-summarize.js', () => ({ llmSummarizeRoutes: noopRoute }));
vi.mock('./routes/llm/llm-diagram.js', () => ({ llmDiagramRoutes: noopRoute }));
vi.mock('./routes/llm/llm-quality.js', () => ({ llmQualityRoutes: noopRoute }));
vi.mock('./routes/llm/llm-ask.js', () => ({ llmAskRoutes: noopRoute }));
vi.mock('./routes/llm/llm-conversations.js', () => ({ llmConversationRoutes: noopRoute }));
vi.mock('./routes/llm/llm-embeddings.js', () => ({ llmEmbeddingRoutes: noopRoute }));
vi.mock('./routes/llm/llm-models.js', () => ({ llmModelRoutes: noopRoute }));
vi.mock('./routes/llm/llm-admin.js', () => ({ llmAdminRoutes: noopRoute }));
vi.mock('./routes/llm/llm-pdf.js', () => ({ llmPdfRoutes: noopRoute }));
vi.mock('./routes/knowledge/pages-crud.js', () => ({ pagesCrudRoutes: noopRoute }));
vi.mock('./routes/knowledge/pages-versions.js', () => ({ pagesVersionRoutes: noopRoute }));
vi.mock('./routes/knowledge/pages-tags.js', () => ({ pagesTagRoutes: noopRoute }));
vi.mock('./routes/knowledge/pages-embeddings.js', () => ({ pagesEmbeddingRoutes: noopRoute }));
vi.mock('./routes/knowledge/pages-duplicates.js', () => ({ pagesDuplicateRoutes: noopRoute }));
vi.mock('./routes/knowledge/pinned-pages.js', () => ({ pinnedPagesRoutes: noopRoute }));
vi.mock('./routes/knowledge/analytics.js', () => ({ analyticsRoutes: noopRoute }));
vi.mock('./routes/knowledge/knowledge-admin.js', () => ({ knowledgeAdminRoutes: noopRoute }));
vi.mock('./routes/knowledge/templates.js', () => ({ templateRoutes: noopRoute }));
vi.mock('./routes/knowledge/pages-export.js', () => ({ pagesExportRoutes: noopRoute }));
vi.mock('./routes/knowledge/comments.js', () => ({ commentsRoutes: noopRoute }));
vi.mock('./routes/knowledge/pages-import.js', () => ({ pagesImportRoutes: noopRoute }));
vi.mock('./routes/knowledge/content-analytics.js', () => ({ contentAnalyticsRoutes: noopRoute }));
vi.mock('./routes/knowledge/verification.js', () => ({ verificationRoutes: noopRoute }));
vi.mock('./routes/knowledge/knowledge-requests.js', () => ({ knowledgeRequestRoutes: noopRoute }));
vi.mock('./routes/knowledge/search.js', () => ({ searchRoutes: noopRoute }));
vi.mock('./routes/knowledge/local-spaces.js', () => ({ localSpacesRoutes: noopRoute }));

describe('buildApp — CORS multi-origin support', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = originalFrontendUrl;
    }
  });

  it('should default to http://localhost:5273 when FRONTEND_URL is unset', async () => {
    delete process.env.FRONTEND_URL;
    process.env.NODE_ENV = 'development';
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'http://localhost:5273' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5273');

    await app.close();
  });

  it('should accept a single custom origin', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    process.env.NODE_ENV = 'development';
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');

    await app.close();
  });

  it('should accept comma-separated origins', async () => {
    process.env.FRONTEND_URL = 'http://localhost:5273, https://app.example.com';
    process.env.NODE_ENV = 'development';
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    // First origin
    const res1 = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'http://localhost:5273' },
    });
    expect(res1.headers['access-control-allow-origin']).toBe('http://localhost:5273');

    // Second origin
    const res2 = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'https://app.example.com' },
    });
    expect(res2.headers['access-control-allow-origin']).toBe('https://app.example.com');

    // Unknown origin should not be reflected
    const res3 = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res3.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');

    await app.close();
  });
});

describe('buildApp — Swagger UI gating', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should register Swagger UI in development', async () => {
    process.env.NODE_ENV = 'development';
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/docs/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');

    await app.close();
  });

  it('should not register Swagger UI in production', async () => {
    process.env.NODE_ENV = 'production';
    const { buildApp } = await import('./app.js');
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/docs/' });
    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
