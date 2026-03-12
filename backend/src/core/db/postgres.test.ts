import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from './postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Database', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('should run migrations and have _migrations table', async () => {
    const result = await query<{ count: string }>('SELECT COUNT(*) as count FROM _migrations');
    expect(parseInt(result.rows[0].count, 10)).toBeGreaterThanOrEqual(8);
  });

  it('should have pgvector extension', async () => {
    const result = await query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it('should insert and query users', async () => {
    await truncateAllTables();

    await query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)",
      ['testuser', 'fakehash', 'admin'],
    );

    const result = await query<{ username: string; role: string }>(
      'SELECT username, role FROM users WHERE username = $1',
      ['testuser'],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].username).toBe('testuser');
    expect(result.rows[0].role).toBe('admin');
  });

  it('should support vector operations', async () => {
    const result = await query<{ distance: number }>(
      "SELECT '[1,2,3]'::vector(3) <=> '[4,5,6]'::vector(3) AS distance",
    );
    expect(result.rows[0].distance).toBeGreaterThan(0);
  });
});
