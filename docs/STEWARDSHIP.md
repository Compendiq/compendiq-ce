# Compendiq Stewardship Commitment

**Last updated:** 2026-04-23
**Signed by:** _[TODO founder — full name + title, e.g. "Simon Lutz, Maintainer"]_
**Applies to:** Compendiq Community Edition (this repository)

---

## The commitment

Compendiq is developed under an **open-core** model: the Community Edition (CE) is licensed under **AGPL-3.0** and lives in this public repository; the Enterprise Edition (EE) is a separate commercial offering built on top. To give contributors and customers confidence that the open-core bargain is stable, we publicly commit to the following:

**Every feature that has shipped under the CE license (AGPL-3.0) stays under the CE license. We will not relicense, remove, paywall, or functionally gate any CE feature behind EE in any future release.**

This pledge is the counterpart to the AGPL-3.0 license: the license guarantees legal freedom to use, fork, and redistribute the CE code; this pledge guarantees that we will not shrink what CE *contains* in future releases.

The canonical feature baseline against which this pledge is enforceable is the CE feature list as of release **v0.3.0** (see "Canonical CE feature baseline" below).

---

## What this covers

- **Every route, page, setting, and capability** in the CE codebase at or after v0.3.0 remains in CE.
- **Bug fixes and improvements** to CE features stay in CE — we will not keep a "better" version in EE for a paid feature that already exists in CE.
- **Documentation** for CE features stays in this public repository.
- **Configuration surface** visible in CE (the Settings UI, admin routes, env vars, migration schema) stays in CE.
- **Public roadmap transparency**: material changes to the scope of CE (if ever required — see carve-outs below) will be announced on the public roadmap **before** the release that makes the change.

---

## What this does NOT cover

- **EE-only features that have never shipped in CE** — there is no promise to eventually open-source them. OIDC/SSO, SCIM, custom RBAC, per-page ACL enforcement, compliance reports, webhook push, multi-instance management, PII detection, etc. are deliberately EE-only and may remain so indefinitely.
- **Unmaintainable code paths** — if a CE feature's implementation becomes technically unmaintainable (e.g. depends on a vendored library that has been sunset and has no drop-in replacement), the feature may be **replaced in CE** by an equivalent implementation. The capability stays; the specific implementation may not.
- **Bundled third-party dependencies** — libraries we import into CE are governed by their own licenses. If a dependency changes its license in a way that's incompatible with AGPL-3.0, we may need to swap it out (with an equivalent CE-side replacement where possible).
- **Security patches** — we may **temporarily disable** a CE feature pending a security fix. We will ship the fix as soon as possible and the feature returns.
- **Semantic renames** — a CE feature may be renamed (e.g. `/api/ollama/*` → `/api/llm/*`). The capability stays; the URL path may evolve on a published deprecation window.

---

## Canonical CE feature baseline (v0.3.0)

As of the [v0.3.0 release](./releases/v0.3.0.md), the following capabilities are shipped in CE and covered by this pledge. This list is authoritative against the pledge text; if a future release appears to contradict the pledge, compare against this list.

**Authentication & user management**
- Local username/password authentication with JWT access tokens + rotating refresh-token families
- Register, login, logout, token refresh routes
- Per-user admin listing (`GET /api/users`)
- Global admin role + per-space role assignments (RBAC)
- Groups + group memberships + ACE-level resource permissions
- Audit log (structured event types, metadata, IP/UA capture, admin-tunable retention)

**Confluence integration (Data Center 9.2)**
- Per-user PAT storage (AES-256-GCM encrypted at rest)
- Configurable Confluence base URL + selected-spaces sync
- Incremental + full sync worker with Redis-backed worker lock
- XHTML ↔ HTML ↔ Markdown content pipeline (turndown + jsdom + confluence macros)
- Attachment download + Docker-aware URL rewriting for private-network deployments
- SSRF guard with origin allowlist
- Draft-while-published workflow + version snapshots

**LLM & RAG**
- N-providers model (openai-compatible endpoints; Ollama via /v1 shim)
- Per-use-case provider/model assignment (chat, summary, quality, auto_tag, embedding)
- Per-provider circuit breakers + request queue with backpressure + per-user concurrent SSE-stream limit
- Vector search with pgvector HNSW, hybrid retrieval (vector + keyword), RRF merging
- Prompt injection sanitisation + output reference-stripping
- AI improve / generate / summarise / quality / auto-tag flows with streaming
- LLM request rate limiting + admin-tunable runtime limits

**Knowledge base**
- Pages CRUD (create, read, update, soft-delete, restore, trash, permanent delete)
- Markdown/HTML/XHTML round-trip
- Templates, comments, pinned pages, page versions, knowledge requests
- Full-text search (PostgreSQL, configurable language)
- Tagging + duplicate detection + content analytics
- Article feedback + page-view tracking + verification workflow

**Admin & operations**
- Admin settings UI with rate limits, embedding dimensions, retention policies
- Email/SMTP notifications + Nodemailer templates
- Health + readiness probes
- Data-retention worker (audit log, search analytics, error log, page versions)
- BullMQ + setInterval dual-mode background workers
- Error tracker + correlation IDs + OpenTelemetry optional

**Enterprise extension points present in CE (not features themselves)**
- `app.license` + `app.enterprise` Fastify decoration hook
- `emitLlmAudit()` fire-and-forget hook
- `setSsrfAllowlistPublisher()` hook
- License endpoint `/api/admin/license` (returns community stub when EE is not loaded)
- Dynamic `import('@compendiq/enterprise')` loader with graceful noop fallback

This list will be kept current in each major/minor release's customer-facing notes.

---

## How to verify

- **All CE source is in this repo** under `AGPL-3.0` — see [`LICENSE`](../LICENSE).
- **Release tags are immutable** on GitHub (`v0.1.0` onwards). Any divergence from this pledge is detectable via `git log` + `git diff` against the release tags.
- **Feature diffs against the baseline above** are visible by comparing any release against v0.3.0: `git diff v0.3.0...vX.Y.Z -- backend/src frontend/src` will surface any CE-side removal.
- **Public roadmap** ([`docs/ROADMAP.md`](./ROADMAP.md)) announces any material change to CE scope before the release that implements it.

If you believe this pledge has been violated, open an issue tagged `stewardship` in this repository; the maintainers are expected to respond publicly.

---

## Open process

Beyond the feature pledge, the stewardship of Compendiq is meant to be observable in public. The source of truth for "what's being worked on right now, what's queued next, what shipped recently" is the set of open and closed issues in this repository, filtered by phase label. The human-readable index lives at [`docs/ROADMAP.md`](./ROADMAP.md); the raw data lives on the [issue tracker](https://github.com/Compendiq/compendiq-ce/issues). If you want to understand where Compendiq is going — or influence it with an issue or a pull request — those two surfaces are the canonical answer. The roadmap itself is not a commitment in the legal sense of this pledge, but publishing it is: we commit to keeping it honest, keeping it current, and not running a second, hidden roadmap that contradicts it.

## Changelog

- **2026-04-23** — initial pledge drafted alongside v0.4.0 preparation (CE #296). _Founder review pending._

---

<!--
Founder: before merging this file, please confirm:
  [ ] Signature line at the top reflects your legal name + title.
  [ ] The "What this does NOT cover" carve-outs match your commercial intent.
  [ ] The v0.3.0 feature baseline is accurate for your install — add or remove bullets
      if the v0.3.0 release notes differ from what's listed here.
  [ ] The Changelog entry marks this as a reviewed-and-approved commitment.
-->
