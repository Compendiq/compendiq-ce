import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClientType;
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const client = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  }) as RedisClientType;

  client.on('error', (err) => {
    logger.error({ err }, 'Redis client error');
  });

  client.on('connect', () => {
    logger.info('Redis connected');
  });

  await client.connect();

  fastify.decorate('redis', client);

  fastify.addHook('onClose', async () => {
    await client.quit();
  });
});

export async function checkRedisConnection(redis: RedisClientType): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
