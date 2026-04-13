# Comprehensive Implementation Plan: All Open GitHub Issues

**Date**: 2026-04-03
**Scope**: 48 open issues (excluding #30)
**Branch Base**: `dev`

---

## Executive Summary

This plan covers 48 open GitHub issues spanning six categories: **security** (6), **performance** (13), **backend code hygiene** (7), **frontend** (7), **documentation** (2), and **unused code/cleanup** (9), plus 4 issues flagged as critical/high priority.

**Key themes identified through codebase investigation:**

1. **Security hardening** -- Path traversal in attachment handler, error information leakage, GCM auth tag deprecation, innerHTML usage in content converter, and stale security documentation.
2. **Performance optimization** -- COUNT(*) queries on every search, SHA-256 recomputation across all pages every batch, N+1 query patterns, sequential queries that can be parallelized, missing caches, and frontend bundle bloat from `domMax`.
3. **Enterprise feature alignment** -- LicenseInfo type mismatch between backend/frontend, feature flag naming inconsistency risk.
4. **Dead code and dependency cleanup** -- 284 files in `node_modules.old` tracked in git, 7+ unused npm packages, unused components, duplicate code.
5. **TypeScript strictness** -- `noUncheckedIndexedAccess` would catch 516 potential undefined-access bugs but requires a phased migration.

**Recommended approach**: Six phases over approximately 4-6 weeks, executing security and critical fixes first, then performance, then cleanup. Each phase targets a cohesive set of changes that can be reviewed and merged independently.

---

## Phase 1: Critical Fixes and Security Hardening

**Goal**: Eliminate all security vulnerabilities and critical bugs.
**Duration**: 3-5 days
**Issues**: #103, #87, #71, #70, #82, #75, #104, #105

### Issue #103 -- EE Feature Flag Identifier Mismatch
- **Complexity**: S
- **Risk**: Critical -- if EE package uses kebab-case while CE defines snake_case, feature checks silently fail
- **Affected files**:
  - `backend/src/core/enterprise/features.ts` (source of truth, uses snake_case: `oidc_sso`, `advanced_rbac`)
  - `frontend/src/shared/enterprise/context.test.tsx` (already uses `oidc_sso`)
- **Investigation finding**: The CE codebase consistently uses snake_case (`oidc_sso`, `scim_provisioning`, etc.) in `features.ts`. The test in `context.test.tsx:34` also uses `oidc_sso`. The mismatch risk is in the **EE package** (not in this repo). However, the CE should add a compile-time or runtime assertion that feature identifiers match the expected format.
- **Implementation approach**:
  1. Add a unit test in `features.test.ts` that asserts all values match `/^[a-z][a-z0-9_]*$/` (snake_case pattern).
  2. Add a `validateFeatureIdentifier()` function that the EE loader calls on registered features.
  3. Export a `FEATURE_ID_PATTERN` constant from `features.ts` so the EE package can validate against it.
- **Dependencies**: None

### Issue #105 -- LicenseInfo Type Structural Differences
- **Complexity**: S
- **Risk**: High -- type misalignment causes runtime surprises when EE is loaded
- **Affected files**:
  - `backend/src/core/enterprise/types.ts` -- `LicenseInfo` has `expiresAt: Date`, `seats: number` (required), no `edition`
  - `frontend/src/shared/enterprise/types.ts` -- `LicenseInfo` has `expiresAt?: string`, `seats?: number` (optional), has `edition: string`
- **Investigation finding**: Confirmed structural differences:
  - Backend: `seats: number` (required) vs Frontend: `seats?: number` (optional)
  - Backend: `expiresAt: Date` vs Frontend: `expiresAt?: string` (different type + optionality)
  - Backend: no `edition` field vs Frontend: `edition: string`
  - Backend: `features?: string[]` (optional) vs Frontend: `features: string[]` (required)
- **Implementation approach**:
  1. Create a shared `LicenseInfo` schema in `packages/contracts/src/license.ts`.
  2. Backend type: `expiresAt: Date`, `seats: number` (internal, not serialized).
  3. API response type (contracts): `expiresAt: string` (ISO 8601), `seats: number`, `edition: string`, `features: string[]`.
  4. Frontend uses the API response type from contracts.
  5. Backend serializes `Date` to ISO string at the API boundary.
- **Dependencies**: None

### Issue #87 -- Error Handler Leaks Error Names
- **Complexity**: S
- **Risk**: Medium -- exposes internal error class names (e.g., `TypeError`, `RangeError`) to clients
- **Affected files**: `backend/src/app.ts` line 171-175
- **Investigation finding**: Confirmed. Line 172: `error: error.name ?? 'InternalServerError'` sends the raw error class name for non-500 errors. For example, a 400 error from Fastify's `httpErrors.badRequest()` sends `error: "BadRequestError"` which is fine, but a 404 from an unhandled route sends `error: "NotFoundError"` -- these Fastify errors are OK. The risk is when an unexpected error (e.g., `TypeError`) gets a non-500 status code via `error.statusCode`.
- **Implementation approach**:
  1. For 4xx errors from `fastify.httpErrors.*`, keep the error name (these are intentional).
  2. For other non-500 errors, use a generic name based on status code (e.g., `ClientError`).
  3. Never send raw `error.name` for errors that aren't from the Fastify error factory.
  ```typescript
  const isHttpError = 'statusCode' in error && error.constructor.name.endsWith('Error');
  const errorName = statusCode === 500
    ? 'InternalServerError'
    : (statusCode >= 400 && statusCode < 500 ? 'ClientError' : 'ServerError');
  ```
- **Dependencies**: None

### Issue #71 -- Path Traversal in attachment-handler.ts
- **Complexity**: S
- **Risk**: High -- `pageId` is used directly in `path.join(ATTACHMENTS_BASE, pageId)` without sanitization
- **Affected files**: `backend/src/domains/confluence/services/attachment-handler.ts` line 41-42
- **Investigation finding**: Confirmed. The `attachmentDir()` function at line 41 uses `pageId` directly: `path.join(ATTACHMENTS_BASE, pageId)`. While `filename` is sanitized with `path.basename()` at line 47, `pageId` is not. A crafted `pageId` like `../../etc` could escape the attachments directory.
- **Implementation approach**:
  1. Sanitize `pageId` in `attachmentDir()`: strip path separators, reject if empty after sanitization.
  2. Add a resolved-path check: verify the result starts with `ATTACHMENTS_BASE`.
  ```typescript
  function attachmentDir(_userId: string, pageId: string): string {
    const safe = pageId.replace(/[/\\]/g, '_');
    if (!safe) throw new Error('Invalid page ID');
    const dir = path.join(ATTACHMENTS_BASE, safe);
    if (!dir.startsWith(path.resolve(ATTACHMENTS_BASE))) {
      throw new Error('Path traversal detected');
    }
    return dir;
  }
  ```
  3. Add tests for traversal attempts: `../../../etc/passwd`, `..%2F..%2F`, etc.
- **Dependencies**: None

### Issue #70 -- GCM Decryption Missing Explicit Auth Tag Length
- **Complexity**: S
- **Risk**: Medium -- DEP0182 is a runtime deprecation in Node.js 23+. Will break on future Node versions.
- **Affected files**: `backend/src/core/utils/crypto.ts` line 142
- **Investigation finding**: Confirmed via Node.js docs. `decipher.setAuthTag(authTag)` works but Node.js 23+ emits a deprecation warning (DEP0182) when the auth tag length is not explicitly specified in `createDecipheriv()`. The fix is to pass `{ authTagLength: 16 }` as the options parameter.
- **Implementation approach**:
  1. Change `createDecipheriv(ALGORITHM, key, iv)` to `createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 })`.
  2. Verify existing tests still pass (the auth tag is already 16 bytes by default).
  3. Add a constant: `const AUTH_TAG_LENGTH = 16;`
- **Dependencies**: None

### Issue #82 -- Setup Endpoint Rate Limiting
- **Complexity**: S
- **Risk**: Medium
- **Affected files**: `backend/src/routes/foundation/setup.ts`
- **Investigation finding**: Partially mitigated. `POST /api/setup/admin` already has `SETUP_RATE_LIMIT` using auth-category limits (5/min). However, `GET /api/health/setup-status` has no rate limit and runs two COUNT(*) queries on every call. Also, the setup-status endpoint is public (no auth) and could be used for information disclosure (whether an admin exists).
- **Implementation approach**:
  1. Add rate limiting to `GET /api/health/setup-status` (use global rate limit category).
  2. Consider caching the setup-status response for 10 seconds (it changes rarely).
  3. Add a rate limit specific to setup-related endpoints (stricter than global: e.g., 10/min).
- **Dependencies**: None

### Issue #75 -- TLS Bypass Warnings
- **Complexity**: S
- **Risk**: Low -- current implementation is functional but warnings should be more prominent
- **Affected files**:
  - `backend/src/core/utils/tls-config.ts` lines 54-57
  - `backend/src/domains/llm/services/openai-service.ts` lines 35-49
- **Investigation finding**: Both files log warnings when TLS verification is disabled. The concern is that these warnings are logged once at startup and may be missed. The code pattern is sound for internal deployments with self-signed certs.
- **Implementation approach**:
  1. Add a periodic warning (every 24h) when TLS bypass is active, not just at startup.
  2. Add a health check warning: `GET /api/health` should include `"tlsWarnings"` when bypass is active.
  3. Document the security implications in the admin guide.
- **Dependencies**: None

### Issue #104 -- Stale Security Audit
- **Complexity**: M
- **Risk**: Medium -- outdated audit gives false confidence
- **Affected files**: `docs/SECURITY-AUDIT.md`
- **Investigation finding**: Confirmed. The audit references `routes/llm/llm-chat.ts` (line 52 and 119) which was split into `llm-ask.ts`, `llm-improve.ts`, `llm-generate.ts`, `llm-diagram.ts`, `llm-summarize.ts`, `llm-quality.ts`, and `llm-pdf.ts`. Also missing: `setup.ts` (admin account creation endpoint), `llm-admin.ts`, `knowledge-admin.ts`, the new rate-limit-service, and RBAC routes.
- **Implementation approach**:
  1. Re-audit all route files in `routes/` against the security checklist.
  2. Update file references (llm-chat.ts -> split files).
  3. Add new files to the audit: setup.ts, rbac.ts, llm-admin.ts, knowledge-admin.ts.
  4. Add the new rate-limit-service and admin-settings-service to the audit.
  5. Automate: add a CI check that verifies all route files appear in the security audit.
- **Dependencies**: Best done after #87, #71, #70 are resolved

### Execution order within Phase 1:
1. #71 (path traversal -- most critical security fix)
2. #70 (GCM auth tag -- simple, prevents future Node.js breakage)
3. #87 (error leakage -- quick fix)
4. #103 + #105 (enterprise type alignment -- do together)
5. #82 (setup rate limiting)
6. #75 (TLS warnings -- low risk)
7. #104 (security audit update -- do last after fixes are merged)

---

## Phase 2: Performance -- High-Impact Database Optimizations

**Goal**: Fix the most impactful performance issues (queries that run on every request or every batch cycle).
**Duration**: 3-5 days
**Issues**: #102, #97, #96, #95, #110, #109, #73, #80

### Issue #102 -- COUNT(*) on page_embeddings for Every Search
- **Complexity**: M
- **Risk**: High -- runs a full JOIN + COUNT on every semantic/hybrid search request
- **Affected files**: `backend/src/routes/knowledge/search.ts` lines 87-106
- **Investigation finding**: Confirmed. Every semantic or hybrid search executes:
  ```sql
  SELECT COUNT(*) FROM page_embeddings pe
  JOIN pages cp ON pe.page_id = cp.id
  WHERE ... AND cp.deleted_at IS NULL
  ```
  This is only used to determine if embeddings exist (count > 0), not the actual count.
- **Implementation approach**:
  1. Replace `COUNT(*)` with `SELECT EXISTS(SELECT 1 FROM page_embeddings pe JOIN pages cp ON pe.page_id = cp.id WHERE ... LIMIT 1)`.
  2. Cache the result in Redis with a short TTL (60s) keyed by user ID.
  3. Invalidate when embeddings are added/removed.
  4. Alternative: use a materialized flag on user_settings or admin_settings.
- **Dependencies**: None

### Issue #97 -- SHA-256 Recomputation on All Pages Every Batch
- **Complexity**: M
- **Risk**: High -- PostgreSQL computes `sha256(convert_to(body_text, 'UTF-8'))` for every summarized page every cycle
- **Affected files**: `backend/src/domains/knowledge/services/summary-worker.ts` lines 291-301
- **Investigation finding**: The issue title says "quality worker" but the actual problem is in **summary-worker.ts** line 300:
  ```sql
  AND summary_content_hash != encode(sha256(convert_to(body_text, 'UTF-8')), 'hex')
  ```
  This runs on ALL pages with `summary_status = 'summarized'` every batch cycle, computing SHA-256 in PostgreSQL for every row.
- **Implementation approach**:
  1. **Option A (recommended)**: Add a trigger or use the `last_modified_at` timestamp. If `last_modified_at > summary_analyzed_at`, the content may have changed -- then compute the hash only for those rows.
  2. **Option B**: Store a `body_text_hash` column that is updated on INSERT/UPDATE via a PostgreSQL trigger. Then the comparison becomes a simple column equality check.
  3. **Option C**: Compute the hash in the application layer only for pages where `last_modified_at` has changed since `summary_content_hash` was last set.
  4. Recommended: Option A is simplest -- replace the SQL hash comparison with a timestamp check, then verify with hash only for candidates.
- **Dependencies**: May need a migration to add a `body_text_modified_at` trigger or `body_text_hash` column.

### Issue #96 -- Sequential Search Queries
- **Complexity**: S
- **Risk**: Medium -- latency adds up for keyword search mode
- **Affected files**: `backend/src/routes/knowledge/search.ts` lines 274-332
- **Investigation finding**: In keyword search mode, queries run sequentially:
  1. `getUserAccessibleSpaces()` (line 79)
  2. Embeddings COUNT check (lines 88-106, already addressed by #102)
  3. FTS count query (line 274)
  4. FTS data query (line 284)
  5. Trigram query (line 309)
  6. Facet query (line 381)

  The FTS data query and trigram query are independent and can run in parallel. The facet query is also independent if the count is derived differently.
- **Implementation approach**:
  1. Run FTS data + trigram + facets in `Promise.all()`.
  2. Derive total count from `COUNT(*) OVER()` window function in the data query instead of a separate count query.
  3. This eliminates one query entirely and parallelizes the remaining two.
- **Dependencies**: Benefits from #102 being done first (removes the COUNT query)

### Issue #95 -- N+1 Query in Children Pages Route
- **Complexity**: M
- **Risk**: Medium -- recursive fetch fires one query per parent node
- **Affected files**: `backend/src/routes/knowledge/pages-crud.ts` lines 726-761
- **Investigation finding**: Confirmed. `fetchChildren()` is recursive: for each child, it queries again for sub-children. With depth=3 and 50 children per level, this is 1 + 50 + 2500 = 2551 queries.
- **Implementation approach**:
  1. Replace recursive function with a single recursive CTE:
  ```sql
  WITH RECURSIVE tree AS (
    SELECT id, confluence_id, title, space_key, parent_id, 1 AS depth
    FROM pages WHERE parent_id = $1 AND deleted_at IS NULL
    UNION ALL
    SELECT p.id, p.confluence_id, p.title, p.space_key, p.parent_id, t.depth + 1
    FROM pages p JOIN tree t ON p.parent_id = COALESCE(t.confluence_id, t.id::text)
    WHERE p.deleted_at IS NULL AND t.depth < $2
  )
  SELECT * FROM tree ORDER BY depth, title LIMIT $3
  ```
  2. Assemble the tree structure in application code from the flat result set.
  3. Keep the MAX_TOTAL_NODES cap.
- **Dependencies**: None

### Issue #110 -- Sequential Feedback Queries in Content Analytics
- **Complexity**: S
- **Risk**: Low -- two queries per request that could be parallel
- **Affected files**: `backend/src/routes/knowledge/content-analytics.ts` lines 64-83
- **Investigation finding**: Confirmed. `GET /api/pages/:id/feedback` runs `summary` and `userVote` queries sequentially.
- **Implementation approach**:
  1. Wrap in `Promise.all([summaryQuery, userVoteQuery])`.
  2. Or combine into a single query with a LEFT JOIN.
- **Dependencies**: None

### Issue #109 -- Uncached /pages/filters Endpoint
- **Complexity**: S
- **Risk**: Medium -- DISTINCT queries on every request for authors and labels
- **Affected files**: `backend/src/routes/knowledge/pages-crud.ts` lines 471-495
- **Investigation finding**: Confirmed. Two `SELECT DISTINCT` queries run on every call. The results change infrequently (only when pages are synced or labels change).
- **Implementation approach**:
  1. Cache the result in Redis with a 5-minute TTL, keyed by user's accessible spaces.
  2. Invalidate on sync completion or label changes.
  3. The existing `Promise.all()` for the two queries is fine.
- **Dependencies**: None

### Issue #73 -- N+1 Query in Admin Settings Upsert
- **Complexity**: S
- **Risk**: Low -- affects admin-only operations (infrequent)
- **Affected files**: `backend/src/core/services/admin-settings-service.ts` lines 134-141
- **Investigation finding**: Confirmed. Each setting is upserted individually in a loop.
- **Implementation approach**:
  1. Use `unnest()` with a single INSERT...ON CONFLICT:
  ```sql
  INSERT INTO admin_settings (setting_key, setting_value, updated_at)
  SELECT key, value, NOW()
  FROM unnest($1::text[], $2::text[]) AS t(key, value)
  ON CONFLICT (setting_key) DO UPDATE
  SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
  ```
  2. Similarly, batch the DELETE operations: `DELETE FROM admin_settings WHERE setting_key = ANY($1::text[])`.
- **Dependencies**: None (also addresses #80)

### Issue #80 -- Sequential DELETE Queries in Admin Settings
- **Complexity**: S (included in #73 fix)
- **Risk**: Low
- **Affected files**: `backend/src/core/services/admin-settings-service.ts` lines 102-131
- **Implementation approach**: Addressed as part of #73 -- batch deletes into a single `DELETE WHERE setting_key = ANY($1)`.
- **Dependencies**: Bundle with #73

### Execution order within Phase 2:
1. #102 (COUNT(*) on every search -- highest user-facing impact)
2. #97 (SHA-256 recomputation -- highest background-worker impact)
3. #95 (N+1 children query -- can cause significant latency)
4. #96 (search parallelization -- benefits from #102 being done)
5. #110 (feedback queries -- quick win)
6. #109 (filters caching -- quick win)
7. #73 + #80 (admin settings batching -- bundle together)

---

## Phase 3: Performance -- Infrastructure and Frontend

**Goal**: Address infrastructure-level performance issues and frontend bundle optimization.
**Duration**: 3-5 days
**Issues**: #114, #113, #99, #98, #100, #101, #89, #78, #77

### Issue #114 -- Separate pg Pool for pgvector Queries
- **Complexity**: M
- **Risk**: Medium -- pgvector queries use `SET LOCAL hnsw.ef_search` which requires a dedicated connection
- **Affected files**:
  - `backend/src/core/db/postgres.ts` (pool creation)
  - `backend/src/domains/llm/services/rag-service.ts` (vectorSearch acquires client from main pool)
- **Investigation finding**: `vectorSearch()` at line 36 acquires a client from the main pool (`getPool().connect()`), runs `BEGIN`, `SET LOCAL`, a potentially slow cosine-distance query, and `COMMIT`. This ties up a main pool connection for the duration of the vector search. If all 20 pool connections are used by vector searches, regular CRUD queries queue up.
- **Implementation approach**:
  1. Create a `getVectorPool()` that returns a separate `pg.Pool` with a smaller `max` (e.g., 5 connections).
  2. Configure the vector pool with a longer `connectionTimeoutMillis` (10s) and `statement_timeout` (30s).
  3. Update `vectorSearch()` to use the vector pool.
  4. Make the vector pool size configurable via `PG_VECTOR_POOL_MAX` env var.
  5. Add the vector pool to the shutdown sequence.
- **Dependencies**: None

### Issue #113 -- connectionTimeoutMillis
- **Complexity**: S
- **Risk**: Low -- already resolved
- **Affected files**: `backend/src/core/db/postgres.ts` line 17
- **Investigation finding**: **Already fixed.** `connectionTimeoutMillis: 5_000` is present in the pool config. The issue may have been filed before this was added.
- **Implementation approach**: Close the issue as resolved. Optionally, make the timeout configurable via `PG_CONNECTION_TIMEOUT` env var.
- **Dependencies**: None

### Issue #99 -- Frontend domMax Instead of domAnimation
- **Complexity**: S
- **Risk**: Low -- reduces bundle size by ~20-30KB
- **Affected files**: `frontend/src/App.tsx` line 3 and 109
- **Investigation finding**: Confirmed. `App.tsx` uses `domMax` which includes layout animations, drag, and other features. The app uses basic motion (opacity, transform, staggered entrance). `domAnimation` provides all of these. `domMax` adds layout projection and drag/drop which are not used.
- **Implementation approach**:
  1. Change `import { LazyMotion, domMax }` to `import { LazyMotion, domAnimation }`.
  2. Verify no components use `layout`, `layoutId`, `drag`, or `AnimatePresence` with layout features.
  3. Update all test files that import `domMax` to use `domAnimation`.
  4. If any component does need layout features, lazy-load `domMax` only for that route.
- **Dependencies**: None (but run full test suite to verify no layout animations break)

### Issue #98 -- Redis Cache Stampede Risk
- **Complexity**: M
- **Risk**: Medium -- under load, multiple concurrent requests can miss cache simultaneously
- **Affected files**:
  - `backend/src/routes/knowledge/pages-crud.ts` (page list cache)
  - `backend/src/routes/knowledge/pages-crud.ts` (page tree cache)
  - `backend/src/core/services/redis-cache.ts` (no stampede protection)
- **Investigation finding**: The LLM cache (`llm-cache.ts`) already has a lock-based stampede prevention pattern (acquireLock/waitForCachedResponse). The general Redis cache used by pages-crud does not.
- **Implementation approach**:
  1. Create a generic `getOrCompute(key, computeFn, ttl)` utility in `redis-cache.ts` that:
     - Checks cache, returns if hit.
     - Acquires a NX lock, computes if acquired, stores result.
     - If lock not acquired, polls for result with short timeout.
     - Falls through to compute on timeout (graceful degradation).
  2. Apply to page list cache and page tree cache.
  3. Reuse the pattern from `llm-cache.ts`.
- **Dependencies**: None

### Issue #100 -- Notification Polling Every 30s
- **Complexity**: S
- **Risk**: Low -- reduces unnecessary API calls
- **Affected files**: `frontend/src/shared/components/layout/NotificationBell.tsx` line 14
- **Investigation finding**: Confirmed. `refetchInterval: 30_000` polls every 30 seconds.
- **Implementation approach**:
  1. Increase to 60 seconds: `refetchInterval: 60_000`.
  2. Add a `refetchOnWindowFocus: true` to catch up when the user returns.
  3. Future: consider SSE or WebSocket for real-time notifications (separate issue).
- **Dependencies**: None

### Issue #101 -- No Data Retention Policy for Append-Only Tables
- **Complexity**: L
- **Risk**: Medium -- tables grow unbounded; affects long-running instances
- **Affected files**: Multiple append-only tables:
  - `audit_log` -- grows continuously
  - `search_analytics` -- every search query logged
  - `error_log` -- every 500 error logged
  - `page_versions` -- every page edit creates a version
  - `article_feedback` -- every feedback submission
- **Investigation finding**: No cleanup mechanism exists for any of these tables. The token cleanup service only handles `refresh_tokens`.
- **Implementation approach**:
  1. Create a `data-retention-service.ts` with configurable retention periods per table.
  2. Default retention periods:
     - `audit_log`: 365 days
     - `search_analytics`: 90 days
     - `error_log`: 30 days
     - `page_versions`: keep last 50 per page
     - `article_feedback`: no auto-delete
  3. Run cleanup via `setInterval` (daily at 3 AM or configurable).
  4. Add env vars: `RETENTION_AUDIT_DAYS`, `RETENTION_SEARCH_DAYS`, `RETENTION_ERROR_DAYS`, `RETENTION_VERSIONS_MAX`.
  5. Add admin API endpoint to view table sizes and trigger manual cleanup.
  6. Add migration to create indexes on `created_at` columns if missing (for efficient DELETE).
- **Dependencies**: None

### Issue #89 -- Sequential Worker Triggers at Startup
- **Complexity**: S
- **Risk**: Low -- startup delay, not a runtime issue
- **Affected files**: `backend/src/index.ts` lines 87-90
- **Investigation finding**: Confirmed. After a 30s delay, `triggerQualityBatch()` and `triggerSummaryBatch()` run sequentially. Both make LLM calls which can take minutes.
- **Implementation approach**:
  1. Run in parallel: `await Promise.all([triggerQualityBatch(), triggerSummaryBatch()])`.
  2. Or better: stagger them with different delays (30s for quality, 60s for summary) to avoid resource contention.
  3. Consider: make initial trigger configurable/optional via env var.
- **Dependencies**: None

### Issue #78 -- Sequential Per-Page Embedding Processing
- **Complexity**: M
- **Risk**: Medium -- embedding large spaces takes a long time
- **Affected files**: `backend/src/domains/llm/services/embedding-service.ts` lines 477-530
- **Investigation finding**: Pages are processed strictly sequentially with a sleep between pages (`INTER_PAGE_DELAY_MS`). This is intentional to avoid overwhelming the LLM server. However, the per-page processing includes multiple sequential operations: UPDATE status, embed, UPDATE result.
- **Implementation approach**:
  1. Keep sequential page processing (LLM rate limiting is important).
  2. Batch the status UPDATEs: mark multiple pages as 'embedding' at once.
  3. Use pipeline/batch for the post-embedding database writes.
  4. Consider: configurable concurrency (e.g., `EMBEDDING_CONCURRENCY=2`) for users with powerful GPU servers.
  5. The `INTER_PAGE_DELAY_MS` is the main throttle; reducing it is the biggest win.
- **Dependencies**: Benefits from #114 (separate vector pool) to avoid blocking CRUD during batch embedding

### Issue #77 -- Lazy-Load Heavy Frontend Dependencies
- **Complexity**: S
- **Risk**: Low
- **Affected files**:
  - `frontend/src/shared/components/diagrams/MermaidDiagram.tsx` -- already lazy-loads mermaid
  - `frontend/src/features/graph/GraphPage.tsx` -- static import but route is lazy-loaded
- **Investigation finding**: **Partially resolved.** Mermaid is already lazy-loaded via dynamic import. `react-force-graph-2d` is statically imported in `GraphPage.tsx`, but `GraphPage` itself is lazy-loaded via `React.lazy()` in `App.tsx`. The bundle splitting is already effective at the route level.
- **Implementation approach**: Close or reduce scope. The only optimization would be to dynamic-import `react-force-graph-2d` within `GraphPage.tsx` for an even smaller initial chunk, but the benefit is marginal since the page itself is already code-split.
- **Dependencies**: None

### Execution order within Phase 3:
1. #99 (domMax -> domAnimation -- quick win, measurable bundle reduction)
2. #100 (notification polling -- trivial change)
3. #89 (startup worker sequencing -- trivial change)
4. #113 (verify already resolved, close issue)
5. #77 (verify partially resolved, close or reduce scope)
6. #114 (separate pg pool -- requires design + testing)
7. #98 (stampede protection -- builds generic utility)
8. #101 (data retention -- largest in this phase)
9. #78 (embedding batching -- careful optimization)

---

## Phase 4: Backend Code Hygiene

**Goal**: Improve code quality, type safety, and test coverage.
**Duration**: 5-7 days
**Issues**: #112, #111, #107, #106, #91, #76, #72

### Issue #112 -- Enable noUncheckedIndexedAccess
- **Complexity**: XL
- **Risk**: Medium -- 516 type errors in backend alone
- **Affected files**: `backend/tsconfig.json` + 100+ source files
- **Investigation finding**: Running `tsc --noUncheckedIndexedAccess` produces 516 errors. Common patterns:
  - `rows[0].count` -- query results assumed to have at least one row
  - `parts[1]` -- string splits assumed to produce expected number of parts
  - `config[key]` -- object indexing without undefined check
- **Implementation approach**: **Phased migration** (do NOT enable globally at once):
  1. **Phase A**: Create a `tsconfig.strict.json` that extends base with `noUncheckedIndexedAccess: true`.
  2. **Phase B**: Fix files one domain at a time, adding `// @ts-expect-error` or proper checks.
  3. **Phase C**: Use a script to track progress: `tsc --noUncheckedIndexedAccess 2>&1 | grep "error TS" | wc -l`.
  4. **Phase D**: Enable globally when error count reaches zero.
  5. Common fix patterns:
     - `rows[0]?.count ?? '0'` for query results
     - Non-null assertion `rows[0]!` where query guarantees a result (e.g., `LIMIT 1` with existence check)
     - `at(0)` method which returns `T | undefined` (already correct type)
  6. Estimate: ~2-3 days of focused work for 516 fixes.
- **Dependencies**: Should be done after #106 (shared contracts) to avoid fixing schemas that will be moved

### Issue #111 -- In-Memory Locks Won't Work Multi-Container
- **Complexity**: M
- **Risk**: Medium -- deploying multiple instances causes duplicate work
- **Affected files**:
  - `backend/src/domains/knowledge/services/quality-worker.ts` -- `qualityLock` (line 37)
  - `backend/src/domains/knowledge/services/summary-worker.ts` -- `workerLock` (line 41)
  - `backend/src/core/services/token-cleanup-service.ts` -- `cleanupLock` (line 15)
- **Investigation finding**: Confirmed. All three use `let lock = false` in-memory flags. The embedding service already uses Redis-based distributed locks (`redis-cache.ts` lines 42-104). The pattern exists; it just needs to be applied to the other workers.
- **Implementation approach**:
  1. Create a generic `acquireWorkerLock(name, ttl)` / `releaseWorkerLock(name)` in `redis-cache.ts`.
  2. Replace in-memory locks in quality-worker, summary-worker, and token-cleanup-service.
  3. Use SET NX EX pattern (same as embedding lock).
  4. Keep in-memory locks as fast-path (check in-memory first, then Redis).
  5. Graceful fallback: if Redis unavailable, fall back to in-memory lock.
- **Dependencies**: None

### Issue #107 -- 12 Backend Service Files Lack Tests
- **Complexity**: L
- **Risk**: Low -- technical debt
- **Affected files** (missing direct test files):
  1. `core/services/ai-safety-service.ts`
  2. `core/services/image-references.ts`
  3. `core/services/notification-service.ts`
  4. `core/services/rate-limit-service.ts`
  5. `core/services/version-snapshot.ts`
  6. `core/services/mcp-docs-client.ts`
  7. `core/services/admin-settings-service.ts`
  8. `core/services/fts-language.ts`
  9. `core/utils/logger.ts`
  10. `core/utils/version.ts`
  11. `domains/llm/services/ollama-provider.ts`
- **Investigation finding**: 11 files lack direct test files (excluding the `__fixtures__` file). Some may have indirect coverage via route tests, but no dedicated unit tests.
- **Implementation approach**:
  1. Prioritize by risk: `rate-limit-service.ts`, `ai-safety-service.ts`, `admin-settings-service.ts`, `fts-language.ts` first (security/correctness critical).
  2. Then: `notification-service.ts`, `image-references.ts`, `ollama-provider.ts` (functional correctness).
  3. Low priority: `logger.ts`, `version.ts`, `mcp-docs-client.ts`, `version-snapshot.ts` (trivial or hard to test in isolation).
  4. Each test file should cover: happy path, error cases, edge cases, and mock boundaries.
  5. Estimate: ~1 day for high-priority tests, ~1 day for medium-priority.
- **Dependencies**: None

### Issue #106 -- Inline Zod Schemas Instead of Shared Contracts
- **Complexity**: M
- **Risk**: Low -- refactoring with no behavior change
- **Affected files**: Route files with inline `z.object()` that define API boundaries:
  - `routes/knowledge/content-analytics.ts` (6 schemas)
  - `routes/knowledge/comments.ts` (6 schemas)
  - `routes/knowledge/local-spaces.ts` (6 schemas)
  - `routes/knowledge/templates.ts` (5 schemas)
  - `routes/knowledge/knowledge-requests.ts` (5 schemas)
  - `routes/knowledge/verification.ts` (3 schemas)
  - `routes/knowledge/pages-tags.ts` (4 schemas)
  - `routes/knowledge/pages-versions.ts` (3 schemas)
  - `routes/foundation/rbac.ts` (14 schemas -- many are internal, not all API boundaries)
- **Investigation finding**: Many routes define their own request/response schemas inline. Some are purely internal (param parsing), which is fine. The ones that should be in contracts are request body schemas and response shapes used by the frontend.
- **Implementation approach**:
  1. Identify which inline schemas define API boundaries (request bodies, query params used by frontend).
  2. Move those to `packages/contracts/src/` with appropriate naming.
  3. Keep route-internal schemas (like internal ChildrenQuerySchema) in the route file.
  4. Priority: schemas that the frontend also validates or types against.
  5. Estimate: ~1 day for extraction, ~0.5 day for import updates and tests.
- **Dependencies**: None, but do before #112

### Issue #91 -- Graceful Shutdown Dynamic Import
- **Complexity**: S
- **Risk**: Low -- code works but pattern is suboptimal
- **Affected files**: `backend/src/index.ts` line 99
- **Investigation finding**: `closeBrowser()` is dynamically imported during shutdown: `const { closeBrowser } = await import('./core/services/pdf-service.js')`. This works but is fragile -- if the import fails, the browser process leaks. Fastify 5 recommends using `onClose` hooks for cleanup.
- **Implementation approach**:
  1. Register `closeBrowser` as a Fastify `onClose` hook in `app.ts` (where pdf-service is available).
  2. Remove the dynamic import from `index.ts` shutdown handler.
  3. Use Fastify's `preClose` hook for the workers (stopQualityWorker, etc.).
  4. Keep `closePool()` and `shutdownTelemetry()` in `onClose` hooks.
  5. This aligns with Fastify's shutdown lifecycle: preClose -> server.close -> onClose.
- **Dependencies**: None

### Issue #76 -- void ENTERPRISE_FEATURES Anti-Pattern
- **Complexity**: S
- **Risk**: None -- purely cosmetic
- **Affected files**: `backend/src/app.ts` line 205
- **Investigation finding**: `void ENTERPRISE_FEATURES` is used to suppress the "unused import" lint error. The import exists for the commented-out OIDC route registration.
- **Implementation approach**:
  1. Remove the import and the `void` statement.
  2. Add a comment explaining that the OIDC section is activated in EE.
  3. The OIDC route registration block is commented out -- when it's uncommented (in EE), the import will be needed.
  4. Alternative: use `// eslint-disable-next-line @typescript-eslint/no-unused-vars` on the import line with a comment explaining why it's kept.
- **Dependencies**: None

### Issue #72 -- innerHTML Usage in content-converter.ts
- **Complexity**: L
- **Risk**: Medium -- 17 innerHTML assignments, but context is server-side JSDOM (no real DOM, no XSS risk)
- **Affected files**: `backend/src/core/services/content-converter.ts` (17 occurrences)
- **Investigation finding**: All innerHTML usage is in a server-side JSDOM context. The content comes from Confluence storage format (XHTML), which is already trusted content from the user's own Confluence instance. The Semgrep finding is a false positive for this context -- JSDOM innerHTML has no script execution capability in the default configuration.
- **Implementation approach**:
  1. Add `// nosemgrep: javascript.browser.security.dom-based-xss.innerHTML` annotations on each line.
  2. Document in the file header that innerHTML is safe here because: (a) server-side JSDOM, (b) content is from user's own Confluence instance, (c) output is sanitized before being sent to the frontend.
  3. For the few cases where `textContent` would suffice (e.g., plain text extraction), use `textContent` instead.
  4. Do NOT refactor all innerHTML to DOM manipulation -- it would make the converter much harder to read for minimal benefit.
- **Dependencies**: None

### Execution order within Phase 4:
1. #76 (void anti-pattern -- 30 seconds)
2. #91 (graceful shutdown -- quick, improves reliability)
3. #111 (distributed locks -- important for multi-container)
4. #72 (innerHTML annotations -- reduces Semgrep noise)
5. #106 (shared contracts -- refactoring prerequisite)
6. #107 (test coverage -- ongoing, can be split across PRs)
7. #112 (noUncheckedIndexedAccess -- largest item, do last)

---

## Phase 5: Frontend Cleanup

**Goal**: Remove dead code, unused dependencies, and duplicate components.
**Duration**: 2-3 days
**Issues**: #94, #93, #92, #85, #81, #79

### Issue #94 -- Remove Unused autoprefixer and postcss
- **Complexity**: S
- **Risk**: None -- TailwindCSS 4 does not use PostCSS
- **Affected files**: `frontend/package.json`
- **Investigation finding**: Confirmed. No `postcss.config.*` file exists. No imports of autoprefixer or postcss in any source file. TailwindCSS 4 uses its own processing pipeline.
- **Implementation approach**: `npm uninstall autoprefixer postcss -w frontend`
- **Dependencies**: None

### Issue #93 -- Remove Unused Effect Components
- **Complexity**: S
- **Risk**: None -- only imported by their own test files
- **Affected files**:
  - `frontend/src/shared/components/effects/ActivityHeatmap.tsx` + test
  - `frontend/src/shared/components/effects/DirectionAwareHover.tsx` + test
  - `frontend/src/shared/components/effects/MagneticButton.tsx` + test
- **Investigation finding**: Confirmed. These 3 components are only imported by their own test files. No other file references them.
- **Implementation approach**: Delete the 6 files (3 components + 3 tests).
- **Dependencies**: None

### Issue #92 -- Remove Unused Radix UI and CVA Dependencies
- **Complexity**: S
- **Risk**: Low -- verify no transitive dependency
- **Affected files**: `frontend/package.json`
- **Investigation finding**: Confirmed unused:
  1. `@radix-ui/react-label` -- 0 imports
  2. `@radix-ui/react-scroll-area` -- 0 imports
  3. `@radix-ui/react-select` -- 0 imports
  4. `@radix-ui/react-separator` -- 0 imports
  5. `@radix-ui/react-tabs` -- 0 imports
  6. `@radix-ui/react-tooltip` -- 0 imports
  7. `class-variance-authority` -- 0 imports
- **Implementation approach**: `npm uninstall @radix-ui/react-label @radix-ui/react-scroll-area @radix-ui/react-select @radix-ui/react-separator @radix-ui/react-tabs @radix-ui/react-tooltip class-variance-authority -w frontend`
- **Dependencies**: None

### Issue #85 -- Frontend jose Duplication
- **Complexity**: S
- **Risk**: Low -- jose is lightweight (~45KB) but duplicated
- **Affected files**: `frontend/src/shared/hooks/useTokenRefreshTimer.ts` line 2
- **Investigation finding**: Frontend uses `jose` for a single function: `decodeJwt`. The backend also uses `jose` for full JWT operations. The frontend only needs to decode the JWT to read the `exp` claim for token refresh timing.
- **Implementation approach**:
  1. **Option A**: Replace `decodeJwt` with a simple base64 decode (JWT payload is just base64url JSON).
  ```typescript
  function decodeJwtPayload(token: string): { exp?: number } {
    const payload = token.split('.')[1];
    if (!payload) return {};
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  }
  ```
  2. **Option B**: Keep jose (it's tree-shakeable and the overhead is minimal with modern bundlers).
  3. Recommendation: Option A is simple and eliminates the dependency entirely.
- **Dependencies**: None

### Issue #81 -- Duplicate TagEditor Components
- **Complexity**: S
- **Risk**: Low
- **Affected files**:
  - `frontend/src/shared/components/TagEditor.tsx` -- used by `PageViewPage.tsx`
  - `frontend/src/features/pages/TagEditor.tsx` -- unused duplicate
  - `frontend/src/features/pages/TagEditor.test.tsx` -- tests for unused duplicate
- **Investigation finding**: Confirmed. `PageViewPage.tsx` imports from `../../shared/components/TagEditor`. The `features/pages/TagEditor.tsx` is not imported anywhere except its own test.
- **Implementation approach**:
  1. Delete `frontend/src/features/pages/TagEditor.tsx` and its test file.
  2. Verify no other imports reference it.
- **Dependencies**: None

### Issue #79 -- Orphaned DashboardPage and Analytics Components
- **Complexity**: S
- **Risk**: Low -- components exist but are not routed
- **Affected files**:
  - `frontend/src/features/dashboard/DashboardPage.tsx` + test
  - `frontend/src/features/analytics/AnalyticsDashboardPage.tsx` + test (check if routed)
- **Investigation finding**: `App.tsx` line 17 says `// DashboardPage removed -- merged into PagesPage (issue #109)`. The component files still exist. Need to check if AnalyticsDashboardPage is also orphaned.
- **Implementation approach**:
  1. Check if any route references DashboardPage or AnalyticsDashboardPage.
  2. If not routed, delete the component and test files.
  3. If analytics pages contain useful logic, consider migrating it to PagesPage or a dedicated analytics section.
- **Dependencies**: None

### Execution order within Phase 5:
1. #81 (duplicate TagEditor -- trivial delete)
2. #93 (unused effects -- trivial delete)
3. #79 (orphaned pages -- verify and delete)
4. #94 (unused postcss/autoprefixer -- one npm command)
5. #92 (unused Radix/CVA -- one npm command)
6. #85 (jose replacement -- small refactor)

---

## Phase 6: Documentation and Tooling Cleanup

**Goal**: Fix documentation drift, remove tracked artifacts, and add tooling.
**Duration**: 2-3 days
**Issues**: #108, #74, #90, #88, #86, #84, #83, #69, #68, #67

### Issue #108 -- CLAUDE.md Migration Count Drift
- **Complexity**: S
- **Risk**: None
- **Affected files**: `CLAUDE.md`
- **Investigation finding**: CLAUDE.md says "Sequential SQL files (001-045)". Actual count: 51 SQL files, numbered 001-049 with 017b and two 040 variants (040_rbac_aces_and_migration.sql and 040_rename_cached_spaces.sql).
- **Implementation approach**: Update CLAUDE.md to say "Sequential SQL files (001-049, 51 files)".
- **Dependencies**: None

### Issue #74 -- CLAUDE.md References 'openai' npm Package
- **Complexity**: S
- **Risk**: None
- **Affected files**: `CLAUDE.md`
- **Investigation finding**: Confirmed. CLAUDE.md tech stack section says `openai` npm package. The backend uses raw HTTP calls via `undici` to OpenAI-compatible APIs. There is no `openai` package in `backend/package.json`.
- **Implementation approach**: Change "`openai` npm package" to "raw HTTP via `undici`" in the tech stack section. Update the description to: "OpenAI-compatible APIs (raw HTTP via undici, no SDK dependency)".
- **Dependencies**: None

### Issue #90 -- CORS Single Domain Only
- **Complexity**: S
- **Risk**: Low
- **Affected files**: `backend/src/app.ts` line 77
- **Investigation finding**: Confirmed. `origin: process.env.FRONTEND_URL ?? 'http://localhost:5273'` accepts a single string.
- **Implementation approach**:
  1. Parse `FRONTEND_URL` as comma-separated list: `const origins = (process.env.FRONTEND_URL ?? 'http://localhost:5273').split(',').map(s => s.trim())`.
  2. If single origin, pass as string. If multiple, pass as array.
  3. Fastify CORS supports arrays natively.
  4. Update `.env.example` and CLAUDE.md with the new format.
- **Dependencies**: None

### Issue #88 -- Add knip to CI
- **Complexity**: M
- **Risk**: Low -- tooling addition, no code changes
- **Affected files**: `package.json` (root), CI configuration
- **Investigation finding**: knip is a TypeScript/JavaScript tool for finding unused exports, dependencies, and files.
- **Implementation approach**:
  1. `npm install -D knip` at root level.
  2. Create `knip.config.ts` with workspace configuration for backend, frontend, and packages/contracts.
  3. Run `npx knip` to see initial findings (many will overlap with issues in this plan).
  4. Add to CI as a non-blocking step initially, then make blocking once baseline is clean.
  5. Configure ignore patterns for enterprise stubs, test fixtures, and type declarations.
- **Dependencies**: Best done after Phase 5 cleanup (fewer false positives)

### Issue #86 -- Missing .claudeignore Entries
- **Complexity**: S
- **Risk**: None
- **Affected files**: `.claudeignore`
- **Investigation finding**: Current .claudeignore is missing:
  - `playwright-report/`
  - `test-results/`
  - `coverage/`
  - `backend/node_modules.old/` (tracked in git, see #67)
  - `mcp-docs/node_modules/`
  - `mcp-docs/dist/`
  - `e2e/` (optional, large test files)
- **Implementation approach**: Add missing entries to `.claudeignore`.
- **Dependencies**: None

### Issue #84 -- Screenshots in Repo Root
- **Complexity**: S
- **Risk**: None
- **Affected files**: Repo root
- **Investigation finding**: No screenshots currently exist at the repo root in the working directory or git tracking. The issue may have been resolved already or the screenshots were removed.
- **Implementation approach**: Verify resolved. If screenshots exist in git history, add `*.png` and `*.jpg` to `.gitignore` at root level to prevent recurrence.
- **Dependencies**: None

### Issue #83 -- Inconsistent Test File Naming
- **Complexity**: S
- **Risk**: None
- **Affected files**: `backend/src/core/db/migrations/__tests__/migrations.test.ts`
- **Investigation finding**: One `__tests__` directory exists in the backend (migrations). All other tests use co-located `.test.ts` files. E2E uses `.spec.ts` (standard Playwright convention).
- **Implementation approach**:
  1. Move `migrations/__tests__/migrations.test.ts` to `migrations/migrations.test.ts` (co-located).
  2. Remove the empty `__tests__` directory.
  3. Verify vitest config includes the new location.
- **Dependencies**: None

### Issue #69 -- Remove Unused uuid Dependency
- **Complexity**: S
- **Risk**: None
- **Affected files**: `backend/package.json`
- **Investigation finding**: Confirmed. No imports of `uuid` in any backend source file. PostgreSQL generates UUIDs natively via `gen_random_uuid()`.
- **Implementation approach**: `npm uninstall uuid @types/uuid -w backend`
- **Dependencies**: None

### Issue #68 -- Remove Unused @fastify/static
- **Complexity**: S
- **Risk**: None
- **Affected files**: `backend/package.json`
- **Investigation finding**: Confirmed. No imports of `@fastify/static` in any backend source file. Static files are served by nginx/Vite in the current architecture.
- **Implementation approach**: `npm uninstall @fastify/static -w backend`
- **Dependencies**: None

### Issue #67 -- Remove node_modules.old from Git
- **Complexity**: S
- **Risk**: Low -- will increase the size of the git commit that removes them
- **Affected files**: `backend/node_modules.old/` (284 tracked files)
- **Investigation finding**: Confirmed. 284 files from `backend/node_modules.old/eslint/` are tracked in git. This is likely from a botched `npm install` or eslint migration.
- **Implementation approach**:
  1. `git rm -r backend/node_modules.old/`
  2. Add `node_modules.old/` to `.gitignore`.
  3. Commit with clear message: "chore: remove accidentally committed node_modules.old (284 files)".
  4. Note: this doesn't rewrite history -- the files remain in git history. For a clean history, `git filter-branch` or `git-filter-repo` could be used, but that's disruptive for collaborators.
- **Dependencies**: None (do first in this phase -- reduces noise for all other tooling)

### Execution order within Phase 6:
1. #67 (node_modules.old -- biggest cleanup, do first)
2. #69 + #68 (unused backend deps -- quick wins)
3. #86 (claudeignore -- prevents future noise)
4. #108 + #74 (CLAUDE.md fixes -- documentation)
5. #84 (screenshots -- verify resolved)
6. #83 (test naming -- minor)
7. #90 (CORS array -- small feature)
8. #88 (knip CI -- last, benefits from all cleanups being done)

---

## Dependency Graph

```
Phase 1 (Security)         Phase 2 (Performance DB)     Phase 3 (Performance Infra)
  #71 ────────────────┐
  #70                 │
  #87                 │    #102 ──────────────────────── #96 (benefits from #102)
  #103 + #105         │    #97
  #82                 │    #95
  #75                 │    #110
  #104 ◄──────────────┘    #109
  (do after fixes)         #73 + #80                     #114
                                                         #113 (verify resolved)
                                                         #99
                                                         #98
                                                         #100
                                                         #101
                                                         #89
                                                         #78 ◄──── #114 (benefits)
                                                         #77 (verify resolved)

Phase 4 (Code Hygiene)     Phase 5 (Frontend)           Phase 6 (Docs/Tooling)
  #76                       #81                          #67 (do first)
  #91                       #93                          #69 + #68
  #111                      #79                          #86
  #72                       #94                          #108 + #74
  #106 ◄──────────────────  #92                          #84
  #107                      #85                          #83
  #112 ◄── #106                                          #90
  (do after contracts)                                   #88 ◄── all Phase 5+6
                                                         (do last)
```

**Cross-phase dependencies:**
- #104 (security audit) should be done after all Phase 1 security fixes
- #96 (search parallelization) benefits from #102 (COUNT removal)
- #78 (embedding batching) benefits from #114 (separate vector pool)
- #112 (noUncheckedIndexedAccess) should be done after #106 (shared contracts)
- #88 (knip) should be done after Phase 5 + Phase 6 cleanup

---

## Complexity Summary

| Size | Count | Issues |
|------|-------|--------|
| **S** (< 2h) | 30 | #87, #71, #70, #82, #75, #103, #105, #110, #109, #76, #91, #94, #93, #92, #85, #81, #79, #108, #74, #90, #86, #84, #83, #69, #68, #67, #99, #100, #89, #77 |
| **M** (2-6h) | 12 | #104, #102, #97, #96, #95, #114, #98, #111, #106, #88, #73+#80, #78 |
| **L** (1-2d) | 4 | #101, #107, #72, #112 (Phase A-B) |
| **XL** (3-5d) | 1 | #112 (full migration, 516 fixes) |

**Total estimated effort**: ~25-35 developer-days across 6 phases.

---

## Research Findings

### 1. GCM Auth Tag Length (DEP0182)
Node.js 23+ emits a runtime deprecation warning when `createDecipheriv` is called for GCM without an explicit `authTagLength`. Node.js 20.13+ had documentation-only deprecation. The fix is passing `{ authTagLength: 16 }` to `createDecipheriv()`. Source: Node.js API docs, DEP0182.

### 2. Fastify 5 Shutdown Lifecycle
Fastify 5 has a well-defined shutdown sequence: `preClose` hooks (in-flight requests still active) -> `server.close()` (waits for in-flight) -> `onClose` hooks (server stopped). Resource cleanup should use `onClose` hooks, not manual shutdown handlers. The current code in `index.ts` manually calls `app.close()` which triggers onClose hooks, but the PDF browser cleanup happens outside this lifecycle.

### 3. noUncheckedIndexedAccess Migration Scale
Running `tsc --noUncheckedIndexedAccess` on the backend produces **516 type errors**. The majority are from: (a) assuming `rows[0]` exists after a query, (b) string `.split()` results, (c) object property access by computed key. A phased migration by domain is recommended over a big-bang approach.

### 4. pgvector Pool Isolation
pgvector queries using `SET LOCAL hnsw.ef_search` require a dedicated connection for the duration of the query (wrapped in a transaction). Under load, these can monopolize the main pool. Best practice from `node-postgres` documentation: use a separate `pg.Pool` with lower `max` connections for long-running or specialized queries. The pool's `connectionTimeoutMillis` should be longer for vector queries (they inherently take more time).

### 5. innerHTML in JSDOM Context
Semgrep flags `innerHTML` as a DOM-based XSS risk. However, in a Node.js JSDOM context (server-side), there is no real browser DOM, no script execution, and no user-facing rendering. The content comes from the user's own Confluence instance. This is a false positive for this specific context. The recommended approach is `// nosemgrep` annotations with documentation.

### 6. Cache Stampede Prevention
The project already implements a lock-based stampede prevention pattern in `llm-cache.ts` (SET NX EX + poll). This pattern should be generalized into a `getOrCompute()` utility and applied to all Redis caches (page list, tree, graph, filters).

### 7. Data Retention for Append-Only Tables
The project has 5 append-only tables (`audit_log`, `search_analytics`, `error_log`, `page_versions`, `article_feedback`) with no cleanup mechanism. The `token-cleanup-service` handles only `refresh_tokens`. A generalized retention service with configurable per-table policies is needed.

### 8. Frontend Bundle Analysis
- `domMax` vs `domAnimation`: domMax adds ~20-30KB for layout projection and drag features that are not used.
- 7 unused Radix UI + CVA packages add unnecessary dependency resolution overhead.
- `react-force-graph-2d` is already code-split via React.lazy on the GraphPage route.
- `mermaid` is already dynamically imported.
- `autoprefixer` and `postcss` are dev dependencies that serve no purpose with TailwindCSS 4.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| #112 introduces regressions | Medium | Phased migration, run full test suite after each batch |
| #114 pool exhaustion during migration | High | Deploy with monitoring, start with conservative pool sizes |
| #101 data retention deletes needed data | High | Default to generous retention periods, add admin override |
| #67 large git commit bloats repo | Low | Single commit, clear message; don't rewrite history |
| #97 migration for body_text_hash column | Medium | Make column nullable, backfill incrementally |
| #95 recursive CTE performance | Low | Add LIMIT and depth guard in CTE, test with large page trees |

---

## Quick Wins (Can Be Done Immediately)

These issues require minimal code changes and have zero risk:

1. **#76** -- Remove `void ENTERPRISE_FEATURES` (1 line change)
2. **#108** -- Fix migration count in CLAUDE.md
3. **#74** -- Fix openai package reference in CLAUDE.md
4. **#94** -- `npm uninstall autoprefixer postcss -w frontend`
5. **#69** -- `npm uninstall uuid @types/uuid -w backend`
6. **#68** -- `npm uninstall @fastify/static -w backend`
7. **#100** -- Change `30_000` to `60_000` in NotificationBell.tsx
8. **#89** -- Parallelize or stagger worker triggers
9. **#81** -- Delete unused `features/pages/TagEditor.tsx`
10. **#93** -- Delete 3 unused effect components

These 10 issues could be done in a single "quick wins" PR in under an hour.
