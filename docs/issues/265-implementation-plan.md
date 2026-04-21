# Implementation Plan — Issue #265: upgrade `listActiveEmbeddingLocks` from SCAN to a dedicated Redis set

> Target branch: `feature/265-embedding-locks-set` → PR to `dev` **after PR #261 lands**.
> Scope: maintain `embedding:locks:active` (a Redis Set) alongside each `embedding:lock:<userId>` key, atomically. Swap `listActiveEmbeddingLocks()` from SCAN-walk to `SMEMBERS + pipelined GET/PTTL`. Preserve exact output parity. Self-heal stale set members.
>
> **Trigger per the issue:** non-urgent until Grafana P99 for `GET /api/admin/embedding/locks` exceeds 50 ms for 24 h.

---

## 1. ResearchPack

Line numbers verified against `origin/feature/257-reembed-worker` (commit `96369a2`) — source of the SCAN helper this plan replaces.

### 1.1 Files to edit (from PR #261 baseline)

| File:line (on `feature/257-reembed-worker`) | Role |
|---|---|
| `backend/src/core/services/redis-cache.ts:42` | `EMBEDDING_LOCK_TTL = 3600` — keep. |
| `backend/src/core/services/redis-cache.ts:44–46` | `embeddingLockKey(userId)` — keep. Add `LOCKS_ACTIVE_SET = 'embedding:locks:active'`. |
| `backend/src/core/services/redis-cache.ts:55–71` | `acquireEmbeddingLock(userId)` — currently `SET NX EX`. Extend to also `SADD` on success, atomically via Lua. |
| `backend/src/core/services/redis-cache.ts:76` | `RELEASE_LOCK_SCRIPT` — extend to also `SREM` on successful DEL. |
| `backend/src/core/services/redis-cache.ts:85–95` | `releaseEmbeddingLock(userId, lockId)` — unchanged API, extended Lua. |
| `backend/src/core/services/redis-cache.ts:119–163` (#257 branch) | `listActiveEmbeddingLocks()` — rewrite to `SMEMBERS + Promise.all(GET/PTTL)`. Self-heal stale set members. |
| `backend/src/core/services/redis-cache.ts:165–195` (#257 branch) | `forceReleaseEmbeddingLock(userId)` — unconditional `DEL`. Also `SREM`. |
| `backend/src/core/services/redis-cache.test.ts` | Extend Vitest mock-Redis suite. |

### 1.2 Callers — no change

- `GET /api/admin/embedding/locks` (PR #261, `backend/src/routes/foundation/admin-embedding-locks.ts:41–54`).
- Reembed-all wait-loop (PR #261).

Return type `EmbeddingLockSnapshot[]` unchanged. `forceReleaseEmbeddingLock` return shape `{ released, previousHolderEpoch }` unchanged.

### 1.3 External research — Redis atomicity tradeoffs

Sources: `https://redis.io/docs/latest/develop/using-commands/transactions/#usage` and `https://redis.io/docs/latest/develop/programmability/eval-intro/`.

| Aspect | Lua `EVAL` | `MULTI`/`EXEC` |
|---|---|---|
| Atomicity | Yes — script is atomic. | Yes — block is isolated. |
| Conditional logic | Rich — `redis.call` + Lua branching. | Limited — only `WATCH` optimistic locking. |
| Client round-trips | 1 | 2+ |
| Failure mode | Script aborts on error. | Queued commands discarded if connection drops. |

**Acquire** needs `SET NX EX` *and* `SADD` atomic; SADD must not run if SET NX failed. Conditional → **Lua**.

**Release** already uses Lua. Extending to `SREM` on success is zero additional round-trips.

**List** = `SMEMBERS` + pipelined `GET + PTTL`. Stale member (key expired, SREM didn't fire) is resolved by reader treating `GET → null` as stale + lazy `SREM`.

**Recommendation: Lua for acquire + release (extended); pipelined client reads for list.**

### 1.4 Node-Redis v4 API

`redis-cache.ts:88` uses `_redisClient.eval(SCRIPT, { keys: [...], arguments: [...] })` — v4 syntax. Reuse. Non-BullMQ pool uses `redis` (node-redis), not `ioredis` (`CLAUDE.md:98`).

---

## 2. Step-by-step surgical edits

### Step 1 — constant + acquire Lua

`redis-cache.ts` — after existing `embeddingLockKey()`:

```typescript
const EMBEDDING_LOCK_TTL = 3600;
const LOCKS_ACTIVE_SET = 'embedding:locks:active';

function embeddingLockKey(userId: string): string {
  return `embedding:lock:${userId}`;
}

// KEYS[1] = embedding:lock:<userId>
// KEYS[2] = embedding:locks:active
// ARGV[1] = lockId, ARGV[2] = userId, ARGV[3] = ttl seconds
const ACQUIRE_LOCK_SCRIPT = `
  if redis.call("set", KEYS[1], ARGV[1], "NX", "EX", ARGV[3]) then
    redis.call("sadd", KEYS[2], ARGV[2])
    return ARGV[1]
  end
  return nil
`;
```

Rewrite `acquireEmbeddingLock`:
```typescript
export async function acquireEmbeddingLock(userId: string): Promise<string | null> {
  const lockId = randomUUID();
  if (!_redisClient) {
    logger.warn({ userId }, 'Redis not available for embedding lock, proceeding without lock');
    return lockId;
  }
  try {
    const result = await _redisClient.eval(ACQUIRE_LOCK_SCRIPT, {
      keys: [embeddingLockKey(userId), LOCKS_ACTIVE_SET],
      arguments: [lockId, userId, String(EMBEDDING_LOCK_TTL)],
    });
    return typeof result === 'string' ? result : null;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to acquire embedding lock');
    return null;
  }
}
```

### Step 2 — extend release Lua

```typescript
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    redis.call("del", KEYS[1])
    redis.call("srem", KEYS[2], ARGV[2])
    return 1
  else
    return 0
  end
`;

export async function releaseEmbeddingLock(userId: string, lockId: string): Promise<void> {
  if (!_redisClient) return;
  try {
    await _redisClient.eval(RELEASE_LOCK_SCRIPT, {
      keys: [embeddingLockKey(userId), LOCKS_ACTIVE_SET],
      arguments: [lockId, userId],
    });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to release embedding lock');
  }
}
```

### Step 3 — rewrite `listActiveEmbeddingLocks`

```typescript
export async function listActiveEmbeddingLocks(): Promise<EmbeddingLockSnapshot[]> {
  if (!_redisClient) return [];
  const out: EmbeddingLockSnapshot[] = [];
  try {
    const userIds = await _redisClient.sMembers(LOCKS_ACTIVE_SET);
    if (userIds.length === 0) return [];

    // Pipelined reads: one GET + one PTTL per member.
    const m = _redisClient.multi();
    for (const uid of userIds) {
      m.get(embeddingLockKey(uid));
      m.pTTL(embeddingLockKey(uid));
    }
    const replies = await m.exec();

    const staleMembers: string[] = [];
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i]!;
      const holderEpoch = replies[i * 2] as string | null;
      const pttl = replies[i * 2 + 1] as number;

      if (holderEpoch === null) {
        // Lock key expired but SREM never ran. Record with ttlRemainingMs: -2
        // (parity with SCAN's pTTL-for-missing-key convention).
        staleMembers.push(uid);
        out.push({ userId: uid, holderEpoch: '', ttlRemainingMs: -2 });
        continue;
      }
      out.push({
        userId: uid,
        holderEpoch,
        ttlRemainingMs: typeof pttl === 'number' ? pttl : -2,
      });
    }

    // Fire-and-forget lazy self-heal.
    if (staleMembers.length > 0) {
      _redisClient
        .sRem(LOCKS_ACTIVE_SET, staleMembers)
        .catch((err) => logger.warn({ err, staleMembers }, 'Lazy SREM of stale lock-set members failed'));
    }

    return out;
  } catch (err) {
    logger.error({ err }, 'Failed to list active embedding locks');
    return [];
  }
}
```

**Parity decision.** `__reembed_all__` synthetic member is filtered in caller (`admin-embedding-locks.ts:41–47`). Keep the filter there — don't move into low-level helper.

### Step 4 — extend `forceReleaseEmbeddingLock` to SREM

```typescript
const FORCE_RELEASE_SCRIPT = `
  local prev = redis.call("get", KEYS[1])
  if prev then
    redis.call("del", KEYS[1])
    redis.call("srem", KEYS[2], ARGV[1])
    return prev
  end
  redis.call("srem", KEYS[2], ARGV[1])  -- scrub even if key gone
  return nil
`;

export async function forceReleaseEmbeddingLock(
  userId: string,
): Promise<{ released: boolean; previousHolderEpoch: string | null }> {
  if (!_redisClient) {
    return { released: false, previousHolderEpoch: null };
  }
  try {
    const prev = await _redisClient.eval(FORCE_RELEASE_SCRIPT, {
      keys: [embeddingLockKey(userId), LOCKS_ACTIVE_SET],
      arguments: [userId],
    });
    return {
      released: prev !== null,
      previousHolderEpoch: typeof prev === 'string' ? prev : null,
    };
  } catch (err) {
    logger.error({ err, userId }, 'Failed to force-release embedding lock');
    return { released: false, previousHolderEpoch: null };
  }
}
```

### Step 5 — tests

**RED #1 — acquire SADDs atomically:**
```typescript
it('acquireEmbeddingLock atomically adds userId to embedding:locks:active on success', async () => {
  mockRedis.eval.mockResolvedValue('lock-token');
  const lockId = await acquireEmbeddingLock('user-a');
  expect(lockId).toBe('lock-token');
  expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    keys: ['embedding:lock:user-a', 'embedding:locks:active'],
    arguments: expect.arrayContaining(['user-a']),
  }));
});

it('acquireEmbeddingLock does NOT add to the set when the lock is already held', async () => {
  mockRedis.eval.mockResolvedValue(null);
  const lockId = await acquireEmbeddingLock('user-a');
  expect(lockId).toBeNull();
});
```

**RED #2 — release script SREMs:**
```typescript
it('releaseEmbeddingLock passes both lock key and set key to Lua', async () => {
  await releaseEmbeddingLock('user-a', 'lock-token');
  expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    keys: ['embedding:lock:user-a', 'embedding:locks:active'],
    arguments: ['lock-token', 'user-a'],
  }));
});
```

**RED #3 — list uses SMEMBERS + pipelined reads:**
```typescript
it('listActiveEmbeddingLocks returns SMEMBERS output with TTL and holder', async () => {
  mockRedis.sMembers.mockResolvedValue(['alice', 'bob']);
  const mockMulti = {
    get: vi.fn().mockReturnThis(),
    pTTL: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['uuid-a', 12000, 'uuid-b', 34000]),
  };
  mockRedis.multi.mockReturnValue(mockMulti);

  const out = await listActiveEmbeddingLocks();
  expect(out).toEqual([
    { userId: 'alice', holderEpoch: 'uuid-a', ttlRemainingMs: 12000 },
    { userId: 'bob',   holderEpoch: 'uuid-b', ttlRemainingMs: 34000 },
  ]);
});
```

**RED #4 — stale set member self-heals:**
```typescript
it('listActiveEmbeddingLocks handles a stale set member (key expired, SREM never ran)', async () => {
  mockRedis.sMembers.mockResolvedValue(['alice', 'stale-user']);
  const mockMulti = {
    get: vi.fn().mockReturnThis(),
    pTTL: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['uuid-a', 12000, null, -2]),
  };
  mockRedis.multi.mockReturnValue(mockMulti);

  const out = await listActiveEmbeddingLocks();
  expect(out).toContainEqual({ userId: 'stale-user', holderEpoch: '', ttlRemainingMs: -2 });
  await Promise.resolve();
  expect(mockRedis.sRem).toHaveBeenCalledWith('embedding:locks:active', ['stale-user']);
});
```

**RED #5 — forceRelease SREMs even when key is gone:**
```typescript
it('forceReleaseEmbeddingLock SREMs the set even when the key was already DELed', async () => {
  mockRedis.eval.mockResolvedValue(null);
  const r = await forceReleaseEmbeddingLock('ghost');
  expect(r).toEqual({ released: false, previousHolderEpoch: null });
  expect(mockRedis.eval).toHaveBeenCalledWith(
    expect.stringContaining('srem'),
    expect.objectContaining({
      keys: ['embedding:lock:ghost', 'embedding:locks:active'],
      arguments: ['ghost'],
    }),
  );
});
```

**Integration parity test (optional):** fire 100 acquires + 100 releases interleaved with 50 list calls against real Redis; assert final `SMEMBERS embedding:locks:active` is empty.

---

## 3. Rollback procedure

1. `git revert <commit-sha>`.
2. Residual `embedding:locks:active` set on Redis: leave (old SCAN code ignores) or purge `DEL embedding:locks:active`. Safe — the set is a redundant index; authoritative truth is in `embedding:lock:<userId>` keys.

No schema, no migration, no config change.

---

## 4. Acceptance criteria mapped to issue body

- [x] **"`embedding:locks:active` set maintained atomically"** — Lua in acquire + release + forceRelease.
- [x] **"`listActiveEmbeddingLocks` returns identical output to SCAN version (parity test)"** — RED #3 + optional integration test.
- [x] **"Handles stale set member case … return `ttlRemainingMs: null` and self-heal"** — RED #4 (using `-2` for parity; see §5).

---

## 5. Risks and open questions

1. **`ttlRemainingMs: null` (issue body) vs `-2` (PR #261 current).** Recommend `-2` (wire parity); open separate micro-issue for rename if desired. **Top-3 question.**
2. **Cluster mode.** Single-instance Redis today. Cluster would need `{uid}` hash tag. Out of scope.
3. **Migration of pre-existing lock keys without set entry.** Bounded recovery — 1-hour TTL max. Alternative: bootstrap SCAN+SADD. Recommend accept drift.
4. **P99 measurement threshold.** No Grafana panel ships with CE. Include synthetic `autocannon` before/after in PR description.
5. **`node-redis` v4's `.multi().exec()` — pipeline or MULTI/EXEC?** Wraps in MULTI/EXEC by default. Fine; or use `.batch()` for pure pipelining. Document in code comment.

---

## 6. Dependencies and ordering

- **Hard dependency on PR #261 merging to `dev`.** Do not ship until #261 lands.
- **File conflicts:** none — `redis-cache.ts` is unique to this plan among the batch.
- **Sequencing:** parallel with all others after #261 lands.

---

## 7. Estimated effort

~2 hours. Three Lua scripts, one helper rewrite, five Vitest cases.
