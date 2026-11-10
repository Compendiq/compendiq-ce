# Content Pipeline

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root.

## Content Pipeline (ADR-003)

Confluence DC 9.2 = XHTML Storage Format only (no ADF). Pipeline:
```
Confluence (XHTML) ⇄ confluenceToHtml/htmlToConfluence ⇄ DB (body_storage XHTML, body_html clean, body_text plain)
DB (HTML) ⇄ htmlToMarkdown/markdownToHtml ⇄ {LLM: Markdown, Editor/TipTap: HTML}
```
Custom `turndown` rules per Confluence macro (code blocks, task lists, panels, mentions, page links, draw.io). See `docs/architecture/11-content-pipeline.md`.

PDF tables split tall rows at wrapped-line boundaries across pages, retaining
column positions and borders. A fitting first header row repeats on continuation
pages only when it leaves room for at least one body line; an oversized header
itself continues without repetition. Spanning cells and non-Latin font coverage
are separate limitations.

Draw.io XML-only attachments remain editable `.drawio` sources, not fake
`.png` files. Publish a preview only after validating PNG chunks, checksums
and raster stream; otherwise the wrapper names the unavailable preview and
retains its source URL. Missing previews and sources are rechecked even on
unchanged pages, without counting an intentionally absent preview as a
permanent download failure. Both TipTap schemas must round-trip that URL and
the `drawio-preview-unavailable` marker so a later preview save removes the
obsolete message. Read and edit mode share `loadDrawioSource`: try XML without
stale cache, then an actual decoded PNG containing editable draw.io metadata.
Validate every XML page, preserving the complete multi-page file and valid empty
graphs. Support the packaged editor's URI/double-URI tEXt and legacy raw-deflate
zTXt formats, with bounded expansion. HTTP 200, MIME type, and filename are not
proof of editable content. Never substitute an empty diagram on load failure.
An attachment-candidate fallback is not an authentication retry: one logical
load may invoke the shared refresh helper only once. Propagate refresh
unavailability immediately, keeping auth state and the helper's marked-busy
retry policy; never replay an uncertain rotation through the PNG candidate.
Synthetic refresh-success fixtures must satisfy the shared `AuthResponseSchema`,
including UUID user IDs. Assert request sequences and preserved session state,
not incidental error-message wording.
A missing local source is unknown upstream availability, not proof of absence:
retain the converted source locator on page-only publication (including PUT,
bulk sync and recovery). The existing authorized attachment GET resolves it
on demand; only validated local raster bytes may become a preview.
Lazy `.drawio` reads also resolve `.xml` and extensionless upstream titles.
All sync and lazy paths classify bytes, including names ending in `.xml` or
`.drawio`: actual PNG becomes a preview, actual XML becomes source, and other
payloads are not cached. A preferred source title containing PNG or unrelated
bytes must not shadow another valid XML source: continue through the supported
source candidates, retaining any validated PNG separately. A Confluence-to-local move
must refuse before any cutover or upstream deletion if a referenced draw.io
source is not preserved as XML in its prepared attachments. Open/save the
diagram first, then retry the move; never rewrite an unpreserved source.
Extensionless previews are classified even beside an existing XML source;
classification receipts suppress repeated downloads of unchanged bare sources.
A version-jump sync removes a diagram's cached `<name>.png`, `<name>.drawio`
and `<name>.drawio.png` together when the incoming body references it, keeps
all three when only local content (body, draft, history) does — by source
locator, or by the `data-diagram-name` wrapper alone in HTML written before
2026-10-28 — and never removes dot-file receipts.
Attachment saves and their recovery publish newly valid previews into existing
HTML under the same writer fence, never by reconverting stale storage. Update
plain text and invalidate persisted collaborative bytes with that presentation.
Incremental sync also reconciles stale presentation when both files exist,
through the existing conflict policy rather than an unconditional body write.
Read mode uses the draw.io schema renderer, not the editor-only React node view,
so the admitted Edit Diagram callback remains reachable for source-only nodes.
Remove its overlay when that callback is withdrawn (including a live freeze).

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

**Notion picker discovery is metadata-only.** `GET /api/notion/tree` resolves
accessible native, relation and block-host ancestors omitted from Search without
listing every page body; existing bounded row probes only advise table defaults.
Inline wiki databases remain selectable. Normalize UUID spelling, not titles,
and reject cyclic edges without losing nodes. The picker batches confirmed IDs
into requests of up to 200; explicit database exclusions travel with every batch.

**Notion import plans before persisting.** Pages and databases share parent-first
allocation, preserving the selected root and wiki home bodies. Actual embedded
child pages/databases expand their owned descendants; mentions never imply
ownership. Property-only embedded databases fold into parent tables, never also
row articles, including later row-only batches. Article-bearing rows keep their
bodies and correct parent; wiki containers remain articles. Successfully imported
direct children use one existing Child pages macro per parent. Return discovered
outcomes too, for failure reporting, cache invalidation and audit. Per-owner plus
selected-ID locks protect dynamic overlaps. Re-import preserves bodies unless
overwrite is requested; never automatically delete older row articles or local
edits to remove duplicates.

**Notion import is not request-scoped.** `POST /api/notion/import` returns 202
and runs `runNotionImport` off the request. `GET /api/notion/import/status` is
the result. A Knowledge Base with nested pages outruns nginx
`proxy_read_timeout 300` at Notion's 3 req/s; waiting on the POST is the FTS
rebuild 504 (browser error, work continues). Never put paced Notion traffic
back on that HTTP request. Start is `SET NX` on a per-user lock with a 10-minute
safety TTL (renewed while the walk runs) — a second POST while the lock is held
is 409. Renew, release, and terminal status writes are Lua compare-and-swap on
the lock token (same as Confluence `SYNC_LOCK_TTL`). `importing` is not a 24h
mutex; a missing Redis status key is idle. Redis SET NX throwing fail-closes.


**That 3 req/s budget is spent by `NotionClient`, not by its callers (#1553).**
`waitForSlot` reserves the next *start* 334 ms out, and it reserves
synchronously — before any `await` — so concurrent callers each take their own
slot and the tree's three `pLimit(5)` waves plus the importer's row-body checks
still overlap. Never serialize on completion instead: that caps the client at
1/(interval + latency) rather than 1/interval (≈1.6 req/s at Notion's typical
latency, half the budget) and silently makes every caller-side `pLimit` inert —
measured `peakConcurrentLookups` of 1, which is why both tree concurrency tests
now assert a floor as well as the cap. 429/529 retry on any method; 500/502/503/504
only on GET/DELETE and on the two POSTs that are reads (`/v1/search`,
`/v1/databases/:id/query` — a transient 5xx mid-pagination is exactly what the
ladder is for, and this client issues no writes, so a future write POST must
stay off that list). Six attempts. `Retry-After` wins over the exponential
ladder but is floored at one pacing slot (a proxy answering `Retry-After: 0`
must not turn the ladder into a hot loop) and capped at 60 s, because that sleep
sits outside `AbortSignal.timeout` and would otherwise park an import past every
request timeout. Notion-hosted attachment bytes live on S3, which is not part of
the integration's budget: `fetchMedia` retries them but takes no slot for a URL
off the API origin.

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
ODT `text:s` honours `text:c` (default one), with combined expansion bounded by
the existing entry limit; do not expand each run without a shared budget.

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

`search_web` caches only the requested bounded result width: its Redis key is
the sanitized query plus that effective width. Keep the width in cache
identity because cached results are already truncated; a narrower request
must not poison a later wider request, or vice versa.
Use the versioned `mcp:docs:search:v2:` namespace: legacy query-only hashes
can equal the new query-plus-width hashes. Never read legacy entries as
width-aware results; let their TTL expire without flushing shared Redis.

The MCP cache-width regression is mandatory in the sidecar test suite and uses
real Redis; set `MCP_DOCS_TEST_REDIS_URL` to a test-only Redis endpoint. The
PR Check sidecar job provisions Redis and sets this explicitly. Missing
configuration fails the suite rather than skipping the regression.

`search_web` accepts a `query` of at most 200 characters and 30
whitespace-separated words — a data-leakage control (`MAX_QUERY_LENGTH` /
`MAX_WORD_COUNT` in `mcp-docs/src/security/query-sanitizer.ts`; the tool
schema's `max(200)` in `mcp-docs/src/index.ts`). The public LLM contract
enforces the same bounds up front: `searchQuery` on the
ask/generate/improve/summarize request schemas is `WebSearchQuerySchema`
(`trim().min(1).max(WEB_SEARCH_QUERY_MAX_CHARS)` plus a
`WEB_SEARCH_QUERY_MAX_WORDS` refine) in `@compendiq/contracts`, so an
over-long or blank query is a `400 ValidationError` at the API boundary
instead of a silently empty search. The backend never truncates an explicit
`searchQuery`; only the derived default queries are sliced to 200 characters.
The sidecar does not depend on contracts, so both sides are pinned with
literal tests — `packages/contracts/src/schemas/llm.test.ts`,
`mcp-docs/src/security/query-sanitizer.test.ts` and the running-sidecar cases
in `mcp-docs/src/search-web-limits.test.ts`. Never widen one side alone
(#1767).
