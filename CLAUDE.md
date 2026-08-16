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

Fastify 5 · pgvector (HNSW; `bge-m3` 1024-dim default, Qwen3-Embedding-4B 2560-dim `halfvec` measured/recommended — #1114) · BullMQ (toggleable via `USE_BULLMQ`) · jose / bcrypt · React 19 · TailwindCSS 4 · Radix · TanStack Query · TipTap v3 · Zustand · `turndown` + `jsdom` for content conversion · `pdf-lib` · `nodemailer`. Full deps in `package.json`.

## LLM Provider Model (ADR-021)

N named `openai-compatible` providers in `llm_providers` table, configured via Settings → AI Models. Each use case (chat / summary / quality / auto_tag / embedding) inherits a default or pins an explicit `provider+model` — **except `rerank` (#1104), which never inherits: unassigned means the rerank stage is disabled** (it targets a Cohere/Jina-style `/v1/rerank` endpoint the default provider cannot serve; `resolveRerankUsecase`, not `resolveUsecase`, and a dedicated `rerank-client.ts` sharing the queue/breaker infra). Ollama uses its `/v1` shim — not a separate protocol. Queue + per-provider circuit breakers wrap every outbound call in `openai-compatible-client.ts`.

**Legacy env vars** (`OLLAMA_BASE_URL`, `OPENAI_*`, `LLM_BEARER_TOKEN`, `DEFAULT_LLM_MODEL`, `SUMMARY_MODEL`, `QUALITY_MODEL`, `LLM_MAX_CONCURRENT_STREAMS_PER_USER`, `COMPENDIQ_LICENSE_KEY`) are **deprecated bootstrap fallbacks** — consulted only on fresh install when the DB row / `admin_settings` value is absent. `EMBEDDING_MODEL` is one rung further gone: it is **fully inert** since migration 054 (#1114) — `llm-provider-bootstrap.ts` keeps it in `DEPRECATED_VARS` only so that setting it logs a notice, and nothing reads its value, so a fresh install resolves the `embedding` use case to the default provider's `default_model` until an admin assigns it. (`EMBEDDING_DIMENSIONS` is unaffected — it is still the fallback for a missing `admin_settings.embedding_dimensions` row.) Don't add new env-driven LLM config; extend the providers table or `admin_settings` instead.

**Deep search reuses `chat` — do not give it a use case (#1112).** Multi-query expansion asks the `chat` model for two paraphrases of the question, retrieves all three phrasings and fuses them (`multi-query-search.ts`, in front of `hybridSearch` — `/api/search` paginates and must never expand). It is one extra completion for a one-sentence rewrite, so a sixth ADR-021 assignment would be a knob every operator has to set before the feature works at all. It is per-request and **default off** (`deepSearch`, the `searchWeb` precedent), it never expands an exact-identifier or pasted-error query (#1107 pins the first, and the second IS the literal FTS matches), and every failure — timeout, open breaker, no assignment, unparseable reply — soft-fails to the original query alone. Design of record: `docs/architecture/09-flow-rag-chat.md`.

**The toggle that sets it must never be sticky (#1119).** Measured on the #1102 fixture with the rerank stage live, expansion is a large win on the query class it targets (vocabulary-gap R@1 .182 → .424, n=33) and a *loss* on ordinary queries (R@5 .921 → .866 over the other 164, 2W/11L, **McNemar exact p = 0.0225**), at 1.40 → 3.76 s/query. It is net-positive only when a person picks it for the question that needs it, so the chat-surface control is **per-question and resets after every ask** — never a persisted preference, never a remembered mode. A sticky toggle silently applies the measured regression to every ordinary question that follows it. **Shipped in #1119 as `DeepSearchToggle`**, on both Ask composers (`/ai`'s `AskModeInput` and the dock's `DockPanel`) — the two surfaces that post `/llm/ask`. The enforcement is *where the state lives*: plain `useState` in each composer, read into the body and cleared at submit beside `setInput('')`, before the `await`. Not `AiContext` (`thinkingMode` writes localStorage there, `includeSubPages` survives every ask), not `AiThread` (12 retained threads, so it would be per-conversation sticky), not `ai-dock-store` (ephemeral today, but a store is the thing later work persists), not a `?deep=1` param. The reset sits **inside** the submit handler past its guards, so Enter on an empty composer cannot silently discard the choice and an abort or error cannot leave the toggle lit. It clears at two further boundaries: a **dock chip run** (Improve / Summarize / Diagram / Quality post to routes that do not take the flag — a lit control describing a mode the request is not in) and a **conversation switch on `/ai`** (the sidebar swaps the thread under a mounted composer, which no remount tidies up). **The copy names the downside on screen, at rest, and is wired to the control with `aria-describedby`** — a caveat that lives only in a `title` is unreachable by touch, keyboard and screen readers, and "Slower; this question only." reads as slower-BUT-better, the inverse of what was measured. The cost is quoted as **about 2.4 seconds**, not "roughly 2": the delta is 2.36, and rounding down flatters the feature this whole paragraph exists to keep opt-in. `AskMode.test.tsx` and `AiDock.test.tsx` each fail if the flag survives a send, a remount, a chip run or a conversation switch, on any storage write, and if the caveat stops being visible or stops describing the control.

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

**Carve-out — the retrieval eval (#1102) runs a REAL embedding model in CI.**
The `retrieval-eval` job in `pr-check.yml` brings up Ollama as a service
container and embeds the vendored corpus with `nomic-embed-text`, because a
quality metric computed against mocked vectors measures the mock. The model
must read a whole chunk: `all-minilm`'s 256-token window silently embedded
about a sixth of each one, so `assertModelReadsFullChunk` now refuses any
model that returns the same vector for two chunk-sized texts differing only in
their final word. It is a dedicated
job, scoped to PRs that touch retrieval, so the fast path never waits on it.
The rule above still holds everywhere else — and note this model is for
detecting *regressions in retrieval logic*, never for judging a model upgrade:
those comparisons need the real candidates, run locally through the same script
(`docs/runbooks/retrieval-eval.md`), or scored on the real corpus via #1260.
There is no separate model-comparison harness — #1113 was closed without one.

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

A flat workspace application, not a dashboard. Themes: **Graphite** (dark, `#0d0e11` chassis) and **Paper** (light, `#fbfbfc`), both neutral, carrying one **teal** accent (`#4dd0e1` dark / `#0e7490` light) that is the single brand **and** interaction colour. **Amber is reserved for warning/attention only**, violet marks AI. The craft bar is Linear, Plane and Notion — Compendiq must hold up beside all three.

The two teals are not one hue at two lightnesses, and swapping either for "the same colour, adjusted" is how this breaks. Dark carries a bright cyan-teal that clears 4.5:1 against `#16181d`; Paper carries a deep teal because the bright one measures under 2:1 on white. `workspace-themes.test.ts` computes those ratios from the tokens rather than pinning the hexes, so a retune fails with the measured number instead of a diff.

**Depth is a value step plus a 1px hairline, never extrusion.** Surfaces are FLAT COLOURS: `--surface-backdrop`, `--surface-card` and `--surface-card-elevated` are plain values, not gradients. **Chrome is the ground, content is the pane** — the sidebar, header and toolbars paint `--color-background` and the content pane sits one step *up* from them. That inversion is why the document is the brightest thing on screen and navigation recedes without being dimmed. Do not add a `[data-theme-type="light"]` override for a shell surface; both themes are one token-driven ladder, and retuning the token moves both.

**Exactly one real shadow exists.** `--shadow-overlay` (offset + soft blur) is carried by `nm-card-elevated` alone, for content that genuinely floats above the page: popovers, dropdowns, dialogs, the command palette, toasts. An in-page pane that wants emphasis earns it from position, spacing and heading weight. The retired `--nm-shadow-*` / `--nm-highlight-*` tokens still exist but resolve to `transparent`, so any missed callsite renders flat rather than leaving one embossed control behind.

**No lift, no scale, no glass.** Hover and press are background/border changes. `translateY` on hover, `scale` on press and `backdrop-blur` on an in-flow pane are all retired — blur survives *only* on modal scrims (`fixed inset-0 bg-black/NN`), where it is a specific effect rather than decoration standing in for hierarchy.

Typography: **Inter** for everything, **JetBrains Mono** for code and data figures. There is no display face — a workspace heading is a wayfinding label, and a second family competing at 15–20px costs legibility without buying identity. `--font-display` is an alias onto Inter so existing `font-display` callsites cannot drift. Both are `@fontsource-variable` builds; `font-synthesis: style` forbids faked weights, so a static cut would silently snap headings to the nearest imported weight.

Density: controls are **32px** (buttons, inputs, selects, icon buttons), sidebar tree rows **28px at 13px**, header **48px**, corner scale **10/8/6/4px**. Route titles are 18px semibold. List rows are rows — `px-3 py-2` and a 6px corner — because card geometry stacked forty deep reads as a tile gallery. Below `sm` a row's badge cluster may wrap under the title when the title needs the width — content-driven via `max-sm:flex-wrap` + `basis-auto`, never forced, so short rows keep one line and a `shrink-0` badge never truncates the one thing identifying a row. Both tree implementations (`SidebarTreeView`, `DndLocalSpaceTree`) render in the same rail and must move together.

**In the Pages tree, horizontal budget is the scarce resource and the gutter is out of flow.** At the old 256px default, 43 of 57 rendered rows truncated their title — a level-1 row gave the title 158px against Confluence titles that routinely need 250–400 — and no row carried a `title`, a hover card or any keyboard path to the hidden text, so the panel hid the very thing it exists to choose by. About a third of each row bought nothing: a `w-[20px]` placeholder held the chevron's column on **leaf** rows, a `FileText` rendered on 100% of rows (identical on parents and leaves, so it discriminated nothing while costing 21px), and the indent step was 16px where 12 reads the same at 28px. The chevron is now **absolutely positioned in the indent gutter** (`level*12 + 2`, row padding `level*12 + 28`, 44 in the Dnd tree which also hosts the drag grip). Do not "tidy" it back into the flow: out-of-flow is what keeps sibling titles aligned whether or not a page has children — deleting the placeholder from the flow instead leaves a ragged left edge inside every group — and it is what makes the 24×24 hit area free, clearing WCAG 2.5.8 where the old in-flow 18×18 button failed it *and* charged the title for the privilege. It carries `z-10` because at a 12px indent a parent's 12px-wide `.indent-guide` target overlaps its children's chevrons by ~6px and the chevron must win those clicks. Default width is **280**, and the two halves are both needed: widening alone just moves the panel's cost onto the article. Measured result: truncation 75% → 49%, level-1 title 158 → 215px.

**The chevron and the indent guide are mouse affordances, not controls.** Both are `tabIndex={-1}` + `aria-hidden`. As plain focusable buttons the chevrons defeated the tree's own roving-tabindex contract — a 20-parent tree was 21 tab stops, measured 6-instead-of-1 on the 63-page fixture — and each announced a bare "Expand" with no object, so twenty identical "Expand" buttons could not be told apart. Nothing is lost: per ARIA APG the **row** is the control, carrying `aria-expanded`, with `sidebar-tree-keyboard` handling ArrowRight (expand, then descend) and ArrowLeft (collapse). `aria-hidden` is safe on these because axe's `aria-hidden-focus` rule tests tab-order focusability. The rail is an `<aside aria-label="Page tree">` in **both** the expanded and collapsed branches — collapsing used to render a `<div>`, deleting the complementary landmark rather than shrinking it — and the collapsed rail carries a scope glyph, because losing which space you are in was not a reasonable price for narrowing the pane.

**One section-label treatment, and the tree carries no per-row icon.** Section labels are uppercase at **12px** with `tracking-[0.08em]` (`SECTION_LABEL` in `SidebarTreeView`), matching `SettingsSidebar`'s group headings and the editor's menu labels; 11px uppercase fails `ui-text-legibility.test.ts`'s higher floor for capitals. Tree rows render **no page icon at all** — a parent page is still a page, so a folder/document distinction would be a lie, and one identical glyph on every row is cost without information. The **space dropdown is `nm-card-elevated`, never `nm-sidebar`**: the latter is the panel *chassis* utility (`--color-background` + a border-right), so wearing it made a floating layer paint the exact colour of the panel beneath it with no shadow and one edge. It is the canonical `--shadow-overlay` case. Its filter appears past eight spaces and resets on close, and its footer actions sit outside the scroller because they are how you leave the list.

**A failed tree fetch is a failure, not an empty corpus.** `usePageTree` must be consumed with `isError`; reading only `{ data, isLoading }` collapsed a network failure into the empty state and told the user to go sync a Confluence space that was already working. Three states, not one: failed-with-nothing-cached (destructive, the error *is* the content), failed-with-cache (an amber `role="status"` strip above an intact tree — red is failure, amber is degraded), and genuinely empty. The New page action creates `pageType: 'page'` and is labelled accordingly; `folder` is a real page type that `embedding-service`, `quality-worker` and `summary-worker` all exclude, so a control saying "Folder" while creating a page promised an unindexed container and returned an indexed document.

The sixteen `nm-*` `@utility` classes are kept by name (107 files reference them) but every one is now flat — redefining them in place is what reskins all ~20 routes at once. The retired `--glass-*` tokens resolve onto `--color-*` for the same reason; renaming their ~80 callsites is a mechanical follow-up. Every operable surface keeps a 1px solid border for WCAG 1.4.11 (3:1) and `forced-colors: active` — `--color-border-interactive` (measured ≥3:1 on every surface), **not** the quiet `--color-border` hairline used for separators and panes. `prefers-reduced-motion: reduce` is still honoured. Status colors: green=connected, red=disconnected, amber=syncing, teal=embedding, violet=AI, slate=inactive, and one non-status semantic hue: indigo (`--color-info`)=informational — a passive notice or the Confluence info panel, never a state, a measurement, a category chip or anything clickable. **The semantic trio is the status palette by reference, not by copy:** `--color-success` / `--color-warning` / `--color-destructive` are `var()` aliases onto `status-connected` / `status-syncing` / `status-disconnected` in *both* theme blocks. The paper re-declaration is defensive, not load-bearing today: `data-theme` sits on the root element, so the `:root` alias already resolves paper's status values — it becomes load-bearing only if the attribute ever moves off the root or a nested themed region appears, since a custom property substitutes `var()` on the element it is declared on. They used to be byte-identical hex copies, one retune away from an eighth and ninth hue; `workspace-themes.test.ts` fails on a raw value and on info colliding with a reserved hue.

**Those status colours name pipeline STATES, and nothing else may borrow them.** The quality score used to: `QualityScoreBadge` mapped ≥90/70/50 onto `status-connected` / `status-embedding` / `status-syncing`, so a page scoring 65 wore the same amber as a space mid-sync and one scoring 74 the same teal as "embedding" — the two most tightly reserved hues, on the densest scanning surface in the app. A score is a *measurement*, not a state. It now renders as one neutral chip carrying a **4-segment meter**, because filled-segment count is a pre-attentive length channel that keeps a column of scores scannable without colour and survives `forced-colors` and colour blindness; the number and word stay, so the meter is a redundant channel and `aria-hidden` (WCAG 1.4.1). The badge's *statuses* keep status colours, and **failure keeps amber** — it is the one quality state that is genuinely attention-worthy. The AI marker is violet **in every state**: `ArticleSummary` used to switch to teal once the summary arrived, so the same Sparkles glyph read violet in the Assistant tab and teal in the summary card one click apart, and teal implied the card was a control.

The same rule swept the borrowings the aliasing made visible: **categories are neutral chips differentiated by label or glyph** (the Local/Confluence source badges, Shared/Private, the RBAC User chip), **measurements are neutral** (`FreshnessBadge`'s whole ladder — Aging literally wore `status-syncing`; the KPI coverage ring, whose arc *length* is the channel; and `EmbeddingStatusBadge`'s resting `Embedded <date>`, a freshness readout — its live `embedding`/`failed` states keep their hues), **selected is the neutral pressed recipe** (`NewPagePage`'s toggles lit up in each option's borrowed badge hue, amber included), the feedback Yes/No is `nm-button-ghost` (a survey answer, not a state — the irony was documented twenty lines below it on `VerifyButton`), `VisionBadge` is neutral in all three states (the tri-state *labels* are load-bearing, the teal was not), and the LLM settings scope note is muted, not amber — a permanent banner in amber teaches users to ignore amber. Embedding *work* (SyncTab's `embedding` badge, the re-embed progress banner, the shadow-migration cards) wears `status-embedding` teal, not indigo: it is a pipeline state with a reserved hue. Residual `*-success`/`*-warning` callsites are correct by construction through the aliases; auditing whether each *should* be a status statement is a follow-up sweep. Three **known deviations** from the indigo rule remain live pending that sweep — `LicenseStatusCard`'s tier ladder, `NotificationDropdown`'s type icons and `AttachmentsMacroView`'s file-type icons — complete categorical colour ladders where indigo sits beside violet/amber borrows, deferred whole rather than half-de-coloured.

**An honest refusal is a verdict, and it is neutral (#1119).** When retrieval cannot ground an answer the backend runs no completion and returns a real assistant turn saying so, plus the weak sources it declined to use (`refused: true` and `refusalReason` on the final SSE frame, #1105). There are **three** reasons and only one is a threshold verdict (`weak_match`): `semantic_index_unavailable` (the embedding call threw, so the index was never searched) and `no_context` (retrieval returned nothing) refuse **ungated**, because both knobs default to 0 and gating them would ship the honest answer dark in the deployments that never opened Settings → Retrieval — the reversal is argued in `retrieval-confidence.ts` and `docs/architecture/09-flow-rag-chat.md`. The per-reason wording is load-bearing: an outage must never be reported as "the knowledge base has nothing", which is also why `REFUSAL_ANNOUNCEMENT` names the state and leaves the reason to the message it sits above. `refusal.tsx` renders it in both chat surfaces — `/ai`'s `MessageBubble` and the dock's `DockMessage`, or it degrades silently in one of them — as the ordinary bubble ground plus a 1px hairline and a `Not answered` chip. **Not amber:** on an instance whose threshold is set at all this recurs on every question the corpus does not cover, and `/ai` already spends its amber on the zero-embeddings notice sitting directly above it on exactly those instances — two ambers on one screen, one of them permanent-ish, is how the reserved colour stops meaning anything. **Not `text-destructive`** either: that is `Message.isError`, and this request did not fail. So it takes the treatment already settled for a MEASUREMENT rather than a state — the `QualityScoreBadge` / `ConfidenceBadge` de-colouring argument, where the word is the channel. The `ConfidenceBadge` is **suppressed** on a refusal (it would rate an answer that does not exist), the weak sources carry a `Closest matches — not used` heading (bare chips under "I am not answering" read as the sources it answered from), and **both** polite announcers say so instead of "Answer ready" — `/ai`'s *and* the dock's. There are two live regions, and the first cut fixed one: a screen-reader user on the mobile sheet or the inspector tab was told an answer was ready for a turn the server ran no completion for, which is the whole visible treatment above being invisible to exactly the user who depends on the announcement. It stays in the polite region, not the alert one, because a correct response is not worth interrupting for. `loadConversation` maps the stored `refused` marker back onto `Message.isRefusal`, or a reopened thread downgrades the refusal to an ordinary answer; the persisted turn deliberately carries no sources, so the reloaded copy claims none.

Inline code resolves `--inline-code-color` in **both** themes. Paper declares its own value (#7041a8) but a later `[data-theme-type="light"]` rule used to hardcode a red over it, so the token was dead and the two themes rendered different hues rather than one hue at two lightnesses. Retune the token, never re-add a `color` there. `::selection` is mixed from `--color-primary` at 28% so body text keeps 4.5:1 on top of it — there was no rule at all before, which left the editor's highest-frequency interaction at the UA default blue. `workspace-themes.test.ts` guards all of this: the quality badge is parsed for `status-*` and for hex literals, the light inline-code rule for a `color` declaration, and `::selection` for existence and for resolving the token. Each assertion was verified to **fail** against the pre-change source, not merely to pass after it.

**One inline destructive treatment: `nm-action-destructive`.** `nm-button-destructive` stays the filled variant for a dialog footer where deleting is the point of the surface; this is its quiet counterpart for a destructive action sitting *in* a row, menu or list beside ordinary ones. Three disagreed before — the block menu used `text-destructive` + `hover:bg-destructive/10` + a destructive ring, the article inspector `text-destructive/80` + `hover:bg-destructive/8` + the ordinary ring, and Settings → LLM providers **nothing at all**, where `Delete` was an unstyled button identical in weight to `Edit` beside it and its confirm reached for `text-error`, a class this project does not define, so the one moment the UI meant to turn red it rendered as plain text. A user cannot learn "red means destructive" from three reds and an absence. `destructive-treatment.test.ts` pins the three unified surfaces, bans the undefined `*-error` classes, and **ratchets** the count of hand-rolled callsites elsewhere (21 across 14 files) so it can fall but never rise — the rest are a sweep of their own, and some are legitimately different *kinds* of destructive control.

**Collapsing the inspector must not promote deletion.** Expanded, Delete sits behind a `Danger zone` disclosure and then a confirm dialog. The collapsed rail used to raise it to a top-level icon among ten unlabelled glyphs — sharing the confirm made the second step identical and did nothing about the first going missing, so the safety around destroying a page was a function of a layout preference. The rail carries no Delete; it stays reachable by expanding the pane and by its shortcut.

**The Confluence PAT banner is a strip, not a card.** It renders on *every* authenticated route, so as a `nm-card` with an `nm-button-primary` it owned the only filled teal on screen — on `/pages/:id` the loudest element was a setup nag while the page's own primary action sat beside it at a quarter of the weight, and it cost ~145px of an 845px phone viewport. It keeps its reach and loses its rank: one line, muted text, a text-link CTA. Don't give an onboarding prompt the accent back.

**Theme preference follows the OS by default.** `system | dark | light`, cycled by the header control. The *preference* is persisted; the resolved palette deliberately is not, so a stale value cannot win over the live OS reading. `startSystemThemeSync` is gated on hydration — an OS event arriving before rehydration would re-serialise the initial `system` over the user's stored choice.

Guarded by `frontend/src/workspace-themes.test.ts`, which parses tokens out of `index.css` and **computes** WCAG ratios rather than pinning hex literals, and which now also fails on a reintroduced shadow, `transform`, gradient surface, or light-theme shell override. `ui-text-legibility.test.ts` enforces an 11px floor on arbitrary font sizes.

**Docked AI assistant (#1126).** On `/pages/:id` the assistant is not a destination — design of record in `docs/superpowers/specs/2026-07-28-docked-ai-assistant-design.md`, topology in `docs/architecture/04-frontend-structure.md`.

**It is a tab, not a column.** It used to be a third column beside `ArticleRightPane`; on a 1440px screen that put three vertical rules across the window and left the article — the thing the route exists for — squeezed between two panels of chrome. Assistant is now the first of three tabs *inside* the inspector (`InspectorView = 'assistant' | 'outline' | 'details'`), and the choice is local `useState` in `ArticleRightPane`: it is a per-visit view, and persisting it would mean opening a page to an AI panel nobody asked for. It defaults to `outline`, or `details` when the page has no headings. **Assistant is deliberately first** in the tablist — it is what people reach for most and it used to be the one behind an extra step.

`stores/ai-dock-store.ts` survives as the **mobile** sheet's open flag, and stays ephemeral for the same reason a persisted `open` was always wrong. `AiDock` now renders `AiDockSheet` or nothing — `return mobile ? <AiDockSheet /> : null` — so the desktop column is gone from the tree entirely, not hidden by CSS. `ArticleRightPane` still ORs that flag into its own `collapsed` rather than writing the user's saved `articleSidebarCollapsed`. Both assistant surfaces select the action **inside the composer beside Send**: Q&A, five standalone rewrite skills, and Diagram; `/ai` also offers Generate, while the article-side dock deliberately does not because Generate creates a new page rather than acting on the open one. Summarize and Quality are not assistant modes. Selecting an action changes what that same prepared request will do — it must never discard or replace the typed draft. `/ai` therefore keeps draft text in `AiContext.input` across its mode-specific inputs and owns one page-local `AssistantAttachmentsScope` above the mode switch; Q&A, rewrite skills, and Generate reuse that controller, while Diagram keeps existing attachments paused and sends none. The scope clears on `pageId` changes so source material cannot leak into another page context. Deep Search remains local to the Q&A composer and resets when that action unmounts; do not lift it with the shared draft. Action runs **append to one thread**, so `runStream`'s `userMessage` appends — never `setMessages([…])`. **Opening the assistant runs nothing (#1176)** — the rail icon, the pane row and `Alt+I` open it and stop; every request starts from Send. Don't re-add an on-open action: the trigger cannot choose an improvement type, the dock has no stop control, and closing it does not abort a run. `useIsDockWideLayout()` (`shared/hooks/use-media-query.ts`) is the only JS **width** query in the app — `use-can-hover.ts` and three one-shot checks read `matchMedia` for pointer/motion capability, but every responsive *layout* decision stays a Tailwind class.

**`/ai` scrolls its message pane, not the page (#1218).** The chat log owns the scroller, and it can only do that because `min-h-0` runs down the **whole** chain: AppLayout's scroll container → `PageTransition` → AppLayout's `max-w-*` wrapper → `AiAssistantPage`'s root → the pane. All four links are load-bearing — a flex item's `min-height: auto` refuses to shrink below its content, so restoring it on any one row puts the page back on the outer scroller and live message text back in the 20px scroll-padding strip above the sticky sub-header and below the input bar (#1186's mechanism, at both ends). Tidying `min-h-0` out of a wrapper class list is the way this returns; `src/ai-scroll-chain.test.ts` fails by name when a row drops it, because jsdom performs no layout and no render test can see it. The bars keep plain `inset-0` under-masks — belt-and-braces through the supported range, live again only where the bars are taller than the column, and **never** with an overhang, which would re-create scrollable overflow in a container that now has none (#769). The clamp is shared by every route: it costs the scroll container's `pb-5` at the scroll end, and any page that caps its own height must clip or scroll its cross-axis-stretched boxes (GraphPage's filter sidebar needed `overflow-y-auto`; its canvas was already `overflow-hidden`).

**Do not "simplify" the dock's `Apply` into a client-side editor write.** It calls `POST /llm/improvements/apply` deliberately: that route runs `protectMedia`/`restoreMedia` (#723) and the column-layout realignment that 422s when unrecoverable (#781), all of which live in `backend/src/core/services/content-converter.ts` (JSDOM + turndown) with no frontend counterpart. A `marked` + DOMPurify round-trip in the browser strips Confluence macros and media silently, and the next Save pushes the loss to Confluence. `article-view-store` stays read-only mirrors for the same reason, and Apply is disabled while the editor is open.

**Edit-mode action row — tags are a chip.** `TagEditor` used to render open in the sticky bar, where it stacks a pill row, a 12px gap and an input row: ~92px of permanently pinned chrome, the only bar in the app that was not 48px, on the route where vertical space matters most. It is `TagPopover` now — a `nm-button-ghost` chip labelled **"Add tags" / "1 tag" / "n tags"** (`tagChipLabel`) that opens the unchanged editor in a popover. The row also stopped giving three scopes equal weight: the toolbar above acts on the *selection*, the chip on the *page*, Cancel/Save on the *session*.

The inspector's Details tab is the better **grouping** — tags belong with space, parent and version, beside the auto-tagger already there — and it is unavailable: `ArticleRightPane` is `hidden md:flex`, so that would make tagging impossible while editing on a phone, and `useIsDockWideLayout()` is pinned as the only JS width query, so a second mobile control is closed off too. One control that works everywhere beat a better grouping needing two. The Details tab keeps its read-only pills under "Health & labels" — a summary beside freshness and embedding status, not a second editor.

**The 48px is declared, not derived**, via `min-h-[calc(3rem-1px)]` exactly as the context strip below it does, and for the same two reasons. Measured in Chromium, `nm-button-primary` and `nm-button-ghost` are **34px, not the 32px their comments claim** — both put a 1px border outside a 6+20+6 box, and only `nm-icon-button` sets an explicit `2rem`. So padding-derived arithmetic lands on 50px, and Cancel needs `border border-transparent` beside its `py-1.5` to reach 34 with them (that border is arithmetic, not decoration). The `-1px` is the strip's own: the hairline is on the sticky parent, so without it the row measures 49 and its rule sits a pixel below the other three.

**Escape is absorbed, in both branches.** A portalled layer over the editor that leaves the key unmarked dismisses itself *and* runs `handleCancelEditing()`. `absorbPortalEscape` (`shared/lib/absorb-portal-escape.ts`) is the generic form of what the block menu has always done; `absorbBlockMenuEscape` is now an alias re-exported from `use-block-menu-target.ts` so the block menu's pinned tests keep passing. Escape peels one layer at a time, and that decision lives in `TagPopover`, not in `TagEditor`'s own keydown — **Radix binds Escape at `document` with `capture: true`**, so it sees the key before React dispatches from its root container and the editor's handler never runs. `TagEditorHandle.dismissSuggestions()` returns whether it consumed the keystroke; the popover closes only when that comes back false. `autoFocus` is likewise two halves: the editor's effect focuses the input, and the popover must `preventDefault` `onOpenAutoFocus` because child effects run first and Radix's FocusScope would otherwise pull the caret back onto the wrapper.

**Editor block menu (#1179).** Left-clicking (on release) a block's drag handle opens a controlled Radix **Popover** (never `@radix-ui/react-context-menu` — `role="menu"` typeahead swallows keystrokes in the free-form Improve input) carrying the bubble menu's formatting row, its Improve section and a Delete. Body + handle wrapper both live in `shared/components/article/EditorBlockMenu.tsx`; the formatting row (`EditorFormatBar.tsx`), the AI section (`ImprovePanel.tsx`) and the quick actions (`improve-actions.ts`) are shared with `EditorBubbleMenu` rather than duplicated. Four rules are load-bearing. (1) Text actions render **only** for `paragraph` / `heading` / `blockquote` / `listItem` (`block-menu-nodes.ts`, a closed allow-list); every macro, atom and container gets **Delete only**, and they are *hidden, not disabled* — Improve ends in `insertContentAt(range, markdownDerivedHtml)`, which over a structured Confluence node is the same silent loss the `Apply` note above warns about. The guard has a **second half at the inline level**: an allowed `paragraph` may still carry `confluenceStatus` / `confluenceUserMention` / `confluenceJiraIssue`, which `doc.textBetween` skips (so the model never sees them — "Ask @jdoe about DONE" is sent as `"Ask  about "`) and which the returned HTML then overwrites. `containsStructuredInline()` hides Improve for those blocks too; formatting toggles stay, because a mark toggle rewrites marks, not nodes. **The selection bubble menu runs the same predicate to the same verdict** — see its own note below. One rung further down, a **`link` is a mark, not a node**, so `containsStructuredInline` cannot see it and `textBetween` strips the href before the model ever sees it: that one is **warned about, not hidden** (`containsLossyMarks`), because the text survives, only the address is lost, and links are common enough that hiding Improve for every paragraph containing one would gut the feature. (2) The range is the block's **content** (`pos + 1` … `pos + nodeSize - 1`), never a `NodeSelection`. That keeps the block node when the model answers with a single paragraph — but **it is not sufficient on its own**: `unwrapSingleParagraph` only strips a wrapper for a lone `<p>`, so any multi-block answer stays block-level HTML, and inserting that over a heading's inline range lifts the blocks out and the `h2` is gone (or becomes an `h1`, or a list). "Make longer" on a heading hits this every time, and a heading demoted to body text breaks the page's TOC and anchors on Save. So Replace is **refused for a `heading` whose answer is multi-block** (Insert below stays, so nothing is lost); `paragraph`, `blockquote` and `listItem` are safe by schema and are left alone. (3) The target is a **node decoration** (`block-menu-decoration.ts`), not a remembered `pos`: it remaps through every transaction, it is the "this block" affordance, and its presence is how `selectionShouldShow` knows to stand down so the bubble menu never stacks a second panel on the block menu's selection. (4) The handle must be frozen with `setDragHandleLocked(editor, true)` while the menu is open **and released on close** — the transaction **meta**, not the command, because the `DragHandle` *Extension* is not registered (only the React component's plugin). Without the freeze the plugin nulls the node out the moment the pointer travels to the portalled menu; without the release the handle never tracks the pointer again for the life of the editor. Both directions, and the literal meta key the library reads, are pinned in `use-block-menu-target.test.ts` — the open/close side effects live in that hook precisely because `EditorBlockHandle` is untestable under jsdom (the plugin resolves its node from `mousemove` coordinates). (5) **Escape must be stopped at the menu** — `absorbBlockMenuEscape` on Radix's **`onEscapeKeyDown`**, with both `preventDefault()` and `stopPropagation()`. **Not `onKeyDown`**: it is bypassed when the layer unmounts in Radix's capture pass (React rebuilds its dispatch path from the fiber tree, and there is no fiber left), and again when the key is dispatched from outside the layer — its handler simply never runs in three of `block-menu-escape.test.tsx`'s four cells, so it is not a containment mechanism even where the grid shows it green. The two halves do different jobs: `preventDefault()` makes Radix skip its own dismissal (so `close` runs once, not twice) and, **since #1206**, is the signal `use-keyboard-shortcuts` reads — that hook now yields any single-key shortcut whose keystroke is already `defaultPrevented`, which is what keeps `PageViewPage`'s `Escape` from running `handleCancelEditing()`. Before #1206 it gated solely on `isEditableTarget(event)`, false for a portalled layer, and `stopPropagation` was the only thing saving the user from a "Discard changes?" prompt. `stopPropagation()` stays regardless: `use-keyboard-shortcuts` is not the only listener on `document`, and the others have no reason to consult a flag Radix set. **A new portalled layer over the editor now inherits the shared-hook fix, but only if it marks the event — a layer that neither `preventDefault`s nor stops the key still exits edit mode.** Mouse-only by design: the handle is positioned solely by `mousemove`. Nothing becomes keyboard-inaccessible — formatting and Improve are the bubble menu's own actions and it is keyboard-operable, while Delete (which has no bubble-menu equivalent) falls back to ProseMirror's `NodeSelection` + Backspace. Note that `listItem` is in the allow-list because the decision names it, but the handle runs **non-nested**, so it resolves a hovered list to the `bulletList` / `orderedList` and never to the item inside — `listItem` only becomes live if the handle's `nested` option is turned on.

**Selection bubble menu — inline macros.** `EditorBubbleMenu` reaches the same `insertContentAt` as the block menu, so it runs the same `containsStructuredInline` over the **selection** and reaches the same verdict: **hidden, not warned**. Warning is what `containsLossyMarks` does for marks, where the words survive and only the formatting is lost; an atom takes the *content* with it. And the input half is broken too — `textBetween` drops the atoms before the request is built, so *every* accept path, Insert below included, returns prose derived from text the user never wrote. There is no correct outcome to put behind a warning. The one thing this surface changes is the **copy**: a block target has no remedy, but a selection is the user's own drag, so it names the way out ("Select text around them instead") — and a range that stops at the atom really is clean, because `nodesBetween` does not visit a node whose start equals `to`. Auto-shrinking the selection past the atom was rejected: only well defined when the atom sits at an edge, and silently improving something other than what was highlighted is its own surprise. Two gates, not one. `openAi` refuses on the document, because **Cmd/Ctrl+J never touches the trigger** and hiding a button does not close a keyboard path. `replaceSelection` re-reads the document at click time, because the decoration *widens* to cover anything inserted into the passage while the section is open, and the render gate is a React value that a transaction landing after the last paint leaves a frame stale; that case blocks Replace only (via `ImprovePanel`'s `replaceBlocked`) and leaves Insert below, which destroys nothing. The trigger stays visible while the section is open — it is also the collapse control, and its `aria-controls` must keep pointing at a live panel. The notice is **muted, not amber**, and deliberately **not** a live region, since it appears and disappears on every drag. The `replaceBlocked` message on the open panel *is* amber, and the pair is intentional: the colour tracks whether the user is mid-gesture, not refusal-vs-warning. A notice that flickers past as you drag is noise in amber; a control going dead after you asked for an answer is attention, which is what ADR-010 reserves amber for. The predicate behind both matches **any** non-text inline node, not the three macros by name — a guard in `EditorBubbleMenu.test.tsx` pins the article schema to exactly those three, so a fourth cannot start withholding Improve under copy that no longer describes why.

**Edit-mode toolbar.** `EditorToolbar` lives in its own module; `Editor.tsx` re-exports it and keeps the three context strips. It carries **fifteen main controls** plus utilities: a block-type control (headings and text), Quote, Code block, Divider, five marks, three list toggles, two colour pickers and one Insert menu, with header numbering, undo and redo at the far end. The long tail is behind the two menus *with names beside it* — the flat row shipped two different actions under the same `ListTree` glyph and no label, which is the failure mode a wall of icons has. Nothing was removed; `EditorToolbar.test.tsx` asserts the Insert menu item by item against what the flat row carried, so a restructure cannot quietly drop one.

Four things in it are load-bearing. (1) **A text field never goes inside the menu.** Image URL and status label open a Radix *Popover* from the menu, because `role="menu"` typeahead swallows printable keystrokes — the same trap the block menu's Improve input documents above, reached from a different direction. `onCloseAutoFocus` is preventDefaulted while a prompt is pending, or Radix returns focus to the trigger in the same tick the popover autofocuses its input, and the input loses. (2) **The roving tabindex is the whole point of `role="toolbar"`.** `use-toolbar-roving-focus.ts` gives the bar one tab stop and arrow-key travel; without it the bar was 31 sequential stops between the prose and Save. Its `root.contains(event.target)` guard is not defensive coding — Radix portals its menu content out of the DOM but *not* out of the React tree, and React replays events up the React tree, so an arrow pressed inside an open Insert menu genuinely arrives at the toolbar's handler. Vertical arrows are deliberately not claimed: ArrowDown on a trigger is how Radix opens a menu. (3) **The pressed state is plain CSS in `index.css`, not nested inside `@utility nm-icon-button`** where it belongs by subject. Tailwind emits a nested `&[aria-pressed='true']` in the production build but **not** through the dev server, so the state was invisible while working on it and correct only once built. It also has to sit after the `forced-colors` and `prefers-reduced-motion` blocks, which name `.nm-icon-button:hover` at the same (0,2,0) specificity — on a tie the later rule wins, and being last is what stops a pressed button dropping back to merely-hovered. Its colour is **neutral, not teal**: `nm-pill-active` states the rule that the accent is reserved for actions, and six toggles lighting up teal read as six primary buttons. `EditorFormatBar` shares the recipe, because those are the same six toggles and they used to render teal there and neutral here. (4) **Separators hide below `sm`**, where the bar wraps — a divider that lands at the end of a wrapped row separates a group from nothing — and the container's horizontal gap opens to 8px instead so the grouping still reads. Menu section labels are uppercase at **12px, not 11**: `ui-text-legibility.test.ts` holds capitals to a higher floor than body text.

> **Cross-surface parity:** `compendiq-landing` is on this palette — same
> chassis, same teal, same Inter, `paper`/`graphite` theme IDs — as of its
> `feature/graphite-paper-parity` branch. **The app is the source of truth**;
> port outward, never re-derive the app palette from the landing one.
>
> Parity is **brand-deep, not rule-deep**, and deliberately so. v0.6's flatness,
> its 10/8/6/4 radii and its single shadow are answers to being a workspace that
> should recede behind a document. A marketing page has the opposite job and
> keeps its radial backdrop, its card gradients and its softer radii. Don't
> "fix" that by copying `nm-*` utilities across.
>
> **The mark is the part no token sweep reaches**, and it has lagged the palette
> at every rebrand — honey survived into steel, steel survived into Graphite.
> The values must be literals, because four of the five files are static SVGs
> that render with no custom properties available. `logo-color-parity.test.ts`
> ties them back to the tokens. The landing page now serves the app's SVGs
> directly rather than keeping its own raster of a *different* mark, and its
> social card — a PNG, which is why it stayed honey through two rebrands — is
> generated by `npm run og` and guarded by `npm run og:check`.

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
"Unconfirmed"). Only `true` enables image attachment. The dock's single **Attach document
or image** control stays available for documents in every state; its shared router refuses
an image with the verdict-specific reason when vision is not `true`. Attachment cards remain
their own DOM rows (`composerRowClass`), and the one shared trigger follows those rows, so
focus follows what the eye reads (WCAG 2.4.3). Don't reintroduce `order-*` anywhere in a
composer; `expectComposerFocusOrder` fails on it.

**A wrong verdict is correctable, and `probe_error` is admin-only** (#1184). Settings → AI Models
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

Tunable defaults (override only with reason): `EMBEDDING_DIMENSIONS=1024`, `USE_BULLMQ=true`, `SYNC_INTERVAL_MIN=15`, `LLM_CONCURRENCY=4`, `LLM_MAX_QUEUE_DEPTH=50`, `LLM_STREAM_TIMEOUT_MS=300000`, `LLM_CACHE_TTL=3600`, `QUALITY_*` / `SUMMARY_*` batch+interval, `CONFLUENCE_RATE_LIMIT_RPM=60`, `SHUTDOWN_TIMEOUT_MS=50000` (keep below container stop grace period). TLS escape hatches: `LLM_VERIFY_SSL`, `CONFLUENCE_VERIFY_SSL`, `NODE_EXTRA_CA_CERTS`. Observability: `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`. SMTP: `SMTP_*` (also configurable via admin UI).

**Removed (do not revive): `FTS_LANGUAGE`** — the keyword-index language lives in `admin_settings.fts_language`, edited in Settings → AI Models → Retrieval; the env var was inert on every migrated instance because migration 049 seeds the row (`ON CONFLICT DO NOTHING`, before any request), so the `?? process.env.FTS_LANGUAGE` fallback it fed was unreachable. A set value is reported as ignored at startup. The allow-list is `FTS_LANGUAGES` in `packages/contracts` — one closed list for the select, the route and `getFtsLanguage`, and it stays closed because PostgreSQL has no bind-parameter form for a `regconfig`, so the chosen name is interpolated into SQL. **It is not one of the Retrieval panel's nine knobs, and three rules keep it apart.** `GET /admin/settings` answers with `getFtsLanguage()`, never the raw row: the reader discards a value outside the allow-list (psql, a restored dump, a future migration — none pass through Zod), so the raw row can name a language search is not using and the schema itself rejects. The upsert and the corpus-wide `UPDATE pages SET tsv` are **one transaction** with `SET LOCAL statement_timeout = 0` — two autocommitted statements let a failed rebuild strand the row saying `german` over an index still built as `simple`, which is the silent wrong-index failure the env var caused, and a deployment setting `PG_STATEMENT_TIMEOUT` (pool-wide) fails a corpus-wide UPDATE *deterministically*. It runs after the other knobs land, so a rebuild failure cannot discard settings that already validated. And **"Reset all to defaults" skips it** (`{ ...DEFAULTS, ftsLanguage: prev.ftsLanguage }`), with a muted line beside the button saying so: its default is `simple`, so bundling it with nine cheap resets put a German instance one click plus Save away from re-indexing its whole corpus back to no stemming.

OIDC/SSO is EE-only.
