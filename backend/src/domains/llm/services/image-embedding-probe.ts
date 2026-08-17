/**
 * #1115 — establish, by asking, whether an assigned provider+model can serve
 * the image index. The `vision-probe.ts` precedent, applied to a different
 * question.
 *
 * Capability here is not "does the model claim to be multimodal" — nothing in
 * an OpenAI-compatible `/v1/models` response says so — but the sharper
 * operational question: **does this endpoint answer vLLM's chat-embeddings
 * `messages` shape, for an image and for a text, with vectors of the same
 * width?** All three halves matter:
 *
 *  - **The `messages` shape**, because a plain text-embedding server refuses it
 *    (400/422 from pydantic) and that refusal is the misassignment we exist to
 *    catch, loudly, at assignment time rather than as bad retrieval later.
 *  - **An image AND a text**, because a server can accept both and template
 *    them DIFFERENTLY — `mlx_vlm.server` applies the chat template to images
 *    and skips it for text — which puts two spaces into one column. A width
 *    disagreement is the only symptom reachable from here, and it is worth
 *    refusing on.
 *  - **The width**, because it picks the column type and the HNSW opclass
 *    (`ensureImageEmbeddingColumn`). The same probe-then-DDL pattern the text
 *    column already uses; nothing client-supplied is trusted.
 *  - **The width the deployment ASKED for**, when
 *    `admin_settings.image_embedding_target_dimensions` is set. MRL truncation
 *    is a per-request parameter, so the probe sends it and requires the answer
 *    to come back at exactly it: a server without
 *    `--hf-overrides '{"is_matryoshka": true}'` either refuses the parameter or
 *    ignores it, and an ignored one would type the column to the native width
 *    while P2's embedder keeps asking for the truncated one.
 *
 * The probe image is the three-colour-band PNG `vision-probe.ts` already ships.
 * Its *content* does not matter here — no answer is being interpreted — but
 * reusing it keeps one known-good raster in the tree rather than two.
 */
import { query } from '../../../core/db/postgres.js';
import { columnTypeFor, VECTOR_MAX_DIMS } from '../../../core/db/vector-column-tier.js';
import type { VectorColumnTier } from '../../../core/db/vector-column-tier.js';
import { PROBE_IMAGE_BASE64 } from './vision-probe.js';
import { PROBE_ERROR_MAX_CHARS } from './model-capabilities.js';
import { LlmHttpError } from './llm-http-error.js';
import {
  embedImagesVl,
  embedTextsVl,
  VL_QUERY_INSTRUCTION,
  VL_SHAPE_REFUSAL_STATUSES,
} from './vl-embedding-client.js';
import type { ProviderConfig } from './openai-compatible-client.js';
import { logger } from '../../../core/utils/logger.js';

/** `admin_settings` key holding the last probe, as JSON. */
export const IMAGE_EMBEDDING_PROBE_KEY = 'image_embedding_probe';

/**
 * Why a probe failed, in the categories an admin can act on. The route answers
 * with the CATEGORY; the provider's raw body stays on `error`, which only
 * admin surfaces ever see (#1184's rule).
 */
export type ImageProbeFailureReason =
  /**
   * The provider answered with a status that proves it is reachable and simply
   * does not accept this request: 400/404/405/422 — a plain text-embedding
   * server's pydantic refusal of the `messages` body, or a chat-only server
   * with no `/v1/embeddings` at all. **The wrong-kind-of-server verdict.**
   */
  | 'shape_rejected'
  /**
   * The provider answered with an error that is NOT about the request's shape:
   * 401/403 (credentials), 429 (rate limit), 5xx (a vLLM still loading the
   * model, or the intermittent multimodal-cache crash `vllm#33865`).
   *
   * Split out in review round 2, and the distinction is the operator's next
   * action: `shape_rejected` says "this server cannot serve the image leg —
   * use another"; this one says "the server you have had a problem — look at
   * it and try again". Folding a 503 into the first told an admin running
   * exactly the right vLLM to abandon it.
   */
  | 'provider_error'
  /** No HTTP answer at all: unreachable host, open breaker, abort, timeout. */
  | 'unreachable'
  /** Image and text came back at different widths — two spaces in one column. */
  | 'width_mismatch'
  /**
   * The endpoint ignored the requested MRL truncation and answered at a
   * different width. Almost always a server started without
   * `--hf-overrides '{"is_matryoshka": true}'`, which makes vLLM drop or refuse
   * `dimensions` — and it must refuse, because the column would be typed to the
   * width this probe measured while every later writer asks for another.
   */
  | 'dimensions_ignored'
  /** A width pgvector cannot STORE (its columns hold at most 16000). */
  | 'unusable_width';

export interface ImageEmbeddingProbeResult {
  dimensions: number | null;
  tier: VectorColumnTier | null;
  /** The provider's own body, bounded. Admin surfaces only. */
  error: string | null;
  reason: ImageProbeFailureReason | null;
}

/** What `readImageEmbeddingProbe` answers — the stored result plus its pair. */
export interface StoredImageEmbeddingProbe {
  providerId: string;
  model: string;
  dimensions: number | null;
  tier: VectorColumnTier | null;
  probedAt: string;
  error: string | null;
}

/** The text the probe asks the model to embed beside the image. */
const PROBE_TEXT = 'A photograph of three horizontal colour bands.';

/**
 * Bound third-party error text before it leaves this module — the same rule,
 * and the same constant, as `model-capabilities.ts`. `LlmHttpError.detail` is
 * already sliced, but a non-HTTP failure carries an untrimmed `err.message`.
 */
function truncate(error: string): string {
  if (error.length <= PROBE_ERROR_MAX_CHARS) return error;
  return `${error.slice(0, PROBE_ERROR_MAX_CHARS - 1)}…`;
}

/**
 * How long one probe call may take, queue wait included.
 *
 * An admin is watching a spinner, and the PUT that gates the assignment makes
 * two of these sequentially — so the whole gate is bounded by twice this, not
 * by `LLM_STREAM_TIMEOUT_MS` (300s) twice. Generous enough for a cold vLLM
 * with a busy queue, because an image prompt is 10–25x a short text one.
 */
export const IMAGE_PROBE_TIMEOUT_MS = 60_000;

/**
 * Classify a thrown failure.
 *
 * The status split is the shared `VL_SHAPE_REFUSAL_STATUSES` set, not a second
 * hand-written list: those four are exactly the statuses the client treats as
 * proof that the provider is reachable and refusing the *request*, and the
 * copy an admin reads must not describe a different boundary from the one the
 * breaker uses.
 */
function describeFailure(err: unknown): { error: string; reason: ImageProbeFailureReason } {
  if (err instanceof LlmHttpError) {
    return {
      error: truncate(err.detail ? `${err.message}: ${err.detail}` : err.message),
      reason: VL_SHAPE_REFUSAL_STATUSES.has(err.status) ? 'shape_rejected' : 'provider_error',
    };
  }
  return {
    error: truncate(err instanceof Error ? err.message : String(err)),
    reason: 'unreachable',
  };
}

/**
 * Probe `model` on `cfg`. Never throws — a probe failure is a verdict, and the
 * caller (the assignment route) turns it into a 422 naming the category.
 */
export async function probeImageEmbedding(
  cfg: ProviderConfig,
  model: string,
  targetDimensions: number | null = null,
  /**
   * The per-call budget. Injectable ONLY so the deadline itself is testable —
   * production has one caller-facing value and it is the default. Without it
   * the wiring below was unpinned: the client's own deadline test proves the
   * option works, and deleting this key here would silently hand an admin's
   * blocking PUT back to the queue's 300s timeout, twice over.
   */
  timeoutMs: number = IMAGE_PROBE_TIMEOUT_MS,
): Promise<ImageEmbeddingProbeResult> {
  // The truncation width is sent on BOTH calls, and the probe then insists the
  // answers come back at it. That is the point of plumbing it here rather than
  // only documenting it: the column is typed to what this probe measured, and
  // P2's embedder and P3's query embed send the same
  // `getImageEmbeddingTargetDimensions()` value — so a server that quietly
  // ignores the parameter must be caught HERE, not discovered later as an
  // insert against a column of the wrong width.
  const opts = {
    ...(targetDimensions !== null ? { dimensions: targetDimensions } : {}),
    timeoutMs,
  };
  let imageWidth: number;
  let textWidth: number;
  try {
    const [imageVector] = await embedImagesVl(cfg, model, [
      { bytes: Buffer.from(PROBE_IMAGE_BASE64, 'base64'), format: 'png' },
    ], opts);
    const [textVector] = await embedTextsVl(cfg, model, [PROBE_TEXT], VL_QUERY_INSTRUCTION, opts);
    imageWidth = imageVector?.length ?? 0;
    textWidth = textVector?.length ?? 0;
  } catch (err) {
    const failure = describeFailure(err);
    logger.warn(
      { providerId: cfg.providerId, model, reason: failure.reason, message: failure.error.slice(0, 200) },
      'Image-embedding probe failed',
    );
    return { dimensions: null, tier: null, ...failure };
  }

  if (imageWidth !== textWidth) {
    return {
      dimensions: null,
      tier: null,
      reason: 'width_mismatch',
      error:
        `The endpoint returned ${imageWidth} dimensions for an image and ${textWidth} for a text. ` +
        'Both must come from the same formatting, or image and text vectors are not comparable.',
    };
  }
  if (!Number.isInteger(imageWidth) || imageWidth < 1 || imageWidth > VECTOR_MAX_DIMS) {
    return {
      dimensions: null,
      tier: null,
      reason: 'unusable_width',
      error: `The endpoint returned ${imageWidth} dimensions; pgvector holds 1..${VECTOR_MAX_DIMS}.`,
    };
  }
  // Asked for a truncation width and got something else: the server is
  // ignoring `dimensions`. Refuse rather than record the width it happened to
  // answer with — every later writer will keep asking for the configured one.
  if (targetDimensions !== null && imageWidth !== targetDimensions) {
    return {
      dimensions: null,
      tier: null,
      reason: 'dimensions_ignored',
      error:
        `The endpoint was asked for ${targetDimensions} dimensions and returned ${imageWidth}. ` +
        'It is not applying the `dimensions` (MRL) parameter.',
    };
  }

  const { tier } = columnTypeFor(imageWidth);
  return { dimensions: imageWidth, tier, error: null, reason: null };
}

/**
 * Persist the last probe beside the pair it describes.
 *
 * One row, overwritten — this is "what does the currently assigned leg look
 * like", not a history. `admin_settings` rather than a new table for the same
 * reason `embedding_dimensions` and the shadow-migration state live there: it
 * is the single seam for runtime-DDL bookkeeping.
 *
 * **Never call this from a non-admin route.** `error` is the provider's own
 * body.
 */
export async function persistImageEmbeddingProbe(
  providerId: string,
  model: string,
  result: ImageEmbeddingProbeResult,
): Promise<void> {
  const payload: StoredImageEmbeddingProbe = {
    providerId,
    model,
    dimensions: result.dimensions,
    tier: result.tier,
    probedAt: new Date().toISOString(),
    error: result.error,
  };
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
    [IMAGE_EMBEDDING_PROBE_KEY, JSON.stringify(payload)],
  );
}

/** The last probe, or null when there has never been one. */
export async function readImageEmbeddingProbe(): Promise<StoredImageEmbeddingProbe | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [IMAGE_EMBEDDING_PROBE_KEY],
  );
  const raw = r.rows[0]?.setting_value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredImageEmbeddingProbe;
  } catch {
    // Absent, not a 500: this is read on every paint of the settings panel.
    logger.error({ raw }, 'Unparseable image-embedding probe record — treating as absent');
    return null;
  }
}
