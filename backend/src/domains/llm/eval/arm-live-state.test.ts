import { describe, expect, it } from 'vitest';
import { liveArmReportProblems, type LiveArmState } from './arm-live-state.js';
import { armReport } from './arm-report-fixtures.js';
import type { ArmRunReport, EvalArm } from './arms.js';

/**
 * #1823 — `--report` bound to the live index configuration, field by field.
 * The live state is built from the same fixture report, so every case below
 * differs from an identical pair in exactly the one field it names.
 */

function liveOf(report: ArmRunReport, over: Partial<LiveArmState> = {}): LiveArmState {
  return {
    arm: report.arm,
    visionModel: report.visionModel,
    imageAnalysisMaxOutputTokens: report.imageAnalysisMaxOutputTokens,
    imageAnalysisVersions: report.imageAnalysisVersions,
    embedder: { model: report.embedder.model, endpoint: report.embedder.endpoint, dims: report.embedder.dims },
    ftsLanguage: report.ftsLanguage,
    ...over,
  };
}

describe('liveArmReportProblems (#1823)', () => {
  it.each(['B', 'C'] as const)('accepts an arm %s report that describes the live state', (arm: EvalArm) => {
    const report = armReport(arm);
    expect(liveArmReportProblems(report, liveOf(report))).toEqual([]);
  });

  it('treats a trailing slash on the embedder endpoint as the same endpoint', () => {
    const report = armReport('B');
    expect(liveArmReportProblems(report, liveOf(report, { embedder: { ...liveOf(report).embedder, endpoint: 'http://embed/v1/' } }))).toEqual([]);
  });

  const b = armReport('B');
  const liveB = liveOf(b);
  it.each([
    ['arm', liveOf(b, { arm: 'C' })],
    ['visionModel', liveOf(b, { visionModel: { identity: 'rtx:other-vl@http://vision/v1', model: 'other-vl', endpoint: 'http://vision/v1' } })],
    ['visionModel', liveOf(b, { visionModel: null })],
    ['imageAnalysisMaxOutputTokens', liveOf(b, { imageAnalysisMaxOutputTokens: 4096 })],
    ['imageAnalysisVersions', liveOf(b, { imageAnalysisVersions: { prompt: 2, schema: 1 } })],
    ['imageAnalysisVersions', liveOf(b, { imageAnalysisVersions: { prompt: 1, schema: 2 } })],
    ['imageAnalysisVersions', liveOf(b, { imageAnalysisVersions: null })],
    ['embedder.model', liveOf(b, { embedder: { ...liveB.embedder, model: 'bge-m3' } })],
    ['embedder.endpoint', liveOf(b, { embedder: { ...liveB.embedder, endpoint: 'http://other-embed/v1' } })],
    ['embedder.dims', liveOf(b, { embedder: { ...liveB.embedder, dims: 1024 } })],
    ['embedder.dims', liveOf(b, { embedder: { ...liveB.embedder, dims: null } })],
    ['ftsLanguage', liveOf(b, { ftsLanguage: 'simple' })],
  ] as const)('names %s when the live state contradicts the report', (field, live) => {
    const problems = liveArmReportProblems(b, live);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${field.replace('.', '\\.')}: report `));
  });

  it('refuses a C report on a database that carries B\'s vision model, ceiling and version pair', () => {
    const c = armReport('C');
    const problems = liveArmReportProblems(c, liveOf(b));
    expect(problems.map((p) => p.split(':')[0])).toEqual(['arm', 'visionModel', 'imageAnalysisMaxOutputTokens', 'imageAnalysisVersions']);
  });
});
