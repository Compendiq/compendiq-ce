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
without re-uploading. Expiry is the only removal path; there is no explicit
delete endpoint.

### Contracts

Per `CLAUDE.md`, every API boundary validates with Zod schemas from
`@compendiq/contracts`. This adds `PrepareImageResponseSchema`
(`{ handle, format, width, height, fileSize }`) and extends the existing
generate and improve input schemas with an optional `imageHandle: z.string()`.
`ChatContentPart` stays backend-internal — it is a provider wire shape, not an
API boundary.

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
the reply to those six words, top band first, with `max_tokens` ≈ 16.

| Provider response | Verdict | Reasoning |
| --- | --- | --- |
| 4xx rejecting the image part | `false` | Definitive: the model refused multimodal input |
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
`provider+model` only. Re-probed lazily when the row is missing, when
`vision IS NULL`, or when `probed_at` is older than 30 days. Provider config
changes already call `bumpProviderCacheVersion`; that same path deletes the
provider's capability rows, because a changed `base_url` or key can put a
different model behind the same name. The probe runs through `enqueue` and the
per-provider circuit breaker like every other outbound call, so it cannot
stampede or bypass backpressure.

## Gating

`GET /llm/usecase-default` (`routes/llm/llm-usecases.ts:23`) gains
`vision: boolean | null`, read directly from `llm_model_capabilities`. No probe
runs on the request path, so `AiContext`'s mount-time query
(`AiContext.tsx:536`) stays fast.

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
destructured and logged as `bodyModel` but never reaches the provider. It *is*
persisted, into `llm_conversations.model` (`llm-ask.ts:262`) and
`llm_improvements.model` (`llm-improve.ts:199`) — so those rows name a model
that did not produce the output.

Since gating reads the resolved model, this spec makes the record agree: both
inserts persist `resolvedModel`. One authoritative answer to "which model did
this", matching what the gate reads.

**Filed separately, out of scope here:** the AI pane's model dropdown
(`AiContext.tsx:84,832` exposes `setModel`) lets a user pick a model the backend
will not honour. Making it real is a behaviour change beyond this issue.

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
(4032×3024) fits.

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
generate/improve with the 422 gate and the cache-key change; persist
`resolvedModel` into `llm_conversations.model` and `llm_improvements.model`;
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

**Frontend**

- Paste and drop each call `prepare-image`.
- Both disabled states render their distinct copy; `vision === true` enables.
- Preview renders and the remove affordance clears the staged handle.
- Downscale fires above the threshold and is skipped below it.

## Out of scope

- The decorative model dropdown (filed separately).
- Image input on `/llm/ask`.
- Multimodal *embedding* and image retrieval — #1115, which consumes the
  capability signal specified here.
- OCR, in any form.
