import { query } from '../../../core/db/postgres.js';
import { loadProviderConfig } from './llm-provider-resolver.js';
import { probeVision } from './vision-probe.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * #1154: persisted per-model capability verdicts (migration 087).
 *
 * Reads never block on a probe when a usable row exists, which is what keeps
 * GET /llm/usecase-default fast enough for AiContext's mount-time fetch.
 */

export const CAPABILITY_MAX_AGE_DAYS = 30;

interface CapabilityRow {
  vision: boolean | null;
  stale: boolean;
}

async function readRow(providerId: string, model: string): Promise<CapabilityRow | null> {
  const { rows } = await query<CapabilityRow>(
    `SELECT vision,
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
 * Returns the cached verdict, probing only when there is nothing usable:
 * no row, an unknown (NULL) verdict, or a row past CAPABILITY_MAX_AGE_DAYS.
 * A cached `false` is an answer and is not re-probed.
 */
export async function getVisionCapability(
  providerId: string,
  model: string,
): Promise<boolean | null> {
  const row = await readRow(providerId, model);
  if (row && row.vision !== null && !row.stale) return row.vision;

  try {
    return await refreshVisionCapability(providerId, model);
  } catch (err) {
    // Probing is best-effort on the read path: a resolver failure must not
    // turn a capability question into a 500 on the caller.
    logger.warn(
      { providerId, model, err: err instanceof Error ? err.message : String(err) },
      'Vision capability refresh failed',
    );
    return row?.vision ?? null;
  }
}

/**
 * Drop a provider's verdicts. Called from the provider-service update path,
 * because a changed base_url or key can put an entirely different model
 * behind the same name.
 */
export async function invalidateProviderCapabilities(providerId: string): Promise<void> {
  await query(`DELETE FROM llm_model_capabilities WHERE provider_id = $1`, [providerId]);
}
