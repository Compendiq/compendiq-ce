import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import {
  getRagConfidenceThreshold,
  getRagConfidenceThresholdRerank,
  invalidateRagConfidenceThresholdCache,
} from './admin-settings-service.js';

/**
 * #1114 — a confidence threshold remembers the model it was tuned on.
 *
 * `readConfidenceThreshold` (admin-settings-service) already argues that
 * cosine similarity and rerank relevance are **incommensurable scales**, and
 * that is why #1105 shipped two knobs rather than one. This module is the
 * other half of that argument, one level up: those scales are not properties
 * of the pipeline, they are properties of the MODELS. Swap the embedder and
 * every cosine in the corpus moves; re-point the reranker and the relevance
 * distribution moves with its normalisation. The threshold does not.
 *
 * So an instance that tuned 0.35 against `bge-m3` keeps 0.35 on
 * `Qwen3-Embedding-4B`'s scale after a #1116 shadow swap and silently
 * refuses too much or too little — two unrelated admin actions colliding
 * invisibly, exactly the failure the knob split was introduced to prevent,
 * reached from the other direction.
 *
 * **The ruling is WARN, DON'T MUTATE (2026-08-16).** A model swap must never
 * rewrite refusal policy: an operator who set a gate deliberately would find
 * it moved or cleared by an action about embeddings, and a silently *relaxed*
 * gate is worse than a silently strict one. Nothing here writes a threshold.
 * What it does instead is keep the evidence:
 *
 *  - {@link recordConfidenceCalibration} stores the resolved pair beside a
 *    threshold **whenever that threshold is written**, so the record is
 *    always a statement about the value currently in the row;
 *  - {@link computeCalibrationStatus} compares it with the live assignment on
 *    read, and the Retrieval panel says so until the threshold is saved again;
 *  - {@link warnThresholdOutlivedItsModel} logs the change at the two places
 *    that rewrite the embedding assignment (the shadow swap and its rollback)
 *    and at the plain use-case assignment change, for operators who watch
 *    logs rather than settings pages.
 *
 * Everything here is best-effort and non-fatal. A calibration record is a
 * diagnostic; failing a threshold save — or worse, a shadow swap — because a
 * bookkeeping row could not be written would be the tail wagging the dog.
 */

/** The basis a threshold gates on. Mirrors `computeRetrievalConfidence`. */
export type ConfidenceBasis = 'similarity' | 'rerank';

/** `admin_settings` keys holding the thresholds themselves (#1105). */
export const CONFIDENCE_THRESHOLD_SETTING_KEYS = {
  similarity: 'rag_confidence_threshold',
  rerank: 'rag_confidence_threshold_rerank',
} as const satisfies Record<ConfidenceBasis, string>;

/** `admin_settings` keys holding this module's records (#1114). */
export const CALIBRATION_SETTING_KEYS = {
  similarity: 'rag_confidence_threshold_calibration',
  rerank: 'rag_confidence_threshold_rerank_calibration',
} as const satisfies Record<ConfidenceBasis, string>;

/**
 * Where an operator re-tunes. Spelled once so the log line, the runbook and
 * the panel cannot drift — and checked by `settings-wayfinding.test.ts`,
 * which scans backend source for navigation chains naming a panel or sub-tab
 * that no longer exists.
 */
export const RETUNE_GUIDANCE = 'retune in Settings → AI Models → Retrieval';

/** Provider + model, the only two fields that ever leave this module. */
export interface CalibrationPair {
  providerId: string;
  model: string;
}

/** A stored record: the pair, plus when the threshold was written with it. */
export interface CalibrationRecord extends CalibrationPair {
  /** ISO instant. */
  setAt: string;
}

/** A record compared against the live assignment. Matches the contract. */
export interface CalibrationStatus extends CalibrationRecord {
  liveProviderId: string | null;
  liveModel: string | null;
  stale: boolean;
}

/**
 * Record (or clear) the pair a threshold was written against.
 *
 * Two rules, both load-bearing:
 *
 *  - **`threshold === 0` clears the record.** 0 is the gate OFF, so there is
 *    nothing calibrated; leaving a stale pair behind would make the panel
 *    warn about a gate that is not running, and a later re-enable would
 *    inherit a calibration nobody performed.
 *  - **`pair === null` is written as a literal `null`**, not skipped. The
 *    rerank stage is disabled when unassigned (ADR-021), and "saved while no
 *    reranker existed" must not be readable as "still the model this was
 *    tuned on" once one is assigned. It reads back as no record, which the
 *    panel reports as unknown rather than as a change.
 */
export async function recordConfidenceCalibration(
  basis: ConfidenceBasis,
  threshold: number,
  pair: CalibrationPair | null,
): Promise<void> {
  const key = CALIBRATION_SETTING_KEYS[basis];
  try {
    if (!(threshold > 0)) {
      await query(`DELETE FROM admin_settings WHERE setting_key = $1`, [key]);
      return;
    }
    const record: CalibrationRecord | null = pair
      ? { providerId: pair.providerId, model: pair.model, setAt: new Date().toISOString() }
      : null;
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [key, JSON.stringify(record)],
    );
  } catch (err) {
    // A diagnostic must not fail the save the operator actually asked for.
    // The threshold row is already written by the time we get here; losing
    // the record degrades this feature to "calibration unknown", which is a
    // state the panel renders honestly.
    logger.warn({ err, basis, settingKey: key }, 'Failed to record confidence-threshold calibration');
  }
}

/** Reads a stored record, or null when absent, malformed or explicitly null. */
export async function readConfidenceCalibration(
  basis: ConfidenceBasis,
): Promise<CalibrationRecord | null> {
  const key = CALIBRATION_SETTING_KEYS[basis];
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
      [key],
    );
    const raw = r.rows[0]?.setting_value;
    if (raw === undefined || raw.trim() === '') return null;
    // `admin_settings` is reachable from psql and from a restored dump, so
    // this JSON is not guaranteed to be ours. A malformed row degrades to
    // "no record" — the panel's honest unknown state — rather than 500ing
    // the whole settings page over a diagnostic field.
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const { providerId, model, setAt } = parsed as Record<string, unknown>;
    if (typeof providerId !== 'string' || providerId === '') return null;
    if (typeof model !== 'string' || model === '') return null;
    return {
      providerId,
      model,
      // A record written before this field existed, or by hand, still names a
      // pair — which is the part the staleness verdict rests on. Fall back to
      // the epoch so the contract's `datetime()` shape always holds.
      setAt: typeof setAt === 'string' && !Number.isNaN(Date.parse(setAt))
        ? setAt
        : new Date(0).toISOString(),
    };
  } catch (err) {
    logger.warn({ err, basis, settingKey: key }, 'Failed to read confidence-threshold calibration');
    return null;
  }
}

/**
 * Compare a record against the live assignment.
 *
 * `live === null` — nothing assigned for this basis — is **stale when a pair
 * was recorded**: the threshold was tuned against a model that is no longer
 * behind it. It is not a "no record" case; that is `record === null`, and the
 * two are rendered differently because absence of evidence is not evidence of
 * a change.
 *
 * The provider is part of the identity, not just the model name: two
 * providers serving `bge-m3` are two deployments of it, and a reranker's
 * normalisation in particular is a property of the server, not the weights.
 */
export function computeCalibrationStatus(
  record: CalibrationRecord | null,
  live: CalibrationPair | null,
): CalibrationStatus | null {
  if (!record) return null;
  return {
    ...record,
    liveProviderId: live?.providerId ?? null,
    liveModel: live?.model ?? null,
    stale: !live || live.providerId !== record.providerId || live.model !== record.model,
  };
}

/**
 * Log — never mutate — that the model behind a live threshold just changed.
 *
 * Called from the shadow swap, the post-swap rollback and the plain use-case
 * assignment change. Silent when the threshold is 0, which is the default on
 * every instance: a warning that fires for every operator who never opened
 * the Retrieval panel is a warning everyone learns to skip.
 *
 * The TTL cache is dropped first. It exists so the retrieval hot path pays no
 * per-request round-trip; here it would let a value up to a minute old decide
 * whether an operator hears about a swap at all. One extra SELECT at a
 * lifecycle step nobody runs twice a day is the right trade.
 */
export async function warnThresholdOutlivedItsModel(opts: {
  basis: ConfidenceBasis;
  previousModel: string | null;
  newModel: string | null;
}): Promise<void> {
  const { basis, previousModel, newModel } = opts;
  try {
    invalidateRagConfidenceThresholdCache();
    const threshold =
      basis === 'similarity' ? await getRagConfidenceThreshold() : await getRagConfidenceThresholdRerank();
    if (!(threshold > 0)) return;
    logger.warn(
      {
        previousModel,
        newModel,
        threshold,
        settingKey: CONFIDENCE_THRESHOLD_SETTING_KEYS[basis],
        guidance: RETUNE_GUIDANCE,
      },
      basis === 'similarity'
        ? 'Embedding model changed while the similarity confidence gate is on — the cosine scale moved under a threshold that did not'
        : 'Rerank model changed while the rerank confidence gate is on — the relevance scale moved under a threshold that did not',
    );
  } catch (err) {
    // Read-only and advisory. A shadow swap that has already renamed columns
    // must not fail because a log line could not be composed.
    logger.warn({ err, basis }, 'Could not check the confidence threshold after a model change');
  }
}
