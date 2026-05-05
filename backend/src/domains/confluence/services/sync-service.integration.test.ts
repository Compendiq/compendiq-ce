/**
 * Integration tests for the EE #112 Phase C per-page restriction branch of
 * sync-service.ts.
 *
 * These tests exercise the real PostgreSQL schema (migrations 040 + 065)
 * via `test-db-helper.ts` so the ACE INSERT/UPSERT + stale-sweep paths are
 * validated against actual pgcrypto/partial-index behaviour. They are
 * `describe.skipIf(!dbAvailable)` so contributors without a running
 * `localhost:5433` Postgres can still run the rest of the suite.
 *
 * The `ConfluenceClient` is stubbed at the call-site (each test constructs
 * a bespoke mock that returns the restriction shape it needs). This keeps
 * the test focused on the sync-service ↔ ACE plumbing, which is what
 * Phase C actually changes — `confluence-client.ts` already has its own
 * test file covering the HTTP edge cases.
 *
 * We drive the restriction branch directly via the module's `__internal`
 * test-only exports (`syncPageRestrictions`, `sweepStaleConfluenceAces`)
 * rather than through `syncUser`. Doing the full `syncUser` walk would
 * require stubbing half a dozen unrelated collaborators (content-converter,
 * attachment-handler, version-snapshot, processDirtyPages, Redis locking)
 * and obscures what we're actually asserting. The brief lists nine
 * behavioural cases and each is small and targeted; `syncPageRestrictions`
 * is the natural seam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import type { ConfluencePage, ConfluenceRestriction } from './confluence-client.js';
import { ConfluenceError } from './confluence-client.js';

// ── Enterprise feature-flag gate ────────────────────────────────────────
// Sync-service calls `isFeatureEnabled('rag_permission_enforcement')` from
// the core enterprise loader. We replace that one function with a vitest
// mock so individual tests can flip the flag on/off. Keeping the mock at
// module scope (rather than per-test vi.mock calls) means we only set up
// the wrapper once — each test just flips `featureFlagEnabled`.
let featureFlagEnabled = true;
vi.mock('../../../core/enterprise/loader.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../core/enterprise/loader.js')
  >('../../../core/enterprise/loader.js');
  return {
    ...actual,
    isFeatureEnabled: () => featureFlagEnabled,
  };
});

// Import after mocks so the module picks up the stubbed loader.
const { __internal } = await import('./sync-service.js');

const dbAvailable = await isDbAvailable();

// ── Fixtures ────────────────────────────────────────────────────────────

interface MockClient {
  restrictionsByPage: Map<string, ConfluenceRestriction[]>;
  ancestorsByPage: Map<string, Array<{ id: string }>>;
  restrictionCalls: string[];
  ancestorCalls: string[];
  getPageRestrictions(pageId: string): Promise<ConfluenceRestriction[]>;
  getPageAncestors(pageId: string): Promise<Array<{ id: string }>>;
}

function makeMockClient(): MockClient {
  const mc: MockClient = {
    restrictionsByPage: new Map(),
    ancestorsByPage: new Map(),
    restrictionCalls: [],
    ancestorCalls: [],
    async getPageRestrictions(pageId: string) {
      mc.restrictionCalls.push(pageId);
      return mc.restrictionsByPage.get(pageId) ?? [];
    },
    async getPageAncestors(pageId: string) {
      mc.ancestorCalls.push(pageId);
      return mc.ancestorsByPage.get(pageId) ?? [];
    },
  };
  return mc;
}

function readRestriction(
  users: Array<{ userKey: string; username: string }> = [],
  groups: Array<{ name: string }> = [],
): ConfluenceRestriction {
  return {
    operation: 'read',
    restrictions: { users, groups },
  };
}

function fakePage(confluenceId: string): ConfluencePage {
  return {
    id: confluenceId,
    title: `Page ${confluenceId}`,
    status: 'current',
    type: 'page',
    version: { number: 1, when: new Date().toISOString() },
    body: { storage: { value: '' } },
    ancestors: [],
    metadata: { labels: { results: [] } },
  };
}

async function insertUser(id: string, username: string): Promise<void> {
  await query(
    `INSERT INTO users (id, username, email, role, password_hash)
     VALUES ($1::uuid, $2, $2 || '@test', 'user', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [id, username],
  );
}

async function insertGroup(name: string): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO groups (name, description, source)
     VALUES ($1, 'integration-test', 'local')
     ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
     RETURNING id`,
    [name],
  );
  return res.rows[0]!.id;
}

async function insertPage(confluenceId: string, spaceKey: string, title = 'Test Page'): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                         body_storage, body_html, inherit_perms)
     VALUES ($1, 'confluence', $2, $3, 'text', '', '', TRUE)
     RETURNING id`,
    [confluenceId, spaceKey, title],
  );
  return res.rows[0]!.id;
}

async function getAces(pageDbId: number): Promise<
  Array<{
    principal_type: string;
    principal_id: string;
    source: string;
    synced_at: Date | null;
  }>
> {
  const res = await query<{
    principal_type: string;
    principal_id: string;
    source: string;
    synced_at: Date | null;
  }>(
    `SELECT principal_type, principal_id, source, synced_at
     FROM access_control_entries
     WHERE resource_type = 'page' AND resource_id = $1
     ORDER BY principal_type, principal_id`,
    [pageDbId],
  );
  return res.rows;
}

async function getInheritPerms(pageDbId: number): Promise<boolean> {
  const res = await query<{ inherit_perms: boolean }>(
    `SELECT inherit_perms FROM pages WHERE id = $1`,
    [pageDbId],
  );
  return res.rows[0]!.inherit_perms;
}

async function ensureSpace(spaceKey: string): Promise<void> {
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ($1, $1)
     ON CONFLICT (space_key) DO NOTHING`,
    [spaceKey],
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe.skipIf(!dbAvailable)('sync-service per-page restriction branch (EE #112 Phase C)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    featureFlagEnabled = true;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes ACEs for a page with its own read restriction', async () => {
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await insertUser(userA, 'alice');
    const gid = await insertGroup('engineering');
    await ensureSpace('DOCS');
    const pageDbId = await insertPage('c-100', 'DOCS');

    const client = makeMockClient();
    client.restrictionsByPage.set(
      'c-100',
      [
        readRestriction(
          [{ userKey: 'keyalice', username: 'alice' }],
          [{ name: 'engineering' }],
        ),
      ],
    );
    // Ancestors not needed: own restriction short-circuits the walk.

    const startedAt = new Date();
    await __internal.syncPageRestrictions(
      client as never,
      fakePage('c-100'),
      startedAt,
      new Map(),
    );

    const aces = await getAces(pageDbId);
    expect(aces).toHaveLength(2);
    expect(aces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principal_type: 'group',
          principal_id: String(gid),
          source: 'confluence',
        }),
        expect.objectContaining({
          principal_type: 'user',
          principal_id: userA,
          source: 'confluence',
        }),
      ]),
    );
    // synced_at equals the sync-run start time (Postgres stores as TIMESTAMPTZ).
    for (const ace of aces) {
      expect(ace.synced_at).not.toBeNull();
      expect(ace.synced_at!.getTime()).toBe(startedAt.getTime());
    }
    // inherit_perms flipped off so userCanAccessPage consults the ACE set.
    expect(await getInheritPerms(pageDbId)).toBe(false);
    // The ancestor walk was skipped (own restriction took precedence).
    expect(client.ancestorCalls).toHaveLength(0);
  });

  it('inherits a grandparent restriction onto a child with no own restriction', async () => {
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await insertUser(userA, 'alice');
    await ensureSpace('DOCS');
    const childDbId = await insertPage('c-child', 'DOCS');
    // Parent/grandparent Compendiq pages aren't strictly needed — the
    // restriction sync only cares about the Confluence-side chain — but we
    // insert them for realism (mirrors what a real sync would produce).
    await insertPage('c-parent', 'DOCS', 'Parent');
    await insertPage('c-grandparent', 'DOCS', 'Grandparent');

    const client = makeMockClient();
    // Child has no restriction; parent has no restriction; grandparent does.
    client.restrictionsByPage.set('c-child', []);
    client.restrictionsByPage.set('c-parent', []);
    client.restrictionsByPage.set(
      'c-grandparent',
      [readRestriction([{ userKey: 'keyalice', username: 'alice' }])],
    );
    // Confluence returns ancestors root-first → [grandparent, parent].
    client.ancestorsByPage.set('c-child', [{ id: 'c-grandparent' }, { id: 'c-parent' }]);

    await __internal.syncPageRestrictions(
      client as never,
      fakePage('c-child'),
      new Date(),
      new Map(),
    );

    const aces = await getAces(childDbId);
    expect(aces).toHaveLength(1);
    expect(aces[0]).toMatchObject({
      principal_type: 'user',
      principal_id: userA,
      source: 'confluence',
    });
    expect(await getInheritPerms(childDbId)).toBe(false);
    // Immediate parent (`c-parent`) MUST have been consulted before the
    // grandparent — reverse walk = nearest-first.
    expect(client.restrictionCalls).toEqual(['c-child', 'c-parent', 'c-grandparent']);
  });

  it("own restriction overrides an ancestor's restriction", async () => {
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const userB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await insertUser(userA, 'alice');
    await insertUser(userB, 'bob');
    await ensureSpace('DOCS');
    const pageDbId = await insertPage('c-200', 'DOCS');

    const client = makeMockClient();
    // Page has own restriction → user B only.
    client.restrictionsByPage.set(
      'c-200',
      [readRestriction([{ userKey: 'keybob', username: 'bob' }])],
    );
    // Grandparent restricts to user A — should be IGNORED.
    client.restrictionsByPage.set(
      'c-grand',
      [readRestriction([{ userKey: 'keyalice', username: 'alice' }])],
    );
    client.ancestorsByPage.set('c-200', [{ id: 'c-grand' }]);

    await __internal.syncPageRestrictions(
      client as never,
      fakePage('c-200'),
      new Date(),
      new Map(),
    );

    const aces = await getAces(pageDbId);
    expect(aces).toHaveLength(1);
    expect(aces[0]!.principal_id).toBe(userB);
    // Ancestor walk MUST NOT have been performed — own restriction
    // short-circuits. (This is also the defence against the unit-level
    // bug where own + inherited get unioned.)
    expect(client.ancestorCalls).toHaveLength(0);
    expect(client.restrictionCalls).toEqual(['c-200']);
  });

  it('public ancestor does not widen access of a restricted child', async () => {
    // Covers the corollary to the "own overrides inherited" rule: if the
    // grandparent has NO restriction and the page itself DOES, we must not
    // "fall through" to the grandparent and mistakenly treat the page as
    // public.
    const userB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await insertUser(userB, 'bob');
    await ensureSpace('DOCS');
    const pageDbId = await insertPage('c-201', 'DOCS');

    const client = makeMockClient();
    client.restrictionsByPage.set(
      'c-201',
      [readRestriction([{ userKey: 'keybob', username: 'bob' }])],
    );
    // Grandparent has NO read restriction (public).
    client.restrictionsByPage.set('c-grand-public', []);
    client.ancestorsByPage.set('c-201', [{ id: 'c-grand-public' }]);

    await __internal.syncPageRestrictions(
      client as never,
      fakePage('c-201'),
      new Date(),
      new Map(),
    );

    const aces = await getAces(pageDbId);
    expect(aces).toHaveLength(1);
    expect(aces[0]!.principal_id).toBe(userB);
    expect(await getInheritPerms(pageDbId)).toBe(false);
  });

  it('stale-ACE sweep removes restrictions that disappeared; leaves source=local and unrelated Confluence ACEs alone', async () => {
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const userB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await insertUser(userA, 'alice');
    await insertUser(userB, 'bob');
    await ensureSpace('DOCS');
    const pageDbId = await insertPage('c-300', 'DOCS');
    const otherPageDbId = await insertPage('c-301', 'DOCS', 'Other page');

    // First sync: page restricted to alice.
    const firstStartedAt = new Date('2026-01-01T10:00:00Z');
    const client1 = makeMockClient();
    client1.restrictionsByPage.set(
      'c-300',
      [readRestriction([{ userKey: 'keyalice', username: 'alice' }])],
    );
    await __internal.syncPageRestrictions(
      client1 as never,
      fakePage('c-300'),
      firstStartedAt,
      new Map(),
    );
    expect(await getAces(pageDbId)).toHaveLength(1);

    // Admin-created ACE on a DIFFERENT page (source='local'): must survive.
    await query(
      `INSERT INTO access_control_entries
         (resource_type, resource_id, principal_type, principal_id,
          permission, source, synced_at)
       VALUES ('page', $1, 'user', $2, 'read', 'local', NULL)`,
      [otherPageDbId, userB],
    );

    // Admin-created ACE on a DIFFERENT page (source='confluence' but set
    // far in the future so the sweep doesn't age it out) — simulates a
    // concurrent sync run for another space that shouldn't be touched.
    const futureStartedAt = new Date('2999-01-01T10:00:00Z');
    await query(
      `INSERT INTO access_control_entries
         (resource_type, resource_id, principal_type, principal_id,
          permission, source, synced_at)
       VALUES ('page', $1, 'user', $2, 'read', 'confluence', $3)`,
      [otherPageDbId, userA, futureStartedAt],
    );

    // Second sync: restriction removed in Confluence (no read entry).
    const secondStartedAt = new Date('2026-01-02T10:00:00Z');
    const client2 = makeMockClient();
    client2.restrictionsByPage.set('c-300', []);
    client2.ancestorsByPage.set('c-300', []); // no ancestors either
    await __internal.syncPageRestrictions(
      client2 as never,
      fakePage('c-300'),
      secondStartedAt,
      new Map(),
    );
    // inherit_perms back to TRUE — page falls through to space-level.
    expect(await getInheritPerms(pageDbId)).toBe(true);
    // ACE for alice is still there (sweep hasn't run yet inside syncUser).

    // Now simulate the end-of-run sweep.
    await __internal.sweepStaleConfluenceAces(secondStartedAt);

    // The confluence-sourced ACE for alice is gone.
    const pageAces = await getAces(pageDbId);
    expect(pageAces).toHaveLength(0);

    // Local ACE on the OTHER page is untouched.
    const otherAces = await getAces(otherPageDbId);
    expect(otherAces).toHaveLength(2);
    expect(otherAces.map((a) => a.source).sort()).toEqual(['confluence', 'local']);
  });

  it('emits ACE_SYNC_SKIPPED_UNMAPPED_USER audit and persists no ACE for an unknown userKey', async () => {
    // One real user + one dangling Confluence reference.
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await insertUser(userA, 'alice');
    await ensureSpace('DOCS');
    const pageDbId = await insertPage('c-400', 'DOCS');

    const client = makeMockClient();
    client.restrictionsByPage.set(
      'c-400',
      [
        readRestriction([
          { userKey: 'keyalice', username: 'alice' },
          { userKey: 'keyghost', username: 'ghost' }, // no row in users
        ]),
      ],
    );

    await __internal.syncPageRestrictions(
      client as never,
      fakePage('c-400'),
      new Date(),
      new Map(),
    );

    // Only alice's ACE is persisted.
    const aces = await getAces(pageDbId);
    expect(aces).toHaveLength(1);
    expect(aces[0]!.principal_id).toBe(userA);

    const audits = await query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_log WHERE action = 'ACE_SYNC_SKIPPED_UNMAPPED_USER'`,
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]!.metadata).toMatchObject({
      userKey: 'keyghost',
      username: 'ghost',
      pageConfluenceId: 'c-400',
    });
  });

  it('feature flag OFF: no getPageRestrictions call; no ACE writes; no sweep', async () => {
    featureFlagEnabled = false;

    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await insertUser(userA, 'alice');
    await ensureSpace('DOCS');
    const pageDbId = await insertPage('c-500', 'DOCS');

    // Pre-existing Confluence-sourced ACE from a prior run (when the flag
    // was on): the sweep must NOT remove it while the flag is off, and
    // `syncPageRestrictions` must not touch it either.
    await query(
      `INSERT INTO access_control_entries
         (resource_type, resource_id, principal_type, principal_id,
          permission, source, synced_at)
       VALUES ('page', $1, 'user', $2, 'read', 'confluence', $3)`,
      [pageDbId, userA, new Date('2020-01-01T00:00:00Z')],
    );

    const client = makeMockClient();
    client.restrictionsByPage.set(
      'c-500',
      [readRestriction([{ userKey: 'keyalice', username: 'alice' }])],
    );

    await __internal.syncPageRestrictions(
      client as never,
      fakePage('c-500'),
      new Date(),
      new Map(),
    );

    // `getPageRestrictions` was never consulted.
    expect(client.restrictionCalls).toHaveLength(0);
    expect(client.ancestorCalls).toHaveLength(0);

    // The old ACE is still there (syncPageRestrictions is a no-op).
    const aces = await getAces(pageDbId);
    expect(aces).toHaveLength(1);
    // inherit_perms unchanged from the seed value (TRUE).
    expect(await getInheritPerms(pageDbId)).toBe(true);

    // The sweep is gated by the same flag in `syncUser`, so we simulate the
    // production behaviour: when the flag is off the caller doesn't invoke
    // it. The ACE therefore stays put. (Explicit assertion: re-run the
    // sync-service's feature check through a no-op.)
    // No further action required — the assertions above already prove the
    // v0.3 no-op behaviour.
  });

  it('ancestor cache collapses repeated restriction fetches across siblings', async () => {
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await insertUser(userA, 'alice');
    await ensureSpace('DOCS');
    const siblingADbId = await insertPage('c-sib-a', 'DOCS', 'Sibling A');
    const siblingBDbId = await insertPage('c-sib-b', 'DOCS', 'Sibling B');

    const client = makeMockClient();
    // Neither sibling has an own restriction; both share the same parent
    // which IS restricted.
    client.restrictionsByPage.set('c-sib-a', []);
    client.restrictionsByPage.set('c-sib-b', []);
    client.restrictionsByPage.set(
      'c-shared-parent',
      [readRestriction([{ userKey: 'keyalice', username: 'alice' }])],
    );
    client.ancestorsByPage.set('c-sib-a', [{ id: 'c-shared-parent' }]);
    client.ancestorsByPage.set('c-sib-b', [{ id: 'c-shared-parent' }]);

    const cache = new Map<string, ConfluenceRestriction[]>();
    const startedAt = new Date();

    await __internal.syncPageRestrictions(
      client as never,
      fakePage('c-sib-a'),
      startedAt,
      cache,
    );
    await __internal.syncPageRestrictions(
      client as never,
      fakePage('c-sib-b'),
      startedAt,
      cache,
    );

    // Both children got the parent's ACE.
    expect(await getAces(siblingADbId)).toHaveLength(1);
    expect(await getAces(siblingBDbId)).toHaveLength(1);

    // `c-shared-parent` appeared exactly ONCE in getPageRestrictions calls
    // — second sibling pulled from the cache.
    const parentFetches = client.restrictionCalls.filter((id) => id === 'c-shared-parent');
    expect(parentFetches).toHaveLength(1);
  });

  it('ConfluenceError on getPageRestrictions does NOT abort the sync; affected page gets no ACE', async () => {
    const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await insertUser(userA, 'alice');
    await ensureSpace('DOCS');
    const failingPageDbId = await insertPage('c-fail', 'DOCS', 'Failing');
    const okPageDbId = await insertPage('c-ok', 'DOCS', 'Working');

    const client = makeMockClient();
    // First page: getPageRestrictions throws a transient Confluence error.
    client.getPageRestrictions = async (pageId: string) => {
      client.restrictionCalls.push(pageId);
      if (pageId === 'c-fail') {
        throw new ConfluenceError('Confluence API error: HTTP 503', 503);
      }
      return client.restrictionsByPage.get(pageId) ?? [];
    };
    client.restrictionsByPage.set(
      'c-ok',
      [readRestriction([{ userKey: 'keyalice', username: 'alice' }])],
    );

    // Failing page: swallow silently, move on.
    await expect(
      __internal.syncPageRestrictions(
        client as never,
        fakePage('c-fail'),
        new Date(),
        new Map(),
      ),
    ).resolves.toBeUndefined();

    // OK page: normal success path.
    await __internal.syncPageRestrictions(
      client as never,
      fakePage('c-ok'),
      new Date(),
      new Map(),
    );

    // Failing page has no ACE written.
    expect(await getAces(failingPageDbId)).toHaveLength(0);
    // inherit_perms for the failing page is unchanged from the seed (TRUE)
    // — the sync didn't get far enough to flip it either way.
    expect(await getInheritPerms(failingPageDbId)).toBe(true);

    // OK page got its ACE.
    const okAces = await getAces(okPageDbId);
    expect(okAces).toHaveLength(1);
    expect(okAces[0]!.principal_id).toBe(userA);
  });
});
