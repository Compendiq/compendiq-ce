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

/** Deduplicate in-flight refreshes, keyed on `${providerId}:${model}` */
const inFlightRefreshes = new Map<string, Promise<void>>();

interface CapabilityRow {
  vision: boolean | null;
  stale: boolean;
  probed_at: string;
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

async function persist(
  providerId: string,
  model: string,
  vision: boolean | null,
  error: string | undefined,
): Promise<void> {
  await query(
    `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at, probe_error)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (provider_id, model) DO UPDATE
       SET vision = EXCLUDED.vision,
           probed_at = EXCLUDED.probed_at,
           probe_error = EXCLUDED.probe_error`,
    [providerId, model, vision, error ?? null],
  );
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

/** Always probes, then persists. Used by admin save and the re-probe action. */
export async function refreshVisionCapability(
  providerId: string,
  model: string,
): Promise<boolean | null> {
  const cfg = await loadProviderConfig(providerId);
  const { vision, error } = await probeVision(cfg, model);
  await persist(providerId, model, vision, error);
  return vision;
}

/**
 * Returns the cached verdict immediately, never blocking on a probe.
 *
 * Schedules a background refresh if:
 * - No row exists
 * - The verdict is NULL (undetermined)
 * - The row is stale (older than CAPABILITY_MAX_AGE_DAYS)
 * - The last probe is outside the cooldown window (CAPABILITY_PROBE_COOLDOWN_MINUTES)
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
  const needsRefresh = !row || row.vision === null || row.stale || isOutsideCooldown(row.probed_at);

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
 * Drop a provider's verdicts. Called from the provider-service update path,
 * because a changed base_url or key can put an entirely different model
 * behind the same name.
 */
export async function invalidateProviderCapabilities(providerId: string): Promise<void> {
  await query(`DELETE FROM llm_model_capabilities WHERE provider_id = $1`, [providerId]);
}
