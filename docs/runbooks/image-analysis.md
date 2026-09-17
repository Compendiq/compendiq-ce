# Runbook — image analysis (ADR-027)

Operating the `image_analysis` use case: which model can serve it, how to
assign and probe it, what gets analyzed, how the worker runs, what the operator
card reports, what the chat model is shown, and what changing the model costs.

**One design.** A generative vision model describes each referenced raster at
ingestion into bounded, versioned text; `embedPage` embeds that text with the
ordinary text embedder as provenance-marked `page_embeddings` rows, which the
existing semantic and lexical legs retrieve like any other chunk. There is no
image vector space, no third RRF leg and no second query embed, and a
**text-only** chat model can cite the picture.

> **The legacy image-embedding leg is RETIRED** (#1618 stage 2, migration 118).
> ADR-025's `image_embedding` use case, `page_image_embeddings`,
> `pages.image_embedding_dirty`, `image-leg-search.ts`, the MRL truncation
> width, the `rag_image_leg_enabled` toggle, the `image_only_context` refusal
> and `degraded_reason = 'image_leg_unavailable'` are all gone. The basis was
> **"Remove it, nobody was using it in production."** — unused in production
> plus maintenance burden, and explicitly **not** a measurement (ADR-027 A-5).
> The cutover and its rollback procedure are
> `docs/runbooks/image-embedding-retirement.md`.

**What this does NOT do:** it never shows a picture to a chat model that has
not separately probed vision-capable, and it says nothing when it cannot — a
text-only answer is unqualified, with the images still listed as sources (§6 is
where that gate is written down). There is no SVG rasterisation, no server-side
downscale and no OCR (ADR-025 D10), and a model server upgraded in place behind
an unchanged base URL is invisible to every signal in the code (§7).

Design of record: ADR-027 in `docs/ARCHITECTURE-DECISIONS.md`.

---

## 0. What this runbook covers

Eight sections, in the order you meet them. Every `§n` reference in this file
points into this list.

| § | | Read it when |
|---|---|---|
| [1](#1-what-the-model-has-to-be) | What the model has to be | Before choosing a checkpoint — "OpenAI-compatible" is not enough |
| [2](#2-assigning-and-probing) | Assigning and probing | Wiring the model up in Settings, or a probe refused your assignment |
| [3](#3-intake--what-gets-analyzed-and-what-does-not) | Intake | Nothing is being analyzed, or a row count looks lower than the picture count |
| [4](#4-the-worker) | The worker | A batch stopped, backed off, or is reporting a reason you do not recognise |
| [5](#5-the-image-analysis-card-and-its-routes) | The card and its routes | Reading the status panel, or driving it from a script |
| [6](#6-answer-path--showing-the-model-the-pictures-1115-p4) | Answer path | Asking why the assistant did not describe a diagram it cited |
| [7](#7-changing-the-model-or-the-provider) | Changing the model | Swapping checkpoints, moving the endpoint, or upgrading a server in place |
| [8](#8-verifying-by-hand) | Verifying by hand | Proving the whole chain end to end |

---

## 1. What the model has to be

A **generative** vision-language model on an ordinary
`POST {baseUrl}/chat/completions`, reached through the same
`openai-compatible-client.ts` every other use case uses. No pooling extension,
no chat-embeddings wire shape, no separate client: this is the change ADR-027
made, and it is why the endpoint requirement collapsed from "a server that
serves vLLM's chat-embeddings extension" to "a server that serves images in a
chat message".

What it must do:

- accept an `image_url` content part with a `data:` URI (the bytes never leave
  the deployment);
- answer within the deployment's ordinary LLM timeouts;
- honour `max_tokens` — the ceiling is **Max output tokens** (Settings → AI
  Models, default 8192, `[4096, 16384]`), and a model that runs past it has its
  row recorded `truncated:<ceiling>` rather than stored half-parsed (ADR-027
  D8).

Anything vision-capable on llama.cpp, Ollama, LM Studio, vLLM or a hosted API
qualifies. The tri-state capability verdict (§2) is what decides, not the
server's name.

---

## 2. Assigning and probing

Settings → AI Models → LLM providers → the **Image analysis (vision)** row.

1. Pick a provider (and a model, or leave it to the provider's default model).
2. Save. The save **blocks on a probe** and **refuses the assignment** if the
   pair is not vision-capable — a use case that cannot read a picture must not
   be assignable, because the failure it prevents is silent: a text-only model
   answers the request with a fluent description of nothing.

It never inherits. Unassigned means the worker **pauses** — it still sweeps and
reconciles every cadence and reports `reason: 'unassigned'` — rather than
degrading retrieval, because the derived chunks already written stay
retrievable (ADR-027 D7).

On success the row is written with the **resolved model pinned into it**, even
if you left the model on "Inherit provider's model": the probe verified exactly
one model, and an inherited one would silently follow the provider's
`default_model` the next time somebody edits it. So the model dropdown will show
that model after the save. That is not a UI glitch — it is the use case refusing
to name a model nobody probed.

### The retained identity

`admin_settings.image_analysis_identity` records the pair the corpus was
analyzed under, as `provider:model@baseUrl` hashed into
`page_image_analyses.identity_hash` (ADR-027 D5/D7). Three things read it:

- the **validity predicate** — an `analyzed` row whose `identity_hash`,
  `prompt_version` or `schema_version` no longer matches is invalid, and the
  next sweep re-pends it **with its payload kept**, so an unchanged picture
  comes back `reused` at no vision call;
- the **D13 gate** — the worker analyzes nothing while the resolved assignment
  and the retained identity disagree (`identity_drift`), rather than writing
  rows under two models into one corpus;
- the **card** — `identityMatchesAssignment` reports that gate (§5).

Adopting a new identity is what **Re-check** and a re-save of the assignment
do, and both disclose the re-analysis scope before they fire (§7).

### The capability verdict

`llm_model_capabilities` carries the tri-state: `true` (probed and accepted),
`false` (probed and refused), `null` (never established). Only `true` opens the
gate, here and on the answer path (§6). It is **not** in the rollback dump set,
so a restore never rewinds it.

---

## 3. Intake — what gets analyzed, and what does not

Assigning the use case (§2) makes analysis *possible*; this section is what
fills `page_image_analyses`. The unit of work is a page: the reconcile
enumerates the images that page's stored body references, hashes their bytes
and upserts a row per `(source, key)`, deleting the rows for the ones it no
longer references.

### What schedules a page

**`pages.image_analysis_dirty` is the queue** (ADR-027 D6.2), and nothing else
is walked. It is raised by:

| Event | Where |
|---|---|
| A page is created or updated by sync | the sync upsert, beside `embedding_dirty`, unconditionally — it is rewriting the body anyway |
| A page's body changes on a conflict-policy update | gated on `body_html` alone — `body_text` cannot move an `<img>` |
| A page is created **in the app** | both `INSERT INTO pages` arms in `pages-crud.ts`, unconditionally for a non-folder page (there is no previous body to diff against). The Confluence arm's `ON CONFLICT … DO UPDATE` re-writes `body_html` on a row that may already carry analysis rows |
| A page is edited **in the app** | all four `body_html` writers in `pages-crud.ts` — the editor save on a local page, the app-side Confluence push, publish-draft and the bulk refresh — each gated on `body_html`. With the two below, this is the only trigger for an image that was **deleted**: that writes no attachment at all |
| A version is **restored** | `restoreVersion` (`version-tracker.ts`), gated on `body_html`. Swapping the body for an older one is exactly how an `<img>` comes back or goes, and neither source self-heals: a standalone page is never touched by sync, and a Confluence restore is pushed upstream and the returned version written back, so the next `syncPage` takes the version-unchanged branch |
| An AI improvement is **applied** | both branches of `POST /llm/improvements/apply`, gated on `body_html`. `protectMedia`/`restoreMedia` and #723's drop-guard keep the `img` set intact across the markdown round trip, so in practice every row is reused by content hash — the flag is raised anyway rather than resting on an invariant that lives in another module |
| A new or changed attachment is downloaded under an **unchanged** page version | `syncImageAttachments` / `syncDrawioAttachments`, on a real download only |
| An image is fetched lazily on a cache miss while viewing a page | `fetchAndCachePageImage` — the recovery path for a `missing` skip |
| An image is pasted, or imported from an external URL | `writeAttachmentCache` |
| A draw.io diagram is saved on a local page | `putLocalAttachment` |
| A page is relocated between Confluence and local | both directions, unconditionally — the move rewrites every `<img src>` |
| A page's cached attachments are cleared (a new version, an unsync) | `cleanPageAttachments` — this re-queues the page so the next cycle **re-reads** it; it does not shrink the corpus (see below) |
| **Re-analyze all** | the Embeddings-tab action, and the model-change rebuild in §7 |

Every one of those writers goes through **one** writer module,
`core/services/image-analysis-dirty.ts`, or raises the flag inline in the
`UPDATE` it already owns. A writer that forgets it hands the worker a backfill
that never starts — #1619 lost a run to exactly that, reporting 0/187 valid
analyses at its deadline.

The worker runs on its **own repeatable job**, off the sync cadence — sync does
*not* kick it (§4).

### What gets analyzed

Everything the page's `body_html` points at with one of the two attachment
prefixes, deduped by `(source, key)`:

- `<img src="/api/attachments/<key>/<file>">` → the Confluence cache tree
- `<img src="/api/local-attachments/<page id>/<file>">` → the local store

**The store follows the URL prefix, never `confluence_id IS NULL`.** A relocated
page has no `confluence_id` and its bytes in the *local* store, and a page
pasted into after that move carries both prefixes at once.

An image whose bytes are unchanged since its last analysis — same content hash,
same retained identity, same prompt and schema version — **keeps its payload
and costs no vision call at all**. That is what makes a sweep affordable, and it
is why the model-change rebuild in §7 is not a corpus-wide bill by default.

### What removes a row

The reconcile deletes the rows of this page whose `(source, key)` the page's
**stored body no longer references**. That is the only rule.

A file that has gone missing does **not** lose its row: it becomes
`skipped (missing)` — out of the work window, no attempt charged, no call spent
— and returns to `pending` through the reconcile when a writer (lazy re-fetch,
upload, sync) raises the page flag with the bytes back. `resolveAttachmentBytes`
answers `null` only for `ENOENT`, so a read *failure* is told apart from an
absent file and retried rather than recorded (§4).

So an unsync, or any other clearing of cached attachment files, does **not**
shrink the corpus. Rows go away when the body stops pointing at the image, when
the knobs below exclude it, or when the `pages` row itself is purged
(`ON DELETE CASCADE`).

One more remover exists since #1349, and it cannot collide with the rule above:
the **attachment orphan sweep** (Settings → Knowledge → Spaces & Sync → Sync
schedule, the Attachment storage card; `docs/ADMIN-GUIDE.md`, "Attachment
Storage & Orphan Sweep") deletes the `page_image_analyses` rows of files it
removes from disk — a safety net, since a file it removes is by definition
referenced by no body anywhere, while a `missing` row's file IS still referenced
and therefore sits in the sweep's keep-set and never becomes a candidate. The
sweep is also what bounds the attachment tree this corpus is built over.

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

### The two knobs

Both live in `admin_settings`, on Settings → AI Models → Retrieval:

| Key | Default | What it does |
|---|---|---|
| `rag_images_per_page_max` | `20` | Images analyzed per page. A cost bound: each one is a vision call through the shared LLM queue. **`0` is not a value** — analysis is switched off by unassigning the use case |
| `rag_image_index_external` | on | Whether images a body pulled from an external URL are analyzed |

---

## 4. The worker

Driven by ONE queue, `image-analysis` (BullMQ concurrency 1, repeating on the
sync cadence; the interval worker when BullMQ is off) — **sync does not kick
it**, so a cycle is one lease contest, not one per synced user. The price is
latency: a page a sync writes waits up to one sync interval for its first
reconcile, two when the two repeats fire together and the sync runs on for
minutes.

The batch runs under the lease `worker:lock:image-analysis` (600 s, renewed
every 60 s, checked before every write, including the last-run line: a batch
that lost its lease writes no `image_analysis_last_run`, its partial counts are
the failed job's message). Every batch is three steps, and only the last needs a
model:

1. **Sweep.** `analyzed` rows that fail the validity predicate (retained
   identity, prompt/schema version) become `pending` with their payload kept;
   `pending` rows whose kept payload passes it flip back (`reused`, no call);
   stale `failed` / `failed_terminal` rows return to `failed, attempts 0, due
   now`; `truncated:<ceiling>` rows re-open when **Max output tokens** is
   raised above the recorded ceiling.
2. **Reconcile** every `pages.image_analysis_dirty` page: claim the flag
   first, enumerate `body_html`, hash the bytes through the same intake §3
   describes, upsert `page_image_analyses`. The page is bumped
   (`image_analysis_revision`, `embedding_dirty`) only when its VALID derived
   set changed — an `analyzed` row deleted, re-pended under new bytes or
   skipped by policy — so `embedPage` drops stale derived chunks; new
   `pending`/`skipped` rows bump nothing. In particular the first batch on an
   upgraded instance drains 116's backlog seed (every image-referencing page)
   into `pending` rows **without re-embedding a single page**; pages re-embed
   as analyses complete.
3. **Analyze** up to `image_analysis_batch_size` images (Settings → AI Models
   → Workers, default 50, [1, 500]) — only when `image_analysis` is assigned,
   its vision verdict is `true` and the resolved identity equals the retained
   one. Unassigned, `capability` and `identity_drift` all skip this step and
   the batch result says which (`reason`). A work row whose file is ABSENT
   at call time (`ENOENT`: attachment cleaned while its reference stayed in
   the body, cache evicted) becomes `skipped (missing)` — out of the work
   window, no attempt charged, no call spent — and returns to `pending`
   through the reconcile when a writer (lazy re-fetch, upload, sync) raises
   the page flag with the bytes back; bytes that read but hash differently
   re-raise the flag for the reconcile to re-pend. A file that is there but
   cannot be read (`EACCES` after a restore, `EIO`, a network volume
   blinking) is NOT missing: the row goes `failed (unavailable:bytes)` with
   an attempt charged and backoff, never terminal, and is re-read when due.
   At reconcile time the page's OTHER images are still written and analyzed;
   only the unreadable reference is left, the page stays dirty for the next
   cycle, and it counts in the last run's `pagesFailed` — a non-zero
   `pagesFailed` beside a non-zero `processed` is exactly this condition. Fix
   the permissions or the mount; nothing needs re-uploading.

Failures back off `LEAST(15 min × 2^LEAST(attempts, 7), 24 h)` — the exponent is
clamped so a class that never goes terminal cannot grow one past what an
`interval` can hold; a deterministic class (malformed, empty, refused,
truncated, rejected) at 5 attempts goes `failed_terminal`; `unavailable` never
does. A 4xx outside 400/413/415/422 ends the batch (`provider_status`) and
re-probes the pair; three identical `rejected` statuses first end it too
(`uniform_rejection`, the rows rewritten `unavailable:<status>`, never terminal)
— serve the model with a larger context or lower **Max output tokens**, then
**Process now**. The last batch result is in
`admin_settings.image_analysis_last_run`; the operator card and its three
actions are §5. With `image_analysis` unassigned the worker still sweeps and
reconciles every cadence and returns `reason: 'unassigned'` — a pause, not a
purge.

Derived chunks are ordinary `page_embeddings` rows after every authored index
with `metadata.source = 'image_analysis'`; they are excluded from both page
averages, indexed lexically through `page_embeddings.chunk_tsv` (rebuilt with
`pages.tsv` on a language change), and never assembled as siblings of authored
text.

### Migration 116's cost

It backfills `page_embeddings.chunk_tsv` in one transaction: a rewrite of every
chunk row, the NOT NULL scan and a non-concurrent GIN build, under a lock that
holds `embedPage` writes until COMMIT. Expect roughly migration 049's page
rebuild × chunks-per-page; the old tuple versions stay on disk until autovacuum
gets there, so on a large corpus run `VACUUM (ANALYZE) page_embeddings`
afterwards. The same rewrite runs — same transaction, same lock — when **Keyword
index language** is saved: the PUT is slower than it was by the chunk table, and
the settings copy says so.

### Migration 117's index, and why the first corpus-wide batch used to be slow

(#1617 review r1.) 117 adds `page_embeddings_derived_chunk_tsv_idx` —
`gin (chunk_tsv) WITH (fastupdate = off) WHERE metadata->>'source' =
'image_analysis'` — which is the index the keyword leg's derived arm uses.
Before it, the arm shared 116's FULL GIN, and a batch of derived writes puts
that index into a PENDING LIST state
(`SELECT pending_pages FROM pgstatginindex('page_embeddings_chunk_tsv_idx')`)
that re-prices the plan: measured on a 4,001-page corpus at 429 pending pages,
the arm dropped the GIN for `page_embeddings_derived_idx` plus a `chunk_tsv`
filter over every derived chunk — 8.9–10.4 ms for a one-row match against
0.021 ms, on every keyword query and every `/llm/ask` for as long as the batch
keeps the list full. Re-measured in review r2 at ~360k derived chunks it is
worse than that: 7.8–9.0 ms on the full `keywordSearch` as a STEADY state, plus
an 18–74 ms tail whenever the pending list crosses the planner's flip point.
`fastupdate = off` is what keeps 117 out of that state. A plain partial GIN is
already a 5–10× win (0.90–2.00 ms on the full statement), but it pends like the
full one, so its cost tracks the pending list (0.47/0.89/1.08 ms at
233/465/415 pending pages) and it still flipped to the filter plan once in
twelve write steps; only the reloption makes the cost independent of the burst.
It is paid at ~38 µs per derived chunk by the EMBEDDING worker's inserts
(`embedPage`, which the analysis worker triggers by raising `embedding_dirty`),
and nothing else writes that index. If you are reading an old plan or a pre-117
deployment: `VACUUM (ANALYZE) page_embeddings` drains the pending list and
restores the fast plan immediately.

---

## 5. The Image analysis card and its routes

Settings → AI Models → **Embeddings** carries the **Image analysis** card.

Everything on it comes from one route, `GET /api/admin/embedding/image-analysis`
(admin only), which adds no SQL: it composes the corpus counts, the retained
identity, the live assignment, the last batch and the worker lock.

- `rows` keeps **`analyzed`** (valid under the retained identity and the
  running constants) apart from **`stale`** (analyzed on disk, rejected by
  every reader until the next sweep re-pends it). One number would claim
  coverage the corpus does not have.
- `identityMatchesAssignment` is D13's third gate, reported: `false` means the
  worker will analyze nothing until the assignment PUT or **Re-check** adopts
  the assigned pair. `null` means nothing is assigned — a pause, not a
  mismatch.
- `pagesAwaitingEmbed` is "analysis complete, text embedding still pending",
  which costs no vision call; `dirtyPages` is "queued for an image re-read".
  Neither is partial analysis.
- `lastRun` carries the three steps' counters plus a stop's `reason` and
  `httpStatus`, so "0 analyzed" on a settled corpus is distinguishable from an
  endpoint that refused every call.

Three actions, all admin-only POSTs, all kicking one bounded batch **detached**
and reporting `started` / `alreadyRunning` from the lock:

| Route | Does |
|---|---|
| `…/image-analysis/process` | Kicks a batch. Answers `alreadyRunning` when the lease is held — it never claims a second batch started. |
| `…/image-analysis/retry-failed` | Every `failed` and `failed_terminal` row → `failed, attempts 0, due now`. The only thing that moves a terminal row. Idempotent. |
| `…/image-analysis/reanalyze-all` | Every `analyzed`, `failed` and `failed_terminal` row → `pending, payload NULL`, pages bumped. One vision call per row on the next runs. Refused **409** while a corpus text re-embed or a #1116 shadow migration holds the one-active-run slot. The card discloses the row count in a confirm dialog before it fires. |

A status read that FAILS says so in the destructive treatment, states that the
assignment and the stored analyses are untouched, and **leaves all three
actions available** — they are the remedy, so a failed GET must not withhold
them. It never renders as "not assigned": that would send an operator whose
corpus is fine off to assign a model.

---

## 6. Answer path — showing the model the pictures (#1115 P4)

A derived chunk makes a picture *retrievable* and puts it on the wire as a
source. This section is what puts it in the request: when the pages that ground
an answer carry derived provenance and the chat model can see images, up to
`rag_answer_max_images` of those pictures are attached to the user turn as
`image_url` parts.

This optional attachment is ADR-025 **D8/D8a/D8b**, which **survive** the
retirement (ADR-027 D11) — the chat attachment is not the leg. Its candidate set
is now D11's derived provenance and nothing else: a row's
`derived.attachmentKey`, never a whole-set fallback.

### The gate

Four conditions, all of which must hold. They are checked in this order because
each makes the next cheaper — on a deployment with no analyses the whole step is
one cached settings read:

1. **`rag_answer_max_images` > 0.** Settings → AI Models → Retrieval →
   *Images shown to the model*. Default **2**, range 0–8. Unlike the intake cap
   beside it, **0 is a legal value**: it is the off switch, and it subtracts
   nothing durable — the analyses still fill, the derived chunks still rank, and
   the pictures still reach the reader as sources.
2. **Some returned page carries derived provenance.** False on every deployment
   with no `image_analysis` assignment, and on most questions where there is
   one.
3. **The resolved `chat` pair has probed vision-capable.** The stored #1154
   verdict, read from `llm_model_capabilities` — never a *blocking* probe,
   which would put an LLM round-trip on the answer path. (A missing or stale
   row does schedule one in the background; see "What it does not do" below.)
   The tri-state is not collapsed: `false` (probed and refused) and `null`
   (never established) both mean text-only here, and only `true` admits bytes.
   If the verdict is wrong, fix it with **Re-check** on the chat row (#1184),
   not here.
4. **The bytes are usable.** Each candidate is read from the attachment store
   and put through the same gate a user-attached image passes — format
   sniffed from the bytes, `MAX_IMAGE_BYTES` (5 MB), `MAX_IMAGE_DIMENSION`
   (4096). Anything else is skipped and counted.

### What a text-only model sees

**The analysis.** That is the point of ADR-027: the picture's description is
ordinary retrieved text, so a text-only model answers from it and cites the
image. Only the *bytes* are withheld, and **nothing tells the model, or the
reader, that they were** (ADR-025 D8). No sentence in the prompt, no caveat on
the answer, no badge, no announcement. The images are still listed as
`kind: 'image'` sources with their thumbnails, so the picture the model did not
see is one click away for the person who can.

That is deliberate — a per-answer "the assistant could not see the diagram"
would recur on every answer on such a deployment — and it is why the copy
beside the knob says so: Settings is the only place this fact is ever stated.

### Which pictures, and how many

Selection is **round-robin across pages**: every page contributes its best
image before any page contributes a second, ordered within each round by the
row's own rank. A page carrying three near-identical screenshots therefore
cannot take both slots at the default cap and hide the second page.

A picture is attached **once**, however many pages carry it. Analyses are per
page, so one diagram reused across five pages is five candidates with
byte-identical content. They are deduplicated on the bytes, and the extras are
counted under `skipped.duplicate`.

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
from nothing. It can also happen below 4, because the source list is a flat
best-first sort across pages while the attachments are picked round-robin, so a
round-robin slot can land on a page the flat sort has already filled past. The
page is still cited either way — what is missing is the chip for that particular
picture. At the default cap of 2 it cannot happen. If the reader seeing every
attached picture matters more to you than breadth, keep the cap at 4 or below.

The byte budget is a **constant, not a knob**. A count is something an operator
can reason about; a byte ceiling depends on what the corpus happens to hold, and
the symptom of a wrong one is a provider timing out on a request whose size
nobody can see. It exists because this path bypasses the LLM queue's own sizing
by design — the queue counts requests, not bytes — so a cap of 8 against a 5 MB
intake ceiling would otherwise admit ~55 MB of base64 into a single prompt. The
concurrency in front of it is the **SSE stream cap**
(`admin_settings.llm_max_concurrent_streams_per_user`, hard default 3, raisable
to 20), not `LLM_CONCURRENCY` — the pick runs on the request path, above the LLM
queue entirely.

Its value is *derived*: the base64 length of one `MAX_IMAGE_BYTES` image, so the
largest picture the intake will admit is always attachable and the two numbers
cannot drift. Reaching the budget skips that picture, counts it and keeps going
— a smaller one further down the list still gets attached — and the answer runs
either way.

### It adds no refusal

`image_only_context` is **gone** (#1618 stage 2). It fired when every returned
row was a page the legacy leg had reached that carried no indexed text at all,
so the prompt would have been a list of titles and a question. The replacement
cannot produce that set: a page with a valid analysis carries a real
`page_embeddings` chunk and is reached by the TEXT legs, and a page without one
is reached by no leg. A set with no derived provenance is now an ordinary
text-only answer, judged by the confidence gate alone.

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
bytes on disk are no longer the bytes that were analyzed.** The intake applies
the identical gate before it writes a row — same sniff, same `MAX_IMAGE_BYTES`,
same `MAX_IMAGE_DIMENSION`, over bytes read through the same store (§3) — so a
picture a derived chunk names has already passed it once. Seeing it refused here
is the tell that the attachment was replaced since the last reconcile (or,
rarely, that an upgrade moved one of those ceilings under a corpus analyzed
before it). The remedy is a re-read: **Process now**, or **Re-analyze all** if
it is not just the one page, on the Embeddings tab.

One of those ceilings is checked from the file's **size on disk, before the
bytes are read** — a picture that has grown past `MAX_IMAGE_BYTES` since it was
analyzed is refused with one `stat` rather than loaded whole and then thrown
away. It counts as `invalid` like the rest. The check fails open: a size that
cannot be established is treated as unknown and the read goes ahead, still
bounded by the gate above.

`missing` means the bytes are not in the store the reference names (deleted, or
never downloaded — a lazy fetch is the recovery path, §3), `overBudget` that the
request was already full, and `duplicate` that the same picture had already been
attached from another page.

**Audit (EE).** `llm_audit_log` rows for `action: 'ask'` carry
`retrievedImageCount` and `retrievedImageBytes` — counts and raw byte totals of
what was **sent**, absent entirely when the answer was text-only. Neither
carries a filename, a page id or any image data; base64 never reaches the audit
payload, because the per-message lengths are computed after image parts are
dropped.

**By hand.** Ask a question that only a picture answers on a page with no prose.
With the analysis in place the answer describes the picture whether or not the
model can see pixels, and the citation carries the attachment provenance. Grep
`#1115 P4` — the prefix, not the pick message — because there are three shapes,
not two:

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

---

## 7. Changing the model (or the provider)

**It re-pends the corpus, and it keeps the payloads.** There is nothing to
truncate and no column to retype: the descriptions are text in
`page_image_analyses` and text chunks in `page_embeddings`, so a model change is
a validity event, not a rebuild.

A re-pend is triggered by the retained identity changing — the resolved
`provider:model@baseUrl`, with the base URL in there because a provider row's
endpoint can move without its id changing. It is triggered by **saving** the
assignment and by **Re-check**; those are the only two moments the app looks.
Editing a provider row alone changes nothing until one of them runs.

What happens:

1. the new identity is written to `admin_settings.image_analysis_identity`;
2. the next sweep re-pends every `analyzed` row whose `identity_hash` no longer
   matches, **payload kept**;
3. rows whose bytes are unchanged come back `reused` on the next batch — no
   vision call;
4. only rows whose bytes really changed cost a call.

The card discloses the scope before either control fires, and never quotes a
number it could not read.

`pages.embedding_dirty` is bumped only for pages whose VALID derived set
changed, so text retrieval does not move when the vision model does.

**Unassigning** the use case PAUSES analysis and destroys nothing: the rows, the
payloads and the derived chunks all survive, so re-assigning the same pair costs
nothing.

**A server upgraded in place behind an unchanged base URL is invisible** to
every signal in the code — the identity is `provider:model@baseUrl` and none of
the three moved. That one is a manual **Re-analyze all**.

---

## 8. Verifying by hand

```bash
curl -s "$BASE_URL/chat/completions" -H 'Content-Type: application/json' -d '{
  "model": "qwen2.5-vl-7b",
  "max_tokens": 256,
  "messages": [
    {"role": "user", "content": [
      {"type": "text", "text": "Describe this image in one sentence."},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,'"$(base64 < diagram.png | tr -d '\n')"'"}}
    ]}
  ]
}' | jq -r '.choices[0].message.content'
```

A description of the picture means the pair is usable and the probe in §2 will
accept it. A 400 naming the content part means the server does not take images
on this route; a fluent sentence that does not match the picture at all means
the model is not reading it, which is exactly what the probe refuses.

Then, end to end: put a page in the corpus whose only content is a diagram,
wait for one batch (or press **Process now**), and ask a question only the
diagram answers. The answer should describe it and cite the image — on a
text-only chat model too. If it does not:

```sql
-- Where is the row, and is it valid?
SELECT status, attempts, identity_hash IS NOT NULL AS has_identity,
       prompt_version, schema_version, failure_reason
  FROM page_image_analyses WHERE page_id = <id>;

-- Did the description reach the index?
SELECT count(*) FROM page_embeddings
 WHERE page_id = <id> AND metadata->>'source' = 'image_analysis';
```

`status = 'analyzed'` with no derived chunk means the page is waiting on the
text embedder (`pagesAwaitingEmbed` on the card); `pending` with a payload means
the next sweep will flip it `reused`; `failed` names its own reason.
