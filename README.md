# AtlasMind

<p align="center">
  <img src="frontend/public/logo.svg" alt="AtlasMind" width="128" height="128" />
</p>

[![Build](https://img.shields.io/badge/build-passing-brightgreen)]()
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)]()

AI-powered knowledge base management for **Confluence Data Center** with local **Ollama** LLM integration. Sync your Confluence spaces, improve articles with AI, generate new content from templates, and ask questions across your entire knowledge base using RAG-powered semantic search.

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

## Screenshots

<!-- TODO: Add screenshots -->
<!-- ![Dashboard](docs/screenshots/dashboard.png) -->
<!-- ![AI Assistant](docs/screenshots/ai-assistant.png) -->
<!-- ![Page Editor](docs/screenshots/editor.png) -->

## Architecture

```
atlasmind/
+-- backend/               # Fastify 5 REST API server
|   +-- src/
|       +-- plugins/       # Fastify plugins (auth, cors, rate-limit, swagger)
|       +-- routes/        # REST API routes (auth, pages, spaces, llm, settings, sync, admin)
|       +-- services/      # Business logic (confluence-client, ollama, embedding, rag, sync)
|       +-- db/            # PostgreSQL connection + SQL migrations
|       +-- utils/         # Logger, crypto helpers
+-- frontend/              # React 19 SPA
|   +-- src/
|       +-- features/      # Domain-grouped UI (dashboard, pages, ai-assistant, settings)
|       +-- shared/        # Reusable components, hooks, lib
|       +-- stores/        # Zustand stores (auth, theme, ui)
|       +-- providers/     # Context providers (Query, Auth, Router)
+-- packages/
|   +-- contracts/         # Shared Zod schemas + TypeScript types (@atlasmind/contracts)
+-- docker/                # Docker Compose files (dev + production)
+-- e2e/                   # Playwright E2E tests
+-- docs/                  # Architecture decisions, action plan
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
| **AI/ML** | Ollama (local LLM server), nomic-embed-text embeddings (768 dimensions) |
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

## Quick Start

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
| `GET/POST/PUT/DELETE /api/pages/*` | Page CRUD with Confluence sync |
| `GET /api/spaces` | Confluence space listing and selection |
| `POST /api/sync` | Manual sync trigger |
| `POST /api/llm/*` | LLM operations (improve, generate, summarize, ask) |
| `GET /api/embeddings/status` | Embedding pipeline status |
| `POST /api/admin/*` | Admin operations (key rotation, audit log) |

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

- **Backend routes** are in `backend/src/routes/` -- one file per domain
- **Backend services** are in `backend/src/services/` -- business logic
- **Database migrations** are in `backend/src/db/migrations/` -- sequential SQL files, auto-run on startup
- **Frontend features** are in `frontend/src/features/` -- domain-grouped UI components
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

1. Branch from `main` as `feature/<description>`
2. Every change needs tests (backend: `*.test.ts`, frontend: `*.test.tsx`)
3. Never push directly to `main` -- open a PR from your feature branch
4. Never commit secrets (`.env`, API keys, PATs, passwords)
5. Follow the architectural decisions in `docs/ARCHITECTURE-DECISIONS.md`
6. Run `npm test`, `npm run lint`, and `npm run typecheck` before submitting
7. Keep commits concise -- describe "why", not "what"

