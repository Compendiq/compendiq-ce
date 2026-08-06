# Runbook — zero-downtime embedding model change (#1116)

The shadow re-embed replaces the destructive `POST /admin/embedding/reembed
{newDimensions}` path for model/dimension changes. Search serves the live
vectors throughout; the old model stays recoverable until the final cleanup.

## Lifecycle

| Step | Action | Reversible? | Search impact |
|---|---|---|---|
| 1. Start | Settings → LLM → change the embedding assignment → **Start zero-downtime re-embed** (or `POST /api/admin/embedding/shadow-migration {providerId, model}`) | Yes (Abort) | none |
| 2. Backfill | background job embeds every existing chunk with the new model into `embedding_next`; edited pages dual-write both models | Yes (Abort) | none (background embedding load only) |
| 3. Index build | HNSW indexes built on **both** shadow columns at the end of the backfill — unless the model's dimension exceeds 4000, which pgvector cannot index at all (the status card says so instead of claiming an index, and post-swap vector search scans sequentially) | Yes | none for reads; **writes to `page_embeddings` AND to `pages` queue for the build duration** (minutes) — the second index is on `pages`, so sync upserts, editor saves and embedding-status updates stall too |
| 4. Swap | **Swap to the new model** (`POST …/swap`) — one transaction of column/index renames under `lock_timeout 5s`, ≤5 attempts | Yes (Roll back) | sub-second on success. While a lock attempt waits behind a long reader, **new searches queue behind the pending exclusive lock** — each failed attempt can stall them up to 5s (≤5 attempts), so run the swap when long queries have drained |
| 5. Validate | run real searches; the quality gate is #1102's eval rig | — | new model serving |
| — | *(automatic)* the swap and a post-swap rollback both rebuild `page_relationships.embedding_similarity`, the persisted derivative of `pages.page_avg_embedding`, and clear the graph cache | — | graph/related-pages briefly serve the previous edges; if the rebuild logs a failure, run `POST /api/pages/graph/refresh` |
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

**The destructive re-embed is refused outright while a migration exists** —
both the dimension-change form and the plain same-dimension one. During
`swapped` it would fill the table with rows that have no `embedding_prev`,
and the rollback that deletes NULL-vector rows would then empty the corpus
instead of restoring it.

**Provider-edit caveat.** A `baseUrl` / `apiKey` patch on the migration's
target provider is *not* refused — it repoints the shadow model mid-backfill
and mixes two models into one column, exactly as the same patch does to the
live column outside a migration. Treat the target provider's endpoint as
frozen for the duration; if it must move, abort and restart.

**Legacy mode caveat** (`USE_BULLMQ=false`): job-status lookups return
nothing, so the start-time guards against a *running* destructive re-embed or
a *queued* previous backfill are inert — the state-row exclusion still holds,
but operators must not fire both paths simultaneously by hand.

## Expected duration

Backfill wall-clock ≈ `total_chunks ÷ provider_throughput`. Chunk count:
`SELECT count(*) FROM page_embeddings;`. The measured prod-corpus number for
the acceptance criterion lands with #1101 §C / #1113's rig (the issue's own
split); record it here when it exists.

## Degraded behaviour

None by design — the live column serves until the swap commits. The #1117
coverage signal reads the live column, so it stays healthy throughout (unlike
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
