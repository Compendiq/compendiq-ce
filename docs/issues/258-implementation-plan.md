# Implementation Plan — Issue #258: preserve LLM queue + circuit breakers on call-site migration (v2)

> Follow-up to #256 (merged via PR #259 on 2026-04-21). Target branch: `dev`.
> Scope: verify, test, and tighten the queue + per-provider circuit breaker
> wrapping around the multi-provider `openai-compatible-client.ts`; remove
> the dead legacy `ollamaBreakers` / `openaiBreakers` surface area.
>
> **v2 changes from v1:** Q1 — no frontend depends on the old
> `/ollama/circuit-breaker-status` `{ ollama, openai }` shape, so §2.4
> drops the compat wrapper and returns the clean `listProviderBreakers()`
> output directly. Added §3 inventory (endpoints / settings / components).
> See §9 for full v1→v2 changelog.

---

## 1. ResearchPack — files touched / read

All paths relative to repo root `compendiq-ce/`. Line numbers verified against
tip of `feature/docs-multi-llm-provider-sync` (commit `040d10f`) on
2026-04-21.

### 1.1 What is **already** in place (surprising — worth flagging loudly)

The issue body states the migration "dropped" queue + breaker wrapping. This is
**no longer true on `dev`** — the wrapping is already there:

| File:line | Observation |
|---|---|
| `backend/src/domains/llm/services/openai-compatible-client.ts:56–67` | `listModels` wraps `undiciFetch` inside `enqueue(() => getProviderBreaker(cfg.providerId).execute(...))`. |
| `…openai-compatible-client.ts:78–92` | `chat` (non-stream) same pattern. |
| `…openai-compatible-client.ts:141–158` | `generateEmbedding` same pattern. |
| `…openai-compatible-client.ts:94–116` | `streamChat` — **intentionally bypasses** `enqueue()` per the comment at lines 94–102, but still wraps the initial request in `getProviderBreaker(...).execute(...)`. Matches legacy `providerStreamChat` behaviour. |
| `backend/src/core/services/circuit-breaker.ts:200–253` | Per-provider breaker map + `getProviderBreaker`, `invalidateProviderBreaker`, `listProviderBreakers` — already implemented. Cache-bus hook in resolver (line 33). |
| `backend/src/domains/llm/services/llm-provider-resolver.ts:28–38` | On cache-bus bump, both the undici dispatcher AND the breaker for the affected provider are invalidated. Lifecycle is correct. |

Heavy lifting of #258 is **done**. Remaining work: verify via tests,
remove dead legacy breaker globals, document the streaming bypass.

### 1.2 What is still legacy / dead

| File:line | Dead code to remove |
|---|---|
| `backend/src/core/services/circuit-breaker.ts:159–172` | `ollamaBreakers`, `openaiBreakers` — no production path still wraps through these. |
| `backend/src/core/services/circuit-breaker.ts:177–194` | `getOllamaCircuitBreakerStatus`, `getOpenaiCircuitBreakerStatus` — only called by `routes/llm/llm-models.ts` to populate a dashboard field that is no longer accurate. |
| `backend/src/core/index.ts:15–18` | Public re-exports of the above. |
| `backend/src/routes/llm/llm-models.ts:11, 105–110` | `/api/ollama/circuit-breaker-status` currently returns hardcoded-always-CLOSED data. **Q1 decision:** no frontend consumes this shape — safe to change response directly without compat wrapper. |
| `backend/src/domains/llm/services/embedding-service.ts:127–141` | Code comment already acknowledges: "Previously this queried the legacy `ollamaBreakers` / `openaiBreakers` globals which are no longer populated." `getEmbedBreakerNextRetryTime` already does the right thing via `getProviderBreaker(config.providerId)`. |
| `backend/src/routes/llm/llm-chat.test.ts` | Test file references a non-existent `llm-chat.ts` route and mocks `../../domains/llm/services/llm-provider.js` (lines 58–64) which **does not exist** in the current tree. Dead scaffolding. |

### 1.3 Upstream references (who reads the queue + breakers)

| File | Role |
|---|---|
| `backend/src/domains/llm/services/llm-queue.ts` | The queue. `enqueue()`, `initLlmQueue()`, `setConcurrency()`. Boot-loaded (index.ts:61). |
| `backend/src/domains/llm/services/llm-queue.test.ts:115–130` | Has a test for `LLM_CONCURRENCY=1` serialising three concurrent `enqueue()` calls. Good baseline. |
| `backend/src/routes/foundation/health.ts:4, 152` | Reads `listProviderBreakers()` for health payload. Works. |

**Q1 verification (frontend grep, performed 2026-04-21):**
No match for `circuit-breaker-status` in `frontend/src/`. No match for
consumer of a `{ ollama: …, openai: … }` shape from `/api/ollama/…`.
→ Response-shape change is safe without a compat wrapper.

External ResearchPack (Ref MCP) — not needed; pattern is in-repo.

---

## 2. Plan — surgical edits, file by file

### 2.1 `backend/src/domains/llm/services/openai-compatible-client.ts`

**No functional changes.** Add a module-level docblock documenting the
queue + breaker composition (hoisted from the inline `streamChat` comment):

```diff
+/**
+ * Multi-provider OpenAI-compatible HTTP client.
+ *
+ * Every non-streaming call site (listModels, chat, generateEmbedding) is
+ * wrapped in two layers:
+ *
+ *   enqueue( () => getProviderBreaker(cfg.providerId).execute( fn ) )
+ *
+ *   1. `enqueue` (from llm-queue.ts) enforces process-wide concurrency via
+ *      LLM_CONCURRENCY (default 4) and rejects with `QueueFullError` when
+ *      pending > LLM_MAX_QUEUE_DEPTH (default 50).
+ *   2. `getProviderBreaker(id).execute` trips after `failureThreshold` (3)
+ *      consecutive failures per *provider*, independent of use-case, and
+ *      short-circuits for `timeout` ms (30s). Map lifecycle is tied to the
+ *      provider cache-bus in llm-provider-resolver.ts.
+ *
+ * Streaming intentionally skips the enqueue layer — see streamChat() for
+ * the full rationale.
+ */
 import { Agent, fetch as undiciFetch } from 'undici';
```

### 2.2 `backend/src/core/services/circuit-breaker.ts` — remove dead globals

```diff
-// Per-method circuit breakers for Ollama
-export const ollamaBreakers = { chat: …, embed: …, list: … } as const;
-
-// Separate per-method circuit breakers for OpenAI-compatible providers.
-export const openaiBreakers = { chat: …, embed: …, list: … } as const;
-
-export function getOllamaCircuitBreakerStatus() { … }
-export function getOpenaiCircuitBreakerStatus() { … }
```

Keep the `CircuitBreaker` class and everything from line 196 onward
(per-provider map + `getProviderBreaker` + `invalidateProviderBreaker`
+ `listProviderBreakers`).

### 2.3 `backend/src/core/index.ts` — barrel cleanup

```diff
 export {
-  ollamaBreakers,
-  openaiBreakers,
-  getOllamaCircuitBreakerStatus,
-  getOpenaiCircuitBreakerStatus,
+  getProviderBreaker,
+  invalidateProviderBreaker,
+  listProviderBreakers,
 } from './services/circuit-breaker.js';
```

### 2.4 `backend/src/routes/llm/llm-models.ts` — migrate response shape (Q1)

No compat wrapper. The endpoint path stays (`/api/ollama/circuit-breaker-status`)
for any external ops tooling, but the response shape migrates to the
per-provider model directly:

```diff
-import { getOllamaCircuitBreakerStatus, getOpenaiCircuitBreakerStatus } from '../../core/services/circuit-breaker.js';
+import { listProviderBreakers } from '../../core/services/circuit-breaker.js';

 fastify.get('/ollama/circuit-breaker-status', async () => {
-  return {
-    ollama: getOllamaCircuitBreakerStatus(),
-    openai: getOpenaiCircuitBreakerStatus(),
-  };
+  // Flat map: providerId → { state, failureCount, nextRetryTime }.
+  // Old `{ ollama, openai }` per-protocol shape was tied to the two-slot
+  // LLM_PROVIDER toggle (removed in #256). Per-provider state is the
+  // authoritative signal now. No frontend consumer depends on the old
+  // shape (verified via grep on 2026-04-21, see plan §1.3).
+  const out: Record<
+    string,
+    { state: string; failureCount: number; nextRetryTime: number | null }
+  > = {};
+  for (const snap of listProviderBreakers()) {
+    out[snap.providerId] = {
+      state: snap.state,
+      failureCount: snap.failureCount,
+      nextRetryTime: snap.nextRetryTime,
+    };
+  }
+  return out;
 });
```

**Note:** the route path `/api/ollama/circuit-breaker-status` is now
misleading (there's no Ollama-specific state anymore). Rename to
`/api/llm/circuit-breaker-status` in a **separate follow-up PR** — not
part of #258 — because any external script reading the Ollama path
would break. Flag only.

### 2.5 Delete `backend/src/routes/llm/llm-chat.test.ts`

Verify before deletion:
```bash
cd backend && npx vitest run src/routes/llm/llm-chat.test.ts
```
Expected: file either fails hollowly (mocks `llm-provider.js` which doesn't
exist) or passes against dead paths. Coverage verified not unique.

Delete as a standalone commit for easy rollback.

### 2.6 No migration. No admin_settings changes.

---

## 3. Admin settings, API endpoints, frontend surface — inventory

### 3.1 New `admin_settings` keys

**None.** This plan only touches code structure + tests.

### 3.2 New / changed API endpoints

| method | path | auth | request | response | behaviour change |
|---|---|---|---|---|---|
| GET | `/api/ollama/circuit-breaker-status` | `authenticate` | — | **breaking**: was `{ ollama: {…}, openai: {…} }`. Now `Record<providerId, { state, failureCount, nextRetryTime }>`. | Q1: no frontend depends on old shape. Rename path to `/api/llm/circuit-breaker-status` is a separate follow-up, not in this PR. |

No other endpoints added or changed.

### 3.3 New / changed frontend components

**None.** The `/ollama/circuit-breaker-status` response is not consumed by
the frontend (verified via grep). If an admin UI panel wants to visualise
the new per-provider state, it's a separate UX feature, not #258.

---

## 4. New tests (TDD — RED first)

### 4.1 Unit: `backend/src/domains/llm/services/llm-queue.test.ts` (extend)

- **RED #1**: With `LLM_CONCURRENCY=1` and a local HTTP stub (pattern from
  `openai-compatible-client.test.ts:9–24`), fire 3 concurrent
  `chat(cfg, model, msgs)`. Assert the stub observes at most 1 in-flight
  request at any time. Covers issue's "LLM_CONCURRENCY=1 test confirms
  serialization" bullet.

### 4.2 Unit: `backend/src/domains/llm/services/openai-compatible-client.test.ts` (extend)

- **RED #2**: **Breaker trips on 3rd consecutive failure.** Point a
  `ProviderConfig` at a local stub returning 500. Three `chat(cfg, …)`
  calls — first two reject with upstream error, 3rd/4th reject with
  `CircuitBreakerOpenError`. Then advance time past breaker `timeout`
  (use small test-only timeout) and assert a single probe succeeds
  against a healthy server.
- **RED #3**: **Independent per-provider breakers.** Trip provider A,
  assert provider B's `chat` still succeeds.
- **RED #4**: **Queue-full vs. breaker-open disambiguation.** With
  `LLM_CONCURRENCY=1` + `LLM_MAX_QUEUE_DEPTH=1`, 3 concurrent calls to a
  slow (200ms) stub. 3rd rejects with `QueueFullError`, **not**
  `CircuitBreakerOpenError`.

### 4.3 Unit: `backend/src/core/services/circuit-breaker.test.ts` (extend)

- **RED #5**: `invalidateProviderBreaker('id')` + subsequent
  `getProviderBreaker('id')` returns a **fresh** `CLOSED` instance even
  if the previous was `OPEN`. Confirms the cache-bus lifecycle.

### 4.4 Integration: `backend/src/domains/llm/services/embedding-service.test.ts` (extend)

- **RED #6**: `generateEmbedding` (inside `embedPage`) passes through
  `enqueue`. Mock `llm-queue.enqueue` as a spy; assert it's called once
  per `embedPage`. Covers "chat + `generateEmbedding` pass through
  `enqueue`" bullet.

### 4.5 Route test: `backend/src/routes/llm/llm-models.test.ts` (extend)

- **RED #7** (Q1): `GET /api/ollama/circuit-breaker-status` returns a
  flat map keyed by providerId. Call `getProviderBreaker('p1')` first to
  seed; assert response includes `'p1'` with `state: 'closed'`.

### 4.6 No new E2E.

---

## 5. Rollback procedure

### 5.1 Safe deletions (§2.2, §2.3, §2.4, §2.5)

`git revert <sha>` restores the legacy globals. Route §2.4 reverts cleanly
because the route path is unchanged — only response body shape reverts.
Q1 is a breaking response-shape change: if an external (non-frontend)
script depends on the old shape, it will need an update. No in-repo
consumer does (see §1.3 verification).

### 5.2 Test additions (§4)

Purely additive — revert at will.

### 5.3 No DB / schema changes

Nothing to rollback on DB side.

---

## 6. Acceptance-criteria checklist (maps to issue #258 body)

- [ ] Chat calls go through `enqueue`. → Already true in
      `openai-compatible-client.ts:79`. Verified by §4.1 RED #1.
- [ ] `generateEmbedding` calls go through `enqueue`. → Already true
      (line 145). Verified by §4.4 RED #6.
- [ ] All client calls wrapped in per-provider breaker. → Already true
      (lines 57, 79, 106, 146). Verified by §4.2 RED #2 + #3.
- [ ] `LLM_CONCURRENCY=1` test confirms serialization. → §4.1 RED #1
      (adapts `llm-queue.test.ts` per issue body).
- [ ] Breaker trips on 3rd consecutive failure. → §4.2 RED #2. Confirms
      `failureThreshold: 3` default.
- [ ] Streaming stays bypassed. → Already true (lines 94–102). Doc
      tightened in §2.1.
- [ ] Plan tasks 16+17 referenced `llm-chat.ts` → factored in. §2.5
      deletes dead `llm-chat.test.ts`; `llm-ask.ts` already uses the new
      client (`llm-ask.ts:4, 238`).

---

## 7. Risks + open questions

1. **Route rename.** Current path `/api/ollama/circuit-breaker-status` is
   misleading after Q1. Rename to `/api/llm/circuit-breaker-status` is a
   clean follow-up — out of scope for #258 to keep this PR minimal.
   External ops tooling (if any) would break on rename; a grace window
   with both paths is cheap — flag for reviewer.

2. **Breaker key lifecycle on provider deletion.** `invalidateProviderBreaker(id)`
   is called from the cache-bus hook on **any** bump (config edit). On
   provider **delete**, the breaker entry stays until the next bump.
   Leaks O(n) entries over process lifetime. Non-urgent. Suggested
   follow-up: `llm-provider-service.ts` emits a specific
   "provider-deleted" event wired directly to `invalidateProviderBreaker`.
   Out of scope.

3. **Streaming bypass.** Streaming does not respect `LLM_CONCURRENCY`.
   A client could open 100 concurrent SSE streams and saturate the
   upstream LLM. Mitigation today: Fastify per-route rate limit
   (`LLM_STREAM_RATE_LIMIT`). Stream concurrency enforcement belongs at
   a different layer (per-user stream count in Redis) — explicitly out
   of scope.

4. **Dead-test deletion (§2.5).** Run `vitest` on the file in isolation
   first to confirm no irreplaceable assertion before deleting. Split
   deletion into its own commit for easy rollback.

5. **Test timing race.** "At most 1 in-flight" in §4.1 RED #1 has a
   time-of-check race — mitigate via counter + setTimeout scheduling
   on the stub, same pattern as `llm-queue.test.ts:115–130`. Don't use
   `Date.now()` deltas.

6. **Frontend verification recency.** The Q1 grep was performed
   2026-04-21 against the current tree. If any frontend code is added
   in a parallel PR before #258 lands that consumes the old shape, it
   will break. Unlikely (no active work on that panel) but worth a
   re-check at merge time.

---

## 8. Dependency on #257

See #257's §8 for the reverse summary. Short version:

- **#257 lands first.** #258 is mostly tests + cleanup around the same
  client-layer wrapping; does not change the call path #257 relies on.
- **Shared scaffolding:** local-HTTP stub pattern from
  `openai-compatible-client.test.ts` is reused across both plans; keep
  inline per test file; extract only if a 3rd consumer appears.

---

## 9. Changelog v1 → v2

- **Q1 integrated** (§2.4): dropped the compat-wrapper plan for
  `/api/ollama/circuit-breaker-status`. Now returns the clean
  `Record<providerId, {state, failureCount, nextRetryTime}>` directly.
  Route rename moved to a follow-up. Added the verification grep in §1.3.
- **§3 inventory added** per user ask — explicit "no settings, one
  changed endpoint, no new components" makes the blast radius unambiguous.
- **§4.5 new route test (RED #7)** for the new response shape.
- No Q2/Q3/Q4 impact — those decisions all landed on #257.
