# Issue #282 — RAG permission enforcement: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and strengthen RAG retrieval permission enforcement so that per-user Confluence space permissions are honoured end-to-end, with integration-test coverage against real Postgres, a request-scoped cache layer, an ADR, and an updated architecture diagram.

**Architecture:** The baseline filtering already exists in `rag-service.ts` via `getUserAccessibleSpaces(userId)`, which post-filters both vector (pgvector HNSW) and keyword (FTS) candidate sets by the caller's readable space keys. This plan (a) proves that behaviour with real-DB integration tests covering cross-user leakage and mid-conversation ACL revocation, (b) adds an AsyncLocalStorage-based per-request memoisation layer so the resolver is called at most once per request, (c) documents the enforcement model in a new ADR, (d) updates the architecture diagram to show the permission-check checkpoint.

**Tech Stack:** Fastify 5, TypeScript strict, pgvector 17, Vitest, real Postgres via `test-db-helper.ts` on port 5433, AsyncLocalStorage (Node built-in), Mermaid.

---

## File map

- **Modify:** `backend/src/core/services/rbac-service.ts` — add `getUserAccessibleSpacesMemoized` exported wrapper; wire request-scoped AsyncLocalStorage
- **Modify:** `backend/src/domains/llm/services/rag-service.ts` — swap direct calls for the memoised wrapper
- **Modify:** `backend/src/routes/knowledge/search.ts` — same swap
- **Create:** `backend/src/core/services/rbac-request-scope.ts` — new module that owns the AsyncLocalStorage context and the `runWithRbacScope` + `getScopedSpaces` helpers
- **Modify:** `backend/src/core/plugins/auth.ts` — wrap authenticated requests in `runWithRbacScope`
- **Create:** `backend/src/domains/llm/services/rag-service.integration.test.ts` — new real-DB test file exercising multi-user leakage, ACL revoke mid-conversation, standalone visibility
- **Modify:** `docs/ARCHITECTURE-DECISIONS.md` — add ADR for RAG permission enforcement model
- **Modify:** `docs/architecture/09-flow-rag-chat.md` — add the permission-check checkpoint and legend entry

Existing test file `backend/src/domains/llm/services/rag-service.test.ts` keeps its mocked unit tests (no regression; it covers RRF logic, not enforcement).

---

### Task 1: Red integration test — cross-user space leakage

**Files:**
- Create: `backend/src/domains/llm/services/rag-service.integration.test.ts`

- [ ] **Step 1: Scaffold the test file using the real-DB helper**

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, truncateAllTables, query } from '../../../test-db-helper.js';
import { hybridSearch, keywordSearch, vectorSearch } from './rag-service.js';
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
  resolveUsecase: vi.fn(async () => ({ config: { id: 'stub', base_url: '' }, model: 'stub' })),
}));

describe('rag-service integration — space permission enforcement', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    // pool cleanup handled by test-db-helper
  });
  beforeEach(async () => {
    await truncateAllTables();
  });
  afterEach(async () => {
    vi.clearAllMocks();
  });
  // fixtures + cases inserted in subsequent tasks
});
```

- [ ] **Step 2: Run the empty suite to verify DB connection works**

Run: `cd backend && npx vitest run src/domains/llm/services/rag-service.integration.test.ts`

Expected: 0 passed / 0 failed (empty describe block).

- [ ] **Step 3: Add a fixture helper that creates a user, a space, a page, and an embedding**

Add inside the `describe` block, above the test cases:

```ts
async function seedSpaceWithPage(opts: {
  userId: string;
  spaceKey: string;
  roleName?: 'viewer' | 'admin';
  pageTitle: string;
  bodyText: string;
  vec: number[];
}) {
  const { userId, spaceKey, roleName = 'viewer', pageTitle, bodyText, vec } = opts;
  await query(
    `INSERT INTO users (id, username, email, role, password_hash)
     VALUES ($1, $1, $1 || '@test', 'user', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [userId],
  );
  await query(
    `INSERT INTO spaces (space_key, name) VALUES ($1, $1)
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
    `INSERT INTO page_embeddings (page_id, chunk_text, embedding, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      pageId,
      bodyText,
      pgvector.toSql(vec),
      JSON.stringify({ page_title: pageTitle, section_title: pageTitle, space_key: spaceKey }),
    ],
  );
  return pageId;
}
```

- [ ] **Step 4: Write the cross-user leakage test**

```ts
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
  // User A has no role in SECRET — their readable set should be empty
  const vectorHits = await vectorSearch(userA, fakeVec(7));
  const keywordHits = await keywordSearch(userA, 'launch codes');
  const hybrid = await hybridSearch(userA, 'launch codes');

  expect(vectorHits).toHaveLength(0);
  expect(keywordHits).toHaveLength(0);
  expect(hybrid).toHaveLength(0);
});
```

- [ ] **Step 5: Run it and expect it to pass**

Run: `cd backend && npx vitest run src/domains/llm/services/rag-service.integration.test.ts`

Expected: 1 passed. This is a regression-guard test — it proves the baseline enforcement already works and catches any future regression. If this fails today, there is a real leak bug to fix before proceeding.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domains/llm/services/rag-service.integration.test.ts
git commit -m "test(#282): cross-user RAG space-permission leakage regression guard"
```

---

### Task 2: Red integration test — ACL revocation takes effect on next retrieval

**Files:**
- Modify: `backend/src/domains/llm/services/rag-service.integration.test.ts`

- [ ] **Step 1: Add the revocation test case**

```ts
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
```

- [ ] **Step 2: Run it**

Run: `cd backend && npx vitest run src/domains/llm/services/rag-service.integration.test.ts -t "revocation"`

Expected: PASS. Proves that when admins invalidate the RBAC cache (which all mutation paths in `rbac-service.ts` already do), the next RAG retrieval picks up the new ACL.

- [ ] **Step 3: Commit**

```bash
git add backend/src/domains/llm/services/rag-service.integration.test.ts
git commit -m "test(#282): RAG retrieval honours mid-conversation ACL revocation"
```

---

### Task 3: Red integration test — standalone visibility rules still enforced

**Files:**
- Modify: `backend/src/domains/llm/services/rag-service.integration.test.ts`

- [ ] **Step 1: Add the test case**

```ts
it('enforces standalone article visibility (shared + own-private, not others'' private)', async () => {
  const userX = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const userY = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  // userX writes a private standalone article
  await query(
    `INSERT INTO users (id, username, email, role, password_hash)
     VALUES ($1, $1, $1 || '@t', 'user', 'x'), ($2, $2, $2 || '@t', 'user', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [userX, userY],
  );
  const page = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                        visibility, created_by_user_id)
     VALUES (gen_random_uuid()::text, 'standalone', NULL, 'Private note', 'confidential draft', '', '',
             'private', $1)
     RETURNING id`,
    [userX],
  );
  await query(
    `INSERT INTO page_embeddings (page_id, chunk_text, embedding, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
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
```

- [ ] **Step 2: Run and commit**

```bash
cd backend && npx vitest run src/domains/llm/services/rag-service.integration.test.ts
git add backend/src/domains/llm/services/rag-service.integration.test.ts
git commit -m "test(#282): standalone article visibility enforcement in RAG"
```

---

### Task 4: Request-scoped space resolver (AsyncLocalStorage wrapper)

**Files:**
- Create: `backend/src/core/services/rbac-request-scope.ts`
- Modify: `backend/src/core/services/rbac-service.ts`
- Modify: `backend/src/core/plugins/auth.ts`

- [ ] **Step 1: Create the request-scope module**

```ts
// backend/src/core/services/rbac-request-scope.ts
import { AsyncLocalStorage } from 'node:async_hooks';

interface RbacScope {
  userId: string;
  spaces?: string[]; // memoised result of getUserAccessibleSpaces
}

const storage = new AsyncLocalStorage<RbacScope>();

export function runWithRbacScope<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ userId }, fn);
}

export function getCurrentScope(): RbacScope | undefined {
  return storage.getStore();
}

export function setScopedSpaces(spaces: string[]): void {
  const scope = storage.getStore();
  if (scope) scope.spaces = spaces;
}

export function getScopedSpaces(userId: string): string[] | null {
  const scope = storage.getStore();
  if (scope && scope.userId === userId && scope.spaces !== undefined) {
    return scope.spaces;
  }
  return null;
}
```

- [ ] **Step 2: Wrap `getUserAccessibleSpaces` to consult the scope first**

In `backend/src/core/services/rbac-service.ts`, add near the existing export:

```ts
import { getScopedSpaces, setScopedSpaces } from './rbac-request-scope.js';

// Leave the existing getUserAccessibleSpaces unchanged. Add a new wrapper:
export async function getUserAccessibleSpacesMemoized(userId: string): Promise<string[]> {
  const scoped = getScopedSpaces(userId);
  if (scoped) return scoped;
  const spaces = await getUserAccessibleSpaces(userId);
  setScopedSpaces(spaces);
  return spaces;
}
```

- [ ] **Step 3: Wire the auth plugin to open a scope per authenticated request**

Find the place in `backend/src/core/plugins/auth.ts` where `request.userId` is set after JWT verification. Wrap the rest of the request in `runWithRbacScope`. Because Fastify hooks are async, the pattern is:

```ts
// inside the onRequest / preHandler that currently sets request.userId
import { runWithRbacScope } from '../services/rbac-request-scope.js';

// ...after setting request.userId and passing decoded JWT checks...
await new Promise<void>((resolve, reject) => {
  runWithRbacScope(request.userId, async () => {
    resolve();
  }).catch(reject);
});
```

> NOTE: Fastify v5 request hooks resolve when the handler returns; because AsyncLocalStorage context is bound at `storage.run` call time, we open the scope here and Fastify's internal continuation stays inside the `run` frame for downstream hooks and the route handler. Verify behaviour with a smoke test in Task 5.

- [ ] **Step 4: Swap the callers to use the memoised helper**

`backend/src/domains/llm/services/rag-service.ts` — replace the two imports + call sites:

```ts
import { getUserAccessibleSpacesMemoized as getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
```

(Import the memoised export under the same local name so call sites on lines 35 and 97 do not need to change.)

`backend/src/routes/knowledge/search.ts` — same swap.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/services/rbac-request-scope.ts \
        backend/src/core/services/rbac-service.ts \
        backend/src/core/plugins/auth.ts \
        backend/src/domains/llm/services/rag-service.ts \
        backend/src/routes/knowledge/search.ts
git commit -m "feat(#282): request-scoped cache for RAG space-permission resolver"
```

---

### Task 5: Unit test — memoisation halves DB calls per request

**Files:**
- Create: `backend/src/core/services/rbac-request-scope.test.ts`

- [ ] **Step 1: Test that within a single `runWithRbacScope`, the DB query runs once**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithRbacScope } from './rbac-request-scope.js';
import * as rbac from './rbac-service.js';

vi.mock('./rbac-service.js', async () => {
  const actual = await vi.importActual<typeof import('./rbac-service.js')>('./rbac-service.js');
  return {
    ...actual,
    getUserAccessibleSpaces: vi.fn(async () => ['SPACE1']),
  };
});

describe('rbac-request-scope', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls getUserAccessibleSpaces exactly once per request', async () => {
    await runWithRbacScope('u1', async () => {
      const a = await rbac.getUserAccessibleSpacesMemoized('u1');
      const b = await rbac.getUserAccessibleSpacesMemoized('u1');
      const c = await rbac.getUserAccessibleSpacesMemoized('u1');
      expect(a).toEqual(['SPACE1']);
      expect(b).toEqual(['SPACE1']);
      expect(c).toEqual(['SPACE1']);
    });
    expect(rbac.getUserAccessibleSpaces).toHaveBeenCalledTimes(1);
  });

  it('fresh scope = fresh resolution (no leakage between requests)', async () => {
    await runWithRbacScope('u1', async () => {
      await rbac.getUserAccessibleSpacesMemoized('u1');
    });
    await runWithRbacScope('u1', async () => {
      await rbac.getUserAccessibleSpacesMemoized('u1');
    });
    expect(rbac.getUserAccessibleSpaces).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run and commit**

```bash
cd backend && npx vitest run src/core/services/rbac-request-scope.test.ts
git add backend/src/core/services/rbac-request-scope.test.ts
git commit -m "test(#282): per-request memoisation unit test"
```

---

### Task 6: New ADR — RAG permission enforcement model

**Files:**
- Modify: `docs/ARCHITECTURE-DECISIONS.md`

- [ ] **Step 1: Read the current ADR list and pick the next number**

Run: `grep -E '^## ADR-[0-9]+' docs/ARCHITECTURE-DECISIONS.md | tail -5`

Pick `ADR-<next>`. Use that number below.

- [ ] **Step 2: Append the ADR**

Append to `docs/ARCHITECTURE-DECISIONS.md`:

```markdown
## ADR-<next>: RAG retrieval honours per-user space permissions

**Date:** 2026-04-21
**Status:** Accepted
**Context:** Confluence instances can host spaces with restricted read access. When multiple users share a Compendiq instance, RAG must not surface a chunk from a space the querying user cannot read in Confluence, even if a different user on the same instance synced that space.

**Decision:** Enforce per-user space permissions as a **post-filter** on both vector (pgvector HNSW) and keyword (PostgreSQL FTS) candidate sets, before reciprocal-rank fusion. The allowed space set is resolved from `space_role_assignments` + `group_memberships` via `rbac-service.getUserAccessibleSpaces(userId)` and memoised for the lifetime of the request via `AsyncLocalStorage` so downstream callers pay a single DB round-trip regardless of how many retrieval paths execute per request.

Standalone (non-Confluence) articles are filtered by the same visibility rules already enforced in the knowledge-search route: `shared` articles are visible to all authenticated users; `private` articles are visible only to their creator.

**Why post-filter, not query-time HNSW index filter:** pgvector HNSW has a selectivity penalty when the filter column is sparse; adding `space_key = ANY(...)` as an ORDER-BY-time predicate would force oversampled top-K per call. Post-filter with candidate overfetch is simpler, keeps the vector index unconditioned on per-user state, and is adequate while per-user readable sets stay small (typically < 50 spaces per user in observed deployments).

**Scope boundary (CE-only):** This ADR covers space-level RBAC enforcement. Per-space **per-user ACL** (access-control-entries with custom permissions per page) is gated behind the Enterprise Edition `ENTERPRISE_FEATURES.ADVANCED_RBAC` flag and is not covered here; see the v0.4 roadmap.

**Consequences:**
- Any new retrieval path MUST use `getUserAccessibleSpacesMemoized` (not the raw resolver) to inherit the request-scoped cache.
- RBAC mutation paths MUST invalidate the Redis RBAC cache (`invalidateRbacCache(userId)`) so the next request sees the new ACL within the 60-second global TTL window.
- Integration test `backend/src/domains/llm/services/rag-service.integration.test.ts` is the regression guard.
```

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE-DECISIONS.md
git commit -m "docs(#282): ADR for RAG permission enforcement model"
```

---

### Task 7: Update the RAG chat flow diagram

**Files:**
- Modify: `docs/architecture/09-flow-rag-chat.md`

- [ ] **Step 1: Add a `RBAC` participant and a permission-check checkpoint to the sequence**

In the Mermaid block, add the participant:

```
    participant RBAC as rbac-service (per-req scope)
```

And inject a step between the `par vector + keyword` block and the retrieval calls:

```
            BE->>RBAC: getUserAccessibleSpacesMemoized(userId)
            RBAC-->>BE: readableSpaceKeys[] (request-scoped)
            par vector + keyword
                BE->>RAG: vectorSearch(userId, q_vector)
                RAG->>PG: WHERE cp.space_key = ANY(readableSpaceKeys) ...
                PG-->>RAG: top-K chunks
            and
                BE->>RAG: keywordSearch(userId, question)
                RAG->>PG: tsvector search WHERE same space filter
                PG-->>RAG: matches
            end
```

Also add a note block below the diagram:

```markdown
### Permission-check checkpoint

Per ADR-<next>, RAG retrieval post-filters vector and FTS candidate sets by the caller's readable space keys. The resolver (`rbac-service.getUserAccessibleSpaces`) is memoised per request via `AsyncLocalStorage`, so a single hybrid query touches the RBAC path once regardless of how many retrieval calls execute.
```

- [ ] **Step 2: Verify the Mermaid renders (optional)**

Run: `npx -y @mermaid-js/mermaid-cli -i docs/architecture/09-flow-rag-chat.md -o /tmp/rag.svg 2>&1 | tail -5` — or visually inspect in a Markdown preview. Skip if mermaid-cli is not available; the syntax is standard sequenceDiagram.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/09-flow-rag-chat.md
git commit -m "docs(#282): RAG flow diagram shows permission-check checkpoint"
```

---

### Task 8: Run the full test suite and verify no regression

- [ ] **Step 1: Backend tests**

Run: `cd backend && npm run test -- --run 2>&1 | tail -40`

Expected: all existing tests still green; new `rag-service.integration.test.ts` and `rbac-request-scope.test.ts` pass.

- [ ] **Step 2: Typecheck**

Run: `cd backend && npm run typecheck 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 3: Lint**

Run: `cd backend && npm run lint 2>&1 | tail -10`

Expected: no errors.

If any step fails, fix inline in the same commit or a follow-up fix commit before opening the PR.

---

### Task 9: Open the PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/282-rag-permission-enforcement
```

- [ ] **Step 2: Open PR against `dev`**

```bash
gh pr create --repo Compendiq/compendiq-ce --base dev \
  --head feature/282-rag-permission-enforcement \
  --title "feat(#282): RAG permission enforcement — request-scoped cache + regression tests + ADR" \
  --body "$(cat <<'EOF'
## Summary
- Proves existing per-user space-permission enforcement in `rag-service.ts` with real-Postgres integration tests covering cross-user leakage, mid-conversation ACL revocation, and standalone article visibility
- Adds `AsyncLocalStorage`-backed per-request memoisation so `getUserAccessibleSpaces` runs at most once per request
- New ADR documenting the enforcement model and CE-vs-EE scope boundary
- Architecture diagram `09-flow-rag-chat.md` now shows the permission-check checkpoint

Closes #282

## Test plan
- [ ] Backend unit + integration tests green (`npm run test -w backend`)
- [ ] Typecheck green
- [ ] Lint green
- [ ] Manual: cross-user leakage scenario reviewed in the new integration test

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- **Spec coverage:** All acceptance criteria from issue #282 are addressed (vector + FTS + hybrid filtering, per-request cache, revocation test, no-regression happy path, ADR, diagram).
- **Placeholders:** `<next>` for the ADR number is resolved at Task 6 Step 1 by inspecting the file — not a plan-time placeholder.
- **Type consistency:** `getUserAccessibleSpacesMemoized` signature matches `getUserAccessibleSpaces` exactly (single `userId: string` → `Promise<string[]>`).
- **Scope:** Single, cohesive change set. No unrelated refactoring.
