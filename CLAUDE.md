# CLAUDE.md

This file provides guidance to Claude Code when working with this repository. AGENTS.md mirrors these rules for other AI tools.

## Project Overview

**Compendiq** — AI-powered knowledge base management web app that integrates with Confluence Data Center (on-premises) and supports multiple LLM providers (Ollama, OpenAI-compatible APIs) for article improvement, generation, summarization, and RAG-powered Q&A. Multi-user: each user configures their own Confluence PAT and space selections. Monorepo: `backend/` (Fastify 5 + PostgreSQL + Redis) and `frontend/` (React 19 + Vite).

See `@docs/ARCHITECTURE-DECISIONS.md` for all ADRs. See `@docs/ACTION-PLAN.md` for the implementation plan. See `@docs/architecture/` for the Mermaid architecture diagrams (system context, containers, domain boundaries, deployment, ERD, auth/sync/RAG/license flows, content pipeline).

## Mandatory Rules

1. **Tests required** — Every change needs tests. Backend: `backend/src/**/*.test.ts`, Frontend: `frontend/src/**/*.test.{ts,tsx}`, E2E: `e2e/*.spec.ts`. Both use Vitest; frontend uses jsdom + `@testing-library/react`. Never use `--no-verify`.
2. **Never push to `main`** — Branch from `dev` as `feature/<desc>`. PRs go `feature/* -> dev`. Only `dev -> main` merges target `main`.
3. **Never commit secrets** — No `.env`, API keys, PATs, passwords, or credentials.
4. **Ask before assuming** — If ambiguous, ask for clarification before proceeding.
5. **Follow the ADRs** — All architectural decisions are in `docs/ARCHITECTURE-DECISIONS.md`. Do not deviate without discussion.
6. **Keep architecture diagrams in sync** — `docs/architecture/*.md` are part of the source of truth. In the same PR as any code change that affects the system structure, update the affected diagram(s). See `docs/architecture/README.md` for the mapping of code areas → diagrams (e.g. Docker compose → `02-container.md` + `05-deployment.md`; new domain/service or ESLint boundary change → `03-backend-domains.md`; new migration that adds/renames/drops a table or FK → `06-data-model.md`; auth/sync/RAG/license flow changes → the matching `07-`/`08-`/`09-`/`10-*.md`; content-converter changes → `11-content-pipeline.md`). If unsure how to update a diagram, flag it in the PR description rather than leaving it stale.

## Build Commands

```bash
npm install                # Install all (all workspaces)
npm run dev                # Dev server (backend + frontend)
npm run build              # Build everything
npm run lint               # Lint
npm run typecheck          # Type check
npm test                   # All tests
npm run test -w backend    # Backend only
npm run test -w frontend   # Frontend only
# Single file: cd backend && npx vitest run src/path/file.test.ts
# Backend tests use real PostgreSQL (POSTGRES_TEST_URL env var, default: localhost:5433)
# E2E: npx playwright test (requires running backend + frontend)
# Docker: docker compose -f docker/docker-compose.yml up -d
```

## Architecture

Flat monorepo with domain-based backend structure and shared contracts (ADR-001, ADR-008):

```
compendiq/
├── backend/src/
│   ├── core/                        # Shared infrastructure (no domain imports)
│   │   ├── enterprise/              # Enterprise plugin loader (types, noop, loader, features)
│   │   ├── db/postgres.ts           # Connection pool + migration runner
│   │   ├── db/migrations/           # Sequential SQL files (001-051)
│   │   ├── plugins/                 # Fastify plugins (auth, correlation-id, redis)
│   │   ├── services/                # Cross-cutting: redis-cache, audit-service, error-tracker,
│   │   │                            #   content-converter, circuit-breaker, image-references,
│   │   │                            #   rbac-service, notification-service, queue-service,
│   │   │                            #   email-service, email-templates,
│   │   │                            #   pdf-service, admin-settings-service, version-snapshot
│   │   └── utils/                   # crypto, logger, sanitize-llm-input, ssrf-guard, tls-config, llm-config
│   ├── domains/
│   │   ├── confluence/services/     # confluence-client, sync-service, attachment-handler,
│   │   │                            #   subpage-context, sync-overview-service, confluence-rate-limiter
│   │   ├── llm/services/            # openai-compatible-client (unified; queue + per-provider breakers),
│   │   │                            #   llm-provider-service (CRUD), llm-provider-resolver (resolveUsecase),
│   │   │                            #   llm-provider-bootstrap (env seed on fresh install), cache-bus,
│   │   │                            #   embedding-service, rag-service, llm-cache, llm-audit-hook,
│   │   │                            #   llm-queue, prompts
│   │   └── knowledge/services/      # auto-tagger, quality-worker, summary-worker,
│   │                                #   version-tracker, duplicate-detector
│   ├── routes/
│   │   ├── foundation/              # health, auth, settings, admin, rbac, notifications
│   │   ├── confluence/              # spaces, sync, attachments
│   │   ├── llm/                     # llm-chat (SSE streaming), llm-conversations,
│   │   │                            #   llm-embeddings, llm-models, llm-admin, llm-pdf
│   │   └── knowledge/               # pages-crud, pages-versions, pages-tags,
│   │                                #   pages-embeddings, pages-duplicates, pinned-pages,
│   │                                #   analytics, knowledge-admin, templates, comments,
│   │                                #   content-analytics, verification, knowledge-requests,
│   │                                #   search, pages-export, pages-import, local-spaces
│   ├── app.ts                       # Fastify app builder + route registration
│   └── index.ts                     # Entry point + workers
├── frontend/src/
│   ├── features/         # Domain-grouped UI (admin, ai, analytics, auth, dashboard,
│   │                     #   graph, knowledge-requests, pages, search, settings, spaces, templates)
│   ├── shared/           # Reusable components, hooks, lib
│   │   ├── enterprise/   # Enterprise plugin loader (context, types, loader, hook)
│   │   └── components/   # Categorized: layout/, article/, diagrams/, badges/, feedback/, effects/
│   ├── stores/           # Zustand stores (auth, theme, ui, article-view, command-palette, keyboard-shortcuts)
│   └── providers/        # Context providers (Query, Auth, Router)
├── packages/contracts/   # Shared Zod schemas + TypeScript types (@compendiq/contracts)
└── docker/               # Docker Compose files
```

### Domain Boundary Rules (ESLint-enforced)

Import restrictions enforced by `eslint-plugin-boundaries`:
- **core** → no domain or route imports
- **confluence** → core + llm (for sync-embedding)
- **llm** → core only
- **knowledge** → core + llm + confluence
- **routes** → core + own domain (knowledge routes can access all domains)

## Tech Stack

- **Backend**: Fastify 5, TypeScript, PostgreSQL 17 (pgvector), Redis 8, `ollama` npm package, `jose` (JWT), `bcrypt`, `pg`, `undici`, `zod`, `pino`, `bullmq`, `nodemailer`
- **LLM providers**: N named `openai-compatible` endpoints configured in Settings → LLM. Ollama is reached via its `/v1` shim — no separate protocol. Each use case (chat/summary/quality/auto_tag/embedding) either inherits a default provider or picks an explicit provider+model. Queue + per-provider circuit breakers wrap every outbound call inside `openai-compatible-client.ts`
- **Frontend**: React 19, Vite, TailwindCSS 4, Radix UI, Zustand, TanStack Query, Framer Motion, TipTap v3, Sonner
- **Content conversion**: `turndown` + `jsdom` + `turndown-plugin-gfm` (Confluence XHTML → Markdown), `marked` (Markdown → HTML)
- **PDF**: `pdf-lib` for PDF export/import processing
- **RAG**: pgvector (HNSW index), `bge-m3` embeddings (1024 dimensions) via Ollama, hybrid search (vector + keyword)
- **Job Queue**: BullMQ (Redis-backed) with setInterval fallback, configurable via `USE_BULLMQ` env var
- **Email**: `nodemailer` for SMTP-based notifications, configurable via admin UI or env vars
- **Docker**: `pgvector/pgvector:pg17`, `redis:8-alpine`, multi-stage Dockerfiles

## External Services

| Service | Connection | Auth |
|---------|-----------|------|
| Confluence Data Center 9.2.15 | Per-user URL from `user_settings` | Bearer PAT (AES-256-GCM encrypted at rest) |
| LLM providers (Ollama, OpenAI, Azure OpenAI, LM Studio, vLLM, llama.cpp, LocalAI, …) | Configured via admin UI (Settings → LLM); rows in `llm_providers` table with per-use-case assignments (ADR-021). Legacy env vars (`OLLAMA_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `LLM_BEARER_TOKEN`, `DEFAULT_LLM_MODEL`, `SUMMARY_MODEL`, `QUALITY_MODEL`, `EMBEDDING_MODEL`) remain as first-boot seed only. | Bearer token (AES-256-GCM encrypted at rest) + `LLM_AUTH_TYPE` (`bearer`\|`none`) + `LLM_VERIFY_SSL` per provider row |
| PostgreSQL | `POSTGRES_URL` env var | Password via env |
| Redis | `REDIS_URL` env var | Password via env |

## Enterprise Plugin Architecture (Open-Core)

Compendiq uses an open-core model. The CE (Community Edition) is this repo. The EE (Enterprise Edition) is a separate private repo (`compendiq-enterprise`) that publishes `@compendiq/enterprise` via GitHub Packages. See `docs/ENTERPRISE-ARCHITECTURE.md` for the full design.

**Key files in the CE codebase:**

| File | Purpose |
|------|---------|
| `backend/src/core/enterprise/types.ts` | `EnterprisePlugin` interface, `LicenseInfo`, `LicenseTier`, Fastify augmentation (`app.license`, `app.enterprise`) |
| `backend/src/core/enterprise/features.ts` | `ENTERPRISE_FEATURES` constants (24+ feature flags) |
| `backend/src/core/enterprise/noop.ts` | Community-mode stub (all features disabled, zero side effects) |
| `backend/src/core/enterprise/loader.ts` | Dynamic `import('@compendiq/enterprise')` with fallback to noop |
| `backend/src/core/types/compendiq-enterprise.d.ts` | TypeScript declaration for the optional EE package |
| `frontend/src/shared/enterprise/types.ts` | `EnterpriseUI` interface, `LicenseInfo`, `EnterpriseContextValue` |
| `frontend/src/shared/enterprise/context.tsx` | `EnterpriseProvider` — fetches `/api/admin/license` once per load; derives `isEnterprise` |
| `frontend/src/shared/enterprise/use-enterprise.ts` | `useEnterprise()` hook |
| `frontend/src/features/admin/LicenseStatusCard.tsx` | License status + key-entry form (admin Settings → License tab) |
| `frontend/src/features/admin/OidcSettingsPage.tsx` | OIDC/SSO admin UI (admin Settings → SSO tab, gated by `isEnterprise`) |
| `frontend/src/features/auth/OidcCallbackPage.tsx` | Route `/auth/oidc/callback` — exchanges login_code for JWT |
| `docker/Dockerfile.enterprise` | Multi-stage Dockerfile template for EE builds (Layer 2+3 protection) |
| `backend/src/domains/llm/services/llm-audit-hook.ts` | `LlmAuditEntry` interface, `emitLlmAudit()` fire-and-forget, `setLlmAuditHook()` for EE registration |
| `scripts/build-enterprise.sh` | Template script documenting the EE overlay merge process |

**Rules for the enterprise extension points:**
- CE defines types, loader, noop stub, and feature constants — plus the enterprise UI surfaces (`LicenseStatusCard`, `OidcSettingsPage`, `OidcCallbackPage`), which render their own state based on the live license API response.
- The noop plugin must be completely inert (zero dependencies, zero side effects).
- `app.ts` calls `loadEnterprisePlugin()` during bootstrap and decorates Fastify with `license` and `enterprise`. The EE plugin's `registerRoutes()` additionally loads the persisted license key from the `admin_settings` table and refreshes the in-memory cache, so runtime `PUT /api/admin/license` updates take effect without a restart.
- `GET /api/admin/license` returns `{ edition: 'community', tier: 'community', valid: true, features: [] }` in CE mode. The fallback route is only registered when `enterprise.version === 'community'` (noop plugin) to avoid duplicate-route errors when the EE plugin registers its own version via `registerRoutes()`.
- The EE plugin's response additionally includes `displayKey`, `licenseId`, and `canUpdate: true` — the frontend reads `canUpdate` to decide whether to render the key-entry form in `LicenseStatusCard`. The CE noop fallback omits this flag.
- OIDC routes are conditionally registered only when the enterprise plugin enables `ENTERPRISE_FEATURES.OIDC_SSO`.
- Both CE and EE deployments ship the **same** unmodified CE frontend image. There is no EE-specific frontend image, no IIFE bundle, and no build-time patching of the CE SPA source. Enterprise UI is gated at runtime by `useEnterprise().isEnterprise`, derived from the `/admin/license` API response (`edition !== 'community' && valid === true`).
- License format: `ATM-{tier}-{seats}-{expiryYYYYMMDD}-{licenseId}.{ed25519SignatureBase64url}` (v2) or legacy v1 without `licenseId`. Persisted in the `admin_settings` table under key `license_key` by the EE plugin. The `COMPENDIQ_LICENSE_KEY` env var is a **deprecated bootstrap fallback** — consulted only when the DB row is absent.

## Security (Mandatory)

1. **PAT Encryption** — Confluence PATs are encrypted with AES-256-GCM using `PAT_ENCRYPTION_KEY` env var. Never store plaintext PATs. Never send PATs to the frontend.
2. **Zero Default Secrets** — Production (`NODE_ENV=production`) MUST fail to start if `JWT_SECRET` or `PAT_ENCRYPTION_KEY` is default or < 32 characters.
3. **LLM Safety** — All user content must be sanitized before sending to Ollama (prompt injection guard). Sanitize LLM output before displaying.
4. **Input Validation** — Use Zod schemas from `@compendiq/contracts` on all API boundaries. Parameterized SQL only (no string concatenation).
5. **Auth on all routes** — `fastify.authenticate` decorator on every protected endpoint. No anonymous access except `/api/health` and `/api/auth/*`.
6. **Infrastructure Isolation** — Internal services (PostgreSQL, Redis, Ollama) must not be exposed on `0.0.0.0` in production. Use Docker internal networks.

## UI/UX Design (ADR-010)

Premium glassmorphic dashboard matching `ai-portainer-dashboard`:
- Backdrop blur cards (`bg-card/80 backdrop-blur-md border-white/10`)
- Animated gradient mesh background
- Staggered entrance animations via Framer Motion (`LazyMotion`)
- Radix UI primitives for all interactive elements
- TailwindCSS 4 with CSS variables for theming
- All animations respect `prefers-reduced-motion`

**Status colors:** Green=connected, Red=disconnected, Yellow=syncing, Blue=embedding, Purple=AI processing, Gray=inactive.

## Content Format Pipeline (ADR-003)

Confluence Data Center 9.2 uses **XHTML Storage Format** only (no ADF, no API v2).

```
Confluence (XHTML Storage Format)
    ↕  confluenceToHtml() / htmlToConfluence()
PostgreSQL (body_storage=XHTML, body_html=clean HTML, body_text=plain)
    ↕  htmlToMarkdown() / markdownToHtml()
LLM/Ollama (Markdown)         Editor/TipTap (HTML)
```

Key conversion: `turndown` + `jsdom` with custom rules per Confluence macro type (code blocks, task lists, panels, user mentions, page links, draw.io diagrams).

## Testing & Mocks

**Mocks are for CI only.** External services (Confluence API, Ollama, Redis) are unavailable in CI:

- **Backend DB tests**: Use real PostgreSQL via `test-db-helper.ts` (port 5433). Never mock the database.
- **Backend route tests**: Mock only external API calls (Confluence, Ollama) and auth. Use `vi.spyOn()` with passthrough mocks.
- **Frontend tests**: Mock API responses (`vi.spyOn(globalThis, 'fetch')` or MSW), not internal components.
- **Never mock pure utility functions** — test them directly with real inputs.
- **Keep mocks close to the boundary** — mock the HTTP call, not the service function.

## Dependency Management

- **Always run `npm install` from the repo root** — npm workspaces requires a single root lock file.
- `pino-pretty` is a devDependency (not shipped to production Docker images).
- Prefer exact versions for major framework deps (React 19, Fastify 5, TipTap v3).

## Code Quality

- Readability first. Explicit over clever.
- ESLint flat config in each workspace. TypeScript strict mode. No over-engineering.
- Every PR must include doc updates: `docs/`, `.env.example`, and this file if relevant.

## Versioning

Semantic Versioning (`MAJOR.MINOR.PATCH`), currently pre-1.0. Single source of truth: **root `package.json`** → `"version"` field.

**How it flows:**
- **Backend**: `backend/src/core/utils/version.ts` reads root `package.json` at startup → exports `APP_VERSION` → used by health routes, Swagger, MCP client
- **Frontend**: `frontend/vite.config.ts` reads root `package.json` and injects `__APP_VERSION__` via Vite `define` at build time → used in UI components. Type declared in `frontend/src/vite-env.d.ts`
- **Tests**: `frontend/vitest.config.ts` also defines `__APP_VERSION__` so tests can reference it
- **MCP docs**: `mcp-docs/src/index.ts` reads its own `package.json` at startup

**When to bump:**
- Feature PRs → `dev`: **no version change**
- Release (`dev → main`): bump `"version"` in all 5 `package.json` files (root, backend, frontend, packages/contracts, mcp-docs), then merge and tag `main` with `vX.Y.Z`
- Patch (bug fix): `0.1.0 → 0.1.1`
- Minor (new feature or pre-1.0 breaking change): `0.1.0 → 0.2.0`
- Major (stable + breaking): `1.0.0` when production-ready

## Git Workflow

**CRITICAL — never violate:**
- Branch from `dev` as `feature/<desc>`. PRs MUST target `dev`, never `main` directly.
- Only `dev -> main` merges are allowed to target `main`. No exceptions.
- If a PR accidentally targets `main`, retarget it to `dev` before merging.

Commits: concise, describe "why" not "what". Never ignore CI failures. Never skip hooks.

## Environment

Copy `.env.example` to `.env`. Key vars:
- `JWT_SECRET` (32+ chars, required)
- `PAT_ENCRYPTION_KEY` (32+ chars, required)
- `POSTGRES_URL` (default: `postgresql://kb_user:changeme-postgres@localhost:5432/kb_creator`)
- `REDIS_URL` (default: `redis://:changeme-redis@localhost:6379`)
- `OLLAMA_BASE_URL` (**deprecated — seed-only**; consulted once on fresh install to seed the first `llm_providers` row. After that, configure providers in Settings → LLM.)
- `LLM_PROVIDER` (**removed** — was the two-slot toggle. Replaced by the `llm_providers` table + per-use-case assignments.)
- `LLM_BEARER_TOKEN` (**deprecated — seed-only**; Bearer token on the seeded Ollama row, consulted once on fresh install. After that, configure per-provider API keys in Settings → LLM.)
- `LLM_AUTH_TYPE` (optional, `bearer` or `none`, default: `bearer`)
- `LLM_VERIFY_SSL` (optional, set to `false` to disable TLS verification for LLM connections)
- `LLM_STREAM_TIMEOUT_MS` (optional, streaming timeout in ms, default: `300000`)
- `LLM_CACHE_TTL` (optional, Redis TTL in seconds for LLM cache, default: `3600`)
- `LLM_CONCURRENCY` (optional, default: `4`, max concurrent LLM requests)
- `LLM_MAX_QUEUE_DEPTH` (optional, default: `50`, reject when exceeded)
- `OPENAI_BASE_URL` (optional, OpenAI-compatible API base URL)
- `OPENAI_API_KEY` (optional, required when using openai provider)
- `EMBEDDING_MODEL` (default: `bge-m3`, server-wide, 1024 dims)
- `EMBEDDING_DIMENSIONS` (default: `1024`, server-wide embedding vector dimensions)
- `FTS_LANGUAGE` (default: `simple`, PostgreSQL text search configuration -- e.g. `german`, `english`)
- `DEFAULT_LLM_MODEL` (deprecated bootstrap fallback — configured in Settings → LLM → Use case assignments, issue #214; consulted only when the `admin_settings` row is absent)
- `QUALITY_CHECK_INTERVAL_MINUTES` (default: `60`)
- `QUALITY_BATCH_SIZE` (default: `5`, pages per batch)
- `QUALITY_MODEL` (deprecated bootstrap fallback — configured in Settings → LLM → Use case assignments, issue #214; consulted only when the `admin_settings` row is absent; fallback-of-last-resort: `qwen3:4b`)
- `SUMMARY_CHECK_INTERVAL_MINUTES` (default: `60`)
- `SUMMARY_BATCH_SIZE` (default: `5`, pages per batch)
- `SUMMARY_MODEL` (deprecated bootstrap fallback — configured in Settings → LLM → Use case assignments, issue #214; consulted only when the `admin_settings` row is absent)
- `USE_BULLMQ` (optional, default `true`, set `false` to fall back to legacy setInterval workers)
- `SYNC_INTERVAL_MIN` (optional, sync scheduler polling interval in minutes, default: `15`)
- `CONFLUENCE_VERIFY_SSL` (optional, set to `false` to disable TLS for Confluence)
- `CONFLUENCE_RATE_LIMIT_RPM` (optional, default: `60`, admin-configurable)
- `ATTACHMENTS_DIR` (optional, attachment cache dir, default: `data/attachments`)
- `NODE_EXTRA_CA_CERTS` (optional, PEM CA bundle path for self-signed certs)
- `OTEL_ENABLED` (optional, set to `true` to enable OpenTelemetry tracing)
- `OTEL_SERVICE_NAME` (optional, default: `compendiq-backend`)
- `OTEL_EXPORTER_OTLP_ENDPOINT` (optional, OTLP collector endpoint)
- `SMTP_HOST` (optional, SMTP server hostname)
- `SMTP_PORT` (optional, default: `587`)
- `SMTP_SECURE` (optional, set to `true` for TLS)
- `SMTP_USER` (optional, SMTP username)
- `SMTP_PASS` (optional, SMTP password)
- `SMTP_FROM` (optional, sender email address)
- `SMTP_ENABLED` (optional, set to `true` to enable email notifications; all SMTP vars also configurable via admin UI)

- `COMPENDIQ_LICENSE_KEY` (deprecated bootstrap fallback — new installs should leave this unset and paste the key into Settings → License after first login; the EE plugin persists it in the `admin_settings` table and the env var is only consulted when the DB row is absent)

OIDC/SSO is available in the Enterprise Edition only.
