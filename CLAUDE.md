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

## UI/UX (ADR-010 v0.6 — flat workspace system)

A flat workspace application, not a dashboard. Themes: **Graphite** (dark, `#0d0e11` chassis) and **Paper** (light, `#f7f7f8`), both neutral, carrying one indigo accent (`#8b93f8` dark / `#4a55c9` light) that is the single brand **and** interaction colour. **Amber is reserved for warning/attention only**, violet marks AI. The craft bar is Linear, Plane and Notion — Compendiq must hold up beside all three.

**Depth is a value step plus a 1px hairline, never extrusion.** Surfaces are FLAT COLOURS: `--surface-backdrop`, `--surface-card` and `--surface-card-elevated` are plain values, not gradients. **Chrome is the ground, content is the pane** — the sidebar, header and toolbars paint `--color-background` and the content pane sits one step *up* from them. That inversion is why the document is the brightest thing on screen and navigation recedes without being dimmed. Do not add a `[data-theme-type="light"]` override for a shell surface; both themes are one token-driven ladder, and retuning the token moves both.

**Exactly one real shadow exists.** `--shadow-overlay` (offset + soft blur) is carried by `nm-card-elevated` alone, for content that genuinely floats above the page: popovers, dropdowns, dialogs, the command palette, toasts. An in-page pane that wants emphasis earns it from position, spacing and heading weight. The retired `--nm-shadow-*` / `--nm-highlight-*` tokens still exist but resolve to `transparent`, so any missed callsite renders flat rather than leaving one embossed control behind.

**No lift, no scale, no glass.** Hover and press are background/border changes. `translateY` on hover, `scale` on press and `backdrop-blur` on an in-flow pane are all retired — blur survives *only* on modal scrims (`fixed inset-0 bg-black/NN`), where it is a specific effect rather than decoration standing in for hierarchy.

Typography: **Inter** for everything, **JetBrains Mono** for code and data figures. There is no display face — a workspace heading is a wayfinding label, and a second family competing at 15–20px costs legibility without buying identity. `--font-display` is an alias onto Inter so existing `font-display` callsites cannot drift. Both are `@fontsource-variable` builds; `font-synthesis: style` forbids faked weights, so a static cut would silently snap headings to the nearest imported weight.

Density: controls are **32px** (buttons, inputs, selects, icon buttons), sidebar tree rows **28px at 13px**, header **48px**, corner scale **10/8/6/4px**. Route titles are 18px semibold. List rows are rows — `px-3 py-2` and a 6px corner — because card geometry stacked forty deep reads as a tile gallery. Both tree implementations (`SidebarTreeView`, `DndLocalSpaceTree`) render in the same rail and must move together.

The sixteen `nm-*` `@utility` classes are kept by name (107 files reference them) but every one is now flat — redefining them in place is what reskins all ~20 routes at once. The retired `--glass-*` tokens resolve onto `--color-*` for the same reason; renaming their ~80 callsites is a mechanical follow-up. Every operable surface keeps a 1px solid border for WCAG 1.4.11 (3:1) and `forced-colors: active` — `--color-border-interactive` (measured ≥3:1 on every surface), **not** the quiet `--color-border` hairline used for separators and panes. `prefers-reduced-motion: reduce` is still honoured. Status colors: green=connected, red=disconnected, amber=syncing, indigo=embedding, violet=AI, slate=inactive.

**Theme preference follows the OS by default.** `system | dark | light`, cycled by the header control. The *preference* is persisted; the resolved palette deliberately is not, so a stale value cannot win over the live OS reading. `startSystemThemeSync` is gated on hydration — an OS event arriving before rehydration would re-serialise the initial `system` over the user's stored choice.

Guarded by `frontend/src/workspace-themes.test.ts`, which parses tokens out of `index.css` and **computes** WCAG ratios rather than pinning hex literals, and which now also fails on a reintroduced shadow, `transform`, gradient surface, or light-theme shell override. `ui-text-legibility.test.ts` enforces an 11px floor on arbitrary font sizes.

**Docked AI assistant (#1126).** On `/pages/:id` the assistant is a third column beside `ArticleRightPane`, not a destination — design of record in `docs/superpowers/specs/2026-07-28-docked-ai-assistant-design.md`, topology in `docs/architecture/04-frontend-structure.md`. Its open state is the **ephemeral** `stores/ai-dock-store.ts` (width is the persisted `aiDockWidth`); it ORs the article pane into its rail rather than writing the user's saved `articleSidebarCollapsed`. Improve/Summarize/Diagram/Quality are **chips seeding one thread**, so `runStream`'s `userMessage` appends — never `setMessages([…])`. **Opening the assistant runs nothing (#1176)** — the rail icon, the pane row and `Alt+I` open it and stop; every request starts at a chip or the composer. Don't re-add an on-open action: the trigger cannot choose an improvement type, the dock has no stop control, and closing it does not abort a run. `/ai` keeps only Ask + Generate; the four mode screens still render for `?mode=…` deep links, but nothing offers them. `useIsDockWideLayout()` (`shared/hooks/use-media-query.ts`) is the only JS **width** query in the app — `use-can-hover.ts` and three one-shot checks read `matchMedia` for pointer/motion capability, but every responsive *layout* decision stays a Tailwind class.

**`/ai` scrolls its message pane, not the page (#1218).** The chat log owns the scroller, and it can only do that because `min-h-0` runs down the **whole** chain: AppLayout's scroll container → `PageTransition` → AppLayout's `max-w-*` wrapper → `AiAssistantPage`'s root → the pane. All four links are load-bearing — a flex item's `min-height: auto` refuses to shrink below its content, so restoring it on any one row puts the page back on the outer scroller and live message text back in the 20px scroll-padding strip above the sticky sub-header and below the input bar (#1186's mechanism, at both ends). Tidying `min-h-0` out of a wrapper class list is the way this returns; `src/ai-scroll-chain.test.ts` fails by name when a row drops it, because jsdom performs no layout and no render test can see it. The bars keep plain `inset-0` under-masks — belt-and-braces through the supported range, live again only where the bars are taller than the column, and **never** with an overhang, which would re-create scrollable overflow in a container that now has none (#769). The clamp is shared by every route: it costs the scroll container's `pb-5` at the scroll end, and any page that caps its own height must clip or scroll its cross-axis-stretched boxes (GraphPage's filter sidebar needed `overflow-y-auto`; its canvas was already `overflow-hidden`).

**Do not "simplify" the dock's `Apply` into a client-side editor write.** It calls `POST /llm/improvements/apply` deliberately: that route runs `protectMedia`/`restoreMedia` (#723) and the column-layout realignment that 422s when unrecoverable (#781), all of which live in `backend/src/core/services/content-converter.ts` (JSDOM + turndown) with no frontend counterpart. A `marked` + DOMPurify round-trip in the browser strips Confluence macros and media silently, and the next Save pushes the loss to Confluence. `article-view-store` stays read-only mirrors for the same reason, and Apply is disabled while the editor is open.

**Editor block menu (#1179).** Right-clicking a block's drag handle opens a controlled Radix **Popover** (never `@radix-ui/react-context-menu` — `role="menu"` typeahead swallows keystrokes in the free-form Improve input) carrying the bubble menu's formatting row, its Improve section and a Delete. Body + handle wrapper both live in `shared/components/article/EditorBlockMenu.tsx`; the formatting row (`EditorFormatBar.tsx`), the AI section (`ImprovePanel.tsx`) and the quick actions (`improve-actions.ts`) are shared with `EditorBubbleMenu` rather than duplicated. Four rules are load-bearing. (1) Text actions render **only** for `paragraph` / `heading` / `blockquote` / `listItem` (`block-menu-nodes.ts`, a closed allow-list); every macro, atom and container gets **Delete only**, and they are *hidden, not disabled* — Improve ends in `insertContentAt(range, markdownDerivedHtml)`, which over a structured Confluence node is the same silent loss the `Apply` note above warns about. The guard has a **second half at the inline level**: an allowed `paragraph` may still carry `confluenceStatus` / `confluenceUserMention` / `confluenceJiraIssue`, which `doc.textBetween` skips (so the model never sees them — "Ask @jdoe about DONE" is sent as `"Ask  about "`) and which the returned HTML then overwrites. `containsStructuredInline()` hides Improve for those blocks too; formatting toggles stay, because a mark toggle rewrites marks, not nodes. **The selection bubble menu runs the same predicate to the same verdict** — see its own note below. One rung further down, a **`link` is a mark, not a node**, so `containsStructuredInline` cannot see it and `textBetween` strips the href before the model ever sees it: that one is **warned about, not hidden** (`containsLossyMarks`), because the text survives, only the address is lost, and links are common enough that hiding Improve for every paragraph containing one would gut the feature. (2) The range is the block's **content** (`pos + 1` … `pos + nodeSize - 1`), never a `NodeSelection`. That keeps the block node when the model answers with a single paragraph — but **it is not sufficient on its own**: `unwrapSingleParagraph` only strips a wrapper for a lone `<p>`, so any multi-block answer stays block-level HTML, and inserting that over a heading's inline range lifts the blocks out and the `h2` is gone (or becomes an `h1`, or a list). "Make longer" on a heading hits this every time, and a heading demoted to body text breaks the page's TOC and anchors on Save. So Replace is **refused for a `heading` whose answer is multi-block** (Insert below stays, so nothing is lost); `paragraph`, `blockquote` and `listItem` are safe by schema and are left alone. (3) The target is a **node decoration** (`block-menu-decoration.ts`), not a remembered `pos`: it remaps through every transaction, it is the "this block" affordance, and its presence is how `selectionShouldShow` knows to stand down so the bubble menu never stacks a second panel on the block menu's selection. (4) The handle must be frozen with `setDragHandleLocked(editor, true)` while the menu is open **and released on close** — the transaction **meta**, not the command, because the `DragHandle` *Extension* is not registered (only the React component's plugin). Without the freeze the plugin nulls the node out the moment the pointer travels to the portalled menu; without the release the handle never tracks the pointer again for the life of the editor. Both directions, and the literal meta key the library reads, are pinned in `use-block-menu-target.test.ts` — the open/close side effects live in that hook precisely because `EditorBlockHandle` is untestable under jsdom (the plugin resolves its node from `mousemove` coordinates). (5) **Escape must be stopped at the menu** — `absorbBlockMenuEscape` on Radix's **`onEscapeKeyDown`**, with both `preventDefault()` and `stopPropagation()`. **Not `onKeyDown`**: it is bypassed when the layer unmounts in Radix's capture pass (React rebuilds its dispatch path from the fiber tree, and there is no fiber left), and again when the key is dispatched from outside the layer — its handler simply never runs in three of `block-menu-escape.test.tsx`'s four cells, so it is not a containment mechanism even where the grid shows it green. The two halves do different jobs: `preventDefault()` makes Radix skip its own dismissal (so `close` runs once, not twice) and, **since #1206**, is the signal `use-keyboard-shortcuts` reads — that hook now yields any single-key shortcut whose keystroke is already `defaultPrevented`, which is what keeps `PageViewPage`'s `Escape` from running `handleCancelEditing()`. Before #1206 it gated solely on `isEditableTarget(event)`, false for a portalled layer, and `stopPropagation` was the only thing saving the user from a "Discard changes?" prompt. `stopPropagation()` stays regardless: `use-keyboard-shortcuts` is not the only listener on `document`, and the others have no reason to consult a flag Radix set. **A new portalled layer over the editor now inherits the shared-hook fix, but only if it marks the event — a layer that neither `preventDefault`s nor stops the key still exits edit mode.** Mouse-only by design: the handle is positioned solely by `mousemove`. Nothing becomes keyboard-inaccessible — formatting and Improve are the bubble menu's own actions and it is keyboard-operable, while Delete (which has no bubble-menu equivalent) falls back to ProseMirror's `NodeSelection` + Backspace. Note that `listItem` is in the allow-list because the decision names it, but the handle runs **non-nested**, so it resolves a hovered list to the `bulletList` / `orderedList` and never to the item inside — `listItem` only becomes live if the handle's `nested` option is turned on.

**Selection bubble menu — inline macros.** `EditorBubbleMenu` reaches the same `insertContentAt` as the block menu, so it runs the same `containsStructuredInline` over the **selection** and reaches the same verdict: **hidden, not warned**. Warning is what `containsLossyMarks` does for marks, where the words survive and only the formatting is lost; an atom takes the *content* with it. And the input half is broken too — `textBetween` drops the atoms before the request is built, so *every* accept path, Insert below included, returns prose derived from text the user never wrote. There is no correct outcome to put behind a warning. The one thing this surface changes is the **copy**: a block target has no remedy, but a selection is the user's own drag, so it names the way out ("Select text around them instead") — and a range that stops at the atom really is clean, because `nodesBetween` does not visit a node whose start equals `to`. Auto-shrinking the selection past the atom was rejected: only well defined when the atom sits at an edge, and silently improving something other than what was highlighted is its own surprise. Two gates, not one. `openAi` refuses on the document, because **Cmd/Ctrl+J never touches the trigger** and hiding a button does not close a keyboard path. `replaceSelection` re-reads the document at click time, because the decoration *widens* to cover anything inserted into the passage while the section is open, and the render gate is a React value that a transaction landing after the last paint leaves a frame stale; that case blocks Replace only (via `ImprovePanel`'s `replaceBlocked`) and leaves Insert below, which destroys nothing. The trigger stays visible while the section is open — it is also the collapse control, and its `aria-controls` must keep pointing at a live panel. The notice is **muted, not amber**, and deliberately **not** a live region, since it appears and disappears on every drag. The `replaceBlocked` message on the open panel *is* amber, and the pair is intentional: the colour tracks whether the user is mid-gesture, not refusal-vs-warning. A notice that flickers past as you drag is noise in amber; a control going dead after you asked for an answer is attention, which is what ADR-010 reserves amber for. The predicate behind both matches **any** non-text inline node, not the three macros by name — a guard in `EditorBubbleMenu.test.tsx` pins the article schema to exactly those three, so a fourth cannot start withholding Improve under copy that no longer describes why.

> **Brand parity caveat:** this palette does not mirror `compendiq-landing/src/styles/tokens.css`, which is still on the retired honey system (black `#0A0A0A` + honey `#F9C74F`). Cross-surface parity has been broken across two palette generations now — the landing page never adopted the steel tokens either. Treat the app as the source of truth and port Graphite/Paper to the landing page when that work is scheduled; do not re-derive the app palette from the landing one.

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

Its size limits (#1178) are a **ladder in two different units**, and every rung must clear
the one below: nginx `client_max_body_size 44m` → the route's `bodyLimit` 8 MiB →
`ImportMarkdownSchema`'s 1,000,000 **characters** → the client precheck in `NewPagePage`.
1,000,000 characters is up to 3 MB of UTF-8 and ~6 MB of JSON-escaped request body, so an
edge limit set to the same *number* as the schema still refuses files the schema accepts —
which is what produced an HTML 413 from nginx naming a limit the app had never heard of.
The edge is **shared with every other `/api/` route**, so size it to the largest `bodyLimit`
behind it (the draw.io attachment route's 40 MiB), never to the route you happen to be
working on; `frontend/src/nginx-api-body-limit.test.ts` parses them out of the backend and
fails if the edge drops below any of them.
`parseFrontMatter` tolerates CRLF and a leading BOM because failing to match is **silent**:
the `---` block renders as body and the import reports success with title and labels gone.

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

**That Redis is shared and `noeviction`, so staging is capacity-gated (#1183).** A full
instance rejects *writes* — BullMQ enqueue included — so `stageImage` reads `INFO memory`
first and answers **503** when the write would take Redis past
`IMAGE_STAGING_MAX_REDIS_PERCENT` (default 80) of `maxmemory`: the image feature degrades
instead of sync, re-embed, summary and quality all failing to enqueue. The check **fails
open** — `maxmemory: 0`, an unreadable reply, or an `INFO` that a hardened deployment has
renamed all proceed — because an unreadable reply is not evidence of pressure, and per
request the write is its own backstop: an `OOM` reply from the `SET` maps to the same 503.
**Don't restate that as "the worst case is a slower 503".** It is true per request and false
per deployment: where `INFO` is unreadable the ceiling never engages, staging fills Redis,
and `OOM` only arrives once BullMQ enqueue is failing beside it — such deployments are back
to the per-user mitigation and their operators must watch `used_memory` themselves. Even
where it engages, the check is check-then-write: concurrent uploads inside the window pass
on the same pre-write reading and can collectively overshoot the reserve, so the percentage
is a soft target under burst, not a hard guarantee. Don't add
a cache in front of the check (a stale "there is room" admits every upload in the window on
one reading) and don't replace it with a staged-bytes counter (a TTL expiry can't decrement
one, so it drifts up until the feature wedges). `MAX_IMAGE_BYTES` is **5 MB** and is the only
*memory* ceiling; `MAX_IMAGE_DIMENSION` stays **4096** on purpose — dimensions bound what the
model looks at, not what Redis holds, and 4096 typically stays reachable in WebP or in JPEG at
moderate quality. Both are pinned by tests, so moving either is a deliberate capacity decision.

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

**A wrong verdict is correctable, and `probe_error` is admin-only** (#1184). Settings → LLM
carries a **Re-check** control on the chat row — `POST /admin/llm-usecases/chat/reprobe-vision`,
a blocking probe of the pair `resolveUsecase('chat')` resolves — plus a disclosure exposing
`probed_at` and `probe_error` from `GET /admin/llm-usecases/chat/vision-capability`. Both are
`requireAdmin`. **Never extend `UsecaseDefaultSchema` with `probeError`**: `GET
/llm/usecase-default` is `fastify.authenticate` but *not* admin-gated, and the probe error is
the provider's raw body, which `llm-http-error.ts` keeps off client-visible paths because it
can echo request fragments and internal topology. It is truncated at
`PROBE_ERROR_MAX_CHARS` on the way out and rendered as plain JSX text — never
`dangerouslySetInnerHTML`, never a Markdown renderer.

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
