# Implementation Plan — Issue #257: wire BullMQ re-embed-all worker (v3)

> Follow-up to #256 (merged via PR #259 on 2026-04-21). Target branch: `dev`.
> Scope: replace the `TODO(#257)` stub in `enqueueReembedAll` with a real
> BullMQ-backed worker, add a progress-readable job endpoint, gate the
> worker on per-user embedding locks (with admin visibility + force-release
> escape hatch), and make job-history retention admin-configurable.
>
> **v3 changes from v2:** dedicated `GET /api/admin/embedding/locks`
> endpoint (not an extension of `/api/embeddings/status`); new
> `POST /api/admin/embedding/locks/:userId/release` force-release with
> audit logging + holder-epoch write-guard; SCAN-based
> `listActiveEmbeddingLocks` kept as-is with an upgrade-path note. See §9
> for the full v2→v3 changelog.
>
> CLAUDE.md compliance: tests required on every change (§4), branch
> `feature/257-reembed-worker` targets `dev` (never `main`), migration
> `055` additive + idempotent, no architecture-diagram area affected (no
> new domain boundary, no new container, no table schema change — only a
> new `admin_settings` row).

---

## 1. ResearchPack — files touched / read

All paths relative to repo root `compendiq-ce/`. Line numbers verified against
tip of `feature/docs-multi-llm-provider-sync` (commit `040d10f`) on
2026-04-21.

| File | Current role | Key lines |
|---|---|---|
| `backend/src/domains/llm/services/embedding-service.ts` | Stub `enqueueReembedAll` (line 912) returns `reembed-${Date.now()}`. Working `reEmbedAll()` (line 891) + `processDirtyPages(userId, onProgress)` (line 436) — both **sync / in-process**. | 891–951, 436–700 |
| `backend/src/routes/llm/llm-embedding-reembed.ts` | Admin route — validates `newDimensions`, returns `{ jobId, pageCount }`. Already wired to `fastify.requireAdmin` + admin rate limit. | 1–33 |
| `backend/src/routes/llm/llm-embedding-reembed.test.ts` | Vitest + real Postgres. Asserts `jobId` starts with `reembed-`, validates `newDimensions=768` rewrites column & truncates. | 70–192 |
| `backend/src/core/services/queue-service.ts` | BullMQ wrapper. Registers `sync`, `quality`, `summary`, `maintenance`, stub `analytics-aggregation`. Exports `startQueueWorkers`, `stopQueueWorkers`, `getQueueMetrics`, `isBullMQEnabled`. **No `enqueueJob` API today.** Writes `job_history` rows (lines 63–81, migration 050). | 11–50, 94–183, 240–319 |
| `backend/src/core/db/migrations/050_job_history.sql` | Existing `job_history` table reused for outcome persistence. | full file |
| `backend/src/core/services/redis-cache.ts` | `acquireEmbeddingLock(userId) / releaseEmbeddingLock / isEmbeddingLocked`. Lock key pattern: `embedding:lock:${userId}` (line 45). 1-hour TTL safety cap. No listing helper today — we need to add `listActiveEmbeddingLocks()`. | 40–110 |
| `backend/src/core/services/admin-settings-service.ts` | `getEmbeddingDimensions()`. The admin_settings table is the canonical key/value store. | 1–23 |
| `backend/src/routes/foundation/admin.ts` | `GET/PUT /api/admin/settings` — surface for all existing tunables. The new `reembed_history_retention` key plugs in here. | 228–329 |
| `packages/contracts/src/schemas/admin.ts` | `AdminSettingsSchema` (line 18) + `UpdateAdminSettingsSchema` (line 44). Zod validators for admin settings API; frontend consumes typed shape. | full file |
| `backend/src/domains/llm/services/llm-provider-resolver.ts` | `resolveUsecase('embedding')` returns `{ config, model }`. Worker inherits it via `embedPage`. | 45–102 |
| `frontend/src/features/settings/panels/EmbeddingReembedBanner.tsx` | UI that triggers reembed. Today shows a "worker not implemented" warning (line 76). | full file |
| `frontend/src/features/settings/panels/EmbeddingTab.tsx` | Admin UI embedding settings panel. Host for the new retention-control field + lock-visibility banner. | around lines 48–129 |
| `backend/src/index.ts` | Boot order: `initLlmQueue()` → `buildApp()` → `startQueueWorkers()`. | 1–85 |
| `e2e/llm-providers.spec.ts` | Playwright E2E — chat-only today. | full file |

External ResearchPack (BullMQ v5, via Ref MCP — verified 2026-04-21):

- **Custom `jobId` = idempotency primitive.** `queue.add()` with an existing
  `jobId` is a no-op — BullMQ ignores it and (optionally) emits a
  `duplicated` event. Source:
  `taskforcesh/bullmq` `docs/gitbook/guide/jobs/job-ids.md`.
- **Reusability after completion.** From
  `docs/gitbook/guide/queues/auto-removal-of-jobs.md §"What about idempotence?"`:
  > "When you add a job with an id that exists already in the queue, the
  > new job is ignored and a **duplicated** event is triggered. … a job
  > that has been removed will not be considered part of the queue
  > anymore, and will not affect any future jobs that could have the
  > same Id."
  → Exactly the Q3 semantic we want: removed == reusable id. §2.2
  pins `removeOnComplete`/`removeOnFail` to make this happen.
- **Lazy removal caveat.** Same doc: "The auto removal of jobs works
  lazily. … jobs are not removed unless a new job completes or fails".
  → First post-completion `POST` may still collide if the previous
  completed job wasn't swept yet. §2.2 mitigates via an explicit
  `job.remove()` on the old record before enqueue (see Q3 mechanism).
- **`job.updateProgress(n | {…})`** official progress API. Listeners via
  `Worker.on('progress')` / `QueueEvents.on('progress')`. Source:
  `docs/gitbook/guide/workers/README.md#progress`.

---

## 2. Plan — surgical edits, file by file

### 2.1 `backend/src/core/services/redis-cache.ts` — list + force-release helpers

Needed for Q2 visibility (list) and Q2-follow-up (admin force-release). Add
after `isEmbeddingLocked` (~line 110):

```typescript
export interface EmbeddingLockSnapshot {
  userId: string;
  /** Lock identity token (random UUID written by acquireEmbeddingLock).
   *  Exposed so the worker can verify, before each write, that the lock it
   *  originally acquired is still the one in Redis (holder-epoch guard). */
  holderEpoch: string;
  /** Remaining TTL in ms. -1 means "no TTL" (shouldn't happen — SET NX EX
   *  always sets one; -2 means key doesn't exist). */
  ttlRemainingMs: number;
}

/**
 * List all per-user embedding locks currently held. Used by:
 *   1. Admin UI (`GET /api/admin/embedding/locks`) — render "alice, bob".
 *   2. `runReembedAllJob` wait-on-locks loop.
 *
 * Uses Redis SCAN (NOT KEYS) to avoid blocking Redis on large keyspaces.
 * See §7 open-Q3 for the future optimisation path if SCAN latency grows.
 * Returns `[]` when Redis is unavailable.
 */
export async function listActiveEmbeddingLocks(): Promise<EmbeddingLockSnapshot[]> {
  if (!_redisClient) return [];
  const out: EmbeddingLockSnapshot[] = [];
  try {
    let cursor = 0;
    do {
      const reply = await _redisClient.scan(cursor, {
        MATCH: 'embedding:lock:*',
        COUNT: 100,
      });
      cursor = Number(reply.cursor);
      for (const key of reply.keys) {
        const userId = key.slice('embedding:lock:'.length);
        if (!userId) continue;
        // Pipeline would be nicer but keyspaces are small (< 100 entries
        // typical). Two round-trips per key is fine for 5-sec polling.
        const [holderEpoch, pttl] = await Promise.all([
          _redisClient.get(key),
          _redisClient.pTTL(key),
        ]);
        out.push({
          userId,
          holderEpoch: holderEpoch ?? '',
          ttlRemainingMs: typeof pttl === 'number' ? pttl : -2,
        });
      }
    } while (cursor !== 0);
    return out;
  } catch (err) {
    logger.error({ err }, 'Failed to list active embedding locks');
    return [];
  }
}

/**
 * Admin escape hatch — force-delete a per-user embedding lock regardless of
 * holder. Unlike `releaseEmbeddingLock(userId, lockId)` (which refuses to
 * delete unless the caller's lockId matches the stored value via Lua), this
 * one unconditionally DELs the key. Use ONLY from admin-authenticated
 * routes; log to the audit trail on every call.
 *
 * Returns:
 *   - { released: true,  previousHolderEpoch: '<uuid>' } when the key existed.
 *   - { released: false, previousHolderEpoch: null     } when the key was
 *     already gone (idempotent — no 404).
 *
 * Safety contract (documented for operators):
 *   If the user's embedding worker is still genuinely running when this is
 *   called, the worker's next `embedPage` transaction will still commit (it
 *   doesn't re-check the lock between every row). A racing second acquirer
 *   of the same userId's lock would see a fresh `holderEpoch`; the original
 *   worker's write-guard (see §2.3 "Holder-epoch guard") detects this and
 *   aborts the loop. Duplicate rows in `page_embeddings` are prevented by
 *   the DELETE/INSERT transaction inside `embedPage` (see lines 370–409).
 */
export async function forceReleaseEmbeddingLock(
  userId: string,
): Promise<{ released: boolean; previousHolderEpoch: string | null }> {
  if (!_redisClient) {
    return { released: false, previousHolderEpoch: null };
  }
  try {
    const key = embeddingLockKey(userId);
    const previous = await _redisClient.get(key);
    const deleted = await _redisClient.del(key);
    return {
      released: deleted === 1,
      previousHolderEpoch: previous,
    };
  } catch (err) {
    logger.error({ err, userId }, 'Failed to force-release embedding lock');
    return { released: false, previousHolderEpoch: null };
  }
}
```

### 2.2 `backend/src/core/services/queue-service.ts` — enqueueJob + reembed-all worker

Add thin `enqueueJob` + `getJobStatus`. Register the `reembed-all` queue.

```diff
+/**
+ * Enqueue a one-off job onto a named queue. Returns the resolved job id.
+ *
+ * Idempotency: when the caller passes a `jobId`, BullMQ ignores the add if a
+ * job with that id is already in waiting/active/delayed. Removed jobs
+ * (completed/failed that have been swept via `removeOnComplete`/`removeOnFail`)
+ * do **not** block re-adds — which is exactly the "collapse concurrent, allow
+ * re-run after finish" semantic we want (see Q3 in plan §6).
+ */
+export async function enqueueJob(
+  queueName: string,
+  data: Record<string, unknown>,
+  opts?: { jobId?: string; removeOnComplete?: number; removeOnFail?: number },
+): Promise<string> {
+  if (!USE_BULLMQ) {
+    const fakeId = opts?.jobId ?? `${queueName}-${Date.now()}`;
+    const def = workerDefs.find((d) => d.queueName === queueName);
+    if (def) {
+      void def.processor({ id: fakeId, name: queueName, data,
+        updateProgress: async () => {}, remove: async () => {} } as unknown as Job);
+    }
+    return fakeId;
+  }
+  const q = getOrCreateQueue(queueName);
+
+  // Q3 mechanism: if a previous job with this id exists in a *terminal* state
+  // (completed / failed) we must explicitly remove it before re-adding,
+  // because BullMQ's auto-removal is lazy — it does not happen until the
+  // NEXT job finishes. Without this sweep, the second POST after a clean
+  // run would silently dedupe against the stale completed record.
+  //
+  // When the previous job is still waiting/active/delayed, DO NOT remove
+  // it: let the duplicate add be ignored so the second caller observes
+  // the same jobId (collapse-concurrent semantic).
+  if (opts?.jobId) {
+    const existing = await q.getJob(opts.jobId);
+    if (existing) {
+      const state = await existing.getState();
+      if (state === 'completed' || state === 'failed') {
+        await existing.remove().catch(() => { /* race-tolerant */ });
+      }
+    }
+  }
+
+  const addOpts: Record<string, unknown> = {};
+  if (opts?.jobId) addOpts.jobId = opts.jobId;
+  if (opts?.removeOnComplete !== undefined) addOpts.removeOnComplete = { count: opts.removeOnComplete };
+  if (opts?.removeOnFail !== undefined) addOpts.removeOnFail = { count: opts.removeOnFail };
+
+  const job = await q.add(queueName, data, addOpts);
+  return job.id ?? opts?.jobId ?? `${queueName}-${Date.now()}`;
+}
+
+/** Fetch a job's current status + progress. Returns null when unknown. */
+export async function getJobStatus(
+  queueName: string,
+  jobId: string,
+): Promise<
+  | {
+      state: string;
+      progress: number | object;
+      returnvalue: unknown;
+      failedReason?: string;
+    }
+  | null
+> {
+  if (!USE_BULLMQ) return null;
+  const q = queues.get(queueName) ?? getOrCreateQueue(queueName);
+  const job = await q.getJob(jobId);
+  if (!job) return null;
+  return {
+    state: await job.getState(),
+    progress: (job.progress ?? 0) as number | object,
+    returnvalue: job.returnvalue,
+    failedReason: job.failedReason,
+  };
+}
```

In `registerAllWorkers()`, add after `maintenance`:

```typescript
registerWorkerDef({
  queueName: 'reembed-all',
  concurrency: 1,
  processor: async (job: Job) => {
    const { runReembedAllJob } = await import(
      // eslint-disable-next-line boundaries/dependencies -- orchestrator
      '../../domains/llm/services/embedding-service.js'
    );
    return runReembedAllJob(job);
  },
});
```

### 2.3 `backend/src/domains/llm/services/embedding-service.ts`

Replace stub (lines 891–951 keep the dim-change transaction; only return path changes) + add worker entry point. Integrates **Q2** (per-user lock
coordination) and **Q4** (configurable retention).

```diff
 export async function enqueueReembedAll(
   opts: { newDimensions?: number } = {},
 ): Promise<string> {
-  const jobId = `reembed-${Date.now()}`;
+  // Fixed id → concurrent POSTs collapse (Q3).
+  const jobId = `reembed-all`;
   if (opts.newDimensions !== undefined) {
-    // … existing heavy dim-change transaction, unchanged …
+    // … existing heavy dim-change transaction, unchanged (lines 916–949) …
   }
-  return jobId;
+
+  // Q2: if per-user embedding locks are currently held, DO NOT start the
+  // worker yet — enqueue it with a short delay and include the offender
+  // list in the job data. The worker re-checks on start and keeps
+  // back-pressuring until locks clear. Surfaces to the UI via
+  // `GET /admin/embedding/reembed/:jobId`.
+  const { listActiveEmbeddingLocks } = await import('../../../core/services/redis-cache.js');
+  // v3: `listActiveEmbeddingLocks` now returns
+  //   Array<{ userId, holderEpoch, ttlRemainingMs }>.
+  // We pass only userIds into the BullMQ job data (the rest is UI-only,
+  // fetched fresh by the GET endpoint).
+  const heldBy = (await listActiveEmbeddingLocks()).map((l) => l.userId);
+
+  // Q4: read retention from admin_settings (default 150, range 10–10000).
+  const retention = await getReembedHistoryRetention();
+
+  const { enqueueJob } = await import('../../../core/services/queue-service.js');
+  await enqueueJob(
+    'reembed-all',
+    { triggeredAt: new Date().toISOString(), heldBy },
+    { jobId, removeOnComplete: retention, removeOnFail: retention },
+  );
+  return jobId;
+}
+
+/**
+ * Read the admin-configurable job-history retention setting.
+ * Default 150, clamped to [10, 10000]. See plan §2.6 for schema.
+ */
+async function getReembedHistoryRetention(): Promise<number> {
+  const r = await query<{ setting_value: string }>(
+    `SELECT setting_value FROM admin_settings WHERE setting_key='reembed_history_retention'`,
+  );
+  const raw = r.rows[0]?.setting_value;
+  const n = raw ? parseInt(raw, 10) : NaN;
+  if (!Number.isFinite(n)) return 150;
+  return Math.max(10, Math.min(10_000, n));
+}
+
+/**
+ * BullMQ worker entry point — registered in `queue-service.ts`.
+ *
+ * Q2 lock coordination:
+ *   Before the cursor loop, the worker polls `listActiveEmbeddingLocks()`
+ *   up to `REEMBED_WAIT_LOCKS_MS` (default 10 min). While it waits, it
+ *   emits `{ phase: 'waiting-on-user-locks', heldBy: string[] }` progress
+ *   events so the admin UI can show "waiting for alice, bob to finish".
+ *   If locks do not clear within the window, the job fails with a clear
+ *   message. The admin can retry or force-cancel user locks.
+ *
+ *   While the re-embed worker runs, its own Redis lock is held at the
+ *   special key `embedding:lock:__reembed_all__`. Per-user triggers
+ *   (`POST /embeddings/process`) already no-op via `isProcessingUser`
+ *   — we extend that check to also consider the reembed-all lock
+ *   (see §2.4 below). Net effect: only ONE embedding loop ever runs.
+ *
+ * Idempotency: the fixed `jobId='reembed-all'` + removeOnComplete
+ * together give "collapse concurrent, allow re-run after finish" (Q3).
+ */
+export async function runReembedAllJob(job: Job): Promise<string> {
+  const REEMBED_LOCK_USER = '__reembed_all__';
+  const WAIT_LOCKS_TIMEOUT_MS = parseInt(
+    process.env.REEMBED_WAIT_LOCKS_MS ?? '600000', 10,  // 10 min default
+  );
+  const POLL_INTERVAL_MS = 3_000;
+
+  const { listActiveEmbeddingLocks } = await import('../../../core/services/redis-cache.js');
+
+  // Wait-on-locks loop.
+  const waitStart = Date.now();
+  while (true) {
+    const held = (await listActiveEmbeddingLocks())
+      .filter((l) => l.userId !== REEMBED_LOCK_USER)
+      .map((l) => l.userId);
+    if (held.length === 0) break;
+    if (Date.now() - waitStart > WAIT_LOCKS_TIMEOUT_MS) {
+      throw new Error(
+        `reembed-all aborted: per-user embedding locks still held after ` +
+        `${Math.round(WAIT_LOCKS_TIMEOUT_MS / 60_000)}m by: ${held.join(', ')}`,
+      );
+    }
+    await job.updateProgress({
+      phase: 'waiting-on-user-locks',
+      heldBy: held,
+      waitedMs: Date.now() - waitStart,
+    });
+    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
+  }
+
+  const lockId = await acquireEmbeddingLock(REEMBED_LOCK_USER);
+  if (!lockId) {
+    // Lock appeared between the wait loop and here — treat as already running.
+    return 'already-running';
+  }
+
+  try {
+    // Mark every eligible page dirty (excludes folders + soft-deleted).
+    await query(
+      `UPDATE pages
+          SET embedding_dirty = TRUE,
+              embedding_status = 'not_embedded',
+              embedded_at = NULL,
+              embedding_error = NULL
+        WHERE deleted_at IS NULL
+          AND COALESCE(page_type, 'page') != 'folder'`,
+    );
+
+    const countRow = await query<{ c: string }>(
+      `SELECT COUNT(*)::text AS c FROM pages
+        WHERE embedding_dirty = TRUE AND deleted_at IS NULL
+          AND COALESCE(page_type, 'page') != 'folder'`,
+    );
+    const total = parseInt(countRow.rows[0]?.c ?? '0', 10);
+    await job.updateProgress({ total, processed: 0, failed: 0, phase: 'started' });
+
+    let processed = 0;
+    let failed = 0;
+    await processDirtyPages(REEMBED_LOCK_USER, (evt) => {
+      if (evt.type === 'progress') {
+        processed = evt.completed;
+        failed = evt.failed;
+        if ((processed + failed) % 100 === 0 || evt.percentage === 100) {
+          void job.updateProgress({ total, processed, failed, phase: 'embedding' });
+        }
+      }
+    });
+
+    await job.updateProgress({ total, processed, failed, phase: 'complete' });
+    return `processed=${processed} failed=${failed} total=${total}`;
+  } finally {
+    await releaseEmbeddingLock(REEMBED_LOCK_USER, lockId);
+  }
+}
```

Add `import type { Job } from 'bullmq';` at the top.

### 2.4 `backend/src/domains/llm/services/embedding-service.ts` — extend `isProcessingUser` check

Q2 bidirectional gating: per-user `POST /embeddings/process` must refuse
while the reembed-all worker holds `embedding:lock:__reembed_all__`.

```diff
 export async function isProcessingUser(userId: string): Promise<boolean> {
-  return isEmbeddingLocked(userId);
+  // Q2: block per-user triggers whenever ANY of these is held:
+  //   1. This user's own lock (existing behaviour).
+  //   2. The reembed-all system lock.
+  //
+  // Route handlers (`/embeddings/process`, `/embeddings/retry-failed`)
+  // already throw 409 when this returns true — so the reembed-all
+  // coordination is invisible to the user except for the 409 body
+  // (updated to mention "global re-embed in progress").
+  const [mine, reembedAll] = await Promise.all([
+    isEmbeddingLocked(userId),
+    isEmbeddingLocked('__reembed_all__'),
+  ]);
+  return mine || reembedAll;
+}
```

Companion: update the 409 body in `routes/llm/llm-embeddings.ts` to
differentiate: "Embedding processing is already in progress for this user"
vs "A global re-embed is in progress — per-user triggers are temporarily
disabled. Try again in a few minutes."

### 2.5 `backend/src/routes/llm/llm-embedding-reembed.ts` — add GET + locks in response

```diff
 fastify.post(
   '/admin/embedding/reembed',
   …
-  async (request) => {
+  async (request) => {
     const { newDimensions } = ReembedBodySchema.parse(request.body ?? {});
     const { rows } = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pages`);
     const pageCount = parseInt(rows[0]!.c, 10);
     const jobId = await enqueueReembedAll(newDimensions !== undefined ? { newDimensions } : {});
-    return { jobId, pageCount };
+
+    // Q2 (v3): surface per-user lock userIds so the UI can render
+    // "Embedding in progress: alice, bob — re-embed-all will start after
+    //  these complete." without a second round-trip. The richer
+    // `EmbeddingLockSnapshot[]` (with `holderEpoch` + `ttlRemainingMs`) is
+    // only exposed via `GET /api/admin/embedding/locks` (§2.10).
+    const { listActiveEmbeddingLocks } = await import(
+      '../../core/services/redis-cache.js'
+    );
+    const heldBy = (await listActiveEmbeddingLocks())
+      .filter((l) => l.userId !== '__reembed_all__')
+      .map((l) => l.userId);
+    return { jobId, pageCount, heldBy };
   },
 );
+
+fastify.get(
+  '/admin/embedding/reembed/:jobId',
+  { preHandler: fastify.requireAdmin },
+  async (request) => {
+    const { jobId } = request.params as { jobId: string };
+    const { getJobStatus } = await import('../../core/services/queue-service.js');
+    const { listActiveEmbeddingLocks } = await import(
+      '../../core/services/redis-cache.js'
+    );
+    const status = await getJobStatus('reembed-all', jobId);
+    const heldBy = (await listActiveEmbeddingLocks())
+      .filter((l) => l.userId !== '__reembed_all__')
+      .map((l) => l.userId);
+    if (!status) return { jobId, state: 'unknown', progress: null, heldBy };
+    return { jobId, ...status, heldBy };
+  },
+);
```

### 2.6 `packages/contracts/src/schemas/admin.ts` — new retention setting

Q4. Add one field to both read + write schemas:

```diff
 export const AdminSettingsSchema = z.object({
   embeddingDimensions: z.number().int().min(128).max(4096),
   …
+  reembedHistoryRetention: z.number().int().min(10).max(10_000),
 });

 export const UpdateAdminSettingsSchema = z.object({
   …
+  reembedHistoryRetention: z.number().int().min(10).max(10_000).optional(),
 });
```

### 2.7 `backend/src/routes/foundation/admin.ts` — wire the setting

```diff
 const result = await query<{ setting_key: string; setting_value: string }>(
   `SELECT setting_key, setting_value FROM admin_settings
-   WHERE setting_key IN ('embedding_chunk_size', 'embedding_chunk_overlap', 'drawio_embed_url', 'fts_language')`,
+   WHERE setting_key IN ('embedding_chunk_size', 'embedding_chunk_overlap', 'drawio_embed_url', 'fts_language', 'reembed_history_retention')`,
 );
 …
 return {
   embeddingDimensions,
   …
+  reembedHistoryRetention: parseInt(map['reembed_history_retention'] ?? '150', 10),
 };
```

And in the PUT handler, alongside `embeddingChunkSize` upsert:

```diff
+if (body.reembedHistoryRetention !== undefined) {
+  updates.push({
+    key: 'reembed_history_retention',
+    value: String(body.reembedHistoryRetention),
+  });
+}
```

### 2.8 Migration `055_reembed_history_retention.sql`

```sql
-- Migration 055: admin-configurable reembed-all job history retention (#257)
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('reembed_history_retention', '150', NOW())
ON CONFLICT (setting_key) DO NOTHING;
```

Additive, idempotent. Existing installs inherit default 150; explicit
override is honoured.

### 2.9 Frontend — `EmbeddingReembedBanner.tsx` + `EmbeddingTab.tsx` + new `ActiveEmbeddingLocksBanner.tsx`

**New component** `frontend/src/features/settings/panels/ActiveEmbeddingLocksBanner.tsx`:

- Polls `GET /api/embeddings/status` (or a new `GET /api/admin/embedding/locks` — see §6 open-Q) every 5 s.
- Renders when `heldBy.length > 0`.
- Displays "Embedding in progress: alice, bob — per-user triggers and
  re-embed-all will queue until these complete."
- Mounted above `EmbeddingReembedBanner` inside `EmbeddingTab.tsx`.
- Unmounts when `heldBy` is empty.

**`EmbeddingReembedBanner.tsx` updates** (drops v1 warning, adds polling):

1. Remove the "worker not yet implemented" warning block (v1 lines 72–95).
2. After a successful `POST /admin/embedding/reembed`, start a `setInterval`
   polling `GET /admin/embedding/reembed/:jobId` every 2 s.
3. Surface the `progress.phase`:
   - `'waiting-on-user-locks'` → "Waiting for alice, bob to finish
     (${waitedMs / 1000}s elapsed)"
   - `'embedding'` → "${processed}/${total} pages"
   - `'complete'` → green toast, stop polling.
4. Cancel polling on component unmount or after 30 min.

**`EmbeddingTab.tsx` updates** — add one new field in the embedding
settings section:

```tsx
<label>Re-embed job history retention
  <input
    type="number" min={10} max={10000} step={1}
    value={reembedHistoryRetention}
    onChange={(e) => setField('reembedHistoryRetention', parseInt(e.target.value, 10))}
  />
  <span className="help">
    Maximum completed/failed re-embed jobs retained in Redis before the
    oldest get swept. Takes effect on the next re-embed run.
  </span>
</label>
```

**`ActiveEmbeddingLocksBanner.tsx` — v3 additions (force-release UI).**

Per-lock row now renders a **"Force release"** button gated behind a
confirm modal. The banner consumes `EmbeddingLockSnapshot[]` from the
dedicated admin endpoint (§2.10, §3.2).

```tsx
// Pseudocode sketch — real implementation follows existing banner style.
{locks.map((lock) => (
  <li key={lock.userId} className="flex items-center justify-between gap-2">
    <span>
      {lock.userId} — holding for{' '}
      {Math.max(0, Math.round((EMBEDDING_LOCK_TTL_MS - lock.ttlRemainingMs) / 1000))}s
    </span>
    <button
      className="glass-button-danger text-xs"
      onClick={() => openConfirm({
        title: 'Force release embedding lock?',
        body: `This will abandon any in-flight embedding for user "${lock.userId}". `
            + `Their worker may continue writing a few rows before detecting the `
            + `release; no duplicate embeddings will be produced. Continue?`,
        confirmLabel: 'Force release',
        danger: true,
        onConfirm: () => postForceRelease(lock.userId),
      })}
    >
      Force release
    </button>
  </li>
))}
```

Confirm modal: reuse the existing `ConfirmDialog` / `AlertDialog` component
already used by `BulkOperations.tsx` and the delete-page flow (whichever
already exists in `frontend/src/shared/components/` — audit at implementation
time). Do not introduce a new modal primitive.

Polling cadence: 5 s (unchanged from v2).

### 2.10 New admin-only routes — `/api/admin/embedding/locks` (GET + force-release POST)

**File:** new `backend/src/routes/foundation/admin-embedding-locks.ts`
(or extend `admin.ts` — place alongside `admin_settings` routes since both
are foundation-scope admin).

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listActiveEmbeddingLocks,
  forceReleaseEmbeddingLock,
} from '../../core/services/redis-cache.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: async () => (await getRateLimits()).admin.max,
      timeWindow: '1 minute',
    },
  },
};

const UserIdParam = z.object({ userId: z.string().min(1).max(256) });

export async function adminEmbeddingLocksRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/admin/embedding/locks — list ALL active per-user embedding locks.
  // Admin-only. Polled by `ActiveEmbeddingLocksBanner` every 5s.
  fastify.get(
    '/admin/embedding/locks',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      // Filter out the synthetic `__reembed_all__` system lock — the UI
      // handles that one via the reembed-job GET, not the lock banner.
      const locks = (await listActiveEmbeddingLocks()).filter(
        (l) => l.userId !== '__reembed_all__',
      );
      return { locks };
    },
  );

  // POST /api/admin/embedding/locks/:userId/release — admin escape hatch.
  // Audit-logged on every call.
  fastify.post(
    '/admin/embedding/locks/:userId/release',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      const { userId } = UserIdParam.parse(request.params);

      const result = await forceReleaseEmbeddingLock(userId);

      await logAuditEvent(
        request.userId,
        'ADMIN_ACTION',
        'embedding_lock',
        userId,
        {
          action: 'force_release_embedding_lock',
          targetUserId: userId,
          released: result.released,
          previousHolderEpoch: result.previousHolderEpoch,
        },
        request,
      );

      // Idempotent: return 200 with `released: false` when the lock was
      // already gone, NOT 404. Avoids races where the lock releases
      // naturally between the banner-poll and the admin click.
      return { released: result.released, userId };
    },
  );
}
```

Register in `app.ts` alongside the other foundation routes (next to
`adminRoutes`).

**Holder-epoch guard — `embedPage` worker-side check** (small follow-up in
`backend/src/domains/llm/services/embedding-service.ts`):

The `acquireEmbeddingLock` call already returns a random UUID (the
"lockId") that is only used for the safe-release Lua script today. For v3
we also use it as the **holder-epoch** so a force-released worker can
detect it lost its lock and abort cleanly:

```typescript
// Inside processDirtyPages, between embedPage() calls:
//   Every 20 pages, re-read the lock key and compare.
//   If it's missing or mismatched, break the loop and log.
if (pagesProcessedSinceGuardCheck >= 20) {
  const stillMine = await redis.get(embeddingLockKey(userId));
  if (stillMine !== lockId) {
    logger.warn(
      { userId, expected: lockId, actual: stillMine },
      'Embedding lock was force-released or expired — aborting worker loop',
    );
    break; // exits the outer page-batch loop; finally block releases nothing
           // (already gone) via the safe-release Lua (no-op when mismatched).
  }
  pagesProcessedSinceGuardCheck = 0;
}
```

This is the minimum-intrusive change that gives the "release abort"
safety documented in `forceReleaseEmbeddingLock`. Check frequency every
20 pages matches the existing inter-page delay pattern; tune if test
coverage shows a tighter bound is worth the extra Redis round-trip.

**Important:** the `releaseEmbeddingLock` Lua script in the existing
codebase (redis-cache.ts:76) already does `get+compare+del`, so the
worker's `finally` block continues to work unchanged — it just no-ops
when the lock no longer matches, which is exactly what we want.

---

## 3. Admin settings, API endpoints, frontend surface — inventory

### 3.1 New `admin_settings` keys

| key | type | default | range | validation | migration |
|---|---|---|---|---|---|
| `reembed_history_retention` | integer (stored as text) | `150` | `[10, 10000]` | Zod int + server-side clamp in `getReembedHistoryRetention()` | `055_reembed_history_retention.sql` |

### 3.2 New / changed API endpoints

| method | path | auth | request | response | behaviour change |
|---|---|---|---|---|---|
| POST | `/api/admin/embedding/reembed` | `requireAdmin` + admin rate-limit | `{ newDimensions?: number }` | **changed**: `{ jobId, pageCount, heldBy: string[] }` | Adds `heldBy` userIds. Worker now actually runs. |
| **GET** (new) | `/api/admin/embedding/reembed/:jobId` | `requireAdmin` | path param | `{ jobId, state, progress, returnvalue?, failedReason?, heldBy: string[] }` | Progress polling. |
| **GET** (new, v3) | `/api/admin/embedding/locks` | `requireAdmin` + admin rate-limit | — | `{ locks: EmbeddingLockSnapshot[] }` where `EmbeddingLockSnapshot = { userId, holderEpoch, ttlRemainingMs }` | Q1: dedicated endpoint — does NOT extend `/api/embeddings/status`. Excludes the synthetic `__reembed_all__` system lock. |
| **POST** (new, v3) | `/api/admin/embedding/locks/:userId/release` | `requireAdmin` + admin rate-limit | path param: userId | `{ released: boolean, userId }` (200 on both; idempotent) | Q2-follow-up: admin escape-hatch. Audit-logged as `ADMIN_ACTION` / `embedding_lock` / `force_release_embedding_lock`. |
| GET | `/api/admin/settings` | `requireAdmin` | — | **changed**: adds `reembedHistoryRetention: number` | Additive. |
| PUT | `/api/admin/settings` | `requireAdmin` | **changed**: accepts `reembedHistoryRetention?` | `{ message }` | Additive. |
| GET | `/api/embeddings/status` | `authenticate` | — | unchanged | v3: NOT extended — dedicated admin endpoint instead. |

Rate limits: admin routes share `ADMIN_RATE_LIMIT` (existing decorator).
`retry-failed` / `process` route semantics unchanged (still 409 when
`isProcessingUser` true); only the 409 body text is updated to differentiate
"user's own lock" vs "global re-embed in progress".

### 3.3 New / changed frontend components

| component | status | consumes | purpose |
|---|---|---|---|
| `ActiveEmbeddingLocksBanner.tsx` | **new** | `GET /api/admin/embedding/locks` → `{ locks: EmbeddingLockSnapshot[] }` (polled every 5 s) | Shows "Embedding in progress: alice, bob" when any per-user lock is held, with a per-row **Force release** button (v3) gated behind a confirm modal. |
| `EmbeddingReembedBanner.tsx` | **changed** | `/admin/embedding/reembed/:jobId` | Drops v1 warning, polls progress, surfaces `waiting-on-user-locks` + `embedding` + `complete` phases. |
| `EmbeddingTab.tsx` | **changed** | `AdminSettingsSchema.reembedHistoryRetention` + admin-only surface | Adds the retention-number input and mounts `ActiveEmbeddingLocksBanner` above `EmbeddingReembedBanner`. |
| existing `ConfirmDialog` / `AlertDialog` | **reused** | — | Confirm modal for force-release. No new primitive. |

**Type export:** add `EmbeddingLockSnapshot` to `packages/contracts/src/schemas/admin.ts`
(or a new `…/schemas/embedding-locks.ts` if reviewer prefers a dedicated
module) so the frontend imports the type instead of redeclaring. Zod
shape:

```ts
export const EmbeddingLockSnapshotSchema = z.object({
  userId: z.string(),
  holderEpoch: z.string(),
  ttlRemainingMs: z.number().int(),
});
export type EmbeddingLockSnapshot = z.infer<typeof EmbeddingLockSnapshotSchema>;

export const AdminEmbeddingLocksResponseSchema = z.object({
  locks: z.array(EmbeddingLockSnapshotSchema),
});

export const ForceReleaseLockResponseSchema = z.object({
  released: z.boolean(),
  userId: z.string(),
});
```

No new prop shapes on existing components besides the changes above.

---

## 4. New tests (TDD — RED first)

### 4.1 Unit: `backend/src/domains/llm/services/embedding-service.test.ts`

- **RED #1**: `runReembedAllJob` on 2 pages + 1 folder → `processed === 2`, `job.updateProgress` called with `phase: 'complete'`.
- **RED #2** (Q2): With `acquireEmbeddingLock('alice')` held, worker emits `{ phase: 'waiting-on-user-locks', heldBy: ['alice'] }` and waits. Release lock → worker proceeds to `'embedding'` phase. Use a short `REEMBED_WAIT_LOCKS_MS` env override.
- **RED #3** (Q2 timeout): With lock held for longer than `REEMBED_WAIT_LOCKS_MS`, worker throws `reembed-all aborted: per-user embedding locks still held …`.
- **RED #4** (Q4): Custom `reembed_history_retention='250'` in admin_settings → `enqueueJob` called with `removeOnComplete: 250`. Default path (unset) → `150`.

### 4.2 Unit: `backend/src/core/services/queue-service.test.ts`

- **RED #5** (Q3 core): `enqueueJob('reembed-all', {}, { jobId: 'x' })` while a previous 'x' is in `completed` state → old record removed before new add, second add succeeds, third add (while new one is `active`) no-ops (returns same id, no new `Queue.add` call).
- **RED #6**: `getJobStatus` returns `null` for unknown queue.

### 4.3 Unit: `backend/src/core/services/redis-cache.test.ts`

- **RED #7** (v3 signature): `listActiveEmbeddingLocks()` returns
  `EmbeddingLockSnapshot[]` with `{ userId, holderEpoch, ttlRemainingMs }`
  for each `SET NX`-acquired lock. After `releaseEmbeddingLock` on the
  same user → returns `[]`. Assert `holderEpoch` matches the lockId
  returned by `acquireEmbeddingLock`. Assert `ttlRemainingMs` is > 0 and
  ≤ `EMBEDDING_LOCK_TTL * 1000`. Uses real Redis.
- **RED #7b** (v3 new): `forceReleaseEmbeddingLock('alice')` when alice
  holds a lock → returns `{ released: true, previousHolderEpoch: '<uuid>' }`
  and key is gone from Redis. Calling it a second time (idempotent) →
  `{ released: false, previousHolderEpoch: null }`. Calling it when Redis
  is unavailable → `{ released: false, previousHolderEpoch: null }`
  (no throw).

### 4.4 Route test: `backend/src/routes/llm/llm-embedding-reembed.test.ts`

- **RED #8**: `POST /admin/embedding/reembed` twice in flight → identical `jobId` both times.
- **RED #9** (Q3): After first run completes, second `POST` returns the **same** `jobId='reembed-all'` but enqueues a NEW BullMQ job (verified via `GET /admin/embedding/reembed/:jobId` showing fresh `state='waiting'|'active'`).
- **RED #10** (Q2 surface): `POST` returns `heldBy: ['alice']` when alice's lock is held. `GET /admin/embedding/reembed/:jobId` returns the same `heldBy` field (string[], filtered to exclude `__reembed_all__`).

### 4.5 Route test: `backend/src/routes/foundation/admin.test.ts`

- **RED #11** (Q4): `PUT /api/admin/settings` with `reembedHistoryRetention: 500` persists. GET reflects it. Out-of-range value (e.g. `5`) returns 400.

### 4.6 Route test: `backend/src/routes/foundation/admin-embedding-locks.test.ts` (new)

- **RED #11a** (v3, GET): `GET /api/admin/embedding/locks` with admin token → returns `{ locks: [{ userId: 'alice', holderEpoch: '…', ttlRemainingMs: <positive> }] }` when alice holds a lock.
- **RED #11b** (v3, GET excludes system): The synthetic `__reembed_all__` lock acquired by the worker is filtered out of the GET response.
- **RED #11c** (v3, force-release happy path): `POST /api/admin/embedding/locks/alice/release` with admin token → 200, `{ released: true, userId: 'alice' }`. Lock key gone from Redis. `audit_log` contains an `ADMIN_ACTION` / `embedding_lock` / `force_release_embedding_lock` row with `targetUserId: 'alice'`.
- **RED #11d** (v3, force-release idempotent / non-existent): `POST .../:userId/release` when no lock exists → 200, `{ released: false, userId }`. Still writes an audit row (so deliberate no-ops are observable).
- **RED #11e** (v3, non-admin forbidden): Member token on either GET or POST → 403. No audit row created on the forbidden request.
- **RED #11f** (v3, rate-limited): Excessive POSTs hit `ADMIN_RATE_LIMIT` → 429.

### 4.7 Unit: holder-epoch worker guard (extend `embedding-service.test.ts`)

- **RED #11g** (v3): Acquire a lock as user 'alice', start `processDirtyPages('alice', …)` with fake pages. After N pages, call `forceReleaseEmbeddingLock('alice')` from the test. Assert: the worker's loop exits within its next 20-page guard-check window; no `throw`; `finally` block's `releaseEmbeddingLock` is a safe no-op (Lua mismatch path). Remaining pages left in their pre-worker state (embedding_dirty = TRUE still).

### 4.8 Contract test: `packages/contracts/src/schemas/admin.test.ts`

- **RED #12**: `AdminSettingsSchema.parse` accepts valid retention. `UpdateAdminSettingsSchema.parse({ reembedHistoryRetention: 100 })` valid; `= 9` rejected; `= 10001` rejected.
- **RED #12a** (v3): `EmbeddingLockSnapshotSchema` / `AdminEmbeddingLocksResponseSchema` / `ForceReleaseLockResponseSchema` round-trip through `parse` with sample payloads.

### 4.9 E2E: `e2e/llm-providers.spec.ts`

Extend with: admin triggers re-embed, polls, asserts
`state === 'completed'` within 60 s. Mirrors v1 §3.4.

### 4.10 Frontend: component tests (Vitest + jsdom)

- **RED #13** (v3 updated): `ActiveEmbeddingLocksBanner` given `locks = [{ userId: 'alice', holderEpoch: 'uuid', ttlRemainingMs: 500_000 }]` renders "alice" row with a visible **Force release** button. Given `locks = []`, component renders nothing.
- **RED #14**: `EmbeddingReembedBanner` surfaces `waiting-on-user-locks` message when the polled job payload has that phase.
- **RED #14a** (v3 new): Clicking "Force release" on a lock row opens the confirm modal; clicking cancel closes it without any fetch; clicking confirm fires `POST /api/admin/embedding/locks/alice/release`. After the POST resolves `{ released: true }`, the row disappears on the next poll (mock the fetcher to return empty `locks`).
- **RED #14b** (v3 new): When the force-release POST returns a non-2xx (403/500), the modal surfaces an error toast and leaves the lock row in place.

---

## 5. Rollback procedure

1. `git revert <range>` reverts all of:
   - `backend/src/core/services/queue-service.ts` (additive `enqueueJob` + worker def).
   - `backend/src/core/services/redis-cache.ts` (additive `listActiveEmbeddingLocks`).
   - `backend/src/domains/llm/services/embedding-service.ts` (stub + new helpers).
   - `backend/src/routes/llm/llm-embedding-reembed.ts` (GET route).
   - `backend/src/routes/foundation/admin.ts` (setting wiring).
   - `packages/contracts/src/schemas/admin.ts` (Zod field).
   - Frontend components + banner.
2. Migration `055_reembed_history_retention.sql` is idempotent & additive;
   the `admin_settings` row can remain (no harm) or be manually deleted:
   `DELETE FROM admin_settings WHERE setting_key='reembed_history_retention';`.
   No schema DDL to revert.
3. Partial rollback: setting `USE_BULLMQ=false` restores inline-execution
   fallback for the enqueue path.

---

## 6. Acceptance-criteria checklist

- [ ] `POST /api/admin/embedding/reembed` enqueues & runs a BullMQ worker.
      (§2.2, §2.3)
- [ ] Worker cursors all pages, calls `embedText` via the existing client.
      (§2.3 reuses `processDirtyPages`)
- [ ] Progress emitted every 100 pages. (§2.3 throttle)
- [ ] Frontend banner polls progress. (§2.9 + §3.2)
- [ ] Concurrent POSTs collapse to same `jobId`. (Q3 — §2.2, §4.2 RED #5, §4.4 RED #8)
- [ ] Post-completion POST enqueues a fresh run. (Q3 — §2.2 explicit remove, §4.4 RED #9)
- [ ] E2E completion within 60s. (§4.9)
- [ ] Worker waits for / respects per-user locks. (Q2 — §2.3, §4.1 RED #2/#3)
- [ ] Per-user triggers gated while reembed-all runs. (Q2 — §2.4)
- [ ] Admin UI shows active-lock list via **dedicated** `/api/admin/embedding/locks`. (v3-Q1 — §2.10, §4.6 RED #11a, §4.10 RED #13)
- [ ] Admin can force-release a user lock; action is audit-logged; idempotent on non-existent. (v3-Q2 — §2.10, §4.6 RED #11c/#11d, §4.10 RED #14a)
- [ ] Force-released worker aborts cleanly (no dup rows, no throw). (v3-Q2 write-guard — §2.10 holder-epoch guard, §4.7 RED #11g)
- [ ] Retention configurable from admin settings. (Q4 — §2.6–§2.8, §4.5 RED #11)

---

## 7. Risks + open questions

### 7.1 Resolved in v3 (noted for reviewer traceability)

- **(resolved, v3-Q1) Lock-listing endpoint placement.** Dedicated
  `GET /api/admin/embedding/locks` — NOT an extension of
  `/api/embeddings/status`. §2.10, §3.2.
- **(resolved, v3-Q2) Admin force-release.** In scope.
  `POST /api/admin/embedding/locks/:userId/release` with audit logging +
  holder-epoch write-guard on the embedding worker. §2.1
  (`forceReleaseEmbeddingLock`), §2.10 (routes + worker guard), §4.6,
  §4.7.

### 7.2 Remaining risks

1. **SCAN cost on Redis (accepted as-is, v3-Q3).** `listActiveEmbeddingLocks`
   uses SCAN `MATCH embedding:lock:* COUNT 100`. O(N) across the whole
   keyspace; fine today (admin poll cadence 5 s, expected ≤ 100 locks).
   **Upgrade path if this ever hurts:** maintain a dedicated
   `SADD embedding:locks:active <userId>` set alongside each `SET NX`
   lock write (with matching `SREM` on release + a reconciling sweep on
   boot to handle crashes). Switch `listActiveEmbeddingLocks` to
   `SMEMBERS` + per-key `GET` / `PTTL`. **Revisit heuristic:** if the
   `/api/admin/embedding/locks` P99 latency exceeds **50 ms** in
   production or the SCAN `COUNT` tuning becomes load-bearing.
2. **Force-release race (documented trade-off).** `forceReleaseEmbeddingLock`
   unconditionally DELs the Redis key. If the victim worker is
   mid-`embedPage` when the key is deleted, it still finishes the
   in-flight page transaction (the DELETE/INSERT inside `embedPage`
   already prevents duplicate `page_embeddings` rows). The holder-epoch
   guard (§2.10) catches the release within at most 20 pages, aborting
   the loop. Worst-case: ≤ 20 pages get their embeddings rewritten by a
   soon-to-abort worker. Acceptable for an admin escape-hatch. UI
   confirm-modal body text explicitly calls this out.
3. **BullMQ lazy-removal edge case.** The explicit `existing.remove()` in
   `enqueueJob` races against the next job's auto-removal sweep. Both
   operations are idempotent (`del` vs `del`) and the `.catch(() => {})`
   swallows the race. Verified safe per BullMQ docs; call out in review.
4. **Setting change timing.** Retention changes take effect on the
   **next** enqueue (reads `admin_settings` inside `enqueueReembedAll`,
   §2.3). Existing queued jobs carry the old retention until they
   complete — documented in the field's help-text.
5. **Multi-instance deployment.** BullMQ handles this natively (Redis
   coordination). `listActiveEmbeddingLocks` /
   `forceReleaseEmbeddingLock` are Redis-native.
   `acquireEmbeddingLock(__reembed_all__)` is atomic via `SET NX`. No
   single-instance assumption. Flag: make sure CI runs Redis.
6. **`page_type='folder'` exclusion.** Current code uses
   `COALESCE(page_type, 'page') != 'folder'`. Worker uses same filter —
   consistency preserved.
7. **Job removal after explicit failure.** If `runReembedAllJob` throws,
   BullMQ retries per queue config (default: no retries). The first POST
   after that keeps the same `jobId` and collapses into the failed record
   unless we remove it. `enqueueJob` §2.2 handles both `completed` and
   `failed` — correct.
8. **Audit log on forbidden attempts (§4.6 RED #11e).** Non-admin POSTs
   to the force-release route get a 403 from `requireAdmin` *before* the
   handler runs → no audit row. If auditing denied attempts is desired,
   wire it at the `requireAdmin` decorator level (cross-cutting, out of
   scope for #257). Called out for reviewer.

---

## 8. Dependency on #258

See #258's §7 for the reverse summary. Short version:

- **#257 lands first.** Unblocks the dimension-change banner. Reuses the
  `openai-compatible-client.ts` queue+breaker wrapping that #256 already
  shipped.
- **#258 is mostly tests + cleanup** around the same wrapping —
  non-breaking relative to #257.
- **Shared scaffolding:** the local-HTTP stub pattern from
  `openai-compatible-client.test.ts` is reused across both plans; keep
  it inline in each test for now and extract if a 3rd consumer appears.

---

## 9. Changelog

### v1 → v2

- **Q2 integrated** (§2.1 new `listActiveEmbeddingLocks`, §2.3 worker
  wait-on-locks loop, §2.4 bidirectional `isProcessingUser`, §2.5 `heldBy`
  in API response, §2.9 new `ActiveEmbeddingLocksBanner` component).
- **Q3 integrated** (§2.2 explicit completed/failed job removal before
  re-add; research citation of BullMQ "lazy removal" doc; RED #5 + RED #9
  cover the post-completion re-run path).
- **Q4 integrated** (new `reembed_history_retention` admin setting;
  §2.6 Zod, §2.7 route wiring, §2.8 migration, §2.9 UI field; default 150,
  range [10, 10000]; read per-enqueue so changes take effect on next run).
- New §3 inventory table (admin settings / endpoints / components) per
  user ask.
- Test list expanded from 6 → 14 RED cases.
- Two new open questions (lock-listing endpoint placement; admin force-release).

### v2 → v3

- **v3-Q1 resolved, dedicated endpoint.** `GET /api/admin/embedding/locks`
  is a new admin-only route (§2.10). `/api/embeddings/status` is NOT
  extended — the §3.2 "TBD" row is resolved. Response is
  `{ locks: EmbeddingLockSnapshot[] }` where each snapshot carries
  `userId` + `holderEpoch` + `ttlRemainingMs`.
- **v3-Q2 resolved, folded into #257.** New admin-only
  `POST /api/admin/embedding/locks/:userId/release` with audit logging
  (`ADMIN_ACTION` / `embedding_lock` / `force_release_embedding_lock`).
  §2.1 adds `forceReleaseEmbeddingLock` helper. §2.10 adds the route file
  + worker-side **holder-epoch guard** (re-reads the lock every 20 pages
  inside `processDirtyPages` and breaks the loop on mismatch) so a
  force-released worker aborts without throwing and without duplicate
  writes. UI: per-row "Force release" button in
  `ActiveEmbeddingLocksBanner` gated by existing `ConfirmDialog`
  primitive.
- **v3-Q3 noted, no code change.** SCAN-based `listActiveEmbeddingLocks`
  kept. §7.2 Risk #1 adds the upgrade-path note (dedicated
  `embedding:locks:active` set) with the 50 ms P99 revisit heuristic.
- **Type exports added** to `packages/contracts/src/schemas/admin.ts`:
  `EmbeddingLockSnapshotSchema`, `AdminEmbeddingLocksResponseSchema`,
  `ForceReleaseLockResponseSchema`. §3.3 + §4.8 RED #12a.
- **§1 ResearchPack** line for `redis-cache.ts` updated to note the
  `SET NX EX` + Lua safe-release pattern already in place (line 76)
  is what makes the holder-epoch guard cheap to add.
- **§2.1 signature breaking change** inside this PR:
  `listActiveEmbeddingLocks` returns `EmbeddingLockSnapshot[]` instead
  of `string[]`. Call-sites in §2.3 (worker wait loop) and §2.5 (POST
  + GET reembed routes) updated in the diff to `.map((l) => l.userId)`.
- **Tests:** 14 REDs → 20 REDs. New:
  #7b (`forceReleaseEmbeddingLock` unit), #11a–#11f (new route-test file
  `admin-embedding-locks.test.ts`), #11g (worker holder-epoch guard),
  #12a (contract schema), #14a / #14b (frontend confirm modal +
  error-toast).
- **§6 acceptance checklist** expanded with three new bullets (dedicated
  endpoint, force-release + audit, worker abort safety).
- **§7 open questions** reorganised: §7.1 resolved items pinned for
  reviewer traceability; §7.2 renumbered remaining risks; new risk #2
  (force-release race trade-off, documented); new risk #8 (forbidden
  attempts not audit-logged — cross-cutting, flagged).
- No schema changes — migration `055` unchanged.
