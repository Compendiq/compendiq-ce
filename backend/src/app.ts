import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import correlationIdPlugin from './core/plugins/correlation-id.js';
import authPlugin from './core/plugins/auth.js';
import redisPlugin from './core/plugins/redis.js';
// Foundation routes
import { healthRoutes } from './routes/foundation/health.js';
import { authRoutes } from './routes/foundation/auth.js';
import { settingsRoutes } from './routes/foundation/settings.js';
import { adminRoutes } from './routes/foundation/admin.js';
// Confluence routes
import { spacesRoutes } from './routes/confluence/spaces.js';
import { syncRoutes } from './routes/confluence/sync.js';
import { attachmentRoutes } from './routes/confluence/attachments.js';
// LLM routes
import { llmChatRoutes } from './routes/llm/llm-chat.js';
import { llmConversationRoutes } from './routes/llm/llm-conversations.js';
import { llmEmbeddingRoutes } from './routes/llm/llm-embeddings.js';
import { llmModelRoutes } from './routes/llm/llm-models.js';
import { llmAdminRoutes } from './routes/llm/llm-admin.js';
// Knowledge routes
import { pagesCrudRoutes } from './routes/knowledge/pages-crud.js';
import { pagesVersionRoutes } from './routes/knowledge/pages-versions.js';
import { pagesTagRoutes } from './routes/knowledge/pages-tags.js';
import { pagesEmbeddingRoutes } from './routes/knowledge/pages-embeddings.js';
import { pagesDuplicateRoutes } from './routes/knowledge/pages-duplicates.js';
import { pinnedPagesRoutes } from './routes/knowledge/pinned-pages.js';
import { analyticsRoutes } from './routes/knowledge/analytics.js';
import { knowledgeAdminRoutes } from './routes/knowledge/knowledge-admin.js';

import { ZodError } from 'zod';
import { trackError } from './core/services/error-tracker.js';
import { logger } from './core/utils/logger.js';

export async function buildApp() {
  const app = Fastify({
    logger: false, // We use our own pino instance
    trustProxy: true,
  });

  // Zod type provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Core plugins
  await app.register(cors, {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:5273',
    credentials: true,
  });

  await app.register(sensible);
  await app.register(cookie);
  await app.register(compress);

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AI KB Creator API',
        version: '1.0.0',
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
  });

  // Custom plugins (correlation-id first so all subsequent requests have it)
  await app.register(correlationIdPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

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

    logger.error({ err: error }, 'Request error');
    const statusCode = error.statusCode ?? 500;

    // Auto-track 500 errors in the database
    if (statusCode === 500) {
      trackError(error, {
        userId: request.userId,
        requestPath: `${request.method} ${request.url}`,
        correlationId: (request.headers as Record<string, string>)['x-correlation-id'],
      });
    }

    reply.status(statusCode).send({
      error: error.name ?? 'InternalServerError',
      message: statusCode === 500 ? 'Internal Server Error' : error.message,
      statusCode,
    });
  });

  // Foundation routes
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });

  // Confluence routes
  await app.register(spacesRoutes, { prefix: '/api' });
  await app.register(syncRoutes, { prefix: '/api' });
  await app.register(attachmentRoutes, { prefix: '/api' });

  // LLM routes
  await app.register(llmChatRoutes, { prefix: '/api' });
  await app.register(llmConversationRoutes, { prefix: '/api' });
  await app.register(llmEmbeddingRoutes, { prefix: '/api' });
  await app.register(llmModelRoutes, { prefix: '/api' });
  await app.register(llmAdminRoutes, { prefix: '/api' });

  // Knowledge routes
  await app.register(pagesCrudRoutes, { prefix: '/api' });
  await app.register(pagesVersionRoutes, { prefix: '/api' });
  await app.register(pagesTagRoutes, { prefix: '/api' });
  await app.register(pagesEmbeddingRoutes, { prefix: '/api' });
  await app.register(pagesDuplicateRoutes, { prefix: '/api' });
  await app.register(pinnedPagesRoutes, { prefix: '/api' });
  await app.register(analyticsRoutes, { prefix: '/api' });
  await app.register(knowledgeAdminRoutes, { prefix: '/api' });

  return app;
}
