# Architectural Decisions Record (ADR)

This document captures all key architectural decisions for the AtlasMind project.
Each decision includes context, options considered, and the chosen approach with rationale.

---

## ADR-001: Project Structure

### Context
The reference project (ai-portainer-dashboard) evolved into a complex monorepo with 10+ npm workspace packages. Our project is simpler in scope.

### Options

| Option | Pros | Cons |
|--------|------|------|
| **A: Flat monorepo** (`backend/` + `frontend/`) | Simple, fast to set up, easy to navigate | Services grow into large files over time |
| **B: Packages monorepo** (like reference) | Clean boundaries, enforced architecture | Over-engineered for this project's scope |
| **C: Flat + shared contracts** (`backend/` + `frontend/` + `packages/contracts/`) | Type safety across boundary, still simple | Slight extra complexity |

### Decision: **Option C - Flat monorepo with shared contracts package**

```
atlasmind/
├── backend/
│   └── src/
│       ├── plugins/          # Fastify plugins (auth, cors, etc.)
│       ├── routes/           # REST API routes grouped by domain
│       │   ├── auth.ts
│       │   ├── pages.ts
│       │   ├── spaces.ts
│       │   ├── llm.ts
│       │   ├── ollama.ts
│       │   ├── settings.ts
│       │   └── sync.ts
│       ├── services/         # Business logic
│       │   ├── confluence-client.ts
│       │   ├── ollama-service.ts
│       │   ├── embedding-service.ts  # pgvector + chunking + embedding
│       │   ├── rag-service.ts        # Hybrid search + prompt building
│       │   ├── redis-cache.ts        # Redis caching layer
│       │   ├── sync-service.ts
│       │   └── content-converter.ts  # XHTML ↔ HTML ↔ Markdown + draw.io
│       ├── db/
│       │   ├── postgres.ts   # Connection + migration runner
│       │   └── migrations/   # Sequential SQL files
│       ├── utils/
│       └── index.ts          # Entry point
├── frontend/
│   └── src/
│       ├── features/         # Domain-grouped UI
│       │   ├── dashboard/
│       │   ├── pages/        # Browse, view, edit articles
│       │   ├── ai-assistant/ # LLM panel (improve, generate, Q&A)
│       │   └── settings/
│       ├── shared/
│       │   ├── components/   # Glass cards, layout, etc.
│       │   ├── hooks/
│       │   └── lib/
│       ├── stores/           # Zustand stores
│       ├── providers/        # Context providers
│       └── App.tsx
├── packages/
│   └── contracts/            # Shared Zod schemas + TypeScript types
│       └── src/
│           ├── schemas/      # Zod validation schemas
│           └── types/        # Shared TypeScript interfaces
├── docker/
│   ├── docker-compose.yml
│   └── docker-compose.dev.yml
└── docs/
```

**Rationale**: Our scope (Confluence + Ollama + CRUD) is ~20% of the reference project's complexity. A flat structure with shared contracts gives us type safety at the API boundary without the overhead of 10+ packages. We can always extract packages later if needed.

---

## ADR-002: Rich Text Editor

### Context
We need an editor that can:
- Import HTML content from Confluence (XHTML storage format)
- Export HTML back to Confluence storage format
- Provide a good editing UX (formatting toolbar, tables, code blocks, lists)
- Work with React 19

### Options

| Editor | React 19 | HTML Import/Export | Maturity | Bundle Size | Notes |
|--------|----------|-------------------|----------|-------------|-------|
| **TipTap** | Partial (UI components need React 18) | Native | Very mature, ProseMirror-based | ~200KB | Industry standard, extensible |
| **BlockNote** | Full | `tryParseHTMLToBlocks` / `blocksToHTMLLossy` | Good, built on TipTap/ProseMirror | ~350KB | Notion-style blocks, opinionated |
| **Lexical** (Meta) | Full | Via plugins | Mature | ~100KB | Complex API, more low-level |
| **Plate** | Full | Via plugins | Good, built on Slate | ~250KB | Highly modular |

### Decision: **TipTap**

**Rationale**:
1. **HTML is our native format** - Confluence stores XHTML. TipTap's ProseMirror core natively parses and generates HTML, making round-trip conversion the most reliable.
2. **Extension ecosystem** - TipTap has extensions for everything Confluence uses: tables, task lists, code blocks, images, headings, etc. We can add custom extensions for Confluence-specific macros.
3. **Headless/unstyled** - We control the look completely, fitting the glassmorphic design.
4. **Server-side rendering** - `@tiptap/static-renderer` can render content server-side for previews.
5. **React 19 note** - The core editor works fine with React 19. Only the premium "UI Components" package requires React 18, which we don't need (we build our own toolbar with Radix UI).

**Editor configuration approach**:
```typescript
// Core extensions matching Confluence capabilities
const extensions = [
  StarterKit,         // Bold, italic, headings, lists, code, blockquote
  Table,              // Confluence tables
  TaskList, TaskItem, // Confluence task lists (ac:task-list)
  CodeBlockLowlight,  // Code blocks with syntax highlighting
  Image,              // Inline images
  Link,               // Hyperlinks
  Placeholder,        // Empty state guidance
]
```

---

## ADR-003: Content Format Pipeline

### Context
Content flows between 4 systems with different format needs:

```
Confluence (XHTML Storage Format)
    ↕
PostgreSQL Cache (store both formats)
    ↕
Editor (HTML via TipTap)
    ↕
LLM/Ollama (Markdown - best for LLM comprehension)
```

### Decision: **Dual-format storage with on-demand conversion**

```
                    ┌─────────────────────────┐
                    │   Confluence REST API    │
                    │  (XHTML Storage Format)  │
                    └────────┬────────────────┘
                             │ GET/PUT
                    ┌────────▼────────────────┐
                    │   Content Converter     │
                    │  confluenceToHtml()     │  Strip ac:*/ri:* → clean HTML
                    │  htmlToConfluence()     │  Wrap back to storage format
                    │  htmlToMarkdown()       │  For LLM consumption
                    │  markdownToHtml()       │  For LLM output → editor
                    └────────┬────────────────┘
                             │
                    ┌────────▼────────────────┐
                    │     PostgreSQL Cache     │
                    │  body_storage (XHTML)   │  Original Confluence format
                    │  body_html (clean HTML) │  For editor loading
                    └────────┬────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │                             │
     ┌────────▼──────┐          ┌──────────▼──────┐
     │  TipTap Editor │          │  Ollama LLM     │
     │  (HTML in/out) │          │  (Markdown)     │
     └───────────────┘          └─────────────────┘
```

### Conversion Libraries

| Conversion | Library | Notes |
|------------|---------|-------|
| Confluence XHTML → Clean HTML | `jsdom` + custom DOM transform | Parse XHTML, walk DOM, convert `ac:*/ri:*` to standard HTML |
| Confluence XHTML → Markdown | `turndown` + `jsdom` + `turndown-plugin-gfm` + custom rules | Best approach for LLM consumption |
| Markdown → HTML | `marked` | Fast, GFM support |
| Clean HTML → Confluence XHTML | Custom serializer | Re-wrap with Confluence macro tags |

**Important**: Confluence Data Center 9.2.15 does NOT support ADF (Atlassian Document Format)
or REST API v2. We must use the **Storage Format (XHTML)** via `/rest/api/content`.
ADF is Cloud-only. Verified against the DC 9.2.17 REST API reference.

### Turndown custom rules implementation

`jsdom` parses the XHTML, and namespace tags appear **uppercased** in the DOM
(e.g. `AC:STRUCTURED-MACRO`). CSS selectors require escaped colons
(e.g. `node.querySelector('ac\\:parameter')`).

```
npm install turndown jsdom turndown-plugin-gfm he
npm install -D @types/turndown @types/jsdom @types/he
```

### Confluence macro mapping

| Confluence Macro | Editor HTML | Markdown |
|-----------------|-------------|----------|
| `<ac:structured-macro ac:name="code">` + `<ac:plain-text-body>` | `<pre><code class="language-X">` | ````lang\ncode```` |
| `<ac:task-list>/<ac:task>` + `<ac:task-status>` | `<ul data-type="taskList">` | `- [x]`/`- [ ] task` |
| `<ac:structured-macro ac:name="info\|warning\|note\|tip">` | `<div class="panel-info\|warning">` | `> [!INFO] text` |
| `<ac:link><ri:page ri:content-title="X">` | `<a href="...">` | `[text](url)` |
| `<ac:link><ri:user>` | `<span class="mention">@user</span>` | `@userId` |
| `<ac:image><ri:attachment>` | `<img src="...">` | `![alt](url)` |
| `<ac:structured-macro ac:name="drawio">` | `<div class="confluence-drawio"><img>` | `![diagram](url)` |

**Rationale**: Storing both `body_storage` (original) and `body_html` (clean) avoids re-converting on every page load. The LLM always gets Markdown (proven to be the best format for LLM comprehension). The editor always gets clean HTML (what TipTap expects).

---

## ADR-004: Caching & Sync Strategy

### Context
Loading all pages from Confluence REST API on every request is slow (~200-500ms per page, pagination needed for lists). We need fast caching for the UI layer and persistent storage for articles + embeddings.

### Decision: **Redis for hot cache + PostgreSQL for persistent storage + background sync**

#### Two-tier caching architecture
```
                    ┌──────────────────────┐
                    │   Confluence REST API │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │     Sync Service      │
                    │  (background worker)  │
                    └──┬───────────────┬───┘
                       │               │
            ┌──────────▼──┐    ┌───────▼──────────┐
            │   Redis      │    │   PostgreSQL      │
            │  (hot cache) │    │  (persistent)     │
            │              │    │                   │
            │ - Page lists │    │ - Full articles   │
            │ - Space data │    │ - body_storage    │
            │ - Search idx │    │ - body_html       │
            │ - API resp.  │    │ - Embeddings      │
            │ - TTL: 15min │    │   (pgvector)      │
            └──────────────┘    └───────────────────┘
```

**Redis layer** (hot cache, TTL-based):
- Page list responses (per space, per user)
- Space metadata
- Search results
- Confluence API response caching
- Default TTL: 15 minutes (configurable)
- Invalidated on write operations

**PostgreSQL layer** (persistent storage):
- Full article content (body_storage + body_html)
- Vector embeddings for RAG (pgvector)
- User settings, conversations, improvements
- Source of truth for offline/fast access

#### Sync Flow
```
Initial Setup (user configures PAT + spaces)
    │
    ▼
Full Sync: Fetch all pages → store in PostgreSQL → generate embeddings → warm Redis
    │
    ▼
Background Sync (every 15 min, configurable):
    - CQL: `lastmodified > "last_sync_timestamp" AND space IN (selected_spaces)`
    - Update changed pages in PostgreSQL
    - Re-generate embeddings for changed pages
    - Invalidate Redis cache for affected keys
    - Detect deleted pages (compare ID sets)
    │
    ▼
Write-through: When user creates/updates via our app:
    1. Write to Confluence REST API
    2. On success, update PostgreSQL immediately
    3. Generate embeddings for new/changed content
    4. Invalidate relevant Redis keys
```

#### Cache invalidation triggers
- User clicks "Sync Now" button
- Background timer fires (configurable interval)
- After any write operation (create/update/delete)
- On login (check if last sync > threshold)
- Redis TTL expiry (automatic)

**Rationale**: Redis handles the fast UI layer (page lists, search results) while PostgreSQL stores the full articles and vector embeddings. Confluence Data Center's REST API doesn't support webhooks, so we poll with CQL `lastmodified >` for efficient delta sync.

---

## ADR-005: LLM Communication Protocol

### Context
LLM responses stream token-by-token from Ollama. We need to deliver these to the browser in real-time.

### Options

| Option | Pros | Cons |
|--------|------|------|
| **SSE (Server-Sent Events)** | Simple, HTTP-native, works through proxies, auto-reconnect | Unidirectional, limited to text |
| **WebSocket** | Bidirectional, binary support | More complex, needs Socket.IO/ws setup, proxy issues |
| **HTTP Streaming** (chunked transfer) | Simplest | No standard reconnect, harder to parse |

### Decision: **SSE for LLM streaming**

**Rationale**:
- LLM output is inherently unidirectional (server → client)
- SSE is simpler to implement (standard `text/event-stream` + `EventSource` API)
- No Socket.IO dependency needed (we don't have real-time features that need bidirectional comms)
- Works reliably through nginx reverse proxies in Docker

**Implementation pattern**:
```typescript
// Backend: Fastify SSE route
fastify.post('/api/llm/improve', async (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  await ollamaService.chatStream(messages, model, (chunk) => {
    reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
  });

  reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  reply.raw.end();
});

// Frontend: fetch + ReadableStream (not EventSource, since we POST)
const response = await fetch('/api/llm/improve', { method: 'POST', body, headers });
const reader = response.body.getReader();
// ... read chunks
```

**Note**: We use `fetch` with streaming response rather than `EventSource` because EventSource only supports GET. Our LLM endpoints need POST with request bodies.

---

## ADR-006: Database Schema Design

### Decision: Single PostgreSQL instance, hand-rolled SQL migrations

**Migration pattern** (same as reference project):
```
backend/src/db/migrations/
  001_extensions.sql
  002_users.sql
  003_user_settings.sql
  004_cached_spaces.sql
  005_cached_pages.sql
  006_page_embeddings.sql
  007_llm_conversations.sql
  008_llm_improvements.sql
  009_admin_roles.sql
```

Auto-run on server start via a `_migrations` tracking table.

### Schema

```sql
-- 001_extensions.sql
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram index for fuzzy text search

-- 002_users.sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 003_user_settings.sql
CREATE TABLE user_settings (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  confluence_url    TEXT,              -- e.g. https://confluence.company.com
  confluence_pat    TEXT,              -- AES-256-GCM encrypted
  selected_spaces   TEXT[] DEFAULT '{}', -- array of space keys
  ollama_model      TEXT DEFAULT 'qwen3.5',
  theme             TEXT DEFAULT 'glass-dark',
  sync_interval_min INT DEFAULT 15,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 004_cached_spaces.sql
CREATE TABLE cached_spaces (
  id          SERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_key   TEXT NOT NULL,
  space_name  TEXT NOT NULL,
  description TEXT,
  homepage_id TEXT,                    -- Confluence page ID
  last_synced TIMESTAMPTZ,
  UNIQUE(user_id, space_key)
);

-- 005_cached_pages.sql
CREATE TABLE cached_pages (
  id                SERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confluence_id     TEXT NOT NULL,      -- Confluence content ID
  space_key         TEXT NOT NULL,
  title             TEXT NOT NULL,
  body_storage      TEXT,               -- Original Confluence XHTML
  body_html         TEXT,               -- Clean HTML for editor
  body_text         TEXT,               -- Plain text (stripped) for search
  version           INT NOT NULL DEFAULT 1,
  parent_id         TEXT,               -- Confluence parent page ID
  labels            TEXT[] DEFAULT '{}',
  author            TEXT,
  last_modified_at  TIMESTAMPTZ,
  last_synced       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding_dirty   BOOLEAN DEFAULT TRUE, -- needs re-embedding
  UNIQUE(user_id, confluence_id)
);

CREATE INDEX idx_cached_pages_space ON cached_pages(user_id, space_key);
CREATE INDEX idx_cached_pages_title ON cached_pages(user_id, title text_pattern_ops);
CREATE INDEX idx_cached_pages_parent ON cached_pages(user_id, parent_id);
CREATE INDEX idx_cached_pages_dirty ON cached_pages(embedding_dirty) WHERE embedding_dirty = TRUE;
-- Full-text search index (fallback when vector search is unavailable)
CREATE INDEX idx_cached_pages_fts ON cached_pages
  USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_text, '')));

-- 006_page_embeddings.sql (pgvector)
-- Chunks: each page is split into ~500 token chunks for embedding
CREATE TABLE page_embeddings (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confluence_id   TEXT NOT NULL,        -- FK to cached_pages.confluence_id
  chunk_index     INT NOT NULL,         -- Order within the page
  chunk_text      TEXT NOT NULL,         -- The text chunk
  embedding       vector(768) NOT NULL,  -- nomic-embed-text: 768 dimensions
  metadata        JSONB DEFAULT '{}',    -- {section_title, page_title, space_key}
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, confluence_id, chunk_index)
);

-- HNSW index for fast approximate nearest neighbor search
CREATE INDEX idx_page_embeddings_vector ON page_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_page_embeddings_user ON page_embeddings(user_id);

-- 007_llm_conversations.sql
CREATE TABLE llm_conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id    TEXT,                     -- Optional: linked Confluence page
  model      TEXT NOT NULL,
  title      TEXT,                     -- Auto-generated from first message
  messages   JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 008_llm_improvements.sql
-- (see below)

-- 009_admin_roles.sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
-- Valid roles: 'user', 'admin'. First registered user gets 'admin' automatically.

-- 008_llm_improvements.sql
CREATE TABLE llm_improvements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confluence_id     TEXT NOT NULL,
  improvement_type  TEXT NOT NULL,      -- grammar, structure, clarity, technical, completeness
  model             TEXT NOT NULL,
  original_content  TEXT NOT NULL,
  improved_content  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft', -- draft, applied, rejected
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Rationale**:
- No ORM (same pattern as reference project) - parameterized SQL only for security
- Per-user data isolation via `user_id` foreign keys
- `body_storage` + `body_html` dual storage (see ADR-003)
- JSONB for conversation messages (flexible schema for multi-turn chat)
- Text arrays for labels and selected_spaces (native PostgreSQL arrays)

---

## ADR-007: Security Model

### PAT Storage
- User enters PAT in settings UI
- Backend encrypts with **AES-256-GCM** before storing
- Encryption key: derived from `PAT_ENCRYPTION_KEY` env var (required, 32+ chars)
- Decrypted only when making Confluence API calls (never sent to frontend)
- IV is unique per encryption, stored alongside ciphertext

### Authentication
- **JWT** via `jose` library (same as reference project)
- Access token: 15 min expiry, stored in memory (not localStorage)
- Refresh token: 7 day expiry, httpOnly cookie
- Password hashing: `bcrypt` with salt rounds 12
- `fastify.authenticate` decorator on all protected routes

### LLM Safety
- **Prompt injection guard**: Sanitize user-provided content before sending to Ollama
- **Output sanitization**: Strip any potential system prompt leakage
- Rate limiting on LLM endpoints (prevent abuse of local Ollama resources)

### Input Validation
- **Zod** schemas on all API boundaries (from `@atlasmind/contracts`)
- Parameterized SQL only (no string concatenation)

---

## ADR-008: Simplified vs Full Packages Architecture

### Context
The reference project has 10 npm workspace packages. Should we replicate this?

### Decision: **No. Start flat, extract if needed.**

| Reference Project | Our Project | Rationale |
|-------------------|-------------|-----------|
| `packages/contracts/` | `packages/contracts/` | Keep - shared types across API boundary |
| `packages/core/` | `backend/src/db/` + `backend/src/plugins/` | Flatten - we have one domain, not five |
| `packages/ai-intelligence/` | `backend/src/services/ollama-service.ts` | Single file, not a package |
| `packages/server/` | `backend/src/index.ts` + `backend/src/app.ts` | Direct bootstrap, no wiring needed |
| `packages/infrastructure/` | N/A | We don't have Docker/K8s management |
| `packages/security/` | N/A | We don't have security scanning |
| `packages/observability/` | N/A | We don't have metrics/timeseries |

**Rationale**: The reference project's package architecture exists because it manages 5+ external integrations (Portainer, Harbor, Prometheus, Ollama, Redis) across multiple domains (containers, security, observability, operations). Our project has 2 integrations (Confluence, Ollama) in a single domain (knowledge base management). A flat structure with good file organization is sufficient.

---

## ADR-009: Frontend State Management

### Decision: Same pattern as reference project

| State Type | Tool | Example |
|------------|------|---------|
| **Server data** | TanStack Query | Page list, spaces, sync status |
| **Global UI** | Zustand (persisted) | Theme, sidebar, preferences |
| **Auth** | Zustand + Context | JWT tokens, user info |
| **Editor** | TipTap internal | Document state, selection |
| **LLM streaming** | Local state (useState) | Current stream, pending state |

### Zustand Stores

```
stores/
  auth-store.ts     # User session, tokens, login/logout
  theme-store.ts    # Theme selection, glassmorphic prefs
  ui-store.ts       # Sidebar collapse, view modes
  settings-store.ts # Cached user settings (Confluence URL, model, etc.)
```

**Rationale**: TanStack Query handles all the caching, refetching, and loading states for server data. Zustand handles client-only state. No Redux overhead needed.

---

## ADR-010: UI Component Strategy

### Decision: Custom glassmorphic components built on Radix UI primitives

**Same approach as reference project:**
- **Radix UI** for accessible primitives (Dialog, Select, Tabs, Tooltip, ScrollArea, etc.)
- **TailwindCSS 4** for styling with CSS variables for theming
- **Framer Motion** (`LazyMotion` with `domAnimation`) for animations
- **Custom glass components** wrapping Radix with glassmorphic styling:

```css
/* Glass card base */
.glass-card {
  @apply rounded-xl border border-white/10 bg-card/80 backdrop-blur-md shadow-lg;
}

/* Glass card hover */
.glass-card-hover {
  @apply glass-card transition-all hover:border-white/20 hover:shadow-xl;
}
```

**Theme system**: CSS variables at `:root` and `.dark` scope (start with light + dark, expand later).

**Animation philosophy**: All animations respect `prefers-reduced-motion`. Staggered entrance animations for lists/grids.

---

## ADR-011: Docker Deployment Architecture

### Decision: 4-service stack (frontend + backend + PostgreSQL with pgvector + Redis)

```yaml
# docker/docker-compose.yml
services:
  backend:
    build: ./backend
    ports: ["3051:3051"]
    depends_on: [postgres, redis]
    environment:
      - POSTGRES_URL=postgresql://...
      - REDIS_URL=redis://redis:6379
      - PAT_ENCRYPTION_KEY=${PAT_ENCRYPTION_KEY}
      - JWT_SECRET=${JWT_SECRET}
      - OLLAMA_BASE_URL=http://host.docker.internal:11434

  frontend:
    build: ./frontend
    ports: ["5273:5273"]
    depends_on: [backend]

  postgres:
    image: pgvector/pgvector:pg17      # PostgreSQL 17 + pgvector extension
    volumes: [postgres-data:/var/lib/postgresql/data]

  redis:
    image: redis:8-alpine
    command: >
      redis-server
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
      --requirepass ${REDIS_PASSWORD}
```

**PostgreSQL with pgvector**: Using the `pgvector/pgvector:pg17` Docker image which includes the vector extension pre-installed. No separate vector DB service needed.

**Redis**: Hot cache for UI responsiveness (page lists, search results, API responses). TTL-based with LRU eviction.

**Ollama runs on the host**: Not containerized by us (user manages their own Ollama installation). Accessed via `host.docker.internal`.

**Rationale**: 4 containers keep operational complexity low while providing proper caching (Redis) and vector search (pgvector) capabilities.

---

## ADR-012: RAG Pipeline with pgvector

### Context
For the "Q&A over knowledge base" feature, we need to provide relevant article context to the LLM. Full articles don't fit in small model context windows. Semantic search outperforms keyword search for natural language questions.

### Decision: **Full RAG pipeline with pgvector + hybrid search**

#### Embedding Pipeline
```
Page synced/updated from Confluence
    │
    ▼
1. Extract plain text (strip HTML tags)
    │
    ▼
2. Chunk into ~500 token segments with overlap (~50 tokens)
   Strategy: split on headings (h1-h6) first, then paragraphs,
   then sentence boundaries. Preserve section context.
    │
    ▼
3. Generate embeddings via Ollama
   Model: nomic-embed-text (768 dimensions, fast, high quality)
   Endpoint: ollama.embed({ model, input })
    │
    ▼
4. Store chunks + embeddings in page_embeddings table (pgvector)
   Include metadata: {page_title, section_title, space_key}
    │
    ▼
5. Mark page as embedding_dirty = FALSE
```

#### Chunking Strategy
```
┌─────────────────────────────────────┐
│ Page: "Kubernetes Deployment Guide" │
├─────────────────────────────────────┤
│ Chunk 0: Title + Introduction       │ ← ~500 tokens
│ Chunk 1: Prerequisites section      │ ← ~500 tokens
│ Chunk 2: Step 1 - Setup (overlap)   │ ← ~500 tokens, 50 token overlap with chunk 1
│ Chunk 3: Step 2 - Deploy            │
│ Chunk 4: Troubleshooting            │
└─────────────────────────────────────┘

Each chunk stored with metadata:
{
  "page_title": "Kubernetes Deployment Guide",
  "section_title": "Prerequisites",
  "space_key": "OPS",
  "chunk_index": 1
}
```

#### Q&A Query Flow (Hybrid Search)
```
User Question: "How do I deploy to staging?"
    │
    ▼
1. Generate question embedding via Ollama (nomic-embed-text)
    │
    ▼
2. Hybrid search (vector + keyword):
   a) Vector search: cosine similarity on page_embeddings
      SELECT chunk_text, metadata, 1 - (embedding <=> $query_vec) AS score
      FROM page_embeddings WHERE user_id = $uid
      ORDER BY embedding <=> $query_vec LIMIT 10
   b) Full-text search: PostgreSQL ts_vector on cached_pages
      SELECT title, body_text FROM cached_pages
      WHERE to_tsvector('english', body_text) @@ plainto_tsquery($question)
    │
    ▼
3. Re-rank: combine vector + keyword scores (RRF - Reciprocal Rank Fusion)
   Take top 5 unique chunks
    │
    ▼
4. Build RAG prompt:
   "You are a helpful knowledge base assistant.
    Answer based ONLY on the following sources.
    Cite sources as [Source N] in your answer.

    [Source 1: {page_title} > {section_title}]
    {chunk_text}

    [Source 2: {page_title} > {section_title}]
    {chunk_text}
    ...

    Question: {user_question}"
    │
    ▼
5. Stream response via SSE with source citations
   Include links to original Confluence pages
```

#### Embedding Model Selection
| Model | Dimensions | Speed | Quality | Notes |
|-------|-----------|-------|---------|-------|
| **nomic-embed-text** (default) | 768 | Fast | High | Best balance, outperforms OpenAI ada-002 |
| snowflake-arctic-embed | 1024 | Fast | High | Alternative option |
| qwen3-embedding | 1024 | Medium | Very High | If user runs Qwen family |

The embedding column is **locked to `vector(768)`** using `nomic-embed-text`. Users can select
their chat model freely, but the embedding model is a server-wide setting (`EMBEDDING_MODEL` env var).
Changing the embedding model requires a manual admin action: run `POST /api/admin/re-embed` which
truncates the `page_embeddings` table and re-generates all embeddings with the new model. This is
a deliberate trade-off: dimension changes require HNSW index rebuilds that cannot happen transparently.

#### Background Embedding Worker
- Runs as a background task after sync
- Processes pages where `embedding_dirty = TRUE`
- Concurrency limited (max 2 parallel embedding calls to Ollama)
- Progress indicator in UI ("Embedding 42/150 pages...")
- Can be paused/resumed

**Rationale**: Full vector search gives the LLM the best possible context for Q&A. pgvector keeps it in PostgreSQL (no new service). Hybrid search (vector + keyword) handles both semantic similarity and exact term matching. nomic-embed-text is fast enough for incremental re-embedding on sync.

---

## ADR-013: Draw.io / Diagrams.net Support

### Context
Confluence pages often contain draw.io diagrams. These are stored as Confluence macros (`ac:structured-macro` with `ac:name="drawio"`) with diagram data in page attachments.

### How draw.io works in Confluence
1. The macro references an attachment on the page
2. The attachment contains two files:
   - A rendered **PNG/SVG image** (for display)
   - The **XML diagram source** (for editing)
3. The REST API returns the macro in `body.storage` as XHTML
4. The rendered image can be fetched via `body.export_view` (base64-encoded PNG) or via the attachments API

### Decision: **Read-only rendering with link to edit in Confluence**

#### Display approach
```
Confluence page with draw.io macro
    │
    ▼
During sync: fetch page attachments via REST API
    GET /rest/api/content/{id}/child/attachment
    │
    ▼
For draw.io attachments:
    1. Download the rendered PNG/SVG
    2. Store locally (filesystem or DB as BLOB)
    3. In cached body_html, replace the macro with <img> tag
    │
    ▼
In the editor/viewer:
    - Display as rendered image
    - Show "Edit in Confluence" overlay button
    - Click opens the page in Confluence for draw.io editing
```

#### Macro conversion
```html
<!-- Confluence storage format -->
<ac:structured-macro ac:name="drawio" ac:schema-version="1">
  <ac:parameter ac:name="diagramName">architecture-diagram</ac:parameter>
  <ac:parameter ac:name="width">800</ac:parameter>
</ac:structured-macro>

<!-- Converted to HTML for our editor -->
<div class="confluence-macro confluence-drawio" data-diagram-name="architecture-diagram">
  <img src="/api/attachments/{page_id}/{attachment_name}.png"
       alt="architecture-diagram"
       style="max-width: 800px" />
  <a href="{confluence_url}/pages/viewpage.action?pageId={id}"
     target="_blank" class="edit-in-confluence">
    Edit in Confluence
  </a>
</div>
```

#### TipTap custom node for draw.io
```typescript
// Custom ProseMirror node that renders draw.io diagrams as images
const DrawioDiagram = Node.create({
  name: 'drawioDiagram',
  group: 'block',
  atom: true, // Not editable inline
  addAttributes() {
    return {
      src: {},
      alt: {},
      diagramName: {},
      confluencePageId: {},
      width: { default: '100%' },
    }
  },
  parseHTML() {
    return [{ tag: 'div.confluence-drawio' }]
  },
  renderHTML({ HTMLAttributes }) {
    // Renders as image with overlay
  },
})
```

#### What's NOT supported (and why)
- **Inline editing of draw.io diagrams**: Would require embedding the full draw.io editor (1MB+ JS), maintaining sync of diagram XML back to Confluence attachments, and handling concurrent edits. The complexity is enormous for marginal benefit.
- **Creating new draw.io diagrams**: Same complexity issue. Users create diagrams in Confluence, our app displays them.

**Rationale**: Draw.io diagrams are visual assets, not text content. Displaying the rendered image is sufficient for our knowledge base use case. Users who need to edit diagrams already have Confluence. The "Edit in Confluence" link provides a seamless escape hatch.

---

## ADR-014: Background Workers

### Context
The app needs several background tasks: Confluence sync, embedding generation, article quality analysis, and auto-summarization. Fastify has no built-in job scheduler.

### Decision: **Simple `setInterval` with lock flags**

All four workers follow the same pattern: `setInterval` with an in-memory lock flag to prevent concurrent execution, configurable interval and batch size via env vars, and a 30-second delayed initial batch on startup.

```typescript
// In index.ts after server start
let syncRunning = false;
setInterval(async () => {
  if (syncRunning) return;
  syncRunning = true;
  try {
    await syncService.runForAllUsers();
    await embeddingService.processAllDirtyPages();
  } finally {
    syncRunning = false;
  }
}, SYNC_INTERVAL_MS);
```

#### Workers

| Worker | Interval | Batch Size | Model Env Var | Retry Limit |
|--------|----------|------------|---------------|-------------|
| Sync | `SYNC_INTERVAL_MINUTES` (15) | All changed pages | N/A | N/A |
| Embedding | After sync | All dirty pages | `EMBEDDING_MODEL` | N/A |
| Quality Analysis | `QUALITY_CHECK_INTERVAL_MINUTES` (60) | `QUALITY_BATCH_SIZE` (5) | `QUALITY_MODEL` → `DEFAULT_LLM_MODEL` → `qwen3:4b` | 3 (`quality_retry_count`) |
| Summary | `SUMMARY_CHECK_INTERVAL_MINUTES` (60) | `SUMMARY_BATCH_SIZE` (5) | `SUMMARY_MODEL` → `DEFAULT_LLM_MODEL` | 3 (`summary_retry_count`) |

#### Worker Lifecycle

1. **Startup**: `startXxxWorker()` called from `index.ts`, registers `setInterval`
2. **Initial batch**: Runs 30 seconds after startup via `triggerXxxBatch()` (lock-guarded)
3. **Interval batches**: Every N minutes, processes up to BATCH_SIZE pages
4. **Priority**: Pending pages first, then stale/changed content, then failed (with retries remaining)
5. **Shutdown**: `stopXxxWorker()` called on SIGTERM/SIGINT, clears interval

#### Quality Analysis Worker

Scores articles across 6 dimensions (overall, completeness, clarity, structure, accuracy, readability) by sending content to the LLM with a structured prompt. Results stored in `cached_pages` columns. Pages with changed content (`last_modified_at > quality_analyzed_at`) are automatically re-analyzed. Status: `pending → analyzing → analyzed | failed | skipped`.

#### Summary Worker

Generates plain-text and HTML summaries by sending article content to the LLM. Detects content changes via SHA-256 hash comparison (using PostgreSQL built-in `sha256()`, no pgcrypto extension needed). Status: `pending → summarizing → summarized | failed | skipped`.

**Why not bullmq/pg-boss?**
- 4-15 users, ~1000 pages total. A simple interval is sufficient.
- No distributed workers needed (single backend instance).
- Redis-based job queues add complexity for zero benefit at this scale.

**Crash recovery**: On restart, all status flags and `embedding_dirty` markers are still set in PostgreSQL. The next interval picks them up automatically. No work is lost. Failed pages retry up to 3 times before being left in `failed` state.

**Per-user sync**: The worker iterates all users with configured Confluence connections and syncs each user's spaces sequentially. At 15 users × 1000 pages, a full delta sync takes seconds (CQL returns only changed pages).

**Admin controls**: Force rescan endpoints (`POST /api/llm/quality-rescan`, `POST /api/llm/summary-rescan`) reset all pages to pending. Status endpoints (`GET /api/llm/quality-status`, `GET /api/llm/summary-status`) expose aggregate stats. All visible in Settings > Sync tab.

---

## ADR-015: Ollama Service Architecture

### Context
The critic flagged ambiguity about whether Ollama is per-user or shared.

### Decision: **Shared Ollama server, server-wide configuration**

- **Single `OLLAMA_BASE_URL` env var** — not per-user. All users share the same Ollama instance.
- **Chat model**: per-user preference (stored in `user_settings.ollama_model`). Users can pick different models.
- **Embedding model**: server-wide (`EMBEDDING_MODEL` env var, default `nomic-embed-text`). Locked to `vector(768)`.
- **Global concurrency limiter**: `p-limit(2)` — max 2 concurrent Ollama calls across all users. At 4-15 users this is fine; most requests are short (summarize, improve) and naturally serialize.
- **Singleton service**: One `OllamaService` instance, created at server start. Chat calls pass the user's preferred model as a parameter.

---

## ADR-016: Diff View Strategy

### Context
When the AI improves an article, the user needs to compare original vs improved content and decide whether to apply changes.

### Decision: **v1: Accept All / Reject All. v2: Individual changes.**

**v1 (ship first)**:
- Side-by-side view: original (left) vs improved (right)
- Visual diff highlighting using `diff` library (word-level on plain text)
- Two buttons: "Apply All" (replaces editor content) / "Discard" (keeps original)
- Simple, reliable, ships fast

**v2 (future)**:
- Individual change acceptance requires mapping diffs back to editor positions
- Use TipTap's transaction API to apply/reject individual edits
- Significantly harder — deferred to after v1 is stable

---

## ADR-017: PAT Change / Re-sync Behavior

### Context
When a user changes their Confluence PAT or URL, cached data may be invalid.

### Decision: **Invalidate all cached data and trigger full re-sync**

When `confluence_url` or `confluence_pat` changes in user_settings:
1. Delete all rows from `cached_spaces` for that user
2. Delete all rows from `cached_pages` for that user
3. Delete all rows from `page_embeddings` for that user
4. Invalidate all Redis keys for that user (`DEL kb:{userId}:*`)
5. Trigger an immediate full sync + embedding generation

This is the safest approach. A different Confluence URL means different page IDs.
A new PAT on the same instance means permissions may have changed.

---

## ADR-018: Draw.io Image Storage

### Context
Draw.io diagrams need to be displayed in the viewer/editor. The images come from Confluence attachments API. We need to decide where to store them.

### Options
| Option | Pros | Cons |
|--------|------|------|
| **A: Proxy on demand** | No storage needed | Every image load hits Confluence, needs PAT in request cycle |
| **B: Cache locally (filesystem)** | Fast, no Confluence dependency for viewing | Needs Docker volume, disk management |
| **C: Store as BLOB in PostgreSQL** | No extra volume | Inflates DB, complicates backups |

### Decision: **Option B - Cache locally on filesystem**

- Draw.io attachment PNGs/SVGs are downloaded during sync and stored on the local filesystem
- Storage path: `data/attachments/{userId}/{confluencePageId}/{filename}`
- Docker volume: `attachments-data:/app/data/attachments` in docker-compose
- Backend serves via `GET /api/attachments/:pageId/:filename` (authenticated, reads from disk)
- On sync: re-download if attachment `modifiedDate` has changed
- On page delete or PAT change: delete user's attachment directory

**Rationale**: Local cache avoids hitting Confluence on every page view. Filesystem is simplest for binary blobs. Docker volume provides persistence across container restarts.

---

## ADR-019: Admin Role & Re-embed Endpoint

### Context
The embedding model is server-wide. Changing it requires re-generating all embeddings (`POST /api/admin/re-embed`). This is a destructive, resource-intensive operation that should not be available to all users.

### Decision: **Simple admin role, first user is admin**

- Add `role` column to `users` table (migration 009): values `'user'` or `'admin'`
- First registered user automatically gets `role = 'admin'`
- Subsequent users get `role = 'user'`
- Admin-only endpoints use a `fastify.requireAdmin` decorator (checks `role` from JWT claims)
- Admin-only routes:
  - `POST /api/admin/re-embed` — truncates `page_embeddings`, marks all pages `embedding_dirty = TRUE`, triggers background re-embedding
  - Future: user management, server settings

**Re-embed behavior**:
1. Validate new model exists on Ollama (`ollama.show(model)`)
2. Update `EMBEDDING_MODEL` in server config (or require env var change + restart)
3. Truncate `page_embeddings` for all users
4. Set `embedding_dirty = TRUE` on all `cached_pages`
5. Background worker picks up dirty pages on next interval
6. Progress visible via `GET /api/embeddings/status`

**PAT_ENCRYPTION_KEY rotation**: Out of scope for v1. If the key changes, all stored PATs become unreadable and users must re-enter them. This is acceptable for 4-15 users.

---

## ADR-020: Standalone KB Articles & Confluence-Free Mode

### Context
The app was originally a Confluence-only cache — every article required a `confluence_id` and `space_key`. Users without Confluence couldn't use the app at all. Issue #353 proposed making the app work standalone and as a hybrid Confluence + local KB.

### Decision: **Shared `pages` table with `source` discriminator + universal SERIAL FK**

**Table rename**: `cached_pages` → `pages` — the table is no longer just a cache; standalone articles are the source of truth.

**New columns on `pages`**:
- `source` (`'confluence'` | `'standalone'`) — discriminates article origin
- `created_by_user_id` (UUID FK) — owner for standalone articles
- `visibility` (`'private'` | `'shared'`) — access control for standalone articles
- `deleted_at` (TIMESTAMPTZ) — soft delete for standalone articles (trash/restore)

**Universal FK migration**: All 5 dependent tables (`page_embeddings`, `page_versions`, `llm_improvements`, `pinned_pages`, `page_relationships`) migrated from `confluence_id TEXT` to `page_id INT REFERENCES pages(id)`. The SERIAL `id` is now the canonical identifier everywhere. This eliminates orphaning when standalone articles are published to Confluence.

**RAG dual-path access control**: Every query that previously used `INNER JOIN user_space_selections` now uses `LEFT JOIN` with a triple-OR WHERE clause:
1. Confluence pages where user has selected the space
2. Standalone shared pages (visible to all)
3. Standalone private pages (visible to owner only)

**Soft delete**: Standalone articles use `deleted_at` instead of hard delete. Workers skip `deleted_at IS NOT NULL`. Trash endpoint lists deleted articles with restore/permanent-delete.

**Content verification**: Per-article `review_interval_days`, `next_review_at`, `verified_by`, `verified_at` — Guru-style staleness system.

**Draft-while-published**: Separate `draft_body_html` columns allow editing without affecting the live article. Atomic publish swaps draft → live.

### Alternatives Considered
1. **Separate table for standalone articles** — rejected because all existing features (RAG, embeddings, quality scoring, summaries) would need duplication
2. **Keep `cached_pages` name** — rejected because standalone articles are the source of truth, not a cache
3. **Keep `confluence_id` as FK target** — rejected because standalone articles have no `confluence_id`, creating a dual-identifier problem

### Consequences
- All existing features work on standalone articles with zero extra code (embeddings, RAG, quality, summaries, tagging, duplicate detection)
- Every SELECT query on `pages` must include `AND deleted_at IS NULL`
- `confluence_id` remains on the table as metadata (nullable, partial unique index) but is no longer a join key
- Migrations 028-037 must apply in order; historical migrations (001-027) are never modified

---

## Summary of All Decisions

| # | Decision | Choice | Key Rationale |
|---|----------|--------|---------------|
| 001 | Project Structure | Flat + shared contracts | Simpler than reference, sufficient for scope |
| 002 | Rich Text Editor | TipTap v3 | Best HTML round-trip, headless, extensible, React 19 |
| 003 | Content Pipeline | Dual-format (XHTML + HTML), Markdown for LLM | Each consumer gets optimal format |
| 004 | Caching Strategy | Redis (hot) + PostgreSQL (persistent) + background sync | Fast UI + durable storage + vector embeddings |
| 005 | LLM Communication | SSE via fetch streaming | Unidirectional, simple, proxy-friendly |
| 006 | Database Schema | PostgreSQL + pgvector, hand-rolled SQL migrations | Proven pattern + native vector search |
| 007 | Security Model | AES-256-GCM PAT encryption, JWT auth, Zod | Defense in depth, no plaintext secrets |
| 008 | Package Architecture | Flat (not full packages) | 2 integrations vs 5+, single domain |
| 009 | State Management | TanStack Query + Zustand | Server data vs client state separation |
| 010 | UI Components | Radix UI + TailwindCSS + Framer Motion | Glassmorphic, accessible, same as reference |
| 011 | Docker Stack | 4 services (frontend, backend, postgres+pgvector, redis) | Proper caching + vector search, manageable ops |
| 012 | RAG Pipeline | pgvector + hybrid search (vector + keyword) + nomic-embed-text | Best LLM context quality for Q&A |
| 013 | Draw.io Support | Read-only rendering + "Edit in Confluence" link | Display diagrams, edit in Confluence |
| 014 | Background Workers | `setInterval` + lock flag + retry limits | Simple, 4 workers (sync, embedding, quality, summary), crash-safe, admin controls |
| 015 | Ollama Architecture | Shared server, global concurrency limit, per-user chat model | Single instance, no per-user URL complexity |
| 016 | Diff View | v1: Accept All/Reject All, v2: individual changes | Ship simple first, iterate |
| 017 | PAT Change Behavior | Invalidate all user data + full re-sync | Safest approach for URL/PAT changes |
| 018 | Draw.io Image Storage | Local filesystem cache + Docker volume | Fast, no Confluence dependency for viewing |
| 019 | Admin Role & Re-embed | Simple role column, first user is admin | Protects destructive re-embed operation |
| 020 | Standalone KB Articles | Shared `pages` table + `source` discriminator + universal SERIAL FK | All features work on standalone articles; no dual-identifier problem |
