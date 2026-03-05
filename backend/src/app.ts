import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import correlationIdPlugin from './plugins/correlation-id.js';
import authPlugin from './plugins/auth.js';
import redisPlugin from './plugins/redis.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { settingsRoutes } from './routes/settings.js';
import { spacesRoutes } from './routes/spaces.js';
import { pagesRoutes } from './routes/pages.js';
import { syncRoutes } from './routes/sync.js';
import { attachmentRoutes } from './routes/attachments.js';
import { llmRoutes } from './routes/llm.js';
import { adminRoutes } from './routes/admin.js';
import { analyticsRoutes } from './routes/analytics.js';
import { ZodError } from 'zod';
import { trackError } from './services/error-tracker.js';
import { logger } from './utils/logger.js';

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

  // Routes
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(spacesRoutes, { prefix: '/api' });
  await app.register(pagesRoutes, { prefix: '/api' });
  await app.register(syncRoutes, { prefix: '/api' });
  await app.register(attachmentRoutes, { prefix: '/api' });
  await app.register(llmRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(analyticsRoutes, { prefix: '/api' });

  return app;
}
