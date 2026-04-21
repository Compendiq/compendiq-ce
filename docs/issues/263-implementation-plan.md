# Implementation Plan — Issue #263: retire stale "interval is sufficient" paragraph in ADR-014

> Docs-only change. Target branch: `feature/263-adr014-bullmq` → PR to `dev`.
> Scope: rewrite the ADR-014 "Decision" + rationale so it matches the `queue-service.ts` inventory (5+ BullMQ queues + legacy setInterval fallback). Keep the superseded rationale as an audit-trail section.

---

## 1. ResearchPack — files touched / read

Line numbers verified on `feature/258-llm-queue-breakers` (commit `19b8c87`). PR #261 adds the `reembed-all` queue; treat as shipped.

### 1.1 File to edit

| File:line | Observation |
|---|---|
| `docs/ARCHITECTURE-DECISIONS.md:840–900` | ADR-014 Context / Decision / Workers table / rationale / "Why not bullmq/pg-boss?" paragraph. Stale paragraph at **889–892** says "A simple interval is sufficient. No distributed workers needed (single backend instance)." Contradicts `queue-service.ts` and `USE_BULLMQ` in `CLAUDE.md:261`. |

### 1.2 Current BullMQ queue inventory (ground truth)

From `backend/src/core/services/queue-service.ts:240–319` + PR #261:

| Queue | Defined at | Schedule | Purpose |
|---|---|---|---|
| `sync` | `:248–258` | every `SYNC_INTERVAL_MIN` (15) min | Confluence delta sync |
| `quality` | `:261–271` | every `QUALITY_CHECK_INTERVAL_MINUTES` (60) min | Quality scoring batch |
| `summary` | `:274–284` | every `SUMMARY_CHECK_INTERVAL_MINUTES` (60) min | Summary generation batch |
| `maintenance` | `:287–310` | 24 h token cleanup + 24 h data-retention | Token cleanup + retention |
| `analytics-aggregation` | `:180` (stub) | n/a | Registered for future EE use |
| `reembed-all` | PR #261 (`86261a5`) | on-demand `enqueueJob(...)` | One-shot reembed-all |

**5 worker-backed + 1 stub queue.** Legacy `setInterval` gated by `USE_BULLMQ=false` (`:17–21, 107–109, 323–367`).

### 1.3 Don't touch

- `CLAUDE.md:263` — `USE_BULLMQ` already documented.
- `.env.example` — already lists `USE_BULLMQ`.

### 1.4 External research

BullMQ v5 docs confirm the integration (Ref MCP). No normative quote needed inline.

---

## 2. Step-by-step surgical edits

One file, one section. Keep Context + Workers-table + Worker-Lifecycle verbatim. Rewrite Decision heading, code snippet, and "Why not bullmq/pg-boss?" paragraph. Add "Superseded rationale" for audit trail.

### Step 1 — rewrite `docs/ARCHITECTURE-DECISIONS.md:845–892`

Replace with:

```
### Decision: **BullMQ (Redis-backed) primary; legacy setInterval behind `USE_BULLMQ=false`**

All recurring background work runs on BullMQ queues, registered in
`backend/src/core/services/queue-service.ts`. Each queue gets a dedicated
`Worker` with its own concurrency, and a repeatable-job scheduler drives it
at a configurable cadence. A feature flag (`USE_BULLMQ`, default `true`)
gates the behaviour: setting `USE_BULLMQ=false` falls back to the legacy
`setInterval` code path, which remains in tree as a single-process escape
hatch for dev environments where Redis is unavailable.

```typescript
// queue-service.ts (excerpt)
registerWorkerDef({
  queueName: 'sync',
  concurrency: 3,
  repeatPattern: { every: syncInterval * 60 * 1000 },
  processor: async () => {
    const { runScheduledSync } = await import(
      '../../domains/confluence/services/sync-service.js'
    );
    const result = await runScheduledSync();
    return `Synced ${result} users`;
  },
});
```

#### Queue inventory

| Queue | Concurrency | Schedule | Purpose |
|-------|-------------|----------|---------|
| `sync` | 3 | `SYNC_INTERVAL_MIN` (15 min) | Confluence delta sync |
| `quality` | 2 | `QUALITY_CHECK_INTERVAL_MINUTES` (60 min) | Quality scoring batch |
| `summary` | 2 | `SUMMARY_CHECK_INTERVAL_MINUTES` (60 min) | Summary generation batch |
| `maintenance` | 1 | `TOKEN_CLEANUP_INTERVAL_HOURS` (24 h) + 24 h data-retention | Token cleanup + retention |
| `reembed-all` | 1 | on-demand | One-shot reembed-all run (#257) |
| `analytics-aggregation` | — | registered-only | Reserved for EE analytics workers |

Worker definitions live in `registerAllWorkers()` (`queue-service.ts:240–319`).
Job history is persisted to the `job_history` table on every completion /
failure (`queue-service.ts:63–81`).

#### Why BullMQ over the old `setInterval`

- **Multi-process safety.** The embedding path uses a Redis SET-NX lock
  (`redis-cache.ts:55–71`); PR #257 adds per-user lock visibility. In-memory
  `let running = false` flags don't generalise.
- **Job history and observability.** BullMQ's `Worker` events + `recordJobHistory`
  sink give admins a real audit trail; dashboard consumes via `getQueueMetrics()`.
- **On-demand jobs.** The `reembed-all` queue (#257) is a one-shot job admin UI
  triggers via `enqueueJob('reembed-all', …)` and polls via `getJobStatus(jobId)`.
  `setInterval` can't express "run once, now, track progress".
- **Feature-flag escape hatch.** `USE_BULLMQ=false` keeps legacy path alive
  for envs without Redis.

#### Superseded rationale (preserved for audit trail)

The original ADR argued for `setInterval`:

> *4-15 users, ~1000 pages total. A simple interval is sufficient.*
> *No distributed workers needed (single backend instance).*
> *Redis-based job queues add complexity for zero benefit at this scale.*

That argument no longer holds as of issue #256 (multi-LLM-provider) and #257
(admin-triggered reembed-all). On-demand jobs, multi-provider fan-out, and
per-user lock visibility can't be absorbed without re-inventing a queue.
Paragraphs retained so the decision trail stays auditable.
```

Leave `#### Worker Lifecycle`, `#### Quality Analysis Worker`, `#### Summary Worker`, `**Crash recovery**`, `**Per-user sync**`, `**Admin controls**` untouched.

### Step 2 — no other files

---

## 3. Tests / Rollback / AC

- No tests.
- Rollback: `git checkout origin/dev -- docs/ARCHITECTURE-DECISIONS.md`.
- AC: coherent end-to-end ✓ — inventory matches source ✓ — superseded preserved ✓.

---

## 4. Risks + dependencies

1. Separate file for Superseded? Recommend inline.

- Content dependency on PR #261 (to reference `reembed-all` factually). Zero file conflicts with #264–#269.

~15 min effort.
