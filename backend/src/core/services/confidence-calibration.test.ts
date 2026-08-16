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

  it('records a literal null when the basis has no model assigned', async () => {
    // ADR-021: an unassigned rerank means the stage is disabled. Writing the
    // pair as absent is what stops a later assignment from being read as
    // "still the model this was tuned on".
    await recordConfidenceCalibration('rerank', 0.2, null);
    expect(rows[CALIBRATION_SETTING_KEYS.rerank]).toBe('null');
    expect(await readConfidenceCalibration('rerank')).toBeNull();
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
  });

  it('answers null for an absent row', async () => {
    expect(await readConfidenceCalibration('rerank')).toBeNull();
  });
});

describe('computeCalibrationStatus (#1114)', () => {
  const record = { ...PAIR, setAt: '2026-08-16T10:00:00.000Z' };

  it('is null when nothing was recorded', () => {
    expect(computeCalibrationStatus(null, PAIR)).toBeNull();
  });

  it('is not stale while the live pair still matches', () => {
    expect(computeCalibrationStatus(record, PAIR)).toEqual({
      ...record,
      liveProviderId: PAIR.providerId,
      liveModel: 'bge-m3',
      stale: false,
    });
  });

  it('is stale when the model changed under it', () => {
    const status = computeCalibrationStatus(record, { ...PAIR, model: 'Qwen3-Embedding-4B' });
    expect(status?.stale).toBe(true);
    expect(status?.liveModel).toBe('Qwen3-Embedding-4B');
  });

  it('is stale when the same model name is served by a different provider', () => {
    // Two providers serving "bge-m3" are two deployments of it, and a
    // reranker's normalisation in particular is a property of the server.
    const status = computeCalibrationStatus(record, {
      providerId: '99999999-9999-4999-8999-999999999999',
      model: 'bge-m3',
    });
    expect(status?.stale).toBe(true);
  });

  it('is stale when the basis has become unassigned', () => {
    const status = computeCalibrationStatus(record, null);
    expect(status).toEqual({ ...record, liveProviderId: null, liveModel: null, stale: true });
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
