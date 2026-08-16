import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * #1114 — the confidence thresholds' calibration record.
 *
 * `readConfidenceThreshold`'s own module doc already argues that similarity
 * and rerank relevance are INCOMMENSURABLE scales. This file is the other
 * half of that argument: the scales are set by the MODELS, so swapping an
 * embedding model or re-pointing the reranker moves the scale under a
 * threshold nobody edited. 0.35 tuned on bge-m3 refuses a different set of
 * questions on Qwen3-Embedding-4B.
 *
 * The owner ruling is **warn, don't mutate**: nothing here ever rewrites a
 * threshold. It records what the threshold was tuned against, reports
 * whether that still matches, and logs a warning at the two moments the
 * model changes.
 */

const mockQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../utils/logger.js';
import { invalidateRagConfidenceThresholdCache } from './admin-settings-service.js';
import {
  CALIBRATION_SETTING_KEYS,
  CONFIDENCE_THRESHOLD_SETTING_KEYS,
  RETUNE_GUIDANCE,
  computeCalibrationStatus,
  readConfidenceCalibration,
  recordConfidenceCalibration,
  warnThresholdOutlivedItsModel,
} from './confidence-calibration.js';

/** The fake `admin_settings` table both the reader and the writer see. */
let rows: Record<string, string>;

beforeEach(() => {
  rows = {};
  vi.mocked(logger.warn).mockClear();
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/^\s*INSERT INTO admin_settings/i.test(sql)) {
      const [key, value] = params as [string, string];
      rows[key] = value;
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*DELETE FROM admin_settings/i.test(sql)) {
      const [key] = params as [string];
      const existed = key in rows;
      delete rows[key];
      return { rows: [], rowCount: existed ? 1 : 0 };
    }
    if (/SELECT setting_value FROM admin_settings/i.test(sql)) {
      const key = (params as string[])[0]!;
      const value = rows[key];
      return { rows: value === undefined ? [] : [{ setting_value: value }], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  invalidateRagConfidenceThresholdCache();
});

const PAIR = { providerId: '11111111-2222-3333-4444-555555555555', model: 'bge-m3' };

describe('recordConfidenceCalibration (#1114)', () => {
  it('records the pair a non-zero threshold was written against', async () => {
    await recordConfidenceCalibration('similarity', 0.35, PAIR);
    const stored = JSON.parse(rows[CALIBRATION_SETTING_KEYS.similarity]!);
    expect(stored.providerId).toBe(PAIR.providerId);
    expect(stored.model).toBe('bge-m3');
    expect(Date.parse(stored.setAt)).not.toBeNaN();
  });

  it('CLEARS the record when the threshold is set to 0 — there is nothing to calibrate', async () => {
    await recordConfidenceCalibration('similarity', 0.35, PAIR);
    expect(rows[CALIBRATION_SETTING_KEYS.similarity]).toBeDefined();

    await recordConfidenceCalibration('similarity', 0, PAIR);
    expect(rows[CALIBRATION_SETTING_KEYS.similarity]).toBeUndefined();
  });

  it('records a NULL PAIR — not a null record — when the basis has no model assigned', async () => {
    // ADR-021: an unassigned rerank means the stage is disabled, so saving a
    // rerank threshold there is ordinary, not exceptional. Review r1: this
    // used to write the JSON literal `null`, which read back as "never
    // recorded" — the panel then told the operator the number predated the
    // feature and offered a remedy that rewrote the same absence forever.
    // The record is present and says what it knows: tuned against nothing.
    await recordConfidenceCalibration('rerank', 0.2, null);
    const stored = JSON.parse(rows[CALIBRATION_SETTING_KEYS.rerank]!) as Record<string, unknown>;
    expect(stored).toMatchObject({ providerId: null, model: null });
    expect(Date.parse(String(stored.setAt))).not.toBeNaN();

    const read = await readConfidenceCalibration('rerank');
    expect(read).toMatchObject({ providerId: null, model: null });
  });

  it('REPORTS whether the row moved, so the caller does not claim a write it did not get', async () => {
    // Review r3. The failure stays non-fatal — the threshold the operator
    // asked for is already saved — but the panel's whole remedy for a stale
    // calibration is this one write, and the route answers 200 either way. A
    // swallowed failure plus a "recorded" toast is a button that reports
    // success and changes nothing.
    expect(await recordConfidenceCalibration('similarity', 0.35, PAIR)).toBe(true);
    expect(await recordConfidenceCalibration('similarity', 0, PAIR)).toBe(true);

    mockQuery.mockRejectedValueOnce(new Error('deadlock detected'));
    expect(await recordConfidenceCalibration('similarity', 0.35, PAIR)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('keeps the two bases in separate rows', async () => {
    await recordConfidenceCalibration('similarity', 0.35, PAIR);
    expect(rows[CALIBRATION_SETTING_KEYS.rerank]).toBeUndefined();
    expect(CALIBRATION_SETTING_KEYS.similarity).toBe('rag_confidence_threshold_calibration');
    expect(CALIBRATION_SETTING_KEYS.rerank).toBe('rag_confidence_threshold_rerank_calibration');
  });
});

describe('readConfidenceCalibration (#1114)', () => {
  it('round-trips a written record', async () => {
    await recordConfidenceCalibration('similarity', 0.35, PAIR);
    const read = await readConfidenceCalibration('similarity');
    expect(read).toMatchObject(PAIR);
  });

  it('treats a hand-written malformed row as no record rather than throwing', async () => {
    // `admin_settings` is reachable from psql and from a restored dump. A
    // GET that 500s because someone typed into this row would take the whole
    // settings page down over a diagnostic field.
    rows[CALIBRATION_SETTING_KEYS.similarity] = '{not json';
    expect(await readConfidenceCalibration('similarity')).toBeNull();

    rows[CALIBRATION_SETTING_KEYS.similarity] = '{"providerId":"","model":""}';
    expect(await readConfidenceCalibration('similarity')).toBeNull();

    // Half a pair is corruption, not the "recorded against nothing" state —
    // the two fields are written together and must read together.
    rows[CALIBRATION_SETTING_KEYS.similarity] = '{"providerId":null,"model":"bge-m3"}';
    expect(await readConfidenceCalibration('similarity')).toBeNull();
  });

  it('answers null for an absent row', async () => {
    expect(await readConfidenceCalibration('rerank')).toBeNull();
  });

  it('still reads a legacy literal-null row as NO record', async () => {
    // What the pre-review-r1 writer emitted, and what a restored dump or a
    // hand-edited row may still hold. It degrades to the panel's honest
    // unknown state rather than inventing a pair.
    rows[CALIBRATION_SETTING_KEYS.rerank] = 'null';
    expect(await readConfidenceCalibration('rerank')).toBeNull();
  });
});

describe('computeCalibrationStatus (#1114)', () => {
  const record = { ...PAIR, setAt: '2026-08-16T10:00:00.000Z' };
  /** What the resolver answers when it succeeded. */
  const live = (pair: { providerId: string; model: string } | null) => ({ resolved: true, pair });

  it('is null when nothing was recorded', () => {
    expect(computeCalibrationStatus(null, live(PAIR))).toBeNull();
  });

  it('is not stale while the live pair still matches', () => {
    expect(computeCalibrationStatus(record, live(PAIR))).toEqual({
      ...record,
      liveProviderId: PAIR.providerId,
      liveModel: 'bge-m3',
      liveResolved: true,
      stale: false,
    });
  });

  it('is stale when the model changed under it', () => {
    const status = computeCalibrationStatus(record, live({ ...PAIR, model: 'Qwen3-Embedding-4B' }));
    expect(status?.stale).toBe(true);
    expect(status?.liveModel).toBe('Qwen3-Embedding-4B');
  });

  it('is stale when the same model name is served by a different provider', () => {
    // Two providers serving "bge-m3" are two deployments of it, and a
    // reranker's normalisation in particular is a property of the server.
    const status = computeCalibrationStatus(
      record,
      live({ providerId: '99999999-9999-4999-8999-999999999999', model: 'bge-m3' }),
    );
    expect(status?.stale).toBe(true);
  });

  it('is stale when the basis has become unassigned', () => {
    const status = computeCalibrationStatus(record, live(null));
    expect(status).toEqual({
      ...record,
      liveProviderId: null,
      liveModel: null,
      liveResolved: true,
      stale: true,
    });
  });

  it('separates "unassigned" from "the resolver could not answer" (review r3)', () => {
    // Both leave the live pair null, and only the first is a fact about
    // `llm_usecase_assignments`. The panel's copy turns on the difference: an
    // undecryptable provider row and an EE policy naming a deleted provider
    // both throw on every read, so telling the operator "nothing is assigned"
    // sends them to the wrong screen, permanently.
    const unassigned = computeCalibrationStatus(record, live(null));
    const unreadable = computeCalibrationStatus(record, { resolved: false, pair: null });
    expect(unassigned?.liveResolved).toBe(true);
    expect(unreadable?.liveResolved).toBe(false);
    // The VERDICT is deliberately the same: whatever stops the resolver
    // naming the model stops `generateEmbedding` using it, and erring toward
    // "still needs attention" is the safe direction.
    expect(unassigned?.stale).toBe(true);
    expect(unreadable?.stale).toBe(true);
  });

  it('is stale when a model APPEARED behind a threshold tuned without one', () => {
    // The mirror of the case above, and the one the literal-null record could
    // not express: a rerank threshold set while the stage was disabled now
    // gates on jina's relevance scale, which it was never measured against.
    const tunedAgainstNothing = { providerId: null, model: null, setAt: record.setAt };
    const status = computeCalibrationStatus(
      tunedAgainstNothing,
      live({ providerId: '99999999-9999-4999-8999-999999999999', model: 'jina-reranker-v2' }),
    );
    expect(status?.stale).toBe(true);
    expect(status?.model).toBeNull();
    expect(status?.liveModel).toBe('jina-reranker-v2');
  });

  it('is NOT stale when nothing was assigned then and nothing is assigned now', () => {
    // Nothing moved under the number. The rerank pool's own status line
    // already says the stage is disabled; a second notice saying so would be
    // amber for a resting state.
    const status = computeCalibrationStatus(
      { providerId: null, model: null, setAt: record.setAt },
      live(null),
    );
    expect(status?.stale).toBe(false);
  });
});

describe('warnThresholdOutlivedItsModel (#1114)', () => {
  it('logs a structured warning when the threshold is above 0', async () => {
    rows[CONFIDENCE_THRESHOLD_SETTING_KEYS.similarity] = '0.35';

    await warnThresholdOutlivedItsModel({
      basis: 'similarity',
      previousModel: 'bge-m3',
      newModel: 'Qwen3-Embedding-4B',
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      previousModel: 'bge-m3',
      newModel: 'Qwen3-Embedding-4B',
      threshold: 0.35,
      settingKey: 'rag_confidence_threshold',
      guidance: RETUNE_GUIDANCE,
    });
  });

  it('says NOTHING when the gate is off — 0 is the default on every instance', async () => {
    await warnThresholdOutlivedItsModel({
      basis: 'similarity',
      previousModel: 'bge-m3',
      newModel: 'Qwen3-Embedding-4B',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reads the rerank basis from its OWN key', async () => {
    rows[CONFIDENCE_THRESHOLD_SETTING_KEYS.rerank] = '0.2';

    await warnThresholdOutlivedItsModel({ basis: 'rerank', previousModel: null, newModel: 'jina-reranker-v2' });
    const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ threshold: 0.2, settingKey: 'rag_confidence_threshold_rerank' });

    // …and a similarity swap on the same instance stays silent, because THAT
    // knob is still 0. One knob per basis is the whole #1105 argument.
    vi.mocked(logger.warn).mockClear();
    await warnThresholdOutlivedItsModel({ basis: 'similarity', previousModel: 'a', newModel: 'b' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never mutates the threshold — the ruling is warn, do not rewrite policy', async () => {
    rows[CONFIDENCE_THRESHOLD_SETTING_KEYS.similarity] = '0.35';
    await warnThresholdOutlivedItsModel({ basis: 'similarity', previousModel: 'a', newModel: 'b' });
    expect(rows[CONFIDENCE_THRESHOLD_SETTING_KEYS.similarity]).toBe('0.35');
    expect(mockQuery.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/i.test(String(sql)))).toBe(false);
  });

  it('swallows a read failure — a swap must not fail because a log line could not be written', async () => {
    mockQuery.mockRejectedValue(new Error('connection terminated'));
    await expect(
      warnThresholdOutlivedItsModel({ basis: 'similarity', previousModel: 'a', newModel: 'b' }),
    ).resolves.toBeUndefined();
  });

  it('points at the panel that owns the knob', () => {
    expect(RETUNE_GUIDANCE).toContain('Settings → AI Models → Retrieval');
  });
});
