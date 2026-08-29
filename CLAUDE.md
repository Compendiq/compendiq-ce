# CLAUDE.md

Guidance for Claude Code working in this repo. Codex and other AI tools also read this file via their fallback-filename config — keep it tool-agnostic.

## Project

**Compendiq** — AI knowledge-base app over Confluence Data Center, multi-LLM (Ollama, OpenAI-compatible). Monorepo: `backend/` (Fastify 5 + Postgres + Redis), `frontend/` (React 19 + Vite), `packages/contracts/` (shared Zod schemas).

Source-of-truth docs:
- ADRs → `@docs/ARCHITECTURE-DECISIONS.md`
- Diagrams → `@docs/architecture/` (Mermaid; see its `README.md` for the code-area → diagram map)
- Enterprise design → `@docs/ENTERPRISE-ARCHITECTURE.md`

## Mandatory Rules

1. **Tests required** for every change. Vitest everywhere; frontend uses jsdom + `@testing-library/react`. Backend DB tests hit real Postgres (port 5433 via `test-db-helper.ts`) — never mock the DB. PR Check runs backend tests without coverage (frontend is its own job); the aggregate floors in `backend/vitest.config.ts` are for local `npm run test:coverage`. Never use `--no-verify`.
2. **Branch model.** Branch from `dev` as `feature/<desc>`. PRs target `dev`. Only `dev → main` may target `main`. If a PR accidentally targets `main`, retarget before merging.
3. **No secrets in commits.** No `.env`, PATs, API keys, JWT secrets, license keys.
4. **Ask when ambiguous** — don't guess at intent.
5. **Follow the ADRs.** Don't deviate without discussion.
6. **Diagrams are source-of-truth.** When a code change affects system structure (compose, domains, ESLint boundaries, table/FK migrations, auth/sync/RAG/license flows, content pipeline), update the matching `docs/architecture/*.md` in the same PR. If unsure which diagram applies, flag it in the PR description.
7. **Documentation research via Ref MCP.** When researching external library documentation, APIs, framework behavior, or technical specifications, use the `ref` MCP tools (`ref_search_documentation`, `ref_read_url`) whenever the tool is available.

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
- `routes/foundation` → `core` + `llm` + `confluence` (provider health/list-models, the LLM queue knobs, the confidence-basis resolver, and the Confluence connection test/sync overview — see #1347 below)
- `routes/confluence` → `core` + `confluence`
- `routes/llm` → `core` + `llm` + `confluence` (sub-page context, `getClientForUser` — this allowance predates #1347 and was already enforced once the rule started firing)
- `routes/knowledge` → `core` + `llm` + `confluence` + `knowledge` (the top-level aggregator — it may import any domain)

**The routes rule was inert until #1347.** `boundaries/elements` patterned each route element as `src/routes/<x>/*` with `mode: 'folder'`, which only classifies a SUBFOLDER of that directory — every route file lives directly in `src/routes/<x>/`, so none of them ever matched an element and `boundaries/dependencies` silently never applied to any route file (a `routes/foundation` file importing `domains/knowledge` passed `npm run lint` clean). Patterns are now bare folder paths (`src/core`, `src/routes/foundation`, …), which `mode: 'folder'` classifies whether the file sits directly in the folder or a subfolder of it. `boundaries/no-unknown-files: error` is on, so a `src/` file with no element mapping now fails lint outright — this is what caught `src/telemetry-register.ts`, added to the `app` element. `backend/src/eslint-boundaries.test.ts` pins both directions (a disallowed import fails, an allowed one and `no-unknown-files` behave as configured) by linting synthetic probe source through ESLint's Node API, so a config regression is a red test rather than a silent no-op. Once the rule actually fired, whole-tree lint reported 7 real violations, all `routes/foundation` reaching into `domains/llm`/`domains/confluence` for the reasons listed above — the allow-list above reflects that widening rather than re-homing those seven call sites (an L-size change to route registration, rejected as out of scope).

Layout: `backend/src/{core,domains/{confluence,llm,knowledge},routes/{foundation,confluence,llm,knowledge}}` + `frontend/src/{features,shared,stores,providers}` + `packages/contracts/`. Detailed structure → `docs/architecture/03-backend-domains.md` and `04-frontend-structure.md`.

## Tech Stack (highlights, not a manifest)

Fastify 5 · pgvector (HNSW; `bge-m3` 1024-dim default, Qwen3-Embedding-4B 2560-dim `halfvec` measured/recommended — #1114) · BullMQ (toggleable via `USE_BULLMQ`) · jose / bcrypt · React 19 · TailwindCSS 4 · Radix · TanStack Query · TipTap v3 · Zustand · `turndown` + `jsdom` for content conversion · `pdf-lib` · `nodemailer`. Full deps in `package.json`.

## LLM Provider Model (ADR-021)

N named `openai-compatible` providers in `llm_providers` table, configured via Settings → AI Models. Each use case (chat / summary / quality / auto_tag / embedding) inherits a default or pins an explicit `provider+model` — **except `rerank` (#1104), which never inherits: unassigned means the rerank stage is disabled** (it targets a Cohere/Jina-style `/v1/rerank` endpoint the default provider cannot serve; `resolveRerankUsecase`, not `resolveUsecase`, and a dedicated `rerank-client.ts` sharing the queue/breaker infra) **and `image_embedding` (#1115), which never inherits for the same reason one rung stronger** — a text embedder answers the plain shape with a plausible but wrong vector, so unassigned means the image leg is off (see the multimodal block below). Ollama uses its `/v1` shim — not a separate protocol. Queue + per-provider circuit breakers wrap every outbound call in `openai-compatible-client.ts`.

**Client inference (#1418 / ADR-026) is not an ADR-021 use case.** The browser WebGPU SLM never inherits, never talks to Hugging Face, and falls through to #1417 / `/llm/improve` when it is not ready. Unassigned `inline_completion` plus the Editor setting “Use on-device suggestions when no server model is assigned” (default on) may run local ghost text only when the worker is ready. Hunspell EN/DE is a separate MIT worker, not GPU. Runbook: `docs/runbooks/client-inference.md`.

**Legacy env vars** (`OLLAMA_BASE_URL`, `OPENAI_*`, `LLM_BEARER_TOKEN`, `DEFAULT_LLM_MODEL`, `SUMMARY_MODEL`, `QUALITY_MODEL`, `LLM_MAX_CONCURRENT_STREAMS_PER_USER`, `COMPENDIQ_LICENSE_KEY`, `RAG_EF_SEARCH`) are **deprecated bootstrap fallbacks** — consulted only on fresh install when the DB row / `admin_settings` value is absent. `EMBEDDING_MODEL` is one rung further gone: it is **fully inert** since migration 054 (#1114) — `llm-provider-bootstrap.ts` keeps it in `DEPRECATED_VARS` only so that setting it logs a notice, and nothing reads its value, so a fresh install resolves the `embedding` use case to the default provider's `default_model` until an admin assigns it. (`EMBEDDING_DIMENSIONS` is unaffected — it is still the fallback for a missing `admin_settings.embedding_dimensions` row.) Don't add new env-driven LLM config; extend the providers table or `admin_settings` instead.

**Deep search reuses `chat` — do not give it a use case (#1112).** Multi-query expansion asks the `chat` model for two paraphrases of the question, retrieves all three phrasings and fuses them (`multi-query-search.ts`, in front of `hybridSearch` — `/api/search` paginates and must never expand). It is one extra completion for a one-sentence rewrite, so a sixth ADR-021 assignment would be a knob every operator has to set before the feature works at all. It is per-request and **default off** (`deepSearch`, the `searchWeb` precedent), it never expands an exact-identifier or pasted-error query (#1107 pins the first, and the second IS the literal FTS matches), and every failure — timeout, open breaker, no assignment, unparseable reply — soft-fails to the original query alone. Design of record: `docs/architecture/09-flow-rag-chat.md`.

**The toggle that sets it must never be sticky (#1119).** Measured on the #1102 fixture with the rerank stage live, expansion is a large win on the query class it targets (vocabulary-gap R@1 .182 → .424, n=33) and a *loss* on ordinary queries (R@5 .921 → .866 over the other 164, 2W/11L, **McNemar exact p = 0.0225**), at 1.40 → 3.76 s/query. It is net-positive only when a person picks it for the question that needs it, so the chat-surface control is **per-question and resets after every ask** — never a persisted preference, never a remembered mode. A sticky toggle silently applies the measured regression to every ordinary question that follows it. **Shipped in #1119 as `DeepSearchToggle`**, on both Ask composers (`/ai`'s `AskModeInput` and the dock's `DockPanel`) — the two surfaces that post `/llm/ask`. The enforcement is *where the state lives*: plain `useState` in each composer, read into the body and cleared at submit beside `setInput('')`, before the `await`. Not `AiContext` (`thinkingMode` writes localStorage there, `includeSubPages` survives every ask), not `AiThread` (12 retained threads, so it would be per-conversation sticky), not `ai-dock-store` (ephemeral today, but a store is the thing later work persists), not a `?deep=1` param. The reset sits **inside** the submit handler past its guards, so Enter on an empty composer cannot silently discard the choice and an abort or error cannot leave the toggle lit. It clears at two further boundaries: a **dock chip run** (Improve / Summarize / Diagram / Quality post to routes that do not take the flag — a lit control describing a mode the request is not in) and a **thread switch on `/ai`**, which since #1361 keys on `AiContext`'s `activeThreadId` rather than on the sidebar — New chat, opening a saved conversation and Back/Forward between two `/ai/c/:id` URLs all swap the thread under a mounted composer that no remount tidies up, while typing, a `?q=` prefill and a first answer's promotion from `draft` to `conv:<id>` deliberately leave it lit because none of those is a different conversation. **The copy names the downside on screen, at rest, and is wired to the control with `aria-describedby`** — a caveat that lives only in a `title` is unreachable by touch, keyboard and screen readers, and "Slower; this question only." reads as slower-BUT-better, the inverse of what was measured. The cost is quoted as **about 2.4 seconds**, not "roughly 2": the delta is 2.36, and rounding down flatters the feature this whole paragraph exists to keep opt-in. `AskMode.test.tsx` and `AiDock.test.tsx` each fail if the flag survives a send, a remount, a chip run or an `activeThreadId` change, on any storage write, and if the caveat stops being visible or stops describing the control.

**Multimodal image retrieval (#1115, ADR-025).** Text keeps the Phase-1 text embedder; a vision-language model embeds *images* into a separate `page_image_embeddings` index, and the question is embedded once per space. Don't merge the two: VL text retrieval is a measured regression against the text model, and one space would force every text embed through vLLM's chat-embeddings wire shape (argued in ADR-025 D1). The local parity gate agreed and changed nothing — both VL checkpoints clear `bge-m3`, neither beats Qwen3-Embedding-4B (ADR-025 **Measured** §A). Design of record: `docs/superpowers/specs/2026-08-16-multimodal-image-retrieval-design.md`; operations: `docs/runbooks/image-index.md`. **The use case.** `image_embedding` is `rerank`-shaped: it never inherits, and unassigned means the leg is off (D3). Reach the model only through `vl-embedding-client.ts` — a `messages` array with a trailing empty `assistant` turn and `continue_final_message: true` — never `generateEmbedding`'s `{model, input}`, which skips the chat template and pools a different position (D4, `vl-embedding-client.test.ts`). Probe BEFORE the assignment row is written: `probeImageEmbedding` blocks and a failure is a 422 that refuses the row, because a wrong verdict here fills an index with plausible garbage instead of merely disabling a control (`llm-usecases-image-embedding.test.ts`). The index identity is `provider:model@baseUrl#dims` over the RESOLVED model, and a change to it — or to the probed width — TRUNCATEs, retypes, reindexes and re-dirties every page (D7/D12, `image-embedding-index.integration.test.ts`). Send the MRL truncation width on every image-side call (`admin_settings.image_embedding_target_dimensions`, one reader in `core/services/image-embedding-target-dimensions.ts`) and let the probe refuse a server that ignores it (D5). A server upgraded in place behind the same URL is invisible to every signal in the code: that one is a manual re-scan (runbook §8). **Intake** (`image-embedding-service.ts`, runbook §5). Take the store from the URL PREFIX in `body_html` — `/api/attachments/` vs `/api/local-attachments/`, both of which really occur there — never from `confluence_id IS NULL`, which names the Confluence tree for exactly the pages whose bytes left it. Skip and COUNT, never resize: SVG, draw.io XML behind a `.png`, over `MAX_IMAGE_BYTES`, over `MAX_IMAGE_DIMENSION`, missing, past `rag_images_per_page_max`, external with the knob off (D10). Reuse a row whose sha256 and model still match, at no request at all — that is what makes D7's truncate-and-rescan affordable. Keep `image_embedding_dirty` RAISED while the use case is unassigned: the flag is the queue, so clearing it drains the backlog against an index nothing is filling. Clear it only when nothing FAILED — a skip is a fact about the file, a failure is a fact about the endpoint. Raise it from every writer that can move an image: the attachment writers through `core/services/image-embedding-dirty.ts`, the `body_html` writers inline in the UPDATE they already own (`image-embedding-dirty.integration.test.ts`). Let the reconcile KEEP a `missing` row — clearing a cached file never touches `body_html`, and the lazy re-fetch is what refills it; the one other thing that removes index rows is the #1349 attachment orphan sweep (`attachment-sweep-service.ts`, admin-triggered and dry-run-first), and the two cannot collide: it deletes rows only for files it removed, a file it removes is referenced by no body anywhere, and a `missing` row's file IS referenced — so it sits in the sweep's global keep-set and is never a candidate. The sweep's own rules are stated once, in that module's header (reserved root stores skipped by name, the global per-store keep-set, the 24h grace, plain files only, unreadable ≠ absent, delete-time re-verification), with the operator view in `docs/ADMIN-GUIDE.md` "Attachment Storage & Orphan Sweep", the stores in `docs/architecture/06-data-model.md` and the index-side note in `docs/runbooks/image-index.md`. Event-driven removal is the other half and obeys different rules: a hard delete or purge drops `local/<pk>/` and `page-icons/<pk>/` unconditionally, and the shared-keyspace `<pk>/` only when no page claims that `confluence_id` and the directory has aged past a 5-minute grace, consulting NO keep-set (`standalone-attachment-cleanup.ts`). Unconditional is about ownership, not timing: every icon discard rides a COMMITTED `DELETE … RETURNING id`, never a cleanup transaction's rollback branch, where the page is still there and the mark is its only copy. Run the worker under `worker:lock:image-embedding-index`, never the per-user `embedding:lock:*`, and renew its holder epoch from a timer armed for the run's LIFETIME; one page can outlive the key, so a page-boundary check has exactly the hole it is meant to close (`image-embedding-worker.integration.test.ts`). **The leg** (`image-leg-search.ts`, fused in `rag-service.ts`; runbook §6, `docs/architecture/09-flow-rag-chat.md`). Gate on four conditions and do NO retrieval work when shut — `imageLeg` not `false`, `rag_image_leg_enabled`, the use case assigned, the table non-empty. Fuse it as a page-denominated THIRD RRF leg: a page's best image ranks it once, so image count cannot beat image quality (#1106's rule). Spend ONE VL call per request, bounded at 3s, with the kNN carrying its own 2s `statement_timeout`; the two compose, and neither bounds "the leg" on its own. Run it on deep search's ORIGINAL question only, or the same evidence enters the merge three times as though three phrasings had independently agreed. Give an image-only page its `chunk_index 0` row, or its title flagged `imageTextSynthesized`. Keep an image-ONLY row out of `computeRetrievalConfidence` entirely and never let a cross-modal similarity feed the number: `weak_match` is unchanged, `no_context` is not — a page the leg reaches stands it down. Record a bypass as `degraded_reason = 'image_leg_unavailable'` and let a text-side reason win the one column. Share `visiblePagesPredicate` with the vector leg rather than copying it; an image row carries no ACL of its own. Budget a SECOND vector-pool connection per hybrid search, and raise `PG_VECTOR_POOL_MAX` before enabling the leg on a busy instance. Put matched pictures on the `/llm/ask` wire as `kind: 'image'` with `similarity: null`, appended after the page and web entries, capped at four. There are no query-class exemptions — the leg runs for every question the gate admits (`image-leg-search.integration.test.ts`). Since #1361 the same ENTRY is persisted per assistant turn through the chip allow-list — `toPersistedSources` copies `kind`/`attachmentUrl` together, never singly, and drops `score` like every other source — and echoed back by `GET /llm/conversations/:id`, which is a replay of `/llm/ask`'s own output, not a second wire. **The answer path** (`retrieved-images.ts`; D8/D8a/D8b, runbook §7). Read attachment bytes through `core/services/attachment-store.ts`'s `resolveAttachmentBytes`, which applies **no ACL** — legal only after retrieval has applied `visiblePagesPredicate` and the EE per-page filter, which is why the pick is a `domains/llm` service and why `attachment-store.test.ts` walks `src/routes` and fails if any file there names it. Attach bytes only when `getVisionCapability` reads exactly `true`; `false` and `null` both mean text-only. Order the parts text, the USER's own attachment, then the retrieved ones, and add ONE system sentence only when a picture really was attached. Say NOTHING when a gate shuts: the answer is text-only and UNQUALIFIED, the pictures stay in `sources[]`, and the fact is stated once beside the Retrieval knob (D8). Never count a retrieved image as `otherGrounding` — the pick runs after the refusal decision, so a refused turn reads no bytes at all. Refuse `image_only_context` when every returned row is `imageTextSynthesized` AND zero parts were attached AND nothing else grounds the turn; `every`, never `any` (D8a, `llm-ask.test.ts`). Keep `RETRIEVED_IMAGES_BYTE_BUDGET` a CONSTANT derived from `MAX_IMAGE_BYTES` — never a knob, never a literal (D8b). Audit COUNTS only (`retrievedImageCount` / `retrievedImageBytes`, absent rather than 0), and keep base64 out of the audit by construction. The answer cache key gains a 15th component, so every deployment cold-starts its answer cache once for one `LLM_CACHE_TTL` (`retrieved-images.test.ts`). **Settings surfaces.** Settings → AI Models → LLM providers carries the **Image embedding** row — the assignment, **Truncate to N dimensions (MRL)**, the **Last probe** chip and **Re-check**, which on a width or endpoint change rebuilds rather than merely reporting. Settings → AI Models → Embeddings carries the **Image index** card: status, counters, last run by skip reason, **Process now** and **Re-scan all** (`ImageIndexCard.test.tsx`). Settings → AI Models → Retrieval carries the **Image retrieval** group — **Image leg**, **Images per page**, **Index external images**, **Images shown to the model** — with a MUTED unassigned note and the controls left enabled, because they are settings rather than actions (`RetrievalTab.test.tsx`).

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
(`docs/runbooks/retrieval-eval.md`), or scored on the real corpus during a
#1116 shadow migration's `ready` window via the shadow card's **Compare on
real queries** (#1260): `shadow-compare-service.ts` samples the most frequent
`search_analytics` queries, embeds each once per model (prefix per model),
retrieves top-K from `embedding` and `embedding_next` through `vectorSearch`'s
allow-listed `column` option, and reports AGREEMENT (top-1 change rate,
Jaccard, RBO) plus per-query disagreements — never presented as quality. An
unfilled candidate row must never enter the top-K: that column is nullable by
construction (the dual-write leaves it NULL when the candidate provider fails
on a page edited mid-migration), `NULL <=> $2` is NULL, and `1 - null` is 1 in
JS — a PERFECT MATCH that would inflate every figure computed from it. What
guarantees that is the `distance !== null` filter in JS, which also covers the
LIVE column between a swap and its cleanup (the swap drops the renamed
column's NOT NULL) and which `rag-service.integration.test.ts` falsifies by
dropping the HNSW index. The shadow arm's `AND embedding_next IS NOT NULL` is
a NARROWING beside it, not the guarantee: `ORDER BY` is ASC and therefore
NULLS LAST, so such a row cannot displace a scored one under the LIMIT — no
test can make that clause fail, and its comment must not claim a fetch-budget
effect it does not have. A transient failure costs its own query
(`failedQueries` on the report), never the 46 comparisons already paid for;
only a majority of failures fails the run. Mode 2 judgements accumulate in
`embedding_compare_judgements` (101) keyed by **provider AND model on each
side** — the same name behind a different provider is a different index — and
quote a McNemar p only from 20 **live-or-candidate PICKS**, never from a total
that ties inflate (fourteen ties plus six picks published `p = 0.031` from six
clicks). That key carries **no admin dimension on purpose** — one query is one
McNemar trial, so a per-judge key would let two admins vote it twice and
inflate N and the p drawn from it; the cost, stated in 101's header and in
`06-data-model.md`, is that on a multi-admin instance the last judge of a
query wins it and the stored page-id arrays carry THAT judge's visibility.
Runs reuse `retrieval_benchmark_runs`
(`config.kind = 'shadow-compare'`), so a comparison and the production
benchmark exclude each other — deliberately, both spend the shared LLM queue —
**and BOTH 409s are worded by the run that HOLDS the slot** (`slotBusyMessage`,
beside `staleRunError`; a route may not import another route) **while the
holder's id is withheld unless it is the caller's OWN run of the caller's own
kind** — `activeBenchmarkRun` reports `requestedBy` for that decision alone, and
both `:id` reads are scoped by kind AND by `requested_by`, so a foreign id is a
card re-attached to a run whose every poll 404s. The exclusion is
the owner decision and both cards' copy states it; telling an operator refused
by a comparison that "a production retrieval benchmark is already running" is
not part of that decision, and it named a run that does not exist on the one
surface consulted to find out what is holding the slot. Both route suites
`importActual` that module rather than hand-writing a stand-in: the previous
factories defined a `class extends Error {}` the route's `instanceof` could not
have distinguished from the real one, and a `slotBusyMessage` that did not
exist at all — so the sentence never once ran in the suite pinning its wording.
The whole row lifecycle is ONE module, `eval/benchmark-run-lifecycle.ts`:
the two private copies diverged inside a single review round, the stale sweep
failing comparisons with "start a new benchmark" and the benchmark's own
`GET /:id` serving compare runs to a renderer that dereferences
`report.baseline`. Its fetch takes the expected `kind` as a REQUIRED argument
in both directions, and a compare run is additionally scoped to
`requested_by` — the report's titles came out of that admin's ACL. `GET …/compare`
(no id) answers this admin's latest run, because the card's `runId` is
component state and a comparison outlives a tab switch — but only a run whose
config carries the candidate PAIR that is live now: run rows outlive the
migration that produced them, so an aborted migration's report was otherwise
adopted into the next migration's card, under a heading naming the new
candidate, with live judgement controls beside it. That pair check is a
PREDICATE of the query (`config @> $2::jsonb`, a bind parameter), never a
filter over its one row: applied after `ORDER BY created_at DESC LIMIT 1` it
discarded the completed comparison of the pair that is live NOW whenever any
newer run named another candidate, so an operator who tries X, tries Y and
comes back to X loses X's report and re-spends its N x 2 embedding calls. The
card's half of that is `refetchOnMount: 'always'` plus a cache seed at start;
`staleTime: Infinity` alone served the first mount's `{run: null}` back to the
second one, so the re-attachment worked only across a full reload. The judged
verdict renders **Recall and MRR beside the p and withheld with it** — both
come off the same scored picks, so quoting them under a withheld p publishes
the quality half of a verdict the server declined to state; the surface is a
labelled `region` with a real heading, because a completed run puts four
judgement controls per disagreeing query above the assignments grid, its Save
and the runtime-limits card in tab order. **The section lives inside the card's
`ready` branch, so every way a run can end is also a way the section can
vanish** — a mid-run Abort took the progress line, the section and any failure
strip away within one poll while the run failed server-side and nothing
rendered the reason, and the pair-scoped re-attachment above cannot recover it
BY DESIGN. So the two surfaces that survive the unmount speak instead: the
section reports an in-flight run UP to the card (read BEFORE the lifecycle
request, because that request's own `refresh()` is what unmounts the reporter),
the card warns that the comparison ended, and a run that fails while still
mounted is additionally toasted — a toast renders at the app root, the strip
does not. **The card's warning is keyed on the migration WINDOW, latched by
run id, and outlives the branch it was raised in.** The window, because the
server ends a run on the state row's fingerprint while `phase` is recomputed
from a live `embedding_next IS NULL` count on every poll — one page whose
shadow embed failed mid-window (a shadow failure must never fail the live
embed) flips ready → backfilling with the row untouched, and a phase-keyed
signal announced an ending to a run that was still going, still held the
one-active slot, and prescribed a remedy the compare route's own 409 refuses.
That branch keeps the id and says so, and the section re-adopts the run when
`ready` returns; `Re-run backfill` therefore passes `endsMigrationWindow:
false`, because path-blind arming would fire on exactly that button. Latched
by id, because `post()` snapshots the in-flight id BEFORE its request while
the 5s poll can raise the same ending inside that window — a real abort takes
a table lock and drops columns, so the POST losing that race is the ordinary
case, and one ending produced two identical toasts. Outliving the branch,
because a toast is gone in seconds and the fact it reports is that N × 2
embedding calls were spent for nothing: the ending is a dismissible amber
`role="status"` strip rendered by every branch of the card (the toast still
covers the one case the strip cannot — a rollback with no pending change takes
the whole card away). That branch also asks the SERVER which
comparison is live rather than reading a flag only the section can set: the
section is unmounted there, so a fresh mount (a reload, a sub-tab switch) had
watched nothing and told the admin comparing was merely "not yet possible"
over a run holding the slot, while a run that FINISHED behind the note kept
"still running" for as long as the stragglers lasted and left a stale id that
made the next swap warn about a comparison that had completed. It reads the
section's own cache key, candidate and all, so the two are one entry.
All four "could not be read" notices on the section carry the
`RetrievalTab` retry recipe (`useNoticeRetry`), because all four were gated on
`isError` alone and react-query reverts a refetch with nothing cached to
`pending`: the `role="status"` line containing the pressed button unmounted
under the admin's focus, and for the judgement notice the four picks came back
reading `aria-checked="false"` on a pair whose stored side had never been read.
So each notice is gated on `<its isError> || retryInFlight`, the busy state is
`aria-disabled` + a label swap (never native `disabled`, which blurs the focus
the flag exists to hold) and a successful retry rehomes focus to the nearest
surviving prose, guarded on `activeElement === document.body`.
The judgements read consumes `isError` like its two
siblings — a failed read of a MODEL PAIR's accumulated judgements is a
failure, not "nothing judged yet" — in THREE states, not two: unreadable
(nothing cached) hides the four picks rather than rendering
`aria-checked="false"` on rows that are already judged, while a failed
BACKGROUND refetch over loaded judgements keeps them under a muted
last-loaded line, because `isError` alone let one 500 on a 30s-stale tab-back
blank every pick of a sitting react-query was still holding — the `usePageTree`
ladder, on the workflow whose own copy is "twenty judgements across sittings".
Judging is also the one flow here that writes in a BURST, so the judgement
POST carries its own allowance (`JUDGEMENT_RATE_LIMIT_FACTOR` × the admin
knob, a multiple and never a floor, so lowering `rate_limit_admin_max` still
lowers it): the shared 20/min bucket is sized for the run-starting POSTs, the
p needs 20 PICKS with ties costing a POST each, and a 429 here DROPS the pick.
The client's `['shadow-compare-latest']` cache key carries the CANDIDATE for
the same reason the server's lookup carries a pair predicate — keyed on the
bare name, a remount after aborting migration A and readying B inside one
gcTime rendered A's report and A's live judgement radios under B's heading.
The model NAME is one dimension short of that predicate, so the key is the
MIGRATION's identity — `` `${migration.model}@${migration.startedAt}` ``,
built once in the card and passed to the section as `candidateKey`, both
halves keying the one entry. `providerId` is not on the shadow-status wire, so
the same name re-hosted behind a second provider collided on the client while
the server refused; `startedAt` is strictly FINER than the pair, which is the
safe direction — a finer key can only miss the cache and pay the round trip
the server was going to answer anyway, never serve the wrong run. And the
card's ending notice rehomes focus when its Dismiss unmounts itself (the phase
paragraph, `tabIndex={-1}`), under `useNoticeRetry`'s two guards: it was the
fourth self-removing control on this surface and the only one dropping a
keyboard admin to `<body>`.
An empty sample fails naming the window it asked for and the
control that widens it, not just the state: it is the likeliest first-run
outcome on a quiet instance and it recurs in the amber failed-run strip on
every attempt. The
polite completion announcer is MOUNTED FOR THE SECTION'S LIFE with only its
sentence conditional, the pattern `AiAssistantPage` and `DockPanel` use,
because a region inserted together with its text is the case AT is least
reliable about and this one is `sr-only`. `fetchBenchmarkRun`'s `requestedBy`
is now passed by BOTH callers: the production benchmark's `GET` was the one
that omitted it, so the module's own ACL argument was contradicted by the
caller beside the one that honoured it. **The report is keyed on STATUS, never on provenance**, and the card
watches its own poll as well as its own POST: `GET …/compare` resolves through
`latestBenchmarkRun(…, requestedBy, …)` (`WHERE requested_by = $1`), so a run
adopted on mount is always this admin's own — gating the channel on
started-in-this-session made it dead on exactly the path re-attachment exists
for, and the next Abort then ended a live comparison in silence. The
from-another-tab case needs the card's *poll*, not its POST: nothing is pressed
here, `refresh()` alone flips the branch, and the server fails the run only at
its next per-query fingerprint check — one or more polls later — so the
section's compensating toast loses that race and the card raises the same
sentence when the phase leaves `ready` with a run in flight. Amber-versus-quiet
likewise tracks WATCHED-versus-adopted rather than provenance: a comparison
showing live progress one poll earlier is news, one adopted already failed is
history. The channel is armed on the **202**, by seeding the run cache beside
the latest cache (and invalidating it, or the app client's 30s `staleTime`
holds the placeholder until the first poll tick): between the POST and the
first status GET the section otherwise rendered as idle — Run re-enabled, a
second click firing a duplicate POST the server 409s, and an Abort in that
window reporting nothing at all. The completed report carries the surface's one
POLITE announcement (`shadow-compare-complete`); every failure here already
announced, while the outcome the run exists to produce arrived in silence after
minutes. The disagreement list marks the pages only
ONE side returned, in words (`forced-colors` flattens both inks and a
colour-blind reader sees one grey), and opens at ten rows with an expander:
`limit` 100 × `topK` 20 is ~4000 lines inside a settings card, with the
migration's own Swap and Abort above the fold behind it. The four sides are one
**`radiogroup` with a roving tabindex**, not four `aria-pressed` toggles — one
mutually exclusive choice, one tab stop per row — and its arrows move FOCUS
ONLY, deliberately not APG's selection-follows-focus, because every selection
is a POST that becomes a row in the McNemar count. The chosen side keeps
`nm-pill-active` and gains a **check glyph**: measured off the tokens that
recipe's fill step is 1.07:1 (Graphite) / 1.11:1 (Paper) and even its ink step
is 2.06:1 (Graphite), all under WCAG 1.4.11's 3:1, so the only channel that is
not a contrast question is a shape — `QualityScoreBadge`'s segment-meter
argument. A 42703 while the migration
still reports active is a SCHEMA fault, not a provider one — it ends the run at
the first query instead of being counted as a skipped query and reported as
"check the provider" once the failed-share ceiling (**half** the sample; pinned
by 2-of-4 completes / 3-of-4 fails) trips. Lifecycle step 3b in
`docs/runbooks/shadow-reembed.md`.
There is no separate model-comparison harness — #1113 was closed without one.

**A run states which FTS configuration it measured, and the default is
`simple` for every language (#1114).** Hybrid retrieval has a lexical leg, and
`pages.tsv` is built by migration 049's trigger from
`admin_settings.fts_language` while `keywordSearch` re-reads the same row per
query. The eval never wrote that row, so every run — `--lang de` included —
scored its keyword leg through a language-neutral stemmer, and **every German
number published on #1114 before this is `fts=simple`**. `--fts-language` pins
it, the report carries `ftsLanguage`, and `--baseline` refuses a mismatched
pair (absent means `simple`, because that is what it was). The default is
deliberately NOT derived from `--lang`: every recorded baseline, CI's included,
was measured under `simple`, and deriving it would silently re-measure all of
them and report the difference as a retrieval change. **The rule reaches the
one surface those numbers are shown on**: Settings → AI Models' benchmark table
carries `ftsLanguage` **per language block** and renders it beside each heading
— enforcing it on the JSON report alone would move the omission one layer up
rather than fix it, and one global label became a lie the moment the two blocks
diverged. **The German re-run under `german` is done (2026-08-16) and the
stemmer bought nothing**: R@10 came back bit-identical query-for-query on both
models, the only nominally significant cell (Qwen3 R@1, p = 0.039) dies under
Bonferroni ×4, and the model gap reproduced — R@3 p = 0.0037 and R@10
p = 0.0075 clear correction under both configurations, while German R@1 fell
from `established: true` (p = 0.026 under `simple`) to `false` (p = 0.088), so
top-1 is now unestablished in both languages. So the panel's note states the
result rather than a pending flag, and the Retrieval tab's keyword-language
hint names the rebuild cost instead of promising a recall gain. `ef_search` at
`halfvec(2560)` is **measured, not settled**: effectively exact from 40,
recall@10 0.9995 at the default floor of 100 and unchanged to the 1000
ceiling — leave it alone and watch **footprint** instead (18.6 MiB of HNSW for
2,377 vectors, larger than heap and TOAST combined). That footprint figure came
from one cache-resident 2,377-chunk corpus with **build time unmeasured**, so it
does not license extrapolating to production scale — and it is a property of how
the index was BUILT (`m` / `ef_construction`), identical at every value of the
floor below, which is why the panel's copy names scan time (0.39 ms per probe at
100 against 1.74 ms at 1000) and never footprint as this control's cost.
**Since #1285 that floor
is a knob, not an environment variable**: `admin_settings.rag_ef_search`
(default 100, range 1–1000 — pgvector's own bound), read through the same
60-second cached reader as its Retrieval-panel siblings and written by
`PUT /admin/settings`, with the panel's help text quoting the measurement above
so nobody raises it hoping for recall. `efSearchFor(k)` in
`domains/llm/services/hnsw-ef-search.ts` is the ONE form all four kNN probes
call (retrieval's vector leg, the image leg, `computePageRelationships`, the
duplicate detector) — it resolves the floor and returns
`min(1000, max(floor, 2k))`, and a fifth probe needs nothing but `await
efSearchFor(rawRowCount)` interpolated into a `SET LOCAL` **inside the
transaction it already owns** (a session-level `SET` leaks into the next
borrower of that pooled connection). It sits beside Fetch width as CONTEXT and
**must never be described as a knob to raise with the width** (review r1): the
`2k` half covers every probe's own SQL LIMIT at every reachable width — both
legs cap the raw fetch at 500, so `2 × raw` stays inside the 1000 ceiling — so
the floor binds only probes narrower than half of it and a wider fetch outgrows
it rather than plateauing against it. Three docs, THREE code comments and the
panel's own placement note shipped the inverse claim, which told an operator to
buy scan time (0.39 → 1.74 ms) for nothing; the panel's visible help text was
right all along and is the wording to copy. The third comment was `vectorSearch`'s
own JSDoc — the function whose `SET LOCAL hnsw.ef_search` line this work
rewrites — still carrying both "higher ef_search = better recall" and "the floor
here is 100" a whole round after the rest was corrected (review r1). No test
reads a JSDoc, so grep the retired phrasings across `backend/src`, `docs/` and
`frontend/src` rather than trusting a green suite. `RAG_EF_SEARCH` survives as a bootstrap
fallback in `getRagEfSearch`'s row → env → 100 cascade, and it is the LEGACY-LLM-VARS
kind of deprecated rather than `FTS_LANGUAGE`'s: nothing seeds the row, so the
variable is still live on every instance that has never saved the panel, which
is exactly what the startup notice and the panel's own muted line say. Three
rules that review r1 had to add and that a fifth probe or a later edit must
keep: a row read that THREW never falls through to the variable **over a value
already resolved** (an unreadable row is not an absent one, and the
fall-through silently reinstated a retired env value for a TTL) — #1512
narrowed that to what it was actually protecting: a failure now holds the last
`{value, source}` `resolveRagEfSearch` resolved, and a COLD failure — nothing
resolved AND no row written — reaches the bootstrap rather than the constant 100,
because the old shape retired a live `RAG_EF_SEARCH` on one statement timeout,
dropped every kNN probe on that pod to 100 for a full TTL and — since
`ragEfSearchFromEnv` is `source === 'env'` — stripped the panel's note and its
`Keep` remedy exactly while the value was wrong (`getRagContextCharsPerPage`'s
"fail toward the operator's last known setting", same direction);
`invalidateRagEfSearchCache()` stays a full forget, because it is the reset
hook ~30 tests in four files call between cases — which is precisely why the
admin PUT calls `noteRagEfSearchRowSaved(value)` instead (review r1 of #1512):
a bare forget leaves the reader unable to tell "cleared by this write" from
"nothing has ever resolved", and the panel refetches straight into that window,
so one blipped SELECT there reinstated the RETIRED variable over the row just
saved and re-offered the `Keep <old env value>` that writes it back; the
floor is resolved **before** the probe checks its
client out, never between `BEGIN` and the `SET LOCAL`, because on a cache miss
it queries the MAIN pool and a transaction asking its own pool for a second
connection stalls under saturation; and the panel's line about the variable
renders only where `ragEfSearchFromEnv` says the variable really produced the
number, carrying its own one-key `Keep <value>` write — Save is a pure value
diff, so on exactly that instance the number on screen already matches the
server's and the row the note asks for could not be written from the panel
(the #1114 `Keep`/`Record` precedent, same reason, same discipline) — reading
`saved` and never the draft in the field, like every other `Keep` on this
panel. Review r2 added the guards those three rules were missing: the ordering
one is pinned at all four probes by a source assertion in
`hnsw-ef-search.test.ts` plus an `invocationCallOrder` assertion at the vector
leg, and the `Keep` one by a test that edits the ef-search field itself before
pressing it. Review r3 closed the two holes in the first of those: it checked
each file's FIRST probe only, and read its file list off a hand-maintained
array — so a second probe added below a correct one passed green, and a probe
in a NEW file was covered by nothing at all. It now checks EVERY probe in a
file and cross-checks that array against a walk of `backend/src`, so a fifth
probe fails the suite until it is registered there (which is where its author
is told a pool this text guard cannot instrument also wants a runtime
ordering assertion). That cross-check keys on the GUC NAME, never on the
statement: keyed on `SET LOCAL hnsw.ef_search` it could not see the one
spelling that hurts most — a session-level `SET hnsw.ef_search`, invisible to
both walks and worse than the literal, since it outlives `COMMIT` — so every
code line in `backend/src` naming the GUC must now spell `SET LOCAL`, checked
per line with its own failure message. The verification round closed the hole
BETWEEN those two walks: both compare sets of file PATHS, so a second,
unresolved depth statement added inside an ALREADY-LISTED file satisfied all of
them at once — the GUC walk still matched the same file set, the `SET LOCAL`
assertion still passed, and the ordering test iterates probes, of which such a
mutant adds none (verified green on `rag-service.ts`, the file #1260 edits
against this head). So the per-callsite check now COUNTS a file's depth
statements against that file's own probe count and requires each to
interpolate (`hnsw.ef_search = ${…}`) rather than name a literal — per-LINE
rules where the walks are per-FILE. The startup notice's out-of-range branch hedges on the row too
("while no `rag_ef_search` row exists…"): the function reads `process.env` and
cannot know the resolved floor. And the panel-wide `aria-describedby` wiring
those knobs gained reaches **`ToggleRow` too, not only `NumberRow`** — the
first cut stopped at the number rows, so inside one group a screen-reader user
heard the caveat for `Images per page` and not the one for `Image leg` above
it, and the toggles carry the sharpest caveats on the panel (`Image leg`'s
"one extra embedding call per question", MMR's measured NO-gain). Either way
**a row's `children` are prose only** — a
description flattens to one string, so an operable control or a wayfinding
link goes in the row's `aside` prop, beside the region rather than inside it
(`RetrievalTab.test.tsx` walks the region behind every `aria-describedby` on
the panel — review r3 widened it from `input`/`select` describers, which
certified the layer #1285 had just fixed and stayed silent on the one live
offender: the #1114 calibration strip's `Keep` **button**, described by a
sentence that carried the LLM-providers link. That link now sits on its own
line inside the strip. Review r2 of the verification round then seeded that
walk on the **`RAG_EF_SEARCH` note** as well: both existing cells rendered a
panel with no env note on it, so the one branch whose source comment states
this rule — the pin sits outside its row to obey it — was the one branch
nothing walked, and folding the button back into the described span passed the
whole suite). **#1285's
other value went the other way and must stay there**: `TRGM_SIMILARITY_THRESHOLD`
in `routes/knowledge/search.ts` is FIXED at 0.3 because the fuzzy-title query is
sargable only through pg_trgm's `%` operator, which compares against the
`pg_trgm.similarity_threshold` GUC — so the constant must equal the GUC's
default or the retained `similarity() > $4` stops being exact, and making it a
knob means moving the GUC too (a `SET LOCAL` per search, i.e. a checked-out
client where a pooled `query()` does now). Documented as deliberately fixed in
its JSDoc, in ADMIN-GUIDE's Retrieval section and on the panel's Keyword index
group; don't "finish the job" by making it configurable. **The proposed go/no-go, revert
criteria and measured costs for the Qwen3 cutover live in
`docs/runbooks/shadow-reembed.md`** — they are proposals until the owner agrees
them, and they must be agreed before a re-embed starts. Both eval entrypoints
now **refuse an unrecognised flag** (`assertKnownFlags`, `eval/cli-flags.ts`)
and print a usage list: `--fts-langauge german` parsed cleanly and spent an
hour embedding under the default. They also share **one flag reader**
(`flagValue`): `--out x` and `--out=x` both work, a value flag given without a
value is refused rather than defaulted, and a switch refuses a value — the
guard admitted `--baseline=prev.json` on its name half while the eval's own
`indexOf('--baseline')` could not see it, so the comparison silently never ran.
And `resetEvalCorpus` drops the
`eval_corpus_language` claim it invalidates, so a seed that dies halfway leaves
*no* claim rather than the previous run's — absent routes the benchmark to its
warning, which is the safe verdict for "unknown".

**The image corpus, fixture and `--images` axis (#1115 P5).**
`eval/corpus-de-images/` is a THIRD corpus — 65 German Wikipedia articles
carrying 187 vendored images, the first vendored content whose licence is not
MIT, so page text is CC BY-SA 4.0 and every image carries a named author and any
`requiredCredit` verbatim in `LICENSE-ATTRIBUTION.md`. Keep it out of
`CORPUS_DIRS` and `corpusDirsForLanguage`: `computeCorpusManifestSha` covers
every directory in that list, so wiring it in invalidates every recorded
baseline at once, and only `--images` reaches it (through
`loadImageCorpusManifest`). Its page bodies carry `![](images/…)` with an EMPTY
alt and no caption, and no query may restate a manifest caption — a page that
captions its own figures is answerable from text alone, so a leg measured on it
scores a win it did not earn. Each page pins a `textSha256` and each image the
upstream Commons `sha1`, because a revision id renders through the CURRENT
templates and never pinned the pictures at all. `corpus-de-images.test.ts` fails
on the wiring, a leaked caption, a licence outside the allow-list, an unnamed or
silently-cut author, a missing credit and a body whose sha no longer matches.
`fixture-de-images.json` is its own file with its own schema and loader (never a
widened `FixtureSchema`): 309 labels over all 65 pages and 187 images, written
by blind labellers on a different model from the implementer, in two styles —
`image`, and `image-negative` distractors with EMPTY `expectedImages`, without
which a leg that always answers with a picture scores like one that answers
correctly. `fixture-de-images.test.ts` pins the sha, the counts, the per-language
negative floors and the caption rule. **The negative slice is blind end to end
(#1370, done):** six blind labels (`img-07/08/09-*`) replace the four
merger-written ones; the merger only adjudicates verbatim candidates, so a
labeller's numbering gap records a rejection. ADR-025's `--images` table used
the old 307-label, 22-negative fixture: the next run must identify its changed
negative slice beside `delta.perStyle['image-negative']` and cannot pair against
those numbers through `--baseline` (`pairedBootstrapCi` rejects differing query
sets); no image-axis report is committed.
`--images` is a SECOND AXIS, not a flag on the gate: it answers what the leg
ADDS, so it seeds a different corpus against a different fixture with its own
runner, its own report family (`axis: 'images'`) and its own default `--out`
(`retrieval-eval-images.json`). Seed it through the REAL intake — bytes on disk
under `attachment-store`'s own layout, the body rewritten by `buildPageImageUrl`,
then `embedPage` *and* `embedPageImages` — because a seeder that INSERTed rows
would measure its own fixture. Run both arms in ONE process on one seeded
database, interleaved per query and alternating which arm goes first, forced
through `HybridSearchOptions.imageLeg` and never by writing
`rag_image_leg_enabled`: pairing is McNemar's precondition and a global setting
would change what every other request on the instance retrieves. `--deep-search`
is refused here (expansion reformulates per request, so the arms would be
paraphrased separately), and `--baseline` refuses a cross-axis pair, a differing
VL model, width or index endpoint, and two DECLARED and disagreeing
`imageEndpointBackend` labels — the gate's own model guard reads the TEXT
embedder and cannot see any of it. It is **not in CI and cannot be**: the
`retrieval-eval` job runs `nomic-embed-text`, which is text-only, so CI tests the
plumbing against `eval/vl-stub-server.ts` and the numbers come from a run an
operator starts. Nothing runnable on a laptop speaks the D4 request shape — LM
Studio's `/v1/embeddings` takes no image input, TEI has no image concept, and
llama-server serves multimodal embeddings only on its non-OpenAI route — so
`tools/vl-embedding-shim/` is that server, one FastAPI process over an `mlx` and
a `llama` backend, and it is where TEMPLATE CORRECTNESS lives: it converts
#1329's flat `Instruct:` prefix back into `system` + `user`, refuses a body whose
`messages` would render differently under vLLM's own template, and is tested with
**pytest** in its own `pr-check.yml` job because `tools/` is not an npm
workspace. Recipes: `docs/runbooks/vl-embedding-dev.md` and
`docs/runbooks/retrieval-eval.md` ("Image axis"). **Measured 2026-08-18 (local
shim, so plumbing-grade — ADR-025 D11):** the leg never costs a page at K ≥ 3 and
is a tie at R@1 on a text-easy corpus, `imageHit@1` is .82, and 2B ≥ 8B at a
quarter of the intake cost — full tables in ADR-025 **Measured** §B.

**Query-time latency is measured OUTSIDE `eval/`**, by
`backend/scripts/benchmark-query-latency.ts` — `runner.ts`'s participation
floors assume exactly one sequential hit per query, so a concurrency flag does
not belong there. It is non-destructive (never seeds, `recordAnalytics: false`)
and refuses a search arm whose model width does not match the live
`page_embeddings` column, because `hybridSearch` degrades to keyword-only on an
embedding failure and would otherwise publish FTS latency as retrieval latency.
**It reports no configuration it has not certified**, so it runs
`assertSeededFtsLanguage` over the row it publishes as `ftsLanguage`: the eval
writes that row *before* it truncates the corpus and `resetEvalCorpus`
deliberately never clears it (migration 049's trigger reads it per inserted
row), so a seed that dies in between leaves the previous corpus standing under a
changed configuration — and the keyword leg then genuinely runs mismatched, so
the timing is wrong too and not only the label. The certification is one
recomputing `SELECT`, which is what keeps the script read-only.
**Its two halves do not take their model from the same place**, and the report
would lie by default if that were left implicit: `hybridSearch` accepts no model
and no endpoint, so `rag-service` resolves both from the DB's `embedding`
assignment while `--models`/`--base-url` describe only the direct-POST embedding
half. So a `search`/`both` arm takes exactly ONE model, is refused unless it
names what the assignment resolves to (the width probe cannot separate two
1024-dim models), and the report records the resolved pair. That endpoint
comparison is **exact**: `--base-url` is spelled as the provider row is, because
`generateEmbedding` posts `${base_url}/embeddings` verbatim — guessing a `/v1`
onto a bare host both timed a URL the product never calls and let a `/v1` arm
pass against an assignment resolving somewhere else. `--lang` selects the
question set, never the corpus — `run-retrieval-eval.ts` records the seeded
corpus in `admin_settings.eval_corpus_language` and a mismatched `--lang` is
refused, because the dead-vector-leg guard only fires at *zero* participation.
The metadata also carries `llmConcurrency` and `vectorPoolMax`: the search half
runs through the shared LLM queue (default 4) and the vector pool (default 5),
so a rung above those measures the product's serialisation, while the embedding
half bypasses the queue and really does run N wide. Since #1285 it carries
`ragEfSearch` and `ragEfSearchSource` beside them: the HNSW scan depth stopped
being a module-load `process.env` constant visible in the launching shell and
became a row in the database under test, so two identically-labelled runs can
now measure different scan depths over one corpus (0.39 ms per probe at 100
against 1.74 ms at 1000 — the very quantity this script publishes). The
provenance is reported because "100" reached by a saved row, by the deprecated
variable and by the unconfigured default are three different claims about the
instance. Reported, **not certified** like `ftsLanguage`: there is no seeded
artefact to recompute it against, and a floor the operator chose is a fact
about the instance rather than an inconsistency to refuse over. Both fields
are pinned in `eval/script-wiring.test.ts` beside `llmConcurrency` /
`vectorPoolMax`, which is that file's whole subject: deleting the pair from
the metadata literal leaves the measurement correct and the report silent
about what it measured, and lint, typecheck and every other suite stay green.

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

## UI/UX (ADR-010 v0.7 — Graphite / Paper with Steel)

A flat workspace application, not a dashboard. Themes: **Graphite** (dark, `#0F0F10` workspace / `#161617` pane / `#09090A` canvas) and **Paper** (light, `#F7F7F8` workspace / `#FAFAFB` pane / `#EEEFF0` canvas), both neutral, carrying one desaturated **Steel** accent (`#86AEC8` dark / `#3F627C` light) that is the single brand **and** interaction colour. The two reading panes deliberately avoid near-black and pure white for long-session eye comfort; Paper reserves true white for Raised overlays. **Amber is reserved for warning/attention only**, violet marks AI. The craft bar is Linear, Plane and Notion — Compendiq must hold up beside all three.

The two Steel values are tuned independently for their surfaces: Graphite's `#86AEC8` clears 7.67:1 on the document pane and Paper's `#3F627C` clears 6.20:1 on its off-white pane. `workspace-themes.test.ts` computes those ratios from the tokens rather than pinning hexes, so a retune fails with the measured number instead of a diff. The eight base roles and their exact values live in ADR-010 v0.7; do not scatter equivalent literals across components.

**Depth is a value step plus a 1px hairline, never extrusion.** Surfaces are FLAT COLOURS: `--surface-backdrop`, `--surface-card` and `--surface-card-elevated` are plain values, not gradients. Canvas forms the outer frame, Workspace carries navigation, Chrome marks internal panel toolbars, and content is the Pane one step *up*. That ladder is why the document is the brightest thing on screen and navigation recedes without being dimmed. Do not add a `[data-theme-type="light"]` override for a shell surface; both themes are one token-driven ladder, and retuning the token moves both.

**The authenticated app sits in an inset shell on `md+`.** `--app-chassis` is the viewport ground (`body` overscroll included) and paints the top app header too, completing one continuous outer frame on all four sides. Internal panel toolbars use the lighter/darker cool-grey Chrome token `--app-header-bg`; the command palette remains available through Ctrl/Cmd+K without a persistent search bar. Left nav and main content sit in a brighter rounded workspace card (`--app-shell-*`) below the header. Outline, Details and Assistant share a detached context rail (`--app-rail-*`) beside that card. Its `--app-rail-gap` gutter is 4px at `md` and 6px at `xl`; the gutter owns the inspector's visible three-dot separator and is the mouse, keyboard and double-click resize target, rather than borrowing an invisible strip from inside the panel. Below `md` inset, radius and gap are 0 (edge-to-edge). Retune those tokens; do not scatter equivalent padding across layout components.

**Exactly one real shadow exists.** `--shadow-overlay` (offset + soft blur) is carried by `nm-card-elevated` alone, for content that genuinely floats above the page: popovers, dropdowns, dialogs, the command palette, toasts. In-page command surfaces such as Library search stay flat and use the shared interactive border for their boundary. Every other in-page pane that wants emphasis earns it from position, spacing and heading weight. The retired `--nm-shadow-*` / `--nm-highlight-*` tokens still exist but resolve to `transparent`, so any missed callsite renders flat rather than leaving one embossed control behind.

**No lift, no scale, no glass.** Hover and press are background/border changes. `translateY` on hover, `scale` on press and `backdrop-blur` on an in-flow pane are all retired — blur survives *only* on modal scrims (`fixed inset-0 bg-black/NN`), where it is a specific effect rather than decoration standing in for hierarchy.

Typography: **Inter** for everything, **JetBrains Mono** for code and data figures. There is no display face — a workspace heading is a wayfinding label, and a second family competing at 15–20px costs legibility without buying identity. `--font-display` is an alias onto Inter so existing `font-display` callsites cannot drift. Both are `@fontsource-variable` builds; `font-synthesis: style` forbids faked weights, so a static cut would silently snap headings to the nearest imported weight.

Density: controls are **32px** (buttons, inputs, selects, icon buttons), sidebar tree rows **28px at 13px**, header **48px**, corner scale **10/8/6/4px**. Route titles are 18px semibold. List rows are rows — `px-3 py-2` and a 6px corner — because card geometry stacked forty deep reads as a tile gallery. Below `sm` a row's badge cluster may wrap under the title when the title needs the width — content-driven via `max-sm:flex-wrap` + `basis-auto`, never forced, so short rows keep one line and a `shrink-0` badge never truncates the one thing identifying a row. Both tree implementations (`SidebarTreeView`, `DndLocalSpaceTree`) render in the same rail and must move together — and since #1361 so does a third occupant, the `/ai` conversations pane (`AiConversationsSidebar`), which is the shell's left rail on `/ai` and `/ai/c/:id` instead of the Pages tree. It shares `ui-store`'s `treeSidebarCollapsed` / `treeSidebarWidth` (default and reset **282**), the same resize handle, and the same `embedMainNav` contract — bare in the mobile drawer, `={false}` in the desktop slot, where `MainNavChassisRail` owns the destination strip and a rail painting its own would double it, which is also why the `h-12` `panel-toolbar` nav row's collapse button moves into the row below when the strip is not embedded. Its footer carries the loaded row count and nothing else: theme and account live in the app header (`HeaderSessionCluster`), not at the foot of a rail. A chassis change lands in all three or the rail visibly changes shape when you switch tabs. `toolbar-rule-alignment.test.ts` requires **every** `panel-toolbar` + `border-b` row in each of them to carry `h-12`, with no `py-` on the first — the footer is `border-t`, so it is in neither set.

**In the Pages tree, horizontal budget is the scarce resource and the gutter is out of flow.** At the old 256px default, 43 of 57 rendered rows truncated their title — a level-1 row gave the title 158px against Confluence titles that routinely need 250–400 — and no row carried a `title`, a hover card or any keyboard path to the hidden text, so the panel hid the very thing it exists to choose by. About a third of each row bought nothing: a `w-[20px]` placeholder held the chevron's column on **leaf** rows, a `FileText` rendered on 100% of rows (identical on parents and leaves, so it discriminated nothing while costing 21px), and the indent step was 16px where 12 reads the same at 28px. The chevron is now **absolutely positioned in the indent gutter** (`level*12 + 2`, row padding `level*12 + 28`, 44 in the Dnd tree which also hosts the drag grip). Do not "tidy" it back into the flow: out-of-flow is what keeps sibling titles aligned whether or not a page has children — deleting the placeholder from the flow instead leaves a ragged left edge inside every group — and it is what makes the 24×24 hit area free, clearing WCAG 2.5.8 where the old in-flow 18×18 button failed it *and* charged the title for the privilege. It carries `z-10` because at a 12px indent a parent's 12px-wide `.indent-guide` target overlaps its children's chevrons by ~6px and the chevron must win those clicks. Default width is **280**, and the two halves are both needed: widening alone just moves the panel's cost onto the article. Measured result: truncation 75% → 49%, level-1 title 158 → 215px.

**The chevron and the indent guide are mouse affordances, not controls.** Both are `tabIndex={-1}` + `aria-hidden`. As plain focusable buttons the chevrons defeated the tree's own roving-tabindex contract — a 20-parent tree was 21 tab stops, measured 6-instead-of-1 on the 63-page fixture — and each announced a bare "Expand" with no object, so twenty identical "Expand" buttons could not be told apart. Nothing is lost: per ARIA APG the **row** is the control, carrying `aria-expanded`, with `sidebar-tree-keyboard` handling ArrowRight (expand, then descend) and ArrowLeft (collapse). `aria-hidden` is safe on these because axe's `aria-hidden-focus` rule tests tab-order focusability. The rail is an `<aside aria-label="Page tree">` in **both** the expanded and collapsed branches — collapsing used to render a `<div>`, deleting the complementary landmark rather than shrinking it — and the collapsed rail carries a scope glyph, because losing which space you are in was not a reasonable price for narrowing the pane.

**One section-label treatment, and the tree carries no per-row icon.** Section labels are uppercase at **12px** with `tracking-[0.08em]` (`SECTION_LABEL` in `SidebarTreeView`), matching `SettingsSidebar`'s group headings and the editor's menu labels; 11px uppercase fails `ui-text-legibility.test.ts`'s higher floor for capitals. Tree rows render **no page icon at all** — a parent page is still a page, so a folder/document distinction would be a lie, and one identical glyph on every row is cost without information. The **space dropdown is `nm-card-elevated`, never `nm-sidebar`**: the latter is the panel *chassis* utility (`--color-background` + a border-right), so wearing it made a floating layer paint the exact colour of the panel beneath it with no shadow and one edge. It is the canonical `--shadow-overlay` case. Its filter appears past eight spaces and resets on close, and its footer actions sit outside the scroller because they are how you leave the list.

**A failed tree fetch is a failure, not an empty corpus.** `usePageTree` must be consumed with `isError`; reading only `{ data, isLoading }` collapsed a network failure into the empty state and told the user to go sync a Confluence space that was already working. Three states, not one: failed-with-nothing-cached (destructive, the error *is* the content), failed-with-cache (an amber `role="status"` strip above an intact tree — red is failure, amber is degraded), and genuinely empty. The New page action creates `pageType: 'page'` and is labelled accordingly; `folder` is a real page type that `embedding-service`, `quality-worker` and `summary-worker` all exclude, so a control saying "Folder" while creating a page promised an unindexed container and returned an indexed document.

The sixteen `nm-*` `@utility` classes are kept by name (107 files reference them) but every one is now flat — redefining them in place is what reskins all ~20 routes at once. The retired `--glass-*` tokens resolve onto `--color-*` for the same reason; renaming their ~80 callsites is a mechanical follow-up. Every operable surface keeps a 1px solid border for WCAG 1.4.11 (3:1) and `forced-colors: active` — `--color-border-interactive` (measured ≥3:1 on every surface), **not** the quiet `--color-border` hairline used for separators and panes. `prefers-reduced-motion: reduce` is still honoured. Status colors: green=connected, red=disconnected, amber=syncing, Steel=embedding, violet=AI, slate=inactive, and one non-status semantic hue: indigo (`--color-info`)=informational — a passive notice or the Confluence info panel, never a state, a measurement, a category chip or anything clickable. **The semantic trio is the status palette by reference, not by copy:** `--color-success` / `--color-warning` / `--color-destructive` are `var()` aliases onto `status-connected` / `status-syncing` / `status-disconnected` in *both* theme blocks. The paper re-declaration is defensive, not load-bearing today: `data-theme` sits on the root element, so the `:root` alias already resolves paper's status values — it becomes load-bearing only if the attribute ever moves off the root or a nested themed region appears, since a custom property substitutes `var()` on the element it is declared on. They used to be byte-identical hex copies, one retune away from an eighth and ninth hue; `workspace-themes.test.ts` fails on a raw value and on info colliding with a reserved hue.

**Those status colours name pipeline STATES, and nothing else may borrow them.** The quality score used to: `QualityScoreBadge` mapped ≥90/70/50 onto `status-connected` / `status-embedding` / `status-syncing`, so a page scoring 65 wore the same amber as a space mid-sync and one scoring 74 the same interaction accent as "embedding" — the two most tightly reserved hues, on the densest scanning surface in the app. A score is a *measurement*, not a state. It now renders as one neutral chip carrying a **4-segment meter**, because filled-segment count is a pre-attentive length channel that keeps a column of scores scannable without colour and survives `forced-colors` and colour blindness; the number and word stay, so the meter is a redundant channel and `aria-hidden` (WCAG 1.4.1). The badge's *statuses* keep status colours, and **failure keeps amber** — it is the one quality state that is genuinely attention-worthy. The AI marker is violet **in every state**: `ArticleSummary` used to switch to the interaction accent once the summary arrived, so the same Sparkles glyph read violet in the Assistant tab and Steel in the summary card one click apart, and Steel implied the card was a control.

The same rule swept the borrowings the aliasing made visible: **categories are neutral chips differentiated by label or glyph** (the Local/Confluence source badges, Shared/Private, the RBAC User chip), **measurements are neutral** (`FreshnessBadge`'s whole ladder — Aging literally wore `status-syncing`; the KPI coverage ring, whose arc *length* is the channel; and `EmbeddingStatusBadge`'s resting `Embedded <date>`, a freshness readout — its live `embedding`/`failed` states keep their hues), **selected is the neutral pressed recipe** (`NewPagePage`'s toggles lit up in each option's borrowed badge hue, amber included), the feedback Yes/No is `nm-button-ghost` (a survey answer, not a state — the irony was documented twenty lines below it on `VerifyButton`), `VisionBadge` is neutral in all three states (the tri-state *labels* are load-bearing, the interaction accent is not), and the LLM settings scope note is muted, not amber — a permanent banner in amber teaches users to ignore amber. Embedding *work* (SyncTab's `embedding` badge, the re-embed progress banner, the shadow-migration cards) wears `status-embedding` Steel, not indigo: it is a pipeline state with a reserved hue. Residual `*-success`/`*-warning` callsites are correct by construction through the aliases; auditing whether each *should* be a status statement is a follow-up sweep. Three **known deviations** from the indigo rule remain live pending that sweep — `LicenseStatusCard`'s tier ladder, `NotificationDropdown`'s type icons and `AttachmentsMacroView`'s file-type icons — complete categorical colour ladders where indigo sits beside violet/amber borrows, deferred whole rather than half-de-coloured.

**An honest refusal is a verdict, and it is neutral (#1119).** When retrieval cannot ground an answer the backend runs no completion and returns a real assistant turn saying so, plus the weak sources it declined to use (`refused: true` and `refusalReason` on the final SSE frame, #1105). There are **four** reasons and only one is a threshold verdict (`weak_match`): `semantic_index_unavailable` (the embedding call threw, so the index was never searched) and `no_context` (retrieval returned nothing) refuse **ungated**, because both knobs default to 0 and gating them would ship the honest answer dark in the deployments that never opened Settings → Retrieval — the reversal is argued in `retrieval-confidence.ts` and `docs/architecture/09-flow-rag-chat.md`. The fourth, `image_only_context` (#1115 P4), is ungated too and is the only one decided *late*: every returned row is an image-only page whose context is a synthesised title and not one picture could be shown to the model, which is knowable only after the pick step — still before any completion. The reason is a local union in `llm-ask.ts`, deliberately not a contract enum: it is a route verdict on the SSE frame, and `refusal.tsx` renders every reason the same way, so a new one needs no frontend change and gets none. Adding a per-reason wording map on the client would move the wording away from the route that knows why it refused. The per-reason wording is load-bearing: an outage must never be reported as "the knowledge base has nothing", which is also why `REFUSAL_ANNOUNCEMENT` names the state and leaves the reason to the message it sits above. `refusal.tsx` renders it in both chat surfaces — `/ai`'s `MessageBubble` and the dock's `DockMessage`, or it degrades silently in one of them — as the ordinary bubble ground plus a 1px hairline and a `Not answered` chip. **Not amber:** on an instance whose threshold is set at all this recurs on every question the corpus does not cover, and `/ai` already spends its amber on the zero-embeddings notice sitting directly above it on exactly those instances — two ambers on one screen, one of them permanent-ish, is how the reserved colour stops meaning anything. **Not `text-destructive`** either: that is `Message.isError`, and this request did not fail. So it takes the treatment already settled for a MEASUREMENT rather than a state — the `QualityScoreBadge` / `ConfidenceBadge` de-colouring argument, where the word is the channel. The `ConfidenceBadge` is **suppressed** on a refusal (it would rate an answer that does not exist), the weak sources carry a `Closest matches — not used` heading (bare chips under "I am not answering" read as the sources it answered from), and **both** polite announcers say so instead of "Answer ready" — `/ai`'s *and* the dock's. There are two live regions, and the first cut fixed one: a screen-reader user on the mobile sheet or the inspector tab was told an answer was ready for a turn the server ran no completion for, which is the whole visible treatment above being invisible to exactly the user who depends on the announcement. It stays in the polite region, not the alert one, because a correct response is not worth interrupting for. `loadConversation` maps the stored `refused` marker back onto `Message.isRefusal`, or a reopened thread downgrades the refusal to an ordinary answer; the persisted turn carries its weak sources as structured data since #1361 (`toPersistedSources` — the prose still names no list), so a reloaded refusal shows them under the same `Closest matches — not used` heading, and `GET /llm/conversations/:id` marks any whose page is trashed or no longer visible as `unavailable`. An image source keeps its `kind` and `attachmentUrl` through that persist-and-reload — or, when the URL is empty or outside the attachment routes (`ATTACHMENT_URL_PATTERN`), the entry is dropped entirely rather than kept as a stripped duplicate of the page entry beside it — so a reopened answer renders the same thumbnails the live one did rather than a duplicate page chip.

**A confidence threshold remembers the model it was tuned on, and says so when that model changes (#1114).** The two knobs above are operator-set because their scales are deployment-specific — and the thing that makes them so is the MODEL: the embedder decides the cosine distribution, the reranker's normalisation the relevance one. Nothing connected that to the places a model changes, so a #1116 shadow swap (which rewrites the `embedding` assignment), its rollback, and a plain `PUT /admin/llm-usecases` all left 0.35-tuned-on-`bge-m3` sitting on `Qwen3-Embedding-4B`'s scale, silently refusing too much or too little. **The ruling is WARN, DON'T MUTATE** (2026-08-16): a swap must never rewrite refusal policy — an operator who set a gate deliberately would find it moved by an action about embeddings, and a silently *relaxed* gate is worse than a silently strict one. So the evidence is kept instead, in `core/services/confidence-calibration.ts`. Writing a threshold through `PUT /admin/settings` records `{providerId, model, setAt}` beside it (`rag_confidence_threshold_calibration` / `..._rerank_calibration`), resolved through `resolveConfidenceBasisPair` — the resolvers, never a raw `llm_usecase_assignments` read, because inheritance, the EE override and ADR-021's "unassigned rerank = stage disabled" all decide what the pipeline actually scores with. Three write rules are load-bearing: **only** for a threshold that PUT carried (re-dating an untouched one certifies it against a model nobody tuned it on), **re-recorded on a re-save of the same number** (that is the panel's own remedy, so a value-diffed write would make it a no-op), and **cleared at 0** (gate off = nothing calibrated). A basis with no assigned model is recorded as a **null pair inside a present record**, never as an absent record: a rerank threshold saved while the stage is disabled (ADR-021's ordinary state) was tuned against *nothing*, and that is a fact — it goes stale the moment a reranker appears behind it, and both-sides-null is a match rather than a warning. Written as an absence it read back as "never recorded", so the panel reported a threshold saved seconds ago as predating the feature and its own remedy re-wrote the same absence forever. `GET /admin/settings` computes `stale` server-side and answers `ragConfidenceCalibration` — **provider id and model name only**, never a base URL or key. `warnThresholdOutlivedItsModel` logs at the swap, the post-swap rollback and the direct assignment change; **never on an abort** (no assignment was rewritten) and **never when the threshold is 0**, which is every instance that left the gate off — a warning everyone sees is a warning everyone skips. `RetrievalTab` renders a stale record as an amber `role="status"` strip *above* that control (the failed-save recipe: 16px `AlertTriangle`, `border-warning/30` + `bg-warning/10`), naming the old model, the live one and which scale moved, because "stale" alone leaves nobody able to judge too-strict from too-loose. A threshold with **no record** — everything set before this shipped, and anything written by SQL — gets a **muted** line, not amber: absence of evidence is not evidence of a change, and an amber strip appearing on every upgraded instance is how the panel's own no-amber-at-rest rule gets hollowed out. That line states what is **missing, never why** — a record write that failed and one that never happened are the same absence, so "set before models were recorded" was a claim about a threshold saved seconds ago — and a server that has not shipped `ragConfidenceCalibration` at all renders **neither** notice, because it has told the panel nothing. **A resolver FAILURE is not an answer either**: `resolveConfidenceBasisPair` returns `{resolved, pair}` and the write path abstains when `resolved` is false, leaving the previous record — collapsing the two persisted a DB hiccup or a decrypt error as the claim "tuned against nothing", which the panel then states as fact and rates stale the moment the resolver recovers. "No provider configured at all" is a *state*, not a failure (`NoProviderConfiguredError`), so it still records a null pair. The warn is skipped when either side of the before/after comparison failed to resolve — **on the direct-assignment path only** (`llm-usecases.ts`), which has nothing but that comparison to go on; the **swap and rollback warn anyway**, falling back to the raw `llm_usecase_assignments.model` for the unresolved side, because each knows an assignment really was rewritten and a possibly-null model beats suppressing a swap warning entirely. The swap's line names the *incoming* model captured **inside** the swap transaction (the rollback's discipline: the pre-lock snapshot and the verified value differ exactly when another lifecycle step won the lock race) — while the *outgoing* model is **resolved, never read off `llm_usecase_assignments.model`**, because that column is NULL on a provider-pinned/model-inherited assignment (a first-class partial pin the rollback restores verbatim) and a raw read named the one field the line exists to carry `null`. Same on the way back: the rollback resolves the restored pair after the transaction rather than echoing `revState.prev.model`.

**And it is picked from the distribution the deployment actually produced, not from another one (#1284).** The panel told operators there is no universal value and then sent them to `grep` their own `rag.confidence` log lines — a question the product already had the data for. It did not, quite: `search_analytics` held `max_score` (RRF fusion) and `rerank_score` (the reranker's scale), and **neither IS the number the gate compares**, so the readout could not be derived from either. Migration **098** records the verdict itself — `confidence`, `confidence_basis`, `surface`, all nullable, no backfill. Three rules. **`NULL` is a real score**: a keyword-led set, an image-only set, a pinned exact-identifier head and an empty set whose retrieval health could not be verified all carry no number, and writing 0 for one would drag every percentile toward the floor and make every threshold look generous. **But `NULL` is not the test for "unmeasurable"** — a HEALTHY empty set scores **0** on basis `none` (the ordinary `no_context` path: "the KB has nothing on this" is a measurement), so the readout selects by **BASIS** and never by the score: `confidence IS NOT NULL` is only a `COUNT(*)` backstop (a score-presence predicate would floor both percentiles with those zeros), and a NON-zero predicate is wrong in the other direction, because the similarity basis is clamped at 0 for a negative cosine, so `0` on basis `similarity` is the worst-matching question the deployment really answered and belongs in the sample. That second half is the one a wire test can falsify — the route drops a `none` group twice over (the SQL predicate, then the bucket mapping), so `analytics-confidence.integration.test.ts` pins the legitimate zero and `rag-service.test.ts` pins the healthy-empty zero the rule is about. **The basis is its own column**, because it flips per request and a null score cannot tell `none` from "not recorded". **`surface` is set by the CALLER** (`HybridSearchOptions.surface`): the gate runs on `/llm/ask` alone, so `'ask'` is the only label the readout reads, a page search is `'search'`, and NULL — every pre-098 row, and any internal caller that declares nothing — is unknown and never adopted. Both hybrid writers record it: `hybridSearchInner` now computes the verdict **above** the analytics write (it used to run after, which is why the value was only ever a span attribute) from the same `topResults` and health caveat the trace carries, and `multi-query-search.ts` computes it over the MERGED set with the ORIGINAL leg's caveat — the same inputs `llm-ask.ts` re-derives the gate from, so the recorded number is the number the gate compared. `GET /api/analytics/confidence-distribution` (`requireAdmin`, `routes/knowledge/analytics.ts`, **not** an extension of `GET /admin/settings` — that route is a settings document and this is a measurement) answers per-basis `p50`/`p90`/`count` over a **fixed 7-day** window, nulls at 0 and never NaN — and it **parses its own answer** through `ConfidenceDistributionSchema` on the way out (review r1), because `Number()`/`parseInt()` answer NaN *inside* the `number` type and `JSON.stringify` ships that as `null`, so an unparsed route would report "nothing measured" for a sample it had just counted. `RetrievalTab` renders one **muted, neutral** readout inside each threshold row — a MEASUREMENT, the `QualityScoreBadge` de-colouring argument again, so never amber and never Steel — carrying the count always (a p90 over eleven questions is noise), a small-sample caveat below 30, an explicit "nothing measured" state, and a **failure sentence on `isError`**: "we could not look" and "nothing was measured" send an operator in opposite directions. **Each caveat is its own sibling paragraph inside that readout, never another clause appended to the measurement's sentence** (review, external round): concatenated, the worst reachable case — a small sample, #1114's verdict stale and a failed re-read — was one undifferentiated ~290-character run of 12px muted text with the two numbers the operator came for buried at its head. The wiring below is unaffected, because a description flattens across children identically. The region also carries **`nm-focus-ring`**, `index.css`'s standalone `:focus-visible` mechanic: it is the one thing this feature makes focusable, and Chromium otherwise paints the UA default 1px `rgb(0, 95, 204)` outline across its full width. **That failure is THREE states, not two** (review r1) — the `usePageTree` rule in full, applied to this query as the panel's settings query already applies it to its own: react-query settles a failed REFETCH as `error` while KEEPING `data`, and this client sets `staleTime: 30_000` with the default `refetchOnWindowFocus`, so alt-tabbing back during a backend blip is ordinary rather than a corner. `distributionLost` (nothing cached) keeps the failure sentence; `distributionStale` keeps the FIGURES and adds one clause saying they are the last the panel could get — the failure sentence's own second clause ("there is nothing measured to check this threshold against") is false the moment a measurement is cached. The section notice branches the same way ("could not be read" vs "could not be **re**-read") and is a `role="status"` region like the panel's two other failure strips, with the Retry's label going to **Retrying…** while the read is out. **That strip survives the retry it starts, and carries no `aria-busy`** (review r2) — two halves of one announcement, each of which the r1 cut broke in a different direction. react-query's `fetchState` spreads `...data === undefined && { error: null, status: 'pending' }`, so refetching with NOTHING cached — the default failure, a first load against a backend that has not run 098 — drops back to `pending`, `isError` goes false, and a strip gated on `distributionError` alone unmounted the button **under the user's focus**, dropping it to `<body>` in a ~30-stop panel and making the `Retrying…`/`disabled` state unreachable in exactly the branch that needs it; the gate is `distributionError || retryInFlight`, a local flag set in the click handler and cleared in `refetch().finally()`. And `aria-busy="true"` on a live region tells AT to **withhold** updates to that region until it clears, so setting it in the same commit as the `Retry` → `Retrying…` swap silenced the very announcement the swap exists to produce, and by the time it cleared the text had returned to the already-announced string — one region, one mechanism, the content IS the announcement, and the button's own label carries the busy state. `distributionStale` keeps `data`, so it keeps `status: 'error'` and never had the mount problem — which is why the first cut's test only ever exercised the half that worked. **The busy state is `aria-disabled`, it is `retryInFlight` alone, and a SUCCESSFUL retry rehomes focus** (review r3) — three ways the r2 fix's own premise leaked. A native `disabled` blurs the focused element under the HTML focus fixup rule (and `nm-button-ghost`'s `:disabled` adds `pointer-events: none`), so the browser drops focus to `<body>` for the whole multi-second window the r2 machinery exists to hold it through; jsdom implements none of that, which let one test assert focus retention and `toBeDisabled()` in the same block. The handler is the refusal instead (the `AuthPanel` SSO-retry shape), and **no `aria-busy` on the button either** — it sits inside the live region, and busy withholds its own subtree's updates. **And because that label is the only channel the busy state has, it has to stay legible** (review r1): `aria-disabled:opacity-70`, never 45, which composited to 3.93:1 in Graphite and 2.88:1 in Paper against the 4.5:1 floor its 12px text is held to — WCAG's inactive-component exemption does not cover a control that is deliberately *not* inactive, since it keeps focus and its handler is what refuses. Same value as the `AuthPanel` precedent it was modelled on, and the test asserts a floor rather than the literal so a retune upward is free. Folding `isFetching` into that state relabelled the control `Retrying…` for a window-focus refetch nobody pressed anything for, announcing a system event as the user's action. And on the ordinary outcome — the retry succeeds — the strip's condition resolves and the button is removed with focus on it, so focus moves to the similarity readout (`tabIndex={-1}`, still prose, still no tab stop), guarded twice: only for a retry this control started, and only when `activeElement` really did fall to `<body>`, so an operator who went back to a knob mid-request keeps their caret. `RetrievalTab.test.tsx` fails on a native `disabled`, on a background re-read reaching the label, on focus not landing on the measurement, on focus being stolen from elsewhere, and — since the fixture and the fallback constant were both 7, which left the wire value ignorable — on a `windowDays` the panel does not read from the server. **The readout carries no model provenance, and says so while #1114's verdict is `stale`** (review r2): 098 records the score, its basis and the surface and nothing else, so the window cannot be filtered to one model — and the strip directly above it says "re-tune it below", pointing its own remedy at a 7-day sample that may still be mostly the previous model's numbers. The extra sentence is **conditional on that basis's `stale`**, muted like the rest of the line rather than a second amber beside the strip, and it **hedges**: the panel has no swap timestamp, so it says the window *can* span both scales, never how much of it does — the r3 rule that a notice states what it knows. **The failure's recovery is a control, not "reload this page"** (review r2): `values` is draft state and Save is a pure value diff, so a reload discards every unsaved knob edit — the loss #949's one-shot hydration and the separate `Keep` mutation both exist to prevent — and the copy named none of that. One query serves both bases, so ONE `Retry` sits at the section top, where a control is legal: the readout is the input's `aria-describedby` region and holds nothing but paragraphs. The readout renders **inside** the row's help block, which is what keeps the #1114 calibration strip the immediately-preceding sibling of its control. **That wiring is per-row, opt-in and ONE READOUT** (`NumberRow`'s `describedBy`, pointed at `distributionDescriptionId(fieldKey)`), never the panel and never the whole help block. Never the panel, because three other rows carry a `<Link>` or the `Use measured value` button inside their help, and pointing a description at those announces a link and a button as prose the reader cannot act on and then repeats them on the next tab stop (the first cut wired all eleven rows and asserted prose-only on the single row that complied). Never the whole block, because a description flattens to one unskippable string that is re-read on every focus: pointed at the block, the rerank threshold's description measured **159 words / 975 characters** — two scale-caveat paragraphs, the readout and its empty note concatenated — for a measurement of about thirty, and the caveats are visible prose read in ordinary reading order either way (measured 14 / 75 words after). So `RetrievalTab.test.tsx` **sweeps every `[aria-describedby]` the panel renders** and fails on any region holding something operable, asserts the wiring on **both** thresholds (the sweep can only inspect regions that are still wired, so deleting `describedBy` from the rerank row alone left all 97 tests green while that readout stopped reaching its input's description), and fails if a description resolves to anything but that row's own readout element. It also parses the readout's own classes for a borrowed status hue — the `workspace-themes.test.ts` recipe applied to a component — because the neutrality rule above was otherwise prose nothing could fail on. **The empty rerank sample names ADR-021 as its cause only once the panel has been told** (review r1): `assignments && !rerankActive`, because `rerankActive` is false for a `/admin/llm-usecases` query still in flight exactly as it is for one that answered "unassigned", and without the first half the readout states "the rerank stage is disabled on this deployment" on evidence it has not collected — the `usePageTree` three-state rule, the same one the image-leg notice on this panel already follows. The mock helper takes a `holdUsecases` gate so that branch is reachable at all; deleting the guard was green across the whole file before. The section description names the readout in one line and stops there; the consequence a bare number does not carry is stated **beside the first distribution**, in the similarity row's own help. It had grown to 111 words at the top of the section — three times the longest sibling description on this panel, restating the row help and the readout within ~200px of both — and the panel's house style for a section description is an 11–40-word orienting label. The rule itself is unchanged, and it is stated **at** the percentile, not above it (review r1): the gate refuses on `score < threshold`, so a threshold set at p50 puts about half the sample below the bar and one at p90 about nine in ten. The first cut said "a threshold *above* p50 refuses about half", which is off by a whole percentile in the direction that flatters the feature — an operator setting the p90 figure the readout prints beside it would expect half and get nine in ten. Both points are named because the readout prints both, and a rule stated at one says nothing about which way the other moves. **And "below the bar" is a CEILING on refusals, not the rate** (review r2): `llm-ask.ts` computes `otherGrounding` and short-circuits `refusalReason` to `null` *before* the threshold comparison is reached, so a turn carrying a sub-page tree, an attached document, web results or a substantive prior turn is answered at any threshold — while its analytics row, written during retrieval, is in the p50/p90 sample regardless. `hasSubstantiveHistory` makes that every follow-up turn in a conversation, so on a multi-turn assistant the observed rate at p50 is well under half, and the copy says so rather than selling the percentile as the rate. Same qualification in `docs/ADMIN-GUIDE.md`. Logs and traces stay as the per-request tool they are.

**A failure is reported, never inferred from a 200** (review r3). The read path ships `liveResolved` beside the pair, because "no {basis} model is assigned now" is a claim about `llm_usecase_assignments` that is false — and persistently so — when the row is present and merely unreadable (a `PAT_ENCRYPTION_KEY` rotation leaving `api_key` undecryptable, an EE policy naming a deleted provider); the *verdict* stays stale either way, only the sentence differs, and the panel then points at the provider row instead of the assignment grid. The write path likewise answers `ragConfidenceCalibrationWrite` — `recorded` (with the model) / `cleared` / `unresolved` / `failed` per basis — because the threshold row lands and the route answers 200 whether or not the bookkeeping beside it did, so a `Keep`/`Record` press that the server abstained from would otherwise toast "recorded", refetch, and re-render the very notice the operator was told to clear. `recordConfidenceCalibration` returns whether the row moved for the same reason: swallowing the write error AND claiming success is the same dishonesty one layer down.

**Keeping the number is its own control, and Save stays a pure value diff.** The strip's second remedy changes no value, so Save can never carry it — and the first cut fixed that by arming Save on staleness, which put the untouched threshold into *every* subsequent PUT. An operator editing the fetch width at the far end of the panel then certified the refuse gate against a model they had never measured it on, and the strip — the only standing surface saying the gate needs re-tuning once the swap's log line has scrolled away — silently vanished, defeating the route's "only a threshold this PUT carried" rule from one layer up. So the strip carries a **`Keep <value>`** button that PUTs exactly that one key, read from `saved` and never from the draft in the field. It is its **own mutation**, not Save's: Save's success releases the panel's one-shot `hydrated` flag so the form re-reads the server, which is right for a request that submitted the form and wrong for one submitting a row nobody edited — it would revert every other unsaved edit on the panel, the failure #949's flag exists to prevent. No `aria-label` (WCAG 2.5.3 — the visible label *is* the name); `aria-describedby` points at the strip's sentence so two identically-labelled buttons stay distinguishable. **And it hands focus off before it vanishes** (#1285 review r1): every `Keep`/`Record` on this panel — the two calibration ones and the ef-search env note's — sits INSIDE the notice it satisfies, so a successful press unmounts the pressed element and the browser drops focus to `<body>`, restarting the next Tab from the top of the document fourteen controls into the panel. `focusKnobBeforeNoticeClears` moves focus to the knob the notice was about, called **before** the invalidate rather than after it (at that moment both the button and the field are certainly mounted, so focus can only land on a live element), and **only on the outcomes that actually clear the notice** — an `unresolved` or `failed` calibration write leaves the strip and its button standing, so focus stays where the operator put it. **Both sides of that condition are pinned** (review r1 of r1): the first cut guarded only the ef-search button, so disabling the whole calibration branch left the suite green under a rule CLAUDE.md stated for all three — `RetrievalTab.test.tsx` now fails both when a notice-clearing `Keep` leaves focus on `<body>` and when an abstaining one yanks focus off a button the operator still has to press. **The second half of that pair is a claim about the `disabled` ATTRIBUTE, and it is only true without one** (verification round): each of the three buttons inerts itself while its write is in flight, and spelled `disabled` that runs the HTML unfocusing steps on the element the operator is standing on — every real browser blurs it to `<body>` at the press and drops it from the tab order, so on `unresolved`, on `failed` and on both `onError` paths, where the notice and its button deliberately survive, the caret was already gone. jsdom implements none of that, so the abstain test passed against the broken source. They now report themselves inert with **`aria-disabled`**, the recipe `AuthPanel`'s SSO re-check and `AskMode`'s example chips already use for this exact reason, which costs each handler an early return because `aria-disabled` blocks no events; the guard asserts the attributes (jsdom models those faithfully) rather than `activeElement` across a disabled toggle, and fails on a reverted attribute *and* on a dropped handler guard. A `disabled` attribute is what must never come back to these three. **It is a handoff, never a grab** (review r2 of the verification round): `focusKnobBeforeNoticeClears` takes the element that was PRESSED — threaded from the click's `currentTarget` through each mutation's own variables, so a second remedy pressed meanwhile cannot be mistaken for the first — and moves nothing unless the caret is still on it. The write is in flight for as long as the server takes, and the three remedies are deliberately **not locked against one another** (only against Save, which PUTs the whole changed set and re-hydrates the form): they write three different single keys, nothing re-hydrates, and greying two unrelated notices because a third was pressed would state an unavailability that is not real. So an operator who moves on mid-write — onto another remedy's button, or into any of fourteen fields — used to have the caret yanked to the depth field when the pin resolved, which is this same 2.4.3 failure arriving from the other direction; a cross-remedy lock would not have closed it either, since `aria-disabled` leaves a button focusable by design. **All three, and that had to be said twice** (review r1 of the verification round): the guard covered `Keep` and the ef-search pin, so reverting the muted note's `Record` alone left the whole suite green under a rule stated for three — the same half-a-fix shape as the round above it, one layer down. Each of the three now has its own in-flight case, and the abstain pair is per-branch too: the amber strip's cell had been *named* for `Record` while pressing `Keep`, which is how the muted note's gap survived two rounds. The attribute is **`aria-disabled` plus `aria-busy`**, but **neither of them is the in-flight signal, and the round that said so had the premise inverted** (review r1 of #1285). It argued that a native `disabled` "announces unavailable for free" while `aria-disabled` "says nothing at all", and reached for `aria-busy` to repair the difference. It is the other way round: `aria-disabled="true"` IS mapped to the disabled state and announced by NVDA, JAWS and VoiceOver, so dropping the attribute cost that channel nothing — while ARIA 1.2 scopes `aria-busy` to elements whose SUBTREE is being modified (live regions, composite widgets), which on a `<button>` reaches no assistive tech at all. What the attribute swap really dropped is the half a **human** can perceive: 45% opacity reads as "disabled", not as "working", and the write is an unbounded network PUT, so on a slow server the operator was left standing on a control that had gone quiet until the toast landed. `AuthPanel`'s recipe is **four** parts — the attribute pair, a spinner and a label swap — and `PendingRemedyLabel` restores the last two for all three remedies. It swaps to a gerund that **keeps the number** (`Keeping 0.35…`, `Recording 0.35…`): two of these can render at once, one per basis, and the number is the only thing on the button naming which threshold is being written, so `AuthPanel`'s bare `Checking…` would make them identical at the one moment one of them is acting. The spinner is `aria-hidden` (redundant channel, WCAG 1.4.1) and honours `prefers-reduced-motion` through `index.css`'s global rule. `RetrievalTab.test.tsx` fails on all three if the spinner or the gerund goes, and on the outcome the button OUTLIVES (`unresolved`) if either is left behind after the write settles. The toast reports the server's own verdict, not the status code: `Threshold recorded against <model>`, `Threshold recorded — no <basis> model is assigned`, or an error naming the reason it was left alone. **The muted line carries the same control** (`Record <value>`), and it is the branch that needed it: its copy told the operator to "save to record it against the live model" while Save only diffs values and that branch rendered no button, so on every instance upgraded with a live threshold — the exact instance the swap runbook's go/no-go step is written for — the note was permanent and recording the current number was reachable only by changing the gate to a different number and back. Fixing the amber branch and leaving its sibling is how a fix becomes half a fix. `RetrievalTab.test.tsx` fails if an unrelated knob's save carries a stale threshold, if Save arms on staleness, if Keep discards a draft elsewhere, if the strip stops being the immediately-preceding sibling of its control (order alone passed for a strip parked four sections away), if either notice reads the draft instead of `saved`, and if the muted line stops offering a remedy the panel can perform. Its copy names the ACTION, not the outcome — "record the model behind it now", never "against the live model" — because that branch has no calibration object and therefore no live pair to name, and its reachable case (a rerank threshold predating #1114 on an instance with the stage unassigned) records "tuned against nothing".

**Each of those three remedies carries TWO booleans, and mixing them is how the panel starts lying (#1510, #1511).** `…Blocked` (`keepBlocked`, `efSearchPinBlocked`) is UNAVAILABILITY: the click guard plus `aria-disabled`, never `disabled` — see the `PENDING_REMEDY_CLASS` note above for why the attribute may not come back — and Save belongs in it, because a panel-wide PUT re-hydrates the form and a one-key write racing it can be reverted or can revert. `…Writing` is a claim about what the SERVER is doing: the gerund, the spinner and `aria-busy` (`PendingRemedyLabel`), and ONLY the remedy's own mutation may set it. #1285 promoted one shared flag from driving `disabled` (truthful) to driving that label (not), so pressing Save made the `RAG_EF_SEARCH` pin read `Keeping 250…` and both calibration buttons `Recording …`/`Keeping …` for writes nobody had asked for — for as long as a PUT takes, and an `ftsLanguage` change reindexes the corpus in-request. `keepWriting` is also scoped PER KEY (`keepMutation.isPending && keepMutation.variables?.key === fieldKey`; `variables` survives settle in react-query v5, so the `isPending` conjunct is load-bearing), because the panel renders one strip per confidence basis and both can stand at once — a shared flag had the rerank strip announcing `Keeping 0.35…` while the operator kept 0.2, which is precisely what `PendingRemedyLabel` keeps its number to prevent. `keepBlocked` stays SHARED across the two strips, and that is not an oversight: one `useMutation` object cannot carry two concurrent keeps, so that unavailability is real. `RetrievalTab.test.tsx` pins both halves — a Save in flight must leave every remedy reading its verb with `aria-disabled="true"` and no `aria-busy`, and its handler must still refuse the press — so a fix that buys the honest label by loosening the guard fails there.

Inline code resolves `--inline-code-color` in **both** themes. Paper declares its own value (#7041a8) but a later `[data-theme-type="light"]` rule used to hardcode a red over it, so the token was dead and the two themes rendered different hues rather than one hue at two lightnesses. Retune the token, never re-add a `color` there. `::selection` is mixed from `--color-primary` at 28% so body text keeps 4.5:1 on top of it — there was no rule at all before, which left the editor's highest-frequency interaction at the UA default blue. `workspace-themes.test.ts` guards all of this: the quality badge is parsed for `status-*` and for hex literals, the light inline-code rule for a `color` declaration, and `::selection` for existence and for resolving the token. Each assertion was verified to **fail** against the pre-change source, not merely to pass after it.

**One inline destructive treatment: `nm-action-destructive`.** `nm-button-destructive` stays the filled variant for a dialog footer where deleting is the point of the surface; this is its quiet counterpart for a destructive action sitting *in* a row, menu or list beside ordinary ones. Three disagreed before — the block menu used `text-destructive` + `hover:bg-destructive/10` + a destructive ring, the article inspector `text-destructive/80` + `hover:bg-destructive/8` + the ordinary ring, and Settings → LLM providers **nothing at all**, where `Delete` was an unstyled button identical in weight to `Edit` beside it and its confirm reached for `text-error`, a class this project does not define, so the one moment the UI meant to turn red it rendered as plain text. A user cannot learn "red means destructive" from three reds and an absence. `destructive-treatment.test.ts` pins the three unified surfaces, bans the undefined `*-error` classes, and **ratchets** the count of hand-rolled callsites elsewhere (21 across 14 files) so it can fall but never rise — the rest are a sweep of their own, and some are legitimately different *kinds* of destructive control.

**Collapsing the inspector must not promote deletion.** Expanded, Delete sits behind a `Danger zone` disclosure and then a confirm dialog. The collapsed rail used to raise it to a top-level icon among ten unlabelled glyphs — sharing the confirm made the second step identical and did nothing about the first going missing, so the safety around destroying a page was a function of a layout preference. The rail carries no Delete; it stays reachable by expanding the pane and by its shortcut.

**The Confluence PAT banner is a strip, not a card.** It renders on *every* authenticated route, so as a `nm-card` with an `nm-button-primary` it owned the only filled accent on screen — on `/pages/:id` the loudest element was a setup nag while the page's own primary action sat beside it at a quarter of the weight, and it cost ~145px of an 845px phone viewport. It keeps its reach and loses its rank: one line, muted text, a text-link CTA. Don't give an onboarding prompt the accent back.

**The Getting Started checklist is chrome, and it is silent (#1402).** `features/onboarding/OnboardingChecklistCard`, rendered by `PagesPage` as a sibling block between the Library header and the search toolbar — never wrapping, gating or replacing the page tree's loading / failed / failed-with-cache / empty states, and rendering **nothing at all** (not a collapsed sliver) once dismissed. It obeys the PAT-banner rule one paragraph up: **no filled accent anywhere**, every control `nm-button-ghost` at `h-8`, and the completion state **neutral** — finishing a checklist is an achievement, and `status-connected` names a pipeline state. Five milestones, and **two of them are computed, not stored**: `hasConfluencePat` and `selectedSpaces.length > 0` are on `GET /settings` already, and a persisted `patConfigured` would drift the moment a user disconnected their PAT (phase 1's reasoning, in `packages/contracts`). The other three are partial-patched one key at a time: `firstAiQueryMade` from `runStream`'s success-only `onComplete` in **both** `/llm/ask` senders (`AskMode` *and* `dock/use-dock-actions` — there is no shared send function, and wiring one leaves half of users without credit), `shortcutsModalViewed` from `KeyboardShortcutsModal`'s open effect, `pageCreatedOrEdited` from `useCreatePage().onSuccess` and `useUpdatePage().onSettled` on the **no-error** path. There is deliberately **no `stores/onboarding-store.ts`**: the `['settings']` query cache is the store, and a Zustand mirror would need its own invalidation on every write that already invalidates it. `useUpdateSettings({ silent })` skips the "Settings saved" toast and `{ silentErrors }` also skips the failure one — the latter **only** for a background auto-mark nobody asked for, where a red toast beside the answer the user *did* ask for reads as "your question failed"; a Dismiss/Reopen press keeps its error toast, and every Settings-panel Save keeps its confirmation. `completedAt` is written **once** and never rewritten, by `useOnboarding({ trackCompletion: true })` — mounted by the card and nowhere else, or every hook instance on screen races for the same timestamp — together with `dismissed: true`, so visibility stays one server-derived fact. **The completion line is latched off that server fact, never off an in-mount transition** (review r1): three of the five CTAs navigate away from `/`, so the fifth milestone normally lands on another route and the overview is re-entered already-complete — a transition latch never fired for that user, who instead watched the fully-checked list flash and vanish a round-trip later without ever reading where the guide went. The client that finds all five done with `completedAt` still null is the one graduating, wherever the last step landed. It is gated on **`!dismissed`** in the same breath, because the card stays mounted while hidden: without it, pressing `?` on `/` — `shortcutsModalViewed` is the one milestone completable without leaving the route — resurfaced a guide the user had closed, as a congratulation, breaking the renders-nothing-once-dismissed rule this same paragraph states. The auto-mark dedupe is likewise **per session, not only per cache**: `/ai` mounts nothing that calls `useSettings()`, so `['settings']` is absent there and the cache read deduped nothing on the app's busiest auto-mark surface; a `WeakMap<QueryClient, Set<flag>>` carries it and a failed write releases its entry so the next occurrence retries. **Both halves of that record are session-scoped only because something makes them so** (review r2). The QueryClient is **never rebuilt** — `main.tsx` builds one at module scope and login is a pure SPA transition — so the record outlives a sign-out exactly as the query cache does (#885), and the second user in a tab had their milestones silently skipped while their own flags were still false; `useClearCacheOnLogout`, the documented single choke point for every `clearAuth` path, calls `resetOnboardingSessionWrites` beside the cache wipe rather than onboarding growing a second, weaker one. And the release-on-failure runs from the mutation's **hook-level** `onError` (`useUpdateSettings({ onWriteError })`), never from `mutate`'s own options: react-query delivers those through the MutationObserver that `useMutation` detaches on unmount, and `useCreatePage().onSuccess` marks its milestone and navigates away in the same breath, so the caller is normally already gone when the write settles and the flag stayed suppressed for the whole page load. Two focus rules fall out of a card that removes its own controls (the `RetrievalTab` Retry precedent above): Dismiss reports the removal and `PagesPage` moves focus to the Library heading (`tabIndex={-1}`, and only when the unmount really dropped it to `<body>` — a mouse click does not take focus to a button on every platform, so that guard has its own test), and a CTA the user has **activated stays rendered** for the life of the mount even once its step completes — `shortcuts` completes in place, and its button used to vanish while the modal it opened was still open, leaving the close with nothing to restore to. **The congratulation is an addition, not a replacement** (review r2): it renders above the five checked rows rather than instead of them, because `shortcuts` is also the one milestone completable in place, so when it is the FIFTH step the graduating render was the render that discarded the very CTA the paragraph above keeps — Radix then restored focus to a detached node and dropped it to `<body>`. Its `role="status"` region is mounted empty from the first paint and only its text changes; a live region inserted together with its content is announced inconsistently at best, and in the dominant arrive-already-complete flow it was present on first paint, which is never announced at all. **Dismiss takes the card on the press**, optimistically, rolling back (and toasting) if the write fails: waiting for the PUT plus its refetch left the control with no pending state and no visible effect for a full round trip, so each further press fired another write — and on the celebration it swapped the congratulation for the fully-checked checklist the user had just been congratulated for finishing. **User Menu → Getting Started Guide** clears `dismissed` and navigates to `/`.

**An empty list names which emptiness it is (#1402 phase 3).** `PagesPage`'s browse-empty block answers four unrelated questions and must not blur them. A **filter** emptied it → name the filter and offer `Clear filters` (the 2026-08-17 harden pass; do **not** add a spaces check there, "no spaces connected" is not why a search returned nothing). A **search term** emptied it → `Try a different search term` and **no action**, because the search box the user is looking at is already the control — the disjunction that used to promise `Clear filters` for both halves described code that never existed. Neither is set, and then it depends on what `GET /settings` says, which is three answers and not one. **No PAT** → `No Confluence spaces connected`, `Connect Confluence` deep-linking `CONFLUENCE_SETTINGS_PATH`, because the old copy sent someone who had never entered a token to the settings *root* to find the panel themselves. **A PAT and no `selectedSpaces`** → `No spaces selected`, `Choose spaces` deep-linking `SPACES_SETTINGS_PATH`. These two are **not** one branch: the Getting Started checklist renders on this same screen and treats connecting and choosing as separate milestones, and `CONFLUENCE_SETTINGS_PATH` renders only the PAT form — so the merged version told a user with a working token that they had none, one line under a checklist row ticked Done, and sent them back to the step they had finished. The copy is matched to that milestone's wording so the two surfaces on one screen cannot disagree. **Connected for real** → today's copy verbatim, `Go to Settings` / `Create a Page`; that reader has finished with the setup screen. All three read the `settings` the component already fetches for its KPIs — no request was added, `hasConfluencePat` + `selectedSpaces` are the same computed pair the checklist uses one paragraph up, and `selectedSpaces` is read through the same optional chain, since `useSettings()` does no runtime validation and a payload missing the field would throw during render. **Every one of them is gated on `settings !== undefined`.** An unresolved or failed `GET /settings` is not evidence of anything: ungated, a pending fetch or a 500 rendered "No Confluence spaces connected" at a connected user, and on a cold load where `/pages` wins the race that is a real flash of the wrong diagnosis — the same failure-rendered-as-empty-state mistake the sibling `pagesError && !pagesData` branch exists to prevent. Unknown settings fall through to the generic copy, which is true in every state. **And the newer prompt does not outrank the older.** Both Confluence CTAs pass `actionTone="secondary"` to `EmptyState` (a real prop, default `primary`), so `/pages` keeps exactly one filled Steel accent — the header's `New Page` — with the checklist's ghost CTA and the empty state's secondary one below it. Two prompts for the same setup may coexist; two filled accents may not. `SpacesTab` follows the same rule: its filter's zero-match state says `No spaces match "…"` instead of the loaded list's `Click "Fetch Spaces"` prompt, which would be a lie.

**A list you cannot search is a list you have to read.** The Keyboard Shortcuts modal is **23** registry rows across four categories plus 11 TipTap ones — **34** in total under five headings — inside a 60vh scroller, and `SpacesTab` shows every space a PAT can read — dozens to hundreds on a real Data Center instance. (23, not 22: `navigation` carries two `Keyboard Shortcuts` entries, `?` and `ctrl+/`. Phases 1 and 2 both shipped a transcribed count that was wrong, so the number is now derived from `SHORTCUTS`/`TIPTAP_SHORTCUTS` in `KeyboardShortcutsModal.test.tsx` and counted in the DOM rather than quoted from memory.) Both carry a plain local `nm-input` filter (no request, no URL state: a lookup inside one surface is not a shareable view), matching case-insensitively on `label`, and on `name`/`key` respectively. Three rules hold in both. A **section with no matches disappears whole** — an `<h3>` over empty space claims "no shortcut here", a different thing from "not this one". Zero matches is an **honest inline line**, never a second `EmptyState` inside a dialog, and it carries its own reset rather than sending the eye back to the 24x24 clear icon in the input. And **the live region is mounted before the first keystroke, never with its own first sentence** — the rule `PagesPage`'s `filters-live-announcer` already follows, because some assistive tech only starts watching a region once it is in the accessibility tree. Both filters therefore own one always-mounted `sr-only` announcer whose TEXT changes (empty at rest, a count while narrowing, the no-match sentence at zero) and neither visible zero-match line carries a role, or it would be read twice. `SpacesTab` renders that count **visibly** too, in the `browse-results-context` idiom: filtering hides rows without deselecting them, which is right and was silent — `Save Selection (12)` beside one visible row explained nothing. Both clear buttons are `nm-icon-button` at `h-6 w-6`, a 24x24 target under WCAG 2.2 SC 2.5.8 wearing `--color-ring` instead of the UA outline. The shortcuts filter resets on open (Radix unmounts the content, so a stale query would greet the next `?` pre-filtered) and takes focus via `onOpenAutoFocus`, since Radix would otherwise hand it the Close button — the one control this dialog already has a key for. That autofocus ate the dialog's own advertised key: single-key shortcuts are dropped on editable targets, so a second `?` typed a character and landed the user on `No shortcuts match "?"`. On an **empty** box `?` closes the dialog; once anything is typed it is an ordinary search character again. `Dialog.Content` caps itself at `max-h-[90svh] flex flex-col` with a `min-h-0 flex-1` scroller, not just a `max-h` list: the search row grew the non-scrolling chrome from ~107px to ~166px, which pushed the title/Close row and the footer off a 390px-tall phone in landscape with nothing to scroll back with.

**Theme preference follows the OS by default.** `system | dark | light`, cycled by the header control. The *preference* is persisted; the resolved palette deliberately is not, so a stale value cannot win over the live OS reading. `startSystemThemeSync` is gated on hydration — an OS event arriving before rehydration would re-serialise the initial `system` over the user's stored choice.

Guarded by `frontend/src/workspace-themes.test.ts`, which parses tokens out of `index.css` and **computes** WCAG ratios rather than pinning hex literals, and which now also fails on a reintroduced shadow, `transform`, gradient surface, or light-theme shell override. `ui-text-legibility.test.ts` enforces an 11px floor on arbitrary font sizes.

**Docked AI assistant (#1126).** On `/pages/:id` the assistant is not a destination — design of record in `docs/superpowers/specs/2026-07-28-docked-ai-assistant-design.md`, topology in `docs/architecture/04-frontend-structure.md`.

**It is a tab, not a column.** It used to be a third column beside `ArticleRightPane`; on a 1440px screen that put three vertical rules across the window and left the article — the thing the route exists for — squeezed between two panels of chrome. Assistant is now the first of three tabs *inside* the inspector (`InspectorView = 'assistant' | 'outline' | 'details'`), and the choice is local `useState` in `ArticleRightPane`: it is a per-visit view, and persisting it would mean opening a page to an AI panel nobody asked for. It defaults to `outline`, or `details` when the page has no headings. **Assistant is deliberately first** in the tablist — it is what people reach for most and it used to be the one behind an extra step.

`stores/ai-dock-store.ts` survives as the **"show me the assistant"** request channel, and stays ephemeral for the same reason a persisted `open` was always wrong. `AppLayout` consumes `openDock()` on every article route: at `md` and up it expands the inspector onto Assistant; below `md` it opens the page-inspector sheet (Outline / Details / Assistant together). Chassis **AI** is the full-page `/ai` chat; the inspector tab is **Assistant**. The laptop-width force-collapse of the page tree is gone. Both assistant surfaces select the action **inside the composer beside Send**, and since #1361 they offer **different sets**, declared once in `features/ai/assistant-actions.ts` and passed to `AssistantActionSelect` as an `actions` allow-list rather than an `includeGenerate` boolean: the dock gets `DOCK_ACTIONS` — Q&A, five standalone rewrite skills, Diagram, Generate and the five #1401 create skills — and `/ai` gets `AI_HOME_ACTIONS`, which is Q&A, Generate and those same create skills. **The dock offers Generate-shaped actions now** (#1401): `runCreateSkill` POSTs `/llm/generate` and returns a draft card with *Apply to Page*, so the old rule that the dock deliberately withheld Generate is retired — what it withheld was a menu item for a path it already had. `/ai` has no rewrite skills and no Diagram because page scope was retired there and it has no document to act on. Those lists are the menu, not the URL: a `?mode=improve|diagram` deep link on an AI route lands on Q&A because the URL-mode parser admits only `ask` and `generate`, which is a stated allow-list rather than the accident it replaced (a tree click that rewrote the URL and dropped the `mode=` on the way); a create skill is never a URL value at all, since the URL carries `mode=generate` and the skill is picked in-app. Summarize and Quality are not assistant modes. Selecting an action changes what that same prepared request will do — it must never discard or replace the typed draft. `/ai` therefore keeps draft text in `AiContext.input` across its mode-specific inputs and owns one page-local `AssistantAttachmentsScope` above the mode switch; Q&A, rewrite skills, and Generate reuse that controller, while Diagram keeps existing attachments paused and sends none. The scope clears on `activeThreadId` changes — New chat, opening a saved conversation, a dock page switch — so source material cannot leak into another conversation. Deep Search remains local to the Q&A composer and resets when that action unmounts; do not lift it with the shared draft. Action runs **append to one thread**, so `runStream`'s `userMessage` appends — never `setMessages([…])`. **Opening the assistant runs nothing (#1176)** — the rail icon, the pane row and `Alt+I` open it and stop; every request starts from Send. Don't re-add an on-open action: the trigger cannot choose an improvement type, the dock has no stop control, and closing it does not abort a run. JS **width** queries exist only where the component tree changes: `useIsMobileLayout()`, `useIsDockWideLayout()`, and `useIsInspectorWideLayout()` (`xl`: expanded inspector vs 40px rail) in `shared/hooks/use-media-query.ts` — `use-can-hover.ts` and three one-shot checks read `matchMedia` for pointer/motion capability, but every other responsive *layout* decision stays a Tailwind class. Below `xl` the inspector starts collapsed so the article keeps the workspace; Alt+I still expands it — the layout presets that also did were deleted with the rest of the preset menu.

**`/ai` is a conversation with a URL, and the thread key is the LOCATION (#1361).** Saved Q&A conversations reopen at `/ai/c/:id`; on AI routes the shell's left rail carries `AiConversationsSidebar` instead of the Pages tree, whose `isAiRoute` prop and three `/ai?pageId=` producers are gone. Page scope on `/ai` went with them — no context chip, no `+ Sub-pages`, no `pageId` on the ask — so a dock-origin conversation continued from `/ai` searches the whole corpus, and the row's page chip records **origin, not live scope**. `AiContext` keys its ≤12 retained threads by location (`shared/lib/ai-routes.ts` owns the predicates): `draft` for a fresh `/ai`, `conv:<id>` for a reopened one, `page:<id>` for the dock, which is unchanged. **Every thread also carries an `identity`, and stream writers are bound to it rather than to the key.** A first answer promotes `draft` to `conv:<id>` and replaces the URL mid-stream, so a writer holding a key would write into the wrong thread or lose the answer; a writer whose identity is no longer filed DROPS its write instead of resurrecting a thread the user replaced. `activeThreadId` — that identity as a string — is also what every composer reset keys on: Deep Search, the Ask composer's external URLs and the attachment scope clear on a thread switch and on nothing else, so typing, a `?q=` prefill and the promotion itself leave them alone. Server data is TanStack Query only (`useInfiniteQuery` over the keyset list, invalidated on `['llm', 'conversations']` after every ask, rename and delete); the `useState` mirror this replaced could not be invalidated by a mutation and went stale the moment a second surface wrote. A stale id answers 404 and the turn **fails in place** — *This conversation no longer exists — your next question starts a new one.*, the id cleared, no toast and no navigation — because redirecting out from under a typed draft destroys the one thing the user still has. Only Q&A is saved; Generate, the rewrite skills and Diagram are not. Design of record: `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`.

**Conversation auto-titles complete #1361 only after the answer is complete.** A new row starts with the word-boundary question fallback, then `generateConversationTitle` runs fire-and-forget after the terminal SSE frame on all three creation paths: streamed, cached and refused. It uses the existing `chat` assignment, bounds and sanitises the question and non-refused answer, normalises one ≤80-character line, and compare-and-sets only while `title_source = 'question'`; a manual rename writes `'user'` and therefore wins the race. Provider, timeout, output and DB failures keep the fallback and never fail or delay the answer. `useConversationList` polls at three seconds only while a loaded question-title row is under 60 seconds old, then stops on `generated`, `user`, or expiry — never turn a soft failure into permanent polling.

**The article inspector has a 400px minimum when expanded.** Persisted narrower widths are clamped on hydration, and the resize separator reports the same minimum; its double-click reset returns to 400px. The dock composer uses a labelled violet **Skill · current action** control rather than the icon-only selector used by `/ai`, and its dropdown deliberately excludes the five `create-*` templates — creation remains available from the full-page AI flow and the dock's new-page empty state, while plain Generate stays in the dock menu. This later owner decision supersedes the preceding #1361 paragraph's older list of dock actions. When collapsed, Assistant is a first-class violet rail action immediately above Outline, never duplicated in More actions. Outline closes when the pointer moves onto another part of the rail while remaining hoverable over its own flyout. More actions closes on Escape or outside pointer press and restores trigger focus on Escape. The left navigation, central content pane, and inspector body all paint `--color-card`; only their toolbar bands paint `--app-header-bg`.

**Historical version previews mark their change from the immediate predecessor inline.** Formatted mode preserves the selected version's document structure while wrapping additions in `ins` and removals in `del`; Raw Text uses the same word-level change semantics. The oldest version has no invented baseline and says so. Both views sanitize content before rendering and use the existing addition/deletion treatment rather than introducing a third diff language.

**`/ai` scrolls its message pane, not the page (#1218).** The chat log owns the scroller, and it can only do that because `min-h-0` runs down the **whole** chain: AppLayout's scroll container → `PageTransition` → AppLayout's `max-w-*` wrapper → `AiAssistantPage`'s root → the pane. All four links are load-bearing — a flex item's `min-height: auto` refuses to shrink below its content, so restoring it on any one row puts the page back on the outer scroller and live message text back in the 20px scroll-padding strip above the sticky sub-header and below the input bar (#1186's mechanism, at both ends). Tidying `min-h-0` out of a wrapper class list is the way this returns; `src/ai-scroll-chain.test.ts` fails by name when a row drops it, because jsdom performs no layout and no render test can see it. The bars keep plain `inset-0` under-masks — belt-and-braces through the supported range, live again only where the bars are taller than the column, and **never** with an overhang, which would re-create scrollable overflow in a container that now has none (#769). The clamp is shared by every route: it costs the scroll container's `pb-5` at the scroll end, and any page that caps its own height must clip or scroll its cross-axis-stretched boxes (GraphPage's filter sidebar needed `overflow-y-auto`; its canvas was already `overflow-hidden`).

**Do not "simplify" the dock's `Apply` into a client-side editor write.** It calls `POST /llm/improvements/apply` deliberately: that route runs `protectMedia`/`restoreMedia` (#723) and the column-layout realignment that 422s when unrecoverable (#781), all of which live in `backend/src/core/services/content-converter.ts` (JSDOM + turndown) with no frontend counterpart. A `marked` + DOMPurify round-trip in the browser strips Confluence macros and media silently, and the next Save pushes the loss to Confluence. `article-view-store` stays read-only mirrors for the same reason, and Apply is disabled while the editor is open.

**Edit-mode chrome lives in the article column**, as a sticky strip with the #1186 under-mask — the same recipe New Page uses. `EditorToolbar` (format tools) plus `TagPopover` plus Cancel/Save sit there, not in `#app-header-slot`. The document title stays in the article as the 3xl textarea — do not put a second truncated title in the header beside the tools. Table / layout / section strips (`EditorContextToolbars`) stay in the article column under the format bar; they only mount when the caret is in one of those blocks. Read-mode title stays in the article as the 3xl heading — it does not also occupy the header. Chips + Edit sit on the sticky article bar. `TagPopover` is a `nm-button-ghost` chip labelled **"Add tags" / "1 tag" / "n tags"** (`tagChipLabel`) that opens the unchanged editor in a popover. Three scopes: the toolbar acts on the *selection*, the chip on the *page*, Cancel/Save on the *session*.

The inspector's Details tab is the better **grouping** — tags belong with space, parent and version, beside the auto-tagger already there — and below `md` that tab now lives in the page-inspector sheet. The editor's `TagPopover` chip stays anyway: it is the in-flow control while writing, and a sheet you have to open is the wrong place to reach for a label. The Details tab keeps its read-only pills under "Health & labels" — a summary beside freshness and embedding status, not a second editor.

**The 48px is declared, not derived.** The app header is `h-12` with its own `border-b`. `EditorToolbar` (now in the article column) and the read-mode `HeaderHost` fallback still use `h-[calc(3rem-1px)]` / `min-h-[calc(3rem-1px)]` so they share that line when their hairline sits on a sticky parent. Measured in Chromium, `nm-button-primary` and `nm-button-ghost` are **34px, not the 32px their comments claim** — both put a 1px border outside a 6+20+6 box, and only `nm-icon-button` sets an explicit `2rem`. So padding-derived arithmetic lands on 50px, and Cancel needs `border border-transparent` beside its `py-1.5` to reach 34 with them (that border is arithmetic, not decoration).

**Escape is absorbed, in both branches.** A portalled layer over the editor that leaves the key unmarked dismisses itself *and* runs `handleCancelEditing()`. `absorbPortalEscape` (`shared/lib/absorb-portal-escape.ts`) is the generic form of what the block menu has always done; `absorbBlockMenuEscape` is now an alias re-exported from `use-block-menu-target.ts` so the block menu's pinned tests keep passing. Escape peels one layer at a time, and that decision lives in `TagPopover`, not in `TagEditor`'s own keydown — **Radix binds Escape at `document` with `capture: true`**, so it sees the key before React dispatches from its root container and the editor's handler never runs. `TagEditorHandle.dismissSuggestions()` returns whether it consumed the keystroke; the popover closes only when that comes back false. `autoFocus` is likewise two halves: the editor's effect focuses the input, and the popover must `preventDefault` `onOpenAutoFocus` because child effects run first and Radix's FocusScope would otherwise pull the caret back onto the wrapper.

**Editor block menu (#1179).** Left-clicking (on release) a block's drag handle opens a controlled Radix **Popover** (never `@radix-ui/react-context-menu` — `role="menu"` typeahead swallows keystrokes in the free-form Improve input) carrying the bubble menu's formatting row, its Improve section and a Delete. Body + handle wrapper both live in `shared/components/article/EditorBlockMenu.tsx`; the formatting row (`EditorFormatBar.tsx`), the AI section (`ImprovePanel.tsx`) and the quick actions (`improve-actions.ts`) are shared with `EditorBubbleMenu` rather than duplicated. Four rules are load-bearing. (1) Text actions render **only** for `paragraph` / `heading` / `blockquote` / `listItem` (`block-menu-nodes.ts`, a closed allow-list); every macro, atom and container gets **Delete only**, and they are *hidden, not disabled* — Improve ends in `insertContentAt(range, markdownDerivedHtml)`, which over a structured Confluence node is the same silent loss the `Apply` note above warns about. The guard has a **second half at the inline level**: an allowed `paragraph` may still carry `confluenceStatus` / `confluenceUserMention` / `confluenceJiraIssue`, which `doc.textBetween` skips (so the model never sees them — "Ask @jdoe about DONE" is sent as `"Ask  about "`) and which the returned HTML then overwrites. `containsStructuredInline()` hides Improve for those blocks too; formatting toggles stay, because a mark toggle rewrites marks, not nodes. **The selection bubble menu runs the same predicate to the same verdict** — see its own note below. One rung further down, a **`link` is a mark, not a node**, so `containsStructuredInline` cannot see it and `textBetween` strips the href before the model ever sees it: that one is **warned about, not hidden** (`containsLossyMarks`), because the text survives, only the address is lost, and links are common enough that hiding Improve for every paragraph containing one would gut the feature. (2) The range is the block's **content** (`pos + 1` … `pos + nodeSize - 1`), never a `NodeSelection`. That keeps the block node when the model answers with a single paragraph — but **it is not sufficient on its own**: `unwrapSingleParagraph` only strips a wrapper for a lone `<p>`, so any multi-block answer stays block-level HTML, and inserting that over a heading's inline range lifts the blocks out and the `h2` is gone (or becomes an `h1`, or a list). "Make longer" on a heading hits this every time, and a heading demoted to body text breaks the page's TOC and anchors on Save. So Replace is **refused for a `heading` whose answer is multi-block** (Insert below stays, so nothing is lost); `paragraph`, `blockquote` and `listItem` are safe by schema and are left alone. (3) The target is a **node decoration** (`block-menu-decoration.ts`), not a remembered `pos`: it remaps through every transaction, it is the "this block" affordance, and its presence is how `selectionShouldShow` knows to stand down so the bubble menu never stacks a second panel on the block menu's selection. (4) The handle must be frozen with `setDragHandleLocked(editor, true)` while the menu is open **and released on close** — the transaction **meta**, not the command, because the `DragHandle` *Extension* is not registered (only the React component's plugin). Without the freeze the plugin nulls the node out the moment the pointer travels to the portalled menu; without the release the handle never tracks the pointer again for the life of the editor. Both directions, and the literal meta key the library reads, are pinned in `use-block-menu-target.test.ts` — the open/close side effects live in that hook precisely because `EditorBlockHandle` is untestable under jsdom (the plugin resolves its node from `mousemove` coordinates). (5) **Escape must be stopped at the menu** — `absorbBlockMenuEscape` on Radix's **`onEscapeKeyDown`**, with both `preventDefault()` and `stopPropagation()`. **Not `onKeyDown`**: it is bypassed when the layer unmounts in Radix's capture pass (React rebuilds its dispatch path from the fiber tree, and there is no fiber left), and again when the key is dispatched from outside the layer — its handler simply never runs in three of `block-menu-escape.test.tsx`'s four cells, so it is not a containment mechanism even where the grid shows it green. The two halves do different jobs: `preventDefault()` makes Radix skip its own dismissal (so `close` runs once, not twice) and, **since #1206**, is the signal `use-keyboard-shortcuts` reads — that hook now yields any single-key shortcut whose keystroke is already `defaultPrevented`, which is what keeps `PageViewPage`'s `Escape` from running `handleCancelEditing()`. Before #1206 it gated solely on `isEditableTarget(event)`, false for a portalled layer, and `stopPropagation` was the only thing saving the user from a "Discard changes?" prompt. `stopPropagation()` stays regardless: `use-keyboard-shortcuts` is not the only listener on `document`, and the others have no reason to consult a flag Radix set. **A new portalled layer over the editor now inherits the shared-hook fix, but only if it marks the event — a layer that neither `preventDefault`s nor stops the key still exits edit mode.** Mouse-only by design: the handle is positioned solely by `mousemove`. Nothing becomes keyboard-inaccessible — formatting and Improve are the bubble menu's own actions and it is keyboard-operable, while Delete (which has no bubble-menu equivalent) falls back to ProseMirror's `NodeSelection` + Backspace. Note that `listItem` is in the allow-list because the decision names it, but the handle runs **non-nested**, so it resolves a hovered list to the `bulletList` / `orderedList` and never to the item inside — `listItem` only becomes live if the handle's `nested` option is turned on.

**Selection bubble menu — inline macros.** `EditorBubbleMenu` reaches the same `insertContentAt` as the block menu, so it runs the same `containsStructuredInline` over the **selection** and reaches the same verdict: **hidden, not warned**. Warning is what `containsLossyMarks` does for marks, where the words survive and only the formatting is lost; an atom takes the *content* with it. And the input half is broken too — `textBetween` drops the atoms before the request is built, so *every* accept path, Insert below included, returns prose derived from text the user never wrote. There is no correct outcome to put behind a warning. The one thing this surface changes is the **copy**: a block target has no remedy, but a selection is the user's own drag, so it names the way out ("Select text around them instead") — and a range that stops at the atom really is clean, because `nodesBetween` does not visit a node whose start equals `to`. Auto-shrinking the selection past the atom was rejected: only well defined when the atom sits at an edge, and silently improving something other than what was highlighted is its own surprise. Two gates, not one. `openAi` refuses on the document, because **Cmd/Ctrl+J never touches the trigger** and hiding a button does not close a keyboard path. `replaceSelection` re-reads the document at click time, because the decoration *widens* to cover anything inserted into the passage while the section is open, and the render gate is a React value that a transaction landing after the last paint leaves a frame stale; that case blocks Replace only (via `ImprovePanel`'s `replaceBlocked`) and leaves Insert below, which destroys nothing. The trigger stays visible while the section is open — it is also the collapse control, and its `aria-controls` must keep pointing at a live panel. The notice is **muted, not amber**, and deliberately **not** a live region, since it appears and disappears on every drag. The `replaceBlocked` message on the open panel *is* amber, and the pair is intentional: the colour tracks whether the user is mid-gesture, not refusal-vs-warning. A notice that flickers past as you drag is noise in amber; a control going dead after you asked for an answer is attention, which is what ADR-010 reserves amber for. The predicate behind both matches **any** non-text inline node, not the three macros by name — a guard in `EditorBubbleMenu.test.tsx` pins the article schema to exactly those three, so a fourth cannot start withholding Improve under copy that no longer describes why.

**Edit-mode toolbar.** `EditorToolbar` lives in its own module; `Editor.tsx` re-exports it and keeps the three context strips. It carries **fourteen main controls** plus utilities: a block-type control (headings and text), Quote, Code block, Divider, five marks, one colour picker (text colour and highlight in the same panel, immediately left of the bullet list), three list toggles, and one Insert menu, with header numbering, undo and redo at the far end. The long tail is behind the two menus *with names beside it* — the flat row shipped two different actions under the same `ListTree` glyph and no label, which is the failure mode a wall of icons has. When the bar is too narrow, folded tools (strike, inline code, task list, alignment, underline, ordered list) go into **Insert**, never a second `…` trigger. Colour stays on the bar, immediately left of the bullet list. Nothing was removed; `EditorToolbar.test.tsx` asserts the Insert menu item by item against what the flat row carried, so a restructure cannot quietly drop one.

Four things in it are load-bearing. (1) **A text field never goes inside the menu.** Image URL and status label open a Radix *Popover* from the menu, because `role="menu"` typeahead swallows printable keystrokes — the same trap the block menu's Improve input documents above, reached from a different direction. `onCloseAutoFocus` is preventDefaulted while a prompt is pending, or Radix returns focus to the trigger in the same tick the popover autofocuses its input, and the input loses. (2) **The roving tabindex is the whole point of `role="toolbar"`.** `use-toolbar-roving-focus.ts` gives the bar one tab stop and arrow-key travel; without it the bar was 31 sequential stops between the prose and Save. Its `root.contains(event.target)` guard is not defensive coding — Radix portals its menu content out of the DOM but *not* out of the React tree, and React replays events up the React tree, so an arrow pressed inside an open Insert menu genuinely arrives at the toolbar's handler. Vertical arrows are deliberately not claimed: ArrowDown on a trigger is how Radix opens a menu. (3) **The pressed state is plain CSS in `index.css`, not nested inside `@utility nm-icon-button`** where it belongs by subject. Tailwind emits a nested `&[aria-pressed='true']` in the production build but **not** through the dev server, so the state was invisible while working on it and correct only once built. It also has to sit after the `forced-colors` and `prefers-reduced-motion` blocks, which name `.nm-icon-button:hover` at the same (0,2,0) specificity — on a tie the later rule wins, and being last is what stops a pressed button dropping back to merely-hovered. Its colour is **neutral, not Steel**: `nm-pill-active` states the rule that the accent is reserved for actions, and six toggles lighting up Steel read as six primary buttons. `EditorFormatBar` shares the recipe, because those are the same six toggles and they used to render the accent there and neutral here. **The recipe does not transplant onto `nm-button-ghost`, and there is deliberately no `.nm-button-ghost[aria-pressed='true']` rule** (#1260): a ghost button already carries `--color-border-interactive` and `--color-foreground` at rest, so two of the three declarations are no-ops and the surviving fill change measured 1.03:1 (Graphite) / 1.02:1 (Paper) against the surface it sits on, identical to unpressed on hover and absent under `forced-colors` — an invisible pressed state, which is the defect the icon-button rule exists to prevent. A mutually exclusive choice takes the segmented recipe instead — `NewPagePage`'s `bg-muted` track with `nm-pill-active` on the chosen one — which is what "selected is the neutral pressed recipe" above names, **and past a handful of options it wants a shape channel on top**: measured off the tokens, that recipe's fill step over its own track is 1.07:1 (Graphite) / 1.11:1 (Paper) and even its ink step (`--color-muted-foreground` → `--color-foreground`) is 2.06:1 in Graphite, all under 1.4.11's 3:1, so it is legible as a *group* and thin as a *single* readout. The `forced-colors` block already pins `.nm-pill-active` to `Highlight`; where the choice is the whole point of the surface — #1260's judgement rows, where a wrong reading silently mis-records evidence — add a check glyph, which is `QualityScoreBadge`'s segment-meter argument (a shape survives `forced-colors`, colour blindness and a retune of every token) — **rendered in every state with `invisible` when unchosen, never mounted on selection**, because a conditionally mounted glyph puts its 12px box plus the group's 4px gap into the layout on every pick, widening that segment by ~16px and sliding its right-hand siblings out from under the pointer on a surface built for twenty picks and changes of mind. Four such options are also a `radiogroup` with a roving tabindex, not four `aria-pressed` toggles. (4) **Separators hide below `sm`**, where the bar wraps — a divider that lands at the end of a wrapped row separates a group from nothing — and the container's horizontal gap opens to 8px instead so the grouping still reads. Menu section labels are uppercase at **12px, not 11**: `ui-text-legibility.test.ts` holds capitals to a higher floor than body text.

> **Cross-surface parity:** ADR-010 v0.7 changed the app to the Steel accent and
> the five-step surface ladder. `compendiq-landing` still carries the preceding
> Graphite/Paper teal values, so palette parity is open again. **The app is the
> source of truth**; port these exact v0.7 roles outward, never re-derive the app
> palette from the landing one.
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

**`body_html` never contains a raw structured macro (#1438).**
`confluenceToHtml` uses static DOM snapshots, and replacing an outer macro can
clone nested `ac:structured-macro` nodes after their dedicated handler pass.
Conversion therefore repeats to a fixed point with a strict monotonic guard:
the raw macro count must decrease on every pass, or conversion throws rather
than returning partial HTML or deleting the malformed macro. A cloned supported
macro stays raw for the next dedicated pass; it must never be downgraded into
the lossless long-tail `confluence-macro-unknown` node. Native `panel` renders
through the existing info-panel node but carries `data-macro-name="panel"` and
arbitrary direct text parameters through the editor, so write-back emits
`ac:name="panel"` rather than permanently coercing it to `info`.

**Notion import discovery is metadata-only.** `GET /api/notion/tree` builds the
picker hierarchy from Notion Search and resolves Search-listed `block_id` parents, but
must never list every page body's blocks: the retired walk spent up to 80 serial calls
against Notion's 3 req/s limit before a large workspace could render. The picker groups
descendants behind disclosures, mounts them only when expanded, and reveals root pages
in batches of 50. Selecting a parent atomically selects every selectable descendant;
oversized groups are refused rather than partially selected, and a refreshed tree prunes
selection IDs that are no longer present before enforcing the 200-page cap.

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

## SearXNG Sidecar

`mcp-docs` calls SearXNG directly, so `[botdetection].trusted_proxies`
defaults to loopback only; never re-add a blanket Docker subnet. A deployment
that actually proxies SearXNG may set `SEARXNG_TRUSTED_PROXIES` to
comma-separated proxy IPs/CIDRs. The renderer must validate each entry and
fail startup on malformed input; never trust all forwarded headers. The
derived image keeps upstream ClearURLs fetches primary and patches only their
all-failed branch to load the pinned local baseline. Keep the patch strict so
an upstream integration-point change fails the image build.

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
- `MCP_DOCS_TOKEN` — 32+ chars, required for the MCP sidecar in production
- `POSTGRES_URL`, `REDIS_URL`
- `POSTGRES_PASSWORD`, `REDIS_PASSWORD` — required by docker compose (no defaults; URL-safe values, e.g. `openssl rand -hex 24`)

Tunable defaults (override only with reason): `EMBEDDING_DIMENSIONS=1024`, `USE_BULLMQ=true`, `SYNC_INTERVAL_MIN=15`, `LLM_CONCURRENCY=4`, `LLM_MAX_QUEUE_DEPTH=50`, `LLM_STREAM_TIMEOUT_MS=300000`, `LLM_CACHE_TTL=3600`, `QUALITY_*` / `SUMMARY_*` batch+interval, `CONFLUENCE_RATE_LIMIT_RPM=60`, `SHUTDOWN_TIMEOUT_MS=50000` (keep below container stop grace period). TLS escape hatches: `LLM_VERIFY_SSL`, `CONFLUENCE_VERIFY_SSL`, `NODE_EXTRA_CA_CERTS`. Observability: `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`. SMTP: `SMTP_*` (also configurable via admin UI).

**Removed (do not revive): `FTS_LANGUAGE`** — the keyword-index language lives in `admin_settings.fts_language`, edited in Settings → AI Models → Retrieval; the env var was inert on every migrated instance because migration 049 seeds that row before any request, so the fallback it fed was unreachable, and a leftover value is now reported as ignored at startup. The allow-list is `FTS_LANGUAGES` in `packages/contracts` and stays **closed**: PostgreSQL has no bind-parameter form for a `regconfig`, so the chosen name is interpolated into SQL. It is not one of the Retrieval panel's nine cheap knobs — saving it re-indexes every page inside the request — and the mechanism, its transaction and its failure modes are documented where they belong, in `docs/architecture/09-flow-rag-chat.md` and `docs/ADMIN-GUIDE.md`.

OIDC/SSO is EE-only.
