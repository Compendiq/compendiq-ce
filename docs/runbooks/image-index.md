# Runbook — the image index (#1115)

Operating the `image_embedding` leg: which server can serve it, how to start
one, how to assign and probe it, what fills the index, how retrieval reads it,
and what changing the model costs.

**Scope: the feature is complete (P0–P5b).** The leg is *configurable*,
*provable*, *fills*, is *read*, *answers* and has been *measured* (ADR-025
**Measured** §B; recipe in `docs/runbooks/retrieval-eval.md`, "Image axis").
Assigning it types the `page_image_embeddings` column,
builds its index and queues every page (§4); a worker embeds each page's
images into it (§5); hybrid retrieval fuses a third, image-based leg into page
ranking (§6), with matched images listed as sources on `/llm/ask`; and the
chat model is shown up to `rag_answer_max_images` of those pictures when it
has probed vision-capable (§7).

**What it still does NOT do:** it never shows a picture to a chat model that
has not separately probed vision-capable, and it says nothing when it cannot —
a text-only answer is unqualified, with the images still listed as sources.
§7 is where that gate and its one refusal are written down. There is also no
SVG rasterisation, no server-side downscale and no OCR (ADR-025 D10), and a
server upgraded in place behind an unchanged base URL is invisible to every
signal in the code (§8).

Design of record: ADR-025 in `docs/ARCHITECTURE-DECISIONS.md` and
`docs/superpowers/specs/2026-08-16-multimodal-image-retrieval-design.md`.

---

## 0. What this runbook covers

Nine sections, in the order you meet them. Every `§n` reference in this file
points into this list.

| § | | Read it when |
|---|---|---|
| [1](#1-what-the-endpoint-has-to-be) | What the endpoint has to be | Before choosing a server — "OpenAI-compatible" is not enough |
| [2](#2-serving-it-on-vllm) | Serving it on vLLM | Starting the production endpoint, or setting the MRL truncation width |
| [3](#3-local-development) | Local development | You want an endpoint on a laptop (details: `vl-embedding-dev.md`) |
| [4](#4-assigning-and-probing) | Assigning and probing | Wiring the model up in Settings, or a probe refused your assignment |
| [5](#5-intake--what-gets-embedded-and-what-does-not) | Intake | The index is not filling, or a row count looks lower than the picture count |
| [6](#6-retrieval--the-image-leg-1115-p3) | Retrieval — the image leg | Deciding whether the leg is worth its latency, or it stopped contributing |
| [7](#7-answer-path--showing-the-model-the-pictures-1115-p4) | Answer path | Asking why the assistant did not describe a diagram it cited |
| [8](#8-changing-the-model-or-the-provider) | Changing the model | Swapping checkpoints, moving the endpoint, or upgrading a server in place |
| [9](#9-verifying-by-hand) | Verifying by hand | Proving the whole chain end to end, or measuring it (`retrieval-eval.md`) |

---

## 1. What the endpoint has to be

Not "any OpenAI-compatible embeddings endpoint". The model is pooled at the
**last token of a chat prompt**, so the request is vLLM's chat-embeddings
extension: `POST {baseUrl}/embeddings` with a `messages` array and a trailing
**empty `assistant` turn** plus `continue_final_message: true`.

| Serving path | Verdict |
|---|---|
| **vLLM ≥ 0.14.0**, `--runner pooling` | **The supported path.** |
| Hugging Face **TEI** | No. No image concept anywhere in its OpenAPI spec; the request for this family (`text-embeddings-inference#822`) is open with zero comments. |
| **LM Studio** `/v1/embeddings` | No. Text `input` only; images belong to its chat surface. |
| **llama.cpp `llama-server`** | Not through this client. Multimodal embeddings exist, but on the **non-OpenAI** `POST /embedding` route, with a hand-built prompt and a per-server *random* media marker from `/props`. Fine for measuring a GGUF checkpoint directly; not something Compendiq can be pointed at. |
| `mlx_vlm.server` | No. It applies the chat template to images and **not** to text, so the two modalities come from different formattings. The probe refuses this (`width_mismatch`) only when the widths also differ — do not rely on it catching every such server. |
| Plain `{model, input}` on any server | No. Mechanically accepted by the same vLLM instance, and wrong: the chat template is applied on the `messages` path only, so the vector is pooled at a different position and must never share an index. |

## 2. Serving it on vLLM

```bash
# 2B, native 2048 dimensions — the recommended default.
vllm serve Qwen/Qwen3-VL-Embedding-2B \
    --runner pooling \
    --max-model-len 8192
```

- `--runner pooling` is required; the checkpoint ships its own
  `chat_template.jinja`, so **no `--chat-template` flag is needed**.
- No `--pooler-config`. The conversion default is last-token + L2-normalise,
  which is exactly what the checkpoint's `1_Pooling` / `2_Normalize` declare.
  Third-party guides suggesting `{"pooling_type": "MEAN"}` are wrong for this
  model.
- `--max-model-len 8192` matches the reference implementation's operating
  context. 32K is the architectural ceiling; nothing was evaluated there.

**MRL (`dimensions`) takes two steps: the server must ACCEPT it, and Compendiq
must SEND it.** Neither is optional, and neither does the other's job.

`--hf-overrides` is the first half. Neither checkpoint declares `is_matryoshka`
in `config.json`, and vLLM refuses the `dimensions` parameter for models it does
not recognise as Matryoshka:

```bash
vllm serve Qwen/Qwen3-VL-Embedding-8B \
    --runner pooling --max-model-len 8192 \
    --hf-overrides '{"is_matryoshka": true}'
# or pin the allowed set:
#   --hf-overrides '{"matryoshka_dimensions":[4096,2048,1024,512]}'
```

That flag **makes vLLM accept the request parameter — it does not change the
served width**. `dimensions` is per-request, and there is no serve-time flag
that sets a default one, so an 8B started exactly as above still answers 4096
until a client asks for less.

The second half is Compendiq's, in **Settings → AI Models → the Image embedding
row → "Truncate to N dimensions (MRL)"**
(`admin_settings.image_embedding_target_dimensions`). When it is set, that
number is sent as `dimensions` on **every** image-side call: the assignment
probe, Re-check, the image embedder (§5), and — from P3 — the query side. Leave it
empty to use the model's native width.

Two consequences worth knowing before you set it:

- **The probe verifies it.** It sends the width and requires the answer to come
  back at exactly that width; a server that silently ignores the parameter is
  refused as `dimensions_ignored` rather than recorded at the width it happened
  to answer with. If the server *refuses* the parameter outright you get
  `shape_rejected`, and the refusal names the override.
- **Changing it is a rebuild.** It is part of the recorded identity
  (`provider:model@baseUrl#dims`), so saving a new width empties the image index
  and re-dirties every page — see §8.
- **The width is saved even when the probe that follows it fails.** It has to
  be: the probe sends it, so it is written first. A refusal therefore leaves the
  new width stored, the assignment and the column exactly as they were, and the
  refusal on the row — the row, because a width change re-sends the assignment
  already in force, and a refused verdict for the *live* pair is stored (§4).
  Fix the server and press **Re-check** on the row, or clear the field and save
  again. The two remedies are not interchangeable, and which one you need
  follows from the width already being stored. **Save is a value diff**: after a
  refusal the panel re-reads the stored width, so once the server is fixed
  pressing Save again compares the same number against itself, finds no change
  in the dropdowns either, and reports **"No changes"** without re-probing
  anything. **Re-check** is the control that re-runs the probe — it reads that
  same stored width, sends it, and on success re-applies the column type
  (`ensureImageEmbeddingColumn`), which is the half the refused save never got
  to. Clearing the field back to `native` *is* a real change against the stored
  width, so that branch really does go through Save — and it re-sends the
  assignment and re-probes with it.

Compendiq re-normalises client-side whenever it sends `dimensions`, because
truncating a unit vector does not leave a unit vector and vLLM is not documented
to re-normalise on every path.

### Pin the version. A bump is a re-index event.

vLLM's image preprocessing diverges from the reference `qwen_vl_utils` path
(~0.92 cosine on identical inputs — `vllm#33204`, open, acknowledged in vLLM's
own docs), and a quality regression between `0.14.0rc2` and `0.15.2` was
reported as `vllm#33954`. A corpus embedded on one version and queried on
another is silently degraded, and nothing in Compendiq can detect it.

So: pin the served version, and when you change it, treat it exactly like
changing the model — see §8.

What Compendiq can see for you, and what it cannot:

- **Moving the endpoint** — a different provider row, *or* the same provider
  row edited to a new `base_url` — changes the recorded identity, so the next
  save or **Re-check** rebuilds. That covers a container swapped for one running
  a different vLLM version at a new address.
- **Upgrading in place**, same URL, is invisible to every signal the app has.
  After such an upgrade, run **Re-check** (it re-confirms the width) and then
  press **Re-scan all** on the Embeddings tab (§5). Nothing will warn you, and
  the re-scan is not free here: the bytes are unchanged, so every image reuses
  its row by content hash and the vectors from the *old* server survive. If you
  need them regenerated, change something in the identity — the truncation
  width, or the provider row's URL — so the rebuild truncates first.

## 3. Local development

A FastAPI shim exposing the §1 shape is the only local option that reproduces
production semantics on **both** modalities (instruction as a system message,
chat template on image *and* text). It lives in `tools/vl-embedding-shim/` —
one process over two interchangeable backends (`mlx` in-process, `llama`
proxying a `llama-server` you started); see its README and
`docs/runbooks/vl-embedding-dev.md`.

**Local vectors never decide anything.** Quantisation, MLX-vs-CUDA numerics and
vLLM's own preprocessing divergence each move the space. Local is for plumbing
and for eyeballing ranked lists; any number that decides something is measured
on the production stack.

## 4. Assigning and probing

Settings → AI Models → the **Image embedding** row.

1. Pick a provider (and a model, or leave it to the provider's default model).
2. If the checkpoint's native width is above 4000 — the 8B — set **Truncate to
   N dimensions (MRL)** on the same row (§2). Leaving it empty is correct for
   the 2B.
3. Save. The save **blocks on a probe** and **refuses the assignment** if it
   fails — a leg that cannot embed must not be assignable, because the failure
   it prevents is silent: a plain text embedder *answers* the request with a
   well-formed vector from the wrong pooling position.

The truncation width is written first, then the assignment is re-probed with it,
so one Save does both. Changing only that number still re-probes and still
rebuilds; there is no separate step to remember.

On success the row is written with the **resolved model pinned into it**, even
if you left the model on "Inherit provider's model": the probe verified exactly
one model, and an inherited one would silently follow the provider's
`default_model` the next time somebody edits it. So the model dropdown will show
that model after the save. That is not a UI glitch — it is the leg refusing to
name a model nobody probed.

The probe embeds a known image **and** a text, and requires:

- the endpoint accepts the `messages` shape;
- both come back at the **same width** (a server that templates one modality
  and not the other puts two vector spaces in one column);
- the width is 1..16000;
- the width equals the configured truncation width, when one is set — a server
  that ignores `dimensions` answers 200 at its native width, and recording that
  would type the column for a space nothing else writes into.

**Refusal categories.** The toast carries the prose in the middle column; the
slug is the `reason` field on the 422 body, which is what a log line or a
scripted client sees.

| Category (`reason`) | What the toast says | Do |
|---|---|---|
| `shape_rejected` | "This endpoint refused the request. Image embedding needs a server that accepts vLLM's chat-embeddings shape…" | The endpoint answered 400/404/405/422 — it is reachable and refusing *this request*. Usually the wrong kind of server (see §1) or the wrong model id. If a truncation width is set, it may also be vLLM refusing `dimensions` for a checkpoint it does not consider Matryoshka (§2) — the message says so when that applies. The provider's own body is always in the **backend log**, which is why the toast points there. Whether the row's disclosure also shows it depends on *which* pair was refused: a refused verdict overwrites the stored one only when the refused pair **is the live pair** (a re-save of the assignment already in force, which is what a width change sends — §2). A refused change to a *different* pair is not stored, so the disclosure keeps describing the previous, still-working leg rather than replacing a true verdict with "Not established". |
| `provider_error` | "The provider answered with an error rather than a vector…" | 401/403 (credentials), 429 (rate limit) or 5xx. **Not** a verdict about the server being the wrong kind: a vLLM still loading its model answers 503, and `vllm#33865` is an open report of intermittent 5xx from this endpoint. Check credentials and readiness, then re-run the probe — and mind *which* control does that. If you were changing the truncation width on an assignment already in force, the width is already stored, so Save is a no-op that answers "No changes": fix the server and press **Re-check** on the row, or clear the field and save again (§2). If you were making or changing an assignment, the dropdowns still hold your unsaved edit, so **Save** re-sends and re-probes. |
| `unreachable` | "The provider could not be reached, or did not answer within the probe's time budget…" | Check the base URL, credentials, and that the server is up. The per-provider breaker may also be open from earlier failures. Each probe call is bounded at 60s. |
| `width_mismatch` | "This endpoint returned different vector widths for an image and for a text…" | The server is not applying the same formatting to both. Not usable. |
| `dimensions_ignored` | "This endpoint ignored the truncation width configured for image embedding…" | The server accepted the request but answered at another width — almost always started without `--hf-overrides '{"is_matryoshka": true}'` (§2). Restart it with the override and press **Re-check** on the row, or clear the truncation width and save again — the stored width makes a repeat Save a no-op (§2). |
| `unusable_width` | "This endpoint returned a vector width Postgres cannot store — a pgvector column holds at most 16000 dimensions." | Only fires above pgvector's **column** ceiling. A width of 4001–16000 is *not* refused: it is stored and left unindexed (see Index tiers), which the row states. |

On success the row shows `2048-dim · halfvec HNSW` (or `vector HNSW`, or
`no index (sequential scan)`) and when it was last checked. **Re-check** re-runs
the probe against the currently assigned pair; on success it also re-applies the
column type, which is the remedy when you restart the model server at a
different width. A *failed* re-check leaves the column alone and is reported as
an error, not a success.

**Re-check is not read-only.** If the width or the endpoint changed, re-applying
the column type is the destructive rebuild in §8: the image index is emptied and
every non-folder page is queued for a re-scan. The toast says so, naming the
page count, when that is what happened.

The provider's raw error body is admin-only, behind the row's disclosure — which
shows the **currently assigned** pair's last verdict. A refused *change* never
overwrites it, so after a refused assignment look in the backend log rather than
there. It is never returned by `GET /llm/usecase-default`, which every logged-in
user can call.

### Index tiers

| Probed width | Column | Index |
|---|---|---|
| ≤ 2000 | `vector(n)` | HNSW `vector_cosine_ops` |
| ≤ 4000 | `halfvec(n)` | HNSW `halfvec_cosine_ops` |
| > 4000 | `vector(n)` | **none** — sequential scan |

The unindexed tier is legal and correct, and it will get slow as the corpus
grows. Prefer MRL truncation to 4000 or below — which means setting **Truncate
to N dimensions (MRL)** on the row *and* serving with the override (§2), because
the tier follows the width the model actually answers with.

## 5. Intake — what gets embedded, and what does not

Assigning the leg (§4) makes the index *possible*; this section is what fills
it. The unit of work is a page: `embedPageImages(pageId)` enumerates the images
that page's stored body references, embeds the ones it can, and deletes the rows
for the ones it no longer references. `processDirtyPageImages()` runs that over
the backlog.

### What schedules a page

`pages.image_embedding_dirty` is the queue. It is raised by:

| Event | Where |
|---|---|
| A page is created or updated by sync | the sync upsert, beside `embedding_dirty`, unconditionally — it is rewriting the body anyway |
| A page's body changes on a conflict-policy update | gated on `body_html` alone — `body_text` cannot move an `<img>` |
| A page is created **in the app** | both `INSERT INTO pages` arms in `pages-crud.ts`, unconditionally for a non-folder page (there is no previous body to diff against). The Confluence arm's `ON CONFLICT … DO UPDATE` re-writes `body_html` on a row that may already carry index rows |
| A page is edited **in the app** | all four `body_html` writers in `pages-crud.ts` — the editor save on a local page, the app-side Confluence push, publish-draft and the bulk refresh — each gated on `body_html`. With the two below, this is the only trigger for an image that was **deleted**: that writes no attachment at all |
| A version is **restored** | `restoreVersion` (`version-tracker.ts`), gated on `body_html`. Swapping the body for an older one is exactly how an `<img>` comes back or goes, and neither source self-heals: a standalone page is never touched by sync, and a Confluence restore is pushed upstream and the returned version written back, so the next `syncPage` takes the version-unchanged branch |
| An AI improvement is **applied** | both branches of `POST /llm/improvements/apply`, gated on `body_html`. `protectMedia`/`restoreMedia` and #723's drop-guard keep the `img` set intact across the markdown round trip, so in practice every row is reused by content hash — the flag is raised anyway rather than resting on an invariant that lives in another module |
| A new or changed attachment is downloaded under an **unchanged** page version | `syncImageAttachments` / `syncDrawioAttachments`, on a real download only |
| An image is fetched lazily on a cache miss while viewing a page | `fetchAndCachePageImage` — the recovery path for a `missing` skip |
| An image is pasted, or imported from an external URL | `writeAttachmentCache` |
| A draw.io diagram is saved on a local page | `putLocalAttachment` |
| A page is relocated between Confluence and local | both directions, unconditionally — the move rewrites every `<img src>` |
| A page's cached attachments are cleared (a new version, an unsync) | `cleanPageAttachments` — this re-queues the page so the next scan **re-reads** it; it does not shrink the index (see below) |
| **Re-scan all** | the Embeddings-tab action, and the model-change rebuild in §8 |

The worker runs **off the sync cadence** — fire-and-forget beside
`processDirtyPages`, which is how the text embedder is scheduled too — plus the
two admin actions below. There is no separate repeatable job, and that has a
consequence worth stating: `runScheduledSync` only reaches `syncUser` for users
with a Confluence URL *and* a PAT *and* a space assignment, so on a deployment
with **no Confluence credentials at all** — where local pages still raise the
flag through `putLocalAttachment` and `writeAttachmentCache` — nothing ever
kicks the worker automatically. Press **Process now**.

### What is embedded

Everything the page's `body_html` points at with one of the two attachment
prefixes, deduped by `(source, key)`:

- `<img src="/api/attachments/<key>/<file>">` → the Confluence cache tree
- `<img src="/api/local-attachments/<page id>/<file>">` → the local store

**The store follows the URL prefix, never `confluence_id IS NULL`.** A relocated
page has no `confluence_id` and its bytes in the *local* store, and a page
pasted into after that move carries both prefixes at once.

An image whose bytes are unchanged since its last embed — same sha256, same
model — **keeps its row and costs no request at all**. That is what makes
Re-scan cheap, and it is why the model-change rebuild in §8 is affordable.

### What removes a row

Reconcile deletes the rows of this page whose `(source, key)` the page's
**stored body no longer references**. That is the only rule, and it has one
consequence that surprises people: **a file that has gone missing keeps its
row.** The reconcile set comes from `body_html`, not from what the scan managed
to read, and `resolveAttachmentBytes` answers the same `null` for "the file is
gone" and for "the read failed" — so deleting on a miss would let one bad disk
moment empty a page's entries. A missing file is counted as a `missing` skip
and its row is left alone; a stale row is recoverable (the next sync
re-downloads the file), a deleted one costs a full re-embed.

So an unsync, or any other clearing of cached attachment files, does **not**
shrink the index. Rows go away when the body stops pointing at the image,
when the knobs below exclude it, or when the `pages` row itself is purged
(`ON DELETE CASCADE`) — and the whole table is emptied by the model-change
rebuild in §8.

One more remover exists since #1349, and it cannot collide with the rule
above: the **attachment orphan sweep** (Settings → Knowledge → Spaces & Sync →
Sync schedule, the Attachment storage card; docs/ADMIN-GUIDE.md "Attachment
Storage & Orphan Sweep")
deletes the `page_image_embeddings` rows of files it removes from disk — a
safety net, since a file it removes is by definition referenced by no body
anywhere, while a `missing` row's file IS still referenced and therefore sits
in the sweep's keep-set and never becomes a candidate. The sweep is also what
bounds the attachment tree this index is built over.

### What is skipped, and why

Skipping is not failing: the page still clears its flag, and the reason is
counted and shown on the card.

| Reason | Meaning | Is it a problem? |
|---|---|---|
| `unsupported` | The bytes sniff as no raster format — SVG, or Confluence's draw.io export, which is `<mxfile>` XML behind a `.png` name | No. Working as designed (ADR-025 D10) |
| `missing` | The body references a file that is not in the store | Usually a failed attachment download; check the sync log |
| `tooLarge` | Over `MAX_IMAGE_BYTES` (5 MB) | No — **nothing is resized**. The backend has no pixel decoder, deliberately |
| `oversized` | Declared dimensions over `MAX_IMAGE_DIMENSION` (4096) on either edge | Same |
| `capped` | Past `rag_images_per_page_max` on this page | Raise the knob if a page legitimately carries more |
| `external` | Fetched from an external URL (`external-<hash>` in the cache) with `rag_image_index_external` off | Only if you did not mean to turn it off |

A **failure** is different, and it has two causes:

- The endpoint **refused or never answered** — a provider outage, an open
  breaker, a timeout. Retrying is automatic: the page keeps its
  `image_embedding_dirty` flag and the next scan tries it again.
- The model answered at a **width the column is not typed for**. This is the
  guarded-DDL state §8 describes — the assignment saved and the `ALTER` did
  not — and the check happens *before* the INSERT, so it lands here rather than
  taking the page's write down with it. The automatic retry will keep failing
  until you press **Re-check** on the Image embedding row, which re-applies the
  column type. The card says so directly when it can: if the recorded index
  identity is not the pair assigned now, it renders an amber line naming
  Re-check above the counters.

Either way the counter is `failed`, the page stays queued, and the card renders
it in amber.

A **page failure** is a third thing, counted separately (`pagesFailed`, its own
amber line). It means `embedPageImages` itself threw — a **database** error, so
the transaction rolled back and the page embedded nothing at all even if some of
its images had answered. It is not a fact about the provider; look in the
backend log for the SQL error. A page failure never aborts the scan; the run
continues, and the page stays queued.

### The two knobs

Both live in `admin_settings` and are settable through `PUT /api/admin/settings`
(their Retrieval-tab controls arrive with the retrieval leg):

| Key | Default | What it does |
|---|---|---|
| `rag_images_per_page_max` | `20` | Images embedded per page. A cost bound: each one is a request through the shared LLM queue. **`0` is not a value** — the leg is switched off by unassigning the use case |
| `rag_image_index_external` | on | Whether images a body pulled from an external URL are indexed |

### Re-scan vs Process now

Both are on **Settings → AI Models → Embeddings**, on the *Image index* card,
and both return immediately — the scan runs detached, and the card polls.

- **Process now** works through the pages that are *already* queued. It is what
  you press after fixing a provider outage.
- **Re-scan all** marks **every** live non-folder page first. It is what you
  press after upgrading the model server in place (§8 — no signal in the app can
  see that), or when you suspect the index has drifted from the corpus. It is
  affordable because unchanged bytes reuse their rows by content hash: a re-scan
  of a settled corpus costs one file read per image and no requests.

**Pressing either while a scan is already running is a no-op, and the card says
so** rather than reporting a start. Re-scan's marking half still happens — but
the running scan walks a `LIMIT`/`OFFSET` window over `last_modified_at DESC`,
so pages the marking inserted *ahead* of its current offset are not visited by
it. They stay queued. Press **Process now** once the running scan finishes; on a
Confluence instance the next `syncUser` would also pick them up, on a local-only
one nothing would.

### Reading the card

- **Images embedded** — rows in `page_image_embeddings`. Expect it to be *lower*
  than the number of pictures in the corpus; the skip table above is why.
- **Pages pending** — `image_embedding_dirty` over live non-folder pages. On a
  settled instance this is 0. If it is not falling, there are three causes; the
  card distinguishes the first two, and the third is what is left. The leg is
  **unassigned** (it says so); the last run **failed** (an amber line, and
  `failed`/`pagesFailed` name which kind); or **nothing has kicked the worker**
  — for which the card renders nothing at all, because "no scan has run" and "a
  scan ran and found nothing to do" leave identical state. Its automatic cadence
  rides `syncUser`, which only runs for users with a configured Confluence URL
  and PAT, so a local-only instance fills the index from **Process now** /
  **Re-scan all** and nothing else.
- **Last run** — pages visited, embedded, reused, removed, and skipped by
  reason. `removed` counts rows reconciled away, which is the expected outcome
  of a page that lost an image — including one whose `<img>` was deleted in the
  app's own editor, which is why every `body_html` writer raises the flag.
- **A status read that FAILS** says so, in the destructive treatment, and states
  that the assignment and the stored index are unaffected. It never renders as
  "not assigned" — that would send an operator whose leg is working to go and
  assign it — and both actions stay live, because they are the recovery.

## 6. Retrieval — the image leg (#1115 P3)

The index is read by a **third RRF leg** beside the semantic and keyword ones.
Design of record: `docs/architecture/09-flow-rag-chat.md`, "The image leg".

### When it runs

All four, checked in this order. When any fails the leg does **no retrieval
work** — no embedding call, no kNN, no row:

1. the caller did not force it off (`/api/search?mode=semantic` never reaches
   it at all; deep search's paraphrase legs force it off — see below);
2. **Settings → AI Models → Retrieval → Image retrieval → Image leg** is on
   (`admin_settings.rag_image_leg_enabled`, default on);
3. the `image_embedding` use case is **assigned** — it never inherits, so an
   unassigned instance never runs the leg and never pays for it;
4. `page_image_embeddings` is **non-empty**.

(4) is re-checked on every request rather than cached, because it flips on the
first page the worker embeds and again when a model change truncates the table.

A shut gate is not literally free, and it is worth knowing what it is: one
cached boolean for (2), then one small indexed lookup of the assignment for
(3). On an instance with no VL model that lookup answers "unassigned" and the
request stops there — (4) is never reached — so the standing cost of having
this feature compiled in is a single indexed round-trip per hybrid search. If
you are auditing query counts, that is the row to expect; the `EXISTS` in (4)
appears only once a model is assigned.

### What it costs

**One extra embedding call per question**, to the VL endpoint, bounded at 3
seconds including queue wait. It runs in PARALLEL with the two text legs, so
the added latency is whatever it spends beyond them — on the reference stack a
short text through the chat template is well under a second. A persistently
slow or dead endpoint trips the per-provider breaker and the leg self-disables
for the cool-down instead of costing 3s on every question.

**One extra kNN, bounded separately at 2 seconds** (`SET LOCAL
statement_timeout` inside the leg's own transaction). The two budgets are
separate numbers and they compose: the leg's worst case is about five seconds,
not three. The kNN needs its own bound because it is not always an index probe
— above 4000 dimensions no HNSW index exists (§2), so the leg scans the table
sequentially, and the answer path *waits* for it. A statement that runs out of
budget is the ordinary `image_leg_unavailable` bypass, not an error to the
user; if you see those on an unindexed instance, that is the tier's cost
arriving, and the remedy is the MRL truncation width in §2 or the knob above.

**One extra connection from the vector pool, per hybrid search.** The leg's
transaction deliberately overlaps the text vector leg's, so a request holds two
of `PG_VECTOR_POOL_MAX` (default 5) rather than one, and the pool's effective
request concurrency roughly halves when the leg is live. The two sides are not
symmetric about losing that race: a connect timeout in the image leg is a
bypass, while the same failure in the *text* vector leg is `embedding_failed`,
which `/llm/ask` refuses the turn on. **Raise `PG_VECTOR_POOL_MAX` when you
enable the leg on a busy instance**; leaving it at 5 lets an optional leg cost
answers the mandatory one would have grounded.

The knob in (2) exists precisely so an operator can stop paying that while
leaving the index being **built**. Unassigning the use case instead turns off
*both* halves and lets `image_embedding_dirty` accumulate corpus-wide.

**Deep search runs it once**, on the original question only — the paraphrase
legs do not embed a second or third query vector.

### What it changes

Page RANKING, and on `/llm/ask` the answer's `sources[]`.

- A page's **best** matching image ranks it once, however many of its images
  match. Up to three hits per page ride along for the source list.
- A page **no text leg found** enters the results with its first chunk as text,
  or — if it has no indexed text at all, which is the image-only page this leg
  exists to reach — its title. That is what makes such a page retrievable for
  the first time.
- `/api/search?mode=hybrid` gets the leg for ranking; its response shape is
  unchanged (page rows). `mode=semantic` is text-only.
- `/llm/ask` gains `kind: 'image'` entries in `sources[]` — up to four per
  answer — which the assistant renders as a thumbnail linking to the page.
  They carry `similarity: null` deliberately: a cross-modal score shares no
  scale with the text cosines beside it, so it must never join the confidence
  average.
- The **confidence NUMBER and the `weak_match` verdict are unaffected**. An
  image hit establishes no measurable basis, and a page reached only by the
  image leg is excluded from the sample entirely, so it can neither lift the
  number nor trigger a `weak_match` refusal.
- The **`no_context` refusal is affected, and that is the intended trade**.
  That arm fires when retrieval returned *nothing*; a page this leg made
  retrievable is something, so a question that used to return an honest "I
  found nothing" can now return an answer.
- **Since P4 the outcome for such a page is two-way, and the rule is in §7.**
  On the corpus the leg exists for — a page below the embeddable text floor,
  which neither text leg can reach — the model's only text is that page's
  title. If P4 attaches the picture, it answers from the evidence. If it
  cannot (no vision-capable chat model, `rag_answer_max_images` at 0, or every
  candidate skipped) and **every** returned row is such a page, `/llm/ask`
  refuses with the new `image_only_context` reason and lists the pictures
  beneath it. A mixed set — one real text row — always answers. If you would
  rather these questions never reached the answer path at all, turn the leg
  off with the knob in (2); it is a retrieval decision, not a confidence one.

### How to tell it ran

**Traces.** `rag.hybrid_search` carries `rag.image_pages` and
`rag.image_only_pages` **only when the leg ran** — absent means it did not run
at all, which is a different fact from "found nothing". The leg's own span is
`rag.image_leg`, whose attribute of the same name is one of `disabled`,
`unassigned`, `empty_index`, `ran` or `failed`.

**Analytics.** A bypass writes `degraded_reason = 'image_leg_unavailable'`:

```sql
SELECT created_at, search_type, degraded_reason
  FROM search_analytics
 WHERE degraded_reason = 'image_leg_unavailable'
 ORDER BY created_at DESC LIMIT 20;
```

Note the **precedence**: the column records the worst outage, so a request in
which the text embedder ALSO failed records `embedding_failed` and this query
will not see it. `search_type` is unchanged either way — two legs or three is
not a different kind of search.

**Logs.** One `warn` per failure, carrying the category and the model, never
the provider's response body (that reaches admins through the probe
disclosure, §4).

**By hand.** Ask a question whose answer is only in a picture — the
image-only page's title with no matching prose is the sharpest test. If the
page comes back, the leg ran. If it does not, walk the four gate conditions
above in order; the Embeddings-tab card (§5) answers (4).

### When it fails

Every failure is a **bypass**: the answer is exactly what it would have been
with the leg off, plus the analytics row above. Nothing about a VL outage can
fail an ask, empty a result set, or change a refusal verdict.

One case reads like a failure and is not: a use case that is simply
**unassigned** is *off*, not degraded, and writes no `degraded_reason`. So an
empty `image_leg_unavailable` count on an instance with no VL model is the
expected reading, not evidence the leg is healthy. What does record is a read
of the assignment that ERRORED — a database problem, not a credential one (an
undecryptable `api_key` yields a null key and the call proceeds).

The same distinction applies one line further down the gate: an **`EXISTS`
probe that could not be answered** is a degradation, not an empty index. It
takes ACCESS SHARE on `page_image_embeddings`, which a rebuild's retype holds
ACCESS EXCLUSIVE on, so the realistic trigger is a `lock_timeout` against a
model change happening at the same moment — the leg goes quiet for those
requests and says so. And the **lede fetch** counts as well: the leg can run
successfully and still lose every image-ONLY page if the one batched chunk-0
query fails, so that partial bypass writes the same reason rather than a
healthy row. If you see `image_leg_unavailable` while the VL endpoint is
demonstrably fine, look at the database before the model.

## 7. Answer path — showing the model the pictures (#1115 P4)

P3 made a picture *retrievable* and put it on the wire as a source. P4 is what
puts it in the request: when the pages that ground an answer carry matched
images and the chat model can see images, up to `rag_answer_max_images` of
them are attached to the user turn as `image_url` parts.

### The gate

Four conditions, all of which must hold. They are checked in this order
because each makes the next cheaper — on a deployment with no image leg the
whole step is one cached settings read:

1. **`rag_answer_max_images` > 0.** Settings → AI Models → Retrieval → Image
   retrieval → *Images shown to the model*. Default **2**, range 0–8. Unlike
   the intake cap beside it, **0 is a legal value**: it is the off switch, and
   it subtracts nothing durable — the index still fills, the leg still ranks
   pages, and the pictures still reach the reader as sources.
2. **Some returned page carries image hits.** False on every deployment
   without an assigned `image_embedding` model, and on most questions where
   there is one.
3. **The resolved `chat` pair has probed vision-capable.** The stored #1154
   verdict, read from `llm_model_capabilities` — never a *blocking* probe,
   which would put an LLM round-trip on the answer path. (A missing or stale
   row does schedule one in the background; see "What it does not do" below.)
   The tri-state is not
   collapsed: `false` (probed and refused) and `null` (never established)
   both mean text-only here, and only `true` admits bytes. If the verdict is
   wrong, fix it with **Re-check** on the chat row (#1184), not here.
4. **The bytes are usable.** Each candidate is read from the attachment store
   and put through the same gate a user-attached image passes — format
   sniffed from the bytes, `MAX_IMAGE_BYTES` (5 MB), `MAX_IMAGE_DIMENSION`
   (4096). Anything else is skipped and counted.

### What a text-only model sees

Exactly what it saw before P4, and **nothing tells it, or the reader, that a
picture was withheld** (ADR-025 D8). No sentence in the prompt, no caveat on
the answer, no badge, no announcement. The images are still listed as
`kind: 'image'` sources with their thumbnails, so the evidence the model could
not read is one click away for the person who can.

That is deliberate — a per-answer "the assistant could not see the diagram"
would recur on every answer on such a deployment — and it is why the copy
beside the knob says so: Settings is the only place this fact is ever stated.

### Which pictures, and how many

Selection is **round-robin across pages**: every page contributes its best
image before any page contributes a second, ordered within each round by the
image's own similarity. A page carrying three near-identical screenshots
therefore cannot take both slots at the default cap and hide the second page.

A picture is attached **once**, however many pages carry it. The intake
indexes images per page, so one diagram reused across five pages is five
candidates with byte-identical content — and therefore an identical embedding
and an identical similarity, which sorts them next to each other inside one
round. They are deduplicated on the bytes, and the extras are counted under
`skipped.duplicate`.

Three ceilings bound it, and they are different numbers for different costs:

| | bounds | value |
|---|---|---|
| `rag_answer_max_images` | how many pictures the MODEL is shown | 0–8, default 2 |
| `MAX_IMAGE_SOURCES` | how many source chips the READER gets | 4, fixed |
| `RETRIEVED_IMAGES_BYTE_BUDGET` | base64 in one chat request | ~6.7 MB, fixed |

**The first two can diverge, and nothing on the answer says so** (D8 forbids
it). Above a cap of 4 the model **can be** shown a picture the reader gets no
chip for — ADR-025 D8b's wording, and the accurate one: it takes more than four
usable candidates to reach, so a cap of 8 over a corpus that offers two diverges
from nothing. It can also happen below 4, because the source list
is a flat best-first sort across pages while the attachments are picked
round-robin, so a round-robin slot can land on a page the flat sort has
already filled past. The page is still cited either way — what is missing is
the chip for that particular picture. At the default cap of 2 it cannot
happen. If the reader seeing every attached picture matters more to you than
breadth, keep the cap at 4 or below.

The byte budget is a **constant, not a knob**. A count is something an
operator can reason about; a byte ceiling depends on what the corpus happens
to hold, and the symptom of a wrong one is a provider timing out on a request
whose size nobody can see. It exists because this path bypasses the LLM
queue's own sizing by design — the queue counts requests, not bytes — so a cap
of 8 against a 5 MB intake ceiling would otherwise admit ~55 MB of base64 into
a single prompt. The concurrency in front of it is the **SSE stream cap**
(`admin_settings.llm_max_concurrent_streams_per_user`, hard default 3,
raisable to 20), not `LLM_CONCURRENCY` — the pick runs on the request path,
above the LLM queue entirely.

Its value is *derived*: the base64 length of one `MAX_IMAGE_BYTES` image, so
the largest picture the intake will admit is always attachable and the two
numbers cannot drift. Reaching the budget skips that picture, counts it and
keeps going — a smaller one further down the list still gets attached — and
the answer runs either way.

### The one refusal it adds

If **every** returned row is a page the image leg reached that has no indexed
text at all — so its context is the page TITLE — **and** not one picture was
attached, `/llm/ask` refuses with `refusalReason: 'image_only_context'` and
runs no completion. The prompt would otherwise be a list of titles and a
question.

It stands down whenever the turn has other grounding (an attached document, a
sub-page tree, fetched URLs, web results, the user's own image, a substantive
prior turn), and it never fires on a mixed set — one real text row is
grounding. The pictures ride beneath it as the closest matches.

This **supersedes** P3's "an image-only hit set never refuses". That rule was
justified as thin-evidence-not-absent-evidence *because P4 was going to show
the model the picture*; where P4 does, the turn answers exactly as P3 said,
and where it cannot, there is no evidence in the request at all. The remedy is
an operator one: assign a vision-capable chat model, or raise the cap off 0 —
or, where the pick ran and refused every candidate, fix what the `skipped`
counters below name.

### How to tell it ran

**Logs.** One `info` per answer where the pick did anything at all — attached
a picture, or refused one:

```
#1115 P4: retrieved-image pick
  { attached: 2, bytes: 214_355, cap: 2,
    skipped: { missing: 0, invalid: 1, overBudget: 0, duplicate: 0 } }
```

`attached: 0` with a non-zero `skipped` is the state to look for, and it is
the reason this line fires on a request that sent nothing: D8 forbids any
user-visible signal and the audit fields are absent when nothing was sent, so
the log is the only place it shows up.

`skipped.invalid` is the interesting counter, and it names one thing: **the
bytes on disk are no longer the bytes that were indexed.** The intake applies
the identical gate before it writes a row — same sniff, same `MAX_IMAGE_BYTES`,
same `MAX_IMAGE_DIMENSION`, over bytes read through the same store (§5) — so a
picture the leg can rank has already passed it once. Seeing it refused here is
the tell that the attachment was replaced since the last scan (or, rarely, that
an upgrade moved one of those ceilings under an index built before it). The
remedy is a re-read: **Process now**, or **Re-scan all** if it is not just the
one page, on the Embeddings tab.

One of those ceilings is checked from the file's **size on disk, before the
bytes are read** — a picture that has grown past `MAX_IMAGE_BYTES` since it was
indexed is refused with one `stat` rather than loaded whole and then thrown
away. It counts as `invalid` like the rest. The check fails open: a size that
cannot be established is treated as unknown and the read goes ahead, still
bounded by the gate above.

`missing` means the bytes are not in the store the reference names
(deleted, or never downloaded — a lazy fetch is the recovery path, §5),
`overBudget` that the request was already full, and `duplicate` that the same
picture had already been attached from another page.

**Audit (EE).** `llm_audit_log` rows for `action: 'ask'` carry
`retrievedImageCount` and `retrievedImageBytes` — counts and raw byte totals of
what was **sent**, absent entirely when the answer was text-only. Neither
carries a filename, a page id or any image data; base64 never reaches the audit
payload, because the per-message lengths are computed after image parts are
dropped.

**By hand.** Ask a question that only a picture answers on a page with no
prose. With the gate open the answer describes the picture; with it shut the
answer is about the title. The refusal above is the sharpest signal of all —
if you see it, condition (1), (3) or (4) is the one that failed, and the log
separates them. Grep `#1115 P4` — the prefix, not the pick message — because
there are three shapes, not two:

| what you see | what it means |
|---|---|
| a `retrieved-image pick` line with a non-zero `skipped` counter | the pick ran and could not use anything it found (condition 4) |
| `could not resolve page identities for retrieved images` at `warn`, and no pick line | the batched `pages` lookup failed, so the pick soft-failed before it read a byte — the cap and the vision verdict are both fine |
| no `#1115 P4` line at all | the pick never ran: the cap is 0, or the model cannot see images (conditions 1 and 3) |

### What it does not do

- **No blocking probe.** The stored verdict is returned immediately. When it
  is missing, stale (30 days) or `null` outside the 5-minute cooldown,
  `getVisionCapability` schedules a refresh probe in the background and answers
  from the row it has — so asking questions on a deployment whose chat model
  was never probed *can* be what establishes the verdict, but it never adds
  latency to the answer and never changes what that answer was sent.
- **No resize, no re-encode, no download.** Bytes come off disk exactly as the
  intake stored them (ADR-025 D10).
- **No effect on grounding.** A retrieved image never averts or softens a
  `weak_match` refusal — the pick step runs *after* the confidence decision,
  so a refused turn reads no image bytes at all.
- **No decoration.** The answer looks like any other answer.

## 8. Changing the model (or the provider)

**It empties the image index and re-scans. There is no shadow swap here, and
that is deliberate**: the image leg is simply *off* while its index is empty, so
text search is never degraded, and images are cheap to redo.

A rebuild is triggered by the probed **width** changing **or** by the assigned
`provider:model@baseUrl#dims` changing — the second because two different models
at the same width are two incompatible spaces that a column type cannot
distinguish, the base URL is in there because a provider row's endpoint can move
without its id changing (§2), and `#dims` is the requested MRL truncation width,
which is what every image-side call sends.

It is triggered by **saving** the assignment and by **Re-check** — those are the
only two moments the app looks. Editing a provider row alone changes nothing
until one of them runs.

What happens, in one bounded-lock transaction:

1. drop the HNSW index;
2. `TRUNCATE page_image_embeddings`;
3. retype `embedding` to the new tier;
4. rebuild the index (or skip it, above 4000, with a warning in the log and a
   note on the settings row);
5. record `admin_settings.image_embedding_dimensions` and
   `…_index_model`;
6. mark every non-folder page `image_embedding_dirty`.

`pages.embedding_dirty` is **not** touched — text retrieval does not move when
the image model does. That is the whole reason migration 093 gave the two flags
separate columns.

**Unassigning** the use case turns the leg off and destroys nothing: the column
type and the index survive, so re-assigning the same pair costs nothing.

## 9. Verifying by hand

```bash
curl -s "$BASE_URL/embeddings" -H 'Content-Type: application/json' -d '{
  "model": "Qwen/Qwen3-VL-Embedding-2B",
  "messages": [
    {"role": "system",    "content": [{"type": "text", "text": "Represent the user'\''s input."}]},
    {"role": "user",      "content": [{"type": "text", "text": "a diagram of a network"}]},
    {"role": "assistant", "content": [{"type": "text", "text": ""}]}
  ],
  "encoding_format": "float",
  "continue_final_message": true,
  "add_special_tokens": true
}' | jq '.data[0].embedding | length'
```

A 400/422 here is the `shape_rejected` case; a 5xx is `provider_error`. A number
is the width the probe would record.

Add `"dimensions": 2048` to that body to reproduce what Compendiq sends when a
truncation width is configured. The same number back means the override is in
place; the native width back is the `dimensions_ignored` case; a 400 naming the
parameter means the server was started without `--hf-overrides` (§2).

If you drop the trailing `assistant` turn or `continue_final_message`, this call
**still succeeds** and still returns a plausible vector — of a different, worse
space. That is why the client's request body is asserted byte-for-byte in
`vl-embedding-client.test.ts` rather than left to a smoke test.

### Measuring it, rather than verifying it (#1115 P5b)

A 200 with a vector of the right width proves the endpoint is wired up. It says
nothing about whether the leg **helps**, and that is a separate exercise with
its own corpus and its own harness: the `--images` axis on the retrieval eval.
It seeds a German image corpus through this exact intake — bytes on disk,
`embedPageImages`, `page_image_embeddings` — and then runs every fixture query
twice on one seeded database, image leg off and on, paired, and decides with
McNemar exact. It also reports image embed throughput (images/s) and each arm's
query cost, which are the two operational numbers §5 and §6 above tell you to
measure before scheduling a backfill or raising `PG_VECTOR_POOL_MAX`. Read the
right half of each: the seeder embeds one page after another with **no pause**,
so `throughputImagesPerSec` is the endpoint's rate and
`backfillThroughputImagesPerSec` is the one this section's backfill pays (the
worker sleeps 200 ms after every page, which the seeder does not). Likewise the
leg's query cost is `queryCostMs.deltaPaired` — the per-query `on - off` — and
not the difference between the two per-arm percentiles, which are independent
summaries of possibly different queries.

Recipe, environment and how to read the report: **`docs/runbooks/retrieval-eval.md`,
"Image axis (`--images`)"**. It is not in CI (no vision-language model is
runnable there), and a run through the local shim is plumbing-grade — the
numbers that decide the model, the MRL width and the default are measured on
the production stack (ADR-025 D11).
