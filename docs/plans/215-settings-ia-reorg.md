# Plan: Settings Page Information Architecture Reorganisation (Issue #215)

**Branch:** `feature/215-settings-ia-reorg` (from `dev`)
**Scope:** Frontend only — no backend routes, no schema changes.
**Risk:** Medium — user-facing navigation overhaul, 22 routes to remap, ~12 test files touched. Mitigated by strict URL-redirect backward compat and preserved `data-testid`s.

---

## Goal

Collapse the 22-tab horizontal scroll strip at `/settings` into a left-rail navigation with **6 grouped categories (3–6 items each)**. Preserve:

- All existing `data-testid`s (especially the `usecase-*` testids from #214 on the LLM tab).
- The admin/EE/feature-flag gating behaviour exactly as today.
- Any existing link to `/settings` (which currently opens the default Confluence tab).
- The glassmorphic visual language (ADR-010).

Add, for the first time:

- **URL deep-linking** — `/settings/:category/:item?` is now the source of truth. Bookmarks, shared links, and browser back/forward work per section.
- **Accessibility** — `<nav aria-label="Settings">` landmark with `aria-current="page"`, proper heading structure for group labels, keyboard nav via standard Tab (no custom arrow-key handling needed for this pattern).
- **`prefers-reduced-motion`** respect via Tailwind's `motion-safe:` variant throughout the rail.

---

## 1. Research Inputs

Three ResearchPacks gathered in parallel before planning (stored in agent transcripts; see commit history for the planning session).

1. **Codebase inventory** (Explore agent) — full map of the 22 tabs in `frontend/src/features/settings/SettingsPage.tsx:51-77`, gating hooks (`useAuthStore`, `useEnterprise`), current styling, test files, and the existing E2E at `e2e/settings.spec.ts`.
2. **IA best practices** (Gemini research on GitLab / Grafana / Linear / Jira / GitHub / Notion settings pages).
3. **Library docs** (docs-researcher) — Radix Tabs/Accordion, React Router v7 nested routes + `redirect()` loader pattern, Tailwind 4 `motion-safe:` variants, W3C APG Tabs / Navigation patterns.

Key research-driven decisions:

| Decision | Rationale (source) |
|---|---|
| **Use a `<nav>` landmark with `<Link>` list, NOT Radix Tabs.** | APG: `role="tablist"` is for in-page view-switching; URL-driven section navigation is a landmark-nav pattern. Simpler a11y story, no roving-tabindex JS. (W3C APG Landmarks / Navigation) |
| **Nested RRv7 routes `/settings/:category/:item?` with `<Outlet/>`.** | Path-based URLs are the convention in every surveyed product; gives per-panel code-splitting via route-level `lazy`. (React Router v7 routing guide) |
| **Parent `loader` redirects legacy `?tab=<id>` → canonical path with HTTP 301 via `throw redirect()`.** | Loader runs before render — no flash, no effect needed. (RRv7 `redirect()` API) |
| **Route-level `lazy` per panel.** | 22 panels ≈ 22 chunks fetched on demand. Current bundle loads all 22 eagerly. (RRv7 code-splitting doc) |
| **Group headers as real `<h2>` elements inside the rail.** | Screen-reader heading shortcuts; avoids unreliable `role="group"` announcements. (APG, Gemini IA finding) |
| **Left-rail flat list, NOT accordion.** | 6 groups × 3–6 items is the sweet spot for flat rails; accordion hides information scent. (NNGroup, Polaris) |
| **Invisibility gating for admin/EE, unchanged.** | All surveyed products use this; Compendiq already does. No change needed. |

---

## 2. Category Mapping (22 → 6)

**All 22 tabs** map 1:1; nothing added or removed. Admin-only and EE-only flags carry over unchanged. `data-testid` of the trigger changes from `tab-<id>` → `nav-settings-<id>` (see §7 for compat shim).

| Category | Items | Scope |
|---|---|---|
| **Personal** | Confluence · AI Prompts · Theme | user |
| **Content** | Spaces · Sync · Labels | user + admin (Labels) |
| **AI** | LLM · Embedding · AI Safety · Workers · LLM Policy *(EE)* · LLM Audit *(EE)* | admin / admin+EE |
| **Integrations** | Email / SMTP · SearXNG · MCP Docs | admin |
| **Security & Access** | Rate Limits · SSO / OIDC *(EE)* · SCIM *(EE)* · Data Retention *(EE)* | admin / admin+EE |
| **System** | License · Errors · System | admin |

**Canonical path per item** — pattern `/settings/<category>/<item>`:

```
/settings/personal/confluence        (default landing — see §4)
/settings/personal/ai-prompts
/settings/personal/theme
/settings/content/spaces
/settings/content/sync
/settings/content/labels
/settings/ai/llm
/settings/ai/embedding
/settings/ai/ai-safety
/settings/ai/workers
/settings/ai/llm-policy
/settings/ai/llm-audit
/settings/integrations/email
/settings/integrations/searxng
/settings/integrations/mcp-docs
/settings/security/rate-limits
/settings/security/sso
/settings/security/scim
/settings/security/retention
/settings/system/license
/settings/system/errors
/settings/system/system
```

**Label rationale** — addresses Gemini's caveats from the research:

- "AI" (not "AI & LLM") — future-proof label; LLM is an implementation detail.
- "Labels" placed under **Content** (organises knowledge articles, not auth).
- Kept the issue's other groupings — Personal / Integrations / Security & Access / System are industry-standard.
- Personal contains only user preferences (Confluence PAT, prompts, theme); all server-wide config is under admin categories.

---

## 3. URL Back-compat — Legacy `?tab=<id>` Redirect Table

The current implementation is state-only (no URL param read today — see Explore inventory, §3), so there are no external bookmarks to `?tab=<id>` in the wild. However, the issue spec and internal docs/tests may reference this pattern. We install a **one-shot redirect** from `?tab=<id>` → canonical path as a forward-compat hedge.

| Legacy `?tab=<id>` | Canonical path |
|---|---|
| `confluence` | `/settings/personal/confluence` |
| `ai-prompts` | `/settings/personal/ai-prompts` |
| `theme` | `/settings/personal/theme` |
| `sync` | `/settings/content/sync` |
| `spaces` | `/settings/content/spaces` |
| `labels` | `/settings/content/labels` |
| `ollama` | `/settings/ai/llm` *(id changes — see §7 note)* |
| `embedding` | `/settings/ai/embedding` |
| `ai-safety` | `/settings/ai/ai-safety` |
| `workers` | `/settings/ai/workers` |
| `llm-policy` | `/settings/ai/llm-policy` |
| `llm-audit` | `/settings/ai/llm-audit` |
| `email` | `/settings/integrations/email` |
| `searxng` | `/settings/integrations/searxng` |
| `mcp-docs` | `/settings/integrations/mcp-docs` |
| `rate-limits` | `/settings/security/rate-limits` |
| `sso` | `/settings/security/sso` |
| `scim` | `/settings/security/scim` |
| `retention` | `/settings/security/retention` |
| `license` | `/settings/system/license` |
| `errors` | `/settings/system/errors` |
| `system` | `/settings/system/system` |

Unknown `?tab=<x>` values redirect to `/settings` (default landing).

---

## 4. Default Landing & Permission-Aware Redirect

`/settings` (index) redirects to the **first item the current user can see**:

- User (non-admin): `/settings/personal/confluence`.
- Admin (CE): `/settings/personal/confluence` (keeps parity with current `confluence` default — avoids behaviour-change complaint in the issue's "Notes").
- Admin (EE): same as CE — the default is always Confluence, not an admin-only tab.

Implementation: `SettingsLayout` loader resolves the active category+item from the URL; if URL is `/settings` exactly, it 302-redirects to the permission-aware default. This is a single decision point, not scattered conditionals.

---

## 5. File Plan

### New files

| File | Purpose |
|---|---|
| `frontend/src/features/settings/SettingsLayout.tsx` | New parent layout. Left rail (`<nav aria-label="Settings">`) + `<Outlet/>`. Reads active route via `useMatches()` for `aria-current` and active-state styling. |
| `frontend/src/features/settings/settings-nav.ts` | Single source-of-truth: the **nav config** (categories + items + `adminOnly` / `enterpriseOnly` / `requiresFeature` / `component` / `data-testid`). One array, one place. Reused by the layout for rendering AND by the RRv7 route config for child generation. |
| `frontend/src/features/settings/SettingsIndexRedirect.tsx` | Tiny component at `/settings` index that redirects to the permission-aware default (§4). Alternatively implemented as a loader — decide at implementation. |
| `frontend/src/features/settings/panels/index.ts` | Barrel re-exporting panel components so each route can `lazy()` its own chunk. |
| `e2e/settings-nav.spec.ts` | **New** Playwright spec covering: URL deep-link to each category, keyboard Tab navigation, admin-only item visibility, EE gating, back/forward, legacy `?tab=` redirect. |

### Modified files

| File | Change |
|---|---|
| `frontend/src/features/settings/SettingsPage.tsx` | **Deleted** as a page; its inline components (`ConfluenceTab`, `SyncTab`, `LlmTab`/`OllamaTab`, `EmbeddingTab`, `SystemTab`) are extracted to their own files under `frontend/src/features/settings/panels/` so they can be `lazy`-imported by the route config. The existing `export { LlmTab as OllamaTab }` compat shim (used by `OllamaTab.test.tsx`) **must be preserved** by re-exporting from `panels/LlmTab.tsx`. |
| `frontend/src/App.tsx` (lines 148–150) | Replace single `<SettingsPage />` route with the nested route config: `{ path: "/settings", Component: SettingsLayout, loader: legacyTabRedirect, children: [<22 child routes>] }`. |
| `e2e/settings.spec.ts` | Update selectors: `getByRole('tab', ...)` → `getByRole('link', ...)` ; or swap to `data-testid` lookups (recommended — stable). Add assertions that the URL path matches after each nav click. |
| `frontend/src/features/settings/SettingsPage.test.tsx` | Rename to `SettingsLayout.test.tsx` if desired; update imports. Tests for tab-visibility become tests for nav-link visibility. |
| `frontend/src/features/settings/OllamaTab.test.tsx` | Imports change from `SettingsPage` to `panels/LlmTab` (alias kept via the re-export). **Do not change the `usecase-<usecase>-provider/model/model-inherited` assertions** — these are the #214 data-testids that must survive the refactor. |

### Files that stay unchanged

- Every other `*.test.tsx` file under `frontend/src/features/settings/` — they test individual panel components, not the nav shell. Changing the nav does not change panel internals.
- All `frontend/src/features/admin/*` imports (the LlmPolicy, DataRetention, LlmAudit, Scim, Oidc, License panels live there; they're referenced from `settings-nav.ts` unchanged).
- Backend: zero changes.

---

## 6. Route Config Shape

Abbreviated example for orientation — full mapping is driven from `settings-nav.ts`:

```tsx
// App.tsx (pseudocode)
import { redirect } from 'react-router-dom';
import { SETTINGS_NAV, legacyTabMap } from './features/settings/settings-nav';

{
  path: '/settings',
  Component: SettingsLayout,
  loader: ({ request }) => {
    const tab = new URL(request.url).searchParams.get('tab');
    if (tab && legacyTabMap[tab]) {
      throw redirect(legacyTabMap[tab], 301);
    }
    return null;
  },
  children: [
    { index: true, Component: SettingsIndexRedirect },
    ...SETTINGS_NAV.flatMap((group) =>
      group.items.map((item) => ({
        path: `${group.id}/${item.id}`,
        lazy: item.lazy, // e.g. () => import('./panels/LlmTab').then(m => ({ Component: m.LlmTab }))
      })),
    ),
  ],
}
```

`settings-nav.ts` exports both `SETTINGS_NAV` (grouped for rendering) and `legacyTabMap` (flat for the redirect loader) so there is no duplication.

---

## 7. `data-testid` Compatibility Matrix

To keep existing tests green without sweeping edits:

| Today | After |
|---|---|
| `tab-confluence` ... `tab-system` (22 total, on trigger button) | `nav-settings-<id>` on the rail `<Link>`. **Also** keep `tab-<id>` as an additional data-testid on the same element for one release — documented as deprecated in code comments, removed in a follow-up PR. This avoids a 22-file test edit in the same PR as the nav refactor. |
| `usecase-chat-provider`, `usecase-summary-provider`, `usecase-quality-provider`, `usecase-auto_tag-provider`, `usecase-<u>-model`, `usecase-<u>-model-inherited` (from #214) | **Unchanged.** These live inside the LLM panel content, not the nav; the panel component is moved but its internal JSX is not edited. |
| Panel-internal testids (`error-dashboard`, `label-manager`, `mcp-docs-toggle`, `errors-today`, etc.) | **Unchanged.** Panels are lifted verbatim to `panels/*.tsx`. |

**One exception** — the legacy `?tab=ollama` → `/settings/ai/llm` change: the URL segment shifts from `ollama` to `llm` (more accurate now that the panel is multi-provider). The redirect in §3 handles URL compat; any test asserting `?tab=ollama` in the URL must be updated (grep confirms only `OllamaTab.test.tsx` uses the name `ollama` and only as a component import, not a URL — safe).

---

## 8. Component Sketch — Left Rail

Key mechanics only; visual styling follows ADR-010 (`glass-card`, `border-white/10`, `backdrop-blur`). No Radix Tabs component is introduced — the rail is a native `<nav>` landmark.

```tsx
// SettingsLayout.tsx (abridged)
export function SettingsLayout() {
  const { isAdmin, isEnterprise, hasFeature } = useAccess();

  return (
    <div className="glass-card grid grid-cols-[240px_1fr] gap-0">
      <nav aria-label="Settings" className="border-r border-white/10 p-2">
        {SETTINGS_NAV.map((group) => {
          const visibleItems = group.items.filter((i) => canSee(i, { isAdmin, isEnterprise, hasFeature }));
          if (visibleItems.length === 0) return null;
          return (
            <section key={group.id} aria-labelledby={`group-${group.id}`} className="mb-4">
              <h2 id={`group-${group.id}`} className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </h2>
              <ul role="list">
                {visibleItems.map((item) => (
                  <li key={item.id}>
                    <NavLink
                      to={`/settings/${group.id}/${item.id}`}
                      data-testid={`nav-settings-${item.id}`}
                      className={({ isActive }) =>
                        `block rounded-md px-3 py-2 text-sm motion-safe:transition-colors motion-safe:duration-150 ${
                          isActive
                            ? 'bg-foreground/10 text-foreground'
                            : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground/80'
                        }`
                      }
                      aria-current={({ isActive }) => (isActive ? 'page' : undefined)}
                    >
                      {item.label}
                      {item.enterpriseOnly && <EnterpriseBadge />}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>
      <div className="p-6">
        <Suspense fallback={<PanelSkeleton />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}
```

Notes:
- `<NavLink>` gives `isActive` + default `aria-current="page"` in RRv7 — no manual `useMatches()`.
- `motion-safe:transition-colors` covers the reduced-motion ADR requirement with zero media-query plumbing.
- Keyboard nav is handled by the browser: Tab moves between links, Enter activates, Shift-Tab reverses. No JS.

---

## 9. Testing Strategy

1. **Unit (Vitest)**
   - `SettingsLayout.test.tsx` (new): renders groups + items based on role/EE, hides admin-only items for non-admin, hides EE items without feature flag, applies `aria-current` to active route.
   - `SettingsIndexRedirect.test.tsx` (new): redirects `/settings` → `/settings/personal/confluence` by default.
   - Panel tests (`OllamaTab.test.tsx`, `SpacesTab.test.tsx`, etc.): update the component import path only; assertions unchanged.

2. **E2E (Playwright)** — `e2e/settings-nav.spec.ts` (new), in addition to the existing `settings.spec.ts`:
   - User navigates `/settings/ai/llm` directly — page renders, rail item is `aria-current="page"`.
   - User presses Tab from the header; focus traverses rail links in DOM order.
   - Admin user sees the `ai` group; non-admin does not.
   - Legacy `?tab=ollama` → browser URL rewrites to `/settings/ai/llm`.
   - Browser back/forward navigates between categories without full reload.
   - Preserve existing `settings.spec.ts` by updating its selectors to use `data-testid="nav-settings-<id>"`.

3. **UI verification (manual — Docker gated by OS permissions)** — the issue spec requests Playwright-MCP screenshots against the Docker stack. Because this sandbox lacks Docker group membership, an operator runs:
   ```bash
   docker compose -f docker/docker-compose.yml up -d
   npm run dev    # OR use the deployed container
   npx playwright test e2e/settings-nav.spec.ts --headed
   ```
   Checklist for the operator:
   - Before/after screenshot of `/settings` (horizontal scroll strip vs left-rail).
   - Screenshot of each category with one representative item selected.
   - Keyboard focus ring visible on every rail link (tab through one full cycle).
   - Reduced-motion: OS-level toggle on — confirm no transitions on hover / selection.

---

## 10. Implementation Order (small, reviewable steps)

Each step is independently deployable if the previous one is. No big-bang commit.

**Step 1 — `settings-nav.ts`** (additive, no UI change)
- Introduce the grouped config; export `SETTINGS_NAV` and `legacyTabMap`.
- No other file changes. Lands as a pure addition; the old `SettingsPage` still renders.

**Step 2 — Extract panels** (additive, no UI change)
- Move each inline panel out of `SettingsPage.tsx` into `frontend/src/features/settings/panels/*.tsx`.
- `SettingsPage.tsx` now just imports + renders them — behaviour identical.
- Update `OllamaTab.test.tsx` import path in the same commit.

**Step 3 — `SettingsLayout` + nested routes** (feature-flag-less swap)
- New `SettingsLayout.tsx` + `SettingsIndexRedirect.tsx`.
- Rewire `App.tsx` to the nested route config.
- Delete `SettingsPage.tsx`.
- Legacy-URL redirect loader installed here.
- Run both test suites; expect failures only on `SettingsPage.test.tsx` (rename + selector update) and `e2e/settings.spec.ts` (selector update).

**Step 4 — Fix test selectors** (mechanical)
- Swap `tab-<id>` → `nav-settings-<id>` in all unit + E2E tests.
- Keep the dual `data-testid` in the layout for one release to avoid a hard break (tracked for removal in a follow-up).

**Step 5 — New E2E spec** (additive)
- `e2e/settings-nav.spec.ts` with the scenarios in §9.

**Step 6 — Docs + PR body**
- PR description explicitly notes: no backend change, no ADR change needed; per CLAUDE.md rule 6, no architecture diagram update required (this is a UI shuffle, not a domain-boundary change).
- `docs/architecture/README.md` mapping confirms: frontend-only UI → no diagram.

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Bundle size regression** if `lazy()` mis-wired (all 22 panels pulled eagerly). | Check `npm run build` output: verify 22 separate chunks named `panels-*.js`. Add a bundle-size assertion to CI if missing. |
| **A11y regression** if `<NavLink>`'s `aria-current` callback misused. | Unit test `SettingsLayout.test.tsx` asserts `aria-current="page"` on the active link and nowhere else. |
| **Test churn** — 12 panel tests + 1 E2E. | Dual `data-testid` (old + new) for one release absorbs most churn. The only forced edits are test-file import paths (mechanical). |
| **EE plugin interactions** — OidcSettingsPage etc. live in `features/admin/` and have their own auth checks. | These are the *same components* referenced from the nav config — no wrapper, no second-guessing. Admin+EE gating happens once, in the nav filter, consistent with today. |
| **Docker-gated UI verification** is not runnable inside this sandbox. | Plan §9 gives the exact operator commands. PR description includes a Playwright report as a merge gate. |
| **Unknown `?tab=` values** could silently break external docs. | Redirect table in §3 is exhaustive; unknown values fall back to `/settings` (no 404). A one-off audit grep (`grep -r "?tab=" docs/ CLAUDE.md README.md`) catches any internal links before merge. |

---

## 12. Out of Scope (explicit)

- **Renaming or redesigning individual panels.** The LLM panel still contains the use-case assignments UI from #214. Workers panel still shows its status cards. If individual panels want internal reflow, that's a follow-up issue per panel.
- **Wiring the `chat` use-case runtime path** — that's issue #217.
- **New settings panels** (e.g. a `/settings/personal/account` page with MFA). Gemini flagged this as a cleanup opportunity; the issue scope is re-grouping only.
- **Backend route changes** — none required. `/api/admin/settings`, `/api/settings`, all LLM admin routes are untouched.
- **Rate-limiting the left-rail's prefetch behaviour** — out of scope; RRv7 `lazy` is already on-demand.

---

## 13. Acceptance Criteria (from issue, mapped to the plan)

- [x] Plan: 22 panels grouped into **6** categories (§2).
- [x] Plan: each panel reachable in **1 click** from the rail (shallower than the current 1-tab-in-22-scroll).
- [x] Plan: URL deep-links work — `/settings/:category/:item` is the primary URL; legacy `?tab=<id>` redirects via RRv7 `loader` (§3, §6).
- [x] Plan: `data-testid` preservation strategy in §7 (panel-internal testids unchanged; rail has dual testid for a release).
- [x] Plan: admin/EE gating verified in CE **and** EE mode — unit test coverage in §9; manual verification in Docker checklist.
- [x] Plan: keyboard nav via standard Tab ordering (no roving-tabindex needed); `motion-safe:` respects reduced-motion (§8).
- [x] Plan: visual style stays glassmorphic (ADR-010) — `glass-card` wrapper, `border-white/10` divider, `motion-safe:transition-colors`.
- [x] Plan: Playwright E2E spec (`e2e/settings-nav.spec.ts`) covers navigation between all categories (§9).
- [x] Plan: no architecture diagram change — documented in §10 Step 6.

---

## 14. Rollback

Fully additive at the route level up to Step 3. If Step 3 introduces a production regression, revert Steps 3–5 as a single commit; Steps 1–2 stay (they are pure refactors that do not change rendered output). No data, no migrations, no deploy artifacts are touched — rollback is `git revert <merge-sha>` + redeploy.

---

## 15. Follow-ups (filed as separate issues)

1. Remove the dual `data-testid` (`tab-<id>` alongside `nav-settings-<id>`) one release after merge.
2. Consider consolidating "System / System" (the literal `/settings/system/system` URL) — cosmetic cleanup; rename `system` panel id to `version` or `about` if the product team prefers.
3. Revisit the "Personal" category once the first user-scoped panel that needs authentication management (MFA, sessions) lands — Gemini's boundary note about credential security placement becomes relevant then, not now.
