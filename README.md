<p align="center">
  <img src="frontend/public/logo.svg" alt="Compendiq" width="96" height="96" />
</p>

<h1 align="center">Compendiq</h1>

<p align="center">
  <strong>Open-source AI knowledge base for Confluence Data Center</strong><br>
  Self-hosted. On-premise. Your data never leaves your network.
</p>

<p align="center">
  <a href="https://github.com/Compendiq/compendiq-ce/actions/workflows/pr-check.yml"><img src="https://github.com/Compendiq/compendiq-ce/actions/workflows/pr-check.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
  <a href="https://github.com/Compendiq/compendiq-ce/releases"><img src="https://img.shields.io/github/v/release/Compendiq/compendiq-ce?label=Release" alt="Release" /></a>
  <a href="https://github.com/Compendiq/compendiq-ce/discussions"><img src="https://img.shields.io/github/discussions/Compendiq/compendiq-ce?label=Discussions" alt="Discussions" /></a>
</p>

<p align="center">
  <a href="#install-in-3-minutes">Install</a> &middot;
  <a href="#what-it-does">Features</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="docs/USER-GUIDE.md">Docs</a> &middot;
  <a href="https://github.com/Compendiq/compendiq-ce/discussions">Community</a> &middot;
  <a href="SECURITY.md">Security</a>
</p>

---

Compendiq connects to your **Confluence Data Center** instance, syncs your pages, and gives you AI superpowers: ask questions across your entire knowledge base, improve articles with one click, generate new documentation from templates, and detect knowledge gaps -- all running on hardware you control.

**Why this exists:** Confluence Data Center has no native AI features. Cloud-only AI tools don't work for on-premise deployments. Compendiq fills that gap without sending a single byte to external servers (when using Ollama for local inference).

<!-- TODO: Screenshots — uncomment when assets are captured
<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Dashboard with glassmorphic UI" width="800" />
</p>
-->

## Install in 3 Minutes

From zero to setup wizard with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash
```

**Requirements:** Docker Engine 24+ with Compose v2, 4 GB RAM, port 8081 free.

The installer generates cryptographic secrets, pulls images from GHCR, starts the stack (frontend, backend, PostgreSQL, Redis), and opens the setup wizard in your browser. Ollama must be running on the host for local AI inference.

<details>
<summary><strong>What the installer does (step by step)</strong></summary>

1. Generates `JWT_SECRET` and `PAT_ENCRYPTION_KEY` (AES-256, 32+ chars)
2. Writes `~/compendiq/docker-compose.yml` with all secrets embedded
3. Pulls images from `ghcr.io/compendiq/compendiq-ce-*`
4. Starts 4 containers: frontend (nginx), backend (Fastify), PostgreSQL 17 (pgvector), Redis 8
5. Waits for the health endpoint (up to 3 min)
6. Opens `http://localhost:8081` -- the first-run wizard

</details>

<details>
<summary><strong>Custom install directory / Ollama URL</strong></summary>

```bash
# Custom install location
INSTALL_DIR=~/mydir curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash

# Remote Ollama instance
OLLAMA_BASE_URL=http://my-gpu-server:11434 curl -fsSL ... | bash
```

</details>

<details>
<summary><strong>Uninstall</strong></summary>

```bash
bash ~/compendiq/uninstall.sh
```

Stops containers, removes volumes, deletes the install directory.

</details>

### Pull the models

Compendiq needs an embedding model and a chat model:

```bash
ollama pull bge-m3          # Required: embeddings (1024 dimensions)
ollama pull qwen3:4b        # Or any chat model you prefer
```

---

## What It Does

### AI-Powered Q&A Across Your Knowledge Base

Ask questions in natural language and get answers sourced from your Confluence pages. Powered by RAG with pgvector hybrid search (vector cosine similarity + full-text keyword search + Reciprocal Rank Fusion).

<!-- TODO: Screenshot of RAG Q&A with citations -->

### One-Click Article Improvement

Select an article and improve it for grammar, structure, clarity, technical accuracy, or completeness. Generate new articles from templates (runbook, how-to, architecture, troubleshooting). Summarize long documents. Auto-tag pages with LLM classification.

<!-- TODO: Screenshot of article improvement panel -->

### Full Confluence Data Center Integration

Bidirectional sync with XHTML storage format conversion. Round-trip support for Confluence macros: code blocks, task lists, panels, user mentions, page links, draw.io diagrams (read-only rendering), Children Pages (expandable inline), and Attachments with download links.

<!-- TODO: Screenshot of editor with Confluence macros -->

### More Features

| Category | What you get |
|----------|-------------|
| **Editor** | TipTap v3 with Vim mode, drag-and-drop blocks, find-and-replace, image/table captions, header numbering, code block language detection, clipboard image paste |
| **AI** | Multi-provider LLM (Ollama default, or any OpenAI-compatible API), real-time SSE streaming, conversation history, content summarization, knowledge gap detection, duplicate page detection, LLM request backpressure, audit hook extension point |
| **Security** | AES-256-GCM PAT encryption, JWT with refresh token rotation, RBAC with custom roles, OIDC/SSO (Enterprise), rate limiting, SSRF protection, prompt injection guard |
| **Analytics** | Page views, engagement metrics, search pattern tracking, knowledge graph visualization |
| **Operations** | PDF import/export, page verification workflow, knowledge requests, audit logging, OpenTelemetry tracing, background job queue (BullMQ), email notifications (SMTP), Confluence API rate limiting |

---

## Architecture

```
Confluence Data Center (XHTML Storage Format)
    |  REST API v1 (Bearer PAT)
    v
Backend (Fastify 5 + TypeScript + Node.js 22)
    |-- Queue Service ........... BullMQ job queues (sync, quality, summary, maintenance)
    |-- Sync Service ............ polls Confluence, stores in PostgreSQL
    |-- Content Converter ....... XHTML <-> HTML <-> Markdown
    |-- Embedding Service ....... chunks text, generates vectors via Ollama
    |-- RAG Service ............. hybrid search (pgvector + FTS + RRF)
    |-- LLM Queue ............... backpressure + concurrency control for LLM calls
    |-- Email Service ........... SMTP notifications via Nodemailer
    |-- Redis Cache ............. hot cache with TTL eviction
    v
Frontend (React 19 + Vite + TailwindCSS 4)
    |-- TipTap v3 Editor (HTML round-trip with Confluence macros)
    |-- AI Assistant (SSE streaming)
    |-- Glassmorphic UI (Radix UI + Framer Motion)
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Fastify 5, TypeScript, Node.js 22+, BullMQ |
| **Frontend** | React 19, Vite 7, TailwindCSS 4, Radix UI, Zustand, TanStack Query, Framer Motion |
| **Editor** | TipTap v3 (ProseMirror) |
| **Database** | PostgreSQL 17 + pgvector |
| **Cache** | Redis 8 |
| **AI/ML** | Ollama (local) or OpenAI-compatible APIs, bge-m3 embeddings (1024 dims) |
| **Auth** | JWT (jose) + bcrypt + optional OIDC/SSO |
| **Validation** | Zod schemas shared via @compendiq/contracts |
| **Job Queue** | BullMQ (Redis-backed), with setInterval fallback |
| **Testing** | Vitest, Playwright, @testing-library/react |
| **Infra** | Docker Compose (4+ services), multi-stage Dockerfiles, GHCR |

### Data Flow

Confluence pages are synced over REST, converted from XHTML to HTML and Markdown, chunked and embedded for vector search, then served through a React frontend with a real-time AI chat interface. Every LLM call streams via Server-Sent Events. All data stays in your PostgreSQL database on your hardware.

---

## Community Edition vs Enterprise

Compendiq is open-core. The Community Edition (this repo) is fully functional under AGPL-3.0 with **no artificial limits**.

| Feature | Community (free) | Enterprise (paid) |
|---------|:---:|:---:|
| Confluence sync + AI Q&A + article generation | Yes | Yes |
| RAG search (vector + keyword + hybrid) | Yes | Yes |
| Multi-provider LLM (Ollama, OpenAI, Azure, vLLM) | Yes | Yes |
| Rich text editor with Confluence macros | Yes | Yes |
| PDF import/export | Yes | Yes |
| RBAC with custom roles | Yes | Yes |
| Audit logging | Yes | Yes |
| OIDC/SSO | -- | Yes |
| Per-space RAG permissions | -- | Yes |
| Audit log export | -- | Yes |
| Priority support | -- | Yes |

Interested in Enterprise? [Open an issue](https://github.com/Compendiq/compendiq-ce/issues/new?template=enterprise-interest.md) or reach out via [GitHub Discussions](https://github.com/Compendiq/compendiq-ce/discussions).

---

## Developer Quick Start

<details>
<summary><strong>Full local development setup</strong></summary>

### 1. Clone and install

```bash
git clone https://github.com/Compendiq/compendiq-ce.git
cd compendiq-ce
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env -- set JWT_SECRET and PAT_ENCRYPTION_KEY to random 32+ char strings
```

### 3. Start infrastructure

```bash
docker compose -f docker/docker-compose.yml up -d   # PostgreSQL + Redis
```

### 4. Start dev servers

```bash
npm run dev   # Backend (3051) + Frontend (5273) with hot reload
```

### 5. Create your account

Open http://localhost:5273. First user gets admin role. Configure Confluence URL and PAT in Settings.

</details>

<details>
<summary><strong>Running tests</strong></summary>

```bash
npm test                          # All tests (contracts + backend + frontend)
npm run test -w backend           # Backend only (needs PostgreSQL on port 5433)
npm run test -w frontend          # Frontend only (jsdom)
npm run test:e2e                  # E2E (Playwright, needs running servers)
npm run lint                      # ESLint
npm run typecheck                 # TypeScript strict mode
```

</details>

---

## Configuration

All configuration is via environment variables. Key settings:

| Variable | Required | Description |
|----------|:---:|-------------|
| `JWT_SECRET` | Yes | JWT signing secret (32+ characters) |
| `PAT_ENCRYPTION_KEY` | Yes | AES-256-GCM key for Confluence PATs (32+ characters) |
| `OLLAMA_BASE_URL` | -- | Ollama server URL (default: `http://localhost:11434`) |
| `EMBEDDING_MODEL` | -- | Embedding model (default: `bge-m3`) |
| `LLM_PROVIDER` | -- | `ollama` (default) or `openai` |
| `OPENAI_BASE_URL` | -- | OpenAI-compatible API URL (for Azure, LM Studio, vLLM, etc.) |
| `OPENAI_API_KEY` | -- | API key when using OpenAI provider |
| `POSTGRES_URL` | -- | PostgreSQL connection string |
| `REDIS_URL` | -- | Redis connection string |

<details>
<summary><strong>Full configuration reference</strong></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | -- | JWT signing secret (32+ chars, must not be default in production) |
| `PAT_ENCRYPTION_KEY` | -- | AES-256-GCM key for encrypting Confluence PATs (32+ chars) |
| `POSTGRES_USER` | `kb_user` | PostgreSQL username |
| `POSTGRES_PASSWORD` | `changeme-postgres` | PostgreSQL password |
| `POSTGRES_DB` | `kb_creator` | PostgreSQL database name |
| `POSTGRES_URL` | `postgresql://kb_user:changeme-postgres@localhost:5432/kb_creator` | Full connection string |
| `REDIS_PASSWORD` | `changeme-redis` | Redis password |
| `REDIS_URL` | `redis://:changeme-redis@localhost:6379` | Full Redis connection string |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `EMBEDDING_MODEL` | `bge-m3` | Server-wide embedding model (1024 dimensions) |
| `LLM_PROVIDER` | `ollama` | LLM provider: `ollama` or `openai` |
| `LLM_BEARER_TOKEN` | -- | Bearer token for authenticated Ollama/LLM proxies |
| `LLM_VERIFY_SSL` | `true` | Set to `false` for self-signed LLM certs |
| `LLM_STREAM_TIMEOUT_MS` | `300000` | Streaming request timeout (ms) |
| `LLM_CACHE_TTL` | `3600` | Redis TTL for LLM cache (seconds) |
| `OPENAI_BASE_URL` | -- | OpenAI-compatible API base URL |
| `OPENAI_API_KEY` | -- | API key (required with openai provider) |
| `DEFAULT_LLM_MODEL` | -- | Fallback model for background workers |
| `SYNC_INTERVAL_MIN` | `15` | Confluence sync polling interval (minutes) |
| `CONFLUENCE_VERIFY_SSL` | `true` | Set to `false` for self-signed Confluence certs |
| `NODE_ENV` | `development` | `development` or `production` |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry tracing |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | -- | OTLP collector endpoint |

</details>

---

## API

Interactive API documentation is available at `/api/docs` (Swagger UI) when the backend is running.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health checks (live, ready, start probes) |
| `POST /api/auth/*` | Register, login, refresh, logout |
| `GET/POST/PUT/DELETE /api/pages/*` | Page CRUD, versions, tags, embeddings, duplicates |
| `POST /api/llm/*` | AI operations (improve, generate, summarize, ask, chat) |
| `POST /api/sync` | Manual Confluence sync |
| `GET /api/search` | Keyword, semantic, and hybrid search |
| `GET/POST /api/admin/*` | Admin settings, audit log, RBAC, LLM config |

All endpoints except `/api/health` and `/api/auth/*` require a JWT Bearer token.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

**Quick version:** branch from `dev` as `feature/<description>`, add tests, run `npm test && npm run lint && npm run typecheck`, open a PR to `dev`.

## Security

Found a vulnerability? Report it via [GitHub Security Advisories](https://github.com/Compendiq/compendiq-ce/security/advisories/new) (private channel). Do not open a public issue. See [SECURITY.md](SECURITY.md) for details.

## License

[GNU Affero General Public License v3.0](LICENSE)

---

<p align="center">
  Built by a solo developer in Europe. If Compendiq saves your team time, <a href="https://github.com/Compendiq/compendiq-ce">star the repo</a> -- it helps others find it.
</p>
