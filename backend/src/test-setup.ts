import { afterAll } from 'vitest';
import { closePool } from './db/postgres.js';

// Set test environment variables
process.env.POSTGRES_URL = process.env.POSTGRES_TEST_URL ?? 'postgresql://kb_user:changeme-postgres@localhost:5433/kb_creator_test';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';
process.env.PAT_ENCRYPTION_KEY = 'test-pat-encryption-key-at-least-32-chars';
process.env.REDIS_URL = 'redis://:changeme-redis@localhost:6379';
process.env.OLLAMA_BASE_URL = 'http://localhost:11434';

afterAll(async () => {
  await closePool();
});
