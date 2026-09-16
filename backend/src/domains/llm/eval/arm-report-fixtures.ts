/**
 * #1614 PR2 — synthetic arm reports for the tests that pair them
 * (`arms.test.ts`, `judgments.test.ts`, `script-wiring.test.ts`). Test data
 * only; nothing in the harness imports this.
 */
import type { ArmQueryRun, ArmRunReport, EvalArm } from './arms.js';

export function armRun(over: Partial<ArmQueryRun> & { queryId: string }): ArmQueryRun {
  return {
    retrieved: [1, 2, 3],
    expected: [1],
    style: 'image',
    lang: 'de',
    cluster: 'page-1.md',
    expectedImageKeys: ['img-1.png'],
    evidence: [],
    ms: 10,
    ...over,
  };
}

/** A report carrying exactly the provenance its arm must (`armProvenanceProblems`). */
export function armReport(arm: EvalArm, over: Partial<ArmRunReport> = {}): ArmRunReport {
  const runs = over.runs ?? [armRun({ queryId: 'q1' })];
  return {
    axis: 'arm',
    arm,
    revisionSha: 'e398de4a1234',
    command: `scripts/run-retrieval-eval.ts --images --arm ${arm} --fts-language german --out arm-${arm}.json`,
    capturedAt: '2026-09-15T10:00:00.000Z',
    hardware: 'test host',
    corpusManifestSha: 'corpus-sha',
    querySetSha: 'a'.repeat(64),
    language: 'de',
    ftsLanguage: 'german',
    embedder: { identity: 'eval:qwen3@http://embed/v1', model: 'qwen3', endpoint: 'http://embed/v1', dims: 2560 },
    rerank: 'off',
    answerModel: { identity: 'rtx:gemma@http://chat/v1', model: 'gemma', endpoint: 'http://chat/v1' },
    visionModel: arm === 'A'
      ? { identity: 'eval-image-embedding:vl@http://vl/v1', model: 'vl', endpoint: 'http://vl/v1' }
      : arm === 'B'
        ? { identity: 'rtx:qwen-vl@http://vision/v1', model: 'qwen-vl', endpoint: 'http://vision/v1' }
        : null,
    imageIndexIdentity: arm === 'A' ? 'eval-image-embedding:vl@http://vl/v1#2048' : null,
    imageAnalysisMaxOutputTokens: arm === 'B' ? 8192 : null,
    imageAnalysisVersions: arm === 'B' ? { prompt: 1, schema: 1 } : null,
    retrieval: { rag_ef_search: 100, rag_fetch_width: 10, rag_answer_max_images: 0 },
    queries: runs.length,
    vectorParticipatingQueries: runs.length,
    rerankParticipatingQueries: 0,
    assemblyParticipatingQueries: runs.length,
    pinParticipatingQueries: 0,
    imageEvidenceParticipatingQueries: 0,
    recallAtK: { '@5': 1 },
    mrr: 1,
    imageEvidenceRecallAt5: arm === 'C' ? null : 0,
    imageNegativeLeakAt1: 0,
    queryCostMs: { p50: 10, p95: 12 },
    runs,
    ...over,
  };
}

