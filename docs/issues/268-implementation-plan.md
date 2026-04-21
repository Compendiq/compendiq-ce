# Implementation Plan — Issue #268: per-user concurrent-SSE-stream limit

> Target branch: `feature/268-sse-concurrent-limit` → PR to `dev`.
> Scope: bound the number of concurrent SSE streams per `userId` via a Redis counter. Reject 4th+ with 429. Admin-configurable cap via `admin_settings`. No admin bypass. Graceful lowering. Self-heal via TTL.
>
> **Decisions locked (v2, 2026-04-21):**
> - No admin bypass — admins share the same cap.
> - Cap is admin-configurable through Settings → LLM UI (not env-var only). Env var `LLM_MAX_CONCURRENT_STREAMS_PER_USER` becomes a **deprecated bootstrap fallback** — consulted only when the `admin_settings` row is absent.
> - Lowering the cap at runtime is graceful: in-flight streams continue to completion; new opens see the new cap.

---

## 1. ResearchPack

Line numbers verified on `feature/258-llm-queue-breakers` (`19b8c87`).

### 1.1 SSE call sites (unchanged from v1)

Six handlers stream LLM output via `streamChat()` + `reply.hijack()`:

| File:line | Route | Shared helper |
|---|---|---|
| `backend/src/routes/llm/llm-ask.ts:38, 238–310` | `POST /api/llm/ask` | inline (RAG-cache coordination) |
| `backend/src/routes/llm/llm-generate.ts:30, 120–122` | `POST /api/llm/generate` | shared `streamSSE` |
| `backend/src/routes/llm/llm-improve.ts:121` (per Grep) | `POST /api/llm/improve` | shared `streamSSE` |
| `backend/src/routes/llm/llm-summarize.ts:96` | `POST /api/llm/summarize` | shared `streamSSE` |
| `backend/src/routes/llm/llm-quality.ts:65` | `POST /api/llm/analyze-quality` | shared `streamSSE` |
| `backend/src/routes/llm/llm-diagram.ts:64` | `POST /api/llm/generate-diagram` | shared `streamSSE` |

### 1.2 Gate must live above `reply.hijack()`

Increment must happen *before* `reply.hijack()` so a 429 is a normal Fastify JSON reply. Shape:
```typescript
const slot = await acquireStreamSlot(request.userId);
if (!slot.acquired) {
  return reply.code(429).send({ error: 'too_many_concurrent_streams', message: '…' });
}
try { … existing body … } finally { await slot.release(); }
```

### 1.3 Admin-settings pattern to reuse

**Reuse the `rate-limit-service.ts` cascade pattern verbatim** (`backend/src/core/services/rate-limit-service.ts:49–74`):
- DB key in `admin_settings` (text value; parsed int; default-fallback on NaN).
- 60-second in-process TTL cache.
- `upsertX()` helper invalidates cache + audit-logs.
- `_resetCache()` for tests.

Mirrors `reembed_history_retention` (PR #261, `055_admin_settings_reembed_retention.sql`) and the existing `rate_limit_*` keys.

Canonical admin-settings key: **`llm_max_concurrent_streams_per_user`** (integer, stored as text). Default `3`, min `1`, max `20`.

### 1.4 Read-resolution cascade (locked)

```
admin_settings.llm_max_concurrent_streams_per_user   (authoritative)
  → process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER  (deprecated bootstrap fallback)
  → 3                                                (hard-coded default)
```

Mirrors the documented cascade for `DEFAULT_LLM_MODEL`, `QUALITY_MODEL`, `SUMMARY_MODEL`, `COMPENDIQ_LICENSE_KEY` (`CLAUDE.md:253, 257, 260, 278`).

### 1.5 Migration numbering

`dev` is at `054_llm_providers.sql`. PR #261 owns `055_admin_settings_reembed_retention.sql`. This plan allocates **`056_admin_settings_llm_stream_cap.sql`**. #264 allocates `057`. Swap if one PR stalls — flagged in §6.

### 1.6 External research — lifecycle + counter

Fastify SSE abort: `request.raw.on('close', …)` fires for both client-abort and server-done. Existing wiring at `_helpers.ts:167–168` + `llm-ask.ts:235–236` — reuse. (`https://github.com/fastify/fastify/blob/main/docs/Guides/Detecting-When-Clients-Abort.md`.)

Redis counter: Lua `INCR` + over-cap `DECR` + `EXPIRE` — atomic, one round-trip. Release: plain `DECR`. Pattern consistent with `recordAttachmentFailure()` at `redis-cache.ts:173–186`.

### 1.7 UI location — Settings → LLM tab

- Panel root: `frontend/src/features/settings/panels/LlmTab.tsx` (co-located with provider + use-case assignments — confirmed via `frontend/src/features/settings/panels/` listing).
- **Do not create a new sub-tab.** Append a small "Runtime limits" card (or extend an existing one) to `LlmTab.tsx`.
- A single numeric input: "Max concurrent AI streams per user" (min 1, max 20), with inline helper text: *"Rejects additional streams with 429. Lowering takes effect for newly opened streams; in-flight streams continue."*
- Wire through the existing `GET /api/admin/settings` → TanStack-Query pattern used by other entries in the same file (e.g. embedding chunk size already rides on `AdminSettingsSchema`).

### 1.8 Interaction with `LLM_STREAM_RATE_LIMIT`

Different concept. `_helpers.ts:24` caps *requests per minute* via `@fastify/rate-limit`. #268 caps *concurrent connections*. Both stay. They return 429 for different reasons — distinguished via `error` body string (`too_many_concurrent_streams` vs rate-limit's default).

---

## 2. Step-by-step surgical edits

### Step 2.1 — Zod schema updates

`packages/contracts/src/schemas/admin.ts`. Append to both `AdminSettingsSchema` (read) and `UpdateAdminSettingsSchema` (write):

```diff
 export const AdminSettingsSchema = z.object({
   …
   rateLimitLlmStream: z.number().int().min(1).max(1000).optional(),
   rateLimitLlmEmbedding: z.number().int().min(1).max(1000).optional(),
+  // Per-user concurrent SSE-stream cap (#268). Separate from rateLimitLlmStream:
+  // that caps requests/minute; this caps concurrent connections.
+  llmMaxConcurrentStreamsPerUser: z.number().int().min(1).max(20).optional(),
 });

 export const UpdateAdminSettingsSchema = z.object({
   …
   rateLimitLlmEmbedding: z.number().int().min(1).max(1000).optional(),
+  llmMaxConcurrentStreamsPerUser: z.number().int().min(1).max(20).optional(),
 });
```

### Step 2.2 — migration `056_admin_settings_llm_stream_cap.sql`

`backend/src/core/db/migrations/056_admin_settings_llm_stream_cap.sql`:

```sql
-- Migration 056: per-user concurrent SSE-stream cap (#268)
--
-- Seeds the admin-configurable cap for the new per-user SSE-stream limiter.
-- Range (enforced by Zod): [1, 20]. Default: 3.
--
-- Read cascade:
--   admin_settings.llm_max_concurrent_streams_per_user
--     → env LLM_MAX_CONCURRENT_STREAMS_PER_USER (deprecated fallback)
--     → 3 (hard default)
--
-- Additive + idempotent.
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('llm_max_concurrent_streams_per_user', '3', NOW())
ON CONFLICT (setting_key) DO NOTHING;
```

### Step 2.3 — new module `sse-stream-limiter.ts`

`backend/src/core/services/sse-stream-limiter.ts`:

```typescript
/**
 * Per-user concurrent SSE-stream limiter (issue #268).
 *
 * Streaming LLM calls intentionally bypass the LLM queue (openai-compatible-
 * client.ts:94–102). This module caps simultaneously-open streams per user.
 *
 * Cap cascade:
 *   admin_settings.llm_max_concurrent_streams_per_user → authoritative
 *   process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER    → deprecated fallback
 *   3                                                  → hard default
 *
 * Redis key: `llm:streams:<userId>`. TTL: 1h — self-heals on process crash.
 *
 * Lowering the cap at runtime is graceful: existing in-flight streams
 * continue; only new opens see the new cap.
 */
import { getRedisClient } from './redis-cache.js';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

const STREAM_COUNTER_TTL_SECONDS = 3600;
const CACHE_TTL_MS = 60_000;
const HARD_DEFAULT = 3;
const DB_KEY = 'llm_max_concurrent_streams_per_user';

let capCache: { value: number; expiresAt: number } | null = null;

/** Admin_settings → env → default cascade, 60s cache. */
export async function getStreamCap(): Promise<number> {
  if (capCache && Date.now() < capCache.expiresAt) return capCache.value;

  let resolved = HARD_DEFAULT;
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
      [DB_KEY],
    );
    const db = r.rows[0]?.setting_value;
    if (db) {
      const n = parseInt(db, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 20) resolved = n;
    } else {
      const env = process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER;
      if (env) {
        const n = parseInt(env, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 20) resolved = n;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve stream cap; using default');
  }

  capCache = { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS };
  return resolved;
}

/** Called by the admin-settings PUT handler after writing the new value. */
export function invalidateStreamCapCache(): void {
  capCache = null;
}

function key(userId: string): string {
  return `llm:streams:${userId}`;
}

// Atomic acquire — Lua avoids the "two clients race past cap by one" classic.
// KEYS[1] = llm:streams:<userId>
// ARGV[1] = cap, ARGV[2] = ttl seconds
// Returns 1 acquired, 0 rejected.
const ACQUIRE_SCRIPT = `
  local n = redis.call("incr", KEYS[1])
  if n > tonumber(ARGV[1]) then
    redis.call("decr", KEYS[1])
    return 0
  end
  redis.call("expire", KEYS[1], ARGV[2])
  return 1
`;

export interface StreamSlot {
  acquired: boolean;
  release: () => Promise<void>;
}

// Fail-open: rejecting streams when Redis is down is worse than temporarily
// exceeding the cap. Consistent with acquireEmbeddingLock (redis-cache.ts:55–71).
function fallbackSlot(): StreamSlot {
  return { acquired: true, release: async () => {} };
}

export async function acquireStreamSlot(userId: string): Promise<StreamSlot> {
  const redis = getRedisClient();
  if (!redis) {
    logger.warn({ userId }, 'Redis unavailable; skipping SSE-stream cap check (fail-open)');
    return fallbackSlot();
  }
  const cap = await getStreamCap();
  try {
    const result = await redis.eval(ACQUIRE_SCRIPT, {
      keys: [key(userId)],
      arguments: [String(cap), String(STREAM_COUNTER_TTL_SECONDS)],
    });
    if (result !== 1) return { acquired: false, release: async () => {} };
    let released = false;
    return {
      acquired: true,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await redis.decr(key(userId));
        } catch (err) {
          logger.error({ err, userId }, 'Failed to DECR SSE-stream counter — will self-heal via TTL');
        }
      },
    };
  } catch (err) {
    logger.error({ err, userId }, 'acquireStreamSlot eval failed — failing open');
    return fallbackSlot();
  }
}

/** Test-only cache reset. */
export function _resetStreamCapCache(): void {
  capCache = null;
}
```

### Step 2.4 — admin-settings GET/PUT wiring

`backend/src/routes/foundation/admin.ts`:

- Extend the `SELECT … WHERE setting_key IN (…)` block (lines ~237, 284) to include `'llm_max_concurrent_streams_per_user'`.
- Extend the returned map (line ~248 pattern) with `llmMaxConcurrentStreamsPerUser: parseInt(map['llm_max_concurrent_streams_per_user'] ?? '3', 10)`.
- Extend the PUT handler (line ~328 pattern): on `body.llmMaxConcurrentStreamsPerUser !== undefined`, push `{ key: 'llm_max_concurrent_streams_per_user', value: String(body.llmMaxConcurrentStreamsPerUser) }`, and after the DB write call `invalidateStreamCapCache()` from `sse-stream-limiter.ts`. Audit-log alongside the existing `ADMIN_ACTION` for settings updates.

Parameterised SQL only (matches existing `INSERT … ON CONFLICT` pattern).

### Step 2.5 — wire into each of six handlers

Shape (illustrated on `llm-ask.ts`; repeat for `llm-generate.ts`, `llm-improve.ts`, `llm-summarize.ts`, `llm-quality.ts`, `llm-diagram.ts`):

```diff
 } from './_helpers.js';
 import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';
+import { acquireStreamSlot } from '../../core/services/sse-stream-limiter.js';
 …
   fastify.post('/llm/ask', { ...LLM_STREAM_RATE_LIMIT, preHandler: requireGlobalPermission('llm:query') }, async (request, reply) => {
+    const slot = await acquireStreamSlot(request.userId);
+    if (!slot.acquired) {
+      return reply.code(429).send({
+        error: 'too_many_concurrent_streams',
+        message: 'You have reached the per-user concurrent stream limit. Close an existing stream and try again.',
+      });
+    }
+    try {
       const auditStart = Date.now();
       … existing body unchanged …
+    } finally {
+      await slot.release();
+    }
   });
```

### Step 2.6 — frontend UI

`frontend/src/features/settings/panels/LlmTab.tsx`:

- Append a "Runtime limits" card (or extend the nearest existing card — choose based on the file's current layout):
  - `<input type="number" min={1} max={20}>` labelled *"Max concurrent AI streams per user"*.
  - Helper text: *"New streams beyond this cap are rejected with 429. In-flight streams continue; only new opens see the new cap."*
  - Wire into the same TanStack-Query mutation used for other `AdminSettings` fields.
  - Optimistic default 3 when `llmMaxConcurrentStreamsPerUser` is undefined in the GET response.

**No new sub-tab, no new file, no new route component.**

### Step 2.7 — env-var docs

`CLAUDE.md` Environment section — update the wording to mark `LLM_MAX_CONCURRENT_STREAMS_PER_USER` as deprecated fallback (matches `DEFAULT_LLM_MODEL` at `CLAUDE.md:253`):

```
- `LLM_MAX_CONCURRENT_STREAMS_PER_USER` (deprecated bootstrap fallback — configured in Settings → LLM → Runtime limits, issue #268; consulted only when the `admin_settings` row is absent; fallback-of-last-resort: `3`)
```

`.env.example`: same line as a comment.

### Step 2.8 — tests

#### Unit tests on the limiter module (`backend/src/core/services/sse-stream-limiter.test.ts`)

```typescript
// RED #1 — acquire=true under cap
it('acquireStreamSlot returns acquired=true when under cap', async () => {
  mockRedis.eval.mockResolvedValue(1);
  const slot = await acquireStreamSlot('user-a');
  expect(slot.acquired).toBe(true);
});

// RED #2 — acquire=false at cap
it('acquireStreamSlot returns acquired=false when cap exceeded', async () => {
  mockRedis.eval.mockResolvedValue(0);
  const slot = await acquireStreamSlot('user-a');
  expect(slot.acquired).toBe(false);
});

// RED #3 — idempotent release
it('release() is idempotent — DECR called once', async () => {
  mockRedis.eval.mockResolvedValue(1);
  const slot = await acquireStreamSlot('user-a');
  await slot.release();
  await slot.release();
  expect(mockRedis.decr).toHaveBeenCalledTimes(1);
});

// RED #4 — fail-open when Redis unavailable
it('fails open when Redis is unavailable', async () => {
  setRedisClient(null as unknown as RedisClientType);
  const slot = await acquireStreamSlot('user-a');
  expect(slot.acquired).toBe(true);
  await expect(slot.release()).resolves.toBeUndefined();
});

// RED #5 — cap cascade: admin_settings present
it('getStreamCap reads admin_settings row when present', async () => {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
    ['llm_max_concurrent_streams_per_user', '7'],
  );
  _resetStreamCapCache();
  expect(await getStreamCap()).toBe(7);
});

// RED #6 — cap cascade: env fallback
it('getStreamCap falls back to env var when admin_settings row is absent', async () => {
  await query(`DELETE FROM admin_settings WHERE setting_key = $1`, ['llm_max_concurrent_streams_per_user']);
  process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER = '5';
  _resetStreamCapCache();
  try {
    expect(await getStreamCap()).toBe(5);
  } finally {
    delete process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER;
  }
});

// RED #7 — cap cascade: hard default
it('getStreamCap falls back to 3 when neither DB nor env set', async () => {
  await query(`DELETE FROM admin_settings WHERE setting_key = $1`, ['llm_max_concurrent_streams_per_user']);
  delete process.env.LLM_MAX_CONCURRENT_STREAMS_PER_USER;
  _resetStreamCapCache();
  expect(await getStreamCap()).toBe(3);
});

// RED #8 — Lua args use the resolved cap
it('Lua script receives keyed counter + resolved cap + ttl', async () => {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
    ['llm_max_concurrent_streams_per_user', '9'],
  );
  _resetStreamCapCache();
  mockRedis.eval.mockResolvedValue(1);
  await acquireStreamSlot('user-a');
  expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    keys: ['llm:streams:user-a'],
    arguments: ['9', '3600'],
  }));
});

// RED #9 — graceful lowering: in-flight streams survive
it('lowering the cap does not trim in-flight streams — new opens see new cap', async () => {
  // Simulate 4 active slots at cap=10.
  mockRedis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(1)
                .mockResolvedValueOnce(1).mockResolvedValueOnce(1);
  const slots = await Promise.all([
    acquireStreamSlot('u'), acquireStreamSlot('u'),
    acquireStreamSlot('u'), acquireStreamSlot('u'),
  ]);
  expect(slots.every((s) => s.acquired)).toBe(true);

  // Admin lowers cap to 2.
  invalidateStreamCapCache();

  // New open sees cap=2; Lua DECRs and returns 0.
  mockRedis.eval.mockResolvedValueOnce(0);
  const rejected = await acquireStreamSlot('u');
  expect(rejected.acquired).toBe(false);

  // Existing slots still release cleanly.
  for (const s of slots) await s.release();
  expect(mockRedis.decr).toHaveBeenCalledTimes(4);
});
```

#### Route-level (one representative + parameterise across all six)

```typescript
// RED #10 — 4th stream returns 429
it('POST /api/llm/ask returns 429 when user is at concurrent-stream cap', async () => {
  mockAcquireStreamSlot.mockResolvedValue({ acquired: false, release: async () => {} });
  const r = await app.inject({
    method: 'POST',
    url: '/api/llm/ask',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { question: 'hi' },
  });
  expect(r.statusCode).toBe(429);
  expect(r.json().error).toBe('too_many_concurrent_streams');
});
```

#### Integration: disconnect decrements

```typescript
// RED #11 — client-disconnect mid-stream releases the slot
it('client-disconnect during SSE stream releases the slot', async () => {
  mockAcquireStreamSlot.mockResolvedValue({ acquired: true, release: mockRelease });
  const controller = new AbortController();
  const streamPromise = app.inject({
    method: 'POST',
    url: '/api/llm/ask',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { question: 'hi' },
  });
  controller.abort();
  await streamPromise;
  expect(mockRelease).toHaveBeenCalled();
});
```

**Manual TTL self-heal test** (PR description, not automated):
```
redis-cli SET llm:streams:test-user 99 EX 5
sleep 6
redis-cli EXISTS llm:streams:test-user   # expected: 0
```

---

## 3. Rollback procedure

1. `git revert <commit-sha>`.
2. Residual Redis keys `llm:streams:*` self-clear via 1-hour TTL.
3. `admin_settings` row: leave (harmless) or `DELETE FROM admin_settings WHERE setting_key = 'llm_max_concurrent_streams_per_user';`.
4. Migration `056` is forward-only; no reverse migration. Orphan row has no runtime effect after the limiter module is gone.
5. Env var unchanged.

No schema DDL, no frontend-state migration.

---

## 4. Acceptance criteria mapped to issue body

- [x] **"`LLM_MAX_CONCURRENT_STREAMS_PER_USER` env var honored (default 3)"** — deprecated fallback; hard default 3.
- [x] **Admin-configurable via UI** — admin_settings key + Zod + GET/PUT + `LlmTab.tsx` input.
- [x] **"Stream 4 → 429 with body"** — `error: 'too_many_concurrent_streams'`.
- [x] **"Client disconnect decrements the counter"** — `try/finally slot.release()`.
- [x] **"Counter auto-heals on EXPIRE"** — every acquire re-runs EXPIRE.
- [x] **No admin override** — decision locked; no bypass anywhere.
- [x] **Graceful lowering** — RED #9.
- [x] **Test coverage: normal open/close, disconnect, cap cascade, lowering** — RED #1–#11.

---

## 5. Risks and open questions

1. **Cache TTL drift (60 s).** After admin lowers the cap, other processes see it within up to 60 s (unless they also call `invalidateStreamCapCache()`). Matches `rate-limit-service`. Acceptable. Multi-process invalidation via pub/sub is out of scope.
2. **Counter drift under Redis failover.** Rare; strictly fail-open; bounded by 1-hour TTL.
3. **`kill -9` mid-handler.** Counter off by 1 per killed stream; self-heals in 1 hour.
4. **Interaction with `@fastify/rate-limit`.** Rate-limit fires first; if it 429s, this gate never runs. Distinct `error` strings disambiguate.
5. **Cap max at 20 — too low?** Zod is easy to bump. Start conservative.

---

## 6. Dependencies and ordering

- **Hard sequencing:** none on other plans in this batch, **but** coordinate migration numbering with #264:
  - #268 → `056_admin_settings_llm_stream_cap.sql`
  - #264 → `057_admin_settings_denied_admin_retention.sql`
  - Whichever lands first keeps `056`; the other bumps to `057`. Trivial swap.
- **File conflicts:**
  - #264 and #268 both edit `packages/contracts/src/schemas/admin.ts` (independent optional fields) — trivial textual merge for whichever lands second.
  - #264 and #268 both edit `backend/src/routes/foundation/admin.ts` (same story — independent additions).
  - All other plans: zero conflict.
- **Test fixtures:** independent.

---

## 7. Estimated effort

~4 hours. New module (~140 LoC), migration (1 file), Zod + admin-route extensions (~30 LoC), six 10-line handler edits, UI card (~50 LoC), ~11 Vitest cases.
