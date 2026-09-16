import { describe, it, expect } from 'vitest';
import {
  IMAGE_ANALYSIS_BOUNDS,
  IMAGE_ANALYSIS_FIXED_CHARS,
  IMAGE_ANALYSIS_HEADROOM_CHARS,
  IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MAX,
  IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN,
  IMAGE_ANALYSIS_OUTPUT_TOKENS_REFERENCE,
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  ImageAnalysisActionResultSchema,
  ImageAnalysisBatchReasonSchema,
  ImageAnalysisLastRunSchema,
  ImageAnalysisStatusSchema,
  ImageAnalysisIdentitySchema,
  ImageAnalysisReanalysisScopeQuerySchema,
  ImageAnalysisReanalysisScopeSchema,
  emittedLength,
  imageAnalysisBoundsFor,
  imageAnalysisCeilingScale,
  imageAnalysisPayloadSchema,
  type ImageAnalysisKind,
  type ImageAnalysisPayloadV1,
} from './image-analysis.js';

/**
 * ADR-027 D8's output budget invariant, pinned as the ADR asks: the maximal
 * conforming payload of every kind, every string at its emitted bound and
 * filled from the one-token-per-character alphabet (digits and separators,
 * which encode to themselves), is at most `T − 76` at the range's floor, at
 * the reference and at its ceiling — and the four per-kind figures are the
 * ADR's exactly. A base bound or a fixed-character constant that moves moves
 * these figures, and the test names them. Deliberately no model tokenizer and
 * neither of the repo's two estimators (both are averages; an average is the
 * wrong side of this inequality).
 */

/** `n` characters from an alphabet that encodes to itself and tokenizes at one per character. */
function fill(n: number): string {
  return '0123456789'.repeat(Math.ceil(n / 10)).slice(0, n);
}

function maximalPayload(kind: ImageAnalysisKind, T: number): ImageAnalysisPayloadV1 {
  const b = imageAnalysisBoundsFor(T);
  const c = IMAGE_ANALYSIS_BOUNDS.counts;
  const payload: ImageAnalysisPayloadV1 = {
    schemaVersion: 1,
    kind,
    language: fill(b.language),
    description: fill(b.description),
    visibleText: fill(b.visibleText),
    limitations: Array.from({ length: c.limitations }, () => fill(b.limitation)),
  };
  if (kind === 'table') {
    payload.structured = { tableRows: Array.from({ length: c.tableRows }, () => fill(b.tableCell)) };
  } else if (kind === 'chart') {
    payload.structured = {
      chart: {
        xAxis: fill(b.chartField),
        yAxis: fill(b.chartField),
        trend: fill(b.chartField),
        series: Array.from({ length: c.chartSeries }, () => fill(b.chartSeries)),
      },
    };
  } else if (kind === 'diagram') {
    payload.structured = {
      diagram: {
        nodes: Array.from({ length: c.diagramNodes }, () => fill(b.diagramNode)),
        edges: Array.from({ length: c.diagramEdges }, () => fill(b.diagramEdge)),
      },
    };
  }
  // Key order is the encoding order the budget figures are computed from:
  // `structured` sits before `limitations`, as the ADR's shape lists it.
  const { limitations, ...rest } = payload;
  return { ...rest, limitations } as ImageAnalysisPayloadV1;
}

const KINDS: ImageAnalysisKind[] = ['table', 'diagram', 'chart', 'screenshot', 'photo', 'other'];

describe('imageAnalysisPayloadSchema — the output budget invariant (ADR-027 D8)', () => {
  it('holds the ADR\'s exact maxima at the reference ceiling 8,192', () => {
    const T = IMAGE_ANALYSIS_OUTPUT_TOKENS_REFERENCE;
    const sizes = Object.fromEntries(KINDS.map((k) => [k, JSON.stringify(maximalPayload(k, T)).length]));
    expect(sizes).toMatchObject({ table: 7_671, diagram: 8_116, chart: 5_611, screenshot: 4_557 });
    // The diagram kind is the largest and lands exactly on the headroom.
    expect(sizes.diagram).toBe(T - IMAGE_ANALYSIS_HEADROOM_CHARS);
    for (const k of KINDS) expect(sizes[k]).toBeLessThanOrEqual(T - IMAGE_ANALYSIS_HEADROOM_CHARS);
  });

  it('holds the ADR\'s floor figures at 4,096', () => {
    const T = IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN;
    const sizes = Object.fromEntries(KINDS.map((k) => [k, JSON.stringify(maximalPayload(k, T)).length]));
    expect(sizes).toMatchObject({ table: 3_772, diagram: 3_987, chart: 2_997, screenshot: 2_548 });
    for (const k of KINDS) expect(sizes[k]).toBeLessThanOrEqual(T - IMAGE_ANALYSIS_HEADROOM_CHARS);
    // The floor keeps at least a third of every transcription bound.
    const b = imageAnalysisBoundsFor(T);
    expect(b.visibleText).toBe(941);
    expect(b.tableCell).toBe(37);
    expect(b.chartField).toBe(45);
    expect(b.chartSeries).toBe(22);
    expect(b.diagramNode).toBe(18);
    expect(b.diagramEdge).toBe(26);
    expect(b.limitation).toBe(45);
  });

  it('grows nothing above the reference: the maxima at 16,384 are the reference ones', () => {
    const T = IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MAX;
    const sizes = Object.fromEntries(KINDS.map((k) => [k, JSON.stringify(maximalPayload(k, T)).length]));
    expect(sizes).toMatchObject({ table: 7_671, diagram: 8_116, chart: 5_611, screenshot: 4_557 });
    expect(T - sizes.diagram!).toBe(8_268);
    expect(imageAnalysisCeilingScale(T)).toBe(1);
  });

  it('every maximal payload parses under the schema built for its own ceiling', () => {
    for (const T of [IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN, IMAGE_ANALYSIS_OUTPUT_TOKENS_REFERENCE, IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MAX]) {
      const schema = imageAnalysisPayloadSchema(T);
      for (const k of KINDS) {
        expect(schema.safeParse(maximalPayload(k, T)).success, `${k} @ ${T}`).toBe(true);
      }
    }
  });

  it('the fixed-character constant is the diagram kind\'s non-scaling encoding plus the headroom', () => {
    // At the reference every scaled bound is its base, so the diagram maximum
    // minus its scaled string budget is exactly the fixed part.
    const scaledBudget = IMAGE_ANALYSIS_OUTPUT_TOKENS_REFERENCE - IMAGE_ANALYSIS_FIXED_CHARS;
    expect(scaledBudget).toBe(6_570);
    const b = IMAGE_ANALYSIS_BOUNDS;
    const diagramScaled =
      b.scaled.visibleText
      + b.counts.diagramNodes * b.scaled.diagramNode
      + b.counts.diagramEdges * b.scaled.diagramEdge
      + b.counts.limitations * b.scaled.limitation;
    expect(diagramScaled).toBe(scaledBudget);
  });
});

describe('imageAnalysisPayloadSchema — bounds are on the EMITTED length', () => {
  const schema = imageAnalysisPayloadSchema(IMAGE_ANALYSIS_OUTPUT_TOKENS_REFERENCE);
  const base = (over: Partial<ImageAnalysisPayloadV1>): unknown => ({
    schemaVersion: 1,
    kind: 'screenshot',
    language: 'de',
    description: 'A login dialog with an error banner.',
    visibleText: '',
    limitations: [],
    ...over,
  });

  it('a line break costs two characters, so 1,250 lines exceed a 2,500 bound that 2,500 letters meet', () => {
    expect(emittedLength('a\n')).toBe(3);
    expect(schema.safeParse(base({ visibleText: 'x'.repeat(2_500) })).success).toBe(true);
    // 1,250 × "a\n" is 2,500 raw characters but 3,750 emitted.
    expect(schema.safeParse(base({ visibleText: 'a\n'.repeat(1_250) })).success).toBe(false);
    expect(schema.safeParse(base({ visibleText: 'x'.repeat(2_501) })).success).toBe(false);
  });

  it('the description is fixed at 1,200 at every ceiling; language at 16', () => {
    const floor = imageAnalysisPayloadSchema(IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN);
    expect(floor.safeParse(base({ description: 'd'.repeat(1_200) })).success).toBe(true);
    expect(floor.safeParse(base({ description: 'd'.repeat(1_201) })).success).toBe(false);
    expect(floor.safeParse(base({ language: 'zh-Hant-TW-x-abc' })).success).toBe(true);
    expect(floor.safeParse(base({ language: 'l'.repeat(17) })).success).toBe(false);
  });

  it('counts never scale: 30 rows fit at the floor, 31 do not at the ceiling', () => {
    const floor = imageAnalysisPayloadSchema(IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN);
    const top = imageAnalysisPayloadSchema(IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MAX);
    const rows = (n: number) => base({ kind: 'table', structured: { tableRows: Array.from({ length: n }, () => 'a | b') } });
    expect(floor.safeParse(rows(30)).success).toBe(true);
    expect(top.safeParse(rows(31)).success).toBe(false);
    expect(top.safeParse(base({ limitations: Array.from({ length: 7 }, () => 'cut off') })).success).toBe(false);
  });

  it('a structured block must match the kind, and only that one block may be present', () => {
    expect(schema.safeParse(base({ kind: 'table', structured: { tableRows: ['h1 | h2'] } })).success).toBe(true);
    expect(schema.safeParse(base({ kind: 'photo', structured: { tableRows: ['h1 | h2'] } })).success).toBe(false);
    expect(schema.safeParse(base({ kind: 'chart', structured: { chart: { trend: 'up' }, diagram: { nodes: ['A'] } } })).success).toBe(false);
    expect(schema.safeParse(base({ kind: 'diagram', structured: { diagram: { edges: ['A -> B: uses'] } } })).success).toBe(true);
    // An empty block object is not a contradiction.
    expect(schema.safeParse(base({ kind: 'photo', structured: {} })).success).toBe(true);
  });

  it('pins schemaVersion to the running constant and rejects an unknown kind', () => {
    expect(IMAGE_ANALYSIS_SCHEMA_VERSION).toBe(1);
    expect(schema.safeParse(base({ schemaVersion: 2 } as never)).success).toBe(false);
    expect(schema.safeParse(base({ kind: 'meme' } as never)).success).toBe(false);
  });
});

describe('scope preview and identity contracts', () => {
  it('the scope query takes a uuid and an optional non-empty model', () => {
    expect(ImageAnalysisReanalysisScopeQuerySchema.safeParse({ providerId: '00000000-0000-4000-8000-000000000001' }).success).toBe(true);
    expect(ImageAnalysisReanalysisScopeQuerySchema.safeParse({ providerId: 'not-a-uuid' }).success).toBe(false);
    expect(ImageAnalysisReanalysisScopeQuerySchema.safeParse({ providerId: '00000000-0000-4000-8000-000000000001', model: '' }).success).toBe(false);
  });

  it('the scope answer never carries a negative count', () => {
    expect(ImageAnalysisReanalysisScopeSchema.safeParse({ identityHash: 'abc', changed: true, reanalyzeRows: 0 }).success).toBe(true);
    expect(ImageAnalysisReanalysisScopeSchema.safeParse({ identityHash: 'abc', changed: false, reanalyzeRows: -1 }).success).toBe(false);
  });

  it('the retained identity is the three-tuple, its hash and when it was adopted — no version constants', () => {
    const ok = ImageAnalysisIdentitySchema.safeParse({
      providerId: '00000000-0000-4000-8000-000000000001',
      model: 'qwen3-vl',
      baseUrl: 'http://vision/v1',
      identityHash: 'a'.repeat(64),
      assignedAt: '2026-09-15T00:00:00.000Z',
    });
    expect(ok.success).toBe(true);
    expect(ImageAnalysisIdentitySchema.safeParse({
      providerId: '00000000-0000-4000-8000-000000000001',
      model: 'qwen3-vl',
      baseUrl: 'http://vision/v1',
      identityHash: 'not-hex',
      assignedAt: '2026-09-15T00:00:00.000Z',
    }).success).toBe(false);
  });
});

describe('the operator processing surface (#1618)', () => {
  const rows = { analyzed: 1, stale: 0, pending: 0, failed: 0, terminal: 0, skipped: 0 };
  const skipReasons = { missing: 0, unsupported: 0, oversized: 0, tooLarge: 0, external: 0, capped: 0 };

  it('serves a last run recorded before a counter existed, at zero rather than not at all', () => {
    // The row is JSON written by a previous release. A required counter would
    // drop the whole last run on upgrade — `ImageIndexRunSchema.pagesFailed`'s
    // recorded lesson.
    const parsed = ImageAnalysisLastRunSchema.safeParse({ at: '2026-09-16T08:00:00.000Z', processed: 2 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.unreadableRefs).toBe(0);
    expect(parsed.success && parsed.data.reconciledPages).toBe(0);
    // `reason` stays absent: a run that did not stop must not read as one that did.
    expect(parsed.success && 'reason' in parsed.data).toBe(false);
  });

  it('refuses a stop reason the card has no label for', () => {
    expect(ImageAnalysisBatchReasonSchema.safeParse('identity_drift').success).toBe(true);
    expect(ImageAnalysisBatchReasonSchema.safeParse('quota_exhausted').success).toBe(false);
  });

  it('lets the status withhold an identity verdict, but never the counts', () => {
    const base = {
      assigned: false,
      retainedIdentity: null,
      identityMatchesAssignment: null,
      rows,
      skipReasons,
      dirtyPages: 0,
      pagesAwaitingEmbed: 0,
      running: false,
      lastRun: null,
    };
    expect(ImageAnalysisStatusSchema.safeParse(base).success).toBe(true);
    // Six row buckets and six skip reasons, all required: a missing bucket
    // would render as a claimed zero on the card.
    const { skipped: _skipped, ...incomplete } = rows;
    expect(ImageAnalysisStatusSchema.safeParse({ ...base, rows: incomplete }).success).toBe(false);
    // The reconcile's own key is snake_case (`too_large`); the route camelCases
    // it in one place, and sending the raw key through drops the count.
    const { tooLarge: _tooLarge, ...rawSkips } = skipReasons;
    expect(
      ImageAnalysisStatusSchema.safeParse({ ...base, skipReasons: { ...rawSkips, too_large: 1 } }).success,
    ).toBe(false);
  });

  it('lets an action omit a row count it did not compute', () => {
    expect(ImageAnalysisActionResultSchema.safeParse({ started: true, alreadyRunning: false }).success).toBe(true);
    expect(ImageAnalysisActionResultSchema.safeParse({ rows: 3, started: false, alreadyRunning: true }).success).toBe(true);
    expect(ImageAnalysisActionResultSchema.safeParse({ rows: -1, started: true, alreadyRunning: false }).success).toBe(false);
  });
});
