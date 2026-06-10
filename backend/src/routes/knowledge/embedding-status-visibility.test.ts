/**
 * GET /api/llm/embedding-status — visibility scope against a REAL PostgreSQL.
 *
 * Regression: the dashboard KPI counts (Total Articles/Pages, Embedded Pages,
 * coverage %) only counted pages whose space_key was in the caller's RBAC
 * spaces, so standalone articles never counted — a regular user saw
 * "0 total" while their sidebar tree showed pages. The status counts must
 * apply the same visibility predicate as the pages tree/list routes:
 *   - Confluence pages from RBAC-accessible spaces
 *   - shared standalone articles (visible to all)
 *   - the caller's own private standalone articles
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

const mockGetUserAccessibleSpaces = vi.fn();
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const dbAvailable = await isDbAvailable();

// --- Fixtures ---

let userA: string;
let userB: string;
let currentUserId: string;

async function insertUser(username: string): Promise<string> {
  const res = await query<{ id: string }>(
    "INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id",
    [username, `${username}@test`],
  );
  return res.rows[0]!.id;
}

async function insertLocalSpace(spaceKey: string, createdBy: string): Promise<void> {
  await query(
    `INSERT INTO spaces (space_key, space_name, source, created_by, last_synced)
     VALUES ($1, $1, 'local', $2, NOW())`,
    [spaceKey, createdBy],
  );
}

async function insertStandalonePage(
  title: string,
  visibility: 'private' | 'shared',
  createdBy: string,
  spaceKey: string,
  opts: { dirty?: boolean } = {},
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (space_key, title, body_html, body_text, version, source,
                        visibility, created_by_user_id, embedding_dirty, embedding_status)
     VALUES ($1, $2, '<p>x</p>', 'x', 1, 'standalone', $3, $4, $5, 'not_embedded')
     RETURNING id`,
    [spaceKey, title, visibility, createdBy, opts.dirty ?? false],
  );
  return res.rows[0]!.id;
}

async function insertConfluencePage(confluenceId: string, title: string, spaceKey: string): Promise<void> {
  await query(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                        body_storage, body_html, inherit_perms, embedding_dirty)
     VALUES ($1, 'confluence', $2, $3, 'text', '', '', TRUE, FALSE)`,
    [confluenceId, spaceKey, title],
  );
}

/** Insert `chunks` embedding rows for a page (zero vector, dims match schema). */
async function insertEmbeddings(pageId: number, chunks: number): Promise<void> {
  const zeroVector = `[${new Array(1024).fill(0).join(',')}]`;
  for (let i = 0; i < chunks; i++) {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, $2, 'chunk', $3::vector, '{}')`,
      [pageId, i, zeroVector],
    );
  }
}

// --- Tests ---

describe.skipIf(!dbAvailable)('GET /api/llm/embedding-status — visibility scope (DB)', () => {
  let app: ReturnType<typeof Fastify>;

  async function statusAs(asUser: string): Promise<{
    totalPages: number;
    embeddedPages: number;
    dirtyPages: number;
    totalEmbeddings: number;
  }> {
    currentUserId = asUser;
    const response = await app.inject({ method: 'GET', url: '/api/llm/embedding-status' });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

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
      request.userId = currentUserId;
    });
    app.decorate('requireAdmin', async (request: { userId: string }) => {
      request.userId = currentUserId;
    });
    app.decorate('redis', {});
    const { knowledgeAdminRoutes } = await import('./knowledge-admin.js');
    await app.register(knowledgeAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    userA = await insertUser('embed_status_a');
    userB = await insertUser('embed_status_b');
    await insertLocalSpace('NOTES', userA);
    mockGetUserAccessibleSpaces.mockResolvedValue([]);
  });

  it("counts only B-visible pages for user B (shared note, not A's private one)", async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    const status = await statusAs(userB);
    expect(status.totalPages).toBe(1);
  });

  it('counts both standalone pages for their owner', async () => {
    await insertStandalonePage('Private note', 'private', userA, 'NOTES');
    await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');

    const status = await statusAs(userA);
    expect(status.totalPages).toBe(2);
  });

  it('limits Confluence pages to RBAC-accessible spaces', async () => {
    await insertConfluencePage('conf-dev', 'Dev page', 'DEV');
    await insertConfluencePage('conf-secret', 'Secret page', 'SECRET');
    mockGetUserAccessibleSpaces.mockResolvedValue(['DEV']);

    const status = await statusAs(userB);
    expect(status.totalPages).toBe(1);
  });

  it('scopes dirty, embedded-page and chunk counts to visible pages', async () => {
    const privateId = await insertStandalonePage('Private note', 'private', userA, 'NOTES', { dirty: true });
    const sharedId = await insertStandalonePage('Shared note', 'shared', userA, 'NOTES');
    await insertEmbeddings(privateId, 1);
    await insertEmbeddings(sharedId, 2);

    const asB = await statusAs(userB);
    expect(asB.totalPages).toBe(1);
    expect(asB.dirtyPages).toBe(0);
    expect(asB.embeddedPages).toBe(1);
    expect(asB.totalEmbeddings).toBe(2);

    const asA = await statusAs(userA);
    expect(asA.totalPages).toBe(2);
    expect(asA.dirtyPages).toBe(1);
    expect(asA.embeddedPages).toBe(2);
    expect(asA.totalEmbeddings).toBe(3);
  });
});
