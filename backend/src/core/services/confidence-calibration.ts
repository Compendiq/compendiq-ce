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

/**
 * A stored record: the pair, plus when the threshold was written with it.
 *
 * The pair is nullable, and that is a distinct state from "no record at all"
 * (review r1). A rerank threshold saved while the stage is unassigned — the
 * ordinary ADR-021 disabled state — was tuned against nothing, and that is a
 * fact worth keeping: it goes stale the moment a reranker is assigned. Storing
 * it as an absence instead made the panel report a threshold saved seconds ago
 * as predating the feature, and made its remedy a permanent no-op.
 */
export interface CalibrationRecord {
  providerId: string | null;
  model: string | null;
  /** ISO instant. */
  setAt: string;
}

/** A record compared against the live assignment. Matches the contract. */
export interface CalibrationStatus extends CalibrationRecord {
  liveProviderId: string | null;
  liveModel: string | null;
  /** False when the resolver failed, not when nothing is assigned. */
  liveResolved: boolean;
  stale: boolean;
}

/**
 * The live side of the comparison, structurally.
 *
 * `llm-provider-resolver`'s `ConfidenceBasisResolution` is the concrete
 * producer, and `core` may not import a domain (the ESLint boundary), so the
 * shape is spelled here instead of imported.
 */
export interface LiveBasisResolution {
  resolved: boolean;
  pair: CalibrationPair | null;
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
 *  - **`pair === null` is recorded as a record with a NULL PAIR**, never as a
 *    literal `null` and never skipped. The rerank stage is disabled when
 *    unassigned (ADR-021), so "saved while no reranker existed" is an
 *    ordinary state, and it must not be readable as "still the model this was
 *    tuned on" once one is assigned. Review r1: writing it as `null` made it
 *    read back as *no record*, which the panel reports as "set before models
 *    were recorded" — false for a threshold saved seconds ago — and whose
 *    remedy ("save it to record the live model") re-wrote the same absence,
 *    so the note could never clear. A null pair is a claim: tuned against
 *    nothing, and stale the moment something is assigned.
 *
 * Returns false only when the write FAILED — the caller must not report a
 * success it did not get (review r3). It is deliberately not "the row moved":
 * the DELETE branch answers true whether or not a row was there to delete, and
 * the `ON CONFLICT DO UPDATE` always writes. Failing is still non-fatal — the
 * threshold the operator asked for is already saved — but the caller reports
 * the outcome to the panel, whose whole remedy is this write. Swallowing the
 * failure AND answering "recorded" is how a button that cannot work reports
 * that it did.
 */
export async function recordConfidenceCalibration(
  basis: ConfidenceBasis,
  threshold: number,
  pair: CalibrationPair | null,
): Promise<boolean> {
  const key = CALIBRATION_SETTING_KEYS[basis];
  try {
    if (!(threshold > 0)) {
      await query(`DELETE FROM admin_settings WHERE setting_key = $1`, [key]);
      return true;
    }
    const record: CalibrationRecord = {
      providerId: pair?.providerId ?? null,
      model: pair?.model ?? null,
      setAt: new Date().toISOString(),
    };
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [key, JSON.stringify(record)],
    );
    return true;
  } catch (err) {
    // A diagnostic must not fail the save the operator actually asked for.
    // The threshold row is already written by the time we get here; losing
    // the record degrades this feature to "calibration unknown", which is a
    // state the panel renders honestly.
    logger.warn({ err, basis, settingKey: key }, 'Failed to record confidence-threshold calibration');
    return false;
  }
}

/**
 * Reads a stored record, or null when absent, malformed or explicitly null.
 *
 * A row that is the JSON literal `null` still reads as "no record": that is
 * what the pre-review-r1 writer emitted for an unassigned basis, and what a
 * hand-written or restored row may hold. It degrades to the panel's honest
 * unknown state rather than inventing a pair.
 */
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
    // Null is a value here — "recorded while nothing was assigned" — but the
    // two fields move together: half a pair is a corrupt row, not a state.
    const pairIsNull = providerId === null && model === null;
    if (!pairIsNull) {
      if (typeof providerId !== 'string' || providerId === '') return null;
      if (typeof model !== 'string' || model === '') return null;
    }
    return {
      providerId: pairIsNull ? null : (providerId as string),
      model: pairIsNull ? null : (model as string),
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
 * The comparison is a plain equality of two nullable pairs, and both sides
 * being null is a MATCH: a threshold recorded while nothing was assigned, with
 * nothing assigned still, has had nothing move under it. The three interesting
 * cells fall out of that — pair→different pair, pair→nothing (the model is
 * gone) and nothing→pair (a model appeared behind a number tuned without one)
 * are all stale.
 *
 * It is not a "no record" case; that is `record === null`, and the two are
 * rendered differently because absence of evidence is not evidence of a
 * change.
 *
 * The provider is part of the identity, not just the model name: two
 * providers serving `bge-m3` are two deployments of it, and a reranker's
 * normalisation in particular is a property of the server, not the weights.
 *
 * **A resolver failure is carried, not folded in** (review r3). It is stale on
 * its own — whatever stops this resolver naming the model stops
 * `generateEmbedding` using it too, and erring toward "needs attention" is the
 * safe direction — but `liveResolved: false` travels with it so the panel does
 * not state "no model is assigned", a specific claim about
 * `llm_usecase_assignments` that is false when the row is present and merely
 * unreadable (a rotated `PAT_ENCRYPTION_KEY`, an EE policy naming a deleted
 * provider — both persistent, both pointing the operator at the wrong screen).
 *
 * `!liveResolved` is a stale verdict in its OWN right rather than a pair-diff
 * outcome, because the diff cannot express it in one cell: a null-pair record
 * (tuned while the basis was genuinely unassigned) read against a resolver
 * that threw leaves null on both sides, which a diff calls a match. The panel
 * returns early on `stale: false`, so that cell rendered no notice at all —
 * the single output that tells the operator nothing, in the one state where
 * the live side is admittedly unknown.
 */
export function computeCalibrationStatus(
  record: CalibrationRecord | null,
  live: LiveBasisResolution | null,
): CalibrationStatus | null {
  if (!record) return null;
  const liveProviderId = live?.pair?.providerId ?? null;
  const liveModel = live?.pair?.model ?? null;
  // `live === null` means the caller never consulted the resolver, which is an
  // absence of an answer just as much as a throw is.
  const liveResolved = live?.resolved ?? false;
  return {
    ...record,
    liveProviderId,
    liveModel,
    liveResolved,
    // An UNRESOLVED read is stale on its own, not merely by pair-diff. Both
    // sides are null when a null-pair record meets a resolver that cannot
    // answer, so the diff alone called that a match — and the panel returns
    // early on `stale: false`, rendering NEITHER notice while `liveResolved`
    // says the live side is unknown. Silence is the one output that helps
    // nobody here; the "could not be resolved — check the provider row" copy
    // is written for exactly this state. Erring toward "needs attention" is
    // the safe direction, and this is the cell where the pair-diff refused to.
    stale: !liveResolved || liveProviderId !== record.providerId || liveModel !== record.model,
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
