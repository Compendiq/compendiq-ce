/**
 * Sync conflict policy service (Compendiq/compendiq-ee#118).
 *
 * Wraps `admin_settings.sync_conflict_policy` behind an in-process cache that
 * invalidates cluster-wide via the cache-bus channel
 * `sync:conflict:policy:changed` (epic §3.1). The sync path reads the policy
 * once per page-conflict decision via `getSyncConflictPolicy()` — a sync
 * round (~1k pages) thus pays one cold-load DB round-trip total in the steady
 * state, and zero per-page round-trips.
 *
 * Three values, mirroring the EE plan (.plans/118-sync-conflict-resolution.md):
 *   - 'confluence-wins'  — overwrite local with Confluence (legacy behaviour).
 *   - 'compendiq-wins'   — keep local edits; skip the inbound write.
 *   - 'manual-review'    — stash incoming version in `pending_sync_versions`
 *                          and surface it for admin review.
 *
 * Default: 'confluence-wins'. CE and EE-without-feature behave identically
 * to pre-#118 (the new branches in `sync-service.ts::syncPage` are no-ops
 * when the policy resolves to 'confluence-wins' AND there are no local edits
 * — see the "no conflict, proceed normally" exit at the top of the conflict
 * detection block).
 *
 * The PUT handler that flips the value lives in the EE overlay
 * (`overlay/backend/src/routes/admin-sync-conflicts.ts`). It writes to
 * `admin_settings`, publishes on the cache-bus, and emits
 * `SYNC_POLICY_CHANGED`. CE-only deployments retain the default and never
 * hit this surface; the policy getter in CE returns the default for the
 * lifetime of the process.
 */

import { makeCachedSetting } from './cached-setting.js';

export type SyncConflictPolicy =
  | 'confluence-wins'
  | 'compendiq-wins'
  | 'manual-review';

const VALID_POLICIES: ReadonlySet<SyncConflictPolicy> = new Set([
  'confluence-wins',
  'compendiq-wins',
  'manual-review',
]);

export const DEFAULT_SYNC_CONFLICT_POLICY: SyncConflictPolicy = 'confluence-wins';

let getPolicy: (() => SyncConflictPolicy) | null = null;

function parseRawPolicy(raw: string | null): SyncConflictPolicy {
  if (raw && VALID_POLICIES.has(raw as SyncConflictPolicy)) {
    return raw as SyncConflictPolicy;
  }
  return DEFAULT_SYNC_CONFLICT_POLICY;
}

/**
 * Initialise the service: cold-load from admin_settings, subscribe to the
 * cache-bus channel, and wire a reconnect handler. Must be called once at
 * app startup AFTER the cache-bus is initialised.
 *
 * Idempotent across re-calls in tests (the underlying `makeCachedSetting`
 * starts fresh each time the mocks are reset). Fails soft: if the DB read
 * fails at cold-load, the getter returns `DEFAULT_SYNC_CONFLICT_POLICY` —
 * never throws.
 */
export async function initSyncConflictPolicyService(): Promise<void> {
  getPolicy = await makeCachedSetting<SyncConflictPolicy>({
    key: 'sync_conflict_policy',
    cacheBusChannel: 'sync:conflict:policy:changed',
    parse: parseRawPolicy,
    defaultValue: DEFAULT_SYNC_CONFLICT_POLICY,
  });
}

/**
 * Synchronous getter for the active policy. Returns the default when the
 * service has not been initialised — a deliberate safety default so a
 * startup-order regression cannot accidentally activate `manual-review`
 * mode (which would silently start queueing pending versions on every
 * sync) when the operator hasn't configured the feature.
 */
export function getSyncConflictPolicy(): SyncConflictPolicy {
  if (!getPolicy) return DEFAULT_SYNC_CONFLICT_POLICY;
  return getPolicy();
}

// Test seam: reset module state between tests. Mirrors the
// `_resetForTests` export on `ip-allowlist-service.ts` so the test harness
// can re-init the cached setting against fresh mocks without leaking the
// previous run's getter closure.
export function _resetForTests(): void {
  getPolicy = null;
}
