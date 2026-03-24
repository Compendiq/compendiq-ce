# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- **Rich text editor** -- TipTap v3 editor with full Confluence macro round-trip support
- **Draw.io diagram display** -- read-only rendering of draw.io diagrams with "Edit in Confluence" links
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
