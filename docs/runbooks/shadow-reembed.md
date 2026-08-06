# Runbook — zero-downtime embedding model change (#1116)

The shadow re-embed replaces the destructive `POST /admin/embedding/reembed
{newDimensions}` path for model/dimension changes. Search serves the live
vectors throughout; the old model stays recoverable until the final cleanup.

## Lifecycle

| Step | Action | Reversible? | Search impact |
|---|---|---|---|
| 1. Start | Settings → LLM → change the embedding assignment → **Start zero-downtime re-embed** (or `POST /api/admin/embedding/shadow-migration {providerId, model}`) | Yes (Abort) | none |
| 2. Backfill | background job embeds every existing chunk with the new model into `embedding_next`; edited pages dual-write both models | Yes (Abort) | none (background embedding load only) |
| 3. Index build | HNSW index built on the shadow column at the end of the backfill | Yes | none for reads; **writes to `page_embeddings` queue for the build duration** (minutes) |
| 4. Swap | **Swap to the new model** (`POST …/swap`) — one transaction of column/index renames under `lock_timeout 5s`, ≤5 attempts | Yes (Roll back) | sub-second; a retry storm aborts cleanly and changes nothing |
| 5. Validate | run real searches; the quality gate is #1102's eval rig | — | new model serving |
| 6a. Cleanup | **Clean up** (`POST …/cleanup`) — drops the `_prev` columns, restores NOT NULL | **No — old vectors deleted** | none |
| 6b. Rollback | **Roll back** (`POST …/rollback`) — reverse renames, restore the old assignment; pages embedded post-swap are re-dirtied for the normal pipeline | back to step 4 | sub-second |

## Go / no-go

- **Go** when: the probe measures the expected dimension (start refuses
  otherwise — the server probes, nothing client-supplied is trusted); straggler
  count is 0 (`GET …/shadow-migration` → `stragglerPages`); disk headroom ≥
  2× current `page_embeddings` size plus the second HNSW index.
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
or a start whose enqueue never landed. While a migration is active the
embedding use-case assignment is **pinned** (`PUT /admin/llm-usecases`
answers 409 for it) — it is migration state, not free config. An interrupted
abort parks the migration in an `aborting` state; retrying the abort is
idempotent and completes it.

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
old model with the state intact — retry when load drains.

## Revert procedure

- Before swap: **Abort** — drops the shadow columns, nothing else changed.
- After swap, before cleanup: **Roll back** — old model serves again
  immediately; pages embedded in the interim re-embed via the normal dirty
  pipeline.
- After cleanup: no shortcut — run a fresh shadow migration back to the old
  model.
