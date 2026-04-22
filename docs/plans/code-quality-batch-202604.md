# Code Quality Findings Batch — April 2026 (Implementation Plan)

**Tracking epic:** [#225](https://github.com/Compendiq/compendiq-ce/issues/225)
**Child issues:** #226, #227, #228, #229, #230, #231, #232, #233, #234, #235
**Branch base:** `dev`
**PR target:** `dev` (NEVER `main` — see CLAUDE.md "Mandatory Rules")
**Author note:** Plan only — no source files were modified during plan generation. The reviews on each issue have already happened and verdicts are recorded in the issue comments; do not re-run `gh-issue-reviewer`.

---

## Recommended PR sequencing

Six PRs, ordered to minimise rebase pain and bundle changes that touch the same file:

| PR | Issues | Workspace(s) | Rationale |
|---|---|---|---|
| 1 | **#226** | repo root | Untracks 187 files / ~1.7 MB. Pure git surgery — ship alone so the merge is auditable. Eliminates the 3 false-positive CodeQL findings rooted in `frontend/node_modules.old/` on the next scan. |
| 2 | **#228 + #229** | `packages/contracts`, `backend` | Both edit `packages/contracts/src/schemas/admin.ts` (lines 78, 97, 99, 104). Bundling avoids two competing diffs to the same file. #228 also touches the backend handler in `backend/src/routes/foundation/admin.ts:369-376` and the frontend caller in `frontend/src/features/settings/panels/EmbeddingTab.tsx:60-62`; #229 is contracts-only with a doc-comment. Ship together as one focused "tri-state contract alignment" PR. |
| 3 | **#230** | `backend` | Single-line regex fix + targeted unit tests. Backend-only; isolated from PR 2's contract changes. |
| 4 | **#231** | `mcp-docs` | One-line dead import removal in a workspace nobody else is editing. |
| 5 | **#232 + #234** | `frontend` | Both are frontend-test-only changes with zero production impact. Bundling keeps reviewers in one mental context (test hygiene). They touch different files (`RateLimitsTab.test.tsx` vs `RbacPage.test.tsx`) so no merge conflicts internally. |
| 6 | **#227 + #233 + #235** | `frontend` | Three small frontend chores: dead-code removal in `LlmTab.tsx` (#227), small refactor of `settings-nav.ts` (#233), and a doc-comment fix in `ChartsBundle.tsx` (#235). Bundling minimises CI churn. None touch the same file. If any one is contentious, split it back out — but the default is one PR. |

**Total: 6 PRs across 10 issues.** Estimated cumulative production-code delta is ≤ 60 LOC (excluding the ~1.7 MB git index churn from PR 1).

**Sequencing constraint:** PRs 1, 3, 4 are independent. PR 2 should land before PR 6 if PR 6 grows to touch any contract field (it currently does not). PRs 5 and 6 are independent of each other.

---

## Risk register

Two PRs are genuinely riskier than the rest. Reviewers should pay extra attention here.

### High risk

1. **PR 1 (#226) — `git rm -r --cached frontend/node_modules.old`**
   - **Why risky:** Removes 187 files (~1.7 MB) from the git index in a single commit. Anyone with an open feature branch that re-adds `frontend/node_modules.old/` (e.g. during a `mv node_modules node_modules.old` for dependency surgery) will hit a phantom-file conflict on rebase. Also potentially affects local Docker layer caches that snapshotted those paths, and any custom CodeQL exclusion config that referenced them (none currently exists in `.github/workflows/`, verified).
   - **Mitigation:**
     - Land in isolation as PR 1. Announce in the PR description that contributors should `rm -rf frontend/node_modules.old` locally after pulling.
     - The directory is already in `.gitignore` (line 3: `node_modules.old/`), so re-adds are blocked.
     - Verify no `.github/workflows/*.yml` references the path (verified during plan generation — only `pr-check.yml`, `docker-build.yml`, `test-installer.yml` exist; none reference `node_modules.old`).
     - Watch the next CodeQL run on `dev` after merge — the 3 listed findings should disappear.
   - **Rollback:** `git revert <merge-sha>` restores the index entries. The on-disk files remain wherever they were (or weren't).

2. **PR 2 (#228) — `drawioEmbedUrl` contract change**
   - **Why risky:** Changes the wire contract for `PUT /api/admin/settings`. Today the backend already had unreachable code that handled `""` as "clear". Switching the clear-signal from `""` (currently rejected by Zod) to `null` is the right fix, but **any external caller that was sending `""` will start failing schema validation** — though, per the issue body, no such caller can exist today because Zod rejects `""` upstream of the handler. Still, frontend code in `frontend/src/features/settings/panels/EmbeddingTab.tsx:60-62` constructs the update payload with `drawioEmbedUrl || undefined`, which silently drops a cleared field; that needs to change to send `null`.
   - **Mitigation:**
     - Frontend, contract, and backend changes ship in the same PR — no half-deployed window.
     - Add the schema test (`UpdateAdminSettingsSchema.parse({ drawioEmbedUrl: null })` succeeds) and the route test (PUT with `null` deletes the row) called out in the issue.
     - Add a regression test that the existing happy-path PUT with a valid URL still upserts (covered by existing `admin.test.ts:469-478`).
     - Existing test at `backend/src/routes/foundation/admin.test.ts:491-501` ("rejects invalid URL for drawioEmbedUrl") should still pass — `null` is permitted, but `'not-a-valid-url'` still fails.
   - **Rollback:** `git revert <merge-sha>` on the dev branch. No DB migration involved.

### Medium risk

- **#227 (LlmTab dead-code removal)** — touches a user-visible admin settings panel. Verify in a real browser session via Playwright MCP after the fix that no broken text/missing tooltip remains. (Planned only; do not execute now.)
- **#233 (settings-nav refactor)** — pure refactor but the `legacyTabMap` generator is consumed by route resolution. There are no existing tests in `frontend/src/features/settings/settings-nav.test.ts` (verified — file does not exist), so add one as part of PR 6.

### Low risk

- **#229, #230, #231, #232, #234, #235** — all sub-10-line surgical fixes, well-bounded, mechanically straightforward.

---

## Out-of-scope notes

The epic [#225](https://github.com/Compendiq/compendiq-ce/issues/225) lists **11 confirmed false positives** that should be **dismissed in the GitHub UI** (Security → Code quality → each finding → "Dismiss → False positive / Used in tests"). Do **not** file these as issues, do **not** patch the underlying code:

| Rule | Count | Where | Why dismiss |
|---|---|---|---|
| `js/superfluous-trailing-arguments` | 9 | `frontend/src/stores/auth-store.test.ts` (StorageEvent constructor calls), `frontend/src/shared/components/article/{ArticleOutline,TableOfContents,ArticleRightPane}.tsx` (IntersectionObserver constructor calls), 1 in `frontend/node_modules.old/eslint/lib/rules/no-shadow.js` (covered by #226) | Both `new IntersectionObserver(cb, options)` and `new StorageEvent('storage', { ... })` accept 2 args per W3C specs and modern `lib.dom.d.ts`. Stale arity assumption in CodeQL's DOM type model. Dismiss as "False positive — incorrect rule assumption". |
| `js/trivial-conditional` | 2 | `backend/src/core/services/error-tracker.ts:90`, `frontend/src/features/pages/PageViewPage.test.tsx:187` | Both ternaries genuinely reach both branches across iterations / per-test mutations. Investigator-confirmed. Dismiss as "Used in tests" (frontend) / "False positive — flow analysis limitation" (backend). |

**Note for the executor:** the 1 `js/superfluous-trailing-arguments` finding inside `frontend/node_modules.old/` is collateral damage of the still-tracked-but-gitignored vendored eslint copy. PR 1 (#226) deletes that directory, so the finding will resolve itself on the next scan and does not need a separate dismissal.

**No `.github/workflows/codeql*.yml` config exists** in the repo (verified). GitHub default code-quality analysis is in effect. After PR 1 lands, no further config change is needed to prevent rescanning of `node_modules.old/` — it's gone.

---

## Per-issue plans

Each section below follows the same template:
1. Branch name
2. Files touched (path + line range)
3. Exact change
4. Test additions / updates
5. Verification commands
6. Rollback
7. PR target (always `dev`)

---

### Issue #226 — Untrack `frontend/node_modules.old/`

**Issue:** Remove tracked `frontend/node_modules.old/` from repo (eliminates 3 false-positive CodeQL findings). Priority: high.

**1. Branch name**
```
feature/226-untrack-node-modules-old
```

**2. Files touched**
- `frontend/node_modules.old/**` — 187 tracked files removed from index (verified: `git ls-files frontend/node_modules.old | wc -l` → 187)
- No `.gitignore` change needed (line 3 already lists `node_modules.old/`, verified)
- No CodeQL config change needed (no `.github/workflows/codeql*.yml` exists)

**3. Exact change**
```bash
git checkout dev
git pull origin dev
git checkout -b feature/226-untrack-node-modules-old
git rm -r --cached frontend/node_modules.old
rm -rf frontend/node_modules.old   # remove from working tree too
git add -A
git commit -m "chore: untrack frontend/node_modules.old (already gitignored)

The directory was a leftover from a manual mv during dependency surgery
and was tracked despite being in .gitignore. CodeQL scanning vendored
eslint sources here was the only reason 3 standard findings existed
(js/superfluous-trailing-arguments, js/trivial-conditional x2,
js/useless-assignment-to-property).

Verified: git ls-files frontend/node_modules.old | wc -l → 187 (now 0).
Repo size drops by ~1.7 MB. Already covered by .gitignore line 3.

Closes #226."
git push -u origin feature/226-untrack-node-modules-old
```

**4. Test additions / updates**
- None. This is a build/repo-hygiene change with no executable code path.

**5. Verification commands**
```bash
# Verify the directory is gone from the index
git ls-files frontend/node_modules.old | wc -l        # → 0
test ! -d frontend/node_modules.old && echo "OK"

# Confirm test suite still runs (sanity check; nothing should break)
npm install
npm run lint
npm run typecheck
npm test
```

**6. Rollback**
```bash
git revert <merge-sha>
```
On-disk files do not auto-restore; if needed re-create via `cd frontend && mv node_modules node_modules.old`. (Unlikely to be needed.)

**7. PR target:** `dev`

---

### Issue #227 — Remove dead `wired` branch in `LlmTab.tsx`

**Issue:** All four LLM use cases are wired via PRs #217 and #219. `WIRED_USECASES` always returns `true`, making the `disabled`, `title`, and helper-span fallbacks dead code. The tooltip text references issue #214 as a follow-up that is already closed.

**1. Branch name**
```
feature/227-llmtab-dead-wired-branch
```

**2. Files touched**
- `frontend/src/features/settings/panels/LlmTab.tsx` lines 360-457 (`WIRED_USECASES` constant, `wired` local, `disabled`, `title`, helper span)

**3. Exact change**
Apply option (a) from the issue body — pure deletion. Replace lines 360-457 (the `WIRED_USECASES` block + its consumers in `UsecaseAssignmentsSection`) with the equivalent always-rendered version:

- **Delete** the `WIRED_USECASES` declaration (lines 360-366) and its accompanying doc comment.
- **Delete** `const wired = WIRED_USECASES.has(usecase);` (line 396).
- On the provider `<select>` (lines 401-417): remove `disabled={!wired}` (line 411) and replace the `title={wired ? undefined : '...'}` (line 412) with no `title` attribute at all.
- On the model `<select>` (lines 427-443): remove `disabled={!wired}` (line 434) and the `title={wired ? undefined : '...'}` (line 435).
- Replace the helper `<span>` (lines 445-451) with the always-rendered "resolved" form:
  ```tsx
  <span className="text-xs text-muted-foreground">
    {row.resolved
      ? `→ ${row.resolved.provider} / ${row.resolved.model || '(none)'}`
      : ''}
  </span>
  ```

Net: -7 lines (the constant + its doc-comment + the `wired` local + 2 `disabled` props + 2 `title` props + the helper-span ternary collapse).

**4. Test additions / updates**
- No existing test file at `frontend/src/features/settings/panels/LlmTab.test.tsx` (verified — file does not exist). Add one in this PR with two cases:
  - **Test 1:** for each of the four use cases (`chat`, `summary`, `quality`, `auto_tag`), the provider `<select>` is enabled (no `disabled` attribute).
  - **Test 2:** the helper span renders the resolved provider/model when `row.resolved` is set, and renders empty when `row.resolved` is undefined.
- New file: `frontend/src/features/settings/panels/LlmTab.test.tsx` (~80 lines including imports + render wrapper).

**5. Verification commands**
```bash
# Lint + types first (catch the easy stuff before running tests)
npm run lint -w frontend
npm run typecheck -w frontend

# Targeted unit tests
cd frontend && npx vitest run src/features/settings/panels/LlmTab.test.tsx
# Then full frontend suite
npm run test -w frontend
```

**Optional (planned, not executed in this run):** verify in a live browser via Playwright MCP that the LlmTab admin panel renders without the dead text. Steps:
- `docker compose -f docker/docker-compose.yml up -d` (only if no local dev server is already running)
- `npm run dev`
- Playwright MCP: navigate to `/settings/ai/llm`, snapshot the use-case-assignments section, assert no element contains the substring "Not yet wired" or "follow-up to #214".

**6. Rollback**
```bash
git revert <merge-sha>
```

**7. PR target:** `dev`

---

### Issue #228 — `drawioEmbedUrl` tri-state alignment

**Issue:** `UpdateAdminSettingsSchema.drawioEmbedUrl` is `z.string().url().optional()`, which rejects `""`. Backend handler treats `""` as "clear / delete row" — that branch is unreachable. Switch the contract to `.nullish()`, treat `null` as "clear", and update the frontend caller.

**1. Branch name**
```
feature/228-229-admin-settings-tristate
```
(Shared branch with #229 — see PR sequencing.)

**2. Files touched**
- `packages/contracts/src/schemas/admin.ts` line 104 (`UpdateAdminSettingsSchema.drawioEmbedUrl`).
- `packages/contracts/src/schemas/admin.ts` line 78 (`AdminSettingsSchema.drawioEmbedUrl`) — **also fixed in this PR**. Backend at `admin.ts:264` returns `drawioEmbedUrl: map['drawio_embed_url'] ?? null`, so the current read schema `z.string().url().optional()` would reject the explicit `null` the backend actually sends. This is a current bug, not a future enhancement; relaxing to `.url().nullable()` aligns the schema with the backend response.
- `backend/src/routes/foundation/admin.ts` lines 369-376 (the handler block that handles `body.drawioEmbedUrl`).
- `frontend/src/features/settings/panels/EmbeddingTab.tsx` lines 60-62 (the update-payload builder that currently does `updates.drawioEmbedUrl = drawioEmbedUrl || undefined`).
- `backend/src/routes/foundation/admin.test.ts` (add new tests; existing tests at lines 469-501 cover happy-path + invalid-URL).

**3. Exact change**

`packages/contracts/src/schemas/admin.ts:78` (read schema — bug fix, backend already returns `null`):
```diff
-  drawioEmbedUrl: z.string().url().optional(),
+  drawioEmbedUrl: z.string().url().nullable(),
```

`packages/contracts/src/schemas/admin.ts:104` (update schema — tri-state contract):
```diff
-  drawioEmbedUrl: z.string().url().optional(),
+  /**
+   * Update semantics:
+   *  - field omitted → leave existing value unchanged
+   *  - null          → clear stored value (backend deletes the row, falls back to default)
+   *  - URL string    → set / replace value
+   */
+  drawioEmbedUrl: z.string().url().nullish(),
```

`backend/src/routes/foundation/admin.ts:369-376`:
```diff
     if (body.drawioEmbedUrl !== undefined) {
-      if (body.drawioEmbedUrl) {
-        updates.push({ key: 'drawio_embed_url', value: body.drawioEmbedUrl });
-      } else {
-        // Empty string clears the setting (falls back to default)
+      if (body.drawioEmbedUrl === null) {
+        // Explicit null clears the setting (falls back to default)
         await query(`DELETE FROM admin_settings WHERE setting_key = 'drawio_embed_url'`);
+      } else {
+        updates.push({ key: 'drawio_embed_url', value: body.drawioEmbedUrl });
       }
     }
```

`frontend/src/features/settings/panels/EmbeddingTab.tsx:60-62`:
```diff
     if (drawioEmbedUrl !== undefined) {
-      updates.drawioEmbedUrl = drawioEmbedUrl || undefined;
+      // Send null to clear the stored value (falls back to default).
+      updates.drawioEmbedUrl = drawioEmbedUrl === '' ? null : drawioEmbedUrl;
     }
```
(Verify the surrounding `updates` object's TypeScript type accepts `null` for `drawioEmbedUrl` — it should once the contract regenerates. If not, widen the local type.)

**4. Test additions / updates**

Add to `backend/src/routes/foundation/admin.test.ts` inside the existing `describe('PUT /api/admin/settings - drawioEmbedUrl only ...')` block:
- **Test:** PUT with `{ drawioEmbedUrl: null }` returns 200 and the underlying `DELETE FROM admin_settings WHERE setting_key = 'drawio_embed_url'` was issued. Use the existing test scaffolding pattern.
- **Test:** PUT with `{ drawioEmbedUrl: '' }` now returns 400 (Zod rejects — empty string is not a URL and the schema now produces an explicit "expected URL" error rather than silently doing nothing). This is a behavioural change that protects accidental empty submissions.
- **Test:** schema-level — `UpdateAdminSettingsSchema.parse({ drawioEmbedUrl: null }).drawioEmbedUrl === null`. Add to a new `packages/contracts/src/schemas/admin.test.ts` if one does not exist, or to wherever schema parse tests live in `packages/contracts`.

**5. Verification commands**
```bash
# Build contracts first so the type changes propagate
npm run build -w @compendiq/contracts

# Backend route + schema tests (uses real Postgres on port 5433)
cd backend && npx vitest run src/routes/foundation/admin.test.ts

# Contracts tests (if a schemas test file exists / was added)
npm run test -w @compendiq/contracts

# Frontend type check (catches the EmbeddingTab payload-type widening)
npm run typecheck -w frontend
npm run test -w frontend -- panels/EmbeddingTab

# Top-level
npm run lint
npm run typecheck
npm test
```

**6. Rollback**
```bash
git revert <merge-sha>
```
No DB migration involved. Backend still writes/deletes the same `admin_settings` row.

**7. PR target:** `dev`

---

### Issue #229 — `openaiBaseUrl` / `openaiModel` tri-state alignment

**Issue:** `UpdateAdminSettingsSchema.openaiBaseUrl` is `z.string().url().nullable().optional()` and `openaiModel` is `z.string().nullable().optional()`. Same semantics as `.nullish()` but more verbose; add a doc comment and unify.

**1. Branch name**
```
feature/228-229-admin-settings-tristate
```
(Shared branch with #228 — both edit `packages/contracts/src/schemas/admin.ts` so they MUST land together.)

**2. Files touched**
- `packages/contracts/src/schemas/admin.ts` lines 97 and 99 (`openaiBaseUrl`, `openaiModel` in `UpdateAdminSettingsSchema`).
- No backend change needed — `backend/src/routes/foundation/admin.ts` already conditions on `body.openaiBaseUrl !== undefined` (line 294) and writes `body.openaiBaseUrl` directly (line 336); both `null` and a URL string are already accepted by the existing logic.
- No frontend caller change needed (verified: no frontend code currently sends `openaiBaseUrl: ''`; if anyone does, the existing schema would reject it the same way `.nullish()` does).

**3. Exact change**

`packages/contracts/src/schemas/admin.ts:97-99`:
```diff
-  openaiBaseUrl: z.string().url().nullable().optional(),
+  /**
+   * Update semantics:
+   *  - field omitted → leave existing value unchanged
+   *  - null          → clear stored value (backend deletes the row, falls back to default)
+   *  - URL string    → set / replace value
+   */
+  openaiBaseUrl: z.string().url().nullish(),
   openaiApiKey: z.string().min(1).optional(),
-  openaiModel: z.string().nullable().optional(),
+  /**
+   * Update semantics: same omit/null/value tri-state as openaiBaseUrl above.
+   */
+  openaiModel: z.string().nullish(),
```
(Each field carries its own doc comment — matches the existing convention in this file, e.g. `UpdateUsecaseAssignmentsSchema` at lines 44-49 and `AdminSettingsSchema.drawioEmbedUrl` at lines 73-77. No cross-file references.)

**4. Test additions / updates**
Add to wherever schema parse tests live in `packages/contracts`:
- `UpdateAdminSettingsSchema.parse({ openaiBaseUrl: null }).openaiBaseUrl === null`
- `UpdateAdminSettingsSchema.parse({}).openaiBaseUrl === undefined`
- `expect(() => UpdateAdminSettingsSchema.parse({ openaiBaseUrl: '' })).toThrow()` (Zod still rejects empty string)
- Same three for `openaiModel` (omitting the URL check).

**5. Verification commands**
```bash
npm run build -w @compendiq/contracts
npm run test -w @compendiq/contracts
npm run typecheck   # confirm no caller breaks
```

**6. Rollback**
```bash
git revert <merge-sha>
```

**7. PR target:** `dev`

---

### Issue #230 — Duplicate dot in attachment-handler regex

**Issue:** `pageId.replace(/[/\\..]+/g, '_')` has a duplicate `.` inside the character class. CodeQL flags as `js/regex/duplicate-in-character-class`. Functionally a no-op but reads as buggy.

**1. Branch name**
```
feature/230-attachment-handler-regex
```

**2. Files touched**
- `backend/src/domains/confluence/services/attachment-handler.ts` line 43.
- `backend/src/domains/confluence/services/attachment-handler.test.ts` — extend the existing `path traversal prevention` describe block (lines 1181+) with the cases listed below.

**3. Exact change**

`attachment-handler.ts:43`:
```diff
-  const safeId = pageId.replace(/[/\\..]+/g, '_').replace(/^_+|_+$/g, '');
+  const safeId = pageId.replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '');
```
(Original intent: strip slashes, backslashes, and dots. The duplicate `.` was a typo — no other character was missing per the issue body.)

**4. Test additions / updates**

Existing tests (lines 1182-1232) already cover the happy path and `..\\..\\etc` and `..%2F..%2Fetc`. Add explicit assertions per the issue body so the regex semantics are pinned:
- **Test:** `attachmentDir('user', '...')` produces `'_'` after edge-trim — assert via `cacheAttachment` that the resulting `mkdir` path ends with `/_` or simply does not contain `'.'`.
- **Test:** `attachmentDir('user', 'page-123')` preserves `page-123` unchanged — assert via `cacheAttachment` that the `mkdir` path contains `page-123`.
- The empty-pageId-rejection test already exists at line 1216 (`rejects empty pageId`) — no change needed.

Note: `attachmentDir` is not exported from `attachment-handler.ts` (verified — it's a private helper). The existing tests exercise it via `cacheAttachment(client, userId, pageId, ...)` and assert on the recorded `fs.mkdir` mock call. Follow that pattern.

**5. Verification commands**
```bash
cd backend && npx vitest run src/domains/confluence/services/attachment-handler.test.ts
npm run lint -w backend
npm run typecheck -w backend
```

**6. Rollback**
```bash
git revert <merge-sha>
```

**7. PR target:** `dev`

---

### Issue #231 — Remove unused `logger` import in `mcp-docs/fetch-url.ts`

**Issue:** `import { logger } from '../logger.js';` at line 13 is never used in the 158-line file. CodeQL `js/unused-local-variable`.

**1. Branch name**
```
feature/231-mcp-docs-unused-logger
```

**2. Files touched**
- `mcp-docs/src/tools/fetch-url.ts` line 13.

**3. Exact change**
```diff
 import { DocsCache, type CachedDoc } from '../cache/redis-cache.js';
-import { logger } from '../logger.js';

 const DEFAULT_MAX_LENGTH = 10_000;
```
Pure deletion. Do not bundle the "wire `logger.warn(...)` into the catch paths" enhancement called out in the issue body — that's a separate scope.

**4. Test additions / updates**
- None. `logger` was unreferenced; deleting an unused import has no observable effect. Test runner is wired (`mcp-docs/package.json` script `"test": "vitest run"`, vitest ^4.0.18 in devDependencies); existing tests should keep passing.

**5. Verification commands**
```bash
# Lint catches unused-import re-introductions
cd mcp-docs && npm run lint
cd mcp-docs && npm run typecheck
cd mcp-docs && npm test    # vitest run — confirmed wired in package.json
```

**6. Rollback**
```bash
git revert <merge-sha>
```

**7. PR target:** `dev`

---

### Issue #232 — Drop dead `... && false` short-circuit in `RateLimitsTab.test.tsx`

**Issue:** Mock-fetch shim has `if ((input as Request)?.method === 'PUT' || (typeof input === 'string' && false))` — the right operand is always `false`. CodeQL `js/trivial-conditional`.

**1. Branch name**
```
feature/232-234-frontend-test-hygiene
```
(Shared branch with #234 — both are frontend-test-only.)

**2. Files touched**
- `frontend/src/features/settings/RateLimitsTab.test.tsx` line 37.

**3. Exact change**
```diff
-      if ((input as Request)?.method === 'PUT' || (typeof input === 'string' && false)) {
+      if ((input as Request)?.method === 'PUT') {
```
Per the issue body: there is no test in this file that exercises the string-input PUT path; the dead operand was a placeholder. Just delete it.

**4. Test additions / updates**
- No new tests. Existing tests in `RateLimitsTab.test.tsx` should pass unchanged — the mock still returns the same responses for the only `method === 'PUT'` callers.

**5. Verification commands**
```bash
cd frontend && npx vitest run src/features/settings/RateLimitsTab.test.tsx
npm run lint -w frontend
```

**6. Rollback**
```bash
git revert <merge-sha>
```

**7. PR target:** `dev`

---

### Issue #233 — `settings-nav.ts` refactor: helper, `Object.fromEntries`, ordering doc

**Issue:** Three AI findings: (1) `legacyTabId` duplicates `id` in most rows; extract `navItem(id, label, options?)` helper. (2) `legacyTabMap` uses `flatMap → reduce`; switch to `Object.fromEntries`. (3) `canSeeItem` short-circuit ordering deserves a doc comment.

**1. Branch name**
```
feature/227-233-235-frontend-chores
```
(Shared branch with #227 and #235 — see PR sequencing.)

**2. Files touched**
- `frontend/src/features/settings/settings-nav.ts` (whole file — it's only 189 lines; the refactor touches lines 46-141 for the `navItem` adoption, lines 147-156 for `legacyTabMap`, and lines 165-173 for the `canSeeItem` doc-comment).
- Add new test file `frontend/src/features/settings/settings-nav.test.ts` (does not currently exist — verified). Cover the `legacyTabMap` shape and `canSeeItem` ordering.

**3. Exact change**

**Add helper near the top of the file (after the type definitions, before `SETTINGS_NAV`):**
```ts
function navItem(
  id: string,
  label: string,
  options: Omit<SettingsNavItem, 'id' | 'label' | 'legacyTabId'> & { legacyTabId?: string | null } = {},
): SettingsNavItem {
  const { legacyTabId = id, ...rest } = options;
  return { id, label, legacyTabId, ...rest };
}
```

**Rewrite `SETTINGS_NAV` (lines 46-141)** so each item uses `navItem()`. Examples:
- `{ id: 'confluence', label: 'Confluence', legacyTabId: 'confluence' }` → `navItem('confluence', 'Confluence')`
- `{ id: 'labels', label: 'Labels', legacyTabId: 'labels', adminOnly: true }` → `navItem('labels', 'Labels', { adminOnly: true })`
- `{ id: 'llm', label: 'LLM', legacyTabId: 'ollama', adminOnly: true }` → `navItem('llm', 'LLM', { legacyTabId: 'ollama', adminOnly: true })`
- The two enterprise items in the AI group keep all their flags: `navItem('llm-policy', 'LLM Policy', { adminOnly: true, enterpriseOnly: true, requiresFeature: 'org_llm_policy' })`.

The only rows that need an explicit `legacyTabId` after the refactor are the LLM panel (`legacyTabId: 'ollama'`); every other row drops the explicit duplicate.

**Replace `legacyTabMap` (lines 147-156):**
```diff
 export const legacyTabMap: Readonly<Record<string, string>> = Object.freeze(
-  SETTINGS_NAV.flatMap((group) =>
-    group.items
-      .filter((item) => item.legacyTabId !== null)
-      .map((item) => [item.legacyTabId!, `/settings/${group.id}/${item.id}`] as const),
-  ).reduce<Record<string, string>>((acc, [legacyId, path]) => {
-    acc[legacyId] = path;
-    return acc;
-  }, {}),
+  Object.fromEntries(
+    SETTINGS_NAV.flatMap((group) =>
+      group.items
+        .filter((item) => item.legacyTabId !== null)
+        .map((item) => [item.legacyTabId!, `/settings/${group.id}/${item.id}`] as const),
+    ),
+  ),
 );
```

**Add the doc-comment to `canSeeItem` (line 165):**
```diff
-/**
- * Shared visibility predicate — same rules used today in SettingsPage, centralised
- * so the layout and any future consumer (e.g. a search / command palette) agree.
- */
+/**
+ * Shared visibility predicate — same rules used today in SettingsPage, centralised
+ * so the layout and any future consumer (e.g. a search / command palette) agree.
+ *
+ * Checks are ordered for short-circuiting from cheapest/synchronous to potentially
+ * more expensive lookups: admin flag (sync auth-store read), enterprise flag
+ * (cached license context), then feature-flag resolution (may be a remote/cached
+ * lookup). Reorder only with measurement.
+ */
 export function canSeeItem(item: SettingsNavItem, ctx: AccessContext): boolean {
```

**4. Test additions / updates**

Add `frontend/src/features/settings/settings-nav.test.ts` (~40 lines) covering:
- **Test 1:** `legacyTabMap` includes every group/item with a non-null `legacyTabId`. Spot-check that `legacyTabMap['confluence'] === '/settings/personal/confluence'` and `legacyTabMap['ollama'] === '/settings/ai/llm'` (the only divergent legacy id).
- **Test 2:** `canSeeItem` returns `true` for a vanilla user-visible item (`{ id: 'confluence', label: 'Confluence', legacyTabId: 'confluence' }`) when `ctx = { isAdmin: false, isEnterprise: false, hasFeature: () => false }`.
- **Test 3:** `canSeeItem` returns `false` for an `adminOnly: true` item when `isAdmin: false`, and `true` when `isAdmin: true`.
- **Test 4:** `canSeeItem` returns `false` for an `enterpriseOnly: true, requiresFeature: 'foo'` item when `isAdmin: true, isEnterprise: false, hasFeature: () => true` (enterprise check fires first).
- **Test 5:** `firstVisiblePath` returns `/settings/personal/confluence` for a vanilla user.

**5. Verification commands**
```bash
cd frontend && npx vitest run src/features/settings/settings-nav.test.ts
# Make sure SettingsLayout / route config still typechecks after the helper-output type changes
npm run typecheck -w frontend
npm run lint -w frontend
npm run test -w frontend
```

**6. Rollback**
```bash
git revert <merge-sha>
```

**7. PR target:** `dev`

---

### Issue #234 — `RbacPage.test.tsx` exact-count assertions and parameter naming

**Issue:** Four AI findings: (1) `_f` → `_feature`. (2) Add explicit type so reassignments preserve the parameter signature. (3) `expect(...).length).toBeGreaterThanOrEqual(2)` → `toHaveLength(2)`. (4) `... toBeGreaterThanOrEqual(1)` → `toHaveLength(2)` for the System badge count.

**Reviewer correction (per task brief):** the issue body misnames the second System-badged role as `system_user`. Verified by reading `RbacPage.test.tsx:39-56`: the two `isSystem: true` roles in `mockRoles` are `system_admin` and `editor`. The expected count of 2 is correct; only the rationale (which role is the second System role) needs adjusting in the new comment / commit message.

**1. Branch name**
```
feature/232-234-frontend-test-hygiene
```
(Shared branch with #232 — see PR sequencing.)

**2. Files touched**
- `frontend/src/features/admin/RbacPage.test.tsx` lines 10, 162, 208, 221.

**3. Exact change**

```diff
-let mockHasFeature = (_f: string) => false;
+let mockHasFeature: (feature: string) => boolean = (_feature) => false;
```
(Combines findings 1 + 2 into a single line: explicit type + renamed parameter.)

```diff
-    expect(screen.getAllByText('read').length).toBeGreaterThanOrEqual(2);
+    expect(screen.getAllByText('read')).toHaveLength(2);
```

```diff
-    expect(screen.getAllByText('System').length).toBeGreaterThanOrEqual(1);
+    // Both `system_admin` and `editor` carry isSystem: true (see mockRoles above),
+    // so exactly two "System" badges should render.
+    expect(screen.getAllByText('System')).toHaveLength(2);
```
(Comment corrects the issue-body misnaming.)

The reassignments at lines 162, 279, 290, 301, 312, 325 (`mockHasFeature = () => true` / `() => false`) all silently drop the parameter today. With the explicit type, TypeScript will continue to accept the parameterless arrow. Optionally tighten one or two to assert on the feature name (e.g. line 279: `mockHasFeature = (feature) => feature === 'advanced_rbac';`) — nice-to-have noted in the issue but not required.

**4. Test additions / updates**
- None new. The four edits above modify existing tests in place.

**5. Verification commands**
```bash
cd frontend && npx vitest run src/features/admin/RbacPage.test.tsx
npm run lint -w frontend
npm run typecheck -w frontend
```

**6. Rollback**
```bash
git revert <merge-sha>
```

**7. PR target:** `dev`

---

### Issue #235 — Fix circular self-import in `ChartsBundle.tsx` doc comment

**Issue:** The doc-comment example shows `lazy(() => import('../../shared/components/charts/ChartsBundle'))` from inside `ChartsBundle.tsx` itself — a copy-paste of the example would create a circular self-import. The `@/` alias is configured in `vite.config.ts:37` and `tsconfig.json:17`.

**1. Branch name**
```
feature/227-233-235-frontend-chores
```
(Shared branch with #227 and #233 — see PR sequencing.)

**2. Files touched**
- `frontend/src/shared/components/charts/ChartsBundle.tsx` lines 4-8 (doc-comment block only — no executable code change).

**3. Exact change**
```diff
 /**
  * ChartsBundle — re-exports recharts primitives as a single lazy-loadable module.
  *
  * Consumers lazy-load this entire module so recharts stays in its own chunk
  * and never bloats the main bundle:
  *
- *   const ChartsBundle = lazy(() => import('../../shared/components/charts/ChartsBundle'));
+ *   // In a consuming component (uses the `@/` Vite alias configured in
+ *   // frontend/vite.config.ts and frontend/tsconfig.json):
+ *   const ChartsBundle = lazy(() => import('@/shared/components/charts/ChartsBundle'));
  *   <Suspense fallback={<Spinner />}><ChartsBundle … /></Suspense>
  */
```

**4. Test additions / updates**
- None. Doc-comment-only change — no observable behaviour.

**5. Verification commands**
```bash
# Just confirm the file still parses and lints
npm run lint -w frontend
npm run typecheck -w frontend
```

**6. Rollback**
```bash
git revert <merge-sha>
```

**7. PR target:** `dev`

---

## Cross-cutting verification (after all PRs land)

After all six PRs are merged into `dev`:

```bash
git checkout dev
git pull origin dev
npm install
npm run lint
npm run typecheck
npm test
```

Then watch the next CodeQL scan on `dev`:
- The 3 findings rooted in `frontend/node_modules.old/` should be gone (PR 1).
- `js/regex/duplicate-in-character-class` on `attachment-handler.ts:43` should be gone (PR 3).
- `js/unused-local-variable` on `mcp-docs/src/tools/fetch-url.ts:13` should be gone (PR 4).
- `js/trivial-conditional` on `RateLimitsTab.test.tsx:37` should be gone (PR 5).
- The 9 `js/superfluous-trailing-arguments` findings and the 2 remaining `js/trivial-conditional` findings (`error-tracker.ts:90`, `PageViewPage.test.tsx:187`) should be **dismissed in the GitHub UI** per the out-of-scope notes above.

---

## Out of scope (future work, not part of this batch)

- **Wire `logger.warn(...)` into `fetch-url.ts` catch paths** (timeout, blocked redirect, non-OK status). Called out as a follow-up in #231; deliberately not bundled.
- **Tighten `RbacPage.test.tsx` mock-feature assertions** (e.g. `mockHasFeature = (feature) => feature === 'advanced_rbac';`). Optional improvement noted in #234; not required to satisfy the four findings.
- **Permanently exclude `node_modules.old/` from CodeQL via `.github/codeql/codeql-config.yml`** — unnecessary because PR 1 deletes the directory. If the team ever creates a similar `node_modules.old/` again, they'd need to remember to delete it; if that becomes a recurring problem, add a paths-ignore config then.
