# CLAUDE.md

Guidance for Claude Code working in this repo. Codex and other AI tools also read this file via their fallback-filename config — keep it tool-agnostic.

## Project

**Compendiq** — AI knowledge-base app over Confluence Data Center, multi-LLM (Ollama, OpenAI-compatible). Monorepo: `backend/` (Fastify 5 + Postgres + Redis), `frontend/` (React 19 + Vite), `packages/contracts/` (shared Zod schemas).

Source-of-truth docs:
- ADRs → `@docs/ARCHITECTURE-DECISIONS.md`
- Diagrams → `@docs/architecture/` (Mermaid; see its `README.md` for the code-area → diagram map)
- Enterprise design → `@docs/ENTERPRISE-ARCHITECTURE.md`

## Mandatory Rules

1. **Tests required** for every change. Vitest everywhere; frontend uses jsdom + `@testing-library/react`. Backend DB tests hit real Postgres (port 5433 via `test-db-helper.ts`) — never mock the DB. Never use `--no-verify`.
2. **Branch model.** Branch from `dev` as `feature/<desc>`. PRs target `dev`. Only `dev → main` may target `main`. If a PR accidentally targets `main`, retarget before merging.
3. **No secrets in commits.** No `.env`, PATs, API keys, JWT secrets, license keys.
4. **Ask when ambiguous** — don't guess at intent.
5. **Follow the ADRs.** Don't deviate without discussion.
6. **Diagrams are source-of-truth.** When a code change affects system structure (compose, domains, ESLint boundaries, table/FK migrations, auth/sync/RAG/license flows, content pipeline), update the matching `docs/architecture/*.md` in the same PR. If unsure which diagram applies, flag it in the PR description.

## Build

```bash
npm install                         # root only — workspaces share one lockfile
npm run dev                         # backend + frontend
npm run build | lint | typecheck    # all workspaces
npm test                            # all suites
npm test -w backend                 # one workspace
cd backend && npx vitest run <file> # single file
npx playwright test                 # E2E (needs backend + frontend running)
docker compose -f docker/docker-compose.yml up -d   # needs POSTGRES_PASSWORD + REDIS_PASSWORD in docker/.env
```

## Architecture

Domain-based backend with ESLint-enforced import boundaries (`eslint-plugin-boundaries`):

- `core` → no domain or route imports
- `confluence` → `core` + `llm` (sync embeddings)
- `llm` → `core` only
- `knowledge` → `core` + `llm` + `confluence`
- `routes/<domain>` → `core` + own domain (knowledge routes may reach all domains)

Layout: `backend/src/{core,domains/{confluence,llm,knowledge},routes/{foundation,confluence,llm,knowledge}}` + `frontend/src/{features,shared,stores,providers}` + `packages/contracts/`. Detailed structure → `docs/architecture/03-backend-domains.md` and `04-frontend-structure.md`.

## Tech Stack (highlights, not a manifest)

Fastify 5 · pgvector (HNSW, `bge-m3`, 1024-dim) · BullMQ (toggleable via `USE_BULLMQ`) · jose / bcrypt · React 19 · TailwindCSS 4 · Radix · TanStack Query · TipTap v3 · Zustand · `turndown` + `jsdom` for content conversion · `pdf-lib` · `nodemailer`. Full deps in `package.json`.

## LLM Provider Model (ADR-021)

N named `openai-compatible` providers in `llm_providers` table, configured via Settings → LLM. Each use case (chat / summary / quality / auto_tag / embedding) inherits a default or pins an explicit `provider+model`. Ollama uses its `/v1` shim — not a separate protocol. Queue + per-provider circuit breakers wrap every outbound call in `openai-compatible-client.ts`.

**Legacy env vars** (`OLLAMA_BASE_URL`, `OPENAI_*`, `LLM_BEARER_TOKEN`, `DEFAULT_LLM_MODEL`, `SUMMARY_MODEL`, `QUALITY_MODEL`, `LLM_MAX_CONCURRENT_STREAMS_PER_USER`, `COMPENDIQ_LICENSE_KEY`) are **deprecated bootstrap fallbacks** — consulted only on fresh install when the DB row / `admin_settings` value is absent. Don't add new env-driven LLM config; extend the providers table or `admin_settings` instead.

**Removed (do not revive):** `LLM_PROVIDER` was the legacy two-slot toggle and is gone — replaced wholesale by the `llm_providers` table + per-use-case assignments.

## Security (Mandatory)

1. **PAT encryption** — Confluence PATs are AES-256-GCM with `PAT_ENCRYPTION_KEY`. Never store plaintext, never expose to frontend.
2. **Zero default secrets** — `NODE_ENV=production` MUST fail to start if `JWT_SECRET` or `PAT_ENCRYPTION_KEY` is default or < 32 chars.
3. **LLM safety** — sanitize user content before sending (prompt-injection guard in `core/utils/sanitize-llm-input.ts`); sanitize output before rendering.
4. **Validation** — Zod schemas from `@compendiq/contracts` on every API boundary. Parameterized SQL only.
5. **Auth** — `fastify.authenticate` on every protected route. Public exceptions: `/api/health`, `/api/auth/*`.
6. **Infra isolation** — Postgres / Redis / Ollama must not bind `0.0.0.0` in production. Use Docker internal networks.

## Testing & Mocks

Mocks exist for CI only (Confluence, Ollama, Redis aren't reachable there).

- DB tests → real Postgres, never mocked.
- Backend route tests → mock external HTTP and auth via `vi.spyOn()` passthroughs; nothing else.
- Frontend tests → mock fetch/MSW at the network boundary, not internal components.
- Pure utilities → test directly with real inputs.
- Mock at the boundary (HTTP), never at the service-function layer.

## Enterprise (Open-Core)

CE is this repo. EE lives in the private `compendiq-enterprise` repo and ships as `@compendiq/enterprise` (loaded dynamically via `core/enterprise/loader.ts`, falls back to `noop.ts`). Both editions ship the **same unmodified CE frontend image** — no EE frontend bundle, no build-time SPA patching. Enterprise UI is gated at runtime via `useEnterprise().isEnterprise`, derived from `/api/admin/license` (`edition !== 'community' && valid === true`).

CE-side extension points (must remain inert in community mode):
- Types/loader/noop/feature flags → `backend/src/core/enterprise/`
- Frontend context/hook → `frontend/src/shared/enterprise/`
- Always-rendered UI surfaces (state-driven, not conditionally compiled): `LicenseStatusCard`, `OidcSettingsPage`, `OidcCallbackPage`. License key-entry form renders only when the API response includes `canUpdate: true` (EE adds it; CE noop omits it).
- LLM audit hook contract → `backend/src/domains/llm/services/llm-audit-hook.ts`

The CE fallback `GET /api/admin/license` route registers **only** when `enterprise.version === 'community'` to avoid duplicate-route errors when EE registers its own.

License format: `ATM-{tier}-{seats}-{expiryYYYYMMDD}-{licenseId}.{ed25519SignatureBase64url}` (v2; v1 omits `licenseId`). Persisted in `admin_settings` under key `license_key`. Full design in `docs/ENTERPRISE-ARCHITECTURE.md`.

## UI/UX (ADR-010 v0.4)

Neumorphic dashboard, brand palette black `#0A0A0A` + honey `#F9C74F`. Themes: **Graphite Honey** (dark, default), **Honey Linen** (light) — mirrors `compendiq-landing/src/styles/tokens.css`. Twelve `nm-*` `@utility` classes (see `frontend/src/index.css`). Hybrid neumorphism: every interactive surface keeps a 1px solid border for WCAG 1.4.11 (3:1) and `forced-colors: active`. Press = inset shadow swap; `prefers-reduced-motion: reduce` strips press transform. Animated gradient mesh background is preserved on the **setup wizard only** (not the rest of the app). Staggered entrance animations via Framer Motion `LazyMotion` (lazy-load to keep first paint cheap). Status colors: green=connected, red=disconnected, yellow=syncing, blue=embedding, purple=AI, gray=inactive.

## Content Pipeline (ADR-003)

Confluence DC 9.2 = XHTML Storage Format only (no ADF). Pipeline:
```
Confluence (XHTML) ⇄ confluenceToHtml/htmlToConfluence ⇄ DB (body_storage XHTML, body_html clean, body_text plain)
DB (HTML) ⇄ htmlToMarkdown/markdownToHtml ⇄ {LLM: Markdown, Editor/TipTap: HTML}
```
Custom `turndown` rules per Confluence macro (code blocks, task lists, panels, mentions, page links, draw.io). See `docs/architecture/11-content-pipeline.md`.

## Versioning

SemVer, pre-1.0. Single source of truth: **root `package.json` `"version"`**. Backend reads at startup (`core/utils/version.ts` → `APP_VERSION`); frontend injects `__APP_VERSION__` via Vite `define`; mcp-docs reads its own.

Feature PRs to `dev` → no bump. Release (`dev → main`) → bump all five `package.json`s (root, backend, frontend, packages/contracts, mcp-docs), merge, tag `vX.Y.Z`. Patch = bug, minor = feature or pre-1.0 breaking, major = `1.0.0` when production-ready.

## Dependencies

- `npm install` from repo root only — workspaces require a single root lockfile.
- `pino-pretty` is a devDependency (excluded from production images).
- Pin majors for framework deps (React 19, Fastify 5, TipTap v3).
- **Root override `"vite": "^7.3.3"`** pins the whole tree to vite 7 (don't remove without testing `npm run dev`). vitest 4 / `@tailwindcss/vite` otherwise pull vite 8 → `rolldown@1.0.1`, whose stricter transform contract breaks `@vitejs/plugin-react@5.2.0`'s native react-refresh wrapper in the dev server (`Missing field moduleType`). Lifting the pin requires moving the app to vite 8 + `@vitejs/plugin-react` 6.x together. See #800.

## Code Quality

Readability first. Explicit over clever. ESLint flat config per workspace; TS strict. PRs that change behavior must update the relevant `docs/`, `.env.example`, and this file.

## Environment

Full reference is `.env.example`. Keys you must set:

- `JWT_SECRET` — 32+ chars, required
- `PAT_ENCRYPTION_KEY` — 32+ chars, required
- `POSTGRES_URL`, `REDIS_URL`
- `POSTGRES_PASSWORD`, `REDIS_PASSWORD` — required by docker compose (no defaults; URL-safe values, e.g. `openssl rand -hex 24`)

Tunable defaults (override only with reason): `EMBEDDING_MODEL=bge-m3`, `EMBEDDING_DIMENSIONS=1024`, `FTS_LANGUAGE=simple`, `USE_BULLMQ=true`, `SYNC_INTERVAL_MIN=15`, `LLM_CONCURRENCY=4`, `LLM_MAX_QUEUE_DEPTH=50`, `LLM_STREAM_TIMEOUT_MS=300000`, `LLM_CACHE_TTL=3600`, `QUALITY_*` / `SUMMARY_*` batch+interval, `CONFLUENCE_RATE_LIMIT_RPM=60`, `SHUTDOWN_TIMEOUT_MS=50000` (keep below container stop grace period). TLS escape hatches: `LLM_VERIFY_SSL`, `CONFLUENCE_VERIFY_SSL`, `NODE_EXTRA_CA_CERTS`. Observability: `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`. SMTP: `SMTP_*` (also configurable via admin UI).

OIDC/SSO is EE-only.
