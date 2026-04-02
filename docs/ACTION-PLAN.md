# Compendiq - Action Plan

> All technical decisions reference [ARCHITECTURE-DECISIONS.md](./ARCHITECTURE-DECISIONS.md).
> ADR numbers (e.g. ADR-004) link to the corresponding decision record.

## Vision
Web interface for managing Confluence knowledge base articles, enhanced with a local Ollama LLM backend for content improvement, generation, summarization, and RAG-powered Q&A.

## Scale Assumptions
- ~1000 articles across multiple spaces, ~100 employees using Confluence
- 4 initial users of this app, scaling to ~15
- Shared Ollama server (ADR-015), not per-user

## Tech Stack (ADR-001, ADR-002, ADR-008)
- **Backend**: Fastify 5 + TypeScript + PostgreSQL (pgvector) + Redis + Ollama SDK
- **Frontend**: React 19 + Vite + TailwindCSS 4 + Radix UI + Zustand + TanStack Query
- **Editor**: TipTap v3 (ADR-002)
- **Auth**: JWT (jose) + bcrypt, per-user encrypted PAT storage (ADR-007)
- **RAG**: pgvector + bge-m3 (1024 dims, server-wide) + hybrid search (ADR-012)
- **LLM Streaming**: SSE via fetch (ADR-005)
- **Deployment**: Docker Compose - 4 services (ADR-011)
- **Testing**: Vitest + Playwright
- **UI Style**: Glassmorphic/premium (ADR-010)

## Architecture Overview (ADR-001, ADR-004)

```
[Browser] <-> [Frontend (React 19 + Vite)]
                    |
              [Backend (Fastify 5)]
              /       |        |         \
    [PostgreSQL]  [Redis]  [Ollama]  [Confluence REST API]
     + pgvector   (hot      - chat     - /rest/api/content
     - articles    cache)   - embed    - /rest/api/space
     - embeddings - pages   - models   - /rest/api/content/search
     - users      - search             - attachments (draw.io)
     - settings   - TTL                - Auth: Bearer PAT
     - history
```

### Backend Directory Structure (PR #334)

```
backend/src/
├── core/                        # Shared infrastructure (no domain imports)
│   ├── db/postgres.ts           # Connection pool + migration runner
│   ├── db/migrations/           # Sequential SQL files (001-026)
│   ├── plugins/                 # Fastify plugins (auth, cors, rate-limit, redis)
│   ├── services/                # redis-cache, audit, error-tracker, content-converter,
│   │                            #   circuit-breaker, image-references
│   └── utils/                   # crypto, logger, sanitize, ssrf-guard, tls/llm config
├── domains/
│   ├── confluence/services/     # confluence-client, sync-service, attachment-handler,
│   │                            #   subpage-context, sync-overview-service
│   ├── llm/services/            # ollama-service, llm-provider, embedding-service,
│   │                            #   rag-service, llm-cache
│   └── knowledge/services/      # auto-tagger, quality-worker, summary-worker,
│                                #   version-tracker, duplicate-detector
├── routes/
│   ├── foundation/              # health, auth, settings, admin
│   ├── confluence/              # spaces, sync, attachments
│   ├── llm/                     # llm-chat (SSE), llm-conversations, llm-embeddings,
│   │                            #   llm-models, llm-admin
│   └── knowledge/               # pages-crud, pages-versions, pages-tags, pages-embeddings,
│                                #   pages-duplicates, pinned-pages, analytics, knowledge-admin
├── app.ts                       # Fastify app builder + route registration
└── index.ts                     # Entry point + background workers
```

**Domain boundary rules** (ESLint-enforced via `eslint-plugin-boundaries`):
- `core` → no domain or route imports
- `confluence` → core + llm (for sync-embedding)
- `llm` → core only
- `knowledge` → core + llm + confluence
- Routes → core + own domain (knowledge routes can access all domains)

## Database Schema (ADR-006)

26 migration files (001-026):
- **001_extensions**: pgvector + pg_trgm
- **002_users**: id, username, password_hash
- **003_user_settings**: confluence_url, confluence_pat (encrypted), selected_spaces[], ollama_model
- **004_cached_spaces**: space_key, space_name, user_id, last_synced
- **005_cached_pages**: confluence_id, space_key, title, body_storage (XHTML), body_html (clean), body_text (plain), embedding_dirty flag
- **006_page_embeddings**: chunk_text, embedding vector(1024), metadata JSONB, HNSW index
- **007_llm_conversations**: user_id, page_id, model, messages JSONB
- **008_llm_improvements**: confluence_id, improvement_type, original/improved content, status
- **009_refresh_tokens**: refresh token rotation (ADR-007)
- **010_audit_log**: audit trail for user actions
- **011_hnsw_tuning**: HNSW index parameter tuning
- **012_error_log**: automated error tracking
- **013_search_analytics**: search query analytics
- **014_page_versions**: version history snapshots
- **015_show_space_home_content**: user setting for space home visibility
- **016_llm_provider_settings**: multi-provider LLM support (ollama/openai)
- **017_embedding_status**: 4-state embedding model (not_embedded/embedding/embedded/failed)
- **018_pinned_pages**: user pinned articles
- **019_embedding_error**: error message storage for failed embeddings
- **020_page_relationships**: knowledge graph relationships (similarity, links, labels)
- **021_add_performance_indexes**: composite indexes for common queries
- **022_embedding_chunk_settings**: configurable chunk size/overlap
- **023_shared_tables**: user_space_selections shared table
- **024_custom_prompts**: user-defined LLM system prompts
- **025_quality_scores**: page quality analysis results
- **026_article_summaries**: auto-generated article summaries

Full schema in ADR-006.

---

## Phase 0: Verification Spike (Before Any App Code)
> References: ADR-003 (content pipeline), ADR-013 (draw.io)
>
> **This phase exists because the critic review identified the content converter as the highest-risk
> component. Everything in Phases 3-5 depends on this working correctly.**

### 0.1 Confluence API Verification
- [ ] Test real DC 9.2.15 REST API with a PAT against your instance:
  - `GET /rest/api/content?spaceKey=X&limit=10` — verify pagination uses `start`/`limit` (not cursor)
  - `GET /rest/api/content/{id}?expand=body.storage,version,ancestors` — get a page with XHTML body
  - `GET /rest/api/content/search?cql=lastmodified>"2024-01-01"` — verify CQL delta sync
  - `GET /rest/api/content/{id}/child/attachment` — verify draw.io attachments are accessible
  - `POST /rest/api/content` — verify page creation with storage format body
- [ ] Save 10-20 representative page XHTML bodies as test fixtures in `backend/src/core/services/__fixtures__/`
- [ ] Document any deviations from API docs (pagination behavior, field names, error formats)

### 0.2 Content Converter Spike
- [ ] Implement `content-converter.ts` with turndown + jsdom + custom rules
- [ ] Test `confluenceToHtml()` against all saved fixtures — verify every macro type present in your instance
- [ ] Test `htmlToConfluence()` round-trip: load XHTML → convert to HTML → convert back → compare
- [ ] **Identify lossy macros**: which macros lose data in the round-trip? Document them.
- [ ] Decision: for lossy macros, either (a) preserve them as opaque blocks that pass through untouched, or (b) show them as read-only placeholders in the editor
- [ ] Test `htmlToMarkdown()` output quality — is it good enough for LLM consumption?
- [ ] Write unit tests for every conversion path with the real fixtures

### 0.3 Results Gate
- [ ] If round-trip is clean for >90% of pages → proceed to Phase 1
- [ ] If significant data loss → redesign the editor approach (e.g., read-only viewer + markdown editor for AI, no XHTML write-back)

---

## Phase 1: Project Scaffolding (Foundation)
> References: ADR-001 (structure), ADR-008 (flat architecture), ADR-011 (Docker)

### 1.1 Monorepo Setup
- [ ] Initialize npm workspaces: root `package.json` with `backend/`, `frontend/`, `packages/contracts/`
- [ ] Root TypeScript config with project references
- [ ] Shared ESLint config (flat config, same pattern as reference project)
- [ ] `.gitignore`, `.env.example`, `.dockerignore`, `.claudeignore`
- [ ] `.npmrc` (engine-strict), `.nvmrc` (Node 22)

### 1.2 Backend Skeleton
- [ ] Fastify 5 + TypeScript setup with `tsx` for dev
- [ ] Plugin architecture: cors, jwt, rate-limit, swagger, compress
- [ ] PostgreSQL connection pool (`pg`) + pgvector setup
- [ ] Redis connection (`redis` package)
- [ ] Database migration system (SQL files + `_migrations` tracking table) — same pattern as reference project
- [ ] Run migrations 001-003 (extensions, users, user_settings)
- [ ] Health check endpoint (`GET /api/health`) — checks PG + Redis + Ollama
- [ ] Pino logger with pino-pretty for dev
- [ ] Zod for request/response validation (from `@compendiq/contracts`)

### 1.3 Shared Contracts Package
- [ ] `packages/contracts/` with Zod schemas for API request/response types
- [ ] Shared TypeScript interfaces (User, Page, Space, Settings, LLM types)
- [ ] Export as `@compendiq/contracts`

### 1.4 Frontend Skeleton
- [ ] React 19 + Vite + TailwindCSS 4
- [ ] Radix UI primitives setup (Dialog, Select, Tabs, Tooltip, ScrollArea, Switch, etc.)
- [ ] Zustand store skeleton (auth, settings, ui, theme)
- [ ] TanStack Query provider
- [ ] React Router with layout structure (app shell: sidebar + main)
- [ ] Glassmorphic theme foundation (CSS variables, backdrop-blur cards, gradient mesh background) — ADR-010
- [ ] Framer Motion (LazyMotion with domAnimation)
- [ ] Sonner for toast notifications

### 1.5 Test Infrastructure
- [ ] `docker/docker-compose.test.yml`: PostgreSQL on port 5433 for test isolation
- [ ] `backend/src/test-db-helper.ts`: connect to test DB, run migrations, truncate between tests
- [ ] Vitest config for backend (`backend/vitest.config.ts`) with test DB setup/teardown
- [ ] Vitest config for frontend (`frontend/vitest.config.ts`) with jsdom environment
- [ ] Verify test DB helper works: write a smoke test that runs a migration + inserts a row

### 1.6 Docker Compose
- [x] `docker/docker-compose.yml`: `pgvector/pgvector:pg17` + Redis 8 + backend + frontend — ADR-011
- [ ] Volumes for hot reload (backend/src, frontend/src)
- [ ] `.env` loading with dev defaults
- [ ] Health checks for postgres and redis
- [ ] `host.docker.internal` for Ollama access

### 1.7 CLAUDE.md + AGENTS.md
- [ ] Project conventions, build commands, architecture notes (adapted from reference project)
- [ ] Security rules, testing rules, git workflow

---

## Phase 2: Authentication & User Settings
> References: ADR-007 (security), ADR-006 (schema)

### 2.1 User Auth
- [ ] Run migrations 002 (users) — if not done in Phase 1
- [ ] Registration endpoint (`POST /api/auth/register`) with Zod validation
- [ ] Login endpoint (`POST /api/auth/login`) with JWT generation (jose)
- [ ] Access token: 15 min, in memory; Refresh token: 7 days, httpOnly cookie — ADR-007
- [ ] `fastify.authenticate` decorator for protected routes
- [ ] Password hashing with bcrypt (salt rounds 12)
- [ ] Frontend: login/register pages, auth Zustand store
- [ ] Token refresh: **reactive** strategy — intercept 401 responses in fetch wrapper, call `POST /api/auth/refresh`, retry the original request. Simpler than proactive timer, single retry per 401.

### 2.2 User Settings
- [ ] Run migration 003 (user_settings)
- [ ] Settings CRUD endpoints (`GET/PUT /api/settings`)
- [ ] Confluence connection config: URL + PAT (PAT encrypted with AES-256-GCM) — ADR-007
- [ ] Confluence connection test endpoint (`POST /api/settings/test-confluence`)
- [ ] Ollama model scanner (`GET /api/ollama/models` -> calls shared Ollama `/api/tags`) — ADR-015
- [ ] Chat model selector (save per user, default qwen3.5)
- [ ] Embedding model: server-wide `EMBEDDING_MODEL` env var, shown read-only in settings — ADR-012
- [ ] Space selector: fetch available spaces from user's Confluence, save selections
- [ ] PAT change handling: invalidate all user cache + embeddings, trigger full re-sync — ADR-017
- [ ] Frontend: Settings page with tabs (Confluence, Ollama, Account) — glassmorphic
- [ ] Connection status indicators (green/red badges with test buttons)

### 2.3 Admin Role (ADR-019)
- [ ] Run migration 009 (admin_roles)
- [ ] First registered user automatically gets `role = 'admin'`
- [ ] Include `role` in JWT claims
- [ ] `fastify.requireAdmin` decorator (checks role from JWT)
- [ ] Admin indicator in UI (settings page shows admin-only sections)

---

## Phase 3: Confluence Integration Layer
> References: ADR-003 (content pipeline), ADR-004 (caching), ADR-013 (draw.io)

### 3.1 Confluence API Client Service
- [ ] `domains/confluence/services/confluence-client.ts`: typed HTTP client with PAT Bearer auth (`undici`)
- [ ] Per-user client instances (decrypt PAT from user_settings)
- [ ] Methods:
  - `getSpaces()` -> `GET /rest/api/space`
  - `getPages(spaceKey, start, limit)` -> `GET /rest/api/content?spaceKey=X&type=page&start=N&limit=N` (DC uses offset pagination, not cursor)
  - `getPage(id, expand)` -> `GET /rest/api/content/{id}?expand=body.storage,version,ancestors`
  - `getPageAttachments(id)` -> `GET /rest/api/content/{id}/child/attachment` — for draw.io images (ADR-013)
  - `searchPages(cql)` -> `GET /rest/api/content/search?cql=X`
  - `createPage(spaceKey, title, body, parentId?)` -> `POST /rest/api/content`
  - `updatePage(id, title, body, version)` -> `PUT /rest/api/content/{id}`
  - `deletePage(id)` -> `DELETE /rest/api/content/{id}`
- [ ] Error handling: 401 (invalid PAT), 403 (no permission), 404, rate limiting
- [ ] SSL verification control (`CONFLUENCE_VERIFY_SSL` env var)

### 3.2 Content Format Converter (ADR-003)
- [ ] `core/services/content-converter.ts` service
- [ ] `confluenceToHtml(xhtml)`: strip `ac:*/ri:*` macros -> clean HTML
  - Code blocks: `ac:structured-macro[name=code]` -> `<pre><code>`
  - Task lists: `ac:task-list/ac:task` -> `<ul data-type="taskList">`
  - Info/warning panels: `ac:structured-macro[name=info|warning]` -> `<div class="panel-*">`
  - Links: `ac:link/ri:page` -> `<a href="...">`
  - Images: `ac:image/ri:attachment` -> `<img src="...">`
  - Draw.io: `ac:structured-macro[name=drawio]` -> `<div class="confluence-drawio"><img ...>` — ADR-013
- [ ] `htmlToConfluence(html)`: wrap back to Confluence storage format
- [ ] `htmlToMarkdown(html)`: via `turndown` library (for LLM consumption)
- [ ] `markdownToHtml(md)`: via `marked` (for LLM output -> editor)
- [ ] `htmlToText(html)`: strip all tags (for full-text search + embedding input)

### 3.3 Draw.io Attachment Handler (ADR-013, ADR-018)
- [ ] During sync: detect draw.io macros in pages
- [ ] Fetch rendered PNG/SVG from page attachments API
- [ ] Store locally on filesystem: `data/attachments/{userId}/{confluencePageId}/{filename}` — ADR-018
- [ ] Docker volume: `attachments-data:/app/data/attachments` (add to docker-compose)
- [ ] Re-download if attachment `modifiedDate` has changed on sync
- [ ] Clean up attachment directory on page delete or PAT change (ADR-017)
- [ ] Replace macro with `<img src="/api/attachments/{pageId}/{filename}">` + "Edit in Confluence" link in `body_html`

### 3.4 Redis Cache Layer (ADR-004)
- [ ] `core/services/redis-cache.ts` service
- [ ] Cache page lists per space per user (TTL 15min)
- [ ] Cache space metadata (TTL 15min)
- [ ] Cache search results (TTL 5min)
- [ ] Invalidate on write operations (create/update/delete)
- [ ] Invalidate on manual sync trigger
- [ ] Key pattern: `kb:{userId}:{type}:{identifier}`

### 3.5 Sync & Persistent Storage (ADR-004)
- [ ] Run migrations 004-005 (cached_spaces, cached_pages)
- [ ] `domains/confluence/services/sync-service.ts`
- [ ] Initial full sync: fetch all pages from selected spaces -> PostgreSQL + warm Redis
- [ ] Incremental sync: CQL `lastmodified > "last_sync_timestamp"` for delta
- [ ] Background sync worker: `setInterval` + lock flag (ADR-014), configurable interval, default 15 min
- [ ] Worker iterates all users with configured connections, syncs each user's spaces sequentially
- [ ] Mark changed pages as `embedding_dirty = TRUE` for re-embedding
- [ ] Manual sync trigger from UI (`POST /api/sync`)
- [ ] Sync progress tracking (`GET /api/sync/status`)
- [ ] Delete detection: compare confluence ID sets, remove stale pages
- [ ] Sync status indicator in frontend (last synced, in-progress, error)

### 3.6 Backend API Routes
- [ ] `GET /api/spaces` - list user's configured spaces (Redis -> PostgreSQL fallback)
- [ ] `GET /api/pages?spaceKey=X&search=Y` - list/search pages (Redis cached)
- [ ] `GET /api/pages/:id` - get page with content (body_html for editor)
- [ ] `POST /api/pages` - create page in Confluence + PostgreSQL + invalidate Redis
- [ ] `PUT /api/pages/:id` - update page in Confluence + PostgreSQL + invalidate Redis + mark embedding_dirty
- [ ] `DELETE /api/pages/:id` - delete from Confluence + PostgreSQL + Redis + embeddings
- [ ] `GET /api/attachments/:pageId/:filename` - serve cached draw.io images from local filesystem (authenticated) — ADR-018
- [ ] `POST /api/sync` - trigger manual sync
- [ ] `GET /api/sync/status` - sync progress

---

## Phase 4: LLM & RAG Integration (Ollama + pgvector)
> References: ADR-005 (SSE), ADR-012 (RAG pipeline)

### 4.1 Ollama Service
- [ ] `domains/llm/services/ollama-service.ts` using `ollama` npm package
- [ ] Model listing (`ollama.list()`)
- [ ] Model health check (`ollama.show(model)`)
- [ ] Streaming chat completions (`ollama.chat({ stream: true })`)
- [ ] Embedding generation (`ollama.embed({ model, input })`) — ADR-012
- [ ] Concurrency limiting (max 2 parallel LLM calls, via `p-limit`)
- [ ] System prompts per use case (improve, generate, summarize, Q&A)
- [ ] Prompt injection guard: sanitize user content before sending to Ollama — ADR-007

### 4.2 Embedding Pipeline (ADR-012)
- [ ] Run migration 006 (page_embeddings with HNSW index)
- [ ] `domains/llm/services/embedding-service.ts`
- [ ] Text chunking: split on headings first, then paragraphs, ~500 tokens with 50 token overlap
- [ ] Preserve chunk metadata: `{page_title, section_title, space_key}`
- [ ] Generate embeddings via `ollama.embed({ model: 'bge-m3', input: chunk })`
- [ ] Store in `page_embeddings` table (vector(1024))
- [ ] Background embedding worker: process pages where `embedding_dirty = TRUE`
- [ ] Concurrency limited (max 2 parallel embedding calls)
- [ ] Progress tracking (`GET /api/embeddings/status` — "Embedding 42/150 pages...")
- [ ] Re-embed on model change (user switches embedding model in settings)
- [ ] Bulk delete old embeddings when page is deleted or re-chunked

### 4.3 RAG Service (ADR-012)
- [ ] `domains/llm/services/rag-service.ts`
- [ ] Generate question embedding via Ollama
- [ ] Vector search: cosine similarity on `page_embeddings` (top 10)
- [ ] Keyword search: PostgreSQL `ts_vector` full-text search on `cached_pages` (top 10)
- [ ] Hybrid re-ranking: Reciprocal Rank Fusion (RRF) combining vector + keyword scores
- [ ] Take top 5 unique chunks after re-ranking
- [ ] Build RAG prompt with source citations (page title, section, space)
- [ ] Return source metadata alongside streamed answer

### 4.4 Article Improvement
- [ ] `POST /api/llm/improve` - send page content + improvement type
- [ ] Improvement types: grammar, structure, clarity, technical accuracy, completeness
- [ ] Stream response via SSE (fetch + ReadableStream) — ADR-005
- [ ] Returns improved content in Markdown (convert to HTML for editor)
- [ ] Store improvement history in `llm_improvements` table (migration 008)

### 4.5 Article Generation
- [ ] `POST /api/llm/generate` - topic/prompt -> full article draft
- [ ] Configurable: target space, parent page, title suggestion
- [ ] Template-based generation (e.g., runbook, how-to, architecture doc, troubleshooting)
- [ ] Stream response via SSE

### 4.6 Article Summarization
- [ ] `POST /api/llm/summarize` - page content -> concise summary
- [ ] Configurable summary length (short/medium/detailed)
- [ ] Stream response via SSE

### 4.7 Q&A Over Knowledge Base (RAG)
- [ ] `POST /api/llm/ask` - question -> RAG pipeline -> streamed answer with citations
- [ ] Uses `rag-service.ts` for context retrieval
- [ ] Conversation history support (multi-turn, stored in `llm_conversations`)
- [ ] Source citations with links to Confluence pages
- [ ] Stream response via SSE

### 4.8 Backend API Routes
- [ ] `GET /api/ollama/models` - list available models (chat + embedding)
- [ ] `GET /api/ollama/status` - Ollama server health
- [ ] `POST /api/llm/improve` - SSE stream
- [ ] `POST /api/llm/generate` - SSE stream
- [ ] `POST /api/llm/summarize` - SSE stream
- [ ] `POST /api/llm/ask` - SSE stream (RAG)
- [ ] `GET /api/llm/conversations` - list conversations
- [ ] `GET /api/llm/conversations/:id` - get conversation with messages
- [ ] `DELETE /api/llm/conversations/:id` - delete conversation
- [ ] `GET /api/llm/improvements?pageId=X` - improvement history
- [ ] `GET /api/embeddings/status` - embedding progress
- [ ] `POST /api/admin/re-embed` - (admin only) truncate embeddings, mark all pages dirty, trigger re-embedding — ADR-019

---

## Phase 5: Frontend UI
> References: ADR-002 (TipTap), ADR-009 (state management), ADR-010 (UI components), ADR-013 (draw.io)

### 5.1 Layout & Navigation
- [ ] App shell: collapsible sidebar + main content area
- [ ] Sidebar: space tree, search input, quick actions (new article, ask AI)
- [ ] Top bar: user menu, sync status badge, embedding progress, settings link
- [ ] Animated gradient mesh background — ADR-010
- [ ] Glassmorphic card components (`bg-card/80 backdrop-blur-md border-white/10`) — ADR-010
- [ ] Responsive design (desktop-first, tablet-friendly)
- [ ] Respect `prefers-reduced-motion`

### 5.2 Dashboard (Home)
- [ ] Overview cards: total spaces, total pages, recent changes, sync status, embedding coverage
- [ ] Recent articles list (last modified)
- [ ] Quick actions: new article, ask AI, improve article
- [ ] Staggered entrance animations (Framer Motion)

### 5.3 Space & Page Browser
- [ ] Space cards with page count and last synced indicator
- [ ] Page list within space (table or card view, toggle)
- [ ] Page hierarchy tree (parent/child) using `parent_id`
- [ ] Search with hybrid results (vector + keyword via backend)
- [ ] Sort by: title, last modified, author
- [ ] Pagination (cursor-based from cache)

### 5.4 Article Viewer
- [ ] Render `body_html` content (sanitized, with draw.io images) — ADR-013
- [ ] Draw.io diagrams shown as images with "Edit in Confluence" overlay — ADR-013
- [ ] Metadata sidebar: author, last modified, version, space, labels
- [ ] Action buttons: Edit, Improve with AI, Summarize, Delete
- [ ] Link to original in Confluence (open in new tab)

### 5.5 Article Editor (ADR-002)
- [ ] TipTap v3 editor with extensions: StarterKit, Table, TaskList, CodeBlockLowlight, Image, Link, Placeholder
- [ ] Custom TipTap node for draw.io diagrams (read-only, renders as image) — ADR-013
- [ ] Custom glassmorphic toolbar (using Radix UI buttons, not TipTap UI Components)
- [ ] Create new article: select space, parent page, title, content
- [ ] Edit existing: load `body_html` into TipTap, save back via `htmlToConfluence()` -> Confluence API
- [ ] Auto-save drafts to localStorage
- [ ] Version conflict detection (compare version numbers before save)

### 5.6 AI Assistant Panel (Slide-over or Split View)
- [ ] Improve: select improvement type, stream result, diff view (original vs improved)
- [ ] Accept/reject improvements (apply to editor or push directly to Confluence)
- [ ] Generate: enter topic/prompt, select template, stream result, save as new page
- [ ] Summarize: one-click summary of current article
- [ ] Q&A Chat: multi-turn conversation, source citations with clickable page links — ADR-012
- [ ] Model selector in panel header (from scanned Ollama models)
- [ ] Streaming text display with typing animation
- [ ] Conversation history list (load previous Q&A sessions)

### 5.7 Settings Page
- [ ] Tabs: Confluence | Ollama | Account
- [ ] Confluence tab: URL input, PAT input (masked), test connection button, space multi-selector
- [ ] Ollama tab: server status (shared, read-only URL), scan models button, chat model selector, embedding model (read-only, server-wide), test connection
- [ ] Account tab: change password, theme preference
- [ ] Connection status indicators (green/red badges)
- [ ] Embedding status: progress bar, re-embed button

### 5.8 Diff View Component — ADR-016
- [ ] Side-by-side comparison: original (left) vs AI-improved (right)
- [ ] Visual diff highlighting using `diff` library (word-level on plain text)
- [ ] v1: "Apply All" / "Discard" buttons only (no individual change acceptance)
- [ ] Reusable for improvement review workflow

---

## Phase 6: Polish & Production
> References: ADR-007 (security), ADR-011 (Docker)

### 6.1 Error Handling & UX
- [ ] Toast notifications (sonner)
- [ ] Loading skeletons for all async content
- [ ] Empty states with helpful messaging
- [ ] Error boundaries with retry
- [ ] Offline indicators (Confluence unreachable, Ollama unreachable, Redis down)

### 6.2 Docker Compose (Production) — ADR-011
- [ ] Multi-stage Dockerfile for backend (build + slim runtime)
- [ ] Multi-stage Dockerfile for frontend (build + nginx)
- [ ] `docker/docker-compose.yml`: `pgvector/pgvector:pg17` + Redis 8 + backend + frontend
- [ ] Health checks for all 4 services
- [ ] Volume for PostgreSQL data persistence
- [ ] Redis password + maxmemory config
- [ ] `host.docker.internal` for Ollama access

### 6.3 Security — ADR-007
- [ ] PAT encryption at rest (AES-256-GCM with `PAT_ENCRYPTION_KEY` env var)
- [ ] JWT_SECRET validation (32+ chars, fail on default in production)
- [ ] CORS configured for frontend origin only
- [ ] Rate limiting on auth and LLM endpoints
- [ ] Input sanitization (Zod validation on all routes via `@compendiq/contracts`)
- [ ] Prompt injection guard on LLM inputs
- [ ] No secrets in Docker images or git
- [ ] Redis password required

### 6.4 Documentation
- [ ] README.md: setup guide, screenshots, configuration
- [ ] `.env.example` with all variables documented
- [ ] API documentation via Swagger UI (`@fastify/swagger` + `@fastify/swagger-ui`)

---

## Implementation Order

```
Phase 0 (Verification Spike)       ADR: 003, 013        ← MUST pass before proceeding
    |
Phase 1 (Scaffolding)              ADR: 001, 008, 010, 011
    |
Phase 2 (Auth + Settings + Admin)  ADR: 006, 007, 015, 017, 019
    |
Phase 3 (Confluence + Cache)       ADR: 003, 004, 013, 014, 018
    |
Phase 4 (LLM + RAG)               ADR: 005, 012, 014, 015, 019
    |
Phase 5 (Frontend UI)              ADR: 002, 009, 010, 013, 016
    |
Phase 6 (Polish + Docker)          ADR: 007, 011
```

Phase 0 is a quality gate. If the content converter round-trip fails, we redesign
before investing in the full app. Each subsequent phase builds on the previous.
Phases 3-4 backend work can partially overlap with Phase 5 frontend once API contracts are defined.
