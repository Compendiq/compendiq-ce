/**
 * #1115 P5b — the image axis's report block, and the verdict table it prints.
 *
 * The shape lives in a schema rather than only in an interface for one reason:
 * a report is the artefact that outlives the run. `--baseline` reads a file
 * somebody wrote weeks ago, and a field that quietly changed name between then
 * and now is a comparison that silently drops a slice. `images-report.test.ts`
 * parses a built report through this schema, so the builder and the contract
 * cannot drift.
 *
 * The block sits BESIDE the existing report rather than replacing it: an
 * image-axis run still records `model`, `language`, `ftsLanguage`,
 * `corpusManifestSha` and the flags, because every one of those still decides
 * what was measured. What it adds is the pair.
 */
import { z } from 'zod';
import type { PairedDelta } from './images-metrics.js';
import {
  armMrr,
  armRuns,
  imageHitAtK,
  imageNegativeLeakAtK,
  pairedDelta,
  pairedQueryCostDeltaMs,
  partitionPairs,
  queryCostMs,
  type ImageQueryPair,
  type QueryCost,
} from './images-metrics.js';
import { recallAtK } from './metrics.js';
import { round } from './latency-stats.js';
import type { ImageEvalResult } from './runner-images.js';

/** Page Recall@K the text gate already reports at, so the two read alike. */
export const IMAGE_AXIS_TOP_K = [1, 3, 5, 10] as const;
/**
 * `imageHit@K` and `imageNegativeLeak@K` cut shallower.
 *
 * The leg carries at most `MAX_IMAGE_HITS_PER_PAGE` (3) hits per page onto a
 * result and `/llm/ask` puts at most `MAX_IMAGE_SOURCES` (4) on the wire, so a
 * hit at rank 10 is one nobody would ever have been shown.
 */
export const IMAGE_HIT_TOP_K = [1, 3, 5] as const;
/**
 * The K the per-slice verdicts are computed at — the same one the text gate
 * decides on. A slice is small (the English slice is 58 labels, the negatives
 * 22), so reporting four Ks per slice would be four chances to find a p below
 * 0.05 in a table nobody corrected for multiplicity.
 */
export const IMAGE_AXIS_DELTA_K = 5;

const PairedDeltaSchema = z.object({
  k: z.number().int().positive(),
  n: z.number().int().nonnegative(),
  off: z.number(),
  on: z.number(),
  observedDelta: z.number(),
  lower: z.number(),
  upper: z.number(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  method: z.enum(['mcnemar-exact', 'bootstrap-percentile']),
  pValue: z.number().nullable(),
  significant: z.boolean(),
  direction: z.enum(['improvement', 'regression', 'none']),
});

const ArmScoresSchema = z.object({
  recallAtK: z.record(z.string(), z.number()),
  mrr: z.number(),
});

const QueryRunSchema = z.object({
  queryId: z.string().min(1),
  retrieved: z.array(z.number().int()),
  expected: z.array(z.number().int()),
});

const PercentilesSchema = z.object({ p50: z.number(), p95: z.number() });

export const ImageAxisReportSchema = z.object({
  /** The VL model the index was built with and the queries embedded through. */
  imageModel: z.string().min(1),
  /** The width the endpoint ANSWERED with — what the column is typed to. */
  imageDims: z.number().int().positive(),
  /** Free-text provenance from the operator (`llama` | `mlx` | `vllm`), if given. */
  imageEndpointBackend: z.string().min(1).optional(),
  /** `provider:model@baseUrl#dims` — the identity a model change invalidates. */
  imageIndexIdentity: z.string().min(1),
  /**
   * Whether an HNSW index exists at this width. False above 4000 dimensions by
   * design, and the query-cost figures below then describe a sequential scan.
   */
  imageIndexed: z.boolean(),
  imagesEmbedded: z.number().int().nonnegative(),
  imagesReused: z.number().int().nonnegative(),
  imageEmbedWallClockMs: z.number().nonnegative(),
  /**
   * RAW intake rate: images per second, sequential, one page at a time and
   * with NO inter-page pause. It describes the endpoint.
   *
   * Deliberately not labelled "what a backfill would see" any more (review r3):
   * `processDirtyPageImages` sleeps `INTER_PAGE_DELAY_MS` after every page, and
   * on a 65-page corpus that is 13 seconds this figure never pays.
   */
  throughputImagesPerSec: z.number().nonnegative(),
  /**
   * …and the same intake WITH that valve — the operational number
   * `docs/runbooks/image-index.md` §5 tells an operator to read before
   * scheduling a backfill. Derived from `interPageDelayMs` below, which is the
   * worker's own exported constant, so the two cannot drift.
   */
  backfillThroughputImagesPerSec: z.number().nonnegative(),
  /** The worker's per-page valve, so the derived rate above is self-describing. */
  interPageDelayMs: z.number().nonnegative(),
  imageLegParticipatingQueries: z.number().int().nonnegative(),
  legOff: ArmScoresSchema,
  legOn: ArmScoresSchema,
  delta: z.object({
    /** The paired verdict at each K, over the whole fixture. */
    recallAtK: z.record(z.string(), PairedDeltaSchema),
    /** …and per `style`: `image` is what the leg is FOR, `image-negative` what it is against. */
    perStyle: z.record(z.string(), PairedDeltaSchema),
    /** …and per label language: `de` is the ordinary case, `en` the cross-lingual one. */
    perLang: z.record(z.string(), PairedDeltaSchema),
  }),
  imageHitAtK: z.record(z.string(), z.number()),
  imageNegativeLeakAtK: z.record(z.string(), z.number()),
  queryCostMs: z.object({
    off: PercentilesSchema,
    on: PercentilesSchema,
    /**
     * Percentiles of `on.ms - off.ms` over the SAME query.
     *
     * The two marginals above are what a request is budgeted against; this is
     * what the leg costs. `p95(on) - p95(off)` is not any query's cost — it is
     * the gap between two possibly different queries — and the runner's whole
     * interleave-and-alternate design exists to make the paired figure
     * meaningful, so throwing the pairing away at exactly this metric was the
     * one place the axis stopped being paired (review r3).
     */
    deltaPaired: PercentilesSchema,
  }),
  /**
   * Both arms' per-query results, so a same-axis `--baseline` can compare
   * leg-off against leg-off AND leg-on against leg-on. Without them a
   * comparison could only see whichever arm the top-level `runs` carries, and
   * a change that moved the text legs would read as a change in the image leg.
   */
  runsOff: z.array(QueryRunSchema),
  runsOn: z.array(QueryRunSchema),
});

export type ImageAxisReport = z.infer<typeof ImageAxisReportSchema>;

export interface BuildImageAxisReportInput {
  imageModel: string;
  imageDims: number;
  backend?: string | undefined;
  identity: string;
  indexed: boolean;
  imagesEmbedded: number;
  imagesReused: number;
  imageEmbedWallClockMs: number;
  throughputImagesPerSec: number;
  backfillThroughputImagesPerSec: number;
  interPageDelayMs: number;
  run: ImageEvalResult;
}

function scoresFor(pairs: readonly ImageQueryPair[], arm: 'off' | 'on'): z.infer<typeof ArmScoresSchema> {
  const runs = armRuns(pairs, arm);
  return {
    recallAtK: Object.fromEntries(IMAGE_AXIS_TOP_K.map((k) => [`@${k}`, recallAtK(runs, k)])),
    mrr: armMrr(pairs, arm),
  };
}

/** Both percentiles of one cost figure, at the report's precision. */
function roundCost(cost: QueryCost): QueryCost {
  return { p50: round(cost.p50), p95: round(cost.p95) };
}

function slice(
  pairs: readonly ImageQueryPair[],
  by: (pair: ImageQueryPair) => string,
): Record<string, PairedDelta> {
  return Object.fromEntries(
    Object.entries(partitionPairs(pairs, by)).map(([key, group]) => [
      key,
      pairedDelta(group, IMAGE_AXIS_DELTA_K),
    ]),
  );
}

export function buildImageAxisReport(input: BuildImageAxisReportInput): ImageAxisReport {
  const pairs = input.run.pairs;
  return {
    imageModel: input.imageModel,
    imageDims: input.imageDims,
    ...(input.backend ? { imageEndpointBackend: input.backend } : {}),
    imageIndexIdentity: input.identity,
    imageIndexed: input.indexed,
    imagesEmbedded: input.imagesEmbedded,
    imagesReused: input.imagesReused,
    imageEmbedWallClockMs: round(input.imageEmbedWallClockMs),
    throughputImagesPerSec: round(input.throughputImagesPerSec),
    backfillThroughputImagesPerSec: round(input.backfillThroughputImagesPerSec),
    interPageDelayMs: input.interPageDelayMs,
    imageLegParticipatingQueries: input.run.imageLegParticipatingQueries,
    legOff: scoresFor(pairs, 'off'),
    legOn: scoresFor(pairs, 'on'),
    delta: {
      recallAtK: Object.fromEntries(IMAGE_AXIS_TOP_K.map((k) => [`@${k}`, pairedDelta(pairs, k)])),
      perStyle: slice(pairs, (p) => p.style),
      perLang: slice(pairs, (p) => p.lang),
    },
    imageHitAtK: Object.fromEntries(IMAGE_HIT_TOP_K.map((k) => [`@${k}`, imageHitAtK(pairs, k)])),
    imageNegativeLeakAtK: Object.fromEntries(
      IMAGE_HIT_TOP_K.map((k) => [`@${k}`, imageNegativeLeakAtK(pairs, k)]),
    ),
    queryCostMs: {
      // Rounded like every other latency figure in the report
      // (`imageEmbedWallClockMs` above, and `latency-stats.ts`'s own callers):
      // `performance.now()` answers in fractional milliseconds, so an unrounded
      // p95 lands in the file as 1843.2749999999996 beside a wall clock written
      // to two places. One precision convention, or a reader pasting two rows
      // of this block into an issue gets two different-looking kinds of number.
      // The metrics themselves stay unrounded — this is the publishing step.
      off: roundCost(queryCostMs(pairs, 'off')),
      on: roundCost(queryCostMs(pairs, 'on')),
      deltaPaired: roundCost(pairedQueryCostDeltaMs(pairs)),
    },
    runsOff: armRuns(pairs, 'off'),
    runsOn: armRuns(pairs, 'on'),
  };
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

/** Signed, in whole milliseconds — a paired latency delta can be negative. */
function signedMs(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(0)}`;
}

function verdictLine(name: string, delta: PairedDelta): string {
  const p = delta.pValue === null ? 'n/a' : delta.pValue.toFixed(4);
  const call = delta.significant
    ? delta.direction === 'improvement' ? 'credible improvement' : 'credible REGRESSION'
    : 'no credible change';
  return (
    `  ${name.padEnd(18)} n=${String(delta.n).padStart(4)}  ` +
    `${delta.off.toFixed(4)} → ${delta.on.toFixed(4)}  ${signed(delta.observedDelta)}  ` +
    `${delta.wins}W/${delta.losses}L  p=${p}  ${call}`
  );
}

/**
 * The console block, as lines — built here rather than printed inline so the
 * table a reader pastes into an issue is covered by a test.
 *
 * The per-slice rows are the point of the whole axis: `image` is the class the
 * leg exists for and `image-negative` the class it must not help, so a headline
 * improvement that is really a leak shows up as the two rows disagreeing.
 */
export function formatImageAxisVerdict(images: ImageAxisReport): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push('--- image axis: page ranking, leg OFF vs leg ON (paired) ---');
  lines.push(
    `model ${images.imageModel} · ${images.imageDims} dims` +
    `${images.imageEndpointBackend ? ` · backend ${images.imageEndpointBackend}` : ''}` +
    ` · ${images.imageIndexed ? 'HNSW' : 'SEQUENTIAL SCAN (no index at this width)'}`,
  );
  lines.push(
    `indexed ${images.imagesEmbedded} images in ${(images.imageEmbedWallClockMs / 1000).toFixed(1)}s ` +
    `(${images.throughputImagesPerSec.toFixed(2)} images/s sequential, no inter-page pause; ` +
    `${images.backfillThroughputImagesPerSec.toFixed(2)} images/s for a backfill, which adds ` +
    `${images.interPageDelayMs}ms per page)`,
  );
  lines.push(`image leg contributed hits to ${images.imageLegParticipatingQueries} queries`);
  lines.push('');
  for (const [k, delta] of Object.entries(images.delta.recallAtK)) {
    lines.push(verdictLine(`Recall${k}`, delta));
  }
  lines.push(`  ${'MRR'.padEnd(18)}       ${images.legOff.mrr.toFixed(4)} → ${images.legOn.mrr.toFixed(4)}`);
  lines.push('');
  lines.push(`by style (Recall@${IMAGE_AXIS_DELTA_K}):`);
  for (const [style, delta] of Object.entries(images.delta.perStyle)) lines.push(verdictLine(style, delta));
  lines.push(`by language (Recall@${IMAGE_AXIS_DELTA_K}):`);
  for (const [lang, delta] of Object.entries(images.delta.perLang)) lines.push(verdictLine(lang, delta));
  lines.push('');
  lines.push(
    `imageHit@K        ${Object.entries(images.imageHitAtK).map(([k, v]) => `${k} ${v.toFixed(4)}`).join('  ')}`,
  );
  lines.push(
    `imageNegLeak@K    ${Object.entries(images.imageNegativeLeakAtK).map(([k, v]) => `${k} ${v.toFixed(4)}`).join('  ')}`,
  );
  lines.push(
    `query cost ms     off p50 ${images.queryCostMs.off.p50.toFixed(0)} / p95 ${images.queryCostMs.off.p95.toFixed(0)}` +
    `   on p50 ${images.queryCostMs.on.p50.toFixed(0)} / p95 ${images.queryCostMs.on.p95.toFixed(0)}`,
  );
  // The paired figure on its own line, and labelled as the leg's cost — the
  // two rows above are independent marginals, so their difference is nobody's
  // query (review r3).
  lines.push(
    `leg cost ms       paired per query: p50 ${signedMs(images.queryCostMs.deltaPaired.p50)} / ` +
    `p95 ${signedMs(images.queryCostMs.deltaPaired.p95)}`,
  );
  return lines;
}
