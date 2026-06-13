# UX Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all findings from the 2026-06-10 usability review of Compendiq EE 0.5.2 (license-expiry invisibility, silent AI failures, broken trash UI, system-account exposure, degraded-state messaging, terminology/locale inconsistencies, console noise) and stand up the Confluence integration test container.

**Architecture:** All code changes are CE-side (`compendiq-ce`, branch `feature/ux-review-fixes` off `dev`). Backend fixes align four inconsistently-scoped knowledge routes to one visibility predicate and shield the `__system__` account; frontend fixes surface degraded states (LLM down, expired license, 403s) that today fail silently. The EE repo needs no code change — final verification rebuilds the EE image with the `ce` submodule pointed at this branch.

**Tech Stack:** Fastify 5 + Postgres (vitest + real DB on :5433), React 19 + TanStack Query (vitest + jsdom + testing-library), sonner toasts, nm-* design utilities, Playwright for live verification.

**Conventions for every task:** Read each target file region before editing (line numbers may have drifted). Frontend tests are colocated `Foo.test.tsx`; backend route tests are `backend/src/routes/**/*.test.ts` using `setupTestDb/truncateAllTables/teardownTestDb` from `test-db-helper.ts` (skipIf no DB). Run a task's tests with `cd backend && npx vitest run <file>` or `cd frontend && npx vitest run <file>`. Commit after each task with the message given in the task.

---

### Task 0: Branch setup

- [ ] **Step 0.1:** In `/home/simon/Documents/Compendiq/compendiq-ce`: `git checkout dev && git checkout -b feature/ux-review-fixes`. Run `npm install` if node_modules is stale. Start the test DB if not running (`docker ps | grep compendiq-test-postgres` — it runs on :5433).
- [ ] **Step 0.2:** Commit the plan file itself: `git add docs/superpowers/plans/2026-06-10-ux-review-fixes.md && git commit -m "docs: UX review fixes implementation plan"`.

---

### Task 1: Backend — pages tree route applies the visibility predicate

The tree route (`GET /api/pages/tree`) lists pages the detail/list/search routes refuse: it filters only by space + `deleted_at`, while the list route (pages-crud.ts ~line 318) also enforces `(confluence AND space ∈ RBAC) OR (standalone shared) OR (standalone private AND owner)`. Result: sidebar shows "Test Dokumentation." → click → "Article not found".

**Files:**
- Modify: `backend/src/routes/knowledge/pages-crud.ts` (~line 590, the `treeWhereClause`)
- Test: `backend/src/routes/knowledge/pages-tree-visibility.test.ts` (new)

- [ ] **Step 1.1: Write the failing DB test** — create `pages-tree-visibility.test.ts` following the `analytics.test.ts` pattern (build app via the same helper used there; check how existing pages-crud tests construct the Fastify instance and auth—mimic exactly). Seed: user A and user B; one standalone page `visibility='private', created_by_user_id=A`; one standalone `visibility='shared'` by A; assert `GET /api/pages/tree` as B returns only the shared page, as A returns both.
- [ ] **Step 1.2:** Run it: `cd backend && npx vitest run src/routes/knowledge/pages-tree-visibility.test.ts` — expect FAIL (B sees the private page).
- [ ] **Step 1.3: Implement** — in the tree route, change the where clause construction to:

```ts
const values: unknown[] = [treeSpaces, userId];
let treeWhereClause = `WHERE cp.deleted_at IS NULL AND (
  (cp.source = 'confluence' AND cp.space_key = ANY($1::text[]))
  OR (cp.source = 'standalone' AND cp.visibility = 'shared')
  OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $2)
)`;
if (params.spaceKey) {
  treeWhereClause += ' AND cp.space_key = $3';
  values.push(params.spaceKey);
}
```

Keep the cache key user-scoped (it already is: `cache.get(userId, …)`).
- [ ] **Step 1.4:** Re-run the test — expect PASS. Also run the existing pages-crud suite: `npx vitest run src/routes/knowledge/pages-crud.test.ts` (adjust any tree assertions that relied on the old behavior).
- [ ] **Step 1.5:** Commit: `git commit -m "fix(pages): apply visibility predicate to pages tree route"`.

---

### Task 2: Backend — embedding-status stats use the same visibility scope

`GET /api/llm/embedding-status` (`backend/src/routes/knowledge/knowledge-admin.ts:119`) feeds the dashboard KPI cards. A fresh regular user saw "Total Articles 0" while the tree showed 1 page. Scope `getEmbeddingStatus` to the same predicate as Task 1.

**Files:**
- Modify: `backend/src/domains/llm/services/embedding-service.ts` (`getEmbeddingStatus`), `backend/src/routes/knowledge/knowledge-admin.ts:119-123`
- Test: extend `backend/src/routes/knowledge/pages-tree-visibility.test.ts`

- [ ] **Step 2.1:** Read `getEmbeddingStatus` in `embedding-service.ts`. Add an optional scoping parameter `{ userId, accessibleSpaces }`; when provided, add the Task-1 predicate to its COUNT queries (same SQL fragment, parameterized).
- [ ] **Step 2.2: Failing test** — as user B from Task 1's seed, `GET /api/llm/embedding-status` should report `totalPages` equal to what B's tree shows (1, the shared page), not the global count (2).
- [ ] **Step 2.3:** Implement: in `knowledge-admin.ts` pass `{ userId: request.userId, accessibleSpaces: await getUserAccessibleSpaces(request.userId) }`. Run test → PASS. Run the embedding-service suite.
- [ ] **Step 2.4:** Commit: `git commit -m "fix(stats): scope embedding-status counts to caller-visible pages"`.

---

### Task 3: Backend — trash contract repair + standalone auto-purge

Frontend calls `GET /api/trash` and `POST /api/trash/:id/restore`; backend registers `GET /api/pages/trash` and `POST /api/pages/:id/restore` → the trash UI 404s and renders empty forever. The UI also renders `deletedBy` and `autoPurgeAt`, which the backend response omits. Nothing ever purges standalone pages, contradicting "purged after 30 days".

**Files:**
- Modify: `backend/src/routes/knowledge/pages-crud.ts` (trash route ~685-712): add fields
- Modify: the maintenance job (locate via `grep -rn "maintenance" backend/src/domains --include="*.ts" -l`; the queue named `maintenance` from /api/health): add standalone purge
- Test: `backend/src/routes/knowledge/pages-trash.test.ts` (new)

- [ ] **Step 3.1: Failing test** — seed standalone page by user A, soft-delete it (`UPDATE pages SET deleted_at = NOW() - INTERVAL '31 days'`). Assert: (a) `GET /api/pages/trash` as A returns the item **with `deletedBy` (username) and `autoPurgeAt` (deleted_at + 30 days ISO)**; (b) after running the exported purge function, the row is gone; (c) a 29-day-old soft-deleted page survives the purge.
- [ ] **Step 3.2:** Run → FAIL.
- [ ] **Step 3.3: Implement** — trash route SELECT joins users for the deleter (deleter == owner for standalone: `JOIN users u ON u.id = cp.created_by_user_id`) and maps:

```ts
deletedBy: row.deleted_by_username,
autoPurgeAt: new Date(row.deleted_at.getTime() + 30 * 24 * 3600 * 1000).toISOString(),
```

Add `purgeExpiredStandalonePages()` next to the existing purge logic (sync-service has the Confluence variant at ~line 1259) but for standalone pages, and call it from the maintenance job:

```ts
export async function purgeExpiredStandalonePages(): Promise<number> {
  const res = await query(
    `DELETE FROM pages WHERE source = 'standalone' AND deleted_at < NOW() - INTERVAL '30 days'`,
  );
  return res.rowCount ?? 0;
}
```

(Place it in a knowledge-domain service the maintenance job may import without violating ESLint boundaries — check where the maintenance job lives first; if it's in `core`, put the function in the job's own domain-legal location.)
- [ ] **Step 3.4:** Run → PASS. Commit: `git commit -m "fix(trash): expose deletedBy/autoPurgeAt and purge expired standalone pages"`.

---

### Task 4: Backend — shield the `__system__` account

`GET /api/admin/users` lists the system account (id `00000000-0000-0000-0000-000000000000`) with live Deactivate/Delete actions.

**Files:**
- Modify: `backend/src/core/services/admin-user-service.ts` (`listUsers` ~line 84; `SYSTEM_USER_ID` const exists at ~line 23; `deactivateUser` ~238; `deleteUser` ~314; role update fn)
- Test: extend the existing admin-users test file (locate: `backend/src/routes/foundation/admin-users.test.ts`)

- [ ] **Step 4.1: Failing tests** — (a) list response contains no user with id SYSTEM_USER_ID; (b) `POST /api/admin/users/<SYSTEM_USER_ID>/deactivate` → 400 with `SYSTEM_USER_PROTECTED` error code; (c) `DELETE /api/admin/users/<SYSTEM_USER_ID>` → 400 same; (d) `PUT` role change on it → 400 same.
- [ ] **Step 4.2:** Run → FAIL.
- [ ] **Step 4.3: Implement** — `listUsers`: `WHERE id <> $1` (SYSTEM_USER_ID). Add at the top of deactivate/delete/update service functions:

```ts
if (targetUserId === SYSTEM_USER_ID) {
  throw new AdminUserServiceError('SYSTEM_USER_PROTECTED', 'The system account cannot be modified');
}
```

Map that error code to 400 in the route handlers the same way `SELF_FORBIDDEN` is mapped.
- [ ] **Step 4.4:** Run → PASS. Commit: `git commit -m "fix(admin): hide and protect the __system__ account"`.

---

### Task 5: Frontend — trash hooks point at the real API

**Files:**
- Modify: `frontend/src/shared/hooks/use-standalone.ts` (lines ~69-83: `useTrash`, `useRestorePage`)
- Test: extend `frontend/src/features/pages/TrashPage.test.tsx`

- [ ] **Step 5.1: Failing test** — TrashPage test mocking fetch at the network boundary: respond to `/api/pages/trash` with one item `{id:'3', title:'X', deletedBy:'simon', deletedAt:…, autoPurgeAt:…}`; assert the row renders with "days until auto-purge"; assert clicking Restore POSTs `/api/pages/3/restore`. (Current code requests `/api/trash` → test fails.)
- [ ] **Step 5.2:** Implement:

```ts
queryFn: () => apiFetch<{ items: TrashItem[]; total: number }>('/pages/trash'),
…
apiFetch(`/pages/${pageId}/restore`, { method: 'POST' }),
```

Align the `TrashItem` type with the Task-3 response (`deletedBy`, `autoPurgeAt`, `deletedAt`).
- [ ] **Step 5.3:** Run `cd frontend && npx vitest run src/features/pages/TrashPage.test.tsx` → PASS. Commit: `git commit -m "fix(trash): call /pages/trash and /pages/:id/restore endpoints"`.

---

### Task 6: Frontend — license card shows expired/invalid state

API already returns `valid:false`, `expiresAt`, `seats`, `displayKey`. The card renders "Community Edition — Free" with no hint the stored key expired.

**Files:**
- Modify: `frontend/src/features/admin/LicenseStatusCard.tsx`
- Test: `frontend/src/features/admin/LicenseStatusCard.test.tsx`

- [ ] **Step 6.1: Failing tests** — mock the license query (follow the file's existing test setup) with `{edition:'community', tier:'community', valid:false, displayKey:'ATM-enterprise-10-20260515-CPQ6ddb3390.****', expiresAt:'2026-05-15T23:59:59.999Z', seats:10, canUpdate:true, features:[]}`. Assert: text matching `/expired on/i` and `May 15, 2026` (or locale-stable check) renders; badge shows "Expired" not "Free". Second case `valid:false` without `expiresAt` in the past ⇒ "Invalid". Third case: valid enterprise ⇒ existing behavior unchanged.
- [ ] **Step 6.2:** Implement — after the existing derived flags add:

```ts
const storedKeyInvalid = hasStoredKey && !isValid;
const expiredDate = data?.expiresAt ? new Date(data.expiresAt) : null;
const isExpired = storedKeyInvalid && expiredDate !== null && expiredDate.getTime() < Date.now();
```

Badge logic becomes `isValid ? 'Active' : storedKeyInvalid ? (isExpired ? 'Expired' : 'Invalid') : isCommunity ? 'Free' : 'Inactive'` (red `text-destructive` styling for the invalid pair). Below the header row, when `storedKeyInvalid`, render:

```tsx
<div className="border-t border-destructive/30 bg-destructive/10 px-5 py-3 text-sm" data-testid="license-expired-banner">
  {isExpired ? (
    <>Your stored license key expired on <strong>{expiredDate!.toLocaleDateString()}</strong>. Enterprise features are locked until a new key is saved.</>
  ) : (
    <>The stored license key is invalid. Enterprise features are locked until a valid key is saved.</>
  )}
</div>
```

Also render the seats/expiry stats grid when `hasStoredKey` even if tier is community (change `{!isCommunity && (` to `{(!isCommunity || hasStoredKey) && (`), and retitle its "Expires" label to "Expired" when `isExpired`.
- [ ] **Step 6.3:** Run tests → PASS. Commit: `git commit -m "fix(license): surface expired/invalid stored-key state on the license card"`.

---

### Task 7: Frontend — edition label disambiguation

**Files:**
- Modify: `frontend/src/features/settings/panels/SystemTab.tsx` (~line 66 row label "Edition"), `frontend/src/features/admin/LicenseStatusCard.tsx` (PanelHeader subtitle)
- Test: existing SystemTab/LicenseStatusCard tests

- [ ] **Step 7.1:** SystemTab: change the row label "Edition" → "Build edition". LicenseStatusCard subtitle → `"License tier and the enterprise features each tier unlocks."`. Update test expectations (failing-first where the strings are asserted).
- [ ] **Step 7.2:** Commit: `git commit -m "fix(settings): disambiguate build edition vs license tier labels"`.

---

### Task 8: Frontend — provider-aware LLM banner

**Files:**
- Modify: `frontend/src/shared/components/badges/ServiceStatus.tsx` (~lines 55-65)
- Test: `frontend/src/shared/components/badges/ServiceStatus.test.tsx`

- [ ] **Step 8.1: Failing test** — mock `/api/health` with `services.llm:false, llmProvider:'LMStudio'`; assert banner text `LLM provider "LMStudio" is unreachable` and a link to `/settings/ai/models`.
- [ ] **Step 8.2:** Implement:

```ts
const label = data.llmProvider
  ? `LLM provider "${data.llmProvider}" is unreachable`
  : 'LLM provider is unreachable';
```

Add to the alert rendering (next to the label) a react-router `<Link to="/settings/ai/models" className="underline">Check LLM settings</Link>`. Keep alert id `'ollama'` (dismissal persistence) but update the aria-label to "Dismiss LLM provider alert". Reduce banner vertical padding to `py-1.5` for the compactness finding.
- [ ] **Step 8.3:** Run tests → PASS. Commit: `git commit -m "fix(health): name the actual LLM provider in the outage banner"`.

---

### Task 9: Frontend — AI degraded states (models error, 403 ask feedback, summary offline note)

**Files:**
- Modify: `frontend/src/features/ai/AiContext.tsx` (modelsQuery ~318; runStream catch ~520), `frontend/src/features/ai/AiAssistantPage.tsx` (~293 "Loading models..."), `frontend/src/shared/components/article/ArticleSummary.tsx` (~88-93)
- Test: AiAssistantPage/AiContext/ArticleSummary colocated tests

- [ ] **Step 9.1: Failing tests** — (a) models fetch rejects ⇒ AiAssistantPage shows "Models unavailable" with a Retry button (not eternal spinner); (b) `runStream` rejects with `ApiError(403,…)` ⇒ messages end with an assistant-style error entry containing "permission" (not silently sliced); (c) ArticleSummary with summaryStatus pending + health `services.llm:false` ⇒ renders "AI summary unavailable — LLM provider offline".
- [ ] **Step 9.2:** Implement (a): expose `modelsError: modelsQuery.isError` and `refetchModels: modelsQuery.refetch` in context; in AiAssistantPage:

```tsx
{modelsError ? (
  <button onClick={() => refetchModels()} className="flex h-7 items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 text-xs text-destructive">
    <AlertTriangle size={12} /> Models unavailable — retry
  </button>
) : models.length === 0 ? ( /* existing spinner */ ) : ( /* existing picker */ )}
```

(b) in the catch block, instead of `setMessages((prev) => prev.slice(0, -1))`, replace the placeholder with an error message so the chat shows what happened:

```ts
const friendly = err instanceof ApiError && err.status === 403
  ? 'You don\'t have permission to use AI features (permission "llm:query"). Ask an administrator to assign you a role that includes it.'
  : err instanceof Error ? err.message : 'Request failed';
setMessages((prev) => {
  const updated = [...prev];
  updated[updated.length - 1] = { ...updated[updated.length - 1]!, content: friendly, isError: true };
  return updated;
});
```

Add optional `isError?: boolean` to the message type and render error bubbles with destructive styling in the message list component (locate where messages render — same feature dir). Keep the toast for non-403s only.
(c) ArticleSummary: add a lightweight health query (`useQuery(['health'], () => fetch('/api/health').then(r=>r.json()), {staleTime:30_000, retry:false})`) and when `summaryStatus !== 'summarizing'` and `health?.services?.llm === false` render "AI summary unavailable — LLM provider offline" (gray, no clock pulse) instead of "AI summary will be generated shortly".
- [ ] **Step 9.3:** Run the three test files → PASS. Commit: `git commit -m "fix(ai): visible degraded states for models, ask 403s, and summary when LLM offline"`.

---

### Task 10: Frontend — embedding dimensions from the settings payload

**Files:**
- Modify: `frontend/src/features/settings/LlmTab.tsx` (~lines 34-40)
- Test: LlmTab colocated test

- [ ] **Step 10.1:** Replace the `['embedding-dimensions']` query (`/admin/embedding/dimensions` — endpoint doesn't exist, 404s on every visit) with a query for `/admin/settings` selecting `embeddingDimensions` (check whether LlmTab/parent already fetches `/admin/settings`; if so reuse that query's data instead of adding one). Keep the 1024 fallback.
- [ ] **Step 10.2:** Failing-first test: mock `/admin/settings` → `{embeddingDimensions: 768, …}`; assert "768" renders where dims display; assert **no** request to `/admin/embedding/dimensions`.
- [ ] **Step 10.3:** Commit: `git commit -m "fix(settings): read embedding dimensions from /admin/settings (kill 404)"`.

---

### Task 11: Frontend — ConfirmDialog component; replace native confirm(); select styling; disabled-create hint

**Files:**
- Create: `frontend/src/shared/components/ConfirmDialog.tsx` + `ConfirmDialog.test.tsx`
- Modify: `frontend/src/features/pages/PageViewPage.tsx` (~line 357), `frontend/src/features/admin/UsersAdminPage.tsx` (delete confirm ~line 303, role select ~251), `frontend/src/features/pages/NewPagePage.tsx` (Create button ~165)

- [ ] **Step 11.1:** Build `ConfirmDialog` on the Radix dialog primitive already in the bundle (check `package.json` / existing usage e.g. version-history popover; if only `@radix-ui/react-dialog` exists, use it):

```tsx
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}
```

nm-card styling, destructive confirm button uses `bg-destructive`. Test: renders title/description, confirm fires `onConfirm`, Escape fires `onCancel`.
- [ ] **Step 11.2:** PageViewPage: replace `window.confirm('Delete this article? This cannot be undone.')` with the dialog — copy: title "Move page to trash?", description "It can be restored from Trash for 30 days, then it is permanently deleted.", confirm "Move to trash". Success toast → "Page moved to trash.". Update PageViewPage test.
- [ ] **Step 11.3:** UsersAdminPage: replace `window.confirm` with the dialog — title `Permanently delete "${u.username}"?`, description "This cannot be undone.", confirm "Delete user", destructive. Style the role `<select>` with the same `nm-select-md`-style classes used by NewPagePage's space selector (keep native element — project pattern). Update test.
- [ ] **Step 11.4:** NewPagePage: on the Create Page button add `title={isCreateDisabled ? 'Enter a title and select a space first' : undefined}` and wrap in a span so the tooltip shows while disabled. Test asserts the title attr when disabled.
- [ ] **Step 11.5:** Run all four test files → PASS. Commit: `git commit -m "feat(ui): ConfirmDialog replaces native confirm; consistent selects; create-page hint"`.

---

### Task 12: Frontend — copy sweep (terminology, locale, pluralization, labels, misc visibility)

**Files / exact changes** (update each component's colocated test where the string is asserted; failing-first for the behavioral ones):

- [ ] **Step 12.1:** Terminology "article"→"page" in user-facing strings:
  - `PageViewPage.tsx`: "Article not found"→"Page not found"; "The selected page is unavailable…" keep; toasts "Article deleted."→handled in Task 11; line 786 "Was this article helpful?"→"Was this page helpful?".
  - `TrashPage.tsx`: header sub "Deleted pages are automatically purged 30 days after deletion"; empty state "No pages in trash" / "Deleted local pages will appear here".
  - `KPICards.tsx`: "Total Articles"→"Total Pages".
  - `GraphPage.tsx` (~643): "start from one article"→"start from one page"; "that article and its closest neighbours"→"that page and its closest neighbors".
  - Editor toolbar aria label "Article editor toolbar"→"Page editor toolbar" (locate via grep).
  - ArticleRightPane "No headings in this article."→"No headings on this page." (locate via grep `No headings`).
- [ ] **Step 12.2:** Locale en-US: `frontend/src/features/ai/ask-example-prompts.ts:9` "Summarise"→"Summarize". Grep the whole frontend for `ise\b` British forms (`summarise|organise|colour|neighbour|favourite`) and fix any user-facing hits.
- [ ] **Step 12.3:** `SidebarTreeView.tsx` (~743): `{treeData.total} {treeData.total === 1 ? 'page' : 'pages'}{…}`.
- [ ] **Step 12.4:** `KPICards.tsx`: add `title={fullLabel}` to each card label and let labels wrap to two lines (`line-clamp-2` instead of truncate) so "Embedding Coverage" isn't cut to "Embedding Co...".
- [ ] **Step 12.5:** `UsersAdminPage.tsx`: compute `const showEmail = data.users.some((u) => u.email);` — render the Email column header/cells only when true.
- [ ] **Step 12.6:** Helpful-widget author visibility (`PageViewPage.tsx` ~786): hide the feedback block when the page is standalone and `page.createdByUserId === currentUser.id` (check the page payload field name via the contracts schema; if absent, skip silently and note in PR).
- [ ] **Step 12.7:** Settings unknown route: read `frontend/src/features/settings/SettingsPanelRoute.tsx`; replace the silent redirect-to-first-item fallback for an unrecognized `/settings/<a>/<b>` with a small panel: "This settings page doesn't exist." + link "Go to Settings" (`firstVisiblePath()`). Keep `/settings` index redirect behavior. Failing-first test with an unknown route via MemoryRouter.
- [ ] **Step 12.8:** Registration form (`frontend/src/features/settings/LoginPage.tsx`): in register mode add a "Confirm password" input (same styling), hint text "At least 8 characters" under the password field, and client-side mismatch error "Passwords don't match" blocking submit. Failing-first test: register mode, mismatched passwords ⇒ error shown, no POST; matched ⇒ POST fired.
- [ ] **Step 12.9:** Run the full frontend suite: `cd frontend && npx vitest run`. Fix any string assertions broken by the sweep. Commit: `git commit -m "fix(ui): terminology/locale/pluralization sweep + registration confirm + settings 404 panel"`.

---

### Task 13: Frontend — silent EE-bundle probe + CSP hash guard

**Files:**
- Modify: `frontend/src/shared/enterprise/loader.ts` (defaultScriptLoader, lines 20-32)
- Modify: `frontend/index.html` + `frontend/nginx-security-headers.conf` (line 12) if hash differs
- Create: `frontend/scripts/check-csp-hash.mjs`; wire into `frontend/package.json` `"prebuild"`
- Test: `frontend/src/shared/enterprise/loader.test.ts`

- [ ] **Step 13.1:** loader: probe before injecting so CE/404 deployments emit zero console errors:

```ts
const defaultScriptLoader: ScriptLoader = async (url) => {
  if ((window as any)[EE_UI_GLOBAL]) return;
  const res = await fetch(url, { method: 'HEAD' });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !/javascript|ecmascript/.test(type)) {
    throw new Error(`EE bundle not available at ${url}`);
  }
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`EE bundle failed to load from ${url}`));
    document.head.appendChild(script);
  });
};
```

Update loader.test.ts mocks (it stubs the loader; add a test for the new probe path with a mocked `fetch` 404 ⇒ resolves null, no throw to caller).
- [ ] **Step 13.2:** `check-csp-hash.mjs`: extract the first inline `<script>` body from `index.html`, compute `sha256-` base64, compare to the hash in `nginx-security-headers.conf`; exit 1 with both values printed on mismatch. Run it; if it reports mismatch, update the conf hash to the computed value. Add `"prebuild": "node scripts/check-csp-hash.mjs"` to frontend package.json.
- [ ] **Step 13.3:** Run `node scripts/check-csp-hash.mjs` (must pass) and `npx vitest run src/shared/enterprise/loader.test.ts` → PASS. Commit: `git commit -m "fix(enterprise): probe EE bundle silently; guard CSP hash at build time"`.

---

### Task 14: Quality gates + EE rebuild + live visual verification

- [ ] **Step 14.1:** CE gates: `npm run lint && npm run typecheck && npm test` from the CE root — all green.
- [ ] **Step 14.2:** Point the EE submodule at the branch: in `/home/simon/Documents/Compendiq/compendiq-ee/ce`, `git fetch /home/simon/Documents/Compendiq/compendiq-ce feature/ux-review-fixes && git checkout FETCH_HEAD`. Rebuild + restart: `./scripts/build-enterprise.sh --skip-obfuscate`, `cd build && docker build -f docker/Dockerfile.enterprise -t ghcr.io/compendiq/compendiq-ee-backend:dev . && cd ..`, `docker compose --env-file .env -f docker/docker-compose.ee.yml up -d --force-recreate backend`. **The frontend container runs the registry CE image — for frontend verification run the Vite dev server against the EE backend** (`cd compendiq-ce && npm run dev -w frontend` with proxy to :3053) or build the frontend image locally; choose whichever the compose/vite config makes cheaper (check `frontend/vite.config.ts` proxy target env var).
- [ ] **Step 14.3:** Playwright pass mirroring the review: license page shows "expired on May 15 2026"; banner says `LLM provider "LMStudio" is unreachable`; AI page 403 → visible chat error (test with a fresh `user`-role account); models error chip; tree no longer lists other users' private pages; deleted page appears in Trash and restores; `__system__` absent from Access Control; no console errors on page load (CSP + enterprise.js gone); registration confirm-password; "1 page in TESTING" pluralized. Screenshot each.
- [ ] **Step 14.4:** Run the overlay suites per EE CLAUDE.md (`cd build/backend && npm test && npm run test:overlay`) to prove the CE changes don't break EE.
- [ ] **Step 14.5:** Final commit of any verification fixes; do not push (user pushes per global config).

---

### Task 15: Confluence integration test container

Infra exists: `docker/docker-compose.confluence.yml` (Confluence DC 9.2.14 + Postgres 16, ports 127.0.0.1:8090/8091) and `e2e/confluence-sync.spec.ts` (skips unless `E2E_CONFLUENCE_URL` + `E2E_CONFLUENCE_PAT`). Confluence DC requires a license to finish setup — use an Atlassian **DC timebomb license** (developer.atlassian.com → "Timebomb licenses for testing Data Center apps"; the 72-hour DC license is fine for dev).

- [ ] **Step 15.1:** `docker network inspect compendiq_backend-net >/dev/null 2>&1 || docker network create compendiq_backend-net` (compose declares it external), then `docker compose -f docker/docker-compose.confluence.yml up -d` and wait for `curl -fsS http://localhost:8090/status` to return `{"state":"FIRST_RUN"}` (startup takes minutes; JVM 2 GB).
- [ ] **Step 15.2:** Drive the setup wizard at `http://localhost:8090` with Playwright (non-clustered "Production installation", paste timebomb license, built-in user directory, admin user `admin`/dev-only password from `docker/.env` — add `CONFLUENCE_ADMIN_PASSWORD=` entry, never commit a real secret). If the wizard markup resists automation, document the 5 manual clicks in the doc from Step 15.4 and continue manually once.
- [ ] **Step 15.3:** In Confluence: create space `TEST` with 2-3 pages (one with a code block + task list to exercise the content pipeline), then create a PAT: profile → Personal Access Tokens → "compendiq-e2e". Export `E2E_CONFLUENCE_URL=http://localhost:8090 E2E_CONFLUENCE_PAT=<token>` and run `npx playwright test e2e/confluence-sync.spec.ts` — expect green.
- [ ] **Step 15.4:** Write `docs/confluence-test-container.md`: how to start/stop, license note, PAT creation, env vars, what the e2e covers, and that the backend container reaches it via `compendiq_backend-net` as `http://confluence:8090`. Mention `e2e/confluence-sync-mock.spec.ts` as the CI-safe variant. Commit: `git commit -m "docs(e2e): Confluence test container runbook + verified sync e2e"`.
- [ ] **Step 15.5:** Use the live instance for one end-to-end verification of Task 1: connect the PAT in the app, sync space TEST, confirm synced pages appear in tree/search/stats consistently for the syncing user.

---

## Self-review notes

- Spec coverage: license expiry (T6), AI silent 403 + models spinner + summary promise (T9), provider banner naming + compactness (T8), tree/search/stats consistency (T1, T2; search already filters), trash triple-contradiction (T3, T5, T11 copy), `__system__` (T4), embedding-dimensions 404 (T10), enterprise.js + CSP console noise (T13), confirm()/selects/tooltip (T11), terminology/locale/plural/truncation/email-column/helpful-widget/settings-404/registration (T12), edition labels (T7), Confluence container (T15), live verification incl. heartbeat-404 check (T14). Post-delete heartbeat noise: navigation in Task 11's new flow happens after the mutation resolves and presence unmounts — verify in T14.3; if 404s persist, stop the heartbeat on 404 response in the presence hook (one-line guard).
- The provider Test button already has toast feedback per code; T14.3 re-checks it live — only fix if reproducibly silent.
- Type consistency: `TrashItem` (T5) matches T3's response; `isError` message flag (T9) is local to the AI feature types.
