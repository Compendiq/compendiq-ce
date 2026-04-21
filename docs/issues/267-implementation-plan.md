# Implementation Plan — Issue #267: drop circuit-breaker map entry on provider deletion

> Target branch: `feature/267-breaker-drop-on-delete` → PR to `dev`.
> Scope: stop leaking `CircuitBreaker` map entries when a provider is deleted. Reuse existing cache-bus (not a new event bus). Minimal diff.

---

## 1. ResearchPack — files touched / read

Line numbers verified on `feature/258-llm-queue-breakers` (`19b8c87`) — post-#259 tree.

### 1.1 Files to edit

| File:line | Why |
|---|---|
| `backend/src/domains/llm/services/llm-provider-service.ts:124–138` (`deleteProvider`) | Producer. Calls `bumpProviderCacheVersion()` at `:137`. Need a distinct signal carrying `providerId`. |
| `backend/src/domains/llm/services/cache-bus.ts:1–14` | 14-line event bus. Add sibling `emitProviderDeleted(id)` + `onProviderDeleted(listener)`. |
| `backend/src/domains/llm/services/llm-provider-resolver.ts:28–38` | Already listens for `onProviderCacheBump`. Extend: also listen for `onProviderDeleted` → `invalidateBreaker(id)` + `invalidateDispatcher(id)` + `configCache.delete(id)`. |
| `backend/src/core/services/circuit-breaker.ts:179–181` (`invalidateProviderBreaker`) | Already does `providerBreakers.delete(providerId)`. **Unchanged** — perfect semantics. |
| `backend/src/core/services/circuit-breaker.test.ts:186–217` | Add one deletion-flow test. |
| `backend/src/domains/llm/services/llm-provider-service.test.ts` | Add one event-emission test. |

### 1.2 Existing event-bus is sufficient

`cache-bus.ts` is a 14-line in-process bus decoupling writers from readers. Adding `emitProviderDeleted` + `onProviderDeleted` alongside keeps cross-domain coordination in one file. No Node `EventEmitter`, no new dep.

### 1.3 Why not just piggy-back on `bumpProviderCacheVersion`?

The resolver's listener (`:28–38`) drops breakers by iterating `configCache.values()`. But `configCache` is only populated when a use-case resolves to that provider. A provider created but never bound (e.g. admin created + clicked "Test connection" but no assignment yet) → breaker is NOT in `configCache` → iterate-over-cache misses it.

**Reproduction:**
1. Admin creates A (no assignment).
2. Admin clicks "Test connection" → `getProviderBreaker(A).execute(...)` creates breaker at `circuit-breaker.ts:164–170`.
3. Resolver `configCache` NOT populated.
4. Admin deletes A → `bumpProviderCacheVersion()` → resolver iterates `configCache.values()` → A not there → breaker never deleted.
5. Leak.

So: need `providerId`-carrying event, not version bump.

### 1.4 External research

None needed — pattern is trivial.

---

## 2. Step-by-step surgical edits

### Step 1 — extend `cache-bus.ts`

Additive only:

```typescript
// backend/src/domains/llm/services/cache-bus.ts
let version = 0;
type Listener = (v: number) => void;
const listeners = new Set<Listener>();

export function bumpProviderCacheVersion(): void {
  version += 1;
  for (const l of listeners) l(version);
}
export function getProviderCacheVersion(): number { return version; }
export function onProviderCacheBump(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ── Provider deletion: carries the deleted providerId so subscribers can ────
// drop per-id resources. Emitted only from `deleteProvider()`.
type DeletedListener = (id: string) => void;
const deletedListeners = new Set<DeletedListener>();

export function emitProviderDeleted(id: string): void {
  for (const l of deletedListeners) l(id);
}
export function onProviderDeleted(l: DeletedListener): () => void {
  deletedListeners.add(l);
  return () => deletedListeners.delete(l);
}
```

### Step 2 — wire `deleteProvider`

`llm-provider-service.ts`:

```diff
-import { bumpProviderCacheVersion } from './cache-bus.js';
+import { bumpProviderCacheVersion, emitProviderDeleted } from './cache-bus.js';
```

```diff
   await query(`DELETE FROM llm_providers WHERE id=$1`, [id]);
-  bumpProviderCacheVersion();
+  emitProviderDeleted(id);
+  bumpProviderCacheVersion();
 }
```

**Order matters:** emit `providerDeleted(id)` *before* `bumpProviderCacheVersion()`.

### Step 3 — resolver listener

`llm-provider-resolver.ts`:

```diff
-import { getProviderCacheVersion, onProviderCacheBump } from './cache-bus.js';
+import { getProviderCacheVersion, onProviderCacheBump, onProviderDeleted } from './cache-bus.js';
```

Append after line 38:

```typescript
onProviderDeleted((id) => {
  // Definitive per-id cleanup. Runs even if the resolver's configCache
  // doesn't have an entry for `id`.
  invalidateDispatcher(id);
  invalidateBreaker(id);
  configCache.delete(id);
});
```

Imports `invalidateDispatcher` + `invalidateBreaker` already at line 3.

### Step 4 — tests

**RED #1 — deletion event drops breaker:**
```typescript
describe('provider deletion event drops breaker entry via cache-bus', () => {
  it('emitProviderDeleted drops the breaker — listProviderBreakers no longer sees the id', async () => {
    await import('../../domains/llm/services/llm-provider-resolver.js'); // register listener
    const { emitProviderDeleted } = await import('../../domains/llm/services/cache-bus.js');

    const id = 'provider-to-delete';
    invalidateProviderBreaker(id);

    const breaker = getProviderBreaker(id);
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('boom'))).catch(() => {});
    }
    expect(breaker.getStatus().state).toBe('OPEN');
    expect(listProviderBreakers().find((b) => b.providerId === id)).toBeDefined();

    emitProviderDeleted(id);

    expect(listProviderBreakers().find((b) => b.providerId === id)).toBeUndefined();

    const reborn = getProviderBreaker(id);
    expect(reborn.getStatus().state).toBe('CLOSED');
    expect(reborn).not.toBe(breaker);
  });
});
```

**RED #2 — `deleteProvider` emits event (real-DB):**
```typescript
it('deleteProvider emits providerDeleted before bumping cache version', async () => {
  const events: Array<{ kind: 'deleted'; id: string } | { kind: 'bump' }> = [];
  const offDel = onProviderDeleted((id) => events.push({ kind: 'deleted', id }));
  const offBump = onProviderCacheBump(() => events.push({ kind: 'bump' }));

  try {
    const p = await createProvider({
      name: 'to-delete', baseUrl: 'http://x', apiKey: null,
      authType: 'none', verifySsl: true, defaultModel: null,
    });
    events.length = 0;
    await deleteProvider(p.id);

    expect(events).toEqual([{ kind: 'deleted', id: p.id }, { kind: 'bump' }]);
  } finally {
    offDel();
    offBump();
  }
});
```

### Step 5 — no other changes

`emitProviderDeleted` only called by `deleteProvider()`. `onProviderDeleted` only subscribed by resolver. EE can subscribe later via the same public export.

---

## 3. Rollback procedure

Single-commit revert. Zero schema, zero Redis. Behaviour returns to pre-fix (entries leak — same as `dev`).

---

## 4. Acceptance criteria mapped to issue body

- [x] **"Delete → `listProviderBreakers()` no longer contains the id within one tick"** — synchronous listener. RED #1.
- [x] **"Re-create with same id → fresh CLOSED breaker, no state bleed"** — RED #1 asserts `reborn.getStatus().state === 'CLOSED'` + `reborn !== breaker`. Note: data model uses DB UUIDs, so "re-create same id" is exotic; still covered.
- [x] **"Test: create → trip → delete → assert entry gone"** — RED #1 + RED #2.

---

## 5. Risks and open questions

1. **Module-load ordering of the listener.** Resolver's `onProviderDeleted(...)` is a module-evaluation side effect. In production, `index.ts` boots via `llm-provider-bootstrap.ts` which transitively imports the resolver. RED #1 pins this with `await import(...)`. Gotcha for unit tests only.

2. **`configCache.delete(id)` as belt-and-braces.** `onProviderCacheBump` listener already `configCache.clear()`s at `:37`. Delete listener's `configCache.delete(id)` is redundant when both fire. Kept anyway — self-sufficient listener.

3. **EE plugin subscription?** `onProviderDeleted` is a public export; EE can subscribe later without change.

4. **Observable change on `/api/ollama/circuit-breaker-status` (soon `/api/llm/…` under #266)?** Yes — deleted provider's entry disappears within one tick; previously lingered. Strictly a bug-fix.

---

## 6. Dependencies and ordering

- **File conflicts:** none with any plan in this batch.
- **Parallel with all** — #263–#269.
- **Test fixtures:** independent.

---

## 7. Estimated effort

~40 minutes. One event-bus extension (~15 LoC), one service-layer line, one resolver listener (~8 LoC), two Vitest cases.
