# CLAUDE.md

Guidance for Claude Code working in this repo. Codex and other AI tools also read this file via their fallback-filename config — keep it tool-agnostic.

## Project

**Compendiq** — AI knowledge-base app over Confluence Data Center, multi-LLM (Ollama, OpenAI-compatible). Confluence is **per-user optional**: with `user_settings.confluence_enabled` off the app runs standalone — every feature works against the local corpus and nothing syncs (#1623; see *Confluence Integration Toggle*). Monorepo: `backend/` (Fastify 5 + Postgres + Redis), `frontend/` (React 19 + Vite), `packages/contracts/` (shared Zod schemas).

Trash distinguishes a failed read from a successful empty list. A failed
refresh retains cached results with a stale warning; retry keeps its control
mounted and focusable until the request settles, then rehomes orphaned focus.

Local space settings distinguish unresolved and failed list reads from an
authoritative missing key. A failed refetch retains the cached form and its
unsaved edits; keep form seeding once per space key, not per query result.

Source-of-truth docs:
- ADRs → `@docs/ARCHITECTURE-DECISIONS.md`
- Diagrams → `@docs/architecture/` (Mermaid; see its `README.md` for the code-area → diagram map)
- Enterprise design → `@docs/ENTERPRISE-ARCHITECTURE.md`

The graph landing picker distinguishes search failures from successful empty
results and retries the current query. Cached results may remain visible after
a refetch failure only for their own query key; the two-character threshold,
large-graph gate, and full-graph escape remain independent.

## Read these when relevant

- `docs/claude/ui-ux.md`: REQUIRED before any frontend or styling change.
- `docs/claude/testing-and-retrieval-eval.md`: REQUIRED before changing tests, the eval or shadow compare.
- `docs/claude/llm-and-rag.md`: REQUIRED before changing providers, retrieval or image analysis.
- `docs/claude/pages-and-confluence.md`: REQUIRED before changing trash, visibility, connections, search or the Confluence toggle.
- `docs/claude/content-pipeline.md`: REQUIRED before changing conversion, import or attachments.
- `docs/claude/enterprise-and-baselines.md`: REQUIRED before changing EE hooks, baselines or page writers.

## Mandatory Rules

1. **Tests required** for every change. Vitest everywhere; frontend uses jsdom + `@testing-library/react`. Backend DB tests hit real Postgres (port 5433 via `test-db-helper.ts`) — never mock the DB. PR Check runs backend tests without coverage (frontend is its own job); the aggregate floors in `backend/vitest.config.ts` are for local `npm run test:coverage`. Never use `--no-verify`.
   Installer and uninstaller paths (`--dir` / `INSTALL_DIR`) are anchored to
   the invocation directory before any `cd`; validation, Compose, writes and
   removal must use that same target, including symlink/`..` traversal (use
   physical `cd` without dereferencing the removal operand). Exercise actual
   scripts with removal intercepted (`scripts/install-path.test.sh`).
2. **Branch model.** Branch from `dev` as `feature/<desc>`. PRs target `dev`. Only `dev → main` may target `main`. If a PR accidentally targets `main`, retarget before merging.
3. **No secrets in commits.** No `.env`, PATs, API keys, JWT secrets, license keys.
4. **Ask when ambiguous** — don't guess at intent.
5. **Follow the ADRs.** Don't deviate without discussion.
6. **Diagrams are source-of-truth.** When a code change affects system structure (compose, domains, ESLint boundaries, table/FK migrations, auth/sync/RAG/license flows, content pipeline), update the matching `docs/architecture/*.md` in the same PR. If unsure which diagram applies, flag it in the PR description.
7. **Documentation research via Ref MCP.** When researching external library documentation, APIs, framework behavior, or technical specifications, use the `ref` MCP tools (`ref_search_documentation`, `ref_read_url`) whenever the tool is available.

Embedding publication must carry the `content_revision` of the exact page
snapshot supplied to the embedder and check it under a page-row lock before
replacing chunks. `content_revision` moves on any protected column, so a moved
revision only rejects the result when the embedded title or `body_html` differs
from the locked row; a stale result rolls back without clearing the new page's
dirty flag. Keep the separate image-analysis revision and schema-epoch fences.

## Build

```bash
npm install                         # root only — workspaces share one lockfile
npm run dev                         # backend + frontend
npm run build | lint | typecheck    # all workspaces
npm test                            # all suites
npm test -w backend                 # one workspace
cd backend && npx vitest run <file> # single file
npx playwright test                 # local E2E against an already-running stack; CI recipe below
docker compose -f docker/docker-compose.yml up -d   # pull GHCR; needs POSTGRES_PASSWORD + REDIS_PASSWORD in docker/.env
```

## Architecture

Domain-based backend with ESLint-enforced import boundaries (`eslint-plugin-boundaries`):

- `core` → no domain or route imports
- `confluence` → `core` + `llm` (sync embeddings)
- `llm` → `core` only
- `knowledge` → `core` + `llm` + `confluence`
- `routes/foundation` → `core` + `llm` + `confluence` (provider health/list-models, the LLM queue knobs, the confidence-basis resolver, and the Confluence connection test/sync overview — see #1347 below)
- `routes/confluence` → `core` + `confluence`
- `routes/llm` → `core` + `llm` + `confluence` (sub-page context, `getClientForUser` — this allowance predates #1347 and was already enforced once the rule started firing)
- `routes/knowledge` → `core` + `llm` + `confluence` + `knowledge` (the top-level aggregator — it may import any domain)

**The routes rule was inert until #1347.** `boundaries/elements` patterned each route element as `src/routes/<x>/*` with `mode: 'folder'`, which only classifies a SUBFOLDER of that directory — every route file lives directly in `src/routes/<x>/`, so none of them ever matched an element and `boundaries/dependencies` silently never applied to any route file (a `routes/foundation` file importing `domains/knowledge` passed `npm run lint` clean). Patterns are now bare folder paths (`src/core`, `src/routes/foundation`, …), which `mode: 'folder'` classifies whether the file sits directly in the folder or a subfolder of it. `boundaries/no-unknown-files: error` is on, so a `src/` file with no element mapping now fails lint outright — this is what caught `src/telemetry-register.ts`, added to the `app` element. `backend/src/eslint-boundaries.test.ts` pins both directions (a disallowed import fails, an allowed one and `no-unknown-files` behave as configured) by linting synthetic probe source through ESLint's Node API, so a config regression is a red test rather than a silent no-op. Once the rule actually fired, whole-tree lint reported 7 real violations, all `routes/foundation` reaching into `domains/llm`/`domains/confluence` for the reasons listed above — the allow-list above reflects that widening rather than re-homing those seven call sites (an L-size change to route registration, rejected as out of scope).

Layout: `backend/src/{core,domains/{confluence,llm,knowledge},routes/{foundation,confluence,llm,knowledge}}` + `frontend/src/{features,shared,stores,providers}` + `packages/contracts/`. Detailed structure → `docs/architecture/03-backend-domains.md` and `04-frontend-structure.md`.

The sidebar's space-home projection detaches the configured homepage from its
actual parent before promoting its children to roots. Keep the original page
IDs for keyboard navigation, and retain the sole-homepage fallback (#1815).

## Tech Stack (highlights, not a manifest)

Fastify 5 · pgvector (HNSW; `bge-m3` 1024-dim default, Qwen3-Embedding-4B 2560-dim `halfvec` measured/recommended — #1114) · BullMQ (toggleable via `USE_BULLMQ`) · jose / bcrypt · React 19 · TailwindCSS 4 · Radix · TanStack Query · TipTap v3 · Zustand · `turndown` + `jsdom` for content conversion · `pdf-lib` · `nodemailer`. Full deps in `package.json`.

## Security (Mandatory)

1. **PAT encryption** — Confluence PATs are AES-256-GCM with `PAT_ENCRYPTION_KEY`. Never store plaintext, never expose to frontend.
2. **Zero default secrets** — `NODE_ENV=production` MUST fail to start if `JWT_SECRET` or `PAT_ENCRYPTION_KEY` is default or < 32 chars.
3. **LLM safety** — sanitize user content before sending (prompt-injection guard in `core/utils/sanitize-llm-input.ts`); sanitize output before rendering.
4. **Validation** — Zod schemas from `@compendiq/contracts` on every API boundary. Parameterized SQL only.
5. **Auth** — `fastify.authenticate` on every protected route. Public exceptions: `/api/health`, `/api/auth/*`. Access and refresh JWTs share `JWT_SECRET` and issuer, so purpose lives in the signed `typ` header: access `at+jwt`, refresh `rt+jwt`. `verifyToken()` is the only bearer verifier (HTTP, collab socket, logout) and requires `at+jwt`; the refresh decoder requires `rt+jwt` plus `jti` + `family`, with no exception for unmarked tokens (#1683). A new token kind signed with `JWT_SECRET` needs its own `typ` and verifier.
6. **Infra isolation** — Postgres / Redis / Ollama must not bind `0.0.0.0` in production. Use Docker internal networks.

**First-administrator bootstrap (#1661).** Migration 032's `__system__` admin
owns built-in templates but is never a real operator. Registration policy,
registration role assignment, setup status, and setup-admin creation all use
the same sentinel-excluding real-admin definition. `POST /api/auth/register`
and `POST /api/setup/admin` serialize the transition with the shared
`account-bootstrap-service.ts` transaction and users-table lock; never replace
it with a filtered count in either route. The user and default `user_settings`
row commit together. Registration keeps its pre-bcrypt policy probe for the
ordinary closed case, then rechecks under the lock so setup cannot close the
bootstrap window between policy and insert.

**Refresh-token rotation is a single-use transaction.** `/api/auth/refresh`
calls `rotateRefreshToken`: under the user's row lock it claims the presented
JTI with `UPDATE ... WHERE revoked = FALSE RETURNING` and inserts the
same-family successor before the same commit; a replay or concurrent loser
revokes the family. Family revocation and logout take the same lock (if the
5s lock wait or 10s statement deadline expires they run the UPDATE unlocked in
its own transaction with the same deadlines, then retry it once under the lock
so a stalled rotation's successor is still revoked; a session transaction idle
for 10s is terminated by PostgreSQL), and admin role change / deactivation
conflict with it by updating the users row. When both the locked revocation
and its fallback time out (`RefreshSessionBusyError`), nothing was revoked:
logout answers 503 with `code: "logout_busy"` and keeps the cookie, and
`logoutApi()` keeps client auth and rejects on that marked 503 only (an
unmarked proxy 503 still clears auth) so the user menu can offer a retry. Never
rebuild rotation from `verifyRefreshToken` + `revokeToken` +
`generateRefreshToken`. In the SPA every request that presents or sets the
refresh cookie (refresh, login, register, setup-admin, OIDC exchange, logout)
goes through `withAuthCookieLock` (Web Locks, IndexedDB lease on plain HTTP);
it is not re-entrant, so hold it around the request only.
`refreshAccessTokenOnce()` resolves `null` only when the session is gone
(then `clearAuth()`). It retries only the backend's marked busy 503
(`REFRESH_BUSY_CODE`, `code: "refresh_busy"`), taking the lock per attempt and
adopting a sibling tab's token on each acquisition; network errors and other
5xx/408/429 are never retried (the rotation may have committed). Successful
refresh bodies must pass `AuthResponseSchema` and contain a nonblank access
token before `setAuth` mutates, persists or broadcasts anything (#1800).
Unreadable bodies, invalid JSON and invalid success shapes (including JSON
`null`) reject with `RefreshUnavailableError`, just like other indeterminate
outcomes — callers must keep auth state on that rejection. The shared helper
retains that failure for the unchanged auth-state snapshot: query retries,
polling, focus/reconnect refetches, remounts and timers must not replay the
cookie. Query retry and presence/collab reconnect distinguish `retrySafe`
(exhausted marked busy only); indeterminate reconnects park until a replacement
token arrives for the same account, preserving the collaborative draft.
A new auth state (including a sibling's valid token) releases the local fence;
an older rejected flight must not fence that newer state. Explicit reload
starts a new attempt; preserve unsaved work first. No timeout clears the fence.

**Editor drafts are per-account (GHSA-r652-53hc-h6jh).** Local editor drafts
live in `localStorage`, shared by every account in the browser. Build and
access draft keys only through `frontend/src/shared/lib/editor-drafts.ts`
(`draft:u:<userId>:<key>`); nothing reads or writes a draft without a
signed-in user. Legacy unscoped `draft:*` keys are purged and never imported.
An explicit sign-out (`logoutApi()`, after the `logout_busy` check) discards
the user's drafts and fences pending writes via the sign-out epoch and the
per-user signed-out marker (cleared by `setAuth`); non-explicit session loss
(`clearAuth()` on expiry or a failed refresh) keeps them for the same user.
Command-palette recent searches follow the same rules through
`frontend/src/shared/lib/recent-searches.ts`
(`compendiq-recent-searches:u:<userId>`; legacy `kb-recent-searches` purged,
never imported; deleted by `logoutApi()` on explicit sign-out). Any new
per-user content kept in web storage and shown back in the UI belongs to the
same class: scope it by user id the same way.

Command-palette page results are bound to the exact query that produced them.
Changing the input clears both the prior result and selection immediately; the
pending state covers debounce as well as the request. Preserve the sequence
guard for out-of-order responses and only select a result after it resolves.

**Ordinary page saves are based on the editing session (#1746).**
`PageViewPage` sends the `PUT /pages/:id` `version` from `editBaseVersionRef`,
never from the live `['pages', id]` query that focus, remount and invalidation
refetches move mid-edit. It is captured where a session seeds the editor (Edit,
Restore draft, Edit published version) and replaced only by that session's own
successful PUT (`useUpdatePage` validates the returned version against
`UpdatePageSchema`); a 409, `confluence_modified` or any other failure keeps
it, so a stale draft is refused until the user reconciles it (Reload, then
Restore draft or Edit published version). The server's `version < current`
rule and the collaborative commit are unchanged.

## Enterprise (Open-Core)

CE is this repo. EE lives in the private `Compendiq/compendiq-ee` repo and ships as `@compendiq/enterprise` (loaded dynamically via `core/enterprise/loader.ts`, falls back to `noop.ts`). Both editions ship the **same unmodified CE frontend image** — no EE frontend bundle, no build-time SPA patching. Enterprise UI is gated at runtime via `useEnterprise().isEnterprise`, derived from `/api/admin/license` (`edition !== 'community' && valid === true`).

CE-side extension points (must remain inert in community mode):
- Types/loader/noop/feature flags → `backend/src/core/enterprise/`
- Frontend context/hook → `frontend/src/shared/enterprise/`
- Always-rendered UI surfaces (state-driven, not conditionally compiled): `LicenseStatusCard`, `OidcSettingsPage`, `OidcCallbackPage`. License key-entry form renders only when the API response includes `canUpdate: true` (EE adds it; CE noop omits it).
- LLM audit hook contract → `backend/src/domains/llm/services/llm-audit-hook.ts`

The CE fallback `GET /api/admin/license` route registers **only** when `enterprise.version === 'community'` to avoid duplicate-route errors when EE registers its own.

**Article AI policy activation (#1881)** is CE-owned and licence-independent:
the `ai_policy_activation_state` row, changed only through
`PUT /api/admin/ai-policy/activation`, decides whether restrictive policies
can be chosen; admission never reads it and a lapsed licence never closes it.
Never reintroduce a plugin activation hook or env flag for it. See
`docs/claude/enterprise-and-baselines.md` and
`docs/architecture/article-ai-policy-activation.md`.

License format: `ATM-{tier}-{seats}-{expiryYYYYMMDD}-{licenseId}.{ed25519SignatureBase64url}` (v2; v1 omits `licenseId`). Persisted in `admin_settings` under key `license_key`. Full design in `docs/ENTERPRISE-ARCHITECTURE.md`.

**Access Control user caches (#1809).** `['admin', 'users']` stores the
`/admin/users` envelope; approver pickers select its `users` array without
changing the cached shape. `/users` is a distinct RBAC list under the child key
`['admin', 'users', 'rbac']`. User lifecycle and bulk mutations invalidate the
`['admin', 'users']` prefix so both lists refresh; do not merge their endpoints
or store arrays under the envelope key.

## Versioning

SemVer, pre-1.0. Single source of truth: **root `package.json` `"version"`**. Backend reads at startup (`core/utils/version.ts` → `APP_VERSION`); frontend injects `__APP_VERSION__` via Vite `define`; mcp-docs reads its own.

Feature PRs to `dev` → no bump. Release (`dev → main`) → bump all five `package.json`s (root, backend, frontend, packages/contracts, mcp-docs), merge, tag `vX.Y.Z`. Patch = bug, minor = feature or pre-1.0 breaking, major = `1.0.0` when production-ready.

Release images: the `v*` tag push runs `.github/workflows/docker-build.yml`, which builds each image natively per architecture (amd64 on `ubuntu-latest`, arm64 on `ubuntu-24.04-arm`; never QEMU — emulated arm64 `npm ci` hangs or dies with `Illegal instruction`), pushes by digest and merges one multi-arch index via the reusable `docker-image.yml`. Branch pushes (`dev`, `main`) stay amd64-only. To republish an existing release without moving its tag: `gh workflow run docker-build.yml --ref dev -f tag=vX.Y.Z -f images=all` (or e.g. `images=mcp-docs`); a rebuild only moves `latest` if it is the newest stable tag.

Installer-generated Compose pins the four Compendiq images to amd64 for `dev`
and mutable `latest` (a main build can replace a multi-arch latest). ARM needs
working amd64 emulation for those tags. Other tags are unpinned for native
selection; an older release without the daemon architecture still fails to pull.
Postgres and Redis remain unpinned.

## Dependencies

- `npm install` from repo root only — workspaces require a single root lockfile.
- `pino-pretty` is a devDependency (excluded from production images).
- Pin majors for framework deps (React 19, Fastify 5, TipTap v3).
- **Root override `"vite": "^8.0.16"`** unifies the whole tree on a single vite 8 (frontend + vitest + `@tailwindcss/vite` must not split versions). The app runs **vite 8 with `@vitejs/plugin-react` 6.x** — these move together: vite 8's `rolldown` transform contract breaks plugin-react 5.x's native react-refresh wrapper in the dev server (`Missing field moduleType`, #800), so never downgrade one without the other. Rolldown also dropped the **object** form of `build.rollupOptions.output.manualChunks` — it must be the **function** form (see `frontend/vite.config.ts`).
- **Happy DOM 21 override (#1708):** `@tiptap/html` 3.30.5 still peers on `^20.8.9`. Keep root `"happy-dom": "^21.0.4"` until TipTap accepts the patched major, or npm retains vulnerable 20.x beside backend's 21.x. Verify `collab-schema-parity.test.ts` and the production HTML/Yjs roundtrip when changing it; do not re-enable CSS or iframe loading.

## Code Quality

Readability first. Explicit over clever. ESLint flat config per workspace; TS strict. PRs that change behavior must update the relevant `docs/`, `.env.example`, and this file.

## Environment

Full reference is `.env.example`. Keys you must set:

- `JWT_SECRET` — 32+ chars, required
- `PAT_ENCRYPTION_KEY` — 32+ chars, required
- `MCP_DOCS_TOKEN` — 32+ chars, required for the MCP sidecar in production
- `POSTGRES_URL`, `REDIS_URL`
- `POSTGRES_PASSWORD`, `REDIS_PASSWORD` — required by docker compose (no defaults; URL-safe values, e.g. `openssl rand -hex 24`)

Tunable defaults (override only with reason): `EMBEDDING_DIMENSIONS=1024`, `USE_BULLMQ=true`, `SYNC_INTERVAL_MIN=15`, `LLM_CONCURRENCY=4`, `LLM_MAX_QUEUE_DEPTH=50`, `LLM_STREAM_TIMEOUT_MS=300000`, `LLM_CACHE_TTL=3600`, `QUALITY_CHECK_INTERVAL_MINUTES=60`, `SUMMARY_CHECK_INTERVAL_MINUTES=60`, `CONFLUENCE_RATE_LIMIT_RPM=60`, `SHUTDOWN_TIMEOUT_MS=50000` (keep below container stop grace period). TLS escape hatches: `LLM_VERIFY_SSL`, `CONFLUENCE_VERIFY_SSL`, `NODE_EXTRA_CA_CERTS`. Observability: `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`. SMTP: `SMTP_*` (also configurable via admin UI).

**Corporate CA trust (#1819).** Base Compose does not mount a host CA file.
For private upstreams, layer `docker/docker-compose.corporate-ca.yml` and set
`HOST_CA_BUNDLE_PATH` to an existing readable PEM. The backend adds that PEM
to Node roots and the image system bundle; it must not replace public trust or
disable certificate/hostname verification. Recreate the backend after changing
the PEM or override. Existing deployments using the old automatic mount must
explicitly opt in; `CONTAINER_CA_BUNDLE_PATH` is no longer used.

Quality/Summary batch entrypoints own their local guard, Redis lease and
`isProcessing` state for every caller, including BullMQ. Do not put locking
back only in timer/manual wrappers: scheduled runs would reclaim live rows.
Their `{processed, errors}` counts exclude failures from processed; deliberate
skips may count as processed. BullMQ marks batches with errors as failed.
Run Now is one bounded batch, not a backlog drain; model identifiers must match
what the configured provider actually serves.
Batch sizes live in `admin_settings.quality_batch_size` / `summary_batch_size`,
edited under Settings → AI Models → Workers; the former batch-size env vars
are ignored. The controls preserve edits made during a save, distinguish
unreadable settings from cached settings, and retain Retry focus through
recovery. Use the shared `nm-input` treatment, not structural border tokens.

**Removed (do not revive): `FTS_LANGUAGE`** — the keyword-index language lives in `admin_settings.fts_language`, edited in Settings → AI Models → Retrieval; the env var was inert on every migrated instance because migration 049 seeds that row before any request, so the fallback it fed was unreachable, and a leftover value is now reported as ignored at startup. The allow-list is `FTS_LANGUAGES` in `packages/contracts` and stays **closed**: PostgreSQL has no bind-parameter form for a `regconfig`, so the chosen name is interpolated into SQL. It is not one of the Retrieval panel's nine cheap knobs — saving it re-indexes every page inside the request — and the mechanism, its transaction and its failure modes are documented where they belong, in `docs/architecture/09-flow-rag-chat.md` and `docs/ADMIN-GUIDE.md`.

OIDC/SSO is EE-only.
