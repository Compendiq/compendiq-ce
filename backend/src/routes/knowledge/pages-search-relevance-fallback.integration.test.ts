/**
 * Integration test for the ILIKE fallback under `sort=relevance` (#862) —
 * `GET /api/pages?search=...&sort=relevance` against a REAL PostgreSQL.
 *
 * #862 production bug: when FTS (`ts_rank` + `plainto_tsquery`) returns zero
 * rows but the ILIKE fallback matches, the data query 500s with a bind
 * mismatch. Under `sort=relevance` the ORDER BY consumes an extra bind slot
 * (the ts_rank search term), but the fallback drops that ORDER BY param while
 * still passing the stale `paramIdx`, so LIMIT/OFFSET render one slot too high
 * relative to the (now shorter) value array. Postgres rejects the bind.
 *
 * A real DB is mandatory here: the sibling `page-filters.test.ts` mocks
 * `core/db/postgres.query`, and a mock silently accepts a mismatched
 * placeholder/value count, so it cannot reproduce the bind failure. The seed
 * page's tsvector lexeme is `confluence`, so `plainto_tsquery('confl')` does
 * NOT match (FTS total 0) but `%confl%` ILIKE matches the title — the exact
 * shape that triggered the 500.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';

// --- Boundary mocks (everything else is real) ---

vi.mock('../../core/services/redis-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/redis-cache.js')>()),
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/webhook-emit-hook.js', () => ({
  emitWebhookEvent: vi.fn(),
}));

vi.mock('../../domains/confluence/services/attachment-handler.js', () => ({
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
  syncDrawioAttachments: vi.fn().mockResolvedValue(undefined),
  syncImageAttachments: vi.fn().mockResolvedValue(undefined),
  getMissingAttachments: vi.fn().mockResolvedValue([]),
  writeAttachmentCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  processDirtyPages: vi.fn().mockResolvedValue(undefined),
  isProcessingUser: vi.fn().mockReturnValue(false),
  computePageRelationships: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../domains/knowledge/services/quality-worker.js', () => ({
  triggerQualityBatch: vi.fn().mockResolvedValue(undefined),
}));

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const mockGetClientForUser = vi.fn();
vi.mock('../../domains/confluence/services/sync-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../domains/confluence/services/sync-service.js')>();
  return {
    ...actual,
    getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
  };
});

const dbAvailable = await isDbAvailable();

let userId: string;

describe.skipIf(!dbAvailable)('GET /pages relevance ILIKE fallback bind mismatch (#862)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = userId;
    });
    app.decorate('requireAdmin', async (request: { userId: string }) => {
      request.userId = userId;
    });
    app.decorate('redis', {});
    const { pagesCrudRoutes } = await import('./pages-crud.js');
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    const res = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('rel_user', 'rel@test', 'x', 'user') RETURNING id",
    );
    userId = res.rows[0]!.id;
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

    // Seed a page whose stored tsvector lexeme is `confluence` (via the
    // trg_pages_tsv trigger + to_tsvector), so plainto_tsquery('confl') does
    // NOT match, but title/body ILIKE '%confl%' does.
    await query(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                          body_storage, body_html, inherit_perms)
       VALUES ('rel-1', 'confluence', 'DEV', 'Confluence Guide', 'confluence guide',
               '', '', TRUE)`,
    );
  });

  it('returns the fuzzy match instead of 500 when FTS misses but ILIKE hits (#862)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?search=confl&sort=relevance',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.fuzzyMatch).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Confluence Guide');
  });

  it('regression: the non-relevance fallback path keeps working (sort=title)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/pages?search=confl&sort=title',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.fuzzyMatch).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Confluence Guide');
  });
});
