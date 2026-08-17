# Multimodal Image Retrieval — Design

**Date:** 2026-08-16
**Issue:** #1115 (Phase 2 of epic #1100)
**Status:** **APPROVED 2026-08-17** (owner interview; the rulings are folded
into the sections they affect and recorded verbatim at the end). P0 —
this spec, ADR-025, migration `093` and the core `attachment-store` hoist —
has landed. P1–P6 are not implemented.

Written against `dev @ 94a4ad41` and two verified fact-bases (codebase +
external research). Every claim that drives a decision carries its source, and
every `file:line` reference was re-verified against `dev @ 4b75e8da` when P0
opened — three had moved and are corrected here.

---

## 1. Decision summary (what changes vs. the epic's framing)

| # | Decision | One-line reason |
|---|----------|-----------------|
| D1 | **Dual space, not shared.** Text stays on the Phase-1 text embedder (Qwen3-Embedding-4B @ 2560, `halfvec` HNSW). A VL model embeds **images** — and the query, for the image leg only — into a **separate** index. | Published: Qwen3-VL-Embedding's *text* retrieval is ≤ Qwen3-Embedding-4B (MMTEB Retrieval 69.41 for VL-8B, 67.12 for VL-2B, vs 69.60 for the 4B text model), so a shared space is a text regression on the product's primary path. And a shared space forces *every* text embed through the VL chat-template request shape, which only vLLM (or a self-written local shim) can serve — killing Ollama / LM Studio / plain-OpenAI text embedding for every CE deployment (ADR-021's N-provider model). |
| D2 | **Phase 1 and Phase 2 are increments, not exclusive end-states.** #1114's cutover proceeds; #1115 adds an image index beside it. | Consequence of D1. The epic's "mutually exclusive" paragraph assumed one column, one model. |
| D3 | New ADR-021 use case **`image_embedding`**, modelled on `rerank`: never inherits the default provider; unassigned ⇒ image leg **disabled**; own resolver; own client. | The wire shape is not OpenAI's `{model, input}` — see D4 — and an accidental fallback to the default text provider would silently produce garbage vectors. Same argument that made `rerank` non-inheriting (#1104). |
| D4 | **Request shape = vLLM's chat-embeddings extension**: `POST /v1/embeddings` with a `messages` array (system = instruction, user = image and/or text, trailing empty `assistant`) + `continue_final_message: true`. Used for **both** the corpus (images, default instruction) and the query (text, retrieval instruction). Never the plain `input` shape. | The model pools the last token of `<\|im_start\|>assistant\n`; the plain `input` path bypasses the chat template and yields off-distribution vectors that must not be mixed with image vectors. Instruction on the query, default on the corpus, English instruction regardless of corpus language (model-card guidance). |
| D5 | **Default recommendation: Qwen3-VL-Embedding-2B @ native 2048 (`halfvec` HNSW).** 8B (native 4096) is allowed only with MRL truncation (`dimensions` ≤ 4000), because 4096 lands in pgvector's **unindexed** tier. | 2B = 4.26 GB bf16, 8B = 16.29 GB. Production is an RTX 6000 96 GB Blackwell, so **VRAM is not the constraint and the choice is quality** — the image eval (§8) measures both and decides. The design carries the `dimensions` request parameter either way. |
| D6 | **Storage = new table `page_image_embeddings`**, not rows in `page_embeddings`. | Kills three of the issue's ten blockers structurally (the unscoped `DELETE`, the unscoped `AVG`, the `(page_id, chunk_index)` unique index) — `page_embeddings`, `embedPage`, the #1116 shadow path, MMR, rerank, sibling assembly and `pages.page_avg_embedding` all stay **text-only by construction**. Different native dims from the text column become a non-issue. |
| D7 | **Model change on the image index = truncate + re-scan.** No shadow swap for images. | The leg is disabled while the index is empty, so text search is never degraded; images are far cheaper to re-embed than a full text corpus (content-addressed skip by sha256, and only referenced images). |
| D8 | **Answer path degrades to text-only** when the chat model's vision verdict is not `true`. Retrieved images never count as "other grounding" for the refusal gate. | Owner ruling on #1115, 2026-08-10. `resolveImagePart` (#1154, `routes/llm/_helpers.ts:366`) throws on `false`/`null` — a sibling that returns `null` is needed. Counting a retrieved image as grounding would stop refusals on every weak retrieval that happens to touch an image page. |
| D9 | **Bytes come from disk, never Redis staging.** A new **core** `attachment-store.ts` — the path-resolution + read half hoisted out of `attachment-handler.ts`, plus `resolveAttachmentBytes` — is the one reader over both stores. | `llm` may import `core` only (`backend/eslint.config.js:50-53`); the staging path exists to move *user uploads* across two requests and is capacity-gated against a `noeviction` Redis (#1183). Retrieved bytes already have a stable local path. |
| D10 | **No server-side pixel processing in v1.** SVG and draw.io XML-in-`.png` are excluded by `sniffImageFormat`; images over `MAX_IMAGE_BYTES` (5 MB) or 4096 px are **skipped and counted**, not resized. | The backend deliberately has no `sharp` / `image-size` (`core/services/image-validator.ts:3-13`); adding a native decoder is a separate supply-chain decision. The model server resizes to its own pixel budget (≈1.31 Mpx) anyway. |
| D11 | **Dev story = a ~30-line Python shim** (`mlx-embeddings` behind FastAPI) exposing exactly the vLLM `messages` shape on `/v1/embeddings`. Committed under `tools/vl-embedding-shim/` with a runbook. | Only local option that reproduces production semantics (instruction as system message, template on both modalities). LM Studio's `/v1/embeddings` takes no images; llama-server's route is non-OpenAI with a per-server random media marker and two open bugs; `mlx_vlm.server` templates images but not text. **Local vectors are for plumbing and ranked-list eyeballing; metrics that decide anything are measured on the prod stack** (MLX-vs-CUDA numerics, quantisation, vLLM's own ~0.92-cosine preprocessing divergence, `vllm#33204`). |
| D12 | **vLLM version is pinned and a bump is a re-index event** for the image index. | Upstream divergence/regression issues: `vllm#33204` **open** (~0.92 cosine against the reference `qwen_vl_utils` preprocessing), `#33986` the **open** tracking issue, `#33954` **closed** (quality declining between 0.14.0rc2 and 0.15.2). Cheap to honour thanks to D7. |

## 2. What this does NOT do (v1 scope fence)

- No SVG rasterisation, no server-side downscale (D10). Follow-up decision:
  adopt `sharp` or not.
- No image+caption joint document embedding (the model supports
  `{image, text}`; v1 embeds the image alone so the vector is purely visual —
  captions already reach the **text** leg through `body_text`). Flagged as the
  first tuning knob to measure after v1.
- No Qwen3-VL-Reranker. No video. No OCR.
- No attachment retention policy — that is **#1349** (the tree grows today
  regardless of embedding).
- External images (`cacheExternalImage`) are embedded when cached — they are
  already corpus content on disk. A knob to exclude them is one line and is
  included (`rag_image_index_external`, default on).
- Not in CI: there is no runnable VL model in the gate (`nomic-embed-text` is
  text-only). Plumbing is unit-tested with a fake embedder; the quality metric
  is measured locally (§8) and on prod.

## 3. Schema (migration `093`, landed in P0)

```sql
CREATE TABLE page_image_embeddings (
  id             BIGSERIAL PRIMARY KEY,
  page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source         TEXT    NOT NULL CHECK (source IN ('confluence','local')),  -- which store the key resolves in
  attachment_key TEXT    NOT NULL,   -- filename inside that store (the converter's URL basename)
  sha256         TEXT    NOT NULL,   -- content address of the bytes that were embedded
  format         TEXT    NOT NULL,   -- sniffed: png|jpeg|webp|gif
  width          INTEGER, height INTEGER,
  model          TEXT    NOT NULL,   -- provider model id that produced the vector
  embedding      vector(2048) NOT NULL,   -- PLACEHOLDER type; retyped at probe time (runtime DDL, see below)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (page_id, source, attachment_key)
);
CREATE INDEX page_image_embeddings_page_id_idx ON page_image_embeddings(page_id);
-- NO HNSW here: it is created by ensureImageEmbeddingColumn(dims) (P1) once the
-- use case is assigned and probed, because the opclass follows the width.

ALTER TABLE pages ADD COLUMN image_embedding_dirty BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX pages_image_embedding_dirty_idx ON pages(id) WHERE image_embedding_dirty;

-- widen the use-case CHECK (same shape as 090_rerank_usecase.sql) to admit 'image_embedding'
```

- **Runtime DDL** `ensureImageEmbeddingColumn(dims)` (P1): same tiering the text
  column uses (≤2000 `vector` + HNSW, ≤4000 `halfvec` + HNSW, else unindexed
  with a WARN and a UI notice). That tiering exists in three places today —
  `embedding-service.ts:1662-1688` (the live destructive path),
  `shadow-migration-service.ts:103-107` and `eval/seed.ts:39-43` — and the image
  path is a fourth; it is deliberately a *copy of the rule*, not a shared
  helper, until someone unifies all four. When the probed dimension differs
  from the live column: `TRUNCATE page_image_embeddings; ALTER COLUMN … TYPE …;`
  rebuild HNSW; mark every non-folder page image-dirty. Records
  `admin_settings.image_embedding_dimensions`. This is D7 in code.
- `pages.image_embedding_dirty` is set by (P2): the full page upsert in sync
  (beside `embedding_dirty`), `writeAttachmentCache`, `putLocalAttachment`,
  `syncImageAttachments` / `syncDrawioAttachments` — which closes the
  "attachment changed under an unchanged version" hole in sync-service's
  version-unchanged branch (`sync-service.ts:656-733`) — the paste/import
  routes, and the re-scan action.

## 4. Backend modules

| Module | Domain | Role |
|--------|--------|------|
| `core/services/attachment-store.ts` **(new, hoisted — shipped in P0)** | core | `resolveAttachmentBytes({pageId, confluenceId, source, key})` → `{bytes, sniffedFormat} \| null`; branches the Confluence-style tree (`<ATTACHMENTS_DIR>/<confluence_id \| numeric id>/`) vs the local store (`local/<page_id>/`). `attachment-handler.ts` re-exports the moved names so its six importers do not move. **System read, no ACL** — a test walks `src/routes` and fails if any route file names it. |
| `core/services/image-references.ts` (existing) | core | Enumeration for the **stored** shape: `<img src="/api/attachments/<id>/<file>">` in `body_html` (the `/api/local-attachments` rewrite is render-time only, so a backend consumer must branch on `pages.confluence_id IS NULL`, and even then pasted images on standalone pages live in the Confluence tree keyed by the numeric PK). Gains `extractImageReferencesFromHtml` — today it only parses Confluence **storage** format (`extractImageReferences(bodyStorage)`), which standalone pages do not have. |
| `domains/llm/services/vl-embedding-client.ts` **(new, P1)** | llm | `embedImages(cfg, model, items: Array<{image: Buffer, format}>, opts?: {dimensions})` and `embedQueryForImages(cfg, model, text, opts?)`. Builds the D4 `messages` body; re-normalises after MRL truncation; inherits `enqueue`, the per-provider breaker and the TLS dispatcher (the `rerank-client.ts` precedent). Documents its **non-support list**: TEI, LM Studio `/v1/embeddings`, llama-server `/embedding`, plain `input`. |
| `domains/llm/services/llm-provider-resolver.ts` | llm | `resolveImageEmbeddingUsecase()` → `null` when unassigned; `resolveUsecase('image_embedding')` throws (same invariant as `rerank`). |
| `domains/llm/services/image-embedding-probe.ts` **(new, P1)** | llm | On assignment: embeds a known 3-colour-band PNG **and** a text through the client; refuses the pair if the endpoint rejects the `messages` shape or returns mismatched widths; records dims. Precedent: `vision-probe.ts`. |
| `domains/llm/services/image-embedding-service.ts` **(new, P2)** | llm | `embedPageImages(pageId)`: enumerate → resolve bytes → `sniffImageFormat` → `validateImage` → sha256 skip → cap `rag_images_per_page_max` → batch embed → upsert; reconcile (delete rows whose key is no longer referenced); counters for skipped/oversized/unsupported. `processDirtyPageImages()` driven from the same worker cadence as `processDirtyPages`. |
| `domains/llm/services/rag-service.ts` | llm | Image leg in `hybridSearch` (§5, P3). |
| `routes/llm/llm-ask.ts` | routes | Retrieved-image parts (§6, P4). |
| `routes/llm/llm-usecases.ts`, `routes/foundation/admin.ts` | routes | Assignment + probe + status + re-scan endpoints (`requireAdmin`). |

**One correction found while planning, carried into P1.**
`isInstructionAwareModel` / `wantsInstructionPrefix` (#1329) matches `qwen3` +
`embed`, so a Qwen3-**VL**-Embedding model id would receive the flat
`Instruct:/Query:` prefix — the wrong format for the VL family, which wants the
chat template with the instruction as a system message. The VL client owns its
own formatting, **and the text-side matcher must exclude `vl`**, so that an
operator who ever points the *text* `embedding` assignment at a VL model gets a
bare query rather than a garbled one.

## 5. Retrieval (P3)

- **When**: `image_embedding` assigned **and** `page_image_embeddings` non-empty
  **and** `rag_image_leg_enabled` (default true). Otherwise the leg does not run
  — no query embed, no cost.
- **Query**: `embedQueryForImages(query)` with the canonical English retrieval
  instruction (`"Retrieve images or text relevant to the user's query."`, a
  constant), once per request (deep search does not expand it).
- **kNN**: top `fetchWidth` rows over `page_image_embeddings` under the same
  visibility predicate, `SET LOCAL hnsw.ef_search`. Rows → `imageHits[]
  {pageId, source, attachmentKey, similarity}`.
- **Fusion**: a **third RRF leg** (rank-based, so the lower absolute cross-modal
  similarity band is irrelevant — see the calibration warning in §8).
  Page-denominated like the others (#1106): a page's best image rank counts
  once.
- **Text for image-only pages**: a page reached only via the image leg needs a
  `SearchResult` row for the downstream stages: use its `chunk_index 0` row; if
  it has none (an image-only page below the 20-char text floor — today
  invisible), synthesise `chunkText = title`. This is how image-only pages
  become retrievable at all.
- **No image-specific branch after fusion**: a `page_image_embeddings` row never
  becomes a `SearchResult`, so rerank, the ranking prior, MMR (trigram Jaccard
  over text), sibling assembly and pins keep scoring `chunkText` exactly as
  today. What they see for an image-reached page is the row above — chunk 0, or
  the title-synthesised one. **P3 owns the judgement that follows**: the
  synthesised row carries text the page did not originally have, and that text
  is what a cross-encoder scores and what MMR diffs.
- **Confidence (#1105)**: image similarity does **not** feed the confidence
  number — image hits carry no `vectorScore`, so they cannot establish the
  `similarity` basis. **Not the same as "never refuses":** the `rerank` basis is
  tested first and has no vector-led precondition
  (`retrieval-confidence.ts:124`), so with #1104's stage assigned a fully
  reranked set gets `basis: 'rerank'` whichever leg found it — true of
  keyword-only sets today. P3 must decide whether the synthesised row may carry
  a `rerankScore` into `computeRetrievalConfidence`; as the code stands it
  would.
- **Failure**: a VL call that fails or times out ⇒ leg bypassed honestly,
  `degraded_reason = 'image_leg_unavailable'` in `search_analytics` (migration
  088's column), `searchTypeFinal` unchanged.
- **Surfaces**: every `hybridSearch` caller gets it — `/llm/ask`, deep search,
  `/api/search?mode=hybrid`. `mode=semantic` stays text-only.
- **Wire**: `sources[]` gains `kind: 'image'` entries `{pageId, pageTitle,
  spaceKey, attachmentUrl, similarity: null}` — `similarity: null` keeps the
  `ConfidenceBadge` sample honest (its 0.7/0.4 cutoffs are text-cosine).
  Frontend: `SourceCitations` + `CitationChips` + the dock render an image
  source as a thumbnail (existing authenticated attachment routes) linking to
  the page via `resolveSourceTarget` (still by `pageId`).

## 6. Answer path (`llm-ask.ts`, P4)

1. After retrieval: `retrievedImages` = up to `rag_answer_max_images` (default
   2) image hits **among the returned pages**, by image similarity, bytes via
   `attachment-store`, `validateImage`, total base64 cap (default 6 MB) — the
   backpressure bound for a path that bypasses the queue by design.
2. `getVisionCapability(chatProvider, chatModel) === true` ⇒ append `image_url`
   data parts after the text part, plus one system-prompt sentence ("Some
   sources are images from the knowledge base…"). Otherwise **text-only,
   unqualified answer** (D8); the images still appear as sources.
3. `otherGrounding` counts only the **user-attached** `imagePart`, never
   retrieved images.
4. Audit records `retrievedImageCount` and bytes (today `contentToText` drops
   image parts, so the log would under-report).

## 7. Settings (ADR-010 rules apply — neutral chips, no amber for permanent notices)

- **AI Models → LLM providers**: an `Image embedding` use-case row (assign /
  unassign / **Probe**), showing dims and the tier ("2048-dim · halfvec HNSW"),
  and a plain-text non-support note.
- **AI Models → Embeddings**: an `Image index` card — embedded / candidates /
  dirty / skipped (oversized, unsupported), last run, **Re-scan** action; the
  model-change consequence stated ("changing the image model empties and
  rebuilds this index; text search is unaffected").
- **AI Models → Retrieval**: `rag_image_leg_enabled`,
  `rag_images_per_page_max` (20), `rag_answer_max_images` (2),
  `rag_image_index_external` (on).

## 8. Evaluation (extends #1102/#1332, own axis — P5)

- **Corpus** `backend/src/domains/llm/eval/corpus-de-images/`: ~60 German
  Wikipedia articles with 2–3 images each, **committed to the repo**. Text
  CC BY-SA 4.0 with per-page attribution (title, URL, revision id, authors
  link); images filtered to CC0 / PD / CC BY / CC BY-SA with per-image
  attribution (Commons file, author, licence) in `MANIFEST.json` +
  `LICENSE-ATTRIBUTION.md`; images vendored **downscaled ≤ 512 px longest edge,
  ≤ ~80 KB** (WebP/JPEG) so the corpus stays ~5–10 MB and the model still sees
  ≥ its 64×64 floor. SVG figures are vendored as Wikimedia's PNG thumbnail
  renderings, because the pipeline never rasterises (D10). All four content
  shapes are in: technical/engineering (diagrams, schematics), science figures
  (charts, cycles, anatomy), organisational/process (flowcharts, org charts,
  maps) and photos of things/places. Pages carry the images as
  `<img src="/api/attachments/…">` **without captions**, mimicking Confluence
  pages where the visual content is not restated in prose.
- **Fixture** `fixture-de-images.json`: queries in **German plus a small English
  subset** (the cross-lingual case), phrased as a user would type them, each
  with `expectedFiles[]` and a new `expectedImages[]`; a new `style: 'image'`
  (+ `'image-negative'` distractors: pages whose *text* mentions the subject but
  whose image does not show it). Labels come from an **independent,
  vision-capable labeler on a different model than the implementer, blind to
  the retrieval code** (the owner's #1102 amendment).
- **Seeder**: writes each page's images into a per-run `ATTACHMENTS_DIR` under
  the assigned page id and rewrites the `<img src>` accordingly, then
  `embedPage` + `embedPageImages` — the real intake path.
- **Metrics**: page Recall@K / MRR **paired, leg on vs off** (McNemar exact, the
  harness's gate), plus `imageHit@K`; its own `--images` axis with its own
  report family; `--baseline` refuses a cross-axis comparison. Also measured:
  image embed throughput (images/s) and the query-time cost of the extra leg.
- **Both checkpoints are measured**: 2B (an MLX build behind the D11 shim) and
  8B (the owner's `VesNFF/Qwen3-VL-Embedding-8B-GGUF` Q6_K + mmproj behind
  `llama-server`, MRL-truncated to ≤ 4000 so it stays on an indexed tier), and
  the numbers decide the default.
- **VL text-parity runs**: both checkpoints, EN + DE, through the shim's
  chat-template path. Informational — it does not gate the dual-space decision —
  and recorded in ADR-025 beside the published MMTEB figures.
- **Where it runs**: locally through the D11 shim (plumbing, ranked lists) and on
  the prod stack for the numbers that decide (the D11 caveat). Not in CI.
- **Calibration warning that shapes §5**: published cross-modal similarities sit
  in a different absolute band than text↔text ones (0.46–0.72 vs 0.75–0.81 in
  the model card's own tables). Any fixed similarity cutoff tuned on text
  misbehaves on images — which is why the image leg fuses by **rank** and why
  it never feeds `retrieval-confidence.ts`.

## 9. Documentation & diagrams (CLAUDE.md rule 6)

New ADR **ADR-025 "Multimodal image retrieval — dual space"** in
`docs/ARCHITECTURE-DECISIONS.md`, with dated amendments to ADR-003 (images stop
being invisible to *retrieval*; the text pipeline is unchanged), ADR-012 (a
third RRF leg that never feeds the confidence number) and ADR-021 (the
`image_embedding` use case + the non-support list). Diagrams: `03-backend-domains`
(core `attachment-store`) and `06-data-model` (new table + flag) in P0;
`08-flow-sync` (dirty flag on attachment writes) in P2; `09-flow-rag-chat`
(third leg, answer parts) in P3/P4; `11-content-pipeline` in P2. `CLAUDE.md`
carries the load-bearing rules (D1, D3/D4, D8, D9, D10). Runbook
`docs/runbooks/image-index.md` (serving on vLLM incl. `--runner pooling`, the
version pin, `--hf-overrides` for MRL; the local shim; probe/re-scan; what only
prod can prove).

## 10. Delivery plan (each PR TDD + adversarial review; sequential where files overlap)

| PR | Content | Depends on |
|----|---------|------------|
| P0 | This spec + ADR-025 + amendments; migration `093` (table, dirty flag, CHECK widening; **no HNSW**); core `attachment-store.ts` hoist + `resolveAttachmentBytes`; diagrams 03 / 06 / README. **No contracts change, no behaviour change.** | owner approval |
| P1 | `vl-embedding-client.ts` + resolver + probe + `ensureImageEmbeddingColumn` + assignment UI/routes + the `image_embedding` contracts enum + the `vl` exclusion in the text-side instruction matcher | P0 |
| P2 | `image-embedding-service.ts` + dirty-flag wiring (sync, uploads, local attachments) + worker + Embeddings-tab card + re-scan | P1 |
| P3 | Retrieval leg + fusion + analytics + wire shape (`sources.kind`) + Retrieval-tab knobs + frontend source rendering | P1, P2 |
| P4 | Answer path (retrieved parts, degrade rule, caps, audit) | P3 |
| P5 | Eval: Wikipedia corpus fetch script + vendored corpus + independent labels + seeder + `--images` axis + shim + runbook; measurement report | P2 (corpus/labels can start earlier) |
| P6 | Diagram/ADR/CLAUDE.md sweep, #1100/#1115 close-out | all |

**P0's scope fence, as ruled.** No contracts change in P0: the
`image_embedding` enum member ships with P1's client/resolver/probe/UI so that
no assignment row can appear without backend support behind it, and the
`sources.kind` discriminator plus the Retrieval-tab knobs ship with P3.

## 11. Questions asked, and the answers (2026-08-17 owner interview)

1. **Which VL checkpoint, in which format?** The 8B as
   `VesNFF/Qwen3-VL-Embedding-8B-GGUF` (Q6_K + mmproj) behind `llama-server`,
   and the 2B as an MLX build behind the `mlx-embeddings` shim. Both are
   measured; neither is assumed.
2. **Wikipedia licence in an MIT repo?** Acceptable, with the attribution files
   and licence filter in §8. The corpus is committed rather than fetched, so
   the eval stays reproducible if Commons files move.
3. **Default checkpoint?** Recommend 2B @ 2048 native; the image eval decides
   whether 8B @ MRL ≤ 4000 is worth 4× the weights. Production has an
   RTX 6000 96 GB Blackwell, so this is a quality question, not a VRAM one.
4. **Retention?** Out of scope → **#1349**.

## 12. Owner rulings, 2026-08-17 (interview) — recorded verbatim

- **Dual space approved** as written above (D1–D12). Phase 1 and Phase 2 are
  increments.
- **Checkpoint:** recommend **Qwen3-VL-Embedding-2B @ 2048 native**; the image
  eval measures **both** 2B (MLX build behind the shim) and 8B (owner's
  `VesNFF/Qwen3-VL-Embedding-8B-GGUF` Q6_K + mmproj, behind `llama-server`,
  MRL-truncated to ≤ 4000) and the numbers decide.
- **Production:** vLLM available; **RTX 6000 96 GB Blackwell** — VRAM is not the
  constraint.
- **Corpus:** German Wikipedia, **committed** downscaled (≤ 512 px longest edge,
  ≤ ~80 KB each, ≈ 5–10 MB total) with per-page + per-image attribution; images
  filtered to CC0 / PD / CC BY / CC BY-SA; SVG figures vendored as Wikimedia's
  PNG thumbnail renderings (raster). All four content shapes:
  technical/engineering, science figures, organisational/process, photos of
  things/places. **Queries: German + a small English subset.** Labels by an
  independent vision-capable agent on a different model than the implementer,
  blind to retrieval code (owner's #1102 amendment).
- **VL text-parity runs: both checkpoints, EN + DE**, through the shim's
  chat-template path — informational, recorded in the ADR beside the MMTEB
  figures.
- **Retention → #1349** (out of scope).
- **Merge policy:** autonomous after TDD + adversarial review + green CI (as
  Phase 1).
- **Correction carried into P1:** `isInstructionAwareModel` (#1329) matches
  `qwen3` + `embed` and would prefix a Qwen3-**VL**-Embedding id with the flat
  `Instruct:/Query:` form, which is wrong for the VL family; the text-side
  matcher must exclude `vl`, and the VL client owns VL formatting.
- **P0 scope note:** no contracts change in P0; P0 = spec + ADR + migration
  (table, dirty flag, CHECK widening; **no HNSW in the migration** — the index
  is built at probe time by `ensureImageEmbeddingColumn`) + the core
  `attachment-store` hoist + diagrams.
- **Dev machine facts:** 24 GB RAM Apple Silicon; brew `llama-server` present
  (build 10450); Python 3.14 only (use a `uv`-managed 3.12 venv if
  `mlx-embeddings` lacks 3.14 wheels); LM Studio holds the text models. The
  local model paths are environment variables, never repo constants.
