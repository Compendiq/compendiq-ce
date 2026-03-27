/**
 * Unit tests for embedding-service.ts Redis-backed lastEmbeddingRunAt.
 *
 * Tests specifically the getLastEmbeddingRunAt / setLastEmbeddingRunAt
 * behavior exposed through getEmbeddingStatus and processDirtyPages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../core/db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [{ count: '0' }], rowCount: 0 }),
  getPool: vi.fn().mockReturnValue({ connect: vi.fn() }),
}));

vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['SPACE1']),
}));

vi.mock('../../../core/services/admin-settings-service.js', () => ({
  getSharedLlmSettings: vi.fn().mockResolvedValue({ embeddingModel: 'nomic-embed-text', llmProvider: 'ollama' }),
}));

vi.mock('../../../core/services/circuit-breaker.js', () => ({
  CircuitBreakerOpenError: class extends Error {},
  ollamaBreakers: { embed: { getStatus: () => ({ nextRetryTime: null }) } },
  openaiBreakers: { embed: { getStatus: () => ({ nextRetryTime: null }) } },
}));

vi.mock('./llm-provider.js', () => ({
  providerGenerateEmbedding: vi.fn().mockResolvedValue([[0.1, 0.2]]),
}));

vi.mock('../../../core/services/content-converter.js', () => ({
  htmlToText: vi.fn().mockReturnValue('some text'),
}));

vi.mock('pgvector', () => ({
  default: { toSql: vi.fn().mockReturnValue('[0.1,0.2]') },
}));

// Redis mock
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisExists = vi.fn();
const mockRedisEval = vi.fn();
const mockRedisDel = vi.fn();

let mockRedisClient: Record<string, unknown> | null = null;

vi.mock('../../../core/services/redis-cache.js', () => ({
  getRedisClient: () => mockRedisClient,
  invalidateGraphCache: vi.fn(),
  acquireEmbeddingLock: vi.fn().mockResolvedValue('lock-id-123'),
  releaseEmbeddingLock: vi.fn(),
  isEmbeddingLocked: vi.fn().mockResolvedValue(false),
}));

import { getEmbeddingStatus } from './embedding-service.js';
import { query } from '../../../core/db/postgres.js';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('embedding-service Redis lastEmbeddingRunAt', () => {
  beforeEach(() => {
    mockRedisClient = {
      get: mockRedisGet,
      set: mockRedisSet,
      exists: mockRedisExists,
      eval: mockRedisEval,
      del: mockRedisDel,
      setEx: vi.fn(),
      scan: vi.fn(),
      incr: vi.fn(),
      expire: vi.fn(),
      ping: vi.fn(),
    };
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisExists.mockReset();
    mockRedisEval.mockReset();
    mockRedisDel.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('getEmbeddingStatus reads lastRunAt from Redis key embedding:last_run_at', async () => {
    const isoDate = '2025-06-15T12:00:00.000Z';
    mockRedisGet.mockResolvedValue(isoDate);
    mockRedisExists.mockResolvedValue(0);

    // Mock all the parallel queries
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ count: '10' }], rowCount: 1, command: '', oid: 0, fields: [] }) // totalResult
      .mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1, command: '', oid: 0, fields: [] }) // dirtyResult
      .mockResolvedValueOnce({ rows: [{ count: '50' }], rowCount: 1, command: '', oid: 0, fields: [] }) // embeddingResult
      .mockResolvedValueOnce({ rows: [{ count: '8' }], rowCount: 1, command: '', oid: 0, fields: [] }); // embeddedPagesResult

    const status = await getEmbeddingStatus('user-1');

    // Verify Redis was queried for the last run timestamp
    expect(mockRedisGet).toHaveBeenCalledWith('embedding:last_run_at');
    expect(status.lastRunAt).toBe(isoDate);
    expect(status.totalPages).toBe(10);
    expect(status.dirtyPages).toBe(2);
  });

  it('getEmbeddingStatus returns null lastRunAt when Redis key does not exist', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockRedisExists.mockResolvedValue(0);

    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1, command: '', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1, command: '', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '20' }], rowCount: 1, command: '', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1, command: '', oid: 0, fields: [] });

    const status = await getEmbeddingStatus('user-2');

    expect(status.lastRunAt).toBeNull();
  });

  it('getEmbeddingStatus returns null lastRunAt when Redis is unavailable', async () => {
    mockRedisClient = null;

    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1, command: '', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1, command: '', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '20' }], rowCount: 1, command: '', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1, command: '', oid: 0, fields: [] });

    const status = await getEmbeddingStatus('user-3');

    expect(status.lastRunAt).toBeNull();
  });

  it('getEmbeddingStatus returns null lastRunAt when Redis throws', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis timeout'));
    mockRedisExists.mockResolvedValue(0);

    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1, command: '', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1, command: '', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '20' }], rowCount: 1, command: '', oid: 0, fields: [] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1, command: '', oid: 0, fields: [] });

    const status = await getEmbeddingStatus('user-4');

    // Should gracefully return null, not throw
    expect(status.lastRunAt).toBeNull();
  });
});
