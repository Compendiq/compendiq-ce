import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import correlationIdPlugin from './correlation-id.js';
import { correlationStorage, getCorrelationId, createCorrelationLogger } from './correlation-id.js';

describe('correlation-id plugin', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(correlationIdPlugin);

    // Test route that returns correlation ID
    app.get('/test', async (request) => {
      return {
        correlationId: request.correlationId,
        fromStorage: getCorrelationId(),
      };
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should generate a correlation ID when none is provided', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.correlationId).toBeDefined();
    expect(body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Response header should contain the correlation ID
    expect(response.headers['x-correlation-id']).toBe(body.correlationId);
  });

  it('should use the provided X-Correlation-ID header', async () => {
    const customId = 'my-custom-correlation-id-123';
    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        'x-correlation-id': customId,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.correlationId).toBe(customId);
    expect(response.headers['x-correlation-id']).toBe(customId);
  });

  it('should generate unique IDs for different requests', async () => {
    const response1 = await app.inject({ method: 'GET', url: '/test' });
    const response2 = await app.inject({ method: 'GET', url: '/test' });

    const body1 = JSON.parse(response1.body);
    const body2 = JSON.parse(response2.body);

    expect(body1.correlationId).not.toBe(body2.correlationId);
  });

  it('should make correlation ID available via AsyncLocalStorage in handler', async () => {
    const customId = 'async-local-test-id';
    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        'x-correlation-id': customId,
      },
    });

    const body = JSON.parse(response.body);
    expect(body.fromStorage).toBe(customId);
  });
});

describe('createCorrelationLogger', () => {
  it('should create a child logger with correlationId binding', () => {
    const childLogger = createCorrelationLogger('test-corr-id');
    expect(childLogger).toBeDefined();
    // Pino child loggers have bindings accessible
    expect(typeof childLogger.info).toBe('function');
    expect(typeof childLogger.error).toBe('function');
  });
});

describe('correlationStorage', () => {
  it('should allow manual entry for background tasks via run()', async () => {
    let capturedId: string | undefined;

    // run() creates a new async context, unlike enterWith()
    await new Promise<void>((resolve) => {
      correlationStorage.run('background-task-id', () => {
        capturedId = getCorrelationId();
        resolve();
      });
    });

    // After run() completes, we are back in the outer context.
    // The outer context may still have a value from enterWith() (used by the plugin tests above),
    // so we verify the inner context captured the right value.
    expect(capturedId).toBe('background-task-id');
  });

  it('should isolate run() contexts from each other', async () => {
    const results: string[] = [];

    await Promise.all([
      new Promise<void>((resolve) => {
        correlationStorage.run('ctx-a', () => {
          results.push(`a:${getCorrelationId()}`);
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        correlationStorage.run('ctx-b', () => {
          results.push(`b:${getCorrelationId()}`);
          resolve();
        });
      }),
    ]);

    expect(results).toContain('a:ctx-a');
    expect(results).toContain('b:ctx-b');
  });
});
