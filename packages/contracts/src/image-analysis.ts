import { z } from 'zod';

/**
 * ADR-027 D8 — the image-analysis contract: schema v1 of what a vision model
 * returns for one page image, with bounds sized to the output-token ceiling.
 *
 * Owned by #1615. The backend validates a provider's reply against
 * `imageAnalysisPayloadSchema(T)` before a row is written; the schema test
 * computes the maximal conforming payload of every kind from the same
 * definition and pins the ADR's figures. Nothing here is a wire boundary
 * between the browser and the server — it is the contract between the
 * ingestion worker (#1616), the client (#1615) and the readers (#1617) — but
 * it lives in `@compendiq/contracts` so one Zod definition serves all three.
 */

/**
 * Schema version stamped on every `page_image_analyses` row and compared at
 * read time (D5). Bumping it invalidates every analyzed row at the next
 * sweep: change it only when the SHAPE below changes. It is not part of the
 * retained identity and never enters the identity hash.
 */
export const IMAGE_ANALYSIS_SCHEMA_VERSION = 1;

/**
 * The ceiling at which the base bounds below are sized. Part of schema v1's
 * definition: moving it is a `schema_version` bump.
 */
export const IMAGE_ANALYSIS_OUTPUT_TOKENS_REFERENCE = 8192;

/**
 * The largest per-kind sum of everything that does NOT scale with the
 * ceiling — `description` at 1,200, `language` at 16, `kind`,
 * `schemaVersion`, every key, quote, comma and bracket of the encoding
 * (1,546 for the diagram kind, the largest) — plus the 76-character headroom.
 * `IMAGE_ANALYSIS_OUTPUT_TOKENS_REFERENCE − IMAGE_ANALYSIS_FIXED_CHARS` is
 * exactly the diagram kind's scaled string budget at the reference.
 */
export const IMAGE_ANALYSIS_FIXED_CHARS = 1622;

/**
 * The 76-character headroom under the ceiling that the budget invariant
 * guarantees for every kind at every integer ceiling in the allowed range:
 * the largest conforming payload is at most `T − IMAGE_ANALYSIS_HEADROOM_CHARS`.
 */
export const IMAGE_ANALYSIS_HEADROOM_CHARS = 76;

/** `admin_settings.image_analysis_max_output_tokens` — default and range (D8). */
export const IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_DEFAULT = 8192;
export const IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN = 4096;
export const IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MAX = 16384;

/**
 * The bounds table at the reference ceiling. `scaled` bounds are multiplied
 * by the ceiling scale and floored; `fixed` bounds and every count never
 * scale (a smaller ceiling shortens what each row, node or limitation may
 * say, not how many there are, and the description keeps the width D11's
 * rerank window is sized to).
 */
export const IMAGE_ANALYSIS_BOUNDS = {
  fixed: {
    language: 16,
    description: 1200,
  },
  scaled: {
    visibleText: 2500,
    tableCell: 100,
    chartField: 120,
    chartSeries: 60,
    diagramNode: 50,
    diagramEdge: 70,
    limitation: 120,
  },
  counts: {
    tableRows: 30,
    chartSeries: 10,
    diagramNodes: 25,
    diagramEdges: 30,
    limitations: 6,
  },
} as const;

export const IMAGE_ANALYSIS_KINDS = ['screenshot', 'diagram', 'chart', 'table', 'photo', 'other'] as const;
export const ImageAnalysisKindSchema = z.enum(IMAGE_ANALYSIS_KINDS);
export type ImageAnalysisKind = z.infer<typeof ImageAnalysisKindSchema>;

/**
 * `s(T) = min(1, (T − 1622) / (8192 − 1622))` — 1 at the reference ceiling
 * and above, below 1 under a smaller one, never above 1.
 */
export function imageAnalysisCeilingScale(maxOutputTokens: number): number {
  return Math.min(
    1,
    (maxOutputTokens - IMAGE_ANALYSIS_FIXED_CHARS)
      / (IMAGE_ANALYSIS_OUTPUT_TOKENS_REFERENCE - IMAGE_ANALYSIS_FIXED_CHARS),
  );
}

/**
 * Every string bound is on the EMITTED length — the JSON-encoded string
 * without its quotes — so a line break or a quote costs the two characters
 * the model actually writes. A `max` on the raw length would admit a
 * 2,500-character transcription that encodes to 5,000.
 */
export function emittedLength(value: string): number {
  return JSON.stringify(value).length - 2;
}

function boundedString(max: number, label: string) {
  return z.string().refine((v) => emittedLength(v) <= max, {
    message: `${label} exceeds ${max} emitted characters`,
  });
}

/** The scaled bounds in force at a given ceiling. */
export function imageAnalysisBoundsFor(maxOutputTokens: number) {
  const s = imageAnalysisCeilingScale(maxOutputTokens);
  const scale = (base: number) => Math.floor(base * s);
  return {
    language: IMAGE_ANALYSIS_BOUNDS.fixed.language,
    description: IMAGE_ANALYSIS_BOUNDS.fixed.description,
    visibleText: scale(IMAGE_ANALYSIS_BOUNDS.scaled.visibleText),
    tableCell: scale(IMAGE_ANALYSIS_BOUNDS.scaled.tableCell),
    chartField: scale(IMAGE_ANALYSIS_BOUNDS.scaled.chartField),
    chartSeries: scale(IMAGE_ANALYSIS_BOUNDS.scaled.chartSeries),
    diagramNode: scale(IMAGE_ANALYSIS_BOUNDS.scaled.diagramNode),
    diagramEdge: scale(IMAGE_ANALYSIS_BOUNDS.scaled.diagramEdge),
    limitation: scale(IMAGE_ANALYSIS_BOUNDS.scaled.limitation),
  };
}

/** Which `structured` block a kind may carry; `null` for the kinds that carry none. */
export function imageAnalysisBlockFor(kind: ImageAnalysisKind): 'tableRows' | 'chart' | 'diagram' | null {
  switch (kind) {
    case 'table': return 'tableRows';
    case 'chart': return 'chart';
    case 'diagram': return 'diagram';
    default: return null;
  }
}

/**
 * `ImageAnalysisPayloadV1Schema`, built per ceiling. The worker builds it
 * once per batch from the same read that sets `max_tokens`; the assignment
 * routes never need it. Key order below is the encoding order the budget
 * figures are computed from.
 */
export function imageAnalysisPayloadSchema(maxOutputTokens: number) {
  const b = imageAnalysisBoundsFor(maxOutputTokens);
  return z
    .object({
      schemaVersion: z.literal(IMAGE_ANALYSIS_SCHEMA_VERSION),
      kind: ImageAnalysisKindSchema,
      /** BCP-47 tag of the visible text ('de', 'de-CH', 'zh-Hant'), or 'none'. */
      language: boundedString(b.language, 'language'),
      /** Retrieval-oriented, only what is visible — FIXED, never scaled (D11). */
      description: boundedString(b.description, 'description'),
      /** Verbatim transcription in reading order, '' when none. */
      visibleText: boundedString(b.visibleText, 'visibleText'),
      structured: z
        .object({
          /** kind 'table': cells joined by ' | ', header row first. */
          tableRows: z.array(boundedString(b.tableCell, 'tableRows[]')).max(IMAGE_ANALYSIS_BOUNDS.counts.tableRows).optional(),
          /** kind 'chart'. */
          chart: z
            .object({
              xAxis: boundedString(b.chartField, 'chart.xAxis').optional(),
              yAxis: boundedString(b.chartField, 'chart.yAxis').optional(),
              trend: boundedString(b.chartField, 'chart.trend').optional(),
              series: z.array(boundedString(b.chartSeries, 'chart.series[]')).max(IMAGE_ANALYSIS_BOUNDS.counts.chartSeries).optional(),
            })
            .optional(),
          /** kind 'diagram': 'A -> B: label', direction only when drawn. */
          diagram: z
            .object({
              nodes: z.array(boundedString(b.diagramNode, 'diagram.nodes[]')).max(IMAGE_ANALYSIS_BOUNDS.counts.diagramNodes).optional(),
              edges: z.array(boundedString(b.diagramEdge, 'diagram.edges[]')).max(IMAGE_ANALYSIS_BOUNDS.counts.diagramEdges).optional(),
            })
            .optional(),
        })
        .optional(),
      /** Unreadable regions, cut-off text, ambiguity. */
      limitations: z.array(boundedString(b.limitation, 'limitations[]')).max(IMAGE_ANALYSIS_BOUNDS.counts.limitations),
    })
    .superRefine((payload, ctx) => {
      // At most ONE structured block, and only the one matching `kind`. A
      // block the kind does not carry is a contradiction in the analysis
      // itself — a 'photo' with table rows — not a bound to clip.
      if (!payload.structured) return;
      const present = (['tableRows', 'chart', 'diagram'] as const).filter(
        (k) => payload.structured![k] !== undefined,
      );
      const allowed = imageAnalysisBlockFor(payload.kind);
      const offending = present.filter((k) => k !== allowed);
      if (offending.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['structured'],
          message: `structured.${offending[0]} does not match kind '${payload.kind}'`,
        });
      }
    });
}

/** The schema at the reference ceiling; the payload TYPE is the same at every ceiling. */
const referencePayloadSchema = imageAnalysisPayloadSchema(IMAGE_ANALYSIS_OUTPUT_TOKENS_REFERENCE);
export type ImageAnalysisPayloadV1 = z.infer<typeof referencePayloadSchema>;
export type ImageAnalysisPayload = ImageAnalysisPayloadV1;

/**
 * D8's six failure classes. Five are DETERMINISTIC (the same request at
 * `temperature: 0` produces the same outcome, so a retry is the same reply):
 * `malformed`, `empty`, `refused`, `truncated`, `rejected`. `unavailable` is
 * the one transient class — a transport error, timeout, open breaker, 408,
 * 429, any 5xx, and every 4xx outside the `rejected` list.
 */
export const IMAGE_ANALYSIS_FAILURE_CLASSES = [
  'malformed', 'empty', 'refused', 'truncated', 'rejected', 'unavailable',
] as const;
export const ImageAnalysisFailureClassSchema = z.enum(IMAGE_ANALYSIS_FAILURE_CLASSES);
export type ImageAnalysisFailureClass = z.infer<typeof ImageAnalysisFailureClassSchema>;

/** Whether a retry can change the outcome; at the attempt cap a deterministic class goes terminal (D13). */
export const IMAGE_ANALYSIS_CLASS_DETERMINISTIC: Record<ImageAnalysisFailureClass, boolean> = {
  malformed: true,
  empty: true,
  refused: true,
  truncated: true,
  rejected: true,
  unavailable: false,
};

/**
 * D7 — the retained inference identity, `admin_settings.image_analysis_identity`.
 * Written by exactly two routes (the assignment PUT and the capability
 * re-check), each only after a `true` probe; never cleared by an unassign;
 * never written by the worker. No version constants (D5).
 */
export const ImageAnalysisIdentitySchema = z.object({
  providerId: z.string().uuid(),
  model: z.string().min(1),
  baseUrl: z.string().min(1),
  /** `sha256(providerId + '\n' + model + '\n' + baseUrl)`, hex. */
  identityHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** ISO-8601; when this identity was adopted, not when the pair was first assigned. */
  assignedAt: z.string(),
});
export type ImageAnalysisIdentity = z.infer<typeof ImageAnalysisIdentitySchema>;

/**
 * `GET /admin/llm-usecases/image_analysis/reanalysis-scope` — the candidate
 * pair, by the assignment PUT's own resolution rule (assignment model, else
 * the provider's `default_model`).
 */
export const ImageAnalysisReanalysisScopeQuerySchema = z.object({
  providerId: z.string().uuid(),
  model: z.string().min(1).optional(),
});
export type ImageAnalysisReanalysisScopeQuery = z.infer<typeof ImageAnalysisReanalysisScopeQuerySchema>;

/**
 * What the scope preview answers, and what the PUT reports after the fact:
 * `changed` is "differs from the retained identity", `reanalyzeRows` the
 * count of analyzed rows that would fail D5's validity predicate under it.
 * With no identity retained: `changed: true, reanalyzeRows: 0`.
 */
export const ImageAnalysisReanalysisScopeSchema = z.object({
  identityHash: z.string(),
  changed: z.boolean(),
  reanalyzeRows: z.number().int().min(0),
});
export type ImageAnalysisReanalysisScope = z.infer<typeof ImageAnalysisReanalysisScopeSchema>;

/**
 * `GET /admin/pages/:id/image-analyses` (D14) — one row per referenced image,
 * the diagnostic an admin reads when a page's images are not where the card
 * says they should be. `payload` is present only on `?payload=1`; `error` is
 * the D8 class with the number it needs (`rejected:413`, `truncated:8192`),
 * never a provider body. `valid` is D5's validity predicate evaluated against
 * the retained identity and the running constants — the same test
 * composition, coverage and readiness apply.
 */
export const ImageAnalysisRowSchema = z.object({
  id: z.number().int(),
  pageId: z.number().int(),
  source: z.enum(['confluence', 'local']),
  attachmentKey: z.string(),
  contentHash: z.string(),
  format: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  status: z.enum(['pending', 'analyzed', 'failed', 'failed_terminal', 'skipped']),
  skipReason: z.enum(['missing', 'unsupported', 'oversized', 'too_large', 'external', 'capped']).nullable(),
  providerId: z.string().uuid().nullable(),
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  identityHash: z.string().nullable(),
  promptVersion: z.number().int().nullable(),
  schemaVersion: z.number().int().nullable(),
  analysisVersion: z.number().int(),
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  error: z.string().nullable(),
  analyzedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  valid: z.boolean(),
  payload: z.unknown().optional(),
});
export type ImageAnalysisRow = z.infer<typeof ImageAnalysisRowSchema>;

export const ImageAnalysisInspectionSchema = z.object({
  pageId: z.number().int(),
  retainedIdentity: ImageAnalysisIdentitySchema.nullable(),
  promptVersion: z.number().int(),
  schemaVersion: z.number().int(),
  rows: z.array(ImageAnalysisRowSchema),
});
export type ImageAnalysisInspection = z.infer<typeof ImageAnalysisInspectionSchema>;
