# World-Class KB — Action Plan

> **Epic:** [#353 — Standalone KB Articles & World-Class KB](https://github.com/laboef1900/ai-kb-creator/issues/353)
>
> **Sub-Issues:** #354 (Spaces), #355 (RBAC), #356 (Comments), #357 (Templates), #358 (PDF Export), #359 (Import), #360 (Verification), #361 (Analytics), #362 (Drafts), #363 (Knowledge Requests), #364 (Notifications), #365 (Search)
>
> **ADR:** ADR-020 (to be created in ARCHITECTURE-DECISIONS.md)
>
> **Reviewed by:** critic agent, gh-issue-reviewer agent — **ApprovedByAI**

## Goal

Transform the app from a Confluence-only cache into a **hybrid knowledge base** that works:
1. **Standalone mode** — no Confluence at all, fully self-contained KB
2. **Hybrid mode** — Confluence-synced articles alongside locally-created articles
3. With full LLM/RAG/quality/summary support for both article types

## Scope & Blast Radius (Validated by Codebase Review)

| Change | Files | Occurrences |
|--------|-------|-------------|
| `cached_pages` → `pages` rename | 47 | 224 |
| `confluence_id` FK migration | 42 | 329 |
| `getClientForUser()` bypass | 6 route files | 10 call sites |
| Frontend Confluence coupling | 41 | — |
| Test file updates | 12 | — |
| Historical migrations (DO NOT TOUCH) | 28 | 001–027 + 017b |

**Next migration:** 028 &nbsp;&nbsp; **Next ADR:** 020

---

## Dependency Graph

```
Phase A1: Table Rename (cached_pages → pages)
    ↓
Phase A2: Schema Changes (source, visibility, created_by, deleted_at, nullable confluence_id/space_key)
    ↓
Phase A3: FK Migration (5 dependent tables → SERIAL id)
    ↓
Phase A4: Backend Code Updates (table name + join key references)
    ├──────────────────────────────┐
    ↓                              ↓
Phase B: Standalone CRUD      Phase D: RAG & LLM Fixes
    ↓                              ↓
Phase C: Confluence-Free Mode  Phase E: Markdown Import
    ├──────────────────────────────┘
    ↓
Phase F: Frontend UI
    ↓
Phase G: Publish to Confluence
    ↓
Phase H: Testing & Documentation
```

**Critical path:** A1 → A2 → A3 → A4 → B → F → H

**Parallelizable:** B + D can run in parallel. C + E can run in parallel after B.

---

## Phase A: Database & Schema (Critical Path)

> **Risk level:** HIGH — touches production tables with data. Each sub-phase is a separate migration with independent rollback.
>
> **Rule:** Historical migrations (001–027 + 017b) must NEVER be modified.

### A1: Table Rename — Migration 028

**File:** `backend/src/core/db/migrations/028_rename_cached_pages.sql`

```sql
-- Rename the core table
ALTER TABLE cached_pages RENAME TO pages;

-- Rename indexes and constraints that reference the old name
-- (PostgreSQL auto-renames some, but explicit is safer)
ALTER INDEX IF EXISTS cached_pages_pkey RENAME TO pages_pkey;
ALTER INDEX IF EXISTS cached_pages_confluence_id_key RENAME TO pages_confluence_id_key;
```

**Backend code update (47 files, 224 occurrences):**
- [ ] Global find-and-replace `cached_pages` → `pages` in all `.ts` files under `backend/src/`
- [ ] Update table references in all SQL queries (services, routes, workers)
- [ ] Update test files referencing the table name
- [ ] Verify: `npm run typecheck -w backend` passes
- [ ] Verify: `npm test -w backend` passes

**Rollback:** `ALTER TABLE pages RENAME TO cached_pages;`

### A2: Schema Changes — Migration 029

**File:** `backend/src/core/db/migrations/029_standalone_columns.sql`

```sql
-- New columns with safe defaults (non-breaking for existing data)
ALTER TABLE pages ADD COLUMN source TEXT NOT NULL DEFAULT 'confluence';
ALTER TABLE pages ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE pages ADD COLUMN deleted_at TIMESTAMPTZ;

-- Make Confluence-specific columns nullable
ALTER TABLE pages ALTER COLUMN confluence_id DROP NOT NULL;
ALTER TABLE pages ALTER COLUMN space_key DROP NOT NULL;

-- Replace absolute unique with partial unique (Confluence pages only)
DROP INDEX IF EXISTS pages_confluence_id_key;
CREATE UNIQUE INDEX pages_confluence_id_unique
  ON pages(confluence_id) WHERE confluence_id IS NOT NULL;

-- Constraints
ALTER TABLE pages ADD CONSTRAINT pages_source_check
  CHECK (source IN ('confluence', 'standalone'));
ALTER TABLE pages ADD CONSTRAINT pages_visibility_check
  CHECK (visibility IN ('private', 'shared'));

-- Indexes for new access control queries
CREATE INDEX pages_source_idx ON pages(source);
CREATE INDEX pages_visibility_idx ON pages(source, visibility) WHERE source = 'standalone';
CREATE INDEX pages_created_by_idx ON pages(created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE INDEX pages_deleted_at_idx ON pages(deleted_at) WHERE deleted_at IS NOT NULL;
```

**Rollback:** Drop columns, restore NOT NULL, restore original unique index.

### A3: FK Migration — Migration 030

**File:** `backend/src/core/db/migrations/030_universal_page_id_fk.sql`

Migrate all 5 dependent tables from `confluence_id TEXT` to `page_id INT REFERENCES pages(id)`:

```sql
-- 1. page_embeddings
ALTER TABLE page_embeddings ADD COLUMN page_id INTEGER;
UPDATE page_embeddings pe SET page_id = p.id FROM pages p WHERE pe.confluence_id = p.confluence_id;
ALTER TABLE page_embeddings ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE page_embeddings ADD CONSTRAINT page_embeddings_page_id_fk
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
CREATE INDEX page_embeddings_page_id_idx ON page_embeddings(page_id);
-- Drop old FK column
ALTER TABLE page_embeddings DROP COLUMN confluence_id;
-- Drop old space_key if present
ALTER TABLE page_embeddings DROP COLUMN IF EXISTS space_key;

-- 2. page_versions
ALTER TABLE page_versions ADD COLUMN page_id INTEGER;
UPDATE page_versions pv SET page_id = p.id FROM pages p WHERE pv.confluence_id = p.confluence_id;
ALTER TABLE page_versions ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE page_versions ADD CONSTRAINT page_versions_page_id_fk
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS page_versions_confluence_id_version_number_key;
CREATE UNIQUE INDEX page_versions_page_id_version_unique ON page_versions(page_id, version_number);
ALTER TABLE page_versions DROP COLUMN confluence_id;

-- 3. llm_improvements
ALTER TABLE llm_improvements ADD COLUMN page_id INTEGER;
UPDATE llm_improvements li SET page_id = p.id FROM pages p WHERE li.confluence_id = p.confluence_id;
ALTER TABLE llm_improvements ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE llm_improvements ADD CONSTRAINT llm_improvements_page_id_fk
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
CREATE INDEX llm_improvements_page_id_idx ON llm_improvements(page_id);
ALTER TABLE llm_improvements DROP COLUMN confluence_id;

-- 4. pinned_pages
ALTER TABLE pinned_pages ADD COLUMN new_page_id INTEGER;
UPDATE pinned_pages pp SET new_page_id = p.id FROM pages p WHERE pp.page_id::text = p.confluence_id;
ALTER TABLE pinned_pages ALTER COLUMN new_page_id SET NOT NULL;
ALTER TABLE pinned_pages ADD CONSTRAINT pinned_pages_page_id_fk
  FOREIGN KEY (new_page_id) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE pinned_pages DROP COLUMN page_id;
ALTER TABLE pinned_pages RENAME COLUMN new_page_id TO page_id;

-- 5. page_relationships
ALTER TABLE page_relationships ADD COLUMN new_page_id_1 INTEGER;
ALTER TABLE page_relationships ADD COLUMN new_page_id_2 INTEGER;
UPDATE page_relationships pr SET
  new_page_id_1 = p1.id,
  new_page_id_2 = p2.id
FROM pages p1, pages p2
WHERE pr.page_id_1 = p1.confluence_id AND pr.page_id_2 = p2.confluence_id;
-- Some relationships may be orphaned — delete those
DELETE FROM page_relationships WHERE new_page_id_1 IS NULL OR new_page_id_2 IS NULL;
ALTER TABLE page_relationships ALTER COLUMN new_page_id_1 SET NOT NULL;
ALTER TABLE page_relationships ALTER COLUMN new_page_id_2 SET NOT NULL;
ALTER TABLE page_relationships ADD CONSTRAINT page_relationships_page_id_1_fk
  FOREIGN KEY (new_page_id_1) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE page_relationships ADD CONSTRAINT page_relationships_page_id_2_fk
  FOREIGN KEY (new_page_id_2) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE page_relationships DROP COLUMN page_id_1;
ALTER TABLE page_relationships DROP COLUMN page_id_2;
ALTER TABLE page_relationships RENAME COLUMN new_page_id_1 TO page_id_1;
ALTER TABLE page_relationships RENAME COLUMN new_page_id_2 TO page_id_2;
```

**Rollback:** Reverse each table (add back TEXT column, backfill from JOIN, drop INT column). This is why A2 preserves `confluence_id` on the `pages` table — it's the backfill source.

### A4: Backend Code Updates

Update all backend code to use `pages.id` (SERIAL) instead of `confluence_id` as the join key:

- [ ] `embedding-service.ts` — `processDirtyPages()`, `getEmbeddingStatus()`, `reEmbedAll()`: query by `id`, FK joins on `page_id`
- [ ] `rag-service.ts` — `vectorSearch()`, `keywordSearch()`: join `page_embeddings.page_id = pages.id`
- [ ] `pages-crud.ts` — all CRUD routes: return `id` (INT) not `confluence_id` as primary identifier
- [ ] `pages-versions.ts` — version queries: join on `page_id`
- [ ] `pages-tags.ts` — tag queries
- [ ] `pages-embeddings.ts` — embedding routes
- [ ] `pages-duplicates.ts` — duplicate detection
- [ ] `pinned-pages.ts` — pin/unpin: use INT `page_id`
- [ ] `analytics.ts` — analytics queries
- [ ] `knowledge-admin.ts` — admin operations
- [ ] `llm-chat.ts` — improvement references
- [ ] `llm-conversations.ts` — conversation page references
- [ ] `llm-embeddings.ts` — embedding admin routes
- [ ] `sync-service.ts` — sync upsert: populate `confluence_id` but JOIN on `id`
- [ ] `sync-overview-service.ts` — overview queries
- [ ] `quality-worker.ts` — quality processing queries
- [ ] `summary-worker.ts` — summary processing queries
- [ ] `version-tracker.ts` — version tracking
- [ ] `duplicate-detector.ts` — duplicate queries
- [ ] `auto-tagger.ts` — tagging queries
- [ ] Update `@atlasmind/contracts` schemas: page responses return `id: number` instead of `id: string`
- [ ] Update all frontend hooks/components that consume page `id` as string → number
- [ ] Verify: `npm run typecheck` passes (both workspaces)
- [ ] Verify: `npm test` passes (both workspaces)

---

## Phase B: Backend — Standalone CRUD

> **Depends on:** Phase A (all sub-phases)
>
> **Parallelizable with:** Phase D

### B1: Contracts Update

**File:** `packages/contracts/src/schemas/pages.ts`

- [ ] `CreatePageSchema`: make `spaceKey` optional, add `source?: 'standalone'`, add `visibility?: 'private' | 'shared'`
- [ ] `PageSummarySchema`: add `source`, `visibility`, `createdByUserId`, `deletedAt` fields
- [ ] `PageDetailSchema`: same additions
- [ ] New `RestorePageSchema`, `ImportMarkdownSchema`
- [ ] Export new types

### B2: Standalone Create

**File:** `backend/src/routes/knowledge/pages-crud.ts` — `POST /api/pages`

- [ ] If `source === 'standalone'` (or no `spaceKey`): skip `getClientForUser()`, skip Confluence API call
- [ ] Insert directly into `pages` with:
  - `confluence_id = NULL`
  - `space_key = NULL`
  - `source = 'standalone'`
  - `created_by_user_id = userId`
  - `visibility = body.visibility || 'shared'`
  - `version = 1`
  - `body_html` from TipTap
  - `body_text` via `htmlToText()`
  - `body_storage = NULL` (no XHTML for standalone)
  - `embedding_dirty = TRUE`
- [ ] Save initial version to `page_versions`
- [ ] Return `{ id, title, version, source }`

### B3: Standalone Edit

**File:** `backend/src/routes/knowledge/pages-crud.ts` — `PUT /api/pages/:id`

- [ ] Load page, check `source`
- [ ] If `source === 'standalone'`:
  - Skip Confluence API call
  - Access control: owner or (`visibility = 'shared'`)
  - Increment `version` locally (current version + 1)
  - Source-aware optimistic concurrency: `body.version < existing.version` → 409 Conflict
  - Save version snapshot to `page_versions`
  - Update `body_html`, `body_text`, `embedding_dirty = TRUE`
- [ ] If `source === 'confluence'`: existing behavior (push to Confluence first)

### B4: Standalone Delete (Soft Delete)

**File:** `backend/src/routes/knowledge/pages-crud.ts` — `DELETE /api/pages/:id`

- [ ] Load page, check `source`
- [ ] If `source === 'standalone'`:
  - If `?permanent=true`: hard delete (CASCADE to embeddings, versions, etc.)
  - Otherwise: set `deleted_at = NOW()` (soft delete)
  - Access control: only owner can delete
- [ ] If `source === 'confluence'`: existing behavior (delete from Confluence, then hard delete locally)

### B5: Access Control in Read Routes

**Files:** `pages-crud.ts` — `GET /api/pages`, `GET /api/pages/:id`

- [ ] Replace all `INNER JOIN user_space_selections` with dual-path pattern:

```sql
LEFT JOIN user_space_selections uss
  ON p.space_key = uss.space_key AND uss.user_id = $userId
WHERE (
  (p.source = 'confluence' AND uss.space_key IS NOT NULL)
  OR (p.source = 'standalone' AND p.visibility = 'shared')
  OR (p.source = 'standalone' AND p.visibility = 'private' AND p.created_by_user_id = $userId)
)
AND p.deleted_at IS NULL
```

- [ ] Apply to all 7+ query locations identified by the reviewer in `pages-crud.ts`
- [ ] Apply to `pages-versions.ts`, `pages-tags.ts`, `pages-embeddings.ts`, `pages-duplicates.ts`
- [ ] Apply to `pinned-pages.ts`, `analytics.ts`

### B6: Trash & Restore

**File:** `backend/src/routes/knowledge/pages-crud.ts` (new endpoints)

- [ ] `GET /api/pages/trash` — list soft-deleted standalone articles (owner only)
  - `WHERE source = 'standalone' AND deleted_at IS NOT NULL AND created_by_user_id = $userId`
  - Return `deletedAt` in response
- [ ] `POST /api/pages/:id/restore` — restore from trash
  - Set `deleted_at = NULL`
  - Owner only
- [ ] Auto-purge: background job to hard-delete articles where `deleted_at < NOW() - INTERVAL '30 days'`

---

## Phase C: Backend — Confluence-Free Mode

> **Depends on:** Phase B
>
> **Parallelizable with:** Phase E

### C1: Conditional Confluence Bypass

- [ ] Audit all 10 `getClientForUser()` call sites across 6 route files:
  1. `pages-crud.ts` — POST (create), PUT (update), DELETE
  2. `sync.ts` — POST (trigger sync)
  3. `spaces.ts` — GET (list spaces)
  4. `attachments.ts` — GET (serve attachment)
  5. Any bulk operations (bulk delete, bulk sync, bulk tag)
- [ ] For each: check `source` field or existence of Confluence config before calling
- [ ] Standalone operations must never call `getClientForUser()`

### C2: App Bootstrap

- [ ] `backend/src/index.ts`: remove any Confluence-required startup checks
- [ ] `backend/src/app.ts`: Confluence routes register but return graceful errors when unconfigured
- [ ] Health endpoint (`GET /api/health`): report Confluence as `{ status: 'not_configured' }` instead of `{ status: 'error' }` when no users have PATs

### C3: Background Workers

- [ ] `quality-worker.ts`: add `WHERE deleted_at IS NULL` to all queries
- [ ] `summary-worker.ts`: add `WHERE deleted_at IS NULL` to all queries
- [ ] `embedding-service.ts` `processDirtyPages()`: add `WHERE deleted_at IS NULL`
- [ ] `auto-tagger.ts`: add `WHERE deleted_at IS NULL`
- [ ] `duplicate-detector.ts`: add `WHERE deleted_at IS NULL`
- [ ] All workers: process both `source = 'confluence'` AND `source = 'standalone'` articles
- [ ] Workers must not log private article content (title OK, body NOT OK)

---

## Phase D: Backend — RAG & LLM Pipeline Fixes

> **Depends on:** Phase A4
>
> **Parallelizable with:** Phase B

### D1: RAG Service Access Control

**File:** `backend/src/domains/llm/services/rag-service.ts`

- [ ] `vectorSearch()` (line ~43): replace `INNER JOIN user_space_selections` with dual-path pattern
- [ ] `keywordSearch()` (line ~90): same dual-path pattern
- [ ] Both queries: add `AND p.deleted_at IS NULL`
- [ ] Verify: private standalone articles excluded from other users' RAG queries
- [ ] Verify: shared standalone articles included in all users' RAG queries

### D2: RAG Context Citations

**File:** `backend/src/domains/llm/services/rag-service.ts`

- [ ] `buildRagContext()` (line ~227): replace `Space: ${r.spaceKey}` with:
  ```typescript
  `Space: ${r.spaceKey || 'Local'}`
  ```
- [ ] Audit all other places `spaceKey` appears in LLM prompts/context

### D3: Embedding Service

**File:** `backend/src/domains/llm/services/embedding-service.ts`

- [ ] `processDirtyPages()`: ensure it queries all sources (no `space_key` filter)
- [ ] `getEmbeddingStatus()`: apply dual-path access control pattern
- [ ] `reEmbedAll()`: handle Confluence-free mode (no user PAT needed for standalone articles)

---

## Phase E: Backend — Markdown Import

> **Depends on:** Phase B (standalone create must work)
>
> **Parallelizable with:** Phase C

### E1: Import Route

**File:** `backend/src/routes/knowledge/pages-crud.ts` (or new `pages-import.ts`)

- [ ] `POST /api/pages/import` — multipart form upload
  - Accept: `.md` file(s) or raw Markdown in request body
  - Parse YAML front-matter if present (extract `title`, `tags`)
  - Convert Markdown → HTML via `marked` (v15, already a dependency)
  - Sanitize HTML output (prevent stored XSS)
  - Generate `body_text` via `htmlToText()`
  - Create standalone article(s) via same path as B2
  - Return `{ imported: number, articles: [{ id, title }] }`

### E2: Front-matter Parser

- [ ] Parse YAML front-matter block (`---\ntitle: ...\ntags: [...]\n---`)
- [ ] Use `title` from front-matter if present, else derive from first `# heading` or filename
- [ ] Use `tags` from front-matter as `labels[]`
- [ ] Strip front-matter before Markdown → HTML conversion

### E3: Bulk Import

- [ ] Accept multiple `.md` files in a single multipart request
- [ ] Process sequentially (not parallel — avoid overwhelming DB)
- [ ] Return per-file success/failure results
- [ ] Limit: max 50 files per request (configurable)

### E4: Input Validation

- [ ] File size limit: 1MB per file (configurable)
- [ ] Content-type validation: only `text/markdown`, `text/plain`, `application/octet-stream`
- [ ] Sanitize converted HTML with existing sanitization pipeline
- [ ] Reject files with embedded `<script>` tags or other XSS vectors in raw Markdown

---

## Phase F: Frontend UI

> **Depends on:** Phase B + D (backend CRUD + RAG fixes must be working)

### F1: Page List Updates

**Files:** `frontend/src/features/pages/PagesPage.tsx`, `frontend/src/shared/hooks/use-pages.ts`

- [ ] Source badge on each page card: "Confluence" (blue) or "Local" (green)
- [ ] Visibility badge for standalone: "Private" (lock icon) or "Shared" (globe icon)
- [ ] Filter by source: All / Confluence / Local
- [ ] Filter by visibility: All / Shared / Private (for standalone only)
- [ ] Handle `id` as number (was string from `confluence_id`)

### F2: New Page — Standalone Option

**File:** `frontend/src/features/pages/NewPagePage.tsx`

- [ ] Toggle: "Confluence Article" vs "Local Article"
- [ ] In Confluence-free mode: default to Local, hide Confluence option
- [ ] Local article: space selector hidden, visibility selector shown (Private / Shared)
- [ ] Confluence article: existing flow (space + parent page required)
- [ ] Markdown paste support: detect Markdown in clipboard, offer to convert

### F3: Page View & Edit — Source-Aware

**Files:** `frontend/src/features/pages/PageViewPage.tsx`, editor components

- [ ] For standalone articles:
  - Hide "View in Confluence" link
  - Hide "Sync" button
  - Show "Publish to Confluence" button (Phase G)
  - Show visibility toggle (Private ↔ Shared)
  - Show "Move to Trash" instead of "Delete"
- [ ] For Confluence articles: existing behavior unchanged

### F4: Trash View

**File:** new `frontend/src/features/pages/TrashPage.tsx`

- [ ] List soft-deleted standalone articles (owner only)
- [ ] Each item shows: title, deleted date, permanent delete countdown
- [ ] Actions: Restore, Permanently Delete
- [ ] Add "Trash" link in sidebar navigation
- [ ] Empty state: "No articles in trash"

### F5: Markdown Import UI

**File:** new component in `frontend/src/features/pages/`

- [ ] Drag-and-drop zone for `.md` files
- [ ] Multi-file selection via file picker
- [ ] Preview: show extracted title + first few lines before import
- [ ] Progress indicator for bulk import
- [ ] Success/failure report per file
- [ ] Accessible from: NewPagePage ("Import from Markdown") + sidebar action

### F6: Settings — Confluence Optional

**File:** `frontend/src/features/settings/SettingsPage.tsx`

- [ ] Confluence tab: show "Optional — configure to sync articles from Confluence" messaging
- [ ] When not configured: no error state, just informational empty state
- [ ] Remove any "required" indicators on Confluence fields

### F7: Dashboard — Confluence-Free

**File:** `frontend/src/features/dashboard/DashboardPage.tsx`

- [ ] Show standalone article stats (total local articles, recent, etc.)
- [ ] When Confluence not configured: hide Confluence-specific cards (sync status, spaces)
- [ ] When hybrid: show both sections

### F8: Empty States

- [ ] Pages list (no articles): "Create your first article" CTA
- [ ] Dashboard (no data): onboarding flow — "Get started by creating an article or connecting Confluence"
- [ ] Spaces list (no Confluence): "Connect Confluence to sync spaces, or create local articles"

---

## Phase G: Publish to Confluence

> **Depends on:** Phase B + C + F (standalone CRUD + Confluence-free mode + frontend working)

### G1: Backend Route

**File:** `backend/src/routes/knowledge/pages-crud.ts`

- [ ] `POST /api/pages/:id/publish`
  - Validate: page exists, `source === 'standalone'`, user owns it or it's shared
  - Validate: user has Confluence configured (`getClientForUser()`)
  - Request body: `{ spaceKey, parentId? }`
  - Convert `body_html` → Confluence XHTML via `htmlToConfluence()`
  - Call `client.createPage(spaceKey, title, storageBody, parentId)`
  - Update page: `source = 'confluence'`, `confluence_id = result.id`, `space_key = spaceKey`, `body_storage = storageBody`
  - All FK-dependent data (embeddings, versions, improvements, pins) survives — they reference `pages.id` (SERIAL), not `confluence_id`
  - Return `{ id, confluenceId, spaceKey }`

### G2: Access Check

- [ ] Verify user has write permission to target Confluence space
- [ ] If publish fails (401/403/500): return error, do NOT modify local article
- [ ] Atomic: either fully transition or fully rollback (wrap in transaction)

### G3: Frontend

**File:** `frontend/src/features/pages/PageViewPage.tsx`

- [ ] "Publish to Confluence" button on standalone article view
- [ ] Dialog: select target space (from user's configured spaces), optional parent page
- [ ] Loading state during publish
- [ ] Success: refresh page, show Confluence badge, show "View in Confluence" link
- [ ] Error: toast with error message, article remains standalone

---

## Phase H: Testing & Documentation

> **Depends on:** All previous phases

### H1: Backend Tests

- [ ] **Standalone CRUD tests** (`pages-crud.test.ts`):
  - Create standalone article (no Confluence)
  - Edit standalone article (version increment)
  - Soft-delete standalone article
  - Restore from trash
  - Permanent delete from trash
  - Access control: private article invisible to non-owner
  - Access control: shared article visible to all
  - Optimistic concurrency conflict (409)

- [ ] **Confluence-free bootstrap tests**:
  - App starts with no Confluence env vars
  - Health endpoint returns `{ confluence: 'not_configured' }`
  - Sync routes return graceful empty state
  - Standalone CRUD works without Confluence

- [ ] **RAG mixed content tests** (`rag-service.test.ts`):
  - Standalone shared articles appear in RAG results
  - Standalone private articles excluded from other users' RAG
  - Standalone private articles included in owner's RAG
  - Citations show "Local" for standalone articles
  - Soft-deleted articles excluded from RAG

- [ ] **Publish-to-Confluence tests**:
  - Successful publish transitions source + populates confluence_id
  - Embeddings/versions/pins survive transition
  - Publish failure does not modify local article
  - Access check: can't publish to space without write permission

- [ ] **Background worker tests**:
  - Workers process standalone articles
  - Workers skip soft-deleted articles
  - Workers don't log private article body content

- [ ] **Markdown import tests**:
  - Single file import
  - Bulk import (multiple files)
  - YAML front-matter parsing (title, tags)
  - XSS sanitization on converted HTML
  - File size limit enforcement
  - Invalid file rejection

### H2: Frontend Tests

- [ ] Standalone article creation flow
- [ ] Source/visibility badge rendering
- [ ] Trash view: list, restore, permanent delete
- [ ] Markdown import: drag-and-drop, file picker
- [ ] Confluence-free empty states
- [ ] Publish-to-Confluence dialog flow

### H3: Documentation

- [ ] **ADR-020** in `docs/ARCHITECTURE-DECISIONS.md`:
  - Decision: shared `pages` table with `source` discriminator
  - Decision: SERIAL `id` as universal FK
  - Decision: dual-path access control
  - Decision: soft delete for standalone articles
  - Decision: Markdown import via `marked`
  - Alternatives considered and rejected

- [ ] **Update `CLAUDE.md`**:
  - Schema section: `pages` table (was `cached_pages`)
  - New columns: `source`, `visibility`, `created_by_user_id`, `deleted_at`
  - Migration count: 28 → 030
  - New routes: `/api/pages/trash`, `/api/pages/:id/restore`, `/api/pages/:id/publish`, `/api/pages/import`
  - Confluence marked as optional

- [ ] **Update `docs/ACTION-PLAN.md`**:
  - Add Phase 7 reference pointing to this document
  - Update migration count (026 → 030)
  - Update architecture diagram (Confluence as optional)

- [ ] **Update `.env.example`**:
  - Mark all Confluence vars as optional with comments
  - Add: `TRASH_AUTO_PURGE_DAYS=30` (optional, default 30)

---

## Implementation Order (Recommended)

```
Step 1:  Phase A1 (table rename)                        ~2 hours
Step 2:  Phase A2 (schema changes)                      ~1 hour
Step 3:  Phase A3 (FK migration)                        ~2 hours
Step 4:  Phase A4 (backend code updates)                ~4 hours
         ├── verify: npm run typecheck && npm test
Step 5:  Phase B (standalone CRUD) + Phase D (RAG)      ~4 hours (parallel)
         ├── verify: standalone create/edit/delete works
         ├── verify: RAG includes standalone articles
Step 6:  Phase C (Confluence-free) + Phase E (import)   ~3 hours (parallel)
         ├── verify: app boots without Confluence
         ├── verify: markdown import works
Step 7:  Phase F (frontend UI)                          ~6 hours
         ├── verify: full UI flow works
Step 8:  Phase G (publish to Confluence)                ~3 hours
         ├── verify: publish transitions correctly
Step 9:  Phase H (tests + docs)                         ~4 hours
         ├── verify: all tests pass, docs updated
```

**Feature branch:** `feature/standalone-articles` (from `dev`)

**PR target:** `dev` (NEVER `main`)

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Migration breaks existing data | 3-phase migration with independent rollback per phase |
| Table rename breaks queries | Automated find-and-replace + full test suite verification |
| Dual access control has gaps | Explicit SQL pattern documented, applied consistently, tested |
| RAG excludes standalone articles | Dedicated test cases for mixed content RAG |
| Publish orphans dependent data | FK on SERIAL `id` — no orphaning possible |
| XSS via Markdown import | Existing sanitization pipeline + dedicated test cases |
| Workers leak private content | Workers process all but never log body content; read-time access control |

---

## Success Criteria

1. **Standalone mode:** App boots, user creates/edits/deletes articles, RAG works — with zero Confluence configuration
2. **Hybrid mode:** Standalone + Confluence articles coexist, both appear in search/RAG, correct access control
3. **Publish flow:** Standalone article pushed to Confluence, all dependent data survives
4. **Markdown import:** `.md` files imported as standalone articles with front-matter support
5. **Soft delete:** Trash view with restore, auto-purge after 30 days
6. **No regression:** All existing Confluence-based functionality continues to work unchanged
7. **All tests pass:** `npm test` green across backend + frontend
