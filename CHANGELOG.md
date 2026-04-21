# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **BullMQ re-embed-all worker + admin lock visibility** -- replaces the `TODO(#257)` stub in `enqueueReembedAll` with a real worker. Fixed `jobId='reembed-all'` collapses concurrent triggers; explicit lazy-removal sweep lets a completed jobId be reused on the next POST. Worker waits on per-user embedding locks (up to `REEMBED_WAIT_LOCKS_MS`) and emits `phase: 'waiting-on-user-locks'`. New admin-only `GET /api/admin/embedding/locks` returns `EmbeddingLockSnapshot[]` (userId, holderEpoch, ttlRemainingMs). `POST /api/admin/embedding/locks/:userId/release` is the force-release escape hatch — audit-logged via `ADMIN_ACTION.embedding_lock.force_release_embedding_lock`, with a holder-epoch guard in `processDirtyPages` that re-reads the lock every 20 pages and aborts on mismatch. Configurable `reembed_history_retention` admin setting (default 150, min 10, max 10000, migration 055) drives BullMQ `removeOnComplete`/`removeOnFail`. Frontend `ActiveEmbeddingLocksBanner` with per-row Force-release (inline-confirm pattern). (#257, PR #261)
- **Per-user concurrent SSE-stream limit** -- prevents a single user from saturating the upstream LLM by opening many streams. Redis counter `llm:streams:<userId>` with Lua-atomic `INCR + EXPIRE + cap-check`; `release()` fires on all lifecycle paths (success, error, timeout, client disconnect). Admin-configurable cap `llm_max_concurrent_streams_per_user` (default 3, min 1, max 20, migration 056), cascades `admin_settings` → env `LLM_MAX_CONCURRENT_STREAMS_PER_USER` → hard default. 60s TTL cache mirrors `rate-limit-service`. Graceful lowering: in-flight streams complete, new opens see the new cap. Wrapped 6 streaming routes (`llm-ask`, `llm-generate`, `llm-improve`, `llm-summarize`, `llm-quality`, `llm-diagram`) with 429 on exceed. UI: new "Runtime limits" card in `LlmTab.tsx`. Admins share the cap — no role-based bypass. (#268, PR #273)
- **Denied admin-action audit + retention** -- `requireAdmin` now writes an `ADMIN_ACCESS_DENIED` audit row on every 401/403, capturing `actorUserId`, `requestIp`, route + method, and `reason: 'not_admin' | 'unauthenticated'`. Forensic visibility into admin-endpoint probes by non-admins. Retention piggy-backs on `data-retention-service.ts` with a new `admin_access_denied_retention_days` admin setting (default 90, min 7, max 3650, migration 057) — targeted `DELETE FROM audit_log WHERE action = 'ADMIN_ACCESS_DENIED' AND created_at < NOW() - INTERVAL '<N> days'` in a batched `LIMIT 10000` loop, so brute-forcers can't grow `audit_log` unbounded. Other audit actions keep their existing policy. UI: new section in `DataRetentionTab.tsx` (CE-native, renders regardless of EE gate). (#264, PR #276)

### Changed

- **`/api/ollama/circuit-breaker-status` → `/api/llm/circuit-breaker-status`** -- renamed to match the post-#256 provider-keyed surface. Originally shipped with a 6-month RFC 9745 deprecation window (`Deprecation: @<epoch>`, RFC 8594 `Sunset:`, `Link: rel="successor-version"`), but retired same-day in #277 since no external consumers had adopted the alias yet. Canonical path is the only one served; the old path returns 404. (#266 + #277, PR #272 + #278)
- **`listActiveEmbeddingLocks` upgraded from SCAN to a dedicated Redis set** -- Lua-atomic acquire/release maintains `embedding:locks:active` alongside `embedding:lock:<userId>` keys. Lookup uses `SMEMBERS` + pipelined `PTTL`/`GET` instead of a keyspace-wide scan. Self-heal: a stale set member (SADDed but no matching lock key after a process crash) is returned with `ttlRemainingMs: -2` and scrubbed asynchronously. Output shape (`EmbeddingLockSnapshot[]`) unchanged; all existing callers continue to work. (#265, PR #275)
- **Per-provider circuit-breaker map invalidates on provider deletion** -- previously, `providerBreakers` in `circuit-breaker.ts` only invalidated on provider *updates* via cache-bus bump. Deleted providers left stale entries until an unrelated bump happened to touch the same id — causing O(n) map growth over process lifetime. Fix: `deleteProvider()` emits a `providerDeleted(id)` event via an extended in-process cache-bus; the resolver's listener invokes `invalidateDispatcher(id)` + `invalidateBreaker(id)` + `configCache.delete(id)`. `listProviderBreakers()` stops reporting the deleted id on the next tick. (#267, PR #270)

- **Chat use-case assignment wired** -- admin-set `chat` provider/model overrides in Settings → LLM → Use case assignments now route `/api/llm/{ask,generate,improve,summarize,generate-diagram,analyze-quality}` through `providerStreamChatForUsecase`. Override semantics: if admin pinned the model too, body model is locked; if only the provider is pinned, the user-passed model is kept (matches `auto_tag` precedent). When no override is set, per-user routing is preserved byte-for-byte. The chat row in the UI is re-enabled. (#217)
- **BullMQ worker queues** -- replace `setInterval` background workers with Redis-backed BullMQ job queues for sync, quality analysis, summary generation, token cleanup, and data retention. Dual-mode: `USE_BULLMQ=false` falls back to legacy workers. Job history table for observability. (#179)
- **Users email + display name** -- migration 051 adds `email` (nullable, partial unique index), `email_verified`, and `display_name` columns to the users table. Auth endpoints return these fields. (#178)
- **LLM request queue with backpressure** -- configurable concurrency (default: 4), queue depth limit (default: 50), per-request timeout. Health endpoint exposes queue metrics. (#181)
- **LLM audit hook extension point** -- fire-and-forget `emitLlmAudit()` for CE/EE audit logging. Zero overhead when no hook registered. Wired into ask, improve, and generate routes. (#183)
- **Confluence API rate limiting** -- token bucket rate limiter (default: 60 req/min, admin-configurable). Applied before every Confluence API call including attachment downloads. (#180)
- **Email notification service** -- Nodemailer SMTP transport with 5 inline-CSS email templates (sync completed/failed, knowledge request, article comment, license expiry). Admin SMTP settings UI with test email button. (#182)

### Documentation

- **ADR-014 rewritten** -- retired the stale "A simple `setInterval` is sufficient" paragraph that had survived #256 / #257 unchanged and contradicted the actual `queue-service.ts` inventory. New Decision section documents BullMQ as primary with `USE_BULLMQ=false` as a legacy escape hatch, lists the actual queues (`sync`, `quality`, `summary`, `maintenance`, `reembed-all`, `analytics-aggregation` stub) with concurrency + schedule, and includes a "Why BullMQ over `setInterval`" rationale grounded in multi-process locks, on-demand jobs, and job-history observability. Original rationale preserved as a labeled Superseded block for audit trail. (#263, PR #274)
- **Pre-#256 banner on historical QA-500 report** -- `docs/issues/ai-assistant-qa-internal-server-error.md` now opens with a note flagging that the symbol/path references in the body (e.g. `ollamaBreakers.embed`, `llm-chat.ts:340`, `rag-service.ts:197`) predate the multi-LLM-provider migration in #256 / #259 / #262 and may not resolve against the current tree. Body untouched — preserves the "as observed" state the report documents. (#269, PR #271)

## [0.2.0] - 2026-04-14

<!--
  Phase 1 public launch release. Covers everything from Phase 0 closeout
  through the public repo launch.
  Sections added during Phase 0 + Phase 1:
    - First-run setup wizard with backend-derived resume
    - One-command installer
    - Enterprise plugin architecture (open-core extension points)
    - Settings → License + System tabs (DB-backed license management)
    - Build info surfaced via /api/health + SystemTab
    - Test coverage gates (backend ≥70%, frontend ≥60%)
    - E2E test suite (Playwright) for critical user flows
    - Performance harness (k6) with 1000-page baseline
-->

### Added

- **First-run setup wizard** -- 5-step onboarding (admin account → LLM provider → Confluence connection → space selection → sync trigger), resumable from backend state if interrupted, re-runnable from `/admin/setup`
- **One-command installer** -- `install.sh` script auto-generates secrets (`JWT_SECRET`, `PAT_ENCRYPTION_KEY`), pulls published Docker images, creates `docker-compose.yml` + `.env`, and opens the first-run wizard in the browser. Tested on macOS 14 and Rocky Linux 10.
- **Enterprise plugin architecture (open-core)** -- `backend/src/core/enterprise/` provides the plugin loader, type contracts, and noop fallback for the optional `@compendiq/enterprise` package. When the enterprise package is absent, CE runs unchanged with all enterprise features disabled.
- **License management via UI** -- `Settings → License` shows the current edition, seats, expiry, and feature availability. When an EE backend is detected, admins can paste a signed license key directly into the UI (persisted in the `admin_settings` database table).
- **Build info display** -- `Settings → System` now shows the running edition (CE/EE), backend commit hash, frontend commit hash, and build timestamp, sourced from `build-info.json` and `/api/health`.
- **E2E test suite (Playwright)** -- covers user registration/login, article create/edit/delete, RAG Q&A with SSE streaming, settings flows, keyboard shortcuts, PDF export, and a mocked Confluence sync flow (the real-DC variant remains available via environment variables).
- **Performance harness (k6)** -- `perf/seed-test-data.ts` seeds 1000 pages + 3000 embedding chunks; `perf/search-load-test.js` runs a ramping load scenario against `/api/search` with a `p(99)<500ms` threshold. Baseline on MacBook / Docker Desktop: p99 = 9.28 ms against 500 ms target (54× headroom).
- **Test coverage gates** -- backend ≥70% on routes (baseline: 79.05% lines, routes aggregate 84.11%); frontend ≥60% (baseline: 67.03% lines). Enforced in `vitest.config.ts` thresholds.
- **Confluence Data Center integration** -- bidirectional sync with XHTML storage format conversion, support for Confluence macros (code blocks, task lists, panels, user mentions, page links, draw.io diagrams)
- **Multi-LLM provider support** -- Ollama (default) and OpenAI-compatible APIs (OpenAI, Azure OpenAI, LM Studio, vLLM, llama.cpp, LocalAI), configurable per-user or server-wide
- **RAG-powered Q&A** -- ask questions across the entire knowledge base using pgvector hybrid search (vector cosine similarity + full-text keyword search + RRF re-ranking)
- **Real-time AI chat** -- SSE streaming for LLM responses, conversation history, multi-turn dialogue
- **AI article improvement** -- grammar, structure, clarity, technical accuracy, and completeness analysis modes
- **Article generation** -- create articles from prompts using runbook, how-to, architecture, and troubleshooting templates
- **Content summarization** -- generate concise summaries of long articles via LLM
- **Auto-tagging** -- automatic label suggestions based on LLM content analysis
- **Knowledge graph visualization** -- interactive relationship map between pages
- **Auto-quality analysis** -- background worker that scores articles on structure, completeness, and readability
- **Auto-summary generation** -- background worker that generates summaries for pages missing them
- **Page management** -- full CRUD operations, version history with diffs, tagging, commenting, pinning, search
- **PDF export and import** -- export pages as PDF documents, import content from PDF files
- **OIDC/SSO authentication** -- integrate with external identity providers, configured entirely via the Admin UI
- **RBAC with custom roles** -- role-based access control with granular permissions (view, edit, delete, admin)
- **Rich text editor** -- TipTap v3 editor with full Confluence macro round-trip support, optional Vim modal editing, Notion-style block drag-and-drop, find-and-replace, image/table captions with auto-numbering and figure/table index, code block language selector with auto-detection, header numbering toggle, inline status label editing with styled badges, and clipboard image paste/drop upload
- **Draw.io diagram display** -- read-only rendering of draw.io diagrams with "Edit in Confluence" links
- **Confluence macro rendering** -- interactive Children Pages macro (expandable inline), Attachments macro with download links, in addition to existing code blocks, task lists, panels, user mentions, and page links
- **Keyboard shortcuts** -- comprehensive shortcuts for navigation, actions, editor, and panel management
- **Dark and light theme** -- system-aware with manual toggle, glassmorphic UI design
- **Audit logging** -- track user actions and system events for compliance
- **Duplicate detection** -- find similar or duplicate content across spaces
- **Knowledge gap detection** -- identify missing documentation topics
- **Knowledge requests** -- request new documentation topics, track knowledge gaps
- **Page verification workflow** -- review and verify knowledge base articles
- **Notifications** -- in-app notification system for updates and reviews
- **Content analytics** -- track page views, engagement, and search patterns
- **Search** -- keyword, semantic (vector), and hybrid search modes
- **Local spaces** -- create knowledge base spaces independent of Confluence
- **Attachment handling** -- sync and cache Confluence attachments (images, draw.io files)
- **Circuit breaker** -- automatic fault isolation for LLM and external service connections
- **Encryption key rotation** -- zero-downtime rotation of PAT encryption keys with versioned key support
- **Docker deployment** -- production-ready Docker Compose with health checks, multi-stage builds
- **OpenTelemetry** -- optional distributed tracing support for observability
- **API documentation** -- auto-generated Swagger UI at `/api/docs`
- **Rate limiting** -- global rate limiting with stricter limits on admin and LLM endpoints
- **Multi-user support** -- per-user Confluence PAT storage with AES-256-GCM encryption

### Changed

- **PDF generation** -- replaced `playwright-core` with `pdf-lib` for a lighter, headless-browser-free implementation
- **Article actions layout** -- AutoTagger and PDF export controls moved to the ArticleRightPane for a cleaner editing experience
- **Confluence sync** -- page deletion now uses soft-delete detection, preserving local history on Confluence-side deletes
- **RAG re-ranking** -- fixed RRF key assignment so cross-method score boosting between vector and full-text results works correctly
