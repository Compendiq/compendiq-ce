# Runbook — the image index (#1115)

Operating the `image_embedding` leg: which server can serve it, how to start
one, how to assign and probe it, what fills the index, and what changing the
model costs.

**Scope as of P2.** The leg is *configurable*, *provable* and now *fills*:
assigning it types the `page_image_embeddings` column, builds its index and
queues every page, and a worker embeds each page's images into it (§5).
**No query touches the index yet (P3)** — nothing you can search for will find
an image, and the Embeddings-tab card says so on screen. Everything below is
preparation you can do, verify and monitor before that lands.

Design of record: ADR-025 in `docs/ARCHITECTURE-DECISIONS.md` and
`docs/superpowers/specs/2026-08-16-multimodal-image-retrieval-design.md`.

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
  and re-dirties every page — see §6.
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
changing the model — see §6.

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
the column type is the destructive rebuild in §6: the image index is emptied and
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
| **Re-scan all** | the Embeddings-tab action, and the model-change rebuild in §6 |

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
Re-scan cheap, and it is why the model-change rebuild in §6 is affordable.

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
rebuild in §6.

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
  guarded-DDL state §6 describes — the assignment saved and the `ALTER` did
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
  press after upgrading the model server in place (§6 — no signal in the app can
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

## 6. Changing the model (or the provider)

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

## 7. Verifying by hand

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
