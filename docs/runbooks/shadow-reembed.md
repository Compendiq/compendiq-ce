# Runbook — zero-downtime embedding model change (#1116)

The shadow re-embed replaces the destructive `POST /admin/embedding/reembed
{newDimensions}` path for model/dimension changes. Search serves the live
vectors throughout; the old model stays recoverable until the final cleanup.

## Lifecycle

| Step | Action | Reversible? | Search impact |
|---|---|---|---|
| 1. Start | Settings → AI → AI Models → change the embedding assignment → **Start zero-downtime re-embed** (or `POST /api/admin/embedding/shadow-migration {providerId, model}`) | Yes (Abort) | none |
| 2. Backfill | background job embeds every existing chunk with the new model into `embedding_next`; edited pages dual-write both models | Yes (Abort) | none (background embedding load only) |
| 3. Index build | HNSW indexes built on **both** shadow columns at the end of the backfill — unless the model's dimension exceeds 4000, which pgvector cannot index at all (the status card says so instead of claiming an index, and post-swap vector search scans sequentially) | Yes | none for reads; **writes to `page_embeddings` AND to `pages` queue for the build duration** (minutes) — the second index is on `pages`, so sync upserts, editor saves and embedding-status updates stall too |
| 4. Swap | **Swap to the new model** (`POST …/swap`) — one transaction of column/index renames under `lock_timeout 5s`, ≤5 attempts | Yes (Roll back) | sub-second on success. While a lock attempt waits behind a long reader, **new searches queue behind the pending exclusive lock** — each failed attempt can stall them up to 5s (≤5 attempts), so run the swap when long queries have drained |
| 5. Validate | run real searches; the quality gate is #1102's eval rig. **Then settle the confidence thresholds (#1114)**: if either is non-zero it is still the number tuned on the old model — read your own logged `rag.confidence` values on the new model and either re-tune it or press **Keep &lt;value&gt;** on the notice to record the number you already have against the new model. Until then the swap's warning stands in the log and the Retrieval tab shows an amber notice on that control — **unless that threshold was set before #1114 shipped or written with SQL**, in which case there is no recorded model to compare against and you get a muted "calibration unknown" line instead, whose **Record &lt;value&gt;** button records the number you have against the model now serving; on that instance the log warning is the signal | — | new model serving |
| — | *(automatic, in the background)* the swap and a post-swap rollback both rebuild `page_relationships.embedding_similarity` — the persisted derivative of `pages.page_avg_embedding` — and clear the graph cache. It runs **detached from the request**, because a whole-corpus recompute can outlast an edge proxy's read timeout and a failed-looking swap invites a rollback of a swap that worked | — | graph/related-pages serve the previous edges until it finishes; if it logs a failure (or the process restarted mid-run), run `POST /api/pages/graph/refresh` |
| 6a. Cleanup | **Clean up** (`POST …/cleanup`) — drops the `_prev` columns, restores NOT NULL | **No — old vectors deleted** | **search and page reads are down for the duration** — see below |
| 6b. Rollback | **Roll back** (`POST …/rollback`) — reverse renames, restore the old assignment; pages embedded post-swap are re-dirtied for the normal pipeline | back to step 4 | same as 6a |

**Only the swap is sub-second.** `lock_timeout` bounds how long a step waits
*to acquire* the table lock, never how long it holds it — so the discipline
that makes step 4 quick does not transfer to cleanup and post-swap rollback.
Both hold `ACCESS EXCLUSIVE` on `page_embeddings` **and** `pages` across a
re-dirty scan, a `DELETE … WHERE embedding IS NULL` scan and a `SET NOT NULL`
that Postgres validates with a full table scan. Every read and write to both
tables queues behind them: search, page views, sync. Treat 6a/6b as a
maintenance window sized to a few full scans of `page_embeddings`, not as the
swap's sibling. The swap itself renames metadata only and is genuinely
sub-second.

## Go / no-go

- **Go** when: the dimension the server MEASURED (start's response and the
  status card show it — the server probes; nothing client-supplied is trusted,
  and only unusable values ≤0/>16000 are refused, not unexpected ones, so
  **verify the reported dimension matches your expectation before letting the
  backfill spend provider budget**); straggler count is 0
  (`GET …/shadow-migration` → `stragglerPages`); disk headroom ≥
  2× current `page_embeddings` size plus the second HNSW index.
- **Enterprise instances:** an active **org LLM policy** pinning the embedding
  use case outranks the assignment a swap writes — the resolver consults the
  policy first — so the corpus would end up on one model while every query
  resolves another. Start and swap both refuse with a 409 in that case (CE
  never has one). Point the policy at the new model, or disable it, first.
- **Plan the confidence re-tune BEFORE you swap (#1114).** Check both refuse
  thresholds — Settings → AI Models → Retrieval, or
  `SELECT setting_key, setting_value FROM admin_settings WHERE setting_key
  LIKE 'rag_confidence_threshold%'`. Both default to `0`, which is the gate
  off; if either is non-zero, it is a number tuned on the OLD model's scale
  and the swap does not move it. A cosine threshold set against `bge-m3` is a
  different gate against `Qwen3-Embedding-4B` — strictly more or strictly
  fewer refusals, silently. **The swap deliberately never rewrites it** (warn,
  don't mutate: refusal policy is the operator's, and a silently relaxed gate
  is worse than a silently strict one). It logs a warning naming both models
  and the threshold, and the Retrieval tab shows an amber notice on that
  control until the threshold is saved again — either re-tuned, or kept via
  the notice's own **Keep &lt;value&gt;** button. **The amber notice needs a
  recorded model to compare against**, so a threshold set before #1114 shipped
  (or written straight into `admin_settings` with SQL) shows a muted
  "calibration unknown" line instead and never turns amber — which is every
  existing instance on its first post-upgrade swap. On those the log warning is
  the signal, so check the thresholds here rather than expecting the panel to
  flag them afterwards; pressing that line's **Record &lt;value&gt;** button
  once, before you start, records the number against the current model and
  gets you the amber notice on this swap. Either way decide up front whether you will
  re-tune the number or keep it, and budget the measurement: the sane order is
  swap → validate → read your own logged `rag.confidence` values on the new
  model → set the threshold from those.
- **No-go / wait** when: a destructive re-embed job is queued (start refuses);
  a previous shadow backfill job is still queued (start refuses — BullMQ's
  fixed job id would silently swallow the new enqueue); sustained
  long-running queries are hitting `page_embeddings` (every DDL step —
  start, swap, rollback, cleanup — runs under a bounded `lock_timeout` with
  retries; safe, but pointless until they drain).

## Stragglers and stuck jobs

Pages whose shadow embed keeps failing are left as **stragglers** (visible in
the status; the swap refuses while any remain) — the backfill terminates
rather than retrying them forever. Fix the provider/content issue, then
**Re-run backfill** (`POST …/shadow-migration/backfill`); it only re-embeds
rows still missing shadow vectors. The same re-run recovers a crashed worker
or a start whose enqueue never landed. From start until the state row is gone — `active`, `swapped` **and**
`aborting` — the embedding use-case assignment is **pinned**
(`PUT /admin/llm-usecases` answers 409 for it): it is migration state, not
free config, and after a swap it is also what a rollback restores. For the
same reason the migration's providers are protected while it runs: neither
the target nor the rollback provider can be deleted, and a default repoint
(`set-default`, or a `defaultModel` patch) is refused whenever the live
assignment **or** the rollback target resolves through it. An interrupted
abort parks the migration in an `aborting` state; retrying the abort is
idempotent and completes it.

**A bulk page re-embed** (`POST /api/pages/bulk/embed`, which any signed-in
user can call) is refused only in the **post-swap** window: during the
backfill it is harmless, because edits dual-write both columns, but after the
swap those rows have no `embedding_prev`, so a rollback would re-dirty exactly
those pages and search would lose them until the pipeline caught up.

**Every whole-corpus re-embed is refused while a migration exists** — the
dimension-change form, the plain same-dimension one, the embedding-rescan
admin routes (`reEmbedAll`), and a chunk-size/overlap change, which marks the
whole corpus dirty. During `swapped` any of them would fill the table with
rows that have no `embedding_prev`, and the rollback that deletes NULL-vector
rows would then empty the corpus instead of restoring it. Finish or abort the
migration first.

**Provider-edit caveat.** A `baseUrl` / `apiKey` patch on the migration's
target provider is *not* refused — it repoints the shadow model mid-backfill
and mixes two models into one column, exactly as the same patch does to the
live column outside a migration. Treat the target provider's endpoint as
frozen for the duration; if it must move, abort and restart.

**Legacy mode caveat** (`USE_BULLMQ=false`): job-status lookups return
nothing, so the start-time guards against a *running* destructive re-embed or
a *queued* previous backfill are inert — the state-row exclusion still holds,
but operators must not fire both paths simultaneously by hand.

**Rollback and cleanup wait for the background edge rebuild** rather than
compete with it for the table lock — clicking either right after a swap can
therefore sit for up to 30s before it starts. The wait is capped for a reason
(waiting out a whole-corpus recompute would time out at the edge proxy and
report a failure for an operation that had not begun) and it only sees a
rebuild running in the SAME backend process, so on a multi-replica deployment
the bounded lock retry is the real backstop: a rollback that answers 503
"could not acquire the table lock" during the rebuild window is safe to
retry, and nothing has been changed when it does.

**`PG_STATEMENT_TIMEOUT` does not apply to this lifecycle's long statements.**
The HNSW build, the re-dirty scan, the NULL-row delete and the `SET NOT NULL`
validation each exempt themselves (`SET LOCAL statement_timeout = 0`, the same
discipline `runMigrations` uses); without that, a deployment which sets the
variable could never reach `ready`, and once swapped, both cleanup and
rollback would abort every time — stranding the instance in `swapped` with no
way out through the UI. `lock_timeout` still bounds every wait that could
affect other sessions.

## Expected duration

Backfill wall-clock ≈ `total_chunks ÷ provider_throughput`. Chunk count:
`SELECT count(*) FROM page_embeddings;`. There is no measured prod-corpus
number yet, and no issue is going to produce one: #1101 (the spike) and #1113
(the benchmark rig) are both closed. It comes from the first real backfill —
record the chunk count, the provider and the wall-clock here when someone runs
one. For the one model change that has been measured end to end, the dev-rig
reference figures are in the section below.

## Cutover to Qwen3-Embedding-4B (#1114): go/no-go, revert, measured costs

Everything above is model-agnostic. This section is the one cutover that has
been measured — `bge-m3`@1024 → **Qwen3-Embedding-4B at its native 2560**, the
recommendation in ADR-012's `#1114` amendment — and it exists because that
issue's acceptance criteria ask for a stated go/no-go and a revert criterion
**agreed before the re-embed starts**, not reconstructed after it.

> **The GO and REVERT criteria below are PROPOSED.** They are the runbook
> author's reading of the measurements, written so the owner has something
> concrete to agree, amend or reject. Nothing here has been ratified, and two
> of the numbers (the p95 latency ceiling and the 2× answer-path bound) are
> derived from dev-machine measurements rather than observed in production.
> Agree them, in writing, before starting the backfill.

### Prerequisites

1. **Production serves Qwen3-Embedding-4B at native 2560 over an
   OpenAI-compatible `/v1/embeddings`.** No `dimensions` field is sent — the
   outbound body stays `{model, input}` — so a server that silently truncates
   or pads is not detectable from the request side. The width the server
   **probes** at start (`startShadowMigration` embeds the literal text `probe`
   and takes `vectors[0].length`) is the only width that counts; verify it
   reads 2560 before the backfill spends provider budget.
2. **The model name the `embedding` use case RESOLVES to must contain BOTH
   `qwen3` and `embed`** — the assignment's model, or the provider's
   `default_model` where the assignment inherits it. `wantsInstructionPrefix`
   (`backend/src/domains/llm/services/query-instruction.ts`) keys the #1329
   query-side instruction prefix off that substring pair on the **resolved**
   model name, deliberately narrowly: prefixing a model that was not trained
   for it corrupts the query vector, while failing to prefix one that was gives
   up some accuracy and nothing else, so `qwen3` alone and a future
   `qwen4-embedding` both fall through to the safe side. Names like
   `text-embedding-qwen3-embedding-4b`, `Qwen/Qwen3-Embedding-4B` and
   `qwen3-embedding:4b` all match; a row named `qwen3-4b` does **not**, and the
   migration would complete with the prefix silently off. Documents are
   embedded bare under every model, so this flips on at the swap and off again
   at a rollback with no re-embed either way.
3. **#1327's width pre-flight is in place** (it is, on `dev`): `embedPage`
   reads the live column's declared width from the catalog and refuses a batch
   whose vectors do not match **before** opening the Phase 2 transaction. That
   is what turns "someone repointed the assignment by hand" into a dirty page
   with a legible `embedding_error` instead of a half-written corpus. See the
   *If you changed the model WITHOUT this runbook* section.
4. **The `halfvec(2560)` HNSW tier is automatic.** `columnTypeFor`
   (`shadow-migration-service.ts`) picks `halfvec` + `halfvec_cosine_ops` at
   this width; nobody types a column type. At 2560, fp16 is not a fallback
   anyone chose — it is the only representation pgvector can index.

### Pre-flight measurements the operator runs

Four, and all four are inputs to the go/no-go below.

**(i) Query-embedding latency at the expected concurrency, against the
PRODUCTION endpoint.**

```bash
cd backend
npx tsx scripts/benchmark-query-latency.ts \
  --mode embedding \
  --base-url https://<your-endpoint>/v1 \
  --models <your-qwen3-model-id>,<your-bge-m3-model-id> \
  --concurrency 1,4,8 --out /tmp/prod-embed-latency.json
```

`--mode embedding` needs no database and is the one mode that takes several
models, so both arms can be timed in a single run. `--base-url` is spelled
**exactly** as the provider row is — the request goes to `<base-url>/embeddings`
verbatim, nothing guesses a `/v1` for you.

Dev-Mac reference, one LM Studio process on Apple Silicon, 40 queries per rung
(source: the #1114 comment of 2026-08-16, *German re-run under `fts=german`*):

| model | conc | emb p50 | emb p95 | search p50 | search p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| bge-m3 `vector(1024)` | 1 | 18.4 | 20.4 | 30.2 | 34.7 |
| | 4 | 62.1 | 76.7 | 58.8 | 66.7 |
| | 8 | 118.7 | 130.7 | 142.8 | 170.9 |
| Qwen3-4B `halfvec(2560)` | 1 | 224.1 | 234.8 | 241.4 | 259.0 |
| | 4 | 788.8 | 985.2 | 805.6 | 1000.7 |
| | 8 | 1797.7 | 1947.2 | 1837.3 | 1944.1 |

**Read only the concurrency-1 rows as latency.** LM Studio serialises
inference — one model, one process, no continuous batching — so the 4- and
8-wide rungs do not overlap any work, they queue it: Qwen3's p50 is ×3.5 at
4-wide and ×8.0 at 8-wide, dead-on proportional, which is the signature of a
throughput-bound system rather than a latency one. Those rungs measure queue
depth. The 1-wide rows put the model gap at roughly **12× on the embedding
call** (224 ms vs 18 ms p50) and ~8× end-to-end (241 ms vs 30 ms); subtracting
the embed half leaves ~12 ms of Postgres time for `vector(1024)` and ~17 ms for
`halfvec(2560)`, so almost all of the difference is the encoder, not the index
width. **A production stack with continuous batching will not reproduce this
shape** — an 8-wide load is absorbed rather than queued — which is exactly why
this pre-flight is run against your own endpoint and the table above is a
*relative* model cost on identical hardware and nothing more.

**(ii) A shadow-backfill throughput sample, taken from the real backfill.**
Start the migration (step 1) and let it run past ~100 pages. The status card
does the projection for you: after it has watched five pages of progress it
renders **"about N remaining"** beside the `backfilled/total` count, computed
from the rate it has actually observed. Take that number.

**Keep the arithmetic in pages if you do it by hand.** The card counts
**pages** (`backfilledPages` / `totalPages`); `SELECT count(*) FROM
page_embeddings` counts **chunks**, and the two differ by the chunks-per-page
ratio — 2,377 / 275 ≈ 8.6 on the measured corpus, so dividing a chunk count by
a page rate over-projects the window by roughly that factor. Either
`totalPages ÷ (Δ backfilledPages ÷ Δt)`, or chunks against a chunks-per-second
figure as the *Expected duration* section above pairs them. Not one of each.

Do this before committing to a maintenance window, not instead of one: an
Abort at that point drops the shadow columns and changes nothing else. Dev
reference for the ratio: the same 275-page corpus re-seeded end to end in
**4 m 21 s** on bge-m3 against **40 m 55 s** on Qwen3-4B — **~9.4×**, which
tracks the ~12× per-call gap closely because corpus embedding dominates the
wall clock and both arms embed the same chunks. (Earlier #1114 figures of
3 m 31 s / 36 m 13 s over 2,198 chunks give the same ~10×; that count and the
2,377 above describe the same corpus and are **not** reconciled — see *On the
chunk count* below.) Both are dev-Mac, single non-batching runtime,
~2,200–2,400 chunks. **Your corpus is not 2,377 chunks and your server is not
this one**, so use the ratio to sanity-check your own sample, never in place of
it.

**(iii) Capture a Production benchmark baseline BEFORE the swap.**
**Settings → AI Models → Retrieval → Production benchmark** (#1322) replays the
most recent distinct questions from `search_analytics` through the current
pages and embeddings — ordinary retrieval and deep search — and reports p50/p95
latency, empty-result counts, result-set overlap, top-1 movement and whether
expansion ran. It is read-only with respect to knowledge content, embeddings
and retrieval settings, and does not write the replayed questions back. Run it
on the **old** model and keep the run id: #1322 stores runs, so the post-swap
run is directly comparable rather than a remembered impression. Production
questions carry no ground truth, so Recall/MRR stay blank unless you post a
labelled custom suite (`POST /api/admin/retrieval-benchmark` with
`source: "custom"` — see `docs/runbooks/retrieval-eval.md`). **If you want a
revert criterion expressed in R@5 or MRR, you need that labelled suite, and you
need it before the swap.**

**Two things the panel does not give you, so take them from the API.** The run
id is never rendered — the panel holds it in state, shows progress and then a
summary, and there is no list endpoint — so copy it from the
`POST /api/admin/retrieval-benchmark` response body (`{ runId, status }`), or
recover it later with `SELECT id, created_at FROM retrieval_benchmark_runs
ORDER BY created_at DESC LIMIT 5`. And the summary renders **movement and
latency only** (p50/p95 per variant, top-K overlap, top-1 changed, expansion
counts) — Recall and MRR are computed and stored but not displayed, so read a
labelled suite's figures from `GET /api/admin/retrieval-benchmark/:id`
(`result.baseline.recallAtK` / `result.baseline.mrr`, and the same pair under
`result.deepSearch`). Both routes are `requireAdmin`.

**(iv) If either confidence threshold is non-zero, plan its re-tune.** See
*Plan the confidence re-tune BEFORE you swap (#1114)* in the Go / no-go section
above — it is the same decision, and #1344 added the mechanism that makes it
visible (the swap logs a warning naming both models; the Retrieval tab shows an
amber notice on that control, or a muted "calibration unknown" line on an
instance whose threshold predates #1114). Both knobs default to `0`, which is
the gate off, and that is the common case; the work is only owed where one is
set.

### Search during the backfill

**No query is answered from a half-migrated corpus — the live column serves
every one of them, which is the point of using this path — but retrieval is not
insulated from the backfill, and the distinction matters.** What is untouched
is the live column's correctness. Consequence 2 below — a rejected query embed
dropping search to its keyword leg — is a change in *quality*, not merely in
latency, so **"search is unaffected" is not a claim this runbook makes**, and
the status card no longer makes it either.

**What does not change: correctness.** The backfill writes into
`embedding_next` while the live column keeps serving every query, and edited
pages dual-write both models; the #1117 coverage signal reads the **live**
column, so it stays healthy start to finish. No query is ever answered from a
half-migrated corpus, and nothing is deleted before the swap. See the *Degraded
behaviour* section for the lifecycle-level statement and its failure modes.

**What does change: the embedding provider is busy, and the queue in front of
it is shared.** `runShadowBackfillJob` embeds through the same
`generateEmbedding` as a user's question, which means the same process-wide
LLM queue (`enqueue`, `LLM_CONCURRENCY`, **default 4**) and the same provider.
There is no separate worker host to isolate it in: BullMQ's workers are started
by the API process, and with `USE_BULLMQ=false` the job runs inline in it. The
backfill is strictly sequential (worker concurrency 1, one 16-chunk batch in
flight at a time), so it occupies **one** of those slots, not all of them; what
it does is hold that slot for the entire run and keep the provider working
continuously. Two consequences, in order of how likely you are to meet them:

1. **Query-embedding latency rises for the duration.** On a runtime that does
   not batch — the dev rig, and any single-process server — a user's query
   embed waits behind whatever chunk batch is mid-flight. At Qwen3's ingest
   cost that duration is hours on a real corpus, so this is not a blip.
2. **Under concurrent LLM load, a query embed can be rejected outright.** When
   `pendingCount` reaches `LLM_MAX_QUEUE_DEPTH` (**default 50**) `enqueue`
   throws `QueueFullError`, and `rag-service` does not treat that differently
   from any other embedding failure: `degraded_reason = 'embedding_failed'`,
   `/api/search` falls back to **keyword-only**, and `/llm/ask` **refuses the
   turn** (`semantic_index_unavailable` — #1105's honest refusal, which is
   ungated). The backfill contributes one pending item, so it cannot fill that
   queue by itself; it removes a quarter of the drain capacity and saturates
   the provider, which is enough to put a load that used to fit over the line.

**Watch:** the warn line `Embedding failed — vector leg down, keyword leg only
(degraded_reason: embedding_failed)`, and `search_analytics.degraded_reason`,
which records the same verdict per query. The LLM queue's own counters
(`getMetrics().totalRejected`) are process-local and are not exposed on any
endpoint today, so the log line and that column are what an operator has.

**Mitigate by scheduling, not by tuning.** Run the backfill off-peak; that is
the whole reason pre-flight (ii) projects a wall-clock before you commit to it.
Raising `LLM_CONCURRENCY` only helps if the provider genuinely absorbs more
concurrency — on a serialising runtime it moves the queue rather than draining
it, which is exactly what the concurrency rungs in (i) measured.

The remaining costs are the provider budget for that load and, at the end of
it, the index build in step 3 — which stalls **writes** to `page_embeddings`
and to `pages` (sync upserts, editor saves, embedding-status updates) for
minutes, while reads are unaffected. The only sub-second step is the swap
itself; **cleanup and post-swap rollback are the maintenance window**, not the
backfill.

**None of which makes the destructive path competitive.**
`enqueueReembedAll`'s `TRUNCATE` leaves RAG on keyword fallback and
`page_avg_embedding` NULL until the last page re-embeds, with the old vectors
already gone. At ~9.4× ingest cost, that window is 40 minutes on a 275-page
corpus and hours on a real one — a guaranteed, total degradation for the whole
re-embed, against a latency rise and a load-dependent rejection risk here.
That is why the Qwen3 cutover is a shadow migration and not a re-embed.

### GO criteria (proposed — for the owner to agree)

- All four pre-flights above are **done and recorded**, not estimated.
- The projected backfill wall-clock from (ii) fits the window you have accepted
  for background embedding load. The live column serves every query throughout,
  so no answer comes from a half-migrated corpus — but the backfill shares the
  LLM queue and the provider with query-side embeds, so pick a window where
  **both** costs are acceptable: a raised query-embedding **p95** for the whole
  run, and — under concurrent LLM load — query embeds rejected at
  `LLM_MAX_QUEUE_DEPTH` into keyword-only `/api/search` and refused `/llm/ask`
  turns (see *Search during the backfill* above).
- **p95 query-embedding latency at your expected concurrency ≤ 400 ms**, from
  (i), against the production endpoint. **This number is a proposal, not a
  measured production fact.** It is derived from two things: Qwen3's dev-Mac
  concurrency-1 p95 of 235 ms, and the ~250 ms end-to-end search p50 the same
  rig measured — a ceiling under half a second keeps the embed call from
  becoming the dominant term in a chat answer that also has retrieval, rerank
  and a completion in front of it. A deployment with a tighter answer-latency
  budget should propose a tighter number; one that batches well may clear it
  easily. Agree it before, not after.
- **The width evidence the pre-swap paths actually produce.** Not an
  `EmbeddingDimensionMismatchError` — **none of the three paths that run before
  the swap can raise one**, so "no mismatch error in the logs" passes vacuously
  on exactly the deployment prerequisite 1 warns about. The probe *defines* the
  width rather than checking it (`startShadowMigration` embeds the literal
  `probe`, takes `vectors[0].length`, refuses only a value outside 1–16000, and
  creates the column from that same number via `columnTypeFor` — probe and
  column cannot disagree). The backfill has no width check at all
  (`shadowEmbedExistingRows` writes into `embedding_next` directly, so a wrong
  width arrives as a pgvector cast error and the page becomes a straggler). The
  dual-write logs a **warn**, not an error class. Check these three instead:
  - the width reported by start — and the `N dims` on the status card — reads
    **2560** (this is prerequisite 1's verification step, promoted to a
    criterion);
  - **`stragglerPages` is 0** when the backfill ends
    (`GET /api/admin/embedding/shadow-migration`; the card reaching `ready` with
    Swap enabled is the same fact, and the swap refuses while any remain);
  - no `Shadow dual-write returned wrong-dimension vectors` warn line appears
    for any page.

  `EmbeddingDimensionMismatchError` is the **live**-column guard
  (`embedding-service.ts`, comparing the served width against the live column's
  declared width), which is why it is a REVERT criterion below and not a GO
  criterion here.

### REVERT criteria (proposed — for the owner to agree)

All of these apply **inside the #1116 rollback window** — after the swap and
before cleanup, where **Roll back** restores the old model immediately. After
cleanup there is no shortcut; the old vectors are gone and the way back is a
fresh shadow migration in the other direction. Do not run cleanup until these
have been checked.

Roll back if any of:

- **The post-swap Production benchmark regresses against the pre-swap baseline
  on R@5 or MRR beyond run-to-run noise.** Requires the labelled custom suite
  from (iii); with the default unlabelled run those two metrics are blank and
  this criterion is unavailable — use the latency and refusal criteria instead,
  and say so in the go/no-go record rather than pretending the criterion is
  live. #1322 stores runs, so before/after is a comparison and not a memory.
- **Answer-path p95 exceeds 2× the pre-swap figure at comparable load.** Also a
  proposal: the encoder is ~12× per call on the dev rig but the embed call is
  one term among several in an answer, so a 2× end-to-end ceiling is the point
  at which the model cost has stopped being amortised by everything else in the
  path. Compare like with like — the same benchmark, similar traffic.
- **The refusal rate jumps after the swap.** This is threshold calibration, not
  retrieval: a cosine gate tuned on `bge-m3` means something different on
  Qwen3's scale. **Re-tune first** (read your own logged `rag.confidence`
  values on the new model and set the threshold from those), and roll back only
  if re-tuning does not settle it. Rolling back for this without re-tuning
  reverts a working swap for a knob nobody moved.
- **The width guard fires** — any `EmbeddingDimensionMismatchError` on the live
  path post-swap. That is the column and the model disagreeing, and it does not
  get better with time.

### What is already measured

Every row here has a source. Nothing in this table is a production figure.
**And every retrieval row was measured with the rerank stage unassigned** —
plain eval runs, no `--rerank`, which ADR-012 carries as open item 4 ("every run
above is plain; #1104's cross-encoder stage was not live"). Per ADR-021 a
deployment that assigns `rerank` runs a cross-encoder over the fused set, which
is not the configuration these recall deltas describe, and the deltas under it
are unmeasured. That gap is not one only production can close — the eval has a
`--rerank` arm — but nobody has run it for this model pair, so a go/no-go
leaning on the table should say so.

| Question | Result | Source |
| --- | --- | --- |
| English fixture, Qwen3 vs bge-m3 | R@3 (p = 0.00003), R@5 (p = 0.0015), R@10 (p = 0.013) and MRR (CI [+0.025, +0.115]) established; **R@1 not** (+0.051 but 27W/17L, p = 0.174, CI crosses zero) | #1114 comment, *Phase 1 measured on the English fixture*; ADR-012 `#1114` amendment |
| German fixture under `fts=simple` | R@1 +0.081 (31W/15L, p = 0.026), R@3 +0.086 (p = 0.0023), R@5 +0.046 (p = 0.122), R@10 +0.061 (p = 0.0075), MRR CI [+0.030, +0.122] | #1114 comment, *German result* |
| German fixture under `fts=german` | R@1 +0.061 (27W/15L, p = 0.088), **R@3 +0.081 (22W/6L, p = 0.0037)**, R@5 +0.056 (19W/8L, p = 0.052), **R@10 +0.061 (15W/3L, p = 0.0075)**, MRR +0.065 (CI [+0.021, +0.110]) | #1114 comment, *German re-run under `fts=german`* |
| Does the German stemmer help? | **No detectable effect.** R@10 bit-identical query-for-query on both models (0W/0L/197T); one nominally significant cell (Qwen3 R@1, 1W/8L, p = 0.039) that dies under correction | same |
| Ingest cost | **~9.4–10× slower.** 4 m 21 s vs 40 m 55 s (275 pages, `german` re-run); 3 m 31 s vs 36 m 13 s over the earlier run's **2,198**-chunk count — see *On the chunk count* below, the same corpus was later counted at 2,377 | same, and *German result* |
| Query latency | **~12× at concurrency 1** on the dev Mac (224 ms vs 18 ms p50 embedding) | same, latency table |
| fp16 rounding | **Below the corpus's own rank gaps.** Largest fp16-induced \|Δdistance\| 2.67e-5 against a p01 adjacent-rank gap of 4.44e-5; 0/200 top-1 changes. **Caveat carried from the source: measured at 768 dims with `nomic-embed-text` on real corpus vectors, NOT at 2560 with Qwen3** — it is evidence that fp16 rounding is small relative to rank spacing, not a 2560-dim measurement | #1114 comment, *The fp16 gate*; ADR-012 `#1114` amendment |
| `ef_search` at `halfvec(2560)` | **Effectively exact from ef = 40.** recall@10 = 0.9995 at the `RAG_EF_SEARCH` default of 100 and unchanged at 200/240/400/1000 | #1114 comment, *`ef_search` at `halfvec(2560)`: effectively exact from 40, and the number to watch is footprint* (2,377 chunks in `kb_eval`, PostgreSQL 17.10 + pgvector 0.8.5, read-only) |

**On the two German configurations.** The model gap is the sturdiest thing in
this data and it does not depend on the stemmer: under `german`, Qwen3 is ahead
at every K and on MRR, and **R@3 (p = 0.0037) and R@10 (p = 0.0075) clear
significance even after a conservative Bonferroni ×4** (0.015 and 0.030). Under
`simple` the same two cells were p = 0.0023 and p = 0.0075. What did move is
R@1: nominally significant under `simple` (p = 0.026) and not under `german`
(p = 0.088), with the point estimate barely changing (+0.081 → +0.061). Read
that as R@1 having always been the weakest of the four — neither value survives
multiplicity correction, and on the `simple` run a single query flipping the
other way takes it to p = 0.054 — not as the stemmer eroding the gap.

**On the chunk count.** Two numbers describe the same 275-page German corpus in
this document and neither is dropped: the earlier ingest run reported **2,198**
chunks, while the `ef_search` session counted **2,377** straight out of
`page_embeddings` and recorded the difference ("the corpus holds 2,377 chunks,
not ~2,198"). Nothing reconciles them, so each figure travels with the run that
produced it. The ~10× ingest ratio and the ~10 / ~1 chunks-per-second rates in
the **Settings → AI Models → Embeddings** benchmark table come from the 2,198
count; the footprint, recall and chunks-per-page figures come from the 2,377
one. The *ratio* is unaffected either way — a *rate* recomputed by mixing the
two counts would not be, which is the same pages-versus-chunks trap pre-flight
(ii) warns about, one level up.

**On `ef_search`.** Leave `RAG_EF_SEARCH` at 100. On the 2,377-chunk German
corpus, recall@10 is 0.9995 at ef = 100 and *identical* at 200, 240, 400 and
pgvector's 1000 ceiling; the single non-matching row across 2,000 comparisons
is a 7×10⁻⁷ distance tie at rank 10, inside halfvec's own fp16 quantization
noise. Server-side cost rises close to linearly (0.39 ms at 100 → 0.66 ms at
240 → 1.74 ms at 1000), so raising it buys nothing and is not free. Production
reaches two values — 100 for a 10-page fetch, 240 for a 30-page rerank pool —
and they are indistinguishable in quality here. Three caveats travel with that
number: **HNSW build time was never measured** (that session created no index);
all 35 MiB of the relation fit inside a 128 MB `shared_buffers`, so every probe
was cache-resident and the timings are CPU-only; and on a corpus this small the
planner **rejects the index** at ef ≥ 200 in favour of an exact seq scan
(correct, and 4.7× slower — it does not cost the per-row detoast of a 5,120-byte
out-of-line vector). All three invert as the corpus grows. The number worth
watching after a 2560-dim re-embed is not recall but **footprint**: the HNSW
index is 18.6 MiB for 2,377 vectors — **8.2 kB per vector, larger than heap and
TOAST combined** — and it scales linearly with chunk count. Budget disk on that,
not on the vectors alone.

### What only production can prove

- **The serving stack's latency envelope.** Every latency figure above comes
  from one non-batching runtime on a laptop serving both arms. A batching
  server (and likely a GPU) has a different shape, and the concurrency rungs
  above measure queue depth on that rig, not request cost on yours.
- **Backfill wall-clock and HNSW build time at your corpus scale.** The ratio
  transfers better than the minutes do, and build time has never been measured
  at any scale.
- **Cache behaviour.** 2,377 vectors in a 128 MB `shared_buffers` is the easy
  case. A corpus that does not fit moves the *cost* column far more than the
  recall column and flips the planner's index-vs-seqscan choice.

### Cosine constants to re-check after the swap

Similarity scores are not comparable across embedding models, and three places
read a raw cosine against a number chosen under `bge-m3`. The argument lives in
ADR-012's `#1114` amendment (open item 3) — **cross-reference, don't restate**;
the list here is so nobody has to remember which files:

- `ConfidenceBadge`'s High/Medium/Low ladder at **0.7 / 0.4**
  (`frontend/src/shared/components/badges/ConfidenceBadge.tsx`), whose own
  comment already says it is calibrated for `bge-m3`.
- **`SIMILARITY_THRESHOLD = 0.4`** for knowledge-graph relationships
  (`backend/src/domains/llm/services/embedding-service.ts`).
- #1105's refuse gate — the operator-set thresholds, which is why they get the
  standing treatment in the Go / no-go section rather than a line here.

None of the three fails loudly. The observable symptoms are the badge
distribution, the graph's edge count and the refusal rate.

## If you changed the model WITHOUT this runbook

Repointing the `embedding` use case at a model of a different width is the
mistake this lifecycle exists to prevent, and it is now caught up front
(#1114). `embedPage` reads the live column's declared width from the catalog
and refuses a batch whose vectors do not match, **before** opening the Phase 2
transaction — so nothing is deleted, nothing is written, and the page is left
dirty with an `embedding_error` naming the model and both widths:

> Embedding model "qwen3-embedding-4b" returned 2560-dimensional vectors but
> the page_embeddings.embedding column holds 1024. Nothing was written.

Previously this surfaced only when pgvector rejected the INSERT — after the
whole page had been embedded and paid for, as a cast error naming neither the
model nor either width. The remedy is either to put the assignment back, or to
run the shadow migration above, which is what actually moves the corpus to the
new width.

The check **fails open**: if the catalog cannot be read it is skipped, and the
INSERT remains the backstop it has always been. It resolves lazily, so a page
whose every batch is skipped for context length does not pay a query for it.
The shadow dual-write has had an equivalent guard since its own review; this
closes the same hole on the live path.

## Degraded behaviour

None by design — the live column serves until the swap commits. That is a
statement about *results*, not about load: the backfill shares the LLM queue and
the provider with query-side embeds, which is costed in *Search during the
backfill* above. The #1117 coverage signal reads the live column, so it stays
healthy throughout (unlike
the destructive path, whose TRUNCATE window it exists to expose). Failure
modes: a shadow-provider outage leaves straggler pages (visible in the status
card; swap refuses); an aborted swap (lock timeout) leaves everything on the
old model with the state intact — retry when load drains. Deleting the target
provider inside start's probe window (a seconds-wide race the in-transaction
re-check closes, leaving only the instant between the delete's own guard read
and its commit) parks the migration at `backfilling` with every page a
straggler — abort it and start again.

## Revert procedure

- Before swap: **Abort** — drops the shadow columns, nothing else changed.
- After swap, before cleanup: **Roll back** — old model serves again
  immediately; pages embedded in the interim re-embed via the normal dirty
  pipeline.
- After cleanup: no shortcut — run a fresh shadow migration back to the old
  model.

A rollback moves the scale back, which is still a move: if you re-tuned a
confidence threshold against the new model between swap and rollback, that
number is now on the old model's scale. The rollback logs the same #1114
warning with the models the other way round, and the Retrieval tab's notice
returns until the threshold is saved again (same caveat as above — a threshold
with no recorded model shows the muted line, not amber).
