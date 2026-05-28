# Audit-log-driven restriction-change detection

**Date:** 2026-05-28
**Status:** Approved design (revised after spec self-review — see "Why per-page, not a global cursor")
**Area:** `backend` · `confluence` domain · sync pipeline (EE + `RAG_PERMISSION_ENFORCEMENT` only)

## Problem

When `RAG_PERMISSION_ENFORCEMENT` is enabled (EE), every sync run mirrors each
page's Confluence read-restrictions into `access_control_entries` (ACEs) so RAG
answers never leak restricted content. The mirror requires a
`getPageRestrictions(pageId)` HTTP call **per page, every run** — even for pages
whose restrictions never changed.

Confluence restrictions change *independently* of content version, so we cannot
use `version.number` / `history.lastUpdated` to decide whether a re-fetch is
needed (verified against DC 9.x: no restriction-modified timestamp exists on the
content object or the `/restriction` endpoints). The result is O(pages)
restriction calls per sync on large spaces, bounded only by the 60 RPM rate
limiter and the per-run `ancestorCache`.

## Goal

Re-fetch restrictions only for pages whose restrictions **actually changed**,
detected via the Confluence **Audit Log API**.

### Non-negotiable correctness guarantee

A pure performance layer that **degrades to today's exact behavior on any
uncertainty.** A page's ACEs are *never* staler than today. There is **no**
ACL-staleness / information-disclosure trade-off — every "not sure" path fetches.

## Non-goals

- No inbound webhooks (would need an inbound endpoint + Confluence-side admin
  config). Audit-log polling is pull-based.
- No change to CE or un-flagged EE behavior. Gated behind
  `RAG_PERMISSION_ENFORCEMENT`, like the restriction sync it optimizes.

## Verified API facts (Confluence Data Center 9.x)

- `GET /rest/api/audit` records: `category` (e.g. `"Permissions"`), `creationDate`
  (epoch ms), `summary`, `affectedObject { id, type, name }`, `changedValues[]`,
  `associatedObjects[]`. Page-restriction events carry the page as `affectedObject`
  with a **numeric content id** in `affectedObject.id` and `type === "page"`.
  (Caveat: some builds use `objectType` instead of `type` — read whichever exists.)
- Query: `startDate`/`endDate` (epoch ms), `searchString`, `start`/`limit`
  (max 1000). Envelope `{ results, start, limit, size, _links.next }`.
- `GET /rest/api/audit/retention` → `{ number, units }`.
- Requires **Confluence Administrator**. Without it: `403` (authenticated) /
  `404` (otherwise). Records past the retention window are purged.

## Why per-page high-water marks, not a global cursor

`syncUser(userId)` only visits pages in that user's accessible spaces. A single
global "last processed audit time" cursor is **unsafe**: user A's run would
advance the cursor past a change-event for page P that A can't see; when user B
later syncs P, the event is behind the cursor and P is wrongly treated as
unchanged → **stale ACE**. So freshness is tracked **per page**, and each page's
own `restrictions_synced_at` is its high-water mark. Advancing one page's mark
never affects another's.

## State model

- **`pages.restrictions_synced_at TIMESTAMPTZ NULL`** — when this page's ACEs
  were last mirrored from Confluence. `NULL` = never mirrored. Set to the run's
  `auditQueryAt` whenever we fetch+mirror. **Not** updated on skip.
- **Confirm window `W`** — `RESTRICTION_CONFIRM_WINDOW_HOURS` (default `168` = 7
  days). A page whose mark is older than `now - W` is force-fetched regardless of
  audit, which (a) bounds the audit query to `W` and (b) guarantees every page is
  re-confirmed at least once per `W` even if the audit log ever missed an event.
- No persistent global cursor.

## Components (all CE, `confluence` domain)

### 1. `confluence-client.ts` — audit access
- `getAuditRecords({ startDate, endDate?, start?, limit? }): Promise<ConfluenceAuditRecord[]>`
  — fully paginates (`_links.next` / `start`+`limit`).
- `getAuditRetention(): Promise<AuditRetention>`.
- New exported types `ConfluenceAuditRecord`, `AuditRetention`.
- `403`/`404` → throw typed `AuditUnavailableError`.
- Reads `affectedObject.type ?? affectedObject.objectType`.

### 2. `restriction-change-tracker.ts` — the decision brain (new service)
```
getRestrictionChangeSet(client, nowMs): Promise<ChangeSet>
type ChangeSet =
  | { mode: 'full' }                                    // fetch everything (fail-safe)
  | { mode: 'incremental'; changedPageIds: Set<string>; windowStartMs: number; auditQueryAt: number }
```
Logic:
1. `auditQueryAt = nowMs`. Desired `windowStartMs = nowMs - W`.
2. `getAuditRetention()`; `effectiveStart = max(windowStartMs, nowMs - retentionMs)`.
   (If retention `< W`, the window narrows; pages older than `effectiveStart` are
   force-fetched by the skip rule, so correctness holds.)
3. `getAuditRecords({ startDate: effectiveStart })`, paginated; keep records with
   `category === 'Permissions'` **and** `affectedObject.type === 'page'`; collect
   `affectedObject.id`.
4. Any matching record without a parseable page id → `{ mode: 'full' }` (conservative).
5. Else → `{ mode: 'incremental', changedPageIds, windowStartMs: effectiveStart, auditQueryAt }`.
6. Any thrown error (`AuditUnavailableError`, 5xx, timeout) → `{ mode: 'full' }`
   + one throttled warning.

### 3. Migration `075_pages_restrictions_synced_at.sql`
- `ALTER TABLE pages ADD COLUMN restrictions_synced_at TIMESTAMPTZ NULL;`

### 4. `sync-service.ts` wiring
- In `syncUser`, only when `RAG_PERMISSION_ENFORCEMENT` is on: compute the
  change-set once (`const changeSet = await getRestrictionChangeSet(client, Date.now())`),
  thread it + its `windowStartMs`/`auditQueryAt` into `syncPageRestrictions(...)`.

## The skip rule (crux — fail-safe by construction)

Inside `syncPageRestrictions`, skip the `getPageRestrictions` fetch **iff all of:**
1. `changeSet.mode === 'incremental'`, **and**
2. `page.restrictions_synced_at` is non-null **and** `>= changeSet.windowStartMs`
   (within the audit-covered confirm window), **and**
3. `page.id ∉ changeSet.changedPageIds`.

Otherwise: full fetch + ACE mirror exactly as today, then stamp
`restrictions_synced_at = changeSet.auditQueryAt` (or `NOW()` in full mode).

New pages (`NULL`), pages older than the window, and any uncertainty → fetch.

### Why it's correct
A skipped page P has `restrictions_synced_at = m ≥ windowStartMs`, and the audit
window `(windowStartMs, now]` is fully covered with **no** change event for P.
Therefore no restriction change occurred to P since `m` → P's ACEs are current.
Skipping is safe. Anything that breaks an assumption (no audit coverage, mark too
old, change present, never mirrored) falls through to a fetch.

## Fail-safe matrix (all → full fetch; correctness == today)

| Condition | Behavior |
|---|---|
| First mirror of a page (`NULL` mark) | fetch that page |
| Mark older than confirm window `W` | fetch that page (+ re-stamp) |
| Audit `403`/`404` (no admin permission) | full mode + warn once |
| Audit `5xx` / timeout | full mode this run, retry next |
| Retention `< W` | window narrows; older pages fetched |
| Unparseable `Permissions` event | full mode |
| Partial run failure | marks only advance for pages actually fetched |

## Testing

- **Unit — `restriction-change-tracker`** (mock client): `403`→full; 5xx→full;
  retention-narrows-window; pagination across pages; `category`/`type` filtering;
  unparseable record→full; happy path returns correct `changedPageIds` +
  `windowStartMs`.
- **Unit — `confluence-client` audit methods** (mock fetch): epoch-ms params;
  `_links.next` pagination; `403`→`AuditUnavailableError`; `type` vs `objectType`.
- **Integration — `sync-service`** (real Postgres): incremental skips an unchanged,
  in-window page (assert `getPageRestrictions` **not** called); fetches a changed
  page; fetches a `NULL`-mark page; fetches an out-of-window page; full mode fetches
  all; `restrictions_synced_at` stamped only on fetched pages.

## Expected benefit

EE+RAG steady-state syncs: restriction fetches drop from O(pages) to
O(changed pages + pages older than `W`) per run, with **identical** ACL accuracy.

## Risks / mitigations

- `"Permissions"` includes non-page events → filtered by `affectedObject.type ===
  'page'`; a stray false positive only causes one extra (safe) fetch.
- Field-name variance (`type`/`objectType`) → read both.
- Audit log not enabled / admin perm absent → full mode (no regression vs. today).
