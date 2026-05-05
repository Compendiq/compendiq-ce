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

// Mutable feature-flag state for the Phase D post-filter tests below.
// `isFeatureEnabled` is imported as a module binding in rag-service.ts, so
// we can't overwrite it after module load — we mock the whole loader here
// and flip a local flag in each test instead.
let ragPermissionEnforcementEnabled = false;
vi.mock('../../../core/enterprise/loader.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/enterprise/loader.js')>(
    '../../../core/enterprise/loader.js',
  );
  return {
    ...actual,
    isFeatureEnabled: (feature: string): boolean => {
      if (feature === 'rag_permission_enforcement') return ragPermissionEnforcementEnabled;
      return false;
    },
  };
});

// Import the functions under test AFTER the mocks above are registered.
const { hybridSearch, keywordSearch, vectorSearch } = await import('./rag-service.js');
// The logger is spied on below (Phase D overfetch tests) to read the
// `candidatesBeforeFilter` / `candidatesAfterFilter` counts without poking
// at the internal vectorSearch/keywordSearch calls — ES module bindings
// mean vi.spyOn(ragModule, 'vectorSearch') wouldn't intercept the internal
// call from hybridSearch anyway.
const { logger } = await import('../../../core/utils/logger.js');

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

  it('enforces standalone article visibility (shared + own-private, not others-private)', async () => {
    const userX = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const userY = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    // Insert both users so the FK on created_by_user_id is satisfied
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@t', 'user', 'x'),
              ($2::uuid, $2::text, $2::text || '@t', 'user', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [userX, userY],
    );
    // userX writes a private standalone article
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                          visibility, created_by_user_id)
       VALUES (gen_random_uuid()::text, 'standalone', NULL, 'Private note', 'confidential draft', '', '',
               'private', $1)
       RETURNING id`,
      [userX],
    );
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [
        page.rows[0]!.id,
        'confidential draft',
        pgvector.toSql(fakeVec(13)),
        JSON.stringify({ page_title: 'Private note', section_title: 'Private note', space_key: null }),
      ],
    );

    // userX can see their own private article
    const ownerHits = await hybridSearch(userX, 'confidential draft');
    expect(ownerHits.length).toBeGreaterThan(0);

    // userY cannot
    const intruderHits = await hybridSearch(userY, 'confidential draft');
    expect(intruderHits).toHaveLength(0);
  });

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

    // Positive counterpart: user B (who has the SECRET role from the fixture)
    // MUST still see the chunk. Without this, a bug that broke retrieval for
    // everyone would pass the zero-leak assertions above — we want to rule
    // out "retrieval is broken for everyone" as a false-positive pass.
    const ownerVectorHits = await vectorSearch(userB, fakeVec(7));
    const ownerKeywordHits = await keywordSearch(userB, 'launch codes');
    const ownerHybrid = await hybridSearch(userB, 'launch codes');

    expect(ownerVectorHits.length).toBeGreaterThan(0);
    expect(ownerKeywordHits.length).toBeGreaterThan(0);
    expect(ownerHybrid.length).toBeGreaterThan(0);
  });
});

// ─── Phase D: per-page ACL post-filter + 1.5x overfetch (issue #112) ────────
//
// These tests exercise the `rag_permission_enforcement` feature flag. When
// the flag is OFF the rag-service behaviour must be bit-identical to v0.3
// (same candidate pool, no ACE consultation). When the flag is ON, each
// candidate returned by RRF is gated through `userCanAccessPage`, and the
// per-stage fetch limit is bumped by 1.5x to compensate for the drops.
//
// Feature-flag plumbing: `isFeatureEnabled` is mocked above to read the
// local `ragPermissionEnforcementEnabled` variable, which each `it` block
// flips in its setup. `afterEach` resets it to `false` so a flaky test
// can't leak state.
describe.skipIf(!dbAvailable)('rag-service integration — per-page ACL post-filter (Phase D)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
         ('system_admin', 'System Administrator', TRUE, ARRAY['read','comment','edit','delete','manage','admin']),
         ('space_admin', 'Space Administrator', TRUE, ARRAY['read','comment','edit','delete','manage']),
         ('editor', 'Editor', TRUE, ARRAY['read','comment','edit','delete']),
         ('commenter', 'Commenter', TRUE, ARRAY['read','comment']),
         ('viewer', 'Viewer', TRUE, ARRAY['read'])
       ON CONFLICT (name) DO NOTHING`,
    );
    // Flush the Redis-backed RBAC cache between tests — otherwise a cached
    // "accessible spaces" set or admin bit from a previous test leaks into
    // the next one and the post-filter sees stale data. Phase C made this
    // change in sync-service.ts; we mirror the discipline here.
    const { invalidateRbacCache } = await import('../../../core/services/rbac-service.js');
    await invalidateRbacCache();
  });
  afterEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    ragPermissionEnforcementEnabled = false;
  });

  async function ensureUser(userId: string, role: 'admin' | 'user' = 'user'): Promise<void> {
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, $1::text, $1::text || '@test', $2, 'x')
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`,
      [userId, role],
    );
  }

  async function ensureSpaceAndViewerRole(userId: string, spaceKey: string): Promise<void> {
    await query(
      `INSERT INTO spaces (space_key, space_name) VALUES ($1, $1)
       ON CONFLICT (space_key) DO NOTHING`,
      [spaceKey],
    );
    const role = await query<{ id: number }>(`SELECT id FROM roles WHERE name = 'viewer'`);
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3)
       ON CONFLICT DO NOTHING`,
      [spaceKey, userId, role.rows[0]!.id],
    );
  }

  async function insertPage(opts: {
    spaceKey: string;
    title: string;
    bodyText: string;
    vec: number[];
    inheritPerms?: boolean;
  }): Promise<number> {
    const { spaceKey, title, bodyText, vec, inheritPerms = true } = opts;
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, inherit_perms)
       VALUES (gen_random_uuid()::text, 'confluence', $1, $2, $3, '', '', $4)
       RETURNING id`,
      [spaceKey, title, bodyText, inheritPerms],
    );
    const pageId = page.rows[0]!.id;
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [
        pageId,
        bodyText,
        pgvector.toSql(vec),
        JSON.stringify({ page_title: title, section_title: title, space_key: spaceKey }),
      ],
    );
    return pageId;
  }

  async function insertConfluenceReadAce(pageId: number, principalUserId: string): Promise<void> {
    await query(
      `INSERT INTO access_control_entries
         (resource_type, resource_id, principal_type, principal_id, permission, source, synced_at)
       VALUES ('page', $1, 'user', $2, 'read', 'confluence', NOW())
       ON CONFLICT (resource_type, resource_id, principal_type, principal_id, permission)
       DO UPDATE SET synced_at = EXCLUDED.synced_at, source = EXCLUDED.source`,
      [pageId, principalUserId],
    );
  }

  // Case 1: flag OFF == v0.3 behaviour (no ACE consultation, no overfetch).
  it('flag OFF — behaviour matches v0.3: ACEs on pages are ignored', async () => {
    ragPermissionEnforcementEnabled = false;

    const user = '11111111-1111-1111-1111-111111111111';
    const otherUser = '22222222-2222-2222-2222-222222222222';
    await ensureUser(user);
    await ensureUser(otherUser);
    await ensureSpaceAndViewerRole(user, 'OPS');

    const pageA = await insertPage({ spaceKey: 'OPS', title: 'Runbook A', bodyText: 'restart queue alpha', vec: fakeVec(7) });
    const pageB = await insertPage({
      spaceKey: 'OPS',
      title: 'Runbook B',
      bodyText: 'restart queue beta',
      vec: fakeVec(7),
      inheritPerms: false,
    });
    // Page B has an ACE for a DIFFERENT user — if the flag were ON, the
    // caller would be blocked. Flag OFF means this ACE is ignored entirely.
    await insertConfluenceReadAce(pageB, otherUser);

    const results = await hybridSearch(user, 'restart queue');
    const ids = results.map((r) => r.pageId).sort((a, b) => a - b);
    expect(ids).toContain(pageA);
    expect(ids).toContain(pageB);
  });

  // Case 2: space access but no page-read ACE → blocked from restricted chunks.
  it('flag ON — user with space access but NO page-read ACE is blocked from the restricted page', async () => {
    ragPermissionEnforcementEnabled = true;

    const user = '33333333-3333-3333-3333-333333333333';
    const otherUser = '44444444-4444-4444-4444-444444444444';
    await ensureUser(user);
    await ensureUser(otherUser);
    await ensureSpaceAndViewerRole(user, 'OPS');

    const pageA = await insertPage({ spaceKey: 'OPS', title: 'Public runbook', bodyText: 'restart queue alpha', vec: fakeVec(7) });
    const pageB = await insertPage({
      spaceKey: 'OPS',
      title: 'Restricted runbook',
      bodyText: 'restart queue beta',
      vec: fakeVec(7),
      inheritPerms: false,
    });
    // ACE grants read to `otherUser`, not `user`.
    await insertConfluenceReadAce(pageB, otherUser);

    const results = await hybridSearch(user, 'restart queue');
    const ids = results.map((r) => r.pageId);
    expect(ids).toContain(pageA);
    expect(ids).not.toContain(pageB);
  });

  // Case 3: explicit page-read ACE → user CAN retrieve restricted chunks.
  it('flag ON — user with explicit page-read ACE CAN retrieve the restricted page', async () => {
    ragPermissionEnforcementEnabled = true;

    const user = '55555555-5555-5555-5555-555555555555';
    await ensureUser(user);
    await ensureSpaceAndViewerRole(user, 'OPS');

    const pageA = await insertPage({ spaceKey: 'OPS', title: 'Public runbook', bodyText: 'restart queue alpha', vec: fakeVec(7) });
    const pageB = await insertPage({
      spaceKey: 'OPS',
      title: 'Restricted runbook',
      bodyText: 'restart queue beta',
      vec: fakeVec(7),
      inheritPerms: false,
    });
    // ACE grants read specifically to `user` on the restricted page.
    await insertConfluenceReadAce(pageB, user);

    const results = await hybridSearch(user, 'restart queue');
    const ids = results.map((r) => r.pageId);
    expect(ids).toContain(pageA);
    expect(ids).toContain(pageB);
  });

  // Case 4: inherited restriction — Phase C already resolved inheritance at
  // sync time, so on Page C we see the grandparent's effective user list
  // materialised as ACEs on Page C itself. Phase D does NOT walk ancestors.
  it('flag ON — inherited restriction (resolved at sync time) is enforced at retrieval', async () => {
    ragPermissionEnforcementEnabled = true;

    const userA = '66666666-6666-6666-6666-666666666666';
    const userB = '77777777-7777-7777-7777-777777777777';
    await ensureUser(userA);
    await ensureUser(userB);
    await ensureSpaceAndViewerRole(userA, 'OPS');
    await ensureSpaceAndViewerRole(userB, 'OPS');

    // Page C: no local restrictions authored against it, but Phase C wrote
    // ACEs reflecting an inherited grandparent restriction that allows only
    // userA. In this fixture we stamp the ACEs directly to mimic what Phase
    // C's computeEffectivePageReadRestrictions + sync would have produced.
    const pageC = await insertPage({
      spaceKey: 'OPS',
      title: 'Grandchild page',
      bodyText: 'launch sequence tango',
      vec: fakeVec(7),
      inheritPerms: false,
    });
    await insertConfluenceReadAce(pageC, userA);

    const resultsA = await hybridSearch(userA, 'launch sequence');
    expect(resultsA.map((r) => r.pageId)).toContain(pageC);

    const resultsB = await hybridSearch(userB, 'launch sequence');
    expect(resultsB.map((r) => r.pageId)).not.toContain(pageC);
  });

  // Case 5: standalone pages are unaffected by the ACL post-filter.
  it('flag ON — standalone (non-Confluence) shared pages are not blocked', async () => {
    ragPermissionEnforcementEnabled = true;

    const user = '88888888-8888-8888-8888-888888888888';
    await ensureUser(user);

    const standalone = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                          visibility, created_by_user_id)
       VALUES (gen_random_uuid()::text, 'standalone', NULL, 'Shared note', 'public handbook content', '', '',
               'shared', $1)
       RETURNING id`,
      [user],
    );
    const standaloneId = standalone.rows[0]!.id;
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [
        standaloneId,
        'public handbook content',
        pgvector.toSql(fakeVec(7)),
        JSON.stringify({ page_title: 'Shared note', section_title: 'Shared note', space_key: null }),
      ],
    );

    const results = await hybridSearch(user, 'public handbook');
    expect(results.map((r) => r.pageId)).toContain(standaloneId);
  });

  // Case 6: admin bypass — restrictions don't apply to system admins.
  it('flag ON — admin users bypass the post-filter (all pages returned regardless of ACE)', async () => {
    ragPermissionEnforcementEnabled = true;

    const admin = '99999999-9999-9999-9999-999999999999';
    const nonExistentPrincipal = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    await ensureUser(admin, 'admin');
    await ensureUser(nonExistentPrincipal);
    // Admins don't need a space-role assignment — getUserAccessibleSpaces
    // returns every known space for admin users. But we still seed the
    // space row so the FK on pages.space_key resolves.
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('OPS', 'OPS') ON CONFLICT DO NOTHING`);

    const pageA = await insertPage({ spaceKey: 'OPS', title: 'Wide open', bodyText: 'alpha content', vec: fakeVec(7) });
    const pageB = await insertPage({
      spaceKey: 'OPS',
      title: 'Restricted to someone else',
      bodyText: 'beta content',
      vec: fakeVec(7),
      inheritPerms: false,
    });
    await insertConfluenceReadAce(pageB, nonExistentPrincipal);

    const results = await hybridSearch(admin, 'alpha beta content');
    const ids = results.map((r) => r.pageId);
    expect(ids).toContain(pageA);
    expect(ids).toContain(pageB);
  });

  // Case 7: overfetch compensation delivers topK after filtering.
  //
  // Seed 15 keyword-matching pages. 5 are restricted to a different user, 10
  // are readable by `user`. With topK=10 and ACE enforcement ON, the stage
  // limit is ceil(10*1.5) = 15, so all 15 candidates reach the filter; the
  // filter drops 5; exactly 10 results come back.
  //
  // Reality note: keyword search shares rows with vector search, and RRF
  // merges on pageId, so the candidate pool that reaches the post-filter
  // is the union of both stages — seeding 15 matching pages means up to 15
  // unique pageIds reach the filter. What we care about is the invariant
  // "readable pages ≥ topK after filtering", which we assert directly.
  it('flag ON — overfetch compensation produces topK results after filter', async () => {
    ragPermissionEnforcementEnabled = true;

    const user = 'abababab-abab-abab-abab-abababababab';
    const blockedBy = 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd';
    await ensureUser(user);
    await ensureUser(blockedBy);
    await ensureSpaceAndViewerRole(user, 'BULK');

    const readableIds: number[] = [];
    const blockedIds: number[] = [];
    for (let i = 0; i < 15; i++) {
      const restricted = i < 5;
      const pageId = await insertPage({
        spaceKey: 'BULK',
        title: `Bulk page ${i}`,
        bodyText: `overfetch candidate ${i} common-keyword`,
        vec: fakeVec(7 + i * 0.001),
        // Restricted pages set inherit_perms=false so userCanAccessPage
        // consults the ACE branch (grants read only to blockedBy).
        // Unrestricted pages keep inherit_perms=true (default) so the
        // space-level check on BULK applies and the caller is allowed.
        inheritPerms: !restricted,
      });
      if (restricted) {
        await insertConfluenceReadAce(pageId, blockedBy);
        blockedIds.push(pageId);
      } else {
        readableIds.push(pageId);
      }
    }

    const results = await hybridSearch(user, 'common-keyword', 10);
    const ids = results.map((r) => r.pageId);
    expect(ids.length).toBe(10);
    for (const rid of ids) {
      expect(blockedIds).not.toContain(rid);
    }
  });

  // Case 8: stage fetch limit is ceil(topK * 1.5) when ON, default (no
  // explicit limit) when OFF. We verify via the pre-filter candidate count
  // logged by the post-filter branch. For the OFF branch we assert on
  // return-count stability instead, since the OFF branch doesn't log the
  // pre-filter count (it doesn't run the filter at all).
  it.each([
    { topK: 10, expectedCeil: 15 },
    { topK: 7, expectedCeil: 11 },
    { topK: 1, expectedCeil: 2 },
  ])('flag ON — stage fetch limit = ceil(topK * 1.5) [topK=$topK]', async ({ topK, expectedCeil }) => {
    ragPermissionEnforcementEnabled = true;

    const user = 'feedface-feed-face-feed-facefeedface';
    await ensureUser(user);
    await ensureSpaceAndViewerRole(user, 'LIM');

    // Seed enough candidates that the stage limit (not the seeded-row
    // count) is the binding constraint. 30 matching pages >> any topK * 1.5
    // we test.
    for (let i = 0; i < 30; i++) {
      await insertPage({
        spaceKey: 'LIM',
        title: `Limit page ${i}`,
        bodyText: `overfetch ceil-check ${i}`,
        vec: fakeVec(7 + i * 0.001),
      });
    }

    const debugSpy = vi.spyOn(logger, 'debug');
    await hybridSearch(user, 'ceil-check', topK);

    // The post-filter debug log records the pre-filter candidate count.
    // Since RRF dedupes by pageId and all 30 pages are unique, the vector
    // stage and keyword stage each contribute up to `ceil(topK*1.5)` rows
    // but they overlap, so the post-filter sees between ceil(topK*1.5) and
    // 2*ceil(topK*1.5) candidates. We assert:
    //   (a) candidatesBeforeFilter >= ceil(topK * 1.5)   (overfetch ran)
    //   (b) candidatesBeforeFilter <= 2 * ceil(topK * 1.5) (no more than
    //       both stages combined)
    const debugCalls = debugSpy.mock.calls.filter((c) => {
      const payload = c[0] as Record<string, unknown> | undefined;
      return payload && typeof payload === 'object' && 'candidatesBeforeFilter' in payload;
    });
    expect(debugCalls.length).toBeGreaterThan(0);
    const payload = debugCalls[0]![0] as { candidatesBeforeFilter: number };
    expect(payload.candidatesBeforeFilter).toBeGreaterThanOrEqual(expectedCeil);
    expect(payload.candidatesBeforeFilter).toBeLessThanOrEqual(2 * expectedCeil);
  });

  it('flag OFF — stage fetch limit is the v0.3 default (10), not topK', async () => {
    ragPermissionEnforcementEnabled = false;

    const user = 'deaddead-dead-dead-dead-deaddeaddead';
    await ensureUser(user);
    await ensureSpaceAndViewerRole(user, 'LIM');

    // Seed 12 matching pages (more than v0.3 default 10, but a small topK
    // below default). With the flag OFF, the stages must still pull 10
    // candidates each (v0.3 default), so slice(0, topK=3) returns 3.
    for (let i = 0; i < 12; i++) {
      await insertPage({
        spaceKey: 'LIM',
        title: `Limit page ${i}`,
        bodyText: `overfetch ceil-check ${i}`,
        vec: fakeVec(7 + i * 0.001),
      });
    }

    const results = await hybridSearch(user, 'ceil-check', 3);
    // With flag OFF: both stages fetch up to 10 candidates each (v0.3
    // default), RRF merges by pageId, slice(0,3) returns 3. Diverges from
    // the brief's "topK exactly" wording on purpose — the brief's
    // competing constraint "behaviour MUST match v0.3 exactly when OFF"
    // wins, because passing `topK` would halve the candidate pool (default
    // 10 → user's topK, often ≤5) and hurt recall. See the design-notes
    // section in the PR description / commit body.
    expect(results).toHaveLength(3);
    // Extra check: the post-filter debug log should NOT appear in the OFF
    // branch (the filter is never invoked).
    const debugSpy = vi.spyOn(logger, 'debug');
    await hybridSearch(user, 'ceil-check', 3);
    const filterLogs = debugSpy.mock.calls.filter((c) => {
      const payload = c[0] as Record<string, unknown> | undefined;
      return payload && typeof payload === 'object' && 'candidatesBeforeFilter' in payload;
    });
    expect(filterLogs).toHaveLength(0);
  });

  // Case 9: post-filter preserves RRF rank order.
  it('flag ON — post-filter preserves RRF rank order (drops blocked, keeps order)', async () => {
    ragPermissionEnforcementEnabled = true;

    const user = 'ba5eba11-ba5e-ba11-ba5e-ba11ba11ba11';
    const blockedBy = 'b10cb10c-b10c-b10c-b10c-b10cb10cb10c';
    await ensureUser(user);
    await ensureUser(blockedBy);
    await ensureSpaceAndViewerRole(user, 'RANK');

    // We arrange three pages such that the RRF merge yields a stable order
    // [P1, P2, P3]. Since RRF rank-based (not score-based) and the vector
    // stage orders by cosine-distance, we use distinct vectors with known
    // similarity to the query vector fakeVec(7). fakeVec is deterministic,
    // so identical vectors yield identical ranks; we seed with slight
    // offsets to force a strict ordering.
    const p1 = await insertPage({
      spaceKey: 'RANK',
      title: 'Rank 1',
      bodyText: 'ranking probe aardvark',
      vec: fakeVec(7), // identical to query — best cosine match
    });
    const p2 = await insertPage({
      spaceKey: 'RANK',
      title: 'Rank 2',
      bodyText: 'ranking probe bear',
      vec: fakeVec(7.1), // slightly off — second best
      inheritPerms: false,
    });
    await insertConfluenceReadAce(p2, blockedBy); // blocked
    const p3 = await insertPage({
      spaceKey: 'RANK',
      title: 'Rank 3',
      bodyText: 'ranking probe coyote',
      vec: fakeVec(7.3), // further off — third
    });

    const results = await hybridSearch(user, 'ranking probe', 10);
    const ids = results.map((r) => r.pageId);
    // P2 blocked, so only [P1, P3] survive in that exact order.
    expect(ids).toEqual([p1, p3]);
  });
});
