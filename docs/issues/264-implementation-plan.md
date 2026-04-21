# Implementation Plan — Issue #264: audit-log denied admin actions (403) at the `requireAdmin` decorator

> Target branch: `feature/264-audit-denied-admin` → PR to `dev`.
> Scope: every 403 from `fastify.requireAdmin` writes an audit row (also the unauthenticated case). Cross-cutting — 61 endpoints via one decorator edit. Adds admin-configurable retention for `ADMIN_ACCESS_DENIED` rows, extending the existing `data-retention-service.ts`.
>
> **Decisions locked (v2, 2026-04-21):**
> - Retention = piggy-back on `data-retention-service.ts`. Default **90 days**, admin-configurable via new `admin_settings.admin_access_denied_retention_days` key (range 7–3650). Extend existing service; don't invent a new mechanism.
> - Purge targets only `action = 'ADMIN_ACCESS_DENIED'` — does not broaden `audit_log` retention for other action types.
> - Parameterised SQL; batched DELETE to avoid long locks.

---

## 1. ResearchPack

Line numbers verified on `feature/258-llm-queue-breakers` (`19b8c87`). Applies cleanly on `dev` + both open PR branches.

### 1.1 Files to edit

| File:line | Why |
|---|---|
| `backend/src/core/plugins/auth.ts:231–236` | `fastify.decorate('requireAdmin', …)` — single choke point. Both throw paths emit audit before bubbling. |
| `backend/src/core/services/audit-service.ts:8–38` | Add `'ADMIN_ACCESS_DENIED'` to the `AuditAction` union. `logAuditEvent()` already handles `userId: null`. |
| `backend/src/core/plugins/auth.test.ts` | Three new test cases. |
| `backend/src/core/services/data-retention-service.ts` | Currently env-only at `:18–23, 34–38`. Extend with admin_settings lookup for the new `ADMIN_ACCESS_DENIED` retention; add the targeted batched purge. |
| `backend/src/core/services/data-retention-service.test.ts` (new or existing — TBD) | Add four retention-specific tests (RED #4–#7). |
| `packages/contracts/src/schemas/admin.ts:18–66` | Add `adminAccessDeniedRetentionDays` to both schemas. |
| `backend/src/routes/foundation/admin.ts:237, 248, 284, 328` | Wire GET/PUT for the new admin_settings key. |
| `backend/src/core/db/migrations/057_admin_settings_denied_admin_retention.sql` (new) | Seed the default (90). |
| `frontend/src/features/admin/DataRetentionTab.tsx` | Surface the retention-days input. |

### 1.2 Downstream consumers of `requireAdmin` — no change

`rg "fastify.requireAdmin" backend/src/routes/` → 61 matches. None need edits.

### 1.3 Fastify 5 hook-ordering research (unchanged from v1)

Source: `https://github.com/fastify/fastify/blob/main/docs/Reference/Hooks.md`.

- `requireAdmin` is a decorated function, not a hook. Attached as `preHandler` or `onRequest`. Runs before the route handler.
- If it throws, preHandler chain stops; Fastify routes the error to `onError` hook chain and error handler set via `setErrorHandler`.
- `onError` is textbook for "custom error logging" but fires for every error on every route — filtering by marker error class is fragile.

**Three viable architectures:**

| Approach | Pros | Cons |
|---|---|---|
| **A. Inline in decorator** | one file, no hook plumbing, obvious trace | ~few ms DB-write per denial |
| **B. Marker error + global `onError`** | centralised | fires for every error; harder to test |
| **C. `onRequestAbort`** | — | wrong lifecycle |

**Recommendation: A.** `logAuditEvent()` is try/catch-wrapped (`audit-service.ts:64–84`) with "never blocks main operation" guarantee.

### 1.4 Existing `data-retention-service.ts` shape (must conform)

Read of the live file (`backend/src/core/services/data-retention-service.ts`):

- Currently holds `RETENTION_DEFAULTS: Record<string, number>` at `:18–23`: `audit_log: 365`, `search_analytics: 90`, `error_log: 30`, `page_versions: 50`.
- `runRetentionCleanup()` at `:29–76` iterates that map. Time-based tables use `DELETE FROM ${table} WHERE created_at < NOW() - INTERVAL '1 day' * $1` with `$1 = retentionDays`. Count-based uses a window function.
- **Env vars only**, no `admin_settings` integration today (`:37–38` reads `RETENTION_${table.toUpperCase()}_DAYS`).
- Scheduler at `:80–115`: `startRetentionWorker(intervalHours = 24)`, `stopRetentionWorker()`.
- Invoked from `queue-service.ts:287–310` (the `maintenance` BullMQ queue) and the setInterval fallback at `:323–350`.

**Reuse everything.** This plan adds a **fifth entry** to the retention cycle: `audit_log_admin_access_denied`, scoped by `action = 'ADMIN_ACCESS_DENIED'` (not whole-table), with the cap read from admin_settings first, then env, then default.

### 1.5 Admin-settings cascade (reuse from #268's plan § 1.3)

Same rate-limit-service pattern. Canonical key: **`admin_access_denied_retention_days`** (integer, text-valued). Default `90`, min `7`, max `3650` (~10 years).

Read cascade:
```
admin_settings.admin_access_denied_retention_days   (authoritative)
  → process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS  (optional env fallback, non-deprecated — no pre-existing env var to deprecate)
  → 90                                              (hard default)
```

### 1.6 Migration numbering

`dev` at `054`. PR #261 owns `055`. #268 allocates `056`. This plan allocates **`057_admin_settings_denied_admin_retention.sql`**. If shipping order flips, swap `056` ↔ `057` — coordinated in #268 plan § 6.

### 1.7 Audit-action naming

`AuditAction` has `'LOGIN_FAILED'` (login-scoped) and `'ADMIN_ACTION'` (success — `knowledge-admin.ts:129`). Add `'ADMIN_ACCESS_DENIED'` — distinct dashboard bucket.

### 1.8 Existing retention UI surface

`frontend/src/features/admin/DataRetentionTab.tsx` already exists. The new input appends to this panel (do NOT create a new sub-tab — mirrors #268's `LlmTab.tsx` decision).

---

## 2. Step-by-step surgical edits

### Step 1 — extend `AuditAction`

`audit-service.ts:37`:

```diff
   | 'EMBEDDING_RESCAN'
-  | 'EMBEDDING_RESET_FAILED';
+  | 'EMBEDDING_RESET_FAILED'
+  | 'ADMIN_ACCESS_DENIED';
```

### Step 2 — rewrite `requireAdmin`

`auth.ts:231–236`. Two paths:
- A: `authenticate` throws — `reason: 'unauthenticated'`, `actorUserId: null`.
- B: role check fails — `reason: 'not_admin'`, `actorUserId: request.userId`.

```typescript
  fastify.decorate('requireAdmin', async (request: FastifyRequest) => {
    // Path A: authentication failure (missing/invalid Bearer).
    try {
      await fastify.authenticate(request);
    } catch (err) {
      await logAuditEvent(
        null,
        'ADMIN_ACCESS_DENIED',
        'route',
        `${request.method} ${request.routeOptions.url ?? request.url}`,
        { decision: 'denied', reason: 'unauthenticated' },
        request,
      );
      throw err;
    }

    // Path B: authenticated but not admin.
    if (request.userRole !== 'admin') {
      await logAuditEvent(
        request.userId,
        'ADMIN_ACCESS_DENIED',
        'route',
        `${request.method} ${request.routeOptions.url ?? request.url}`,
        { decision: 'denied', reason: 'not_admin' },
        request,
      );
      throw fastify.httpErrors.forbidden('Admin access required');
    }
  });
```

Add import:

```diff
 import { userHasPermission, userHasGlobalPermission } from '../services/rbac-service.js';
+import { logAuditEvent } from '../services/audit-service.js';
```

Notes:
- **`request.routeOptions.url`** (Fastify 5) = route template. Fallback `request.url`.
- `request.ip` + `user-agent` auto-captured by `logAuditEvent` (`audit-service.ts:64–66`).
- `await` intentional — row committed before 403 returns; tests non-racey.

### Step 3 — Zod schema updates

`packages/contracts/src/schemas/admin.ts` — append to both schemas (v1 v2 symmetry with #268):

```diff
 export const AdminSettingsSchema = z.object({
   …
+  // Retention (days) for audit_log rows where action = 'ADMIN_ACCESS_DENIED' (#264).
+  // The default covers routine forensics; extend via the data-retention worker.
+  adminAccessDeniedRetentionDays: z.number().int().min(7).max(3650).optional(),
 });

 export const UpdateAdminSettingsSchema = z.object({
   …
+  adminAccessDeniedRetentionDays: z.number().int().min(7).max(3650).optional(),
 });
```

### Step 4 — migration `057_admin_settings_denied_admin_retention.sql`

```sql
-- Migration 057: retention policy for ADMIN_ACCESS_DENIED audit rows (#264)
--
-- Seeds the admin-configurable retention window (days) for the
-- `data-retention-service`-driven purge of `audit_log` rows with
-- `action = 'ADMIN_ACCESS_DENIED'`.
--
-- Range (Zod): [7, 3650]. Default: 90.
--
-- Read cascade (see `data-retention-service.ts :: runAdminAccessDeniedRetention`):
--   admin_settings.admin_access_denied_retention_days
--     → env RETENTION_ADMIN_ACCESS_DENIED_DAYS  (optional)
--     → 90  (hard default)
--
-- Additive + idempotent.
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('admin_access_denied_retention_days', '90', NOW())
ON CONFLICT (setting_key) DO NOTHING;
```

### Step 5 — extend `data-retention-service.ts`

At the module top, add the cap getter (parallel to #268's `getStreamCap` but without a cache — retention runs once per 24 h, so DB reads are cheap and non-cached is simpler):

```typescript
const ADMIN_ACCESS_DENIED_DEFAULT_DAYS = 90;
const ADMIN_ACCESS_DENIED_DB_KEY = 'admin_access_denied_retention_days';

async function resolveAdminAccessDeniedRetentionDays(): Promise<number> {
  try {
    const r = await getPool().query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
      [ADMIN_ACCESS_DENIED_DB_KEY],
    );
    const db = r.rows[0]?.setting_value;
    if (db) {
      const n = parseInt(db, 10);
      if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read admin_access_denied_retention_days; falling back');
  }
  const env = process.env.RETENTION_ADMIN_ACCESS_DENIED_DAYS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 7 && n <= 3650) return n;
  }
  return ADMIN_ACCESS_DENIED_DEFAULT_DAYS;
}
```

Add the batched purge function:

```typescript
/**
 * Purge audit_log rows with action='ADMIN_ACCESS_DENIED' older than the
 * admin-configured retention window. Batched to avoid long lockups on large
 * tables. Returns total rows deleted.
 *
 * Intentionally scoped to a single action — does NOT touch rows with other
 * action values, preserving whatever policy governs them (the umbrella
 * `audit_log: 365 days` entry still applies separately).
 */
async function runAdminAccessDeniedRetention(): Promise<number> {
  const days = await resolveAdminAccessDeniedRetentionDays();
  const pool = getPool();
  const BATCH_SIZE = 10_000;
  let totalDeleted = 0;
  try {
    for (;;) {
      const { rowCount } = await pool.query(
        `DELETE FROM audit_log
         WHERE id IN (
           SELECT id FROM audit_log
           WHERE action = 'ADMIN_ACCESS_DENIED'
             AND created_at < NOW() - INTERVAL '1 day' * $1
           LIMIT $2
         )`,
        [days, BATCH_SIZE],
      );
      const n = rowCount ?? 0;
      totalDeleted += n;
      if (n < BATCH_SIZE) break;
    }
    if (totalDeleted > 0) {
      logger.info({ deleted: totalDeleted, retentionDays: days },
        'ADMIN_ACCESS_DENIED retention cleanup completed');
    }
  } catch (err) {
    logger.error({ err }, 'ADMIN_ACCESS_DENIED retention cleanup failed');
  }
  return totalDeleted;
}
```

Extend `runRetentionCleanup()` to call it:

```diff
   // Time-based retention for audit_log, search_analytics, error_log
   for (const [table, days] of Object.entries(RETENTION_DEFAULTS)) {
     …
   }

+  // Targeted retention for ADMIN_ACCESS_DENIED audit rows (#264).
+  // Runs after the umbrella `audit_log: 365 days` sweep above; any rows that
+  // survived the umbrella AND are > admin_access_denied_retention_days old
+  // AND have action='ADMIN_ACCESS_DENIED' are purged here.
+  results['audit_log_admin_access_denied'] = await runAdminAccessDeniedRetention();

   // Count-based retention for page_versions
```

Notes:
- **Order matters.** The umbrella `audit_log` sweep (default 365 d) runs first. The targeted sweep (default 90 d, narrower) catches the younger-but-still-stale denial rows. Expressing them as separate sweeps keeps each policy independently tunable.
- **Parameterised SQL only** — `$1 = days`, `$2 = BATCH_SIZE`.
- **Batched with `LIMIT`** — avoids multi-minute table locks on a large `audit_log`. Loops until a short batch signals drained.
- **No schema change** required on `audit_log`. Optional perf follow-up: add `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_action_created ON audit_log (action, created_at)` in a later PR if `EXPLAIN` shows a sequential scan on large tables. Out of scope here.

### Step 6 — admin-settings GET/PUT wiring

`backend/src/routes/foundation/admin.ts`:

- Extend `WHERE setting_key IN (…)` (`:237`, `:284`) with `'admin_access_denied_retention_days'`.
- Extend returned map (`:248`) with `adminAccessDeniedRetentionDays: parseInt(map['admin_access_denied_retention_days'] ?? '90', 10)`.
- Extend PUT (`:328`): on `body.adminAccessDeniedRetentionDays !== undefined`, push `{ key: 'admin_access_denied_retention_days', value: String(body.adminAccessDeniedRetentionDays) }`. Audit-log as existing `ADMIN_ACTION`.

Parameterised SQL throughout.

### Step 7 — frontend UI

`frontend/src/features/admin/DataRetentionTab.tsx`:

- Append a row for the new setting: numeric input (min 7, max 3650), labelled "Admin access-denied audit retention (days)".
- Helper text: *"Automated purge of audit_log rows recorded when non-admins attempted admin endpoints. Default 90 days. Applies only to rows with action 'ADMIN_ACCESS_DENIED'; other audit events retain their own retention."*
- Wire through the existing admin-settings TanStack-Query mutation used by this file for other retention entries.

**No new sub-tab, no new file.**

### Step 8 — env-var docs

`CLAUDE.md` — add under Environment:
```
- `RETENTION_ADMIN_ACCESS_DENIED_DAYS` (optional env fallback for the admin-configurable `admin_access_denied_retention_days` setting, issue #264; consulted only when the `admin_settings` row is absent; fallback-of-last-resort: `90`)
```

`.env.example`: same line as a comment.

### Step 9 — tests

#### Decorator tests (`auth.test.ts`)

**RED #1 — non-admin → 403 + audit row:**
```typescript
it('requireAdmin writes ADMIN_ACCESS_DENIED when a non-admin is rejected', async () => {
  const userId = await createTestUser({ role: 'user' });
  const token = await signAccessToken(userId, 'user');
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/embedding/locks/target-user/release',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(403);
  const rows = await query(
    `SELECT user_id, action, resource_type, resource_id, metadata
     FROM audit_log WHERE action = 'ADMIN_ACCESS_DENIED' ORDER BY created_at DESC LIMIT 1`,
  );
  expect(rows.rows[0]).toMatchObject({
    user_id: userId,
    action: 'ADMIN_ACCESS_DENIED',
    resource_type: 'route',
    resource_id: expect.stringMatching(/^POST .+embedding\/locks/),
  });
  expect(rows.rows[0].metadata).toMatchObject({ decision: 'denied', reason: 'not_admin' });
});
```

**RED #2 — unauth → 401 + audit with null user:**
```typescript
it('requireAdmin writes ADMIN_ACCESS_DENIED with user_id=null when unauthenticated', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/embedding/locks/target-user/release',
  });
  expect(res.statusCode).toBe(401);
  const rows = await query(
    `SELECT user_id, metadata FROM audit_log
     WHERE action = 'ADMIN_ACCESS_DENIED' ORDER BY created_at DESC LIMIT 1`,
  );
  expect(rows.rows[0].user_id).toBeNull();
  expect(rows.rows[0].metadata).toMatchObject({ decision: 'denied', reason: 'unauthenticated' });
});
```

**RED #3 — admin success NOT audited as denial:**
```typescript
it('requireAdmin does not write ADMIN_ACCESS_DENIED for a successful admin request', async () => {
  const adminId = await createTestUser({ role: 'admin' });
  const token = await signAccessToken(adminId, 'admin');
  await app.inject({
    method: 'GET',
    url: '/api/admin/embedding/locks',
    headers: { authorization: `Bearer ${token}` },
  });
  const rows = await query(`SELECT COUNT(*)::int AS c FROM audit_log WHERE action = 'ADMIN_ACCESS_DENIED'`);
  expect(rows.rows[0].c).toBe(0);
});
```

#### Retention tests (`data-retention-service.test.ts`)

**RED #4 — old denial rows purged:**
```typescript
it('purges ADMIN_ACCESS_DENIED rows older than the configured retention', async () => {
  await query(`DELETE FROM audit_log`);
  await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
               ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
              ['admin_access_denied_retention_days', '30']);
  // Seed two old rows (35 days ago) and one fresh (5 days ago).
  await query(`INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
               VALUES (NULL, 'ADMIN_ACCESS_DENIED', 'route', 'GET /x', '{}'::jsonb, NOW() - INTERVAL '35 days')`);
  await query(`INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
               VALUES (NULL, 'ADMIN_ACCESS_DENIED', 'route', 'GET /y', '{}'::jsonb, NOW() - INTERVAL '35 days')`);
  await query(`INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
               VALUES (NULL, 'ADMIN_ACCESS_DENIED', 'route', 'GET /z', '{}'::jsonb, NOW() - INTERVAL '5 days')`);

  await runRetentionCleanup();

  const remaining = await query(`SELECT resource_id FROM audit_log WHERE action = 'ADMIN_ACCESS_DENIED'`);
  expect(remaining.rows.map((r) => r.resource_id).sort()).toEqual(['GET /z']);
});
```

**RED #5 — young rows NOT purged:**
```typescript
it('does not purge ADMIN_ACCESS_DENIED rows younger than retention', async () => {
  await query(`DELETE FROM audit_log`);
  await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
               ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
              ['admin_access_denied_retention_days', '90']);
  await query(`INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
               VALUES (NULL, 'ADMIN_ACCESS_DENIED', 'route', 'GET /a', '{}'::jsonb, NOW() - INTERVAL '30 days')`);
  await runRetentionCleanup();
  const r = await query(`SELECT COUNT(*)::int AS c FROM audit_log WHERE action = 'ADMIN_ACCESS_DENIED'`);
  expect(r.rows[0].c).toBe(1);
});
```

**RED #6 — successful admin rows never purged by this sweep:**
```typescript
it('does not touch ADMIN_ACTION rows regardless of age', async () => {
  await query(`DELETE FROM audit_log`);
  await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
               ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
              ['admin_access_denied_retention_days', '30']);
  // 35-day-old ADMIN_ACTION success row — should survive this sweep.
  // (The umbrella `audit_log` retention (365 d default) handles it elsewhere.)
  await query(`INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
               VALUES ('admin-1', 'ADMIN_ACTION', 'admin_settings', NULL, '{}'::jsonb, NOW() - INTERVAL '35 days')`);
  await runRetentionCleanup();
  const r = await query(`SELECT COUNT(*)::int AS c FROM audit_log WHERE action = 'ADMIN_ACTION'`);
  expect(r.rows[0].c).toBe(1);
});
```

**RED #7 — setting change takes effect on next tick:**
```typescript
it('picks up a setting change on the next retention tick', async () => {
  await query(`DELETE FROM audit_log`);
  // Start with lenient retention (100 d); 50-day-old row should survive.
  await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
               ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
              ['admin_access_denied_retention_days', '100']);
  await query(`INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
               VALUES (NULL, 'ADMIN_ACCESS_DENIED', 'route', 'GET /q', '{}'::jsonb, NOW() - INTERVAL '50 days')`);
  await runRetentionCleanup();
  expect((await query(`SELECT COUNT(*)::int AS c FROM audit_log`)).rows[0].c).toBe(1);

  // Tighten retention to 30 d. No cache (resolve is on-demand); next tick honours it.
  await query(`UPDATE admin_settings SET setting_value='30' WHERE setting_key='admin_access_denied_retention_days'`);
  await runRetentionCleanup();
  expect((await query(`SELECT COUNT(*)::int AS c FROM audit_log`)).rows[0].c).toBe(0);
});
```

### Step 10 — no route-file changes for `requireAdmin` consumers

Handlers don't special-case denials. Grep-verify post-change.

---

## 3. Rollback procedure

1. `git revert <commit-sha>`.
2. No schema DDL.
3. Residual `ADMIN_ACCESS_DENIED` rows harmless. Optional: `DELETE FROM audit_log WHERE action = 'ADMIN_ACCESS_DENIED';`.
4. Residual admin_settings row: harmless; optional `DELETE FROM admin_settings WHERE setting_key = 'admin_access_denied_retention_days';`.
5. Migration `057` is forward-only. No reverse.

---

## 4. Acceptance criteria mapped to issue body

- [x] **"Every 403 from `requireAdmin` writes an audit row"** — Path B + RED #1.
- [x] **"No handler needs to special-case"** — no handler edits.
- [x] **"Non-admin POST to force-release → audit with `decision: 'denied'`"** — RED #1.
- [x] **"Unauthenticated call audited with `actorUserId: null`"** — Path A + RED #2.
- [x] **Retention via data-retention-service.ts** — §2 Step 5 extends the existing service; scheduler/logging reused.
- [x] **Purge targets only `ADMIN_ACCESS_DENIED`** — RED #4 / #5 / #6.
- [x] **Admin-configurable, min 7 / max 3650 / default 90** — Zod + migration 057.
- [x] **Batched DELETE** — `LIMIT 10000` loop in §2 Step 5.
- [x] **UI in DataRetentionTab** — §2 Step 7.

---

## 5. Risks and open questions

1. **Storm risk.** ~10 req/s brute force × 24 h ≈ 860k rows/day. With default 90-day retention that's up to ~77M rows before purge kicks in. **Mitigations:**
   - Optional `idx_audit_log_action_created` index (not shipped with this PR — file as separate perf issue if `EXPLAIN` shows sequential scan).
   - Rate-limit admin routes lower than we already do (separate issue).
   - Lower default retention if stakeholders prefer — 30 days is plausible.

2. **Does `request.routeOptions.url` exist when `authenticate` throws?** Yes — Fastify 5 matches routes before `preHandler`. Assert in RED.

3. **Audit-log retention coupling.** The umbrella `audit_log: 365 days` sweep runs first; if an admin sets denied-retention > 365 d, the umbrella evicts first. That's fine (conservative narrows strictly). Document: denied-retention is effectively `min(configured, umbrella-retention)`.

4. **Batching parameter.** 10,000 rows/batch chosen defensively. If real workloads show lock contention, drop to 1,000. Not worth a config knob yet.

5. **Interaction with other retention ideas.** Future extensions (e.g. `PROMPT_INJECTION_DETECTED` retention) can follow the exact same pattern. Not spec'd here.

---

## 6. Dependencies and ordering

- **Migration numbering:** `057_admin_settings_denied_admin_retention.sql`. Coordinate with #268 (`056`). Swap if ship order flips.
- **File conflicts with other plans:**
  - `packages/contracts/src/schemas/admin.ts` — #268 also appends optional fields here; trivial textual merge.
  - `backend/src/routes/foundation/admin.ts` — #268 also extends the GET/PUT handlers here; trivial merge (different keys).
  - `data-retention-service.ts` — unique to this plan.
  - `auth.ts`, `audit-service.ts`, `auth.test.ts` — unique to this plan.
  - `DataRetentionTab.tsx` — unique to this plan. #268's UI sits in `LlmTab.tsx`.
- **Parallel with** #263, #265, #266, #267, #269.
- **Interaction with PR #261:** motivating route (`POST /api/admin/embedding/locks/:userId/release`) is from #261. If #261 hasn't landed, RED tests use `/api/llm/quality-rescan` at `knowledge-admin.ts:25–32`.

---

## 7. Estimated effort

~2 hours. Decorator rewrite (~20 LoC), audit-action union (1 line), `data-retention-service.ts` extension (~60 LoC), Zod + admin-route + migration + UI wiring (~50 LoC), seven Vitest cases.
