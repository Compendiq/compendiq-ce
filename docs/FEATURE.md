# Compendiq Feature List

Implemented features of Compendiq as of the `dev` branch after v0.9.2. Every entry
was checked against the code (registered API routes, UI components, feature gates).
Detailed usage lives in the [User guide](USER-GUIDE.md) and
[Admin guide](ADMIN-GUIDE.md); release history in [CHANGELOG](../CHANGELOG.md).

**Editions.** Everything in sections 1–12 is Community Edition (CE, AGPL-3.0).
Section 13 lists features whose UI ships in CE but which only activate with an
Enterprise licence (same images, unlocked at runtime).

## 1. Knowledge sources

### Confluence Data Center
- Connect with a base URL and personal access token (PAT); connection test before saving.
- Choose which Confluence spaces to sync; background sync on an interval plus manual sync and sync status.
- Lossless round-trip of Confluence XHTML Storage Format: macros, media, mentions and layouts survive editing and are written back to Confluence.
- Confluence attachments are fetched and cached; admin attachment statistics and orphan sweep.
- Older Confluence page versions are imported into history the first time a page's history is opened.
- Confluence API rate limiting.
- Remove (unsync) a space and its content.
- Confluence is a per-user toggle: switch it off and Compendiq runs as a standalone knowledge base with credentials retained.

### Standalone (local) content
- Local spaces: create, rename, delete, set a space home page, set a space icon.
- Local pages with full create, edit, delete, nesting, drag-and-drop reordering and moving between parents.
- Local attachments for images and files on standalone pages.
- Trash with restore, subtree-aware delete and automatic purge.

### Import
- **Notion import** (one-shot migration): internal-integration token stored encrypted, workspace tree picker, databases as *Table*, *Pages* or *Skip*, runs server-side, repeatable without duplicates, "update existing pages" repair mode.
- **Markdown import**: load a `.md` file into the editor with a server-side preview conversion.
- **Document extraction** for AI reference material: PDF, DOCX, ODT, RTF and plain text.
- **Image import**: paste or drop images; external and data-URI images in pasted HTML are re-hosted through an SSRF-guarded server import.

## 2. Pages

- Page library with sorting, filters (space, author, labels, freshness, embedding state, quality, date range, origin), Local/Confluence origin badges and KPI cards (including embedding coverage).
- Page tree, breadcrumbs and child-page lists.
- Page icons: emoji, icons or uploaded images.
- Version history with diffs, semantic diff and restore.
- Drafts: server-side page drafts with publish, plus private local editor drafts per user.
- Labels: manual tagging, AI auto-tagging, admin label rename and delete.
- Pin pages for quick access.
- Relocate pages between spaces and parents, with a preview first.
- Page connections panel: linked articles, in-section pages and related articles, each with its evidence.
- Duplicate detection per page and an admin duplicates overview.
- Page notes and comments: threads, replies, reactions, resolve and unresolve.
- Page verification: verify, set the owner and set a review interval.
- Watch pages for change notifications.
- Page feedback and view tracking.
- PDF export of one page or a selection.
- Bulk actions: delete, tag, replace tags, re-embed, quality re-analysis and re-sync, with progress tracking.
- Templates: built-in shared templates (Meeting Notes, Incident Report, How-to Guide, ADR, Runbook, Cornell Notes), personal templates, admin-shared templates and "save current as template".
- Page access: the visibility of private and shared pages is applied to lists, trees, search, graph and counts. A per-page access-control API is also available.

## 3. Editor

- TipTap v3 rich-text editor with toolbar, selection bubble menu, block menu with drag handles, and a slash-command menu.
- Text formatting, headings, lists, task lists, quotes, code blocks with language selection and titles, tables with cell, row and column controls, text colours.
- Confluence-style blocks: info, note and warning panels, multi-column layouts, expand sections, status badges, children and attachments macros, table of contents.
- Figure and table indexes, plus image and table captions.
- Diagrams: Mermaid blocks and embedded draw.io editing (the draw.io URL is configurable).
- Emoji picker and inline icons.
- Find and replace.
- Vim mode with a mode indicator.
- Client-side spellcheck with selectable Hunspell dictionaries.
- Image upload by paste or drop, with a lightbox viewer.
- Article outline, summary, details and notes in the right-hand inspector.
- Inline AI Improve on a selection, shown as a diff to apply or skip.

### Collaborative editing and presence

- **Real-time co-editing** of the same article by several users (Yjs over a WebSocket). Concurrent edits merge instead of producing a version conflict. Works on Confluence-synced and standalone pages.
- **Off by default.** Admins enable or disable it under **Settings → Personal → Editor → Collaborative editing**. Turning it off closes all open collaborative sessions.
- **Remote carets and selections** for each co-editor, in a dedicated colour palette that stays readable in both themes.
- **Shared save**: saving commits the shared document as one page version (to Confluence or the local page). Repeated `Ctrl/Cmd+S` presses share one save. Saving is blocked while the session is disconnected or read-only.
- **Read-only sessions** for users who may read but not write; a banner explains this and the content can still be copied.
- **Access checked continuously**: page-read access is verified on join, and the session is closed if the page is deleted or hidden, or access is revoked mid-session.
- **Durable state**: collaborative document state is persisted in PostgreSQL and fanned out through Redis, so it works across multiple backend replicas.
- **Automatic reconnect** with backoff after network drops and session-token refresh.
- **Presence avatars** on the page view show who is currently viewing the article, with a pencil badge for people editing. This works whether or not collaborative editing is enabled and is synchronised across replicas.

## 4. Search

- Keyword search (PostgreSQL full text, with a configurable full-text language) plus fuzzy title matching.
- Semantic search over pgvector embeddings.
- Hybrid search that combines both with Reciprocal Rank Fusion.
- Search suggestions, search logging and search filters.
- Command palette (`Ctrl/Cmd+K`) with page results and private recent searches.
- Knowledge graph: a global graph plus a focused two-hop view per page, with filters kept in the URL and browser back/forward.

## 5. AI assistant

- **Ask (RAG Q&A)**: answers grounded in the knowledge base with citations that link back to the source pages, streamed over SSE.
- Saved Q&A conversations: list, rename, delete, a bookmarkable URL per conversation and automatic titles.
- Assistant docked beside the article (`Alt+I`) or full-page at `/ai`.
- **Deep search**: optional multi-query expansion for each question.
- **Extended thinking** toggle for reasoning-capable models.
- Retrieval-confidence refusal: the assistant declines when the retrieved sources are too weak.
- **Improve**: rewrites an article or a selection, with optional instructions, and applies through a reviewed diff.
- **Generate**: drafts a new article from a prompt, optionally with an attached document or web search.
- **Summarize**: on demand plus a background summary worker.
- **Diagram generation** from text.
- **Quality analysis**: a background worker scores pages; the dimensions are shown in Document health.
- **Auto-tagging**: per page or for all pages.
- Documents and images can be attached as reference material; images are only used when the chat model has vision.
- **Image analysis in retrieval**: a vision model describes images when pages are ingested, so text-only chat models can cite diagrams and screenshots.
- Web search context through the bundled `mcp-docs` sidecar and SearXNG.
- **On-device inline completion**: ghost-text suggestions from a WebGPU model running in the browser. Off by default; needs an admin opt-in and a user opt-in.
- Custom AI prompts per user.
- Knowledge-gap and content-gap signals from questions and search.

## 6. LLM providers and models

- Any OpenAI-compatible `/v1` provider (e.g. Ollama, LM Studio, vLLM, hosted OpenAI-compatible APIs): add, edit, delete, set the default, test the connection and list models.
- Per-use-case model assignment (chat, summary, quality, auto-tag, embedding, rerank, image analysis, inline completion), with a provider locality indicator.
- Optional rerank provider (`/v1/rerank`).
- Vision capability probe for chat and image-analysis models.
- Embedding management: status, process now, retry failed, force-embed a page tree, full re-embed, and admin release of embedding locks.
- **Shadow embedding migration**: backfill a new embedding model next to the current one, compare results with relevance judgements, swap, roll back and clean up.
- Retrieval settings: fetch width, rerank candidates, per-basis confidence thresholds and context budget.
- Retrieval benchmark run from the admin UI.
- LLM request queue, circuit breaker with status, per-user streaming cap and an LLM answer cache that admins can clear.

## 7. Users, access and authentication

- Local accounts with registration; the first user becomes the admin.
- Admin-controlled self-registration policy and a configurable login page.
- JWT access and refresh tokens with rotation.
- Admin user management: create, edit, deactivate, reactivate and delete users.
- System roles, space roles and groups with membership management; permission check API.
- Rate limits configurable in the UI.
- Encryption at rest for the Confluence PAT, provider API keys, SMTP password, Notion token and backup credentials, with admin-triggered key rotation.

## 8. Notifications and email

- In-app notifications: bell with unread count, paging, mark read, mark all read and delete.
- Per-user notification preferences.
- SMTP configuration with a test email and email templates.

## 9. Administration

- First-run setup wizard (welcome, admin account, Confluence, LLM, done) and a Getting Started checklist.
- Settings organised as Personal, Knowledge, AI, Governance and System.
- Workers panel for background jobs (sync, embedding, quality, summary).
- Diagnostics: system status, plus an error dashboard with resolve actions.
- Audit log, written for security-relevant actions including denied admin access.
- Built-in data retention jobs for audit, analytics, error and webhook delivery records.
- Article baselines: activation, per-space governance policy, page freeze and unfreeze, freeze preview and history.
- Admin recovery for page writes interrupted mid-flight.
- Licence status card.

## 10. Backup and restore

- Encrypted backup of the database and attachments.
- Browser download through one-time tickets.
- Scheduled uploads to S3-compatible storage, with a connection test.
- Restore from an encrypted backup.

## 11. Operations and deployment

- Docker Compose stack: frontend (nginx), backend, PostgreSQL with pgvector, Redis, `mcp-docs` and SearXNG, on separate networks.
- One-command installer `scripts/install.sh` (`--dir`, `--port`, `--version`, `--dry-run`) and `scripts/uninstall.sh`.
- Multi-arch release images (amd64 and arm64).
- Optional corporate CA trust via a Compose override.
- Health endpoints: liveness, readiness, startup, setup status, plus a token-protected monitoring endpoint whose token can be rotated.
- Optional OpenTelemetry traces and metrics, off by default.
- Automatic database migrations at startup.

## 12. Interface

- Dark (Graphite) and light (Paper) themes that follow the OS, with a manual override and a font choice.
- Keyboard-first use: shortcuts modal (`?`), `G`-chord navigation, single-key panel toggles, zen mode.
- Responsive layout with mobile navigation.
- Accessibility to WCAG 2.1 AA, enforced by tests: contrast, forced colours and reduced motion.

## 13. Enterprise-licensed features

The UI for these ships in CE and stays inert until an Enterprise licence enables it.

| Feature | What it adds |
| --- | --- |
| OIDC single sign-on | SSO login and admin settings |
| SCIM provisioning | Automated user provisioning |
| Advanced RBAC | Custom role editor |
| Bulk user operations | CSV import and multi-user bulk actions |
| IP allowlisting | Restrict access by CIDR ranges |
| RAG permission enforcement | Confluence page restrictions synced and enforced in retrieval |
| Org LLM policy | Organisation and space AI policies, page AI-policy labels, organisation-wide on-device inference policy |
| AI output review | Review queue with approve, reject or edit-and-approve, plus auto-expiry |
| PII detection | Flag, redact or block PII in AI output |
| LLM audit trail | LLM request audit page |
| Data retention policies | Configurable retention UI |
| Compliance reports | Compliance report generation |
| Document sign-off governance | Approval roles for article baselines |
| Sync conflict resolution | Conflict policy and resolve dialog |
| Webhooks | Signed outbound webhooks (Standard Webhooks) with secret rotation |
| Analytics dashboard | Knowledge health, search and content gaps; AI usage tab |
| Backup DR | KMS, immutable storage, replicas |
