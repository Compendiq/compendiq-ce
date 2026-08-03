import { query } from '../../../core/db/postgres.js';
import { loadProviderConfig } from './llm-provider-resolver.js';
import { probeVision } from './vision-probe.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * #1154: persisted per-model capability verdicts (migration 087).
 *
 * Reads are pure-cache: `getVisionCapability` returns immediately with the
 * stored verdict (or null if no row exists) and schedules a background refresh
 * if needed. This keeps GET /llm/usecase-default fast enough for AiContext's
 * mount-time fetch without ever blocking on an LLM round-trip.
 *
 * Writes are blocking: `refreshVisionCapability` probes and persists synchronously,
 * used by the admin save path and future re-probe actions.
 */

export const CAPABILITY_MAX_AGE_DAYS = 30;
export const CAPABILITY_PROBE_COOLDOWN_MINUTES = 5;

/**
 * #1184 — cap on the `probe_error` any caller can see.
 *
 * An HTTP-derived failure is already bounded: `LlmHttpError.detail` is sliced
 * to `ERROR_BODY_MAX_CHARS` (500). A *non*-HTTP failure is not — `probeVision`
 * stores `err.message` verbatim and `probe_error` is an untyped `TEXT` column,
 * so a chatty driver error lands whole. The bound is applied at the read
 * boundary rather than at write time so it also covers rows written before it
 * existed, and so no route or component has to remember it.
 *
 * 600 rather than 500: `describeProbeFailure` prefixes the provider's body
 * with the operation and status (`chat HTTP 415: …`), so a legitimate
 * fully-sized HTTP detail has to survive intact.
 */
export const PROBE_ERROR_MAX_CHARS = 600;

/** Deduplicate in-flight refreshes, keyed on `${providerId}:${model}` */
const inFlightRefreshes = new Map<string, Promise<void>>();

interface CapabilityRow {
  vision: boolean | null;
  stale: boolean;
  probed_at: string;
}

/**
 * #1184: the stored verdict plus the evidence behind it.
 *
 * `probeError` is the provider's own error body and is **admin-only** — see
 * `llm-http-error.ts`. Never widen a non-admin response shape with it.
 */
export interface VisionCapabilityDetail {
  vision: boolean | null;
  /** ISO-8601, from Postgres's clock. */
  probedAt: string;
  probeError: string | null;
}

/** Bound third-party error text before it leaves this module. */
function truncateProbeError(error: string | null | undefined): string | null {
  if (!error) return null;
  if (error.length <= PROBE_ERROR_MAX_CHARS) return error;
  return `${error.slice(0, PROBE_ERROR_MAX_CHARS - 1)}…`;
}

/** `TIMESTAMPTZ` arrives from `pg` as a `Date`; normalise to ISO-8601 either way. */
function toIso(probedAt: Date | string): string {
  return new Date(probedAt).toISOString();
}

async function readRow(providerId: string, model: string): Promise<CapabilityRow | null> {
  const { rows } = await query<CapabilityRow>(
    `SELECT vision,
            probed_at,
            (probed_at < NOW() - ($3 || ' days')::INTERVAL) AS stale
       FROM llm_model_capabilities
      WHERE provider_id = $1 AND model = $2`,
    [providerId, model, String(CAPABILITY_MAX_AGE_DAYS)],
  );
  return rows[0] ?? null;
}

/** Writes the verdict and answers with the `probed_at` Postgres stamped on it. */
async function persist(
  providerId: string,
  model: string,
  vision: boolean | null,
  error: string | undefined,
): Promise<string> {
  const { rows } = await query<{ probed_at: Date | string }>(
    `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at, probe_error)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (provider_id, model) DO UPDATE
       SET vision = EXCLUDED.vision,
           probed_at = EXCLUDED.probed_at,
           probe_error = EXCLUDED.probe_error
     RETURNING probed_at`,
    [providerId, model, vision, error ?? null],
  );
  return toIso(rows[0]!.probed_at);
}

/**
 * #1184: the admin-facing counterpart to the private `readRow` — same row,
 * but carrying `probe_error` and no staleness arithmetic, and it never
 * schedules a probe. Returns null when the pair has never been probed.
 *
 * Kept separate from `readRow` rather than widening it: `getVisionCapability`
 * feeds a non-admin route and must not have `probe_error` within reach.
 */
export async function readVisionCapabilityDetail(
  providerId: string,
  model: string,
): Promise<VisionCapabilityDetail | null> {
  const { rows } = await query<{
    vision: boolean | null;
    probed_at: Date | string;
    probe_error: string | null;
  }>(
    `SELECT vision, probed_at, probe_error
       FROM llm_model_capabilities
      WHERE provider_id = $1 AND model = $2`,
    [providerId, model],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    vision: row.vision,
    probedAt: toIso(row.probed_at),
    probeError: truncateProbeError(row.probe_error),
  };
}

/**
 * Check if the probed_at timestamp is outside the cooldown window.
 * Returns true if more than CAPABILITY_PROBE_COOLDOWN_MINUTES have elapsed.
 */
function isOutsideCooldown(probedAt: string): boolean {
  const lastProbeTime = new Date(probedAt).getTime();
  const cooldownMs = CAPABILITY_PROBE_COOLDOWN_MINUTES * 60 * 1000;
  return Date.now() - lastProbeTime > cooldownMs;
}

/**
 * Always probes, then persists. Used by admin save and the re-probe action.
 *
 * #1184: returns the evidence as well as the verdict, so the manual re-probe
 * route can answer with what it just learned. Returned from the probe rather
 * than re-read afterwards — a re-read is a second round-trip that a concurrent
 * background refresh of the same key could win, handing the admin a different
 * verdict than the one their click produced.
 */
export async function refreshVisionCapability(
  providerId: string,
  model: string,
): Promise<VisionCapabilityDetail> {
  const cfg = await loadProviderConfig(providerId);
  const { vision, error } = await probeVision(cfg, model);
  const probedAt = await persist(providerId, model, vision, error);
  return { vision, probedAt, probeError: truncateProbeError(error) };
}

/**
 * Returns the cached verdict immediately, never blocking on a probe.
 *
 * Schedules a background refresh if:
 * - No row exists
 * - The row is stale (older than CAPABILITY_MAX_AGE_DAYS)
 * - The verdict is NULL (undetermined) *and* the last probe is outside the
 *   cooldown window (CAPABILITY_PROBE_COOLDOWN_MINUTES)
 *
 * The cooldown is not an independent trigger — it only rate-limits the NULL
 * case. A fresh, definite verdict is never re-probed just because the cooldown
 * elapsed; that would fire a probe on effectively every request. Do not
 * "restore" the code to a reading of this list that makes it one.
 *
 * The refresh is deduplicated across concurrent callers and logs failures rather
 * than throwing, so a cold cache or a permanently-NULL verdict never blocks the
 * caller or turns a capability question into a 500.
 */
export async function getVisionCapability(
  providerId: string,
  model: string,
): Promise<boolean | null> {
  const row = await readRow(providerId, model);

  // Return the cached verdict immediately if it is fresh and definite.
  if (row && row.vision !== null && !row.stale) {
    return row.vision;
  }

  // Decide whether to schedule a background refresh based on the cooldown.
  const key = `${providerId}:${model}`;
  // Refresh if: no row, stale row, or NULL verdict outside cooldown window
  const needsRefresh = !row || row.stale || (row.vision === null && isOutsideCooldown(row.probed_at));

  if (needsRefresh && !inFlightRefreshes.has(key)) {
    // Schedule the refresh as a background task (fire-and-forget).
    // This keeps the read path pure-cache.
    const refreshPromise = refreshVisionCapability(providerId, model)
      .catch((err) => {
        logger.warn(
          { providerId, model, err: err instanceof Error ? err.message : String(err) },
          'Vision capability refresh failed (background)',
        );
      })
      .finally(() => {
        inFlightRefreshes.delete(key);
      }) as Promise<void>;

    inFlightRefreshes.set(key, refreshPromise);
  }

  // Return the cached verdict (possibly NULL) immediately without waiting.
  return row?.vision ?? null;
}

/**
 * TEST ONLY — await every background refresh `getVisionCapability` has
 * scheduled. Production code must never call this: the read path is
 * deliberately fire-and-forget, and awaiting it would reintroduce the
 * LLM round-trip on the request path that this module exists to avoid.
 *
 * Tests need it because the alternative is sleeping a fixed number of
 * milliseconds and hoping two Postgres round-trips finish first, which fails
 * outright on a loaded CI runner rather than flaking.
 */
export async function __flushRefreshesForTests(): Promise<void> {
  await Promise.all([...inFlightRefreshes.values()]);
}

/**
 * Drop a provider's verdicts. Called from the provider-service update path,
 * because a changed base_url or key can put an entirely different model
 * behind the same name.
 */
export async function invalidateProviderCapabilities(providerId: string): Promise<void> {
  await query(`DELETE FROM llm_model_capabilities WHERE provider_id = $1`, [providerId]);
}
