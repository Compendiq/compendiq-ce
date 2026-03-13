# CLAUDE.md

This file provides guidance to Claude Code when working with this repository. AGENTS.md mirrors these rules for other AI tools.

## Project Overview

AI-powered knowledge base management web app that integrates with Confluence Data Center (on-premises) and uses a local Ollama server for LLM features: article improvement, generation, summarization, and RAG-powered Q&A. Multi-user: each user configures their own Confluence PAT and space selections. Monorepo: `backend/` (Fastify 5 + PostgreSQL + Redis) and `frontend/` (React 19 + Vite).

See `@docs/ARCHITECTURE-DECISIONS.md` for all ADRs. See `@docs/ACTION-PLAN.md` for the implementation plan.

## Mandatory Rules

1. **Tests required** — Every change needs tests. Backend: `backend/src/**/*.test.ts`, Frontend: `frontend/src/**/*.test.{ts,tsx}`, E2E: `e2e/*.spec.ts`. Both use Vitest; frontend uses jsdom + `@testing-library/react`. Never use `--no-verify`.
2. **Never push to `main`** — Branch from `main` as `feature/<desc>`. PRs go `feature/* -> main`.
3. **Never commit secrets** — No `.env`, API keys, PATs, passwords, or credentials.
4. **Ask before assuming** — If ambiguous, ask for clarification before proceeding.
5. **Follow the ADRs** — All architectural decisions are in `docs/ARCHITECTURE-DECISIONS.md`. Do not deviate without discussion.

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
# Docker: docker compose -f docker/docker-compose.dev.yml up -d
```

## Architecture

Flat monorepo with domain-based backend structure and shared contracts (ADR-001, ADR-008):

```
ai-kb-creator/
├── backend/src/
│   ├── core/                        # Shared infrastructure (no domain imports)
│   │   ├── db/postgres.ts           # Connection pool + migration runner
│   │   ├── db/migrations/           # Sequential SQL files (001-026)
│   │   ├── plugins/                 # Fastify plugins (auth, cors, rate-limit, redis)
│   │   ├── services/                # Cross-cutting: redis-cache, audit, error-tracker,
│   │   │                            #   content-converter, circuit-breaker, image-references
│   │   └── utils/                   # crypto, logger, sanitize, ssrf-guard, tls/llm config
│   ├── domains/
│   │   ├── confluence/services/     # confluence-client, sync-service, attachment-handler,
│   │   │                            #   subpage-context, sync-overview-service
│   │   ├── llm/services/            # ollama-service, llm-provider, embedding-service,
│   │   │                            #   rag-service, llm-cache
│   │   └── knowledge/services/      # auto-tagger, quality-worker, summary-worker,
│   │                                #   version-tracker, duplicate-detector
│   ├── routes/
│   │   ├── foundation/              # health, auth, settings, admin
│   │   ├── confluence/              # spaces, sync, attachments
│   │   ├── llm/                     # llm-chat (SSE streaming), llm-conversations,
│   │   │                            #   llm-embeddings, llm-models, llm-admin
│   │   └── knowledge/               # pages-crud, pages-versions, pages-tags,
│   │                                #   pages-embeddings, pages-duplicates, pinned-pages,
│   │                                #   analytics, knowledge-admin
│   ├── app.ts                       # Fastify app builder + route registration
│   └── index.ts                     # Entry point + workers
├── frontend/src/
│   ├── features/         # Domain-grouped UI (dashboard, pages, ai-assistant, settings)
│   ├── shared/           # Reusable components, hooks, lib
│   │   └── components/   # Categorized: layout/, article/, diagrams/, badges/, feedback/, effects/
│   ├── stores/           # Zustand stores (auth, theme, ui, settings)
│   └── providers/        # Context providers (Query, Auth, Router)
├── packages/contracts/   # Shared Zod schemas + TypeScript types (@kb-creator/contracts)
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

- **Backend**: Fastify 5, TypeScript, PostgreSQL 17 (pgvector), Redis 8, `ollama` npm package, `jose` (JWT), `bcrypt`, `pg`, `undici`, `zod`, `pino`
- **Frontend**: React 19, Vite, TailwindCSS 4, Radix UI, Zustand, TanStack Query, Framer Motion, TipTap v3, Sonner
- **Content conversion**: `turndown` + `jsdom` + `turndown-plugin-gfm` (Confluence XHTML → Markdown), `marked` (Markdown → HTML)
- **RAG**: pgvector (HNSW index), `nomic-embed-text` embeddings via Ollama, hybrid search (vector + keyword)
- **Docker**: `pgvector/pgvector:pg17`, `redis:8-alpine`, multi-stage Dockerfiles

## External Services

| Service | Connection | Auth |
|---------|-----------|------|
| Confluence Data Center 9.2.15 | Per-user URL from `user_settings` | Bearer PAT (AES-256-GCM encrypted at rest) |
| Ollama | Shared server, `OLLAMA_BASE_URL` env var (default `http://localhost:11434`), `LLM_VERIFY_SSL` (default `true`) | Optional Bearer token via `LLM_BEARER_TOKEN` env var, `LLM_AUTH_TYPE` (`bearer`\|`none`, default `bearer`) |
| PostgreSQL | `POSTGRES_URL` env var | Password via env |
| Redis | `REDIS_URL` env var | Password via env |

## Security (Mandatory)

1. **PAT Encryption** — Confluence PATs are encrypted with AES-256-GCM using `PAT_ENCRYPTION_KEY` env var. Never store plaintext PATs. Never send PATs to the frontend.
2. **Zero Default Secrets** — Production (`NODE_ENV=production`) MUST fail to start if `JWT_SECRET` or `PAT_ENCRYPTION_KEY` is default or < 32 characters.
3. **LLM Safety** — All user content must be sanitized before sending to Ollama (prompt injection guard). Sanitize LLM output before displaying.
4. **Input Validation** — Use Zod schemas from `@kb-creator/contracts` on all API boundaries. Parameterized SQL only (no string concatenation).
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
- `POSTGRES_URL` (default: `postgresql://app_user:changeme@localhost:5432/kb_creator`)
- `REDIS_URL` (default: `redis://:changeme-redis@localhost:6379`)
- `REDIS_PASSWORD` (required)
- `OLLAMA_BASE_URL` (default: `http://localhost:11434`)
- `LLM_BEARER_TOKEN` (optional, Bearer token for authenticated Ollama/LLM proxies)
- `LLM_AUTH_TYPE` (optional, `bearer` or `none`, default: `bearer`)
- `LLM_VERIFY_SSL` (optional, set to `false` to disable TLS verification for LLM connections)
- `EMBEDDING_MODEL` (default: `nomic-embed-text`, server-wide, locked to 768 dims)
