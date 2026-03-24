# AtlasMind

<p align="center">
  <img src="frontend/public/logo.svg" alt="AtlasMind" width="128" height="128" />
</p>

[![Build](https://img.shields.io/badge/build-passing-brightgreen)]()
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)]()

AI-powered knowledge base management for **Confluence Data Center** with multi-provider LLM support (**Ollama**, **OpenAI-compatible APIs**). Sync your Confluence spaces, improve articles with AI, generate new content from templates, and ask questions across your entire knowledge base using RAG-powered semantic search.

---

## Key Features

- **Confluence Data Center integration** -- sync spaces, CRUD pages, bidirectional XHTML conversion (ac:\*/ri:\* macro support)
- **AI-powered article improvement** -- grammar, structure, clarity, technical accuracy, and completeness modes
- **Article generation from prompts** -- runbook, how-to, architecture, and troubleshooting templates
- **RAG-powered Q&A** -- ask questions over your entire knowledge base using pgvector hybrid search (vector cosine + full-text + RRF re-ranking)
- **Content summarization** -- generate concise summaries of long articles
- **Auto-tagging via LLM classification** -- automatic label suggestions based on content analysis
- **Duplicate page detection** -- find similar or duplicate content across spaces
- **Knowledge gap detection** -- identify missing documentation topics
- **Premium glassmorphic UI** -- dark mode, backdrop blur cards, animated gradient backgrounds, Framer Motion transitions
- **Multi-user with encrypted credentials** -- per-user Confluence PAT storage with AES-256-GCM encryption
- **Rich text editing** -- TipTap v3 editor with full Confluence macro round-trip support
- **Draw.io diagram display** -- read-only rendering of draw.io diagrams with "Edit in Confluence" links
- **Multi-provider LLM** -- Ollama (default) or OpenAI-compatible APIs (OpenAI, Azure, LM Studio, vLLM)
- **PDF import/export** -- extract content from PDFs, export pages as PDF
- **RBAC** -- role-based access control with granular permissions
- **OIDC/SSO** -- integrate with external identity providers (configured via Admin UI)
- **Page verification workflow** -- review and verify knowledge base articles
- **Knowledge requests** -- request new documentation topics, track knowledge gaps
- **Notifications** -- in-app notification system for updates and reviews
- **Content analytics** -- track page views, engagement, and search patterns
- **Knowledge graph** -- visual relationship map between pages
- **OpenTelemetry** -- optional distributed tracing support

## Screenshots

<!-- TODO: Add screenshots -->
<!-- ![Dashboard](docs/screenshots/dashboard.png) -->
<!-- ![AI Assistant](docs/screenshots/ai-assistant.png) -->
<!-- ![Page Editor](docs/screenshots/editor.png) -->

## Architecture

```
atlasmind/
+-- backend/src/
|   +-- core/                  # Shared infrastructure (no domain imports)
|   |   +-- db/                # PostgreSQL connection pool + SQL migrations (001-045)
|   |   +-- plugins/           # Fastify plugins (auth, correlation-id, redis)
|   |   +-- services/          # Cross-cutting services (redis-cache, audit, error-tracker,
|   |   |                      #   content-converter, circuit-breaker, pdf-service, oidc, rbac,
|   |   |                      #   notification-service, admin-settings-service, etc.)
|   |   +-- utils/             # crypto, logger, sanitize, ssrf-guard, tls/llm config
|   +-- domains/
|   |   +-- confluence/        # confluence-client, sync-service, attachment-handler
|   |   +-- llm/               # ollama-service, openai-service, llm-provider, embedding, rag, llm-cache
|   |   +-- knowledge/         # auto-tagger, quality-worker, summary-worker, duplicate-detector
|   +-- routes/
|   |   +-- foundation/        # health, auth, settings, admin, oidc, rbac, notifications
|   |   +-- confluence/        # spaces, sync, attachments
|   |   +-- llm/               # llm-chat (SSE), llm-conversations, llm-embeddings, llm-models, llm-admin, llm-pdf
|   |   +-- knowledge/         # pages-crud, pages-versions, pages-tags, pages-embeddings, pages-duplicates,
|   |                          #   pinned-pages, analytics, templates, comments, content-analytics,
|   |                          #   verification, knowledge-requests, search, pages-export, pages-import, local-spaces
+-- frontend/src/
|   +-- features/              # Domain-grouped UI (admin, ai, analytics, auth, dashboard, graph,
|   |                          #   knowledge-requests, pages, search, settings, spaces, templates)
|   +-- shared/                # Reusable components, hooks, lib
|   +-- stores/                # Zustand stores (auth, theme, ui, article-view, command-palette, keyboard-shortcuts)
|   +-- providers/             # Context providers (Query, Auth, Router)
+-- packages/contracts/        # Shared Zod schemas + TypeScript types (@atlasmind/contracts)
+-- docker/                    # Docker Compose files (dev + production)
+-- e2e/                       # Playwright E2E tests
+-- docs/                      # Architecture decisions, action plan
```

### Data Flow

```
Confluence Data Center (XHTML Storage Format)
    |  REST API v1 (Bearer PAT)
    v
Backend (Fastify 5)
    |-- Sync Service: polls Confluence via CQL, stores pages in PostgreSQL
    |-- Content Converter: XHTML <-> HTML <-> Markdown
    |-- Embedding Service: chunks text, generates embeddings via Ollama
    |-- RAG Service: hybrid search (pgvector + FTS), prompt building
    |-- Redis Cache: hot cache for page lists, search results (TTL 15min)
    v
Frontend (React 19 + Vite)
    |-- TipTap v3 Editor (HTML round-trip)
    |-- AI Assistant (SSE streaming for LLM responses)
    |-- Glassmorphic UI (TailwindCSS 4 + Radix UI + Framer Motion)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Fastify 5, TypeScript, Node.js 22+ |
| **Frontend** | React 19, Vite 7, TailwindCSS 4, Radix UI, Zustand, TanStack Query, Framer Motion |
| **Editor** | TipTap v3 (ProseMirror-based) |
| **Database** | PostgreSQL 17 with pgvector extension |
| **Cache** | Redis 8 |
| **AI/ML** | Ollama (local LLM server) + OpenAI-compatible APIs, nomic-embed-text embeddings (768 dims) |
| **PDF** | pdf-lib (export/import processing) |
| **Auth** | JWT (jose) + bcrypt, refresh token rotation |
| **Content** | turndown + jsdom (XHTML->Markdown), marked (Markdown->HTML) |
| **Validation** | Zod schemas shared via @atlasmind/contracts |
| **Infrastructure** | Docker Compose (4 services), multi-stage Dockerfiles |
| **Testing** | Vitest, Playwright, @testing-library/react |

## Prerequisites

- **Node.js** >= 22.0.0
- **PostgreSQL** 17 with [pgvector](https://github.com/pgvector/pgvector) extension
- **Redis** 8+
- **Ollama** ([ollama.com](https://ollama.com)) with at least one chat model pulled
- **Confluence Data Center** 9.x with a Personal Access Token (PAT)

Pull the required Ollama models before starting:

```bash
ollama pull nomic-embed-text   # Required for embeddings (768 dimensions)
ollama pull qwen3.5            # Or any chat model of your choice
```

## One-Command Installation (Docker)

Get from zero to the AtlasMind setup wizard in under 3 minutes — no cloning, no manual config:

```bash
curl -fsSL https://raw.githubusercontent.com/laboef1900/ai-kb-creator/main/scripts/install.sh | bash
```

### System requirements

- Docker Engine 24+ with Docker Compose v2 (`docker compose`, not `docker-compose`)
- 4 GB RAM available for containers
- Ports **8081** (frontend) free — the installer checks this before starting

### What the installer does

1. Generates cryptographically secure secrets (AES-256 keys, passwords)
2. Writes a self-contained `~/atlasmind/docker-compose.yml` with all secrets embedded as literal values
3. Pulls images from Docker Hub (`diinlu/atlasmind-backend`, `diinlu/atlasmind-frontend`)
4. Starts all four containers (frontend, backend, postgres, redis)
5. Polls the backend health endpoint until ready (up to 3 minutes)
6. Removes the temporary backend port binding (port 3051 is never permanently exposed to the host)
7. Opens the setup wizard in your default browser

### Custom install directory

```bash
INSTALL_DIR=~/mydir curl -fsSL https://raw.githubusercontent.com/laboef1900/ai-kb-creator/main/scripts/install.sh | bash
```

### Uninstall

```bash
bash ~/atlasmind/uninstall.sh
```

This stops all containers, removes all data volumes, and deletes the install directory.

### Image registries

Images are published to two registries on every release:

| Registry | Image |
|----------|-------|
| Docker Hub | `diinlu/atlasmind-backend:latest` · `diinlu/atlasmind-frontend:latest` |
| GHCR | `ghcr.io/laboef1900/atlasmind-backend:latest` · `ghcr.io/laboef1900/atlasmind-frontend:latest` |

Both registries publish `linux/amd64` and `linux/arm64` variants.

### Ollama requirement

AtlasMind uses Ollama for local LLM inference. Ollama must be running on your host machine **before** you start the containers. The installer defaults to `http://host.docker.internal:11434`; override with:

```bash
OLLAMA_BASE_URL=http://my-ollama-host:11434 curl -fsSL ... | bash
```

Pull the required models before or after installation:

```bash
ollama pull nomic-embed-text   # Required for RAG embeddings (768 dimensions)
ollama pull qwen3:4b           # Or any chat model of your choice
```

---

## Developer Quick Start

### 1. Clone and install

```bash
git clone https://github.com/your-org/atlasmind.git
cd atlasmind
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set your secrets:

```bash
# REQUIRED: Change these to random 32+ character strings
JWT_SECRET=your-random-secret-at-least-32-characters
PAT_ENCRYPTION_KEY=your-random-key-at-least-32-characters

# PostgreSQL
POSTGRES_USER=kb_user
POSTGRES_PASSWORD=your-postgres-password
POSTGRES_DB=kb_creator
POSTGRES_URL=postgresql://kb_user:your-postgres-password@localhost:5432/kb_creator

# Redis
REDIS_PASSWORD=your-redis-password
REDIS_URL=redis://:your-redis-password@localhost:6379

# Ollama (default: local server)
OLLAMA_BASE_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text
```

### 3. Start infrastructure services

Using the development Docker Compose:

```bash
docker compose -f docker/docker-compose.dev.yml up -d
```

This starts PostgreSQL (with pgvector) and Redis. Ollama runs on your host machine.

### 4. Start development servers

```bash
npm run dev
```

This starts both backend (port 3051) and frontend (port 5273) with hot reload.

### 5. Create your account

Open http://localhost:5273 and register. The first user automatically gets admin role. Then configure your Confluence URL and PAT in Settings.

## Docker Deployment

For production deployment with all services:

```bash
# Create .env with production secrets (see Configuration section)
docker compose -f docker/docker-compose.yml up -d
```

The production `docker/docker-compose.yml` runs 4 services:
- **frontend** -- nginx serving the built React app (port 8081)
- **backend** -- Node.js Fastify server (port 3051, internal)
- **postgres** -- PostgreSQL 17 with pgvector (`pgvector/pgvector:pg17`)
- **redis** -- Redis 8 Alpine with password auth and LRU eviction

Ollama is expected to run on the host machine. The backend connects via `OLLAMA_BASE_URL` (defaults to `http://host.docker.internal:11434` in Docker).

## Configuration

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `JWT_SECRET` | -- | Yes | JWT signing secret (32+ characters, must not be default in production) |
| `PAT_ENCRYPTION_KEY` | -- | Yes | AES-256-GCM key for encrypting Confluence PATs (32+ characters) |
| `POSTGRES_USER` | `kb_user` | No | PostgreSQL username |
| `POSTGRES_PASSWORD` | `changeme-postgres` | No | PostgreSQL password |
| `POSTGRES_DB` | `kb_creator` | No | PostgreSQL database name |
| `POSTGRES_URL` | `postgresql://kb_user:changeme-postgres@localhost:5432/kb_creator` | No | Full PostgreSQL connection string |
| `POSTGRES_TEST_URL` | `postgresql://kb_user:changeme-postgres@localhost:5433/kb_creator_test` | No | Test database (port 5433) |
| `REDIS_PASSWORD` | `changeme-redis` | Yes | Redis password |
| `REDIS_URL` | `redis://:changeme-redis@localhost:6379` | No | Full Redis connection string |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | No | Ollama server URL |
| `EMBEDDING_MODEL` | `nomic-embed-text` | No | Server-wide embedding model (locked to 768 dimensions) |
| `NODE_ENV` | `development` | No | Environment (`development` or `production`) |
| `BACKEND_PORT` | `3051` | No | Backend server port |
| `FRONTEND_PORT` | `5273` | No | Frontend dev server port |
| `LLM_PROVIDER` | `ollama` | No | LLM provider: `ollama` or `openai` (server-wide default) |
| `LLM_BEARER_TOKEN` | -- | No | Bearer token for authenticated Ollama/LLM proxies |
| `LLM_AUTH_TYPE` | `bearer` | No | Auth type for LLM connections: `bearer` or `none` |
| `LLM_VERIFY_SSL` | `true` | No | Set to `false` to disable TLS verification for LLM |
| `LLM_STREAM_TIMEOUT_MS` | `300000` | No | Streaming request timeout in ms |
| `LLM_CACHE_TTL` | `3600` | No | Redis TTL (seconds) for LLM response cache |
| `OPENAI_BASE_URL` | -- | No | OpenAI-compatible API base URL |
| `OPENAI_API_KEY` | -- | No | API key (required when using openai provider) |
| `DEFAULT_LLM_MODEL` | -- | No | Fallback model for background workers |
| `SYNC_INTERVAL_MIN` | `15` | No | Sync scheduler polling interval (minutes) |
| `CONFLUENCE_VERIFY_SSL` | `true` | No | Set to `false` for self-signed Confluence certs |
| `ATTACHMENTS_DIR` | `data/attachments` | No | Attachment cache directory |
| `NODE_EXTRA_CA_CERTS` | -- | No | PEM CA bundle path for self-signed certificates |
| `OTEL_ENABLED` | `false` | No | Set to `true` for OpenTelemetry tracing |
| `OTEL_SERVICE_NAME` | `atlasmind-backend` | No | Service name for OTLP collector |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | -- | No | OTLP collector endpoint |

## API Documentation

The backend serves interactive API documentation via Swagger UI at:

```
http://localhost:3051/api/docs
```

### Key API Groups

| Prefix | Description |
|--------|-------------|
| `GET /api/health` | Health checks (live, ready, start probes) |
| `POST /api/auth/*` | Authentication (register, login, refresh, logout) |
| `GET/PUT /api/settings` | User settings (Confluence URL, PAT, model selection) |
| `GET/POST/PUT/DELETE /api/pages/*` | Page CRUD, versions, tags, embeddings, duplicates, export/import |
| `GET /api/spaces` | Confluence space listing and selection |
| `POST /api/sync` | Manual sync trigger |
| `POST /api/llm/*` | LLM operations (improve, generate, summarize, ask, PDF extract) |
| `GET /api/embeddings/status` | Embedding pipeline status |
| `GET/POST /api/templates/*` | Knowledge base templates |
| `GET/POST /api/comments/*` | Page comments |
| `GET /api/analytics/*` | Content analytics and search analytics |
| `GET/POST /api/verification/*` | Page verification/review workflow |
| `GET/POST /api/knowledge-requests/*` | Knowledge gap requests |
| `GET/POST /api/notifications/*` | User notifications |
| `GET/POST /api/admin/*` | Admin operations (key rotation, audit log, LLM settings, OIDC, RBAC) |

All endpoints except `/api/health` and `/api/auth/*` require a valid JWT Bearer token.

## Development

### Testing

```bash
# Run all tests (contracts + backend + frontend)
npm test

# Backend tests only (uses real PostgreSQL on port 5433)
npm run test -w backend

# Frontend tests only (jsdom environment)
npm run test -w frontend

# Single test file
cd backend && npx vitest run src/path/file.test.ts

# E2E tests (requires running backend + frontend)
npm run test:e2e
```

Backend tests use a real PostgreSQL database (port 5433, configured via `POSTGRES_TEST_URL`). Only external API calls (Confluence, Ollama) are mocked in tests.

### Linting and Type Checking

```bash
npm run lint        # ESLint across all workspaces
npm run typecheck   # TypeScript strict mode check
```

### Project Structure

- **Backend routes** are in `backend/src/routes/` -- grouped by domain (foundation, confluence, llm, knowledge)
- **Core services** are in `backend/src/core/services/` -- cross-cutting infrastructure
- **Domain services** are in `backend/src/domains/` -- domain-specific business logic (confluence, llm, knowledge)
- **Database migrations** are in `backend/src/core/db/migrations/` -- sequential SQL files (001-045), auto-run on startup
- **Frontend features** are in `frontend/src/features/` -- domain-grouped UI (12 feature domains)
- **Shared hooks** are in `frontend/src/shared/hooks/` -- TanStack Query hooks
- **Shared contracts** are in `packages/contracts/` -- Zod schemas used by both backend and frontend

### Docker Development Environment

```bash
# Start PostgreSQL + Redis for local development
docker compose -f docker/docker-compose.dev.yml up -d

# View logs
docker compose -f docker/docker-compose.dev.yml logs -f
```

## Security

- **PAT Encryption** -- Confluence Personal Access Tokens are encrypted at rest with AES-256-GCM using a per-server encryption key. PATs are never sent to the frontend.
- **JWT Authentication** -- Access tokens (15min) + refresh tokens (7 days) with rotation and family-based revocation for reuse detection.
- **Password Hashing** -- bcrypt with 12 salt rounds.
- **Input Validation** -- Zod schemas on all API boundaries. Parameterized SQL only (no string concatenation).
- **Rate Limiting** -- Global rate limiting (100 req/min) with stricter limits on admin and LLM endpoints.
- **SSRF Protection** -- Confluence URLs are validated and restricted to user-configured endpoints.
- **Prompt Injection Guard** -- User content is sanitized before sending to Ollama. LLM output is sanitized before display.
- **Production Secrets** -- Server refuses to start if `JWT_SECRET` or `PAT_ENCRYPTION_KEY` is default or under 32 characters in production mode.
- **Infrastructure Isolation** -- Internal services (PostgreSQL, Redis) are not exposed on public interfaces in Docker.

## Contributing

1. Branch from `dev` as `feature/<description>` -- PRs must target `dev`, never `main` directly
2. Only `dev -> main` merges are allowed to target `main`
3. Every change needs tests (backend: `*.test.ts`, frontend: `*.test.tsx`)
4. Never commit secrets (`.env`, API keys, PATs, passwords)
5. Follow the architectural decisions in `docs/ARCHITECTURE-DECISIONS.md`
6. Run `npm test`, `npm run lint`, and `npm run typecheck` before submitting
7. Keep commits concise -- describe "why", not "what"

