import { query } from '../db/postgres.js';
import { VECTOR_MAX_DIMS } from '../db/vector-column-tier.js';
import { logger } from '../utils/logger.js';

/**
 * #1115 — the MRL truncation width the image leg REQUESTS, or null for "take
 * whatever the served checkpoint answers with".
 *
 * **Why this is a stored setting and not a serving flag.** vLLM's `dimensions`
 * is a *per-request* parameter; `--hf-overrides '{"is_matryoshka": true}'` only
 * makes the server ACCEPT it, and there is no serve-time flag that changes the
 * default output width. So an 8B served at its native 4096 stays at 4096 —
 * pgvector's unindexed tier — until a **client** asks for less. This row is
 * where that number lives.
 *
 * **Every image-side call must send the same value.** The probe
 * (`probeImageEmbedding`) sends it and refuses when the answer comes back at a
 * different width; `ensureImageEmbeddingColumn` types the column to it and
 * carries it in the identity that triggers a rebuild. P2's image embedder and
 * P3's query embed read THIS function for the same number — a writer that sends
 * a different width fills a column typed for another one, which is the
 * silent-wrong-vectors class the whole probe gate exists to close.
 *
 * Uncached on purpose (the `getFtsLanguage` precedent): it is read at most a
 * handful of times per admin action, and a 60-second cache would let a probe
 * fired seconds after the width was saved measure the OLD width and type the
 * column to it.
 */
export const IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY = 'image_embedding_target_dimensions';

/**
 * Reads the configured truncation width.
 *
 * A row that is absent, unparseable or out of pgvector's range reads as null —
 * "native width". Discarding rather than throwing is deliberate: the value can
 * arrive from psql, a restored dump or a future migration without passing
 * through `UpdateAdminSettingsSchema`, and the safe interpretation of a
 * nonsense truncation width is to ask for no truncation at all. It is also
 * interpolated nowhere: it travels as a JSON body field, and the width the
 * column is typed to comes from what the model ANSWERED, through
 * `columnTypeFor`.
 */
export async function getImageEmbeddingTargetDimensions(): Promise<number | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY],
  );
  const raw = r.rows[0]?.setting_value;
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > VECTOR_MAX_DIMS) {
    logger.warn(
      { raw, setting: IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY },
      'Ignoring an out-of-range image-embedding truncation width — the image leg will use the model\'s native width',
    );
    return null;
  }
  return parsed;
}
