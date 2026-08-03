# CLAUDE.md

Guidance for Claude Code working in this repo. Codex and other AI tools also read this file via their fallback-filename config — keep it tool-agnostic.

## Project

**Compendiq** — AI knowledge-base app over Confluence Data Center, multi-LLM (Ollama, OpenAI-compatible). Monorepo: `backend/` (Fastify 5 + Postgres + Redis), `frontend/` (React 19 + Vite), `packages/contracts/` (shared Zod schemas).

Source-of-truth docs:
- ADRs → `@docs/ARCHITECTURE-DECISIONS.md`
- Diagrams → `@docs/architecture/` (Mermaid; see its `README.md` for the code-area → diagram map)
- Enterprise design → `@docs/ENTERPRISE-ARCHITECTURE.md`

## Mandatory Rules

1. **Tests required** for every change. Vitest everywhere; frontend uses jsdom + `@testing-library/react`. Backend DB tests hit real Postgres (port 5433 via `test-db-helper.ts`) — never mock the DB. Never use `--no-verify`.
2. **Branch model.** Branch from `dev` as `feature/<desc>`. PRs target `dev`. Only `dev → main` may target `main`. If a PR accidentally targets `main`, retarget before merging.
3. **No secrets in commits.** No `.env`, PATs, API keys, JWT secrets, license keys.
4. **Ask when ambiguous** — don't guess at intent.
5. **Follow the ADRs.** Don't deviate without discussion.
6. **Diagrams are source-of-truth.** When a code change affects system structure (compose, domains, ESLint boundaries, table/FK migrations, auth/sync/RAG/license flows, content pipeline), update the matching `docs/architecture/*.md` in the same PR. If unsure which diagram applies, flag it in the PR description.

## Build

```bash
npm install                         # root only — workspaces share one lockfile
npm run dev                         # backend + frontend
npm run build | lint | typecheck    # all workspaces
npm test                            # all suites
npm test -w backend                 # one workspace
cd backend && npx vitest run <file> # single file
npx playwright test                 # E2E (needs backend + frontend running)
docker compose -f docker/docker-compose.yml up -d   # needs POSTGRES_PASSWORD + REDIS_PASSWORD in docker/.env
```

## Architecture

Domain-based backend with ESLint-enforced import boundaries (`eslint-plugin-boundaries`):

- `core` → no domain or route imports
- `confluence` → `core` + `llm` (sync embeddings)
- `llm` → `core` only
- `knowledge` → `core` + `llm` + `confluence`
- `routes/<domain>` → `core` + own domain (knowledge routes may reach all domains)

Layout: `backend/src/{core,domains/{confluence,llm,knowledge},routes/{foundation,confluence,llm,knowledge}}` + `frontend/src/{features,shared,stores,providers}` + `packages/contracts/`. Detailed structure → `docs/architecture/03-backend-domains.md` and `04-frontend-structure.md`.

## Tech Stack (highlights, not a manifest)

Fastify 5 · pgvector (HNSW, `bge-m3`, 1024-dim) · BullMQ (toggleable via `USE_BULLMQ`) · jose / bcrypt · React 19 · TailwindCSS 4 · Radix · TanStack Query · TipTap v3 · Zustand · `turndown` + `jsdom` for content conversion · `pdf-lib` · `nodemailer`. Full deps in `package.json`.

## LLM Provider Model (ADR-021)

N named `openai-compatible` providers in `llm_providers` table, configured via Settings → LLM. Each use case (chat / summary / quality / auto_tag / embedding) inherits a default or pins an explicit `provider+model`. Ollama uses its `/v1` shim — not a separate protocol. Queue + per-provider circuit breakers wrap every outbound call in `openai-compatible-client.ts`.

**Legacy env vars** (`OLLAMA_BASE_URL`, `OPENAI_*`, `LLM_BEARER_TOKEN`, `DEFAULT_LLM_MODEL`, `SUMMARY_MODEL`, `QUALITY_MODEL`, `LLM_MAX_CONCURRENT_STREAMS_PER_USER`, `COMPENDIQ_LICENSE_KEY`) are **deprecated bootstrap fallbacks** — consulted only on fresh install when the DB row / `admin_settings` value is absent. Don't add new env-driven LLM config; extend the providers table or `admin_settings` instead.

**Removed (do not revive):** `LLM_PROVIDER` was the legacy two-slot toggle and is gone — replaced wholesale by the `llm_providers` table + per-use-case assignments.

## Security (Mandatory)

1. **PAT encryption** — Confluence PATs are AES-256-GCM with `PAT_ENCRYPTION_KEY`. Never store plaintext, never expose to frontend.
2. **Zero default secrets** — `NODE_ENV=production` MUST fail to start if `JWT_SECRET` or `PAT_ENCRYPTION_KEY` is default or < 32 chars.
3. **LLM safety** — sanitize user content before sending (prompt-injection guard in `core/utils/sanitize-llm-input.ts`); sanitize output before rendering.
4. **Validation** — Zod schemas from `@compendiq/contracts` on every API boundary. Parameterized SQL only.
5. **Auth** — `fastify.authenticate` on every protected route. Public exceptions: `/api/health`, `/api/auth/*`.
6. **Infra isolation** — Postgres / Redis / Ollama must not bind `0.0.0.0` in production. Use Docker internal networks.

## Testing & Mocks

Mocks exist for CI only (Confluence, Ollama, Redis aren't reachable there).

- DB tests → real Postgres, never mocked.
- Backend route tests → mock external HTTP and auth via `vi.spyOn()` passthroughs; nothing else.
- Frontend tests → mock fetch/MSW at the network boundary, not internal components.
- Pure utilities → test directly with real inputs.
- Mock at the boundary (HTTP), never at the service-function layer.

## Enterprise (Open-Core)

CE is this repo. EE lives in the private `compendiq-enterprise` repo and ships as `@compendiq/enterprise` (loaded dynamically via `core/enterprise/loader.ts`, falls back to `noop.ts`). Both editions ship the **same unmodified CE frontend image** — no EE frontend bundle, no build-time SPA patching. Enterprise UI is gated at runtime via `useEnterprise().isEnterprise`, derived from `/api/admin/license` (`edition !== 'community' && valid === true`).

CE-side extension points (must remain inert in community mode):
- Types/loader/noop/feature flags → `backend/src/core/enterprise/`
- Frontend context/hook → `frontend/src/shared/enterprise/`
- Always-rendered UI surfaces (state-driven, not conditionally compiled): `LicenseStatusCard`, `OidcSettingsPage`, `OidcCallbackPage`. License key-entry form renders only when the API response includes `canUpdate: true` (EE adds it; CE noop omits it).
- LLM audit hook contract → `backend/src/domains/llm/services/llm-audit-hook.ts`

The CE fallback `GET /api/admin/license` route registers **only** when `enterprise.version === 'community'` to avoid duplicate-route errors when EE registers its own.

License format: `ATM-{tier}-{seats}-{expiryYYYYMMDD}-{licenseId}.{ed25519SignatureBase64url}` (v2; v1 omits `licenseId`). Persisted in `admin_settings` under key `license_key`. Full design in `docs/ENTERPRISE-ARCHITECTURE.md`.

## UI/UX (ADR-010 v0.5)

Neumorphic dashboard on a cool slate-and-steel palette. Themes: **Slate Steel** (dark, default — navy `#0E1220` chassis), **Frost Steel** (light — `#F4F6FA`). Steel (`#6EA8FF` dark / `#2F6BD8` light) is the single brand **and** interaction accent; **amber is reserved for warning/attention only**, violet marks AI. Both themes are gradient-lit: `--surface-backdrop` (radial) on the app shell, `--surface-card` (linear) on content panes, `--surface-card-elevated` one step up for `nm-card-elevated`; chrome (sidebar/header/toolbar) stays flat.

Typography: **Space Grotesk** display/headings, **Inter** body, **JetBrains Mono** for code and data figures. All three are the `@fontsource-variable` builds — `font-synthesis: style` forbids faked weights, so a static cut would silently snap headings to the nearest imported weight.

Sixteen `nm-*` `@utility` classes (see `frontend/src/index.css`). Card surfaces (`nm-card`, `nm-card-elevated`, `nm-card-interactive`) paint a **gradient**, i.e. a background-*image* — a Tailwind `hover:bg-*` utility only sets background-color and is painted underneath it, doing nothing. Tint a card-surfaced control with **`nm-card-hover`**; a test walks the `.tsx` sources and fails on the combination. Hybrid neumorphism: every interactive surface keeps a 1px solid border for WCAG 1.4.11 (3:1) and `forced-colors: active` — that border is `--color-border-interactive` (measured ≥3:1 on every surface), **not** the quiet `--color-border` hairline used for separators and panes. Press = inset shadow swap; `prefers-reduced-motion: reduce` strips press transform. Animated gradient mesh background is preserved on the **setup wizard only**. Staggered entrance animations via Framer Motion `LazyMotion`. Status colors: green=connected, red=disconnected, amber=syncing, steel=embedding, violet=AI, slate=inactive.

Palette changes are guarded by `frontend/src/neumorphic-themes.test.ts`, which parses the tokens out of `index.css` and **computes** WCAG ratios rather than pinning hex literals — retune a surface and it fails with the measured ratio.

**Docked AI assistant (#1126).** On `/pages/:id` the assistant is a third column beside `ArticleRightPane`, not a destination — design of record in `docs/superpowers/specs/2026-07-28-docked-ai-assistant-design.md`, topology in `docs/architecture/04-frontend-structure.md`. Its open state is the **ephemeral** `stores/ai-dock-store.ts` (width is the persisted `aiDockWidth`); it ORs the article pane into its rail rather than writing the user's saved `articleSidebarCollapsed`. Improve/Summarize/Diagram/Quality are **chips seeding one thread**, so `runStream`'s `userMessage` appends — never `setMessages([…])`. **Opening the assistant runs nothing (#1176)** — the rail icon, the pane row and `Alt+I` open it and stop; every request starts at a chip or the composer. Don't re-add an on-open action: the trigger cannot choose an improvement type, the dock has no stop control, and closing it does not abort a run. `/ai` keeps only Ask + Generate; the four mode screens still render for `?mode=…` deep links, but nothing offers them. `useIsDockWideLayout()` (`shared/hooks/use-media-query.ts`) is the only JS **width** query in the app — `use-can-hover.ts` and three one-shot checks read `matchMedia` for pointer/motion capability, but every responsive *layout* decision stays a Tailwind class.

**Do not "simplify" the dock's `Apply` into a client-side editor write.** It calls `POST /llm/improvements/apply` deliberately: that route runs `protectMedia`/`restoreMedia` (#723) and the column-layout realignment that 422s when unrecoverable (#781), all of which live in `backend/src/core/services/content-converter.ts` (JSDOM + turndown) with no frontend counterpart. A `marked` + DOMPurify round-trip in the browser strips Confluence macros and media silently, and the next Save pushes the loss to Confluence. `article-view-store` stays read-only mirrors for the same reason, and Apply is disabled while the editor is open.

**Editor block menu (#1179).** Right-clicking a block's drag handle opens a controlled Radix **Popover** (never `@radix-ui/react-context-menu` — `role="menu"` typeahead swallows keystrokes in the free-form Improve input) carrying the bubble menu's formatting row, its Improve section and a Delete. Body + handle wrapper both live in `shared/components/article/EditorBlockMenu.tsx`; the formatting row (`EditorFormatBar.tsx`), the AI section (`ImprovePanel.tsx`) and the quick actions (`improve-actions.ts`) are shared with `EditorBubbleMenu` rather than duplicated. Four rules are load-bearing. (1) Text actions render **only** for `paragraph` / `heading` / `blockquote` / `listItem` (`block-menu-nodes.ts`, a closed allow-list); every macro, atom and container gets **Delete only**, and they are *hidden, not disabled* — Improve ends in `insertContentAt(range, markdownDerivedHtml)`, which over a structured Confluence node is the same silent loss the `Apply` note above warns about. The guard has a **second half at the inline level**: an allowed `paragraph` may still carry `confluenceStatus` / `confluenceUserMention` / `confluenceJiraIssue`, which `doc.textBetween` skips (so the model never sees them — "Ask @jdoe about DONE" is sent as `"Ask  about "`) and which the returned HTML then overwrites. `containsStructuredInline()` hides Improve for those blocks too; formatting toggles stay, because a mark toggle rewrites marks, not nodes. **The selection bubble menu has the same inline-macro flaw and is not yet guarded** — same predicate, different surface. (2) The range is the block's **content** (`pos + 1` … `pos + nodeSize - 1`), never a `NodeSelection` — improving an `h2` must not flatten it to a paragraph. (3) The target is a **node decoration** (`block-menu-decoration.ts`), not a remembered `pos`: it remaps through every transaction, it is the "this block" affordance, and its presence is how `selectionShouldShow` knows to stand down so the bubble menu never stacks a second panel on the block menu's selection. (4) The handle must be frozen with `editor.view.dispatch(tr.setMeta('lockDragHandle', true))` while the menu is open — the **meta**, not the command, because the `DragHandle` *Extension* is not registered (only the React component's plugin), and without it the plugin nulls the node out the moment the pointer travels to the portalled menu. Mouse-only by design: the handle is positioned solely by `mousemove`. Nothing becomes keyboard-inaccessible — formatting and Improve are the bubble menu's own actions and it is keyboard-operable, while Delete (which has no bubble-menu equivalent) falls back to ProseMirror's `NodeSelection` + Backspace. Note that `listItem` is in the allow-list because the decision names it, but the handle runs **non-nested**, so it resolves a hovered list to the `bulletList` / `orderedList` and never to the item inside — `listItem` only becomes live if the handle's `nested` option is turned on.

> **Brand parity caveat:** this palette no longer mirrors `compendiq-landing/src/styles/tokens.css`, which is still on the retired honey system (black `#0A0A0A` + honey `#F9C74F`). Cross-surface parity is broken until the landing page adopts the steel tokens.

## Content Pipeline (ADR-003)

Confluence DC 9.2 = XHTML Storage Format only (no ADF). Pipeline:
```
Confluence (XHTML) ⇄ confluenceToHtml/htmlToConfluence ⇄ DB (body_storage XHTML, body_html clean, body_text plain)
DB (HTML) ⇄ htmlToMarkdown/markdownToHtml ⇄ {LLM: Markdown, Editor/TipTap: HTML}
```
Custom `turndown` rules per Confluence macro (code blocks, task lists, panels, mentions, page links, draw.io). See `docs/architecture/11-content-pipeline.md`.

**Markdown import** on the New Page form is a *conversion*, not a create (#1133).
`POST /api/pages/import/preview` parses YAML front-matter, runs `markdownToHtml` and
sanitizes — and persists nothing. The form loads the result into the editor the way
"Use Template" does, and the normal `POST /api/pages` create saves it with the space,
parent and visibility the user chose. It replaces `POST /api/pages/import`, which
inserted the row itself under a hardcoded `space_key = '_standalone'`. Don't reintroduce
a client-side Markdown→HTML path: `markdownToHtml` has no frontend counterpart.

**Uploaded documents** (#1131) enter through `core/services/document-extractor.ts`, behind
`POST /api/llm/extract-document`: pdf (`unpdf`), docx (`mammoth` → `htmlToMarkdown`), odt
(`content.xml` walk), rtf (control-word strip), md/txt (read directly). The format is decided
by **magic-byte sniffing**, never the client's `Content-Type` — a mismatch against the claimed
extension is a 415. Zip containers (docx/odt) are bounded by `ZIP_LIMITS` and, for docx,
repacked stored before `mammoth` sees them, because mammoth's own inflater is unbounded.

**Images as AI source material** (#1154) enter the same way but stay bytes, not text: they
never join the Markdown/HTML pipeline above. `POST /api/llm/prepare-image` sniffs the format
by magic bytes (png/jpeg/webp/gif — **SVG is never accepted**, both because vision encoders
need raster and because SVG carries script/XXE risk) and stages the validated bytes in Redis
under a per-user, content-addressed handle (`llm:img:<userId>:<sha256>`, 15-minute TTL). Generate
and Improve accept that handle and are refused with a 422 unless the resolved `chat` model
has separately probed as vision-capable (`llm_model_capabilities`, migration 087) — capability
is probed with a known-content image, never declared, because neither the OpenAI-compatible
`/v1/models` response nor Ollama's off-limits native `/api/show` exposes it. `sanitizeLlmInput`
cannot inspect pixels, so prompt injection rendered as an image is an accepted, documented
risk (ADR-021's `#1154` amendment) — not something this path mitigates.

**The frontend half normalises before it stages.** `shared/lib/downscale-image.ts`
re-encodes **every** attached image — not only oversized ones — to **WebP within a 1568px
longest edge**, so the server never sees anything else and most of its rejections
(format, dimensions, payload size) are unreachable. `shared/hooks/use-attachments.ts` owns
both attachment slots on all three AI composers (`/ai` Generate, `/ai` Improve, the dock):
it routes every intake path — click, drop, paste — decides in **one** place whether a file
is a document or an image, owns the shared composer drop target, and holds the 20 MB
document gate. The upload zones gate nothing; they report the file they were handed and
render what they are given. Two rules follow from that: **SVG is refused client-side**,
never rasterized around the server's sniff; and passing **`isDragOver`** to
`DocumentUploadZone` is what declares "the parent owns the drop target", after which the
component attaches no drag handlers of its own — omit it while the hook is listening and
every drop fires twice.

The **`vision` tri-state must never collapse to a boolean**: `false` means probed and
refused, `null` means never established (an inconclusive probe — rate limit, auth hiccup,
open breaker), and they render different text (`VisionBadge`: "Text-only" vs
"Unconfirmed"). Only `true` enables attachment. Each zone emits **one row carrying its own
card and its own trigger** (`composerRowClass`), because `order-*` moves boxes without
moving the tab sequence (WCAG 2.4.3) — don't reintroduce `order-*` anywhere in a composer;
`expectComposerFocusOrder` fails on it.

## Versioning

SemVer, pre-1.0. Single source of truth: **root `package.json` `"version"`**. Backend reads at startup (`core/utils/version.ts` → `APP_VERSION`); frontend injects `__APP_VERSION__` via Vite `define`; mcp-docs reads its own.

Feature PRs to `dev` → no bump. Release (`dev → main`) → bump all five `package.json`s (root, backend, frontend, packages/contracts, mcp-docs), merge, tag `vX.Y.Z`. Patch = bug, minor = feature or pre-1.0 breaking, major = `1.0.0` when production-ready.

## Dependencies

- `npm install` from repo root only — workspaces require a single root lockfile.
- `pino-pretty` is a devDependency (excluded from production images).
- Pin majors for framework deps (React 19, Fastify 5, TipTap v3).
- **Root override `"vite": "^8.0.16"`** unifies the whole tree on a single vite 8 (frontend + vitest + `@tailwindcss/vite` must not split versions). The app runs **vite 8 with `@vitejs/plugin-react` 6.x** — these move together: vite 8's `rolldown` transform contract breaks plugin-react 5.x's native react-refresh wrapper in the dev server (`Missing field moduleType`, #800), so never downgrade one without the other. Rolldown also dropped the **object** form of `build.rollupOptions.output.manualChunks` — it must be the **function** form (see `frontend/vite.config.ts`).

## Code Quality

Readability first. Explicit over clever. ESLint flat config per workspace; TS strict. PRs that change behavior must update the relevant `docs/`, `.env.example`, and this file.

## Environment

Full reference is `.env.example`. Keys you must set:

- `JWT_SECRET` — 32+ chars, required
- `PAT_ENCRYPTION_KEY` — 32+ chars, required
- `POSTGRES_URL`, `REDIS_URL`
- `POSTGRES_PASSWORD`, `REDIS_PASSWORD` — required by docker compose (no defaults; URL-safe values, e.g. `openssl rand -hex 24`)

Tunable defaults (override only with reason): `EMBEDDING_MODEL=bge-m3`, `EMBEDDING_DIMENSIONS=1024`, `FTS_LANGUAGE=simple`, `USE_BULLMQ=true`, `SYNC_INTERVAL_MIN=15`, `LLM_CONCURRENCY=4`, `LLM_MAX_QUEUE_DEPTH=50`, `LLM_STREAM_TIMEOUT_MS=300000`, `LLM_CACHE_TTL=3600`, `QUALITY_*` / `SUMMARY_*` batch+interval, `CONFLUENCE_RATE_LIMIT_RPM=60`, `SHUTDOWN_TIMEOUT_MS=50000` (keep below container stop grace period). TLS escape hatches: `LLM_VERIFY_SSL`, `CONFLUENCE_VERIFY_SSL`, `NODE_EXTRA_CA_CERTS`. Observability: `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`. SMTP: `SMTP_*` (also configurable via admin UI).

OIDC/SSO is EE-only.
