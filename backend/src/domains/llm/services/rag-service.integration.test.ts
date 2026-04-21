import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import pgvector from 'pgvector';

// Deterministic 1024-dim vector for fixtures and queries
function fakeVec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
}

// Stub the embedding provider so hybridSearch doesn't hit a real LLM
vi.mock('./openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('./openai-compatible-client.js')>(
    './openai-compatible-client.js',
  );
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => [fakeVec(7)]),
  };
});
vi.mock('./llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn(async () => ({
    config: {
      providerId: 'stub',
      id: 'stub',
      name: 'stub',
      baseUrl: '',
      apiKey: null,
      authType: 'none',
      verifySsl: true,
      defaultModel: 'stub',
    },
    model: 'stub',
  })),
}));

// Import the functions under test AFTER the mocks above are registered.
const { hybridSearch, keywordSearch, vectorSearch } = await import('./rag-service.js');

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('rag-service integration — space permission enforcement', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    // Re-seed system roles that migration 039 inserts on fresh install;
    // truncateAllTables wipes them, so restore the ones we reference below.
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
         ('system_admin', 'System Administrator', TRUE, ARRAY['read','comment','edit','delete','manage','admin']),
         ('space_admin', 'Space Administrator', TRUE, ARRAY['read','comment','edit','delete','manage']),
         ('editor', 'Editor', TRUE, ARRAY['read','comment','edit','delete']),
         ('commenter', 'Commenter', TRUE, ARRAY['read','comment']),
         ('viewer', 'Viewer', TRUE, ARRAY['read'])
       ON CONFLICT (name) DO NOTHING`,
    );
  });
  afterEach(async () => {
    vi.clearAllMocks();
  });

  async function seedSpaceWithPage(opts: {
    userId: string;
    spaceKey: string;
    roleName?: 'viewer' | 'space_admin' | 'editor' | 'commenter' | 'system_admin';
    pageTitle: string;
    bodyText: string;
    vec: number[];
  }): Promise<number> {
    const { userId, spaceKey, roleName = 'viewer', pageTitle, bodyText, vec } = opts;
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@test', 'user', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [userId],
    );
    await query(
      `INSERT INTO spaces (space_key, space_name) VALUES ($1, $1)
       ON CONFLICT (space_key) DO NOTHING`,
      [spaceKey],
    );
    const role = await query<{ id: number }>(
      `SELECT id FROM roles WHERE name = $1`,
      [roleName],
    );
    const roleId = role.rows[0]!.id;
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)
       ON CONFLICT DO NOTHING`,
      [spaceKey, userId, roleId],
    );
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html)
       VALUES (gen_random_uuid()::text, 'confluence', $1, $2, $3, '', '')
       RETURNING id`,
      [spaceKey, pageTitle, bodyText],
    );
    const pageId = page.rows[0]!.id;
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [
        pageId,
        bodyText,
        pgvector.toSql(vec),
        JSON.stringify({ page_title: pageTitle, section_title: pageTitle, space_key: spaceKey }),
      ],
    );
    return pageId;
  }

  it('reflects mid-conversation ACL revocation on the next retrieval', async () => {
    const user = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await seedSpaceWithPage({
      userId: user,
      spaceKey: 'OPS',
      pageTitle: 'Runbook',
      bodyText: 'restart the queue',
      vec: fakeVec(11),
    });

    // First retrieval: user has access, should see the page
    const first = await hybridSearch(user, 'restart queue');
    expect(first.length).toBeGreaterThan(0);

    // Revoke the role assignment and invalidate cache (this is what admin APIs do)
    await query(
      `DELETE FROM space_role_assignments
       WHERE space_key = $1 AND principal_id = $2`,
      ['OPS', user],
    );
    const { invalidateRbacCache } = await import('../../../core/services/rbac-service.js');
    await invalidateRbacCache(user);

    // Second retrieval: access should be gone
    const second = await hybridSearch(user, 'restart queue');
    expect(second).toHaveLength(0);
  });

  it('does not leak chunks from a space the caller has no role in', async () => {
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const userB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    // User B has synced space SECRET and has a page there
    await seedSpaceWithPage({
      userId: userB,
      spaceKey: 'SECRET',
      pageTitle: 'Secret plans',
      bodyText: 'launch codes and trade secrets',
      vec: fakeVec(7),
    });
    // User A must also exist as a row before we test their access
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@test', 'user', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [userA],
    );

    // User A has no role in SECRET — their readable set should be empty
    const vectorHits = await vectorSearch(userA, fakeVec(7));
    const keywordHits = await keywordSearch(userA, 'launch codes');
    const hybrid = await hybridSearch(userA, 'launch codes');

    expect(vectorHits).toHaveLength(0);
    expect(keywordHits).toHaveLength(0);
    expect(hybrid).toHaveLength(0);
  });
});
