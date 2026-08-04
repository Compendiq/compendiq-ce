# Images as AI source material — vision input design (#1154)

Design of record for #1154. It resolves the blocking design decision the issue
opens with ("Decide A, B, or hybrid first") and specifies the whole feature on
top of that decision.

Related: [`../../ARCHITECTURE-DECISIONS.md`](../../ARCHITECTURE-DECISIONS.md)
(ADR-021), [`../../architecture/03-backend-domains.md`](../../architecture/03-backend-domains.md),
[`../../architecture/06-data-model.md`](../../architecture/06-data-model.md),
[`../../architecture/09-flow-rag-chat.md`](../../architecture/09-flow-rag-chat.md),
[`2026-04-20-multi-llm-providers-design.md`](2026-04-20-multi-llm-providers-design.md).

## What the feature is

A user pastes or drops a screenshot, diagram, or photo of a whiteboard into the
AI composer and it becomes source material for Generate or Improve, alongside
the document types #1131/#1132 already accept.

## The decision: Option B, vision, with no OCR fallback

The issue offers OCR (A), a vision-capable model (B), or a hybrid. **We take B,
and explicitly reject the hybrid.**

The use case names screenshots, diagrams and whiteboards — precisely the content
where layout carries the meaning and OCR returns disconnected fragments. A
hybrid that silently degrades to OCR on text-only setups produces output that
reads as a model failure rather than as a missing capability, on exactly the
inputs the feature exists for. A capability the user can see is unavailable is
better than one that appears to work and doesn't.

**This is not a cost borne by #1154 alone.** #1115 (Phase 2 multimodal RAG)
names the same blocker in its own body — *"`streamChat` is text-only today —
`ChatMessage.content` is a bare `string`"* — and declares "a vision-capable
`chat` model must exist" a hard prerequisite, without which it "delivers
retrieval that the answer path cannot consume". Its decision gate between
#1114 and #1115 turns on whether such a model is available. The multimodal
message type and the per-model capability signal specified here are the
infrastructure that gate needs.

### Stale premise in the issue body

The issue is written against `PdfUploadZone` / `useExtractPdf` /
`POST /llm/extract-pdf`. Those are gone: #1131 and #1132 merged, and the
plumbing is now `DocumentUploadZone` / `useExtractDocument` /
`POST /api/llm/extract-document`. Nothing external blocks this issue.

## Architecture

### The message type

`ChatMessage.content` widens to a union:

```ts
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}
```

This is the OpenAI-compatible content-part shape, which Ollama's `/v1` shim also
accepts — consistent with ADR-021's rule that Ollama is not a separate protocol.
The union keeps every existing producer compiling untouched; only the image path
constructs an array.

**Two definitions must be consolidated first.** `ChatMessage` is declared twice
— `domains/llm/services/openai-compatible-client.ts:20` and
`domains/llm/services/prompts.ts:9`. `routes/llm/llm-ask.ts` imports the
client's; `routes/llm/llm-conversations.ts` imports `prompts.ts`'s and persists
`messages: ChatMessage[]` as JSON. Left as-is, a multimodal message would be
valid against one definition and not the other. The canonical type lives in
`prompts.ts` (the dependency-free module) and the client imports it.

**The union is not free, and the compiler will not catch it.**
`routes/llm/llm-ask.ts:339` and `:366` compute `m.content.length`. `.length`
exists on both `string` and array, so the expression keeps compiling while its
meaning silently changes from a character count to a part count. `:337` and
`:364` compute `estimateTokens(messages.map(m => m.content).join(''))`, which
would stringify a part array to `[object Object]`. A shared
`contentToText(content: string | ChatContentPart[]): string` helper flattens
parts to their text for both, and those four lines are the only places in the
codebase where the widening bites.

### Staging endpoint

`POST /llm/prepare-image` — multipart, authenticated, rate-limited — mirrors
`routes/llm/extract-document.ts`: `request.file({ limits })`, a
`data.file.truncated` check, magic-byte sniffing that never consults the
client-supplied `mimetype`, then a header-only dimension read. It writes the
validated bytes to Redis under `llm:img:<userId>:<sha256>` with a 15-minute TTL
and returns `{ handle, format, width, height, fileSize }`.

`getRedisClient()` returns `RedisClientType | null`. With Redis unavailable the
route returns 503 and the composer disables image input with that reason —
the same state-driven disabled path used for a text-only model, not a crash.

**Exactly one image per request.** `imageHandle` is a single optional string,
not an array. Multiple images per prompt are a separate change: they multiply
the payload on a queue-less streaming path and raise ordering questions between
image and text parts that this iteration does not need to answer.

**The handle is not consumed on use.** Referencing it leaves the Redis entry in
place until its TTL expires, so a regenerate or a retry within 15 minutes works
without re-uploading. There is no explicit delete endpoint.

**One staged image per user, and raw bytes on the wire.** Staging a new image
evicts that user's previous one — `pruneOlderStagedImages` runs a
`SCAN`-and-delete over `llm:img:<userId>:*` right after the write. This is
not a nicety: the deployed Redis is shared with BullMQ, the LLM response cache
and the embedding locks, and runs `--maxmemory 256mb --maxmemory-policy
noeviction` — a full instance rejects **writes**, so unbounded staging is an
application-wide job-enqueue outage, not merely wasted memory. At the original
10 MB per image and the `llmEmbedding` rate limit, an uncapped namespace reached
that ceiling in a few minutes of deliberate uploading. Since the design already
commits to exactly one image per request and the composer shows a single
preview, a depth of 1 costs nothing the feature promises. For the same reason
the value is the raw bytes behind a short ASCII format header
(`<format>\n<bytes>`), not base64 inside JSON: ~25% less memory and none of the
encode/decode/re-encode passes over the whole image. A stored value that does
not parse — a legacy JSON entry, a truncated write — reads as a **miss** (410
"attach it again"), never a 500.

Per-user depth alone is a mitigation rather than a bound; **#1183** added the
`INFO memory` pre-flight and cut `MAX_IMAGE_BYTES` to 5 MB. See "Known residual
risks" below.

### Contracts

`CLAUDE.md` requires Zod schemas from `@compendiq/contracts` on every API
boundary. This feature touches three, across the package's two contract files.

**`packages/contracts/src/schemas/llm.ts`** — request and response shapes. The
document path established `SUPPORTED_DOCUMENT_FORMATS` (`:59`) as a single
source of truth that both the backend sniffing table and the upload UI's
`accept` list derive from. Images follow that pattern exactly:

```ts
export const SUPPORTED_IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'gif'] as const;

export const ImageFormatSchema = z.enum(SUPPORTED_IMAGE_FORMATS);

/** Content-addressed staging id: the sha256 of the validated bytes, hex. */
export const ImageHandleSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const PrepareImageResponseSchema = z.object({
  /** Format the server *sniffed* from the bytes — never the client's Content-Type. */
  format: ImageFormatSchema,
  handle: ImageHandleSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fileSize: z.number().int().nonnegative(),
});

export type ImageFormat = z.infer<typeof ImageFormatSchema>;
export type PrepareImageResponse = z.infer<typeof PrepareImageResponseSchema>;
```

SVG is absent from `SUPPORTED_IMAGE_FORMATS` by construction, so the enum itself
is what keeps it out of both the sniffing table and the UI `accept` list — the
exclusion cannot drift between the two.

**The handle is validated by shape, not merely by type.** It is interpolated
into a Redis key (`llm:img:<userId>:<sha256>`), so a bare `z.string()` would
permit key injection. `ImageHandleSchema`'s regex is a security control, not
tidiness.

`GenerateRequestSchema` (`:34`) and `ImproveRequestSchema` (`:11`) each gain one
field:

```ts
imageHandle: ImageHandleSchema.optional(),
```

**`packages/contracts/src/llm.ts`** — `UsecaseDefaultSchema` (`:80`) already
types the `/llm/usecase-default` response that `AiContext.tsx:535` consumes. It
gains the capability tri-state:

```ts
vision: z.boolean().nullable(),
```

`.nullable()` rather than `.optional()`: `null` is a meaningful verdict
("probed, couldn't tell") that the composer renders with different copy from
`false`, so it must not be collapsible with "field absent".

`ChatContentPart` stays backend-internal in `prompts.ts`. It is a provider wire
shape rather than an API boundary, and placing it in contracts would imply the
frontend constructs one — it never does; it sends a handle.

Route-side, `/llm/prepare-image` returns `PrepareImageResponseSchema.parse(...)`
exactly as `extract-document.ts` returns `ExtractDocumentResponseSchema.parse(...)`.

### Flow

```
paste / drop  (frontend downscales to 2048px long edge first)
  -> POST /llm/prepare-image        multipart; sniff, size, dimensions, audit
     -> Redis  llm:img:<userId>:<sha256>   TTL 15m
     -> { handle, format, width, height, fileSize }

POST /llm/generate | /llm/improve   { prompt, ..., imageHandle }
  -> resolveUsecase('chat')         -> { config, resolvedModel }
  -> capability gate                -> 422 unless vision === true
  -> Redis GET handle               -> 410 if expired
  -> buildLlmCacheKey(..., { imageHash })
  -> streamChat(cfg, resolvedModel, [
       { role: 'system', content: systemPrompt },          // string, unchanged
       { role: 'user',   content: [ { type: 'text', ... },  // array, new
                                    { type: 'image_url', ... } ] }
     ])
```

### What deliberately does not change

`/llm/ask` accepts no image. `llm_conversations.messages` therefore never
stores a content-part array — persisting base64 into that JSON column would
grow the row without bound. Streaming continues to bypass the LLM queue as it
does today; the image adds payload to a path with no backpressure, recorded
here as a known limit rather than silently inherited.

## Capability detection

There is no capability field in an OpenAI-compatible `/v1/models` response —
`listModels` (`openai-compatible-client.ts:154`) maps it to `{ name }` and
nothing more. Ollama's capability data lives on native `/api/show`, which
ADR-021's "`/v1` shim, not a separate protocol" rule puts off-limits. Capability
is therefore **probed**.

### The probe

A committed base64 constant: a ~64×96 PNG of three horizontal colour bands drawn
from a six-colour palette (red, green, blue, yellow, orange, purple). The probe
issues a non-streaming `chat()` carrying that image and a prompt constraining
the reply to those six words, top band first, with `max_tokens` = 64 — large
enough for the full sentence the matcher deliberately tolerates ("…are yellow,
purple, and green."), which a 16-token cap would truncate before the last band
and turn into a cached `false`.

| Provider response | Verdict | Reasoning |
| --- | --- | --- |
| HTTP 415 | `false` | Unsupported Media Type has no reading that is not about the content we sent |
| HTTP 400 or 422, body mentions the image | `false` | Definitive: the model refused multimodal input |
| HTTP 400 or 422, body says anything else | `null` | Both are also the generic answer to a malformed request — 422 is pydantic's default for *any* body-validation failure, including a field the probe itself sends |
| Any other 4xx (401/403/404/413/429) | `null` | Says nothing about image support |
| 200, reply names all three bands in order | `true` | The model demonstrably read pixels |
| 200, reply does not match | `false` | Accepted the part and ignored it |
| Network error, timeout, breaker open | `null` | Unknown — a transient outage must not permanently mark a capable model blind |

Matching is case-insensitive and ignores surrounding punctuation and filler
words: the verdict is `true` when the three expected colour words appear in the
expected order anywhere in the reply. Nothing stricter survives contact with
models that answer "Red, green, and blue." instead of "red green blue".

A blank 1×1 pixel cannot distinguish "read the image" from "ignored the image";
known visual content converts that false positive into a correct negative.

**Residual false-positive rate ≈ 0.5%** (1 in 216), confined to models that
return 200 while ignoring the image *and* answer in the required format. No
probe-based approach reaches zero. This is an accepted trade for zero admin
configuration.

### Storage — migration 087

```sql
CREATE TABLE llm_model_capabilities (
  provider_id UUID        NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
  model       TEXT        NOT NULL,
  vision      BOOLEAN     NULL,        -- NULL = unknown / not yet probed
  probed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  probe_error TEXT        NULL,
  PRIMARY KEY (provider_id, model)
);
```

`ON DELETE CASCADE`, unlike `llm_usecase_assignments`' `ON DELETE RESTRICT`
(migration 054): capability is derived data, not user configuration, so it
should vanish with its provider rather than block the delete.

### When it runs

On `PUT /admin/llm-usecases` and on provider create/update, for the affected
`provider+model` only — blocking there is fine, an admin save is not a hot path.

**The read path never blocks on a probe.** This was a contradiction in an earlier
draft of this document, caught in review during Task 7: one section promised the
read was pure-cache while another described lazy re-probing, and the read path is
exactly what calls the accessor. Resolved in favour of the pure-cache read:

`getVisionCapability` returns the stored verdict immediately — `null` when there
is no row — and when the row is missing, `NULL`, or older than
`CAPABILITY_MAX_AGE_DAYS`, it *schedules* a probe rather than awaiting one. The
caller gets a tri-state answer with no LLM round-trip in the request. Because the
UI already renders `null` as "couldn't determine — retry", a cold cache degrades
gracefully and self-heals on the next fetch.

Two bounds keep the background refresh from becoming an amplifier, both of which
review found necessary:

- **In-flight de-duplication**, keyed on `provider+model`, so concurrent mounts
  share one probe instead of stampeding.
- **A probe cooldown** (`CAPABILITY_PROBE_COOLDOWN_MINUTES`), so a model that
  keeps answering ambiguously — and therefore stays `null` forever — is re-probed
  at most once per cooldown window rather than on every single read. Without this,
  a permanently-`null` model would fire an LLM call on every mount indefinitely.

Provider updates drop that provider's capability rows (see below), because a
changed `base_url` or key can put a different model behind the same name. Every
probe runs through `enqueue` and the per-provider circuit breaker like any other
outbound call, so it cannot bypass backpressure.

## Gating

`GET /llm/usecase-default` (`routes/llm/llm-usecases.ts:23`) gains
`vision: boolean | null`, read from `llm_model_capabilities`. No probe is
awaited on the request path — see "When it runs" above — so `AiContext`'s
mount-time query (`AiContext.tsx:536`) is never gated on an LLM round-trip.

The handler's existing `try`/`catch` returns a 404 meaning "no provider is
configured for this use case". That `catch` must stay scoped to
`resolveUsecase`: widening it over the response `parse` would report a schema
or contract break as "configure a provider in Settings → LLM", pointing an
operator at the wrong problem and masking the real bug.

The composer enables image input only on `vision === true`. Both other states
disable it with distinct copy:

| State | Copy |
| --- | --- |
| `false` | *"llama3.1 can't read images — assign a vision model in Settings → LLM."* |
| `null` | *"Couldn't determine whether llama3.1 reads images — retry in Settings → LLM."* |

**The backend never trusts that gate.** `/llm/generate` and `/llm/improve`
re-check the resolved model whenever `imageHandle` is present and return 422
unless `vision === true`. Fail closed: `null` is refused, not attempted.

### The model shown is the model used

`llm-generate.ts:133`, `llm-improve.ts:168` and `llm-ask.ts:203` all resolve
`chat` and pass `resolvedModel` to `streamChat`; the request-body `model` is
destructured, logged as `bodyModel`, and never reaches the provider.

**That much is deliberate, not a defect.** All six LLM request schemas carry the
same comment — `// #929: optional — resolved server-side per ADR-021, body value
ignored` (`schemas/llm.ts:14,37,78,89,101,109`). Server-side resolution *is* the
ADR-021 design, and gating inherits it for free: capability is a property of the
assignment, not of anything a client sends.

**Correction (2026-07-30, during execution).** An earlier draft of this section
claimed the ignored body value was nonetheless *persisted*, leaving
`llm_conversations.model` and `llm_improvements.model` naming a model that never
ran, and specified a fix. That claim was false. Both inserts already pass
`resolvedModel` and always have on this branch — verified against `dev` itself
(`llm-ask.ts` and `llm-improve.ts` in `git show dev:…`), with `git diff
dev...HEAD` showing neither line touched. The behaviour predates this work
(commits `0387931` and `009c6aa7`), and existing tests already assert it:
`llm-ask.test.ts` sends `model: 'ignored-body-model'` and asserts the INSERT
receives the resolved model, and `improve-page-id.test.ts` does the same.

So the record is already consistent: one authoritative answer to "which model did
this", and it matches what the vision gate reads. No change was needed, and none
was made.

**Filed separately:** the AI pane still presents a model dropdown
(`AiContext.tsx:84,832` exposes `setModel`) whose selection #929 rendered
inoperative. Removing it or making it real is a UI decision beyond this issue.

## Validation and limits

**Formats.** PNG, JPEG, WebP, GIF — decided by magic bytes, never the client's
`Content-Type`, as `sniffDocumentFormat` already does; a mismatch against the
claimed extension is a 415.

**SVG is refused**, on two independent grounds: vision encoders need raster, and
SVG carries script and external-entity risk. #1115 records that SVG currently
sits in `SUPPORTED_IMAGE_EXTENSIONS`; this path must not inherit that.

**Dimensions without a new dependency.** Read from header bytes directly — PNG
`IHDR`, JPEG `SOFn` marker scan, WebP `VP8`/`VP8L`/`VP8X`, GIF logical screen
descriptor. Roughly 80 lines, no `sharp` and no `image-size`, matching the
byte-level idiom in `core/services/document-extractor.ts`. The server never
decodes pixels, so a declared-dimension bomb is rejected before anything
expands.

**Ceilings: 10 MB and 4096×4096**, below the documents' 20 MB because base64
inflates the payload ~1.37× and it lands in a prompt. A 12 MP phone photo
(4032×3024) fits. *(#1183 lowered the byte ceiling to 5 MB and kept 4096: only
bytes bound memory, and a 4096×4096 WebP or JPEG is well under 5 MB. A 12 MP
photo still fits in any lossy format.)*

**Client-side downscale.** The frontend resizes before upload via
`createImageBitmap(blob, { imageOrientation: 'from-image' })` and a canvas
re-encode to a 2048px long edge. No dependency; it keeps a phone photo from
becoming a 27 MB base64 prompt, applies EXIF orientation correctly, and drops
EXIF metadata as a side benefit. Server limits remain the hard ceiling for
non-browser clients.

## Security

**Prompt injection through pixels is unmitigated, and accepted.**
`core/utils/sanitize-llm-input.ts` operates on text; instructions rendered into
an image reach the model untouched. There is no mitigation short of an OCR pass,
which this design rejects. The issue's proposed step 5 ("apply the same
`sanitizeLlmInput` treatment") is **not achievable as written** for image input
and is recorded here as a stated limitation, to be repeated in the ADR-021
amendment.

**Handles are scoped per user** — `llm:img:<userId>:<sha256>` — so one user can
never reference another's staged bytes, and the 422/410 paths cannot be used to
probe for their existence.

**Audit.** `IMAGE_PREPARED` on staging (format, dimensions, size); the image
hash on the generate/improve event. Bytes are never logged. Rate limiting reuses
the `llmEmbedding` bucket, as `extract-document` does.

## Cache-key correctness

`buildLlmCacheKey` (`domains/llm/services/llm-cache.ts:38`) hashes model +
system prompt + user content + provider + thinking. Two different images with an
identical prompt would collide and serve the first image's answer. The image
hash enters through the existing `options` object as `imageHash`.

## Delivery

Two PRs, backend first.

**PR 1 — backend.** Consolidate the duplicate `ChatMessage` into `prompts.ts`
and widen it; add `contentToText` and fix the four `llm-ask.ts` audit
expressions; migration 087; the probe service; capability wiring into admin save
and cache-bus invalidation; `vision` on `/llm/usecase-default`;
`POST /llm/prepare-image`; the contracts additions above; `imageHandle` on
generate/improve with the 422 gate and the cache-key change;
ADR-021 amendment plus `06-data-model.md` (new table),
`03-backend-domains.md` (new service) and `09-flow-rag-chat.md`.

**PR 2 — frontend.** Paste and drop on the composer in
`features/ai/modes/GenerateMode.tsx:442` and `features/ai/dock/DockPanel.tsx:274`
— the two surfaces that already host `DocumentUploadZone`; canvas downscale;
preview with a remove affordance; gating and the two disabled-copy variants
driven off the `usecase-default` query; a capability badge with a re-probe
action in Settings → LLM.

## Testing

Per `CLAUDE.md`: DB tests hit real Postgres on 5433, route tests mock external
HTTP at the boundary via `vi.spyOn`, frontend tests mock fetch at the network
boundary.

**Backend**

- All four probe verdicts, with the provider HTTP response mocked at the boundary.
- `prepare-image` rejections: MIME/extension mismatch → 415, SVG → 415, oversize
  → 413, dimensions above the cap → 422, Redis unavailable → 503.
- Migration 087 and capability CRUD against real Postgres, patterned on
  `054_llm_providers.test.ts`.
- Cache-key divergence: identical prompt, two different images, two distinct keys.
- Fail-closed gate: `imageHandle` with `vision` of `false` and of `null` both 422.
- `contentToText` over a mixed array, asserting the audit payload reports a
  character count rather than a part count.
- Expired handle → 410.

**Contracts** (`packages/contracts/src/llm.test.ts` and
`schemas/llm.test.ts` alongside the existing `LlmUsecaseSchema` cases)

- `ImageHandleSchema` rejects a non-hex string, a wrong-length string, and
  anything containing `:` or `*` — the Redis key-injection guard.
- `SUPPORTED_IMAGE_FORMATS` excludes `svg`, so the sniffing table and the UI
  `accept` list cannot drift apart on it.
- `UsecaseDefaultSchema` accepts `vision` of `true`, `false` and `null`, and
  rejects the field being absent.

**Frontend**

- Paste and drop each call `prepare-image`.
- Both disabled states render their distinct copy; `vision === true` enables.
- Preview renders and the remove affordance clears the staged handle.
- Downscale fires above the threshold and is skipped below it.

## Known residual risks

Surfaced by the whole-branch review and its fix wave, and verified to be real.
None blocks the backend PR; all are recorded so nobody rediscovers them as
mysteries.

**Redis capacity is mitigated, not bounded.** *(Resolved by #1183 — kept because
the reasoning is why the fix is shaped the way it is.)* The per-user cap moved
the ceiling from *uploads × 10 MB* to *users × 10 MB*. A deployment where ~26 or
more people stage an image inside the same 15-minute window could still fill the
shipped `--maxmemory 256mb`, and that Redis is `noeviction` and shared with
BullMQ, so exhaustion failed *writes* app-wide rather than degrading a cache.
This spec left raising `--maxmemory` or lowering `MAX_IMAGE_BYTES` to the
operator; #1183 concluded that leaving an app-wide outage as an unstated
operational assumption was the wrong call and closed it in the app:

- `stageImage` pre-flights the write against `INFO memory` and answers **503**
  when `used_memory + incoming` would exceed `IMAGE_STAGING_MAX_REDIS_PERCENT`
  (default 80) of `maxmemory`. Nothing is written, the co-tenants keep their
  headroom, and the message names the 15-minute expiry so the wait is
  actionable. Exhaustion now degrades this feature instead of job enqueue.
- The check **fails open** — `maxmemory: 0` (unlimited), an unreadable reply, or
  an `INFO` that is renamed/ACL-blocked all proceed — because an unreadable
  reply is not evidence of pressure, and the write is its own backstop: a full
  `noeviction` instance refuses the `SET` with `OOM`, which maps to the same
  503 rather than a 500.
- `MAX_IMAGE_BYTES` is now **5 MB**, halving both the per-user Redis ceiling and
  the base64 heap cost noted below. `MAX_IMAGE_DIMENSION` stays 4096 — only
  bytes are a memory bound, and 4096 is still reachable in WebP/JPEG.

Full reasoning, including why there is no cache on the check and no separate
staged-bytes counter, is in ADR-021's `#1183` paragraphs.

**Two concurrent uploads by one user are resolved by repair, not by a lock.**
If each prune's `SCAN` runs before the other's `DEL`, both handles would be
deleted and both would subsequently 410 — punishing the caller who did nothing
wrong. `stageImage` therefore re-checks its own key after pruning (one `EXISTS`)
and rewrites it if a concurrent prune took it. The worst case is now both entries
surviving: a bounded overshoot of exactly one entry that expires on its own,
chosen over a lock because it costs one round-trip and cannot deadlock.

**The body matcher errs toward `null`, cheaply.** It matches `image`, `images`,
`image_url`, `vision`, `visual`, `multimodal`, `modality`/`modalities` and
`content part`; a rejection phrased outside that vocabulary falls through to
`null` and is simply re-probed — wrong in the harmless direction. Conversely, a
provider that echoes `image_url` back in an unrelated validation error could be
read as a definitive rejection and cache `false`; that is bounded by the 30-day
staleness re-probe and is visible in `probe_error`.

**`probe_error` is written and never read.** When a verdict is wrong, that column
is the only evidence, and today it is reachable only via `psql`. The Settings →
LLM capability badge in PR 2 should surface it.

**The 054 test's FK restoration hard-codes `087_llm_model_capabilities.sql`.** It
is correct and complete today — 054 and 087 are the only migrations referencing
`llm_providers` — but the next migration that adds an FK to that table
reintroduces the same contamination, presenting identically: green on a fresh
database, red on the second run, blamed on whichever PR is in flight.

## Out of scope

- The decorative model dropdown (filed separately).
- Image input on `/llm/ask`.
- Multimodal *embedding* and image retrieval — #1115, which consumes the
  capability signal specified here.
- OCR, in any form.
