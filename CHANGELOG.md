# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!--
  Claude draft 2026-04-11 (Phase 1 Session 1):
  At launch time (2026-05-05), rename this `[Unreleased]` header to
  `[1.0.0] - 2026-05-05` and insert a new empty `[Unreleased]` section above it.
  The entries below now cover everything the v1.0 on-premise CE launch ships.
  Sections added today for Phase 0 closeout:
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
