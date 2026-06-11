/**
 * Shared seeders + Fastify bootstrap for knowledge-route tests that hit the
 * REAL test PostgreSQL (port 5433 via `test-db-helper.ts`).
 *
 * Extracted from `pages-tree-visibility.test.ts` /
 * `embedding-status-visibility.test.ts`, which duplicated this block verbatim
 * (review note on the UX-fixes plan). Module-level `vi.mock(...)` calls cannot
 * live here (vitest hoists them per test file), so each test file keeps its
 * own boundary mocks and passes a route-registration callback that performs
 * the dynamic import AFTER the mocks are in place.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import type { RedisClientType } from 'redis';
import { query } from '../../core/db/postgres.js';

// --- Seeders ---

export async function insertUser(username: string): Promise<string> {
  const res = await query<{ id: string }>(
    "INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id",
    [username, `${username}@test`],
  );
  return res.rows[0]!.id;
}

export async function insertLocalSpace(spaceKey: string, createdBy: string): Promise<void> {
  await query(
    `INSERT INTO spaces (space_key, space_name, source, created_by, last_synced)
     VALUES ($1, $1, 'local', $2, NOW())`,
    [spaceKey, createdBy],
  );
}

export async function insertStandalonePage(
  title: string,
  visibility: 'private' | 'shared',
  createdBy: string,
  spaceKey: string,
  opts: { dirty?: boolean; deletedAt?: Date } = {},
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (space_key, title, body_html, body_text, version, source,
                        visibility, created_by_user_id, embedding_dirty, embedding_status, deleted_at)
     VALUES ($1, $2, '<p>x</p>', 'x', 1, 'standalone', $3, $4, $5, 'not_embedded', $6)
     RETURNING id`,
    [spaceKey, title, visibility, createdBy, opts.dirty ?? false, opts.deletedAt ?? null],
  );
  return res.rows[0]!.id;
}

export async function insertConfluencePage(
  confluenceId: string,
  title: string,
  spaceKey: string,
  opts: { deletedAt?: Date } = {},
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                        body_storage, body_html, inherit_perms, embedding_dirty, deleted_at)
     VALUES ($1, 'confluence', $2, $3, 'text', '', '', TRUE, FALSE, $4)
     RETURNING id`,
    [confluenceId, spaceKey, title, opts.deletedAt ?? null],
  );
  return res.rows[0]!.id;
}

/** Insert `chunks` embedding rows for a page (zero vector, dims match schema). */
export async function insertEmbeddings(pageId: number, chunks: number): Promise<void> {
  const zeroVector = `[${new Array(1024).fill(0).join(',')}]`;
  for (let i = 0; i < chunks; i++) {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, $2, 'chunk', $3::vector, '{}')`,
      [pageId, i, zeroVector],
    );
  }
}

// --- App bootstrap ---

/**
 * Build a minimal Fastify app mirroring the production wiring the knowledge
 * routes rely on: @fastify/sensible, Zod-aware error handler, and auth
 * decorators that impersonate whichever user `getCurrentUserId()` returns.
 */
export async function buildKnowledgeTestApp(
  getCurrentUserId: () => string,
  registerRoutes: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed' });
    }
    return reply.status(error.statusCode ?? 500).send({ error: error.message });
  });
  app.decorate('authenticate', async (request: { userId: string }) => {
    request.userId = getCurrentUserId();
  });
  app.decorate('requireAdmin', async (request: { userId: string }) => {
    request.userId = getCurrentUserId();
  });
  // Routes under test never touch fastify.redis (the RedisCache boundary is
  // mocked per test file); the decoration only needs to exist.
  app.decorate('redis', {} as RedisClientType);
  await registerRoutes(app);
  await app.ready();
  return app;
}
