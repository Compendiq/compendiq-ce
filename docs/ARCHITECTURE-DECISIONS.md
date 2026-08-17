# Architectural Decisions Record (ADR)

This document captures all key architectural decisions for the Compendiq project.
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
compendiq/
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
│   └── docker-compose.test.yml
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

### #1115 (2026-08-17) — images stop being invisible to RETRIEVAL; the pipeline above is unchanged

**Nothing in the conversion pipeline changes.** Confluence XHTML ⇄ clean HTML ⇄
Markdown stays exactly as specified above, with the same libraries and the same
macro mapping. An `<img>` still converts to `<img>`, and its *text* contribution
to embedding input is still whatever alt text it carries.

What changes (ADR-025, landing in **P2**) is that the attachment's **bytes**
become a second, parallel index — `page_image_embeddings`, embedded by a
vision-language model, fused as a third retrieval leg. Four consequences are
worth stating here, where a reader of the pipeline will look for them:

- **Images never join the pipeline above.** They stay bytes from disk to model,
  exactly as #1154's uploaded images do. There is no image → Markdown step, no
  OCR, and no new conversion rule.
- **The enumeration key is the pipeline's own output.** The converter writes
  `<img src="/api/attachments/<id>/<file>">` into `body_html`; that basename is
  the `attachment_key`, and the id is `confluence_id` — or the numeric page id
  for pasted images on standalone pages, which is a quirk of the render-time
  `/api/local-attachments` rewrite rather than of storage.
- **draw.io PNGs are indexed only where they are really rasters.** Confluence's
  export is sometimes `<mxfile>` XML behind a `.png` name (ADR-013); magic-byte
  sniffing refuses it and the file is skipped and counted, never guessed at from
  the extension.
- **A page whose text is below the embedding floor becomes reachable.** Today an
  image-only page produces no chunk at all; the image leg gives it a row,
  synthesising `chunkText` from the title for the downstream stages.

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
  embedding       vector(1024) NOT NULL,  -- historical: bge-m3 at 1024 dimensions
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

> **Note on `page_embeddings.embedding` (#1114):** the DDL above is this ADR's
> schema snapshot, not the migration file, and its `-- historical:` comment is an
> annotation added here rather than migration text — `006_page_embeddings.sql`
> actually shipped `embedding vector(768) NOT NULL` with no comment, and 1024
> arrives only with migration 048 (`ALTER COLUMN embedding TYPE vector(1024)`,
> which also writes `admin_settings.embedding_dimensions = '1024'`). **The live
> column type is dimension-driven** — `columnTypeFor` picks `vector(n)` + HNSW
> `vector_cosine_ops` up to 2000 dims, `halfvec(n)` + `halfvec_cosine_ops` from
> 2001 to 4000, and an unindexed `vector(n)` above — from a width probed off the
> resolved `embedding` model, not from a constant. So `vector(1024)` is where the
> migrations leave a fresh install, not a width the schema mandates: a model swap
> re-types the column. See ADR-012's `#1114` amendment and
> `docs/architecture/06-data-model.md`.

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
- **Zod** schemas on all API boundaries (from `@compendiq/contracts`)
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

### Addendum (v0.4 — #30): Neumorphic theme system supersedes glassmorphic

The v0.3-era glassmorphic surfaces (`backdrop-filter: blur` + alpha bg + thin top-light highlight) are retired as of v0.4 in favour of a neumorphic theme system that mirrors the public landing page (`compendiq-landing/src/styles/tokens.css`) for cross-surface brand parity. Two themes ship — **Graphite Honey** (dark, default) and **Honey Linen** (light) — both anchored on the brand palette (black `#0A0A0A` + honey `#F9C74F`) with theme-tinted neumorphic shadow recipes rather than backdrop blur. Eleven `nm-*` `@utility` classes (`nm-card`, `nm-card-elevated`, `nm-card-interactive`, `nm-toolbar`, `nm-sidebar`, `nm-header`, `nm-pill-active`, `nm-button-primary`, `nm-button-ghost`, `nm-icon-button`, `nm-input`) replace the glass equivalents one-to-one. **Hybrid neumorphism is mandatory**: every interactive surface carries a 1px solid border so chrome remains visible at 3:1 contrast under WCAG 1.4.11, in `forced-colors: active` mode (where `box-shadow` is zeroed by the browser — each utility falls back to a `ButtonText` system border), and on edge-case display calibrations. Focus rings live on `:focus-visible` with `outline-offset` so they don't visually merge with the surface shadow; press states swap raised → inset shadow. `prefers-reduced-motion: reduce` strips the press transform/transition. Status colours have been lifted to `--color-status-*` semantic tokens (`connected` / `syncing` / `embedding` / `ai` / `disconnected` / `inactive`) so badges shift correctly between dark and light themes; `--color-primary-ink` provides a darkened honey for AA-safe accent-as-text use on cream surfaces. The animated gradient mesh on the setup wizard is preserved (it sits behind the neumorphic surfaces without conflict). Migration of persisted theme preferences: any retired theme ID (`void-indigo`, `obsidian-violet`, `polar-slate`, `parchment-glow`, plus older legacy IDs) silently falls back to `graphite-honey` on first load — no data migration is required.

### Amendment v0.5 (2026-05-17) — Amber-as-AI

The brand palette stays black `#0A0A0A` + honey `#F9C74F`, but **honey is reassigned a single semantic meaning across the product: "AI is involved here."** It is no longer used as the primary affordance color.

Three rules:

1. **Honey appears only on AI surfaces** — AI affordances (Ask / Generate / Summarize / Improve / Diagram / Quality / Think / chat composer / duplicate detection), AI-state status (`--color-status-ai` is honey-amber for "AI is processing this"), the AI tab's icon when active in the main rail, and the brand mark's Q-magnifier strokes.
2. **Primary affordance becomes ink** — `--color-action` (#0A0A0A light, #ECE9E2 dark). Non-AI primary buttons use an outline-fills-on-hover treatment. Active sidebar/tab/article-row pills use ink-fill.
3. **Focus ring is the one allowed exception** — `--color-ring` stays honey across all surfaces for brand-mark continuity. Focus is intentionally loud.

Status indicators retain their domain palette (green=connected, red=disconnected, yellow=syncing, blue=embedding, purple=AI-processing, gray=inactive) — these are state colors, not affordance colors, and the new rule does not collide.

Badge palette unified: every status pill (Local / Shared / Private / Failed / Skipped / Not Embedded / Recent / Draft) uses a tinted-pill recipe with AA-pass text in both themes. "Private" moves from amber to neutral gray; "Recent" moves from amber to sage; "Draft" moves from orange to neutral gray.

WCAG-AA regression guard: `e2e/contrast.spec.ts` audits 6 routes × 2 themes; any text-on-bg pair below AA fails CI.

### v0.5 — Slate Steel / Frost Steel palette (supersedes the honey palette)

**Owner decision.** The honey palette above is retired. The colour system is
replaced wholesale by the cool slate-and-steel system ported from the
`lifecycle-management` console (`apps/web/src/styles.css`, "Mission Bento").
The **structural** decisions of v0.4 are unchanged and still binding: Radix
primitives, the neumorphic `nm-*` surface system, mandatory hybrid borders,
`:focus-visible` rings with offset, press = inset swap, reduced-motion
stripping, and the `--color-status-*` semantic tokens.

What changes is the palette, the accent semantics, and the type system:

- **Themes.** `graphite-honey` → **`slate-steel`** (dark, default, navy
  `#0E1220`); `honey-linen` → **`frost-steel`** (light, `#F4F6FA`). Both IDs
  migrate on read — in `validateThemeId` *and* in the `index.html` FOUC script,
  so a light-theme user does not flash dark before React mounts. Brightness is
  preserved across the migration.
- **Accent semantics inverted from v0.4.** Steel (`#6EA8FF` / `#2F6BD8`) is now
  the single brand **and** interaction accent — primary CTAs, links, active
  states, `--color-ring`. Honey's "AI is involved here" role moves to **violet**
  (`--color-status-ai`, `#C084FC` / `#6D28D9`) — which is a rule about
  *ornament*, not about controls: an AI-labelled affordance you can operate
  still takes steel, because steel is what "operable" means. **Amber is reserved for
  warning/attention only**, which is what makes the ~36 files of literal
  `amber-*`/`yellow-*` warning callouts semantically correct rather than stray
  brand colour — they were deliberately left as-is.
- **`--color-primary-ink`** keeps its v0.4 job only in the light theme, where
  steel-as-text needs darkening (`#2857B3`). In dark, steel clears AA as text
  unaided (7.73:1 on background), so ink and fill are one value.
- **New: `--color-border-interactive`.** v0.4 mandated a 1px border at 3:1 for
  WCAG 1.4.11 but used a single `--color-border` for both separators and
  control edges — measured at **1.60:1** (dark) and **1.28:1** (light), the
  requirement was not actually met. Borders are now split by role: the quiet
  hairline stays `--color-border`; operable surfaces take
  `--color-border-interactive`, measured ≥3:1 on every surface.
- **New: gradient-lit chassis.** `--surface-backdrop` (radial) on the app shell
  and `--surface-card` (linear) on content panes; `nm-card-elevated` takes its
  own `--surface-card-elevated` one step up, so elevation survives in the
  surface and not only in the shadow. Chrome stays flat. Text contrast is
  measured against the *lightest* stop of **both** pane gradients.
- **Consequence: card surfaces are background *images*.** A Tailwind `bg-*`
  utility sets background-*color*, which is painted underneath an opaque
  gradient and does nothing. Card-surfaced controls tint via the new
  `nm-card-hover` utility, which composes the tint as an additional image
  layer. `neumorphic-themes.test.ts` walks the `.tsx` sources and fails on any
  card utility paired with `hover:bg-*` — the failure mode is silent, so it
  needs a guard rather than a convention.
- **All three faces are variable builds.** `font-synthesis: style` forbids the
  browser from faking a weight, and Tailwind's preflight resets headings to
  `font-weight: inherit` — so a static cut set would snap a bare `<h1>` (400)
  and a prose `h1` (800) onto whichever weights happened to be imported.
- **Typography.** Newsreader/IBM Plex Sans → **Space Grotesk Variable**
  (display, headings) + **Inter Variable** (body); JetBrains Mono unchanged.
- **Regression guard strengthened.** `frontend/src/neumorphic-themes.test.ts`
  now parses tokens out of `index.css` and **computes** WCAG ratios instead of
  pinning hex literals, so a bad retune fails with the measured ratio. This
  covers both themes, all status and syntax hues, and both border roles.
  `e2e/contrast.spec.ts` still audits 6 routes × 2 themes.

**Known consequence, accepted:** the app no longer mirrors
`compendiq-landing/src/styles/tokens.css`, so the cross-surface brand parity
that motivated v0.4's palette choice is broken until the landing page adopts
the steel tokens. The brand mark itself was retinted (tile `#151B2C`, glyph
`#E8ECF5`, magnifier strokes steel) across the React `Logo`, the standalone
SVGs, and the generated favicons.

### v0.6 — Graphite / Paper, a flat workspace system (supersedes neumorphism)

**Owner decision (2026-08-06).** Presented with four distinct visual worlds
against the category convention, the owner chose **the convention, executed at
full fidelity**, with **Linear, Plane and Notion** named as the craft bar. This
is recorded as a durable brand commitment in `PRODUCT.md`, not a one-off: future
work does not re-open it with a concept round.

This retires the **neumorphic depth model** that v0.4 introduced and v0.5 kept.
What survives from v0.4/v0.5 and is still binding: Radix primitives, Framer
Motion `LazyMotion`, `:focus-visible` rings with offset, `prefers-reduced-motion`
honoured, the `--color-status-*` semantic tokens, the split border roles, and
the mandatory 1px border on every operable surface for WCAG 1.4.11 and
`forced-colors: active`. **The 1px border matters more now, not less** — there is
no shadow left to fall back on.

- **Themes.** `slate-steel` → **`graphite`** (dark, `#0d0e11`); `frost-steel` →
  **`paper`** (light, `#fbfbfc`). Both are neutral. Retired IDs migrate on read
  in `validateThemeId` *and* the `index.html` FOUC script, preserving brightness
  so a light-theme user does not flash dark before React mounts.
- **Accent.** Steel → **teal** (`#4dd0e1` dark / `#0e7490` light), still the
  single brand *and* interaction colour. Amber stays warning-only; violet stays
  AI. The v0.5 rule that an AI-labelled *control* takes the interaction accent
  (not violet) is unchanged.

  The two values are not one hue at two lightnesses. Dark carries a bright
  cyan-teal because it has to clear 4.5:1 against `#16181d`; Paper carries a
  deep teal because that same bright value measures under 2:1 on white. An
  indigo was trialled first and swapped for teal on owner preference; the
  ratios are computed from the tokens in `workspace-themes.test.ts`, so a
  retune of either fails with the measured number rather than a hex diff.
- **Depth is a value step plus a hairline.** The two-light-source extrusion
  recipe is gone. `--nm-shadow-*` / `--nm-highlight-*` remain declared but
  resolve to `transparent`, so a missed callsite renders flat rather than
  leaving one embossed control behind. Exactly one real shadow exists —
  `--shadow-overlay`, carried by `nm-card-elevated` alone, for content that
  genuinely floats above the page.
- **Chrome is the ground, content is the pane.** Sidebar, header and toolbars
  paint `--color-background`; the content pane sits one step up. This inverts
  v0.4/v0.5, where chrome was the lighter card colour. It is why the document is
  the brightest thing on screen. Consequence: the six
  `[data-theme-type="light"]` shell overrides are deleted — both themes are one
  token-driven ladder, and a light-only override was the mechanism by which the
  two themes drifted apart.
- **Surfaces are flat colours.** The gradient chassis is reverted. A gradient
  under dense 13px text means the same row measures differently at the top of a
  pane than at the bottom, and every surface needs measuring twice. **This also
  reverses v0.5's "card surfaces are background images" consequence**: a
  Tailwind `hover:bg-*` composes normally again, and the trap is designed out
  rather than documented around.
- **No lift, no scale, no glass.** `translateY` on hover and `scale` on press
  are removed from both the utilities and the components. The `--glass-*` tokens
  resolve onto `--color-*`; `backdrop-blur` survives **only** on modal scrims,
  where it is a specific effect rather than decoration standing in for
  hierarchy. 307 fractional `border-border/NN` opacities collapse to one
  measurable hairline, and 56 translucent `bg-card/NN` panes become opaque —
  a translucent pane's text contrast cannot be computed, which is the thing the
  theme tests exist to guarantee.
- **Typography.** Space Grotesk is retired; there is **no display face**. Inter
  carries everything, JetBrains Mono carries code and data figures.
  `--font-display` is an alias onto Inter so existing callsites cannot drift.
  Both remain variable builds for the `font-synthesis: style` reason above.
- **Density.** 32px controls, 28px/13px tree rows, 48px header, 10/8/6/4 corner
  scale, 18px semibold route titles, list rows as rows (`px-3 py-2`) rather than
  cards.
- **The setup wizard's animated gradient mesh is retired.** v0.4 explicitly
  preserved it ("it sits behind the neumorphic surfaces without conflict");
  under a flat system there is nothing for it to sit behind. Three separate
  rules were against it: it was the last gradient in the app and sat on the one
  screen a new operator sees first, so it promised a surface the rest of the
  product does not have; its `rgba(120, 80, 255, …)` was a hardcoded violet, and
  violet means AI here, on a screen that has not asked about a model yet; and it
  animated `background` — a paint property, not a compositable one — on
  `repeat: Infinity` with no `prefers-reduced-motion` guard, for as long as the
  wizard was open. The wizard sits on the chassis like every other surface.
- **Theme preference follows the OS by default** (`system | dark | light`). The
  *preference* is persisted; the resolved palette is not, so a stale value
  cannot win over the live OS reading. `startSystemThemeSync` is gated on
  hydration — an OS event in the gap re-serialised the initial `system` over the
  user's stored choice.
- **Regression guard retargeted.** `neumorphic-themes.test.ts` →
  `workspace-themes.test.ts`. Its computed-WCAG machinery is carried over
  intact; the structural half now fails on a reintroduced shadow, `transform`,
  gradient surface, or light-theme shell override — drift that looks like polish
  in review. `ui-text-legibility.test.ts` enforces an 11px floor.

**Accepted exception:** the 3px `border-left` on `.panel-*` in `.prose` /
`.tiptap` is the rendering of a Confluence panel macro in *document body*
content. Its left rule carries meaning from the source document, and "the source
of record wins" outranks our surface conventions. The equivalent decoration on
app chrome stays refused.

**Cross-surface parity — closed, and the shape of the fix is the point.**
`compendiq-landing` carries Graphite/Paper: same chassis, same teal, same Inter,
`paper`/`graphite` theme IDs. The app is the source of truth and the port went
outward.

Parity is **brand-deep, not rule-deep**. v0.6's flat surfaces, its 10/8/6/4
radii and its single shadow are answers to being a workspace that recedes behind
a document; a marketing page has the opposite job and keeps its radial backdrop
and softer radii. The two surfaces share an identity, not a density.

Three things a token port structurally cannot reach, all of which had silently
survived at least one rebrand:

- **The mark.** Its colours must be literals, because four of its five files are
  static SVGs rendering with no custom properties available (a favicon has no
  document; a maskable icon is rasterised by the OS). Honey survived into steel
  and steel survived into Graphite the same way. `logo-color-parity.test.ts` now
  ties the literals back to `--color-card` / `--color-foreground` /
  `--color-primary` parsed out of `index.css`.
- **A second mark.** The landing page had its own honey raster of a *visually
  different* mark serving as header, footer and favicon. It now serves the app's
  SVGs.
- **The social card.** A PNG, so it stayed honey through two rebrands — cream
  ground, honey underline, serif headline — as the first thing anyone sees when
  a link is shared. It is now generated (`npm run og`) from a template carrying
  the palette literals, and guarded (`npm run og:check`) by content hash rather
  than mtime, since git does not preserve mtimes.

The general lesson: a palette guard that reads only the stylesheet certifies the
part of the brand that was never at risk. Rasters, static SVGs and anything with
a baked literal need their own tie back to the tokens.

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
      --maxmemory-policy noeviction
      --requirepass ${REDIS_PASSWORD}
```

> **Amended:** this ADR originally specified `--maxmemory-policy allkeys-lru`. Adopting BullMQ (`docs/plans/2026-05-04-ee-143-146-design.md`) required **`noeviction`** — evicting queue keys breaks job durability — and the compose file has run `noeviction` since. The snippet above reflects the shipped configuration; do not set `allkeys-lru` to match the original text. The consequence, which ADR-021's `#1183` amendment builds on, is that a full instance rejects **writes** rather than evicting, so exhausting Redis stops job enqueue application-wide.

**PostgreSQL with pgvector**: Using the `pgvector/pgvector:pg17` Docker image which includes the vector extension pre-installed. No separate vector DB service needed.

**Redis**: Hot cache for UI responsiveness (page lists, search results, API responses). TTL-based, and — since the BullMQ amendment above — **without** eviction: entries leave on expiry, never under memory pressure.

**Ollama runs on the host**: Not containerized by us (user manages their own Ollama installation). Accessed via `host.docker.internal`.

**Rationale**: 4 containers keep operational complexity low while providing proper caching (Redis) and vector search (pgvector) capabilities.

---

## ADR-012: RAG Pipeline with pgvector

> **Amended (#1265, #1103, #1104, #1106 — epic #1100):** four parts of the
> pipeline below have evolved. (1) The chunking input is **Markdown from
> `htmlToEmbeddingText(body_html)`**, not stripped plain text — the
> plain-text step made the heading/paragraph strategy unreachable (#1265).
> (2) Retrieval fetch width is decoupled from return width behind the
> `rag_fetch_width` knob with stable-head fusion (#1103). (3) Retrieval is no
> longer "RRF order is the final order": when a provider is assigned to the
> `rerank` use case (ADR-021's #1104 amendment), a **cross-encoder rerank
> stage** re-scores the fused candidate pool on the chat path before the
> final slice, with honest bypass on failure. (4) The vector leg is
> **page-denominated with best-chunk-only fusion** (#1106): a retrieval
> limit counts distinct pages (vectorSearch over-fetches raw chunk rows and
> truncates at the requested page count), and a page's RRF contribution is
> its best chunk's reciprocal rank per leg — per-chunk summing was removed
> on measured head-dilution evidence, making the fusion-score ceiling a
> width-invariant constant; the chat path then reassembles each surviving
> page's sibling chunks into a budget-bounded, best-chunk-anchored context
> window (`rag_context_chars_per_page`, 0 = off) read only by the prompt
> builder — ranking and search snippets keep the best chunk. The embedding
> model/dimensions
> named below are the original defaults; the live pair is DB-configured per
> ADR-021, and the measured recommendation on top of it is the **`#1114`
> amendment at the end of this ADR** — `bge-m3`@1024 is the bootstrap default,
> Qwen3-Embedding-4B@2560 (`halfvec` tier) is what the numbers point at.

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
   Model: bge-m3 (1024 dimensions, multilingual, MIT license)
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
1. Generate question embedding via Ollama (bge-m3)
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
| **bge-m3** (bootstrap default) | 1024 | Fast | Very High | Multilingual, MIT license, best balance |
| nomic-embed-text | 768 | Fast | High | Previous default, still usable |
| snowflake-arctic-embed | 1024 | Fast | High | Alternative option |
| qwen3-embedding:0.6b | 1024 | Medium | Very High | **Not an upgrade** — MMTEB retrieval 80.83 vs `bge-m3`'s 80.76 is a tie |
| **qwen3-embedding:4b** | **2560** | **~10× slower to ingest** | **Highest measured here** | `halfvec` + HNSW tier, no truncation; **measured production recommendation** (#1114) |
| qwen3-embedding:8b | 4096 | Slow | Highest on paper | Above pgvector's `halfvec` HNSW cap → seq-scan tier unless MRL-truncated; rejected, see the `#1114` amendment |

The `qwen3-embedding` row was previously unqualified at 1024, which is only
true of the 0.6B variant — the three sizes are **1024 / 2560 / 4096**, and the
width is what decides the column type and index tier, so the variant has to be
named.

The embedding dimension is configurable via admin settings (`EMBEDDING_DIMENSIONS` env var, default 1024). Users can select
their chat model freely, but the embedding model is a server-wide setting (`EMBEDDING_MODEL` env var).
Changing the embedding model via admin settings triggers automatic re-embedding of all content. This
rebuilds the HNSW index with the new dimensions. This is
a deliberate trade-off: dimension changes require HNSW index rebuilds.

> **Corrected (#1114, 2026-08-16):** the two env vars named in the paragraph
> above are historical. Since ADR-021 / migration 054 the embedding **model** is
> a DB use-case assignment (`resolveUsecase('embedding')`), and `EMBEDDING_MODEL`
> has no effect whatsoever — `llm-provider-bootstrap.ts` keeps it only to log a
> deprecation notice, and nothing reads its value. The **width** is probed from
> the resolved model rather than typed by an operator; `EMBEDDING_DIMENSIONS`
> survives only as the fallback for a missing `admin_settings.embedding_dimensions`
> row. The rest still holds — the pair is server-wide, and a change still means a
> re-embed and an index rebuild — except that since #1116 the non-destructive
> route is the shadow migration rather than the in-place `enqueueReembedAll`. See
> the `#1114` amendment at the end of this ADR.

#### Background Embedding Worker
- Runs as a background task after sync
- Processes pages where `embedding_dirty = TRUE`
- Concurrency limited (max 2 parallel embedding calls to Ollama)
- Progress indicator in UI ("Embedding 42/150 pages...")
- Can be paused/resumed

**Rationale**: Full vector search gives the LLM the best possible context for Q&A. pgvector keeps it in PostgreSQL (no new service). Hybrid search (vector + keyword) handles both semantic similarity and exact term matching. bge-m3 provides multilingual support and is fast enough for incremental re-embedding on sync.

### #1114 (2026-08-16) — the embedding model is dimension-driven, not `bge-m3` by definition

**What changes:** nothing in the pipeline above, and everything about how the
model is written down. `bge-m3`@1024 is the **bootstrap shape** — and the two
halves of that pair reach a fresh install by different routes, which is worth
being exact about, because the ADR's own text above still says both come from
env vars.

- **The width does ship in the schema.** Migration 048 types the column
  `vector(1024)` and writes `admin_settings.embedding_dimensions = '1024'`;
  `getEmbeddingDimensions()` falls back to the deprecated `EMBEDDING_DIMENSIONS`
  env (default 1024) only if that row is missing.
- **The model does not.** `EMBEDDING_MODEL` has had **no effect since migration
  054**: it survives only inside `llm-provider-bootstrap.ts`'s `DEPRECATED_VARS`
  list so that setting it logs a notice — nothing reads its value, and
  `docker-compose.yml` does not even pass it. No migration seeds a `bge-m3` row
  either (054 seeds the `embedding` assignment only from a *pre-existing* legacy
  `admin_settings.embedding_model`, which a fresh install does not have). So on
  a fresh install `resolveUsecase('embedding')` falls through to the default
  provider's `default_model` — whatever that happens to be — until an admin
  assigns the `embedding` use case in Settings → AI Models. `bge-m3` is a
  documented recommendation to pull (`.env.example`: "BGE-M3 via Ollama
  (1024 dims). Run: `ollama pull bge-m3`") that matches the width the schema
  ships, not a value the code injects.

The live pair is `resolveUsecase('embedding')` (ADR-021) plus a width **probed
from the model** (`startShadowMigration` embeds the literal text `probe` and
takes `vectors[0].length`; no operator types a number). This amendment records
the measured recommendation on top of that: **Qwen3-Embedding-4B at 2560
native.**

**Model choice: 4B@2560 native, over 8B+MRL and over 0.6B.** The epic's going-in
choice was Qwen3-Embedding-8B truncated by MRL to 2000, to stay under pgvector's
`vector` HNSW ceiling. Rejected. 2000 is **not an MRL-trained boundary** —
Qwen3's nested sizes are 512/1024/2048 — so the truncation would sit off the
trained manifold, and 2048 needs `halfvec` anyway. Once you are paying the
`halfvec` cost, 4B at its **native** 2560 is strictly less risky than 8B at 2048
truncated: no truncation means the MRL-correctness question is deleted from the
issue rather than answered, at roughly half the GPU footprint, for ~77% of the
8B's paper gain over `bge-m3` (MMTEB retrieval 85.05 vs 86.40 vs 80.76). It also
needs no `dimensions` field on the outbound embeddings body, which stays
`{model, input}`. **0.6B is ruled out explicitly**: 80.83 against `bge-m3`'s
80.76 is a tie, not an upgrade.

**Tier: `halfvec(2560)` + `halfvec_cosine_ops` HNSW.** That is what
`columnTypeFor` returns at this width, and the framing matters — at 2560, fp16
is not a fallback anyone chose, it is **the only indexed representation pgvector
offers**. Measured directly rather than end-to-end (see below): on `kb_eval`,
200 probe vectors, the largest fp16-induced |Δdistance| observed was **2.67e-5**
against a **p01 adjacent-rank gap of 4.44e-5** — the worst rounding error is
smaller than the tightest 1% of rank boundaries in the corpus, so fp16 cannot
reorder what it cannot perturb across a boundary (0/200 top-1 changes). An
end-to-end Recall@K run has **no discriminating power** on this question and
must not be used as the gate: it would report "no difference" whether or not
fp16 were harmful. (Caveat as stated in #1114: measured at 768 dims with
`nomic-embed-text`, on real corpus vectors, not at 2560 with Qwen3.)

**Query-side instruction prefix (#1329, completed by #1335).** Qwen3's embedding
family is trained asymmetrically — a QUERY carries `Instruct: {task}\nQuery:{query}`
(no space after `Query:`), a DOCUMENT is embedded bare. `query-instruction.ts`'s
`formatQueryForEmbedding` wraps **both** query-side `generateEmbedding` calls,
keyed off the **resolved** model, so it turns on exactly when a swap makes Qwen3
live and off again on rollback with no second setting to keep in step: the
vector leg in
`rag-service.ts` (`/llm/ask`, and `/api/search?mode=hybrid` through
`hybridSearch`), and `routes/knowledge/search.ts`, which embeds the query itself
for `/api/search?mode=semantic` rather than delegating. Documents are bare under
every model, so the stored corpus is byte-identical either way and **flipping it
needs no re-embed**.

That second site was missed by #1329 and shipped bare — filed as **#1339**, and
inert only because `bge-m3` is not instruction-aware, so it would have become a
silent retrieval regression on exactly the swap this amendment recommends.
**#1335** applied the prefix there and rebuilt the structural guard, which had
scanned `domains/llm/{services,eval}` only and so certified a claim it had never
looked at. `query-instruction.test.ts` now walks all of `backend/src` and
`backend/scripts` and requires every `generateEmbedding` caller to be either one
of the two query sites or named in a commented allow-list of non-query embeds
(index-time, the eval seeder, the admin width probe, the eval harness's width
probe). It is therefore no longer a prerequisite of the swap.

**Measured, on #1102's 197-query fixture, plain runs, no rerank, every arm
scored with `admin_settings.fts_language` = `simple`.** Significance
columns are McNemar exact on the paired per-query hits, except MRR, which is a
graded score and gets a paired bootstrap CI instead. **The DE column was
re-measured under `german` on 2026-08-16 — see the resolved caveat below; only
the R@1 verdict changed:**

| | EN bge-m3 | EN Qwen3-4B | EN significance | DE bge-m3 | DE Qwen3-4B | DE significance |
|---|---|---|---|---|---|---|
| Recall@1 | 0.6091 | 0.6599 | **p = 0.174 — not established** | 0.6091 | 0.6904 | p = 0.026 under `simple` — **superseded: not established** (p = 0.088 under `german`) |
| Recall@3 | 0.7919 | 0.9086 | p = 0.00003 | 0.7817 | 0.8680 | p = 0.0023 |
| Recall@5 | 0.8477 | 0.9289 | p = 0.0015 | 0.8528 | 0.8985 | p = 0.12 |
| Recall@10 | 0.9137 | 0.9645 | p = 0.013 | 0.8883 | 0.9492 | p = 0.0075 |
| MRR | 0.7131 | 0.7839 | CI [+0.025, +0.115] | 0.7119 | 0.7878 | CI [+0.0302, +0.1218] |

**Say the English R@1 result out loud, because the mean flatters it.** +0.051
reads like the headline, but paired by query it is 27 wins against 17 losses —
heavy churn for a five-point gain — and both the exact test (p = 0.17) and the
bootstrap CI (crosses zero) decline to call it. **In English, Qwen3 has not been
shown to improve the top-1 answer**; everything at K≥3 is solid. On the German
translation of the same corpus (#1332, content held constant so only the
language varies) R@1 measured +0.081 at p = 0.026, which read as the English
run understating the benefit on the result users see first — production content
being German. **Superseded on 2026-08-16:** the re-run under `german` puts that
cell at p = 0.088, and top-1 is unestablished in *both* languages. See the
resolved caveat below. Read the per-K p-values with care either way: four correlated
tests per language, and DE R@5 at p = 0.12 sitting between two clearly
significant neighbours reads as sampling noise. What is robust across both
languages: every delta is positive and the MRR interval excludes zero in both.

**Caveat, now RESOLVED (2026-08-16).** Every German number in the table above
was scored with `admin_settings.fts_language` = `simple`, so the lexical leg did
no German stemming or decompounding. (The setting is that row, edited in
Settings → AI Models → Retrieval and pinned per run by the eval's
`--fts-language`. The `FTS_LANGUAGE` env var these runs predate was inert on
every migrated instance and is retired — #1114; naming it here would send a
reader to a variable the product ignores.) Both arms were re-run on the same 275-page corpus
under `--fts-language german` (same `corpusManifestSha`, same 197 `queryId`s,
scored by the repo's own `metrics.ts`), and the answer is **no detectable
effect**: R@10 came back **bit-identical query-for-query on both models** — 197
ties, zero movement, so the stemmer never changed *which* pages reached the top
ten — and the only nominally significant cell in either arm (Qwen3 R@1, 1W/8L,
p = 0.039) rests on nine discordant queries, dies under a Bonferroni ×4
correction and has no partner on the other model. Plausibly because this is
technical German **translated from English OSS documentation** — content held
constant by construction — where identifiers, loanwords and code tokens carry
the lexical match and `simple` already does exact-token work; that is a
post-hoc reading, not something the runs tested. **The provenance travels with
the conclusion**: a translation holds less of the compounding and inflection a
German stemmer exists to fold than natively-authored pages, so what this
establishes is that `german` is not an assumable recall upgrade, not that it is
inert on a German-authored corpus. See *On the stemmer null result, and how far
it travels* in `docs/runbooks/shadow-reembed.md`.

**Two corrections follow, and they point in opposite directions.**

1. **The model gap survives the stemmer, and is the sturdy part.** Re-measured
   with `german` on both sides, Qwen3 is ahead at every K and on MRR
   (+0.061 / +0.081 / +0.056 / +0.061, MRR +0.065), and **R@3 (p = 0.0037) and
   R@10 (p = 0.0075) clear significance even after Bonferroni ×4** — the same
   two cells that carried it under `simple` (p = 0.0023 and p = 0.0075). So the
   comparison in the table was not an artefact of scoring German text under
   `simple`.
2. **German R@1 is NOT established.** Under `german` it is 27W/15L, p = 0.088
   (CI [−0.005, +0.127]) where under `simple` it was 31W/15L, p = 0.026. The
   point estimate barely moved (+0.081 → +0.061), so this is not the stemmer
   eroding the gap — it is a reminder that R@1 was always the weakest of the
   four numbers quoted above. **Neither value survives a ×4 multiplicity
   correction** (0.026 × 4 = 0.104), and on the `simple` run's 46-query
   discordant set a *single* query flipping the other way (30W/16L) already
   takes it to p = 0.054. **Top-1 is therefore unestablished in BOTH
   languages**, which is what the shipped benchmark panel now renders
   (`embedding-benchmarks.ts`, `established: false` on both).

Sources: the #1114 comment *German re-run under `fts=german`*, and
`docs/runbooks/retrieval-eval.md`, which carries both configurations' tables.

**The counterweight is ingest cost: ~10× slower.** Embedding the same 2,198
chunks took **36m 13s** against `bge-m3`'s **3m 31s** (~1 chunk/s vs ~10). The
`german` re-run reproduced it independently on a full re-seed of the 275-page
corpus: **40m 55s** against **4m 21s**, ~9.4×. On a
real corpus that is the dominant cost of the cutover, which is why the swap is a
scheduling decision run through **#1116's shadow path** — dual-write plus
background backfill plus an atomic rename — and not `enqueueReembedAll`, whose
`TRUNCATE` leaves RAG on keyword fallback and `page_avg_embedding` NULL until
the last page re-embeds, with the old vectors gone.

**`bge-m3` stays the default.** This amendment is a recommendation with numbers
behind it, not a change of shipped behaviour: a fresh install still lands on
`vector(1024)` with `bge-m3` as the model the docs tell an operator to pull, and
opting into 2560 is a deliberate act — Settings → AI Models plus the shadow
migration.

**Was open, and explicitly not settled by the numbers above.** Items 1 and 2
were answered on 2026-08-16 and are kept here with their results and their
limits rather than deleted, because what each measurement does *not* cover is
the part a production swap has to plan around. **The proposed go/no-go and
revert criteria that consume all of this live in
`docs/runbooks/shadow-reembed.md`** (*Cutover to Qwen3-Embedding-4B*) — they
are proposals until the owner agrees them, and #1114 asks for that agreement
**before** a re-embed starts.

1. **Query-time latency at 2560** — **measured 2026-08-16, on a dev rig only.**
   `backend/scripts/benchmark-query-latency.ts` puts the model gap at roughly
   **12× on the embedding call** at concurrency 1 (224 ms vs 18 ms p50) and ~8×
   end-to-end. The concurrency rungs above 1 do **not** answer the "realistic
   concurrency" half: LM Studio serialises inference, so p50 rises almost
   exactly linearly with in-flight requests (×3.5 at 4-wide, ×8.0 at 8-wide) —
   those rungs measure queue depth, not request cost. **A batching server has a
   different shape, and an operator must measure their own endpoint**; the
   runbook's pre-flight (i) is that step. Table in
   `docs/runbooks/shadow-reembed.md`.
2. **`ef_search` sizing at 2560** — **measured 2026-08-16 on a 2,377-chunk
   corpus** (the same 275-page German corpus as above; 2,377 counted directly
   out of `page_embeddings` in that session, while the **2,198** quoted for
   ingest cost is the earlier run's count — the two are not reconciled, and
   which figures ride on which is set out in *On the chunk count* in
   `docs/runbooks/shadow-reembed.md`). `halfvec(2560)` HNSW is effectively
   exact from `ef_search` = 40:
   recall@10 = 0.9995 at the `RAG_EF_SEARCH` default of 100 and *identical* at
   200, 240, 400 and pgvector's 1000 ceiling, with the single non-matching row
   a 7×10⁻⁷ distance tie inside halfvec's own fp16 noise. Leave the default
   alone; the number that moved is **footprint** — 18.6 MiB of HNSW for 2,377
   vectors, 8.2 kB per vector, larger than heap and TOAST combined, scaling
   linearly with chunk count. **Still open inside this item:** HNSW **build**
   time, unmeasured at any scale (that session built no index), and cache
   behaviour — all 35 MiB fit in a 128 MB `shared_buffers`, so the timings are
   CPU-only and the planner's index-vs-seqscan choice will flip as the corpus
   grows. None of it licenses extrapolating to a corpus two or three orders of
   magnitude larger without re-measuring. Source: the #1114 comment
   *`ef_search` at `halfvec(2560)`*; caveats carried in
   `docs/runbooks/shadow-reembed.md`.
3. **Cosine constants calibrated on `bge-m3` must be re-checked after a swap.**
   Similarity scores are not comparable across embedding models, and three
   places read a raw cosine against a number chosen under `bge-m3`:
   `ConfidenceBadge`'s High/Medium/Low ladder at 0.7 / 0.4
   (`frontend/src/shared/components/badges/ConfidenceBadge.tsx:14`, whose own
   comment already says "calibrated for bge-m3; may need adjustment for other
   models"); `SIMILARITY_THRESHOLD = 0.4` for knowledge-graph relationships
   (`backend/src/domains/llm/services/embedding-service.ts:1305`); and #1105's
   refuse gate, where `rag_confidence_threshold` is compared against the
   `similarity` basis produced by `retrieval-confidence.ts` — an operator-set
   value rather than a literal, which makes it *worse*, not better: a swap
   leaves the number where the operator tuned it while silently changing what it
   means. The observable symptoms are the refusal rate, the badge distribution
   and the graph's edge count, none of which fail loudly.
4. **Rerank interaction** — every run above is plain. #1104's cross-encoder
   stage was not live.

A fifth item stood here — `/api/search?mode=semantic` embedding the query
without the prefix (**#1339**) — and it is **closed**: #1335 applied the prefix
at that call site and widened the structural guard to the whole backend, so the
asymmetry is now enforced app-wide rather than at one remembered call. See the
query-side prefix paragraph above.

### #1115 (2026-08-17) — a third retrieval leg, over a separate image index

ADR-025 adds a **third leg** to the fusion described above (landing in **P3**):
alongside the vector leg over `page_embeddings` and the keyword leg over
`pages.tsv`, an image leg does kNN over `page_image_embeddings` — a separate
table, embedded by a separate vision-language model, under the same visibility
predicate as the other two. It runs only when the `image_embedding` use case is
assigned, the table is non-empty and `rag_image_leg_enabled` is on; otherwise
there is no query embed and no added latency.

Three properties keep it from disturbing what is already here:

1. **It fuses by RANK, never by score.** Published cross-modal similarities sit
   in a different absolute band than text↔text ones (roughly 0.46–0.72 vs
   0.75–0.81 in the model card's own tables), so any score-space arithmetic
   across the two — a weighted blend, a shared cutoff — is meaningless. RRF only
   ever sees positions. Page-denominated like #1106: a page's best image rank
   counts once.
2. **It never feeds the confidence number.** `retrieval-confidence.ts` compares
   an operator-tuned scalar against a text-cosine distribution; an image
   similarity on that scale is a different unit wearing the same name. An
   image-only hit set therefore has basis `none` and never refuses — the
   treatment keyword-only hits already get — and the `sources[]` entry for an
   image carries `similarity: null` so the badge's sample stays honest.
3. **The stages after fusion are untouched.** Rerank, the ranking prior, MMR and
   sibling assembly all operate on `chunkText`; image rows carry none, so they
   are invisible to all four rather than specially handled in each.

Failure is honest in the shape #1104 established: a VL call that fails, times
out or meets an open breaker bypasses the leg, records
`degraded_reason = 'image_leg_unavailable'`, and leaves `searchTypeFinal` and
the text legs exactly as they were.

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

### Decision: **BullMQ (Redis-backed) primary; legacy `setInterval` behind `USE_BULLMQ=false`**

All recurring background work runs on BullMQ queues, registered in `backend/src/core/services/queue-service.ts`. Each queue gets a dedicated `Worker` with its own concurrency, and a repeatable-job scheduler drives it at a configurable cadence. A feature flag (`USE_BULLMQ`, default `true`) gates the behaviour: setting `USE_BULLMQ=false` falls back to the legacy `setInterval` code path, which remains in tree as a single-process escape hatch for dev environments where Redis is unavailable.

```typescript
// queue-service.ts (excerpt)
registerWorkerDef({
  queueName: 'sync',
  concurrency: 3,
  repeatPattern: { every: syncInterval * 60 * 1000 },
  processor: async () => {
    const { runScheduledSync } = await import(
      '../../domains/confluence/services/sync-service.js'
    );
    const result = await runScheduledSync();
    return `Synced ${result} users`;
  },
});
```

#### Queue inventory

| Queue | Concurrency | Schedule | Purpose |
|-------|-------------|----------|---------|
| `sync` | 3 | `SYNC_INTERVAL_MIN` (15 min) | Confluence delta sync |
| `quality` | 2 | `QUALITY_CHECK_INTERVAL_MINUTES` (60 min) | Quality scoring batch |
| `summary` | 2 | `SUMMARY_CHECK_INTERVAL_MINUTES` (60 min) | Summary generation batch |
| `maintenance` | 1 | `TOKEN_CLEANUP_INTERVAL_HOURS` (24 h) + 24 h data-retention | Token cleanup + retention |
| `reembed-all` | 1 | on-demand (#257) | One-shot reembed-all run, admin-triggered |
| `analytics-aggregation` | — | registered-only | Reserved for EE analytics workers |

Worker definitions live in `registerAllWorkers()` (`queue-service.ts:337–429`). Job history is persisted to the `job_history` table on every completion / failure (`queue-service.ts:63–81`).

#### Why BullMQ over the old `setInterval`

- **Multi-process safety.** The embedding path uses a Redis SET-NX lock (`redis-cache.ts:55–71`); PR #261 adds per-user lock visibility. In-memory `let running = false` flags don't generalise.
- **Job history and observability.** BullMQ's `Worker` events + `recordJobHistory` sink give admins a real audit trail; dashboard consumes via `getQueueMetrics()`.
- **On-demand jobs.** The `reembed-all` queue (#257) is a one-shot job admin UI triggers via `enqueueJob('reembed-all', …)` and polls via `getJobStatus(jobId)`. `setInterval` can't express "run once, now, track progress".
- **Feature-flag escape hatch.** `USE_BULLMQ=false` keeps the legacy path alive for envs without Redis.

#### Superseded rationale (preserved for audit trail)

The original ADR argued for `setInterval`:

> *4-15 users, ~1000 pages total. A simple interval is sufficient.*
> *No distributed workers needed (single backend instance).*
> *Redis-based job queues add complexity for zero benefit at this scale.*

That argument no longer holds as of issue #256 (multi-LLM-provider) and #257 (admin-triggered reembed-all). On-demand jobs, multi-provider fan-out, and per-user lock visibility can't be absorbed without re-inventing a queue. Paragraphs retained so the decision trail stays auditable.

#### Legacy worker inventory (USE_BULLMQ=false fallback)

| Worker | Interval | Batch Size | Model Env Var | Retry Limit |
|--------|----------|------------|---------------|-------------|
| Sync | `SYNC_INTERVAL_MINUTES` (15) | All changed pages | N/A | N/A |
| Embedding | After sync | All dirty pages | `EMBEDDING_MODEL` | N/A |
| Re-embed-all (#257) | On-demand via `POST /api/admin/embedding/reembed` | All non-folder pages | `EMBEDDING_MODEL` | No automatic retry (fixed `jobId='reembed-all'` collapses concurrent POSTs; admin can re-trigger after completion) |
| Quality Analysis | `QUALITY_CHECK_INTERVAL_MINUTES` (60) | `QUALITY_BATCH_SIZE` (5) | `QUALITY_MODEL` → `DEFAULT_LLM_MODEL` → `qwen3:4b` | 3 (`quality_retry_count`) |
| Summary | `SUMMARY_CHECK_INTERVAL_MINUTES` (60) | `SUMMARY_BATCH_SIZE` (5) | `SUMMARY_MODEL` → `DEFAULT_LLM_MODEL` | 3 (`summary_retry_count`) |

#### Legacy worker lifecycle (USE_BULLMQ=false fallback)

Describes the `setInterval` path only; the primary BullMQ path is driven by the repeatable-job scheduler and `Worker` events documented above.

1. **Startup**: `startXxxWorker()` called from `index.ts`, registers `setInterval`
2. **Initial batch**: Runs 30 seconds after startup via `triggerXxxBatch()` (lock-guarded)
3. **Interval batches**: Every N minutes, processes up to BATCH_SIZE pages
4. **Priority**: Pending pages first, then stale/changed content, then failed (with retries remaining)
5. **Shutdown**: `stopXxxWorker()` called on SIGTERM/SIGINT, clears interval

#### Quality Analysis Worker

Scores articles across 6 dimensions (overall, completeness, clarity, structure, accuracy, readability) by sending content to the LLM with a structured prompt. Results stored in `cached_pages` columns. Pages with changed content (`last_modified_at > quality_analyzed_at`) are automatically re-analyzed. Status: `pending → analyzing → analyzed | failed | skipped`.

#### Summary Worker

Generates plain-text and HTML summaries by sending article content to the LLM. Detects content changes via SHA-256 hash comparison (using PostgreSQL built-in `sha256()`, no pgcrypto extension needed). Status: `pending → summarizing → summarized | failed | skipped`.

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
- **Embedding model**: server-wide (`EMBEDDING_MODEL` env var, default `bge-m3`). Configurable dimensions via `EMBEDDING_DIMENSIONS` (default 1024).
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

## ADR-021: Multi-LLM-Provider Configuration

### Context
Until this ADR the app supported exactly two LLM backends selected by the `LLM_PROVIDER` env var (`ollama` | `openai`) with the credentials and model name stored as scalar rows in `admin_settings`. Operators who wanted to point different use-cases (chat, summary, quality, auto-tag, embedding) at different backends had no way to express that without editing the source. The design spec at `docs/superpowers/specs/2026-04-20-multi-llm-providers-design.md` captures the full requirements gathering.

### Decision: **`llm_providers` table + per-use-case assignments + OpenAI-compatible client everywhere**

**Providers are rows, not env vars**: The new `llm_providers` table (migration 054) stores one row per configured upstream endpoint (`id`, `name`, `base_url`, `api_key` (AES-256-GCM encrypted), `auth_type`, `verify_ssl`, `default_model`, `is_default`). Admins CRUD these in Settings → AI → AI Models. Ollama is just an OpenAI-compatible provider whose base URL points at the local Ollama server — no separate client library.

**Per-use-case assignments**: The new `llm_usecase_assignments` table maps each of `chat | summary | quality | auto_tag | embedding` to a `(provider_id, model)` pair. Either field can be `NULL` to inherit from the provider's default or the globally-default provider. The resolver (`llm-provider-resolver.ts`) combines both inheritance paths in a single cached lookup.

**Unified client**: `openai-compatible-client.ts` replaces both `ollama-service.ts` and `openai-service.ts`. It queues requests (`LLM_CONCURRENCY`) and wraps calls in per-provider circuit breakers. Rate-limit and retry behavior is per-provider, not per-call-site.

**Embedding dimension safety**: Changing the embedding model to one that returns a different vector length is a destructive operation gated by the `/admin/embedding/probe` + `/admin/embedding/reembed {newDimensions}` flow with a two-step confirmation banner in the UI. The reembed transaction picks a column type + index strategy from the requested dimension count (pgvector 0.8 caps: HNSW on `vector` ≤ 2000 dims; HNSW on `halfvec` ≤ 4000 dims):

| Dimensions  | Column type   | Index                                           |
|-------------|---------------|-------------------------------------------------|
| `n ≤ 2000`  | `vector(n)`   | HNSW `vector_cosine_ops` (default tier)         |
| `2001–4000` | `halfvec(n)`  | HNSW `halfvec_cosine_ops` (float16, ~50% size)  |
| `n > 4000`  | `vector(n)`   | no index (sequential scan; warning logged)      |

The DDL order inside the transaction is `TRUNCATE` → `DROP INDEX IF EXISTS` → `ALTER COLUMN TYPE` → `INSERT/UPDATE admin_settings.embedding_dimensions` → `CREATE INDEX` (skipped for the seq-scan tier). Dropping the index before the `ALTER` is mandatory: the old index is bound to its opclass (`vector_cosine_ops`), which Postgres tries to rebuild on the new column type and rejects when the new type is `halfvec` or the new dim exceeds the opclass cap. The validator caps `newDimensions` at `1..16000` (pgvector's absolute max for both `vector` and `halfvec`); pgvector implicitly casts vector literals to `halfvec` on the `<=>` operator, so RAG retrieval needs no per-tier code paths.

**First-boot seed**: `llm-provider-bootstrap.ts` seeds one row from legacy env vars (`OLLAMA_BASE_URL`, `OPENAI_BASE_URL`, …) when `llm_providers` is empty. On subsequent boots the env vars are ignored.

### Alternatives Considered
1. **Keep two-slot `llm_provider='ollama'|'openai'` enum** — rejected because it blocks multi-endpoint deployments (e.g. production chat + a sandboxed summary model on a GPU host).
2. **Multiple concrete clients (one per provider family)** — rejected because every major provider exposes an OpenAI-compatible API; maintaining three code paths triples the test surface for no gain.
3. **Resolver on every call-site** — rejected; the resolver is one function in one service, queued requests share a client instance, and per-provider circuit breakers live inside the client.

### Consequences
- Every LLM route now calls `resolveUsecase(usecase)` instead of reading `admin_settings.llm_provider`; the resolver cache is busted on provider writes via `llm-cache-bus.ts`.
- The legacy `llmProvider`, `ollamaModel`, `openaiModel`, `openaiBaseUrl`, `openaiApiKey`, `embeddingModel` fields were removed from the `admin_settings` row (migration 054 + `AdminSettings` contract in `packages/contracts`).
- Deleting a provider that's assigned to any use-case returns HTTP 409. The default provider cannot be deleted.
- Embedding dimension changes are irreversibly destructive (TRUNCATE `page_embeddings` + `ALTER TABLE` + rebuild HNSW); the UI requires explicit confirmation.
- Frontend settings page uses three new components: `ProviderListSection`, `UsecaseAssignmentsSection`, `EmbeddingReembedBanner`, composed from `LlmTab.tsx`.

### #1154 — image input and model capability

**Context:** #1154 lets a user attach a screenshot, diagram, or photo to Generate/Improve as source material — Option B ("a vision-capable model") from the issue, with the OCR fallback explicitly rejected (see `docs/superpowers/specs/2026-07-29-image-ai-source-material-design.md`). `ChatMessage.content` (canonical in `domains/llm/services/prompts.ts`) widens to `string | ChatContentPart[]`, the OpenAI-compatible content-part shape Ollama's `/v1` shim also accepts — no new protocol, consistent with this ADR's "the shim is not a separate protocol" rule.

**Capability is per `(provider_id, model)`, never per provider.** One host commonly serves both a vision model and a text-only one behind the same base URL, and use-case assignments already pin `provider+model` — so `llm_model_capabilities` (migration 087) is keyed the same way, with `ON DELETE CASCADE` to `llm_providers` (unlike `llm_usecase_assignments`' `ON DELETE RESTRICT`): capability is derived data that should vanish with its provider, not user configuration that should block the delete.

**Capability is probed, not declared.** An OpenAI-compatible `/v1/models` response carries no capability field, and Ollama's capability data lives on native `/api/show` — off-limits under this ADR's shim rule. `vision-probe.ts` sends a committed three-band PNG (yellow/purple/green, deliberately not red/green/blue — the sequence a blind guesser is likeliest to emit) with a prompt constraining the reply to naming the bands in order. Only a reply that does so counts as `true`; the read path (`getVisionCapability`) never blocks a request on a probe — it returns the stored verdict immediately and schedules a background refresh, bounded by in-flight de-duplication per `provider+model` and a cooldown, so a model stuck at `null` cannot fire a probe on every request.

**`null` means undetermined, and is refused.** Verdicts are `true` (the model demonstrably read the pixels); `false` only for a response that definitively rejected the image part or a 200 that ignored it; `null` for everything else, including 5xx, network errors, an open circuit breaker, and every other 4xx. "Definitively rejected" is deliberately narrow: **415 on its own** (Unsupported Media Type has no other reading), and **400 or 422 only when the response body actually mentions the image**. `chat()` throws `LlmHttpError`, which carries the status and a truncated slice of the provider's body as *fields* precisely so this decision can be made without re-parsing a human-readable message — and so the body stays off `message`, which `pages-tags.ts` surfaces to callers.

422 gets the same body condition as 400 rather than counting on its own, which reads stricter than it is: 422 is pydantic's default for **any** request-body validation failure, so every FastAPI-based OpenAI-compatible server (vLLM, LocalAI, llama-cpp-python) answers 422 for an unrecognised field — including `max_tokens`, which the probe itself sends, and whatever `thinkingExtras` adds. A bare 400 or 422, or one saying `Unsupported parameter: 'max_tokens'` / `maximum context length` / `invalid role` / `extra fields not permitted`, falls through to `null` — those come back from fully vision-capable models, and 429/401/403/404/413 say nothing about image support at all.

A `false` verdict is **cached, not permanent**: it is re-probed once the row passes `CAPABILITY_MAX_AGE_DAYS` (30), which is the only thing that bounds a misclassification. That window is why these rules have to be this careful — the cost of getting one wrong is a capable model treated as blind for a month, not for one request. `null` must never be conflated with `false`: `/llm/generate` and `/llm/improve` fail closed on `imageHandle`, returning 422 unless the resolved `chat` model's capability is exactly `true` — the same rule the composer's own gate uses, so the backend never trusts a client-side check it cannot verify.

**Staged images are bounded, because Redis is shared and `noeviction`.** The same instance backs BullMQ, the LLM response cache, the embedding locks and the cache-bus, and is deployed with `--maxmemory 256mb --maxmemory-policy noeviction` — a full instance rejects **writes**, so an unbounded staging namespace is an application-wide job-enqueue outage rather than merely wasted memory. Three properties keep it bounded: only the newest handle per user survives (pruned with a `SCAN` cursor walk — never `KEYS` — immediately after the write), so the ceiling is `users x MAX_IMAGE_BYTES` rather than `uploads x MAX_IMAGE_BYTES`; the value is the raw bytes behind a short ASCII `<format>\n` header instead of base64 inside JSON; and the write is pre-flighted against Redis's own memory reading (**#1183**, next paragraph). A staged value that does not parse is a **miss** (410), and an unreachable Redis on the *read* path is a **503**, not a 410 — telling a user to re-attach when the store is down sends them into a retry that cannot succeed.

**#1183 — the staging write is pre-flighted, and the byte ceiling is 5 MB.** The per-user cap above is a mitigation, not a bound: `users x 10 MB` filled the shipped 256 MB with roughly 26 people uploading inside one TTL window, which is a plausible Tuesday rather than an attack. So `stageImage` reads `INFO memory` and refuses with **503** when `used_memory + incoming` would exceed `IMAGE_STAGING_MAX_REDIS_PERCENT` (default **80**) of `maxmemory` — the remaining fifth is headroom the co-tenants keep writing into. The rejected upload writes nothing and the message names the 15-minute expiry, so the user has something to wait for. This is the whole point of the change: exhaustion degrades **one feature** instead of failing job enqueue for sync, re-embed, summary and quality alike — wherever Redis answers `INFO`, which is the condition the fail-open note below makes explicit. Even there the pre-flight is check-then-write, not a reservation: concurrent uploads inside the read-to-write window all pass on the same pre-write `used_memory`, so a burst can collectively overshoot the headroom — the percentage is a soft target under concurrency, not a hard guarantee.

Three decisions inside that are not obvious. **It fails open, so the bound is conditional on `INFO` being readable.** `maxmemory: 0` means unlimited and passes; an unreadable or missing `INFO` passes too, because `INFO` is renamed or ACL-blocked on plenty of hardened and managed deployments and an unreadable reply is not evidence that memory is short — failing closed would 503 the feature permanently on a healthy instance. Be precise about what that costs, because it is easy to overstate: per *request*, the write is its own backstop — a full `noeviction` instance rejects the `SET` with `OOM`, that reply maps to the same error, and the caller gets the clean 503 one round-trip later instead of a 500. Per *deployment*, it is weaker than that. Where `INFO` is unreadable the 80% ceiling never engages, staging is admitted until Redis is hard-full, and by the time the `OOM` backstop fires the co-tenant headroom this change exists to preserve is already gone — BullMQ enqueue is failing alongside it. **On such a deployment #1183 reverts to the pre-existing mitigation (`users x MAX_IMAGE_BYTES`), not to a bound, and the operator has to watch `used_memory` themselves.** `.env.example` says so at the knob; treat a renamed `INFO` as a monitoring obligation rather than a solved problem. **It is not cached.** One `INFO` is O(1) on a path that already streams megabytes through multipart, hashes them and `SET`s them, so a cache saves nothing measurable — while a stale "there is room" admits every upload inside the window on one reading, which is the exact overshoot being prevented. **No separate staged-bytes counter.** A counter cannot be decremented by a TTL expiry without keyspace notifications, so it drifts upward until it wedges the feature permanently; a `SCAN` + `MEMORY USAGE` sweep per upload walks a keyspace shared with BullMQ. `used_memory` measures the thing that actually matters — including co-tenant growth, which a staging-only counter cannot see.

`MAX_IMAGE_BYTES` drops 10 MB → **5 MB** as the complementary half. It is the only *memory* ceiling of the two: it bounds the staged entry and the ~1.37x base64 inflation `resolveImagePart` holds for the life of a stream (`1.37 x 5 MB x streams`, so ~21 MB per actively-streaming user at the SSE limiter's default of 3, down from ~41 MB — higher transiently during dispatch, and higher again wherever an admin has raised that cap, which `sse-stream-limiter.ts` allows up to 20), and 5 MB is the smallest per-image limit any mainstream vision API accepts. `MAX_IMAGE_DIMENSION` deliberately **stays 4096**: dimensions bound what the model is asked to look at, not what Redis holds, and 4096 remains reachable in the formats this feature uses (a 4096×4096 WebP, or a JPEG at moderate quality, typically lands under 5 MB — a maximum-quality JPEG of detailed content at 16.7 MP can still exceed it, which is why the 413 names lowering the quality too). Cutting it to "restore coherence" would refuse 4K screenshots from direct API callers and save no memory. Lossless PNG at full dimensions is the case that meets the byte ceiling first and most reliably. The UI is unaffected either way — `downscale-image.ts` re-encodes every attachment to WebP within a 1568px edge, one to two orders of magnitude below the cap — so this binds direct API callers only.

**Prompt injection rendered as pixels is unmitigated, and accepted.** `core/utils/sanitize-llm-input.ts` operates on text; instructions drawn into an image reach the model untouched, and there is no mitigation short of an OCR pass — which this design rejects outright as the fallback path. This is a stated limitation, not an oversight: the residual risk is accepted in exchange for not degrading screenshots and diagrams (the feature's core use case) to OCR fragments.

---

### #1104 — the `rerank` use case

ADR-021 is amended to add a sixth use case, `rerank`, to the provider model.
Reranking is an outbound, provider-routed LLM call that inherits the same
queue, per-provider circuit breaker, and per-use-case provider/model
assignment as the existing five. Unlike the others it targets a `/v1/rerank`
endpoint (Cohere/Jina/TEI shape), which is **not** OpenAI-compatible; it is
therefore implemented as a distinct client (`rerank-client.ts`, sharing the
request infrastructure via `providerRequestInfra`) rather than through
`openai-compatible-client`'s chat/embeddings paths. The supported shape is
Cohere/Jina-style `/v1/rerank` (llama.cpp's `llama-server --rerank` serves
it, verified live); **TEI's bare `POST /rerank` with `{query, texts}` and an
array response is NOT compatible** — a TEI adapter would be its own
decision. Note the circuit breaker is keyed per PROVIDER, not per use case:
pointing rerank at a provider that also serves chat/embedding means rerank
failures can open the shared breaker for those too — assign rerank its own
provider row when that isolation matters. This **narrows, not
reverses,** Alternative 2's "every provider is OpenAI-compatible" premise —
it holds for chat/embeddings, not for rerank.

**Resolution semantics differ deliberately:** an unassigned `rerank` use case
means the rerank stage is **disabled** (`resolveRerankUsecase` → null) —
never "inherit the default provider". The default provider speaks
`/chat/completions`; handing it `/v1/rerank` traffic would break retrieval
the moment an admin configured a default. Enterprise org-policy overrides do
not apply either, for the same shape reason. The settings grid renders the
unassigned state as "Disabled (no reranking)".

**Egress decision (the PII question #1104 raised):** an active rerank stage
ships up to `rag_rerank_candidates` (≤ 100) truncated candidate chunks per
query to the assigned provider. Candidates pass through `sanitize-llm-input`
first (same prompt-injection guard as chat context). Rerank joins **neither**
PII-policy list: not the scan call sites (like `embedding`, it is a
corpus-infrastructure path — bulk KB egress is governed by provider choice,
i.e. assign a local/trusted endpoint where that matters) and not the
judge-billing dropdown (judge calls are chat-shaped; a rerank endpoint cannot
serve them).

**Failure is honest, and the budget aborts:** `RERANK_TIMEOUT_MS` is
enforced inside the client as an AbortSignal spanning queue wait plus the
request, so an expired budget frees its global LLM-queue slot immediately
and counts as a breaker failure — a persistently slow reranker trips the
breaker and the stage self-disables for the cool-down instead of paying
full cost for bypassed results (measured: pool 30 at 4 concurrent requests
already grazes a 5s budget on fast local hardware). On any error or expiry
the stage is bypassed — the fused order is served, analytics record plain
`hybrid` (never `hybrid_rerank`), and no score is faked or renormalised.
One consequence worth knowing: a reranked and a bypassed run of the same
question can retrieve different top-K sets, and the chat cache keys on doc
ids — the two legitimately cache as separate entries. `search_analytics.rerank_score` (migration 088) gets its first
writer; `max_score` keeps the fusion unit.

### #1115 — the `image_embedding` use case (Phase 2)

ADR-021 gains a **seventh** use case, `image_embedding` (ADR-025). Migration
`093` widened the `llm_usecase_assignments` CHECK in **P0**; the resolver, the
client, the probe and the settings row land in **P1**.

**It is the `rerank` rule, one rung stronger.** `resolveImageEmbeddingUsecase()`
returns `null` when unassigned and the image leg is simply off; `resolveUsecase('image_embedding')`
throws, exactly as it does for rerank. The reason to refuse inheritance is
sharper here than it was for #1104: a default chat provider handed `/v1/rerank`
traffic **errors**, which is loud, whereas a default text-embedding provider
handed an image-embedding request will happily answer the plain-`input` shape
with a well-formed vector that is simply wrong — and wrong vectors are
indistinguishable from bad retrieval.

**A second non-OpenAI-shaped endpoint, beside `/v1/rerank`.** The path is
`/v1/embeddings`, but the body is vLLM's chat-embeddings extension: a `messages`
array (system = instruction, user = image and/or text parts, plus a trailing
**empty `assistant` message**) with `continue_final_message: true`. The trailing
turn is load-bearing — the checkpoint pools the last token, so the prompt must
end at `<|im_start|>assistant\n` — and vLLM applies the chat template on the
`messages` path only, so the plain `{model, input}` shape pools a different
position and produces vectors that must never be mixed into the same index. This
is why `vl-embedding-client.ts` is its own client (sharing `providerRequestInfra`
with `rerank-client.ts`) rather than a branch inside
`openai-compatible-client.ts`'s embeddings path, and it narrows Alternative 2's
"every provider is OpenAI-compatible" premise a second time.

**Non-support list, recorded so nobody re-derives it:** Hugging Face **TEI**
(no image concept in its OpenAPI spec; the request for this family,
`text-embeddings-inference#822`, is open with zero comments), **LM Studio**
`/v1/embeddings` (text `input` only), **llama.cpp `llama-server`** (multimodal
embeddings exist, but on the non-OpenAI `POST /embedding` route with a
hand-built template and a per-server random media marker), and the plain
`{model, input}` shape on any server. The supported production path is **vLLM
≥ 0.14.0 with `--runner pooling`**, pinned by version because a bump changes the
vector space (ADR-025 D12).

**The probe follows `vision-probe.ts`, and records a width.** On assignment, P1
embeds a known image *and* a text through the client, refuses the pair if the
endpoint rejects the `messages` shape or returns mismatched widths, and stores
the resulting dimension — which then picks the column type and index tier for
`page_image_embeddings`, the same probe-then-DDL pattern the text column already
uses. Capability is established by asking, never by declaration.

## ADR-022: RAG retrieval honours per-user space permissions

**Date:** 2026-04-21
**Status:** Accepted
**Context:** Confluence instances can host spaces with restricted read access. When multiple users share a Compendiq instance, RAG must not surface a chunk from a space the querying user cannot read in Confluence, even if a different user on the same instance synced that space.

**Decision:** Enforce per-user space permissions as a **post-filter** on both vector (pgvector HNSW) and keyword (PostgreSQL FTS) candidate sets, before reciprocal-rank fusion. The allowed space set is resolved from `space_role_assignments` + `group_memberships` via `rbac-service.getUserAccessibleSpaces(userId)` and memoised for the lifetime of the request via `AsyncLocalStorage` so downstream callers pay a single DB round-trip regardless of how many retrieval paths execute per request.

Standalone (non-Confluence) articles are filtered by the same visibility rules already enforced in the knowledge-search route: `shared` articles are visible to all authenticated users; `private` articles are visible only to their creator.

**Why post-filter, not query-time HNSW index filter:** pgvector HNSW has a selectivity penalty when the filter column is sparse; adding `space_key = ANY(...)` as an ORDER-BY-time predicate would force oversampled top-K per call. Post-filter with candidate overfetch is simpler, keeps the vector index unconditioned on per-user state, and is adequate while per-user readable sets stay small (typically < 50 spaces per user in observed deployments).

**Scope boundary (CE-only):** This ADR covers space-level RBAC enforcement. Per-page ACL enforcement against Confluence view restrictions — syncing them into `access_control_entries` and running a second post-filter via `userCanAccessPage` after the RRF merge — is gated behind the Enterprise Edition `ENTERPRISE_FEATURES.RAG_PERMISSION_ENFORCEMENT` flag and is documented in **ADR-023**. The unrelated `ADVANCED_RBAC` flag governs custom RBAC roles (named permissions, configurable role hierarchies) which is separate from per-page ACL enforcement; do not conflate them when reasoning about tier packaging.

**Consequences:**
- Any new **RAG retrieval** path MUST use `getUserAccessibleSpacesMemoized` (not the raw resolver) to inherit the request-scoped cache. Non-retrieval callers (admin tooling, sync workers, one-shot operations that run outside an authenticated HTTP request scope where `AsyncLocalStorage` has no context) continue to call `getUserAccessibleSpaces` directly — memoisation has no benefit there.
- RBAC mutation paths MUST invalidate the Redis RBAC cache (`invalidateRbacCache(userId)`) so the next request sees the new ACL within the 60-second global TTL window.
- Integration test `backend/src/domains/llm/services/rag-service.integration.test.ts` is the regression guard.

---

## ADR-023: Per-page ACL enforcement for RAG retrieval (Enterprise)

**Date:** 2026-04-24
**Status:** Accepted
**Context:** ADR-022 post-filters RAG candidates by the user's readable space set. That is sufficient when "can see the space" ≡ "can see every page in the space". It is NOT sufficient when a Confluence space is readable at the space level but individual pages inside it carry view restrictions (e.g. HR, legal, security teams commonly do this for onboarding checklists, draft policies, incident reports). Without per-page enforcement, any user with space access could retrieve restricted-page chunks via RAG — a confidentiality regression vs. the Confluence-native reading experience.

Confluence DC semantics (per Atlassian's official documentation, not the issue body's claim): **view restrictions ARE inherited** from ancestor pages; edit restrictions are not. The issue body's statement that "restrictions are per-page; not inherited from parent" is wrong, and treating it literally would silently under-enforce whenever an organisation restricts a section root without re-restricting every child.

**Decision:** Mirror Confluence per-page view restrictions into `access_control_entries` at sync time (resolving ancestor inheritance into the child's effective list), and run a **second** post-filter after the ADR-022 RRF merge that gates each candidate via `userCanAccessPage(userId, pageId)`. The whole behaviour is Enterprise-gated behind `ENTERPRISE_FEATURES.RAG_PERMISSION_ENFORCEMENT`; CE deployments and EE deployments without the feature see exactly the ADR-022 behaviour.

**Sync-time contract (`backend/src/domains/confluence/services/sync-service.ts`):**
- For each page, call `confluence-client.getPageRestrictions(pageId)` using the stable `/rest/api/content/{id}/restriction` path; fall back to `/rest/experimental/content/{id}/restriction` on a non-404 error. Return `[]` on either path's 404 — page has no restrictions.
- If the page has its own non-empty `read` restriction: its user + group lists are the effective set. Ancestors are NOT consulted (own overrides inherited — matches Confluence's own precedence).
- If the page has no own `read` restriction: walk `getPageAncestors(pageId)` immediate-parent-first; the first ancestor with a non-empty `read` restriction contributes its list as the effective set. Cache ancestor restrictions within the sync run to avoid refetching a shared ancestor across sibling pages.
- Persist the effective set as `(resource_type='page', principal_type='user'|'group', permission='read', source='confluence', synced_at=<run start>)` rows. UPSERT on the existing uniqueness constraint so re-syncs refresh `synced_at`.
- After all pages are processed, sweep: `DELETE FROM access_control_entries WHERE source='confluence' AND synced_at < <run start>`. Rows that were not refreshed are gone (restriction removed in Confluence, or a specific user was de-listed). `source='local'` rows are never touched.
- A Confluence `userKey` that has no matching Compendiq user (no OIDC login yet) is skipped with an `ACE_SYNC_SKIPPED_UNMAPPED_USER` audit event. Safe default: implicit deny — the ACE never materialises, so `userCanAccessPage` will not grant read.

**Query-time contract (`backend/src/domains/llm/services/rag-service.ts`):**
- Overfetch compensation: when the flag is on, both the vector-search and keyword-search stages pull `ceil(topK * 1.5)` candidates instead of `topK`. The post-filter needs headroom because any given page can be filtered out.
- After `reciprocalRankFusion`, iterate the merged list and keep only entries where `userCanAccessPage(userId, page.id)` is true. Slice to `topK` at the end to keep the response size stable.
- Rank order is preserved — the post-filter is a `filter`, not a re-rank.

> **Amended (#1103, 2026-08-10):** the per-leg stage limit is now
> `resolveStageLimit(topK, fetchWidth, aclEnforced)` =
> `max(fetchWidth, topK)`, with `ceil(topK * 1.5)` kept as an **additional
> floor** when the flag is on — compensation can only ever add candidates
> (its old form fetched 8/leg on the EE chat path vs CE's 10, a net
> under-fetch, #1263). `fetchWidth` is the `rag_fetch_width` row in
> `admin_settings` (default 10 — the legacy per-leg limit — clamped to
> [10, 200], TTL-cached in `admin-settings-service.ts`). **Two consequences
> below are amended with it:** the fetch width and the `topK` floor apply in
> BOTH branches, so "CE deployments and EE without the flag: zero behaviour
> change" now covers the ACE consultation and the post-filter only — a CE
> `/api/search?mode=hybrid&limit=20` fetches 20 rows/leg where it used to
> fetch an unsatisfiable 10.
>
> **Amended again by #1104**, which raised the pool to the rerank candidate
> budget (default 30, up to 100) and delivered the batched check the
> previous paragraph of this amendment assigned to it: the post-filter is
> now `filterAccessiblePages(userId, pageIds)` — one admin probe, one
> memoized space resolve (ADR-022), and ONE set-based query
> spec-matched to `userCanAccessPage` (an integration test compares the two
> verdict-for-verdict). The old "N ≤ topK×1.5, typically ≤15 sequential
> per-page checks" rationale bullet is superseded: the query path is one
> round-trip regardless of pool size, and the per-page `userCanAccessPage`
> remains the single-page API and the batch's specification. The
> `inherit_perms = true` arm evaluates the same memoized space snapshot the
> legs enforced in SQL — the deliberate defence-in-depth trade recorded
> above stands; the ACE arm is the filter's real job and runs in the same
> query. Fusion note: when the stage limit exceeds the configured width,
> ranking uses a stable head (`fuseWithStableHead`) — the pool floors widen
> what the filter sees, never the head ordering.

**Rationale:**
- **Ancestor inheritance is resolved at sync time, not query time.** The RAG post-filter calls `userCanAccessPage` N times per query (N ≤ topK×1.5, typically ≤15 in observed deployments). Each call is 1-3 pooled SQL queries. Resolving inheritance at query time would require either walking the ancestor chain per candidate (unbounded fan-out on hot paths) or duplicating the ancestor-walk logic into `userCanAccessPage` (tight coupling). Putting the walk in the sync path keeps the query path O(topK) and lets us reuse the existing `userCanAccessPage` as-is.
- **`source` + `synced_at` columns instead of a second table.** Adds two columns to `access_control_entries`; preserves the existing uniqueness constraint and the `userCanAccessPage` query path. A separate `confluence_page_aces` table would double the join count on a request-hot function for no correctness benefit.
- **Synchronous mode.** The sync run accepts the extra Confluence API calls (+1 per page, mitigated by conditional fetch on `metadata.restrictions.updated` + the ancestor cache). The alternative — async backfill via a BullMQ job after the main content sync — opens a RAG-leak window during which a restricted-page chunk could surface to a space-member who lacks per-page read. Not acceptable for regulated-buyer deployments. Async-backfill remains available as a future v0.5 option for latency-sensitive customers who accept the leak window.

**Consequences:**
- EE deployments with the flag on: sync runs take longer (proportional to restricted-page count), and RAG respects Confluence's per-page visibility.
- CE deployments and EE without the flag: zero behaviour change. The Confluence client methods, the post-filter branch, and the 1.5x overfetch bump are all gated by `isFeatureEnabled('rag_permission_enforcement')`.
- A Confluence admin removing a restriction or adding a user to an existing one takes effect on Compendiq's next sync (not instant). The sync cadence is `SYNC_INTERVAL_MIN` (default 15 min); documented in the ADMIN-GUIDE.
- Integration tests in `backend/src/domains/confluence/services/sync-service.integration.test.ts` + `backend/src/domains/llm/services/rag-service.integration.test.ts` are the regression guard.

---

## ADR-024: Multi-instance readiness (horizontally-scaled `backend`)

**Date:** 2026-05-05
**Status:** Accepted (drafted alongside Compendiq/compendiq-ee#113 sub-PR 1d; some pieces shipped earlier — see "Already shipped" below)

**Context:** v0.3 ran the `backend` service as a single replica. Process-local `Map`/`Set` state was correct because every request, every cache invalidation, and every scheduled tick lived in the same Node process. v0.4's enterprise scope (multi-instance management in `compendiq-mgmt`, IP-allowlist hot-reload, webhook outbox, SSE co-presence) requires running multiple replicas behind a load balancer for both availability and horizontal capacity. Process-local state silently misbehaves under multi-replica deployment: provider config edits land on one pod and not others; SSRF allowlist drifts; scheduled jobs fire N times per tick; admin-changed concurrency is observed by only the pod that handled the PUT.

The challenge is to deliver multi-replica correctness **without** introducing a separate worker container or a stateful coordinator service — both of which would expand the operator footprint of the v0.3 four-service compose stack we explicitly wanted to keep small.

**Decision:** Adopt a **light-touch coordination model** built on Redis primitives we already use, with five components:

1. **Generic Redis pub/sub cache-bus** for cluster-wide invalidation. Advisory-only payloads — handlers re-fetch from the authoritative store on every event. No durable event log.
2. **BullMQ `upsertJobScheduler`** with stable, semantic IDs for every recurring job, replacing v4's `repeat: { every }` pattern. BullMQ's Redis-side dedup ensures exactly-once-per-tick semantics under N replicas.
3. **In-place mutation of `_limiter.concurrency`** (p-limit 7) when admin-set LLM concurrency changes, rather than allocating a fresh `pLimit(...)` and orphaning in-flight work.
4. **Graceful-shutdown order** for the Fastify+BullMQ process: workers drain first, then HTTP, then DB pools — bounded by a 60s `stop_grace_period` with the BullMQ stall detector as the safety net. Workers-first (not the canonical BullMQ-docs HTTP-first) is the correct choice for this codebase because Compendiq's LLM streaming routes (`/api/llm/*`) hold an SSE response open while in-process `_limiter`-gated `streamChat` produces chunks; closing HTTP first would abort in-flight streams mid-answer. Background BullMQ workers (sync / embedding / quality / summary) drain-first too so any in-flight DB work finishes before the Postgres pools close.
5. **Soft-fail per-pod fallbacks** so single-pod deployments and Redis outages degrade to local-only behaviour rather than hard-erroring the request path.

CE-side primitives (the bus, the BullMQ migration, the p-limit hot-swap, the SSRF allowlist bus) are implemented in CE so the same scale-safety applies to community deployments that choose to run multi-replica. EE does not carry a parallel implementation; it only consumes the primitives.

**Already shipped (per-row Issue/PR citations in the right column are the canonical reference; do not re-cite branch-tip hashes here, they rot every merge):**

| Component | Where | Issue |
|---|---|---|
| `redis-cache-bus.ts` (generic pub/sub) | `backend/src/core/services/redis-cache-bus.ts` — `node-redis` v5; channel union covers `provider:cache:bump`, `provider:deleted`, `admin:llm:settings`, `ip_allowlist:changed`, `confluence:allowlist:changed`, `sync:conflict:policy:changed`, `pii:policy:changed`, `license:changed`. Subscriber on a `main.duplicate()` connection (node-redis requires this). `onReconnect` skips initial `ready`, fires after every reconnect-after-disconnect — drives cold-reload-on-recovery. | CE PR #325 |
| `ssrf-allowlist-bus.ts` + `bootstrapSsrfAllowlist()` wired at boot | `backend/src/app.ts:285` (boot wire), `backend/src/domains/confluence/services/sync-service.ts:1398` (definition). Multi-pod allowlist coherency on `confluence:allowlist:changed`. | CE#306 |
| BullMQ JobScheduler audit | `backend/src/core/services/queue-service.ts:167, 411` use `upsertJobScheduler` exclusively; 0 legacy `{ repeat: { every } }` call sites across `ce/backend/src` and `overlay/backend/src`. | EE#113 (this issue) |
| LLM-queue cluster coordination + #404 hot-swap fix | `backend/src/domains/llm/services/llm-queue.ts:208` (init), `:298, :315` (cluster-wide setters publishing on `admin:llm:settings`). `_limiter.concurrency` mutated in place; `_limiter`'s internal queue + activeCount survive concurrency changes, so in-flight and pending jobs continue to feed `getMetrics()`. | EE#113 + CE#404 |
| Health-API endpoint with constant-time token compare | `backend/src/routes/foundation/health-api.ts` — `GET /internal/health?token=<t>`. Length-mismatched compares spend the same `timingSafeEqual` work against zeroed buffers (`:84-92`) so timing does not leak the expected token's length. Migration `072_admin_settings_health_api_token.sql` seeds the token via `encode(gen_random_bytes(32),'hex')`. | EE#113 Part A |

**Cache-bus contract (the load-bearing rule):**

- **At-most-once delivery.** Pub/sub does not persist messages; a subscriber that is reconnecting at the moment a message is published does not see it. The `redis-cache-bus.onReconnect` hook fires after `ready` events that are NOT the initial connect, so subscribers can cold-reload from Postgres after any disconnect.
- **Payloads are advisory only.** Handlers MUST re-fetch from the authoritative store on every event. Payloads carry IDs (e.g. `providerDeleted: { providerId }`) only to scope the cleanup work; they never carry state. A receiver that "trusts" payload state would silently desync from the publisher.
- **Soft-fail to single-pod.** When `initCacheBus` cannot duplicate the subscriber connection or subscribe, the bus falls back to no-op publish + noop unsubscribe. Single-pod deployments and Redis outages stay request-serving — their bus events become local-only fan-outs in each domain module that wraps the bus (e.g. the LLM `cache-bus.ts` in #113 sub-PR 1d).

**Why not Redis Streams (`XADD` / `XREADGROUP`):**

Streams give at-least-once delivery and crash-recovery semantics, which would eliminate the post-reconnect cold-reload step. We rejected them for v0.4 because:
- Every cache-bus event we publish today is **idempotent on re-emit** and **inexpensive to recompute** — the cold-reload-on-reconnect cost is one Postgres read per cached subsystem, observed empirically at sub-50ms.
- Streams add per-consumer-group bookkeeping (`XACK`, `XPENDING`, `XCLAIM` for stuck consumers) and a continuous-storage-growth concern (`MAXLEN` tuning) that are operational burden for an advisory channel.
- The hot path is already covered: `BullMQ` (durable, at-least-once) for scheduled jobs that must run, and `outbox + worker` (durable, at-least-once) for webhook deliveries — both backed by Redis but using the right primitives for durability-required work.

If the at-most-once trade-off becomes user-visible (e.g. a customer reports caches drifting under sustained Redis flapping), Streams remain a future option for the cache-bus channels that prove most affected. The decision is reversible at the channel granularity — we don't have to migrate all eight channels at once.

**BullMQ JobScheduler stable-id convention:**

- Format: `<domain>:<job-name>:<cadence>` — e.g. `embedding:reembed-tick:hourly`, `data-retention:prune:daily`, `mgmt:instance-poller:5min`.
- IDs are **semantic**, not derived from timing or hash. Changing the interval reuses the same ID, which is what the v5 API requires for in-place updates without orphaning the old schedule.
- BullMQ uses the Redis server's `TIME` command as authoritative "now" — client clock skew is benign for triggering. The residual risk (multiple producers concurrently calling `upsertJobScheduler` with drifted clocks computing different "next tick" timestamps) is mitigated by NTP on all nodes.
- **No catch-up policy:** a tick missed during a Redis outage is not replayed — only the next future occurrence fires after recovery. This is intentional to prevent job storms after extended outages. Daily retention prune and embedding ticks are tolerant; SLA-critical work uses the durable outbox pattern instead.

**p-limit hot-swap (CE#404):**

- The naïve setter would `_limiter = pLimit(newConcurrency)` — but the new instance has an empty internal queue and a zero `activeCount`, leaving in-flight tasks attached to the orphaned old instance. `getMetrics()` would under-report; `enqueue`'s queue-depth backpressure check would over-admit.
- p-limit 7 exposes a writable `concurrency` setter that mutates the existing instance: lowering it lets in-flight finish naturally before new admits, raising it drains pending on the next microtask. Both transitions are observable through the same `_limiter`, keeping `getMetrics()` and `QueueFullError` checks coherent across changes.
- Documented in `llm-queue.ts:23-29` (module-top comment) so future contributors don't "fix" the in-place mutation back into a fresh `pLimit(...)` allocation.

**Graceful-shutdown order:**

Bound to a 60s `stop_grace_period` (set on the `backend` service in `docker/docker-compose.yml`, the `scripts/install.sh` installer compose, and `docker/docker-compose.ee.yml` — issue #931) with the BullMQ stall detector (`stalledInterval` default 30s) as the safety net for jobs that don't complete. The step order is declared in `backend/src/index.ts` and executed by `createShutdownHandler()` (`backend/src/core/utils/graceful-shutdown.ts`, added for issue #745):

```
SIGTERM
  → stopQueueWorkers()           // worker.close() awaits in-flight jobs;
                                 // queue.close() then releases the producer pool.
                                 // QueueEvents is NOT used in this codebase
                                 // (`grep -r 'new QueueEvents' ce/backend/src` → 0 hits),
                                 // so no XREAD connection to release.
  → closeEmailService()          // synchronous teardown of nodemailer transports
  → app.close()                  // stop accepting HTTP, await in-flight handlers
                                 // (Fastify Redis plugin's onClose runs here →
                                 //  Redis client.quit() is implicit)
  → closeVectorPool()            // pgvector pool
  → closePool()                  // primary Postgres pool
  → shutdownTelemetry()          // OTEL flush + transport close
  → process.exit(0 | 1)          // 0 if every step succeeded, 1 otherwise
```

Each step is isolated in its own try/catch (a failing step — e.g. a Redis
`quit()` against a server that is already gone — is logged and skipped, so the
Postgres pools still close), a re-entrancy guard makes a second SIGTERM/SIGINT
during an in-flight shutdown a no-op instead of a parallel teardown, and the
process always reaches `process.exit` (issue #745).

**Why workers-first, not the BullMQ-docs HTTP-first?** Two distinct kinds of "in-flight work" need to drain before HTTP closes:

1. **LLM streaming routes** (`/api/llm/*` chat-completion, summary, generate). These hold an SSE response open while in-process `_limiter`-gated `streamChat` (NOT BullMQ — `streamChat` bypasses `enqueue()` per `openai-compatible-client.ts:94-103` for back-pressure-free streaming) produces chunks. Closing HTTP first would abort streams mid-answer. Closing the LLM `_limiter`-protected path first via `stopQueueWorkers()`'s upstream effects — actually moot here because `_limiter` doesn't have a graceful-close hook — but the point is the HTTP response must remain open until the in-process work that's writing to it is done.

2. **Background BullMQ workers** (sync, embedding, quality, summary). These hold real `enqueue()` slots. They write to Postgres on completion. Closing HTTP before they finish would close the Fastify-managed Postgres pool that the workers are still trying to use, producing late-shutdown error logs and potentially leaving rows half-written.

The canonical BullMQ recommendation (HTTP-first) assumes a typical job-queue pattern where the HTTP handler returns immediately after enqueueing — that doesn't match Compendiq's HTTP-bound-to-worker-output streaming model OR the workers-write-back-to-DB pattern.

**Trade-off accepted:** during the workers-draining window, in-flight HTTP handlers can still call `enqueue()` and add jobs to a closing queue. Those jobs are picked up by the next pod that boots (Redis-persisted) or, if no pod boots within `stalledInterval`, reclaimed and retried via stall detection. The risk is a small backlog at restart — acceptable for v0.4. v0.5 may add an HTTP-side guard that rejects new `enqueue()` calls once shutdown begins.

**No permanently orphaned `active` jobs:** any job that does not finish in 60s is interrupted, but BullMQ's stall detector reclaims and retries it. Long-running LLM streams (`LLM_STREAM_TIMEOUT_MS=300_000`) are accepted as occasional stall-and-retry casualties for v0.4. v0.5 either lowers the timeout default or moves LLM work to a dedicated worker container with a longer grace period.

**Hard deadline inside the handler (v0.5, issue #745).** v0.4 had no in-process timeout — a hanging `await` waited for Docker's `stop_grace_period: 60s` + SIGKILL. `createShutdownHandler()` now arms an unref'ed timer when shutdown begins — default **50s**, tunable via `SHUTDOWN_TIMEOUT_MS` (positive integer of milliseconds; invalid values fall back to the default). If the step chain has not finished by then, the process force-exits with code 1. 50s deliberately spends most of the 60s `stop_grace_period` budget on draining — LLM summary/quality/sync jobs awaited by `stopQueueWorkers()` can legitimately run for tens of seconds — while leaving Docker's SIGKILL backstop a 10s margin. Operators tuning `SHUTDOWN_TIMEOUT_MS` should keep it below their container runtime's stop grace period so the in-process timer fires first.

**Trust-proxy posture (cross-reference ADR for #111):**

Multi-replica deployments sit behind a load balancer. `trustProxy` MUST be set to a specific CIDR or hop-count, never `true` — trust-proxy=true lets any client forge `X-Forwarded-For`, breaking IP-allowlist enforcement (#111) and audit-log accuracy. Documented as a deployment requirement in `docs/architecture/05-deployment.md`; defaulted in code to a single-hop loopback-only configuration that is safe for single-replica dev.

**Consequences:**

- The `backend` service is safe to run with `--scale backend=N` for N≥2 from v0.4 onward, given Redis and Postgres are reachable from every replica. The compose stack does not impose a replica count; operators choose.
- Boot-time migrations are replica-safe (issue #745): `runMigrations()` serializes on a session-level `pg_advisory_lock` taken on its dedicated pool client, and re-reads `_migrations` after acquiring the lock, so N replicas booting concurrently (rolling deploy / HPA scale-up) apply each migration exactly once. The migration session sets `statement_timeout = 0` and `lock_timeout = 0` before acquiring the lock (and `RESET`s both before the client returns to the pool) so a pool-wide `PG_STATEMENT_TIMEOUT` cannot cancel replicas blocked behind a slow migration winner. The lock is released in a `finally`; if the holding session dies, Postgres frees it automatically.
- Every future cache that holds non-trivial cluster-wide invariants (LLM provider config, IP allowlist, SSRF allowlist, conflict-resolution policy, PII policy, license info) registers a channel in the `CacheBusChannel` union and wires both publish and `onReconnect` cold-reload. The union is the canonical inventory.
- Process-local Maps/Sets remain acceptable for per-pod artifacts that are correct to vary per-replica: undici dispatcher pools (`openai-compatible-client.ts:21`), circuit-breaker state (`circuit-breaker.ts:158`), BullMQ client refs (`queue-service.ts:48-49`). The contract is simple — if removing the structure on one pod and re-creating it on another would observably change behaviour to the user, it must be cluster-coordinated.
- Adding a new recurring job means picking a stable namespaced ID and using `upsertJobScheduler`. Reviewers reject any new `{ repeat: { every } }` usage. `grep -rn '{ repeat: { every' ce/backend/src overlay/backend/src` is the boundary check.
- The 2-replica topology is documented in `docs/architecture/05-deployment.md` (added in #113 sub-PR 1f). Single-replica remains the default in dev compose; multi-replica is an operator choice in production.
- Health-API token (`admin_settings.health_api_token`) is the cluster-wide identity for external mgmt-side polling. The token is read from Postgres on every request — there is no in-process cache to invalidate, so rotation (`POST /api/admin/health-api/rotate`) is atomically observable on every replica without bus interaction.

---

## ADR-025: Multimodal image retrieval — dual space

**Date:** 2026-08-17
**Status:** Accepted (owner interview, 2026-08-17). **Partially implemented:**
P0 has shipped — this ADR, migration `093` (the `page_image_embeddings` table,
`pages.image_embedding_dirty`, the widened use-case CHECK) and the core
`attachment-store` hoist. The client, the probe, the index writer, the
retrieval leg and the answer path land in **P1–P4**, and every paragraph below
that describes unshipped behaviour says which PR owns it. Nothing in Compendiq
embeds or retrieves an image today.
**Design of record:** `docs/superpowers/specs/2026-08-16-multimodal-image-retrieval-design.md`
(issue #1115, epic #1100 Phase 2).

### Context

Confluence pages carry meaning in pictures — architecture diagrams, screenshots
of a UI, flowcharts, photos of hardware — and Compendiq's retrieval cannot see
any of it. `embedPage` embeds `htmlToEmbeddingText(body_html)`, in which an
`<img>` contributes at most its alt text, so a page whose answer lives in a
diagram is reachable only through whatever prose happens to surround it. Pages
whose text falls below the 20-character floor are not indexed at all.

Qwen3-VL-Embedding (released 2026-01-07, Apache-2.0, 2B and 8B checkpoints)
embeds images and text into one space, which makes a text query able to retrieve
an image directly. The epic framed Phase 1 (a better *text* embedder, #1114) and
Phase 2 (a multimodal embedder) as **mutually exclusive** — one column, one
model. That framing is what this ADR overturns.

### Decision

Twelve decisions. The reasons matter more than the list, because most of them
are a choice between "one model for everything" and "the product's primary path
stays on its best model".

**D1 — Dual space, not shared.** Text keeps the Phase-1 text embedder
(Qwen3-Embedding-4B @ 2560 on the `halfvec` HNSW tier). A VL model embeds
**images** into a separate index, and embeds the **query** a second time for
that index only. Two citations decide it:

- On **MMTEB Retrieval** (text-only), the VL models *lose* to the text models:
  Qwen3-Embedding-8B **70.88**, Qwen3-Embedding-4B **69.60**,
  Qwen3-VL-Embedding-8B **69.41**, Qwen3-VL-Embedding-2B **67.12**, `bge-m3`
  **54.60** (published model-card table, matching Table 1 of
  `arXiv:2601.04720v2`). The 8B multimodal model is beaten on text retrieval by
  the *4B* text model. A shared space is therefore a measured regression on the
  path almost every query takes.
- A shared space also forces **every** text embed through the VL chat-template
  request shape (D4), which only vLLM — or a self-written shim — serves. That
  ends Ollama, LM Studio and plain-OpenAI text embedding for every CE
  deployment, which is the opposite of ADR-021's N-provider model.

**D2 — Phase 1 and Phase 2 are increments.** #1114's cutover proceeds on its own
schedule; #1115 adds an index beside it. The epic's "mutually exclusive"
paragraph is superseded.

**D3 — A new ADR-021 use case, `image_embedding`, modelled on `rerank` (P1).**
It never inherits the default provider, it has its own resolver
(`resolveImageEmbeddingUsecase`, returning `null` when unassigned) and its own
client, and **unassigned means the image leg is disabled**. Same argument that
made `rerank` non-inheriting in #1104, one rung stronger: a chat provider cannot
answer `/v1/rerank` and would error, whereas a text embedder *will* answer the
plain-`input` shape with a plausible vector that is simply wrong. Silent
garbage is worse than a 404.

**D4 — The request shape is vLLM's chat-embeddings extension, never plain
`input` (P1).** `POST /v1/embeddings` with a `messages` array — system message
carrying the instruction, user message carrying the image and/or text, and a
trailing **empty `assistant` message** with `continue_final_message: true`:

```json
{ "model": "Qwen/Qwen3-VL-Embedding-2B",
  "messages": [
    {"role": "system",    "content": [{"type": "text", "text": "Represent the user's input."}]},
    {"role": "user",      "content": [{"type": "image_url", "image_url": {"url": "data:image/webp;base64,…"}},
                                      {"type": "text", "text": ""}]},
    {"role": "assistant", "content": [{"type": "text", "text": ""}]}
  ],
  "encoding_format": "float", "continue_final_message": true, "add_special_tokens": true }
```

The trailing empty assistant turn is the single easiest thing to get wrong: the
checkpoint pools the **last token** (`1_Pooling`: `"pooling_mode": "lasttoken"`,
then L2-normalise), and the prompt has to end with `<|im_start|>assistant\n` for
that token to be the one the model was trained to pool. vLLM applies the chat
template on the `messages` path **only** — a plain `{model, input}` request is
tokenised bare, pooling a different position, off-distribution. Mixing the two
inside one index is the failure this rule exists to prevent. Instruction on the
**query** (`"Retrieve images or text relevant to the user's query."`), the
checkpoint's default (`"Represent the user's input."`) on the **corpus**, and the
instruction is written in **English regardless of corpus language**, per the
model card's own guidance.

**D5 — Default recommendation: Qwen3-VL-Embedding-2B at its native 2048, on the
`halfvec` HNSW tier.** The 8B is allowed only with MRL truncation to
`dimensions ≤ 4000`, because its native 4096 lands in pgvector's **unindexed**
tier (HNSW caps at 2000 for `vector` and 4000 for `halfvec`) — and MRL on vLLM
additionally needs `--hf-overrides '{"is_matryoshka": true}'`, since neither
checkpoint declares the flag, plus client-side re-normalisation after
truncation. Weights are 4.26 GB (2B) and 16.29 GB (8B) in bf16; production is an
**RTX 6000 96 GB Blackwell**, so **VRAM is not the constraint** and the choice
is quality: the image eval measures both and the numbers decide. The truncation
cost is small where it applies — the authors measure ~1.4% MRR@10 going from
1024 to 512 dims, with int8 quantisation nearly free and binary decidedly not.

**D6 — Storage is a new table, `page_image_embeddings`, not rows in
`page_embeddings` (P0, shipped).** A `kind` discriminator on the existing table
would have made every text path conditional: `embedPage`'s unscoped `DELETE`,
its `AVG(embedding)` for `pages.page_avg_embedding`, the `(page_id,
chunk_index)` uniqueness, #1116's shadow columns, MMR, rerank and sibling
assembly. Three of the issue's ten listed blockers disappear structurally rather
than by everyone remembering a `WHERE`. It is also the only shape that can hold
two different widths from two different models at once.

**D7 — Changing the image model truncates the index and re-scans. No shadow
swap (P1/P2).** #1116's shadow path exists because a text re-embed degrades live
search for hours; here the leg is simply *disabled* while the index is empty, so
text retrieval is untouched. Images are far cheaper to redo: only referenced
files, content-addressed by sha256, and typically a handful per page.

**D8 — The answer path degrades to text-only when the chat model's vision
verdict is not `true`, and retrieved images never count as grounding (P4).**
`resolveImagePart` (#1154) *throws* on `false`/`null`, which is right for a user
who explicitly attached an image and wrong for retrieval that merely found one —
so P4 needs a sibling that returns `null`. And the refusal gate (#1105) must not
count a retrieved image as "other grounding": doing so would stop honest
refusals on every weak retrieval that happens to touch a page with a picture on
it. (Owner ruling, 2026-08-10.)

**D9 — Bytes come from disk, never Redis staging (P0, shipped).**
`core/services/attachment-store.ts` is the hoisted path-resolution + read half
of `attachment-handler.ts`, plus one new `resolveAttachmentBytes`. Two reasons
it had to be in `core`: `domains/llm` may import `core` and nothing else
(`backend/eslint.config.js:50-53`), and #1154's staging path exists to carry a
*user upload* across two requests against a `noeviction` Redis (#1183) — a
retrieved attachment already has a stable path on disk. The function applies
**no ACL**; a test walks `src/routes` and fails if any route file names it.

**D10 — No server-side pixel processing in v1 (P2).** SVG and draw.io
XML-in-`.png` are excluded because `sniffImageFormat` refuses them; images over
`MAX_IMAGE_BYTES` (5 MB) or `MAX_IMAGE_DIMENSION` (4096) are **skipped and
counted**, never resized. The backend has deliberately no `sharp` and no
`image-size` (`core/services/image-validator.ts:3-13`), and adding a native
image decoder is a supply-chain decision of its own. The model server resizes to
its own budget anyway (~1.31 Mpx ≈ 1280 visual tokens, the trained ceiling in
`preprocessor_config.json`; the paper reports a *regression* at the highest
resource levels, so sending more pixels is not free upside).

**D11 — Local development runs a ~30-line Python shim** (`mlx-embeddings`
behind FastAPI) exposing exactly the D4 shape, committed under
`tools/vl-embedding-shim/` with a runbook (P5). Everything else fails on the
input side, which is worth recording because it looks solvable and is not:

| Serving path | Verdict |
|---|---|
| **vLLM** ≥ 0.14.0, `--runner pooling` | The production path. `/v1/embeddings` with `messages`. |
| **TEI** | No image concept anywhere in its OpenAPI spec; the feature request for this exact family (`huggingface/text-embeddings-inference#822`, opened 2026-02-12) is open with zero comments, and a generic image-embedding request has been open since March 2025. |
| **LM Studio** `/v1/embeddings` | Text `input` only; images are documented for chat, not embeddings. |
| **llama.cpp `llama-server`** | Multimodal embeddings exist, but on the **non-OpenAI** `POST /embedding` route, with a hand-built chat template and a **per-server random media marker** fetched from `/props` (two open bugs: `ggml-org/llama.cpp#26201`, `#25088`). The OpenAI-shaped PR (`#18665`) is closed unmerged. |
| **`mlx_vlm.server`** | Templates images but not text — usable for smoke-testing plumbing, not for judging quality. |

**Local vectors never decide anything.** Quantisation, MLX-vs-CUDA numerics and
vLLM's own preprocessing divergence all shift the space; see "what only
production can prove".

**D12 — The vLLM version is pinned, and bumping it is a re-index event.**
`vllm#33204` (open) reports ~0.92 cosine against the reference
`qwen_vl_utils` preprocessing, which vLLM's docs acknowledge; `vllm#33954`
reported quality *declining* between 0.14.0rc2 and 0.15.2; `vllm#33986` is the
open tracking issue for the family. A corpus embedded on one version and queried
on another is silently degraded. D7 makes honouring this cheap.

### Retrieval, in one paragraph (P3)

The image leg runs only when the use case is assigned, the table is non-empty
and `rag_image_leg_enabled` is on — otherwise no query embed and no cost. It
kNN-searches `page_image_embeddings` under the same visibility predicate as the
other legs and fuses as a **third RRF leg**, page-denominated like #1106. Rank,
not score: published cross-modal similarities sit in a different absolute band
than text↔text ones (roughly 0.46–0.72 vs 0.75–0.81 in the model card's own
tables), so any threshold tuned on text misbehaves on images. For the same
reason **the image leg never feeds the confidence number** (#1105): an
image-only hit set has basis `none` and never refuses, exactly like a
keyword-only one. Rerank, the ranking prior, MMR and sibling assembly are
untouched — they all score `chunkText`, and image rows have none.

### v1 scope fence

No SVG rasterisation and no server-side downscale (D10). No joint
image+caption document embedding — v1 embeds the image alone so the vector is
purely visual, and captions already reach the *text* leg through `body_text`;
this is the first tuning knob to measure afterwards. No Qwen3-VL-Reranker, no
video, no OCR. No attachment retention policy (**#1349**). External images are
embedded once cached — they are already corpus content on disk — with a
one-line opt-out knob.

### Evaluation plan (P5)

A new axis on the #1102 harness, not a new harness. Corpus:
`eval/corpus-de-images/` — ~60 German Wikipedia articles with 2–3 images each,
committed downscaled (≤ 512 px longest edge, ≤ ~80 KB, ≈ 5–10 MB total) under
CC0 / PD / CC BY / CC BY-SA with per-page and per-image attribution, covering
technical diagrams, science figures, organisational/process charts and photos.
Pages carry the images **without captions**, which is the case the feature
exists for. Queries are German plus a small English subset (the cross-lingual
case), labelled by an independent vision-capable agent on a different model than
the implementer, blind to the retrieval code (the owner's #1102 amendment).
Metric: page Recall@K / MRR **paired, leg on vs off**, McNemar exact — the
harness's own gate — plus `imageHit@K`, embed throughput and the query-time cost
of the extra leg. Both checkpoints are measured (2B via the D11 shim, 8B via
`llama-server` with MRL ≤ 4000), and a **text-parity run for both checkpoints,
EN + DE**, through the shim's chat-template path is recorded here beside the
MMTEB figures — informational, since D1 does not depend on it. Not in CI: the
gate has no runnable VL model (`nomic-embed-text` is text-only), so CI tests
plumbing against a fake embedder.

### What only production can prove

Everything above is either published, measured on a local shim, or read out of
this codebase. Four things are none of those, and this section exists so that
nobody reads the numbers above as if they were ours:

1. **Retrieval quality on real Confluence pages.** The eval corpus is German
   Wikipedia because it is licensable and committable. Real instances have
   screenshots of internal tools, hand-drawn whiteboards and 12-year-old Visio
   exports, and no published benchmark covers them.
2. **Any number produced locally.** MLX-vs-CUDA numerics, 4/8-bit quantisation
   and vLLM's ~0.92-cosine preprocessing divergence (D12) each move the space.
   Local runs are for plumbing and for eyeballing ranked lists.
3. **Throughput and backfill duration.** No published figures exist — searching
   the model cards, the GitHub README and the full text of `arXiv:2601.04720v2`
   for throughput, images/s or GPU timings returns nothing. What is defensible
   is the *shape*: cost is dominated by visual tokens, so a 1280-token image is
   roughly 10–25× a short text query at any model size, and the 8B is ~4× the
   2B's weights. Measure the real corpus on the real card before scheduling a
   backfill.
4. **Whether 2B or 8B is worth it here.** D5 is a recommendation with a decision
   procedure attached, not a result.

### Consequences

- **Two indexes, two models, two failure modes.** An operator who never assigns
  `image_embedding` gets today's behaviour exactly, including no extra latency:
  the leg does not run and the query is embedded once.
- **`page_embeddings` stays text-only by construction (D6)**, so #1116's shadow
  swap, `page_avg_embedding`, MMR, rerank and sibling assembly need no
  image-awareness — now or later.
- **A model change on the image side is destructive and cheap** (D7), and a
  vLLM upgrade is one (D12). Both are operator-visible actions, not background
  drift.
- **The image leg can degrade alone.** A VL failure bypasses the leg, records
  `degraded_reason = 'image_leg_unavailable'`, and leaves text retrieval and the
  `searchType` label untouched.
- **`resolveAttachmentBytes` is a system read with no ACL** (D9). Its safety is
  a boundary, not a check: routes must keep using the gated readers, and the
  test that walks `src/routes` is what keeps that true as new routes appear.
- **The instruction matcher must learn about `vl` (P1).** `wantsInstructionPrefix`
  (#1329) matches `qwen3` + `embed`, so a Qwen3-**VL**-Embedding id would get the
  flat `Instruct:/Query:` text-side prefix — the wrong format for this family.
  The VL client owns its own formatting and the text-side matcher excludes `vl`,
  so an operator who ever points the *text* `embedding` assignment at a VL model
  gets a bare query rather than a garbled one.
- **Prompt injection rendered as pixels remains unmitigated** and is now
  reachable without a user attaching anything: a synced page can carry an image
  containing instructions. `sanitizeLlmInput` cannot inspect pixels (ADR-021's
  #1154 amendment states the same limitation for uploads); D10's no-OCR fence
  means v1 does not mitigate it. What v1 does do is bound the exposure — at most
  `rag_answer_max_images` (default 2) retrieved images ever reach a completion,
  and only when the chat model is vision-capable.

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
| 012 | RAG Pipeline | pgvector + hybrid search (vector + keyword); embedding model is a DB-resolved use case, column type follows its probed width | Best LLM context quality for Q&A, multilingual; `bge-m3`@1024 bootstrap default, Qwen3-Embedding-4B@2560 `halfvec` measured/recommended (#1114) |
| 013 | Draw.io Support | Read-only rendering + "Edit in Confluence" link | Display diagrams, edit in Confluence |
| 014 | Background Workers | `setInterval` + lock flag + retry limits | Simple, 4 workers (sync, embedding, quality, summary), crash-safe, admin controls |
| 015 | Ollama Architecture | Shared server, global concurrency limit, per-user chat model | Single instance, no per-user URL complexity |
| 016 | Diff View | v1: Accept All/Reject All, v2: individual changes | Ship simple first, iterate |
| 017 | PAT Change Behavior | Invalidate all user data + full re-sync | Safest approach for URL/PAT changes |
| 018 | Draw.io Image Storage | Local filesystem cache + Docker volume | Fast, no Confluence dependency for viewing |
| 019 | Admin Role & Re-embed | Simple role column, first user is admin | Protects destructive re-embed operation |
| 020 | Standalone KB Articles | Shared `pages` table + `source` discriminator + universal SERIAL FK | All features work on standalone articles; no dual-identifier problem |
| 021 | Multi-LLM-Provider Configuration | N named `openai-compatible` providers + per-use-case assignments | Replaces two-slot env-var toggle; supports Ollama via `/v1` shim |
| 022 | RAG retrieval honours per-user space permissions | Post-filter RRF merge by readable space set | Cheap, correct for space-level RBAC; pairs with ADR-023 for per-page |
| 023 | Per-page ACL enforcement for RAG retrieval (Enterprise) | Mirror Confluence per-page view restrictions; resolve ancestor inheritance at sync time | Keeps query path O(topK); regulated-buyer RAG never leaks restricted-page chunks |
| 024 | Multi-instance readiness | Generic Redis pub/sub cache-bus + BullMQ `upsertJobScheduler` + p-limit in-place hot-swap + bounded graceful shutdown + soft-fail per-pod fallbacks | Multi-replica `backend` without an extra coordinator service; advisory-only pub/sub keeps the operator footprint small |
| 025 | Multimodal image retrieval | Dual space: text keeps its embedder, images get their own `page_image_embeddings` index + a non-inheriting `image_embedding` use case + a third RRF leg | VL text retrieval is a measured regression vs. the text model, and a shared space would force every text embed through vLLM's chat-embeddings shape |
