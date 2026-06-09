# Unit B — #721: Unsync / remove a synced Confluence space Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin remove/stop-syncing a Confluence space: a new endpoint purges the space's local pages (a raw `DELETE FROM pages` whose FK cascade removes embeddings/versions), best-effort attachment files, the `spaces` row, and all `space_role_assignments`; it also reconciles orphaned `space_key` rows (space-scoped `oidc_group_role_mappings` deleted; `templates`/`knowledge_requests` detached). The Spaces tab gets a Remove action, can save an empty selection, and reflects deselection for admins.

**Architecture:** Backend adds an exported `unsyncSpace(spaceKey)` purge in the confluence domain and a `DELETE /api/spaces/:key` route (admin-gated, read-only against Confluence). The purge wraps all row deletes/updates in a single `BEGIN`/`COMMIT` transaction on one pooled client (`getPool().connect()`), ROLLBACK + re-throw on error; filesystem attachment cleanup is best-effort and runs **before/outside** the transaction. Deleting `pages` cascades to `page_embeddings`/`page_versions` via the `page_id` FK (migration 030) — it does **not** call `purgeDeletedPages`. `GET /settings` stops sourcing the tab's `selectedSpaces` from the admin "all spaces" view and uses the user's explicit editor assignments instead. Frontend adds a per-space Remove button with a confirm dialog and relaxes the empty-selection guard on Save.

**Tech Stack:** Fastify 5, Postgres (real DB in tests via `backend/src/test-db-helper.ts`), React 19 + TanStack Query, Vitest.

**Branch:** `feature/issue-721-space-unsync` off `dev`. Backend tests run with `fileParallelism:false` against an isolated test Postgres.

---

### Task 1: `unsyncSpace(spaceKey)` purge service

**Files:**
- Modify: `backend/src/domains/confluence/services/sync-service.ts` (add exported function near `purgeDeletedPages` at `:1385`)
- Reuse: `cleanPageAttachments(_userId, pageId)` from `backend/src/domains/confluence/services/attachment-handler.ts:748`
- Test: `backend/src/domains/confluence/services/sync-service.unsync.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { unsyncSpace } from './sync-service.js';

describe('unsyncSpace', () => {
  beforeEach(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it('deletes the space, its pages (cascading versions/embeddings), and reconciles orphaned space_key rows', async () => {
    await query(`INSERT INTO spaces (space_key, name, source) VALUES ('ENG','Engineering','confluence')`);
    const p = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, version, source)
       VALUES ('c-1','ENG','Page','1','confluence') RETURNING id`);
    const pageId = p.rows[0]!.id;
    await query(`INSERT INTO page_versions (page_id, version_number, title) VALUES ($1, 1, 'Page')`, [pageId]);
    await query(`INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
                 SELECT 'ENG','user', gen_random_uuid(), id FROM roles WHERE name='editor' LIMIT 1`);
    await query(`INSERT INTO oidc_group_role_mappings (oidc_group, role_id, space_key)
                 SELECT 'g','` /* role_id */ + `'... , 'ENG'`); // seed a space-scoped mapping
    const tpl = await query<{ id: number }>(
      `INSERT INTO templates (title, body_json, body_html, created_by, space_key)
       VALUES ('T','{}','<p/>', gen_random_uuid(), 'ENG') RETURNING id`);
    const kr = await query<{ id: number }>(
      `INSERT INTO knowledge_requests (title, requested_by, space_key)
       VALUES ('K', gen_random_uuid(), 'ENG') RETURNING id`);

    const result = await unsyncSpace('ENG');

    expect(result.pagesDeleted).toBe(1);
    expect((await query(`SELECT 1 FROM spaces WHERE space_key='ENG'`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM pages WHERE space_key='ENG'`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM page_versions WHERE page_id=$1`, [pageId])).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM space_role_assignments WHERE space_key='ENG'`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM oidc_group_role_mappings WHERE space_key='ENG'`)).rows).toHaveLength(0);
    // templates / knowledge_requests are DETACHED (row kept, space_key NULLed), not deleted.
    expect((await query(`SELECT space_key FROM templates WHERE id=$1`, [tpl.rows[0]!.id])).rows[0]!.space_key).toBeNull();
    expect((await query(`SELECT space_key FROM knowledge_requests WHERE id=$1`, [kr.rows[0]!.id])).rows[0]!.space_key).toBeNull();
  });

  it('rolls back every row delete atomically when a statement fails mid-transaction', async () => {
    // Seed every affected table for 'ENG'; force a failure inside the transaction
    // (e.g. by violating a constraint) and assert ALL 'ENG' rows survive — the
    // BEGIN/COMMIT wrapper must ROLLBACK and re-throw, leaving no partial purge.
  });
});
```

> Adjust the `pages` INSERT column list to the table's actual NOT NULL columns (read `backend/src/core/db/migrations` for the `pages` schema; add `body_html`/`body_text`/etc. defaults if required). The `oidc_group_role_mappings` seed needs a real `role_id` (look one up from `roles`); also seed a second space (e.g. `OPS`) and assert its rows are untouched.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/domains/confluence/services/sync-service.unsync.test.ts`
Expected: FAIL — `unsyncSpace` is not exported.

- [ ] **Step 3: Implement `unsyncSpace`**

Add to `sync-service.ts` (ensure `cleanPageAttachments`, `logger`, and `getPool` are imported; `cleanPageAttachments` is already imported in this module). The purge is a **raw `DELETE FROM pages`** relying on the FK cascade — **not** `purgeDeletedPages` (that is the soft-delete-reconciliation path). All row mutations run inside one transaction; the per-page attachment cleanup is best-effort and happens **before** the transaction opens so a file-cleanup failure can never abort the DB work.

```ts
/**
 * #721: Remove a synced Confluence space and all of its local data. Read-only
 * against Confluence — only local rows/files are deleted.
 *
 * Filesystem attachment cleanup is best-effort and runs BEFORE the transaction;
 * a file-cleanup failure is logged, never fatal. Deleting the `pages` rows
 * cascades to `page_embeddings` and `page_versions` (page_id FK, migration 030).
 *
 * Orphaned `space_key` rows (no FK to `spaces`) are reconciled inside the same
 * transaction:
 *   - space_role_assignments — RBAC + sync selection (the old
 *     `user_space_selections` table was migrated into this one and DROPPED in
 *     migration 040). DELETE, scoped to the space.
 *   - oidc_group_role_mappings — DELETE only rows whose space_key matches; global
 *     (space_key IS NULL) rows are kept.
 *   - templates / knowledge_requests — may hold user-authored content; NULL the
 *     (nullable) space_key to DETACH rather than destroy work.
 */
export async function unsyncSpace(spaceKey: string): Promise<{ pagesDeleted: number }> {
  // Best-effort, non-transactional filesystem cleanup BEFORE the DB transaction.
  const pages = await query<{ id: number }>(
    'SELECT id FROM pages WHERE space_key = $1',
    [spaceKey],
  );
  for (const p of pages.rows) {
    try {
      await cleanPageAttachments('', String(p.id));
    } catch (err) {
      logger.warn({ err, pageId: p.id, spaceKey }, 'unsyncSpace: attachment cleanup failed (continuing)');
    }
  }

  const pool = getPool();
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    // Pages → cascades to page_embeddings + page_versions (migration 030).
    const del = await conn.query('DELETE FROM pages WHERE space_key = $1', [spaceKey]);
    // RBAC / sync-selection rows for the removed space.
    await conn.query('DELETE FROM space_role_assignments WHERE space_key = $1', [spaceKey]);
    // OIDC group→space mappings scoped to this space (NULL = global, kept).
    await conn.query('DELETE FROM oidc_group_role_mappings WHERE space_key = $1', [spaceKey]);
    // User-authored artifacts: detach (retain the row, NULL the space_key).
    await conn.query('UPDATE templates SET space_key = NULL WHERE space_key = $1', [spaceKey]);
    await conn.query('UPDATE knowledge_requests SET space_key = NULL WHERE space_key = $1', [spaceKey]);
    // Finally the space row itself.
    await conn.query('DELETE FROM spaces WHERE space_key = $1', [spaceKey]);
    await conn.query('COMMIT');
    logger.info({ spaceKey, pagesDeleted: del.rowCount ?? 0 }, 'unsyncSpace: purged synced space');
    return { pagesDeleted: del.rowCount ?? 0 };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => { /* original error already surfacing */ });
    throw err;
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/domains/confluence/services/sync-service.unsync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/confluence/services/sync-service.ts backend/src/domains/confluence/services/sync-service.unsync.test.ts
git commit -m "feat(spaces): add unsyncSpace purge service (#721)"
```

---

### Task 2: `DELETE /api/spaces/:key` route (admin-gated)

**Files:**
- Modify: `backend/src/routes/confluence/spaces.ts` (add after the existing handlers; the file already registers `/spaces`, `/spaces/:key/home`, `/spaces/available`)
- Test: `backend/src/routes/confluence/spaces.test.ts` (extend, or create)

- [ ] **Step 1: Write the failing route test**

Model on `backend/src/routes/knowledge/local-spaces.test.ts` (real DB + `app.inject`). Add:

```ts
it('DELETE /api/spaces/:key removes a synced space and its data (admin)', async () => {
  await query(`INSERT INTO spaces (space_key, name, source) VALUES ('ENG','Engineering','confluence')`);
  await query(`INSERT INTO pages (confluence_id, space_key, title, version, source)
               VALUES ('c-1','ENG','Page','1','confluence')`);

  const res = await app.inject({ method: 'DELETE', url: '/api/spaces/ENG' });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ key: 'ENG', deleted: true });
  expect((await query(`SELECT 1 FROM spaces WHERE space_key='ENG'`)).rows).toHaveLength(0);
  expect((await query(`SELECT 1 FROM pages WHERE space_key='ENG'`)).rows).toHaveLength(0);
});

it('DELETE /api/spaces/:key 404s for unknown space', async () => {
  const res = await app.inject({ method: 'DELETE', url: '/api/spaces/NOPE' });
  expect(res.statusCode).toBe(404);
});
```

> Mirror the admin-auth setup used by other admin-gated route tests (e.g. `backend/src/routes/foundation/rbac.test.ts`): seed an admin user and stub `fastify.authenticate` to set `request.userId`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/confluence/spaces.test.ts`
Expected: FAIL — route returns 404/405 (not registered).

- [ ] **Step 3: Implement the route**

In `spaces.ts`, import `unsyncSpace` from the confluence domain service, the existing `query`, cache, `logAuditEvent`, and the admin guard used elsewhere in this file. Add:

```ts
  // DELETE /api/spaces/:key — stop syncing a Confluence space and purge its local
  // data (#721). Admin-only. Read-only against Confluence.
  fastify.delete('/spaces/:key', async (request) => {
    const userId = request.userId;
    await assertSystemAdmin(userId); // use the same admin check other admin routes use
    const { key } = KeyParamSchema.parse(request.params);

    const existing = await query<{ source: string }>(
      'SELECT source FROM spaces WHERE space_key = $1',
      [key],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Space not found');
    }

    const { pagesDeleted } = await unsyncSpace(key);

    await invalidateRbacCache(userId);
    await cache.invalidate(userId, 'spaces');
    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'SPACE_UNSYNCED', 'space', key, { pagesDeleted }, request);

    return { key, deleted: true, pagesDeleted };
  });
```

> `assertSystemAdmin` / `invalidateRbacCache` / `KeyParamSchema` / `cache` / `logAuditEvent`: import the exact symbols already used by admin-gated routes (`routes/foundation/rbac.ts`, `routes/knowledge/local-spaces.ts`). If no shared `assertSystemAdmin` exists, replicate the inline admin check those routes use.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/routes/confluence/spaces.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/confluence/spaces.ts backend/src/routes/confluence/spaces.test.ts
git commit -m "feat(spaces): DELETE /api/spaces/:key to unsync a Confluence space (#721)"
```

---

### Task 3: Decouple the tab's `selectedSpaces` from the admin "all spaces" view

**Files:**
- Modify: `backend/src/core/services/rbac-service.ts` (add `getSelectedSyncSpaces`)
- Modify: `backend/src/routes/foundation/settings.ts:33` (use it)
- Test: `backend/src/routes/foundation/settings.test.ts` (extend) or `rbac-service` unit test

- [ ] **Step 1: Write the failing test**

Add to the settings route test (real DB). After seeding an **admin** user + two synced spaces where the admin has an editor assignment for only ONE:

```ts
it('GET /settings returns only the explicitly-selected spaces for an admin (not all spaces) (#721)', async () => {
  await query(`INSERT INTO spaces (space_key, name, source) VALUES ('ENG','Eng','confluence'),('OPS','Ops','confluence')`);
  await query(`INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
               SELECT 'ENG','user',$1,id FROM roles WHERE name='editor' LIMIT 1`, [adminUserId]);

  const res = await app.inject({ method: 'GET', url: '/api/settings' });
  expect(res.json().selectedSpaces).toEqual(['ENG']); // NOT ['ENG','OPS']
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/foundation/settings.test.ts`
Expected: FAIL — admin currently gets all spaces (`['ENG','OPS']`).

- [ ] **Step 3: Add `getSelectedSyncSpaces` and use it**

In `rbac-service.ts`:

```ts
/**
 * #721: The spaces the user has EXPLICITLY selected for sync (their editor
 * assignments that still correspond to an existing space row) — regardless of
 * system-admin "all spaces" access. Used by GET /settings so deselecting a space
 * is honored for admins (getUserAccessibleSpaces would always re-include it).
 */
export async function getSelectedSyncSpaces(userId: string): Promise<string[]> {
  const r = await query<{ space_key: string }>(
    `SELECT DISTINCT sra.space_key
       FROM space_role_assignments sra
       JOIN roles r ON r.id = sra.role_id AND r.name = 'editor'
       JOIN spaces s ON s.space_key = sra.space_key
      WHERE sra.principal_type = 'user' AND sra.principal_id = $1`,
    [userId],
  );
  return r.rows.map((row) => row.space_key);
}
```

In `settings.ts:33`, replace:

```ts
    const selectedSpaces = await getSelectedSyncSpaces(request.userId);
    selectedSpaces.sort();
```

(Update the import to add `getSelectedSyncSpaces`; leave `getUserAccessibleSpaces` for its other callers.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/routes/foundation/settings.test.ts`
Expected: PASS.

> **Edge note for reviewer:** an admin who synced spaces before this change without an editor assignment will see those spaces *unchecked* in the tab (they still appear via the `/spaces` synced list and can be re-checked or removed). This is intended per #721's decoupling.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/services/rbac-service.ts backend/src/routes/foundation/settings.ts backend/src/routes/foundation/settings.test.ts
git commit -m "fix(spaces): tab selection reflects explicit sync selection, not admin-all (#721)"
```

---

### Task 4: Frontend — Remove action + allow empty Save

**Files:**
- Modify: `frontend/src/features/settings/SpacesTab.tsx` (`:204` Save guard, add Remove button + confirm + mutation)
- Test: `frontend/src/features/settings/SpacesTab.test.tsx` (extend or create)

- [ ] **Step 1: Write the failing test**

```tsx
it('calls DELETE /api/spaces/:key when a space is removed and confirmed', async () => {
  apiFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === '/spaces') return [{ key: 'ENG', name: 'Eng', source: 'confluence' }];
    if (opts?.method === 'DELETE') return { key: 'ENG', deleted: true };
    return [];
  });
  // render SpacesTab with selectedSpaces={['ENG']}
  // click the space's Remove button, confirm the dialog
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/spaces/ENG', expect.objectContaining({ method: 'DELETE' })),
  );
});

it('allows saving an empty selection (Save not disabled at zero) (#721)', () => {
  // render with selectedSpaces={[]}; the Save button must not be disabled
  expect(screen.getByRole('button', { name: /save selection/i })).not.toBeDisabled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/settings/SpacesTab.test.tsx`
Expected: FAIL — no Remove control; Save disabled at zero.

- [ ] **Step 3: Implement the Remove mutation + button + confirm, relax Save guard**

Add a removal mutation:

```tsx
  const removeSpace = useMutation({
    mutationFn: (key: string) => apiFetch(`/spaces/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    onSuccess: (_d, key) => {
      setSelected((prev) => { const n = new Set(prev); n.delete(key); return n; });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      toast.success('Space removed — its synced pages were deleted locally');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to remove space'),
  });
```

For each synced space row, add a Remove button that opens a confirm dialog warning:
*"Remove this space? This deletes its synced pages locally. It does NOT delete anything in Confluence."* Use the existing dialog/confirm primitive in the codebase (search for an existing `ConfirmDialog`/Radix AlertDialog usage; reuse it). On confirm, call `removeSpace.mutate(key)`.

Relax the Save guard at `SpacesTab.tsx:204` — remove `selected.size === 0` from the **Save Selection** button's `disabled` (keep `disabled` on the **Sync Selected** button at `:211`). When saving zero, surface a confirm: *"Remove all synced spaces from your selection?"* before calling `handleSave`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/settings/SpacesTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd frontend && npx eslint src/features/settings/SpacesTab.tsx
git add frontend/src/features/settings/SpacesTab.tsx frontend/src/features/settings/SpacesTab.test.tsx
git commit -m "feat(spaces): Remove action + allow empty save in Spaces tab (#721)"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `docs/architecture/08-flow-sync.md` (note the unsync/purge path + selection decoupling)

- [ ] **Step 1:** Update `docs/architecture/08-flow-sync.md`: add the `DELETE /api/spaces/:key` → `unsyncSpace` purge path (single transaction; raw `DELETE FROM pages` + FK cascade; orphan reconciliation of `oidc_group_role_mappings` / `templates` / `knowledge_requests`; best-effort attachment cleanup outside the transaction) and that the Spaces tab selection now derives from explicit editor assignments.
- [ ] **Step 2:** `cd backend && npx vitest run src/domains/confluence/services/sync-service.unsync.test.ts src/routes/confluence/spaces.test.ts src/routes/foundation/settings.test.ts` — green.
- [ ] **Step 3:** `cd backend && npm run lint && npm run typecheck` (or workspace equivalents) — clean.
- [ ] **Step 4:** `cd frontend && npx vitest run && npx tsc --noEmit` — clean.
- [ ] **Step 5:** Commit docs, open PR `feat(spaces): unsync/remove a synced Confluence space (#721)` targeting `dev`.

## Acceptance mapping (#721)
- Admin can remove a space; stops syncing; pages gone locally; stays gone after refresh → Tasks 1+2 (+3 keeps it unchecked).
- Works down to zero selected → Task 4 (relaxed Save guard).
- Cleans pages/embeddings/attachments (raw `DELETE FROM pages` + FK cascade + best-effort `cleanPageAttachments`), all `space_role_assignments`, and space-scoped `oidc_group_role_mappings`; detaches `templates`/`knowledge_requests`; all DB work atomic (single transaction); nothing in Confluence → Task 1.
- Non-admin deselect still loses access, no orphaned data → Task 3 + Task 1 purge.
