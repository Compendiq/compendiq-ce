import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { invalidateRagAnswerMaxImagesCache } from '../../../core/services/admin-settings-service.js';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../../test-db-helper.js';
import type { AnswerRunProvenance } from './answers.js';
import { armReport } from './arm-report-fixtures.js';
import { establishTextOnlyAnswerCap, readHeldFixedProvenance, type ArmRunReport, type EvalArm, type HeldFixedProvenance } from './arms.js';
import { assertDisposableDatabase } from './disposable-db.js';
import { assertAnswerRunMatches, type SheetProvenance } from './judgments.js';

/**
 * #1822 — the arm retrieval report and the answer run must record the SAME
 * `rag_answer_max_images`, from a fresh database, in the documented order
 * (C retrieval → C answers → B retrieval → B answers).
 *
 * The bug: `run-retrieval-eval.ts` captured the held-fixed provenance without
 * ever writing the protocol's zero cap, so a fresh database's report recorded
 * the reader default 2 while `run-arm-answers.ts` (the only writer) recorded
 * 0 — and `--unblind` refused the pair. Each step below is what the script
 * does since the fix: establish the cap, then read the provenance.
 */

const dbAvailable = await isDbAvailable();

const ANSWER_MODEL = { identity: 'rtx:gemma@http://chat/v1', model: 'gemma', endpoint: 'http://chat/v1' };

/** What `run-retrieval-eval.ts --arm <arm>` publishes from what it read. */
function reportFrom(arm: EvalArm, held: HeldFixedProvenance): ArmRunReport {
  return armReport(arm, { retrieval: { ...held.retrieval, topK: 10 } });
}

/** What `run-arm-answers.ts --arm <arm>` writes beside its answers, and the sheet's record of it. */
function answerRunFrom(arm: EvalArm, held: HeldFixedProvenance): {
  provenance: AnswerRunProvenance;
  source: SheetProvenance['sources'][number];
} {
  const provenance: AnswerRunProvenance = {
    runId: `run-${arm}`, arm, revisionSha: 'e398de4a1234', command: `scripts/run-arm-answers.ts --arm ${arm} --run-id run-${arm}`,
    capturedAt: '2026-09-15T11:00:00.000Z', hardware: 'test host', corpusManifestSha: 'corpus-sha', querySetSha: 'a'.repeat(64),
    answerModel: ANSWER_MODEL, temperature: 'provider default', ragAnswerMaxImages: 0, deepSearch: false,
    retrieval: held.retrieval,
    answersSha256: '1'.repeat(64), mappingSha256: '2'.repeat(64),
    items: 1, refused: 0, refusalReasons: {},
  };
  const source = {
    provenanceSha256: '3'.repeat(64), items: provenance.items,
    runId: provenance.runId, arm, answersSha256: provenance.answersSha256, mappingSha256: provenance.mappingSha256,
  };
  return { provenance, source };
}

/** One script step: the protocol's cap, then the held-fixed read the step records. */
async function scriptStep(): Promise<HeldFixedProvenance> {
  await establishTextOnlyAnswerCap();
  return readHeldFixedProvenance();
}

describe.skipIf(!dbAvailable)('protocol answer-image cap before arm provenance (#1822)', () => {
  beforeAll(async () => {
    await setupTestDb();
    assertDisposableDatabase(process.env.POSTGRES_URL!);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  // A freshly migrated database: no `rag_answer_max_images` row, nothing cached.
  beforeEach(async () => {
    await query(`DELETE FROM admin_settings WHERE setting_key = 'rag_answer_max_images'`);
    invalidateRagAnswerMaxImagesCache();
  });

  it('reads the unset default 2, then 0 once the retrieval-side preparation ran', async () => {
    expect((await readHeldFixedProvenance()).retrieval.rag_answer_max_images).toBe(2);
    await establishTextOnlyAnswerCap();
    expect((await readHeldFixedProvenance()).retrieval.rag_answer_max_images).toBe(0);
  });

  it('C-retrieval → C-answers → B-retrieval → B-answers from a fresh DB yields matching held-fixed metadata', async () => {
    const cReport = reportFrom('C', await scriptStep());
    const cAnswers = answerRunFrom('C', await scriptStep());
    const bReport = reportFrom('B', await scriptStep());
    const bAnswers = answerRunFrom('B', await scriptStep());

    expect(cReport.retrieval.rag_answer_max_images).toBe(0);
    expect(bReport.retrieval).toEqual(cReport.retrieval);
    expect(() => assertAnswerRunMatches(cAnswers.provenance, cAnswers.source, cReport)).not.toThrow();
    expect(() => assertAnswerRunMatches(bAnswers.provenance, bAnswers.source, bReport)).not.toThrow();
  });

  it('still rejects a report captured before the cap (2) against answers made under 0', async () => {
    const staleReport = reportFrom('C', await readHeldFixedProvenance());
    expect(staleReport.retrieval.rag_answer_max_images).toBe(2);
    const cAnswers = answerRunFrom('C', await scriptStep());
    expect(() => assertAnswerRunMatches(cAnswers.provenance, cAnswers.source, staleReport))
      .toThrow(/retrieval\.rag_answer_max_images: 0 vs the retrieval report's 2/);
  });
});
