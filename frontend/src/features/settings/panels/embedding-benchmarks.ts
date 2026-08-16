/**
 * Measured retrieval quality for embedding models, shown in
 * Settings → AI Models → Embeddings so a model choice is not made blind (#1114).
 *
 * These are REFERENCE numbers, not a prediction. They were measured on the
 * #1102 eval corpus — vendored open-source documentation — and its German
 * translation, not on any instance's own pages. Two things follow, and the UI
 * has to carry both or the table is worse than nothing:
 *
 * 1. **The comparison is relative, not absolute.** Both models read identical
 *    text, so the DELTA transfers better than the score does. An operator must
 *    not read "0.69" as "69% of my questions will be answered".
 * 2. **A delta is not a result without its significance.** The English
 *    Recall@1 gap looked like the headline (+0.051) and does not survive a
 *    paired test (p = 0.174). Neither does the German one, once the German
 *    arms are scored with the German stemmer: +0.061 at 27W/15L, p = 0.088.
 *    Shipping means without that distinction would invite exactly the wrong
 *    conclusion, so `established` is carried per metric and rendered.
 *
 * The ingest column is not decoration either. Qwen3 embeds ~10x slower than
 * bge-m3 on the same corpus and hardware, which for a large knowledge base is
 * the dominant cost of switching. A quality-only table would recommend a model
 * while hiding the bill.
 *
 * Absence is not a verdict: a model missing from this table has not been
 * measured, which is different from having measured badly.
 */

export interface BenchmarkMetric {
  /** Mean over the fixture. */
  value: number;
  /**
   * Whether the difference from the baseline survived a paired test
   * (McNemar exact, plus a paired bootstrap interval). `null` on the
   * baseline row itself, where the question does not apply.
   */
  established: boolean | null;
}

export interface BenchmarkRow {
  model: string;
  dimensions: number;
  /** `true` for the row the other rows are compared against. */
  baseline: boolean;
  recallAt1: BenchmarkMetric;
  recallAt5: BenchmarkMetric;
  mrr: BenchmarkMetric;
  /** Chunks embedded per second, same corpus and hardware. */
  chunksPerSecond: number;
}

export interface BenchmarkLanguage {
  code: string;
  label: string;
  /**
   * The PostgreSQL text-search configuration the KEYWORD leg of hybrid
   * retrieval ran under for THIS block (#1114).
   *
   * It used to be one global field, which was honest while every run behind
   * the table was `simple` — nothing in the eval rig wrote
   * `admin_settings.fts_language` until `--fts-language` existed. The German
   * re-measurement on 2026-08-16 ended that: German is `german`, English is
   * still `simple`, and a single label would now certify one block against a
   * configuration it was never measured under. Per-language is the only shape
   * that can state the truth for both.
   */
  ftsLanguage: string;
  rows: BenchmarkRow[];
}

/** Provenance. Rendered verbatim — a number without it is a rumour. */
export const BENCHMARK_PROVENANCE = {
  measuredOn: '2026-08-16',
  corpus: 'Vendored open-source documentation (Fastify, Vitest, Vite) plus synthetic pages',
  corpusPages: 275,
  queries: 197,
  /**
   * The headline text-search configuration: the one the GERMAN arms ran
   * under, because those are the rows a cutover decision leans on. The
   * authoritative per-block value is `BenchmarkLanguage.ftsLanguage`, which is
   * what the table renders; this field must not drift from the German block's,
   * and `EmbeddingModelBenchmarks.test.tsx` fails if it does.
   */
  ftsLanguage: 'german',
  note: 'Not your content. Both models read identical text, so differences between models transfer better than the scores themselves.',
} as const;

/**
 * What the stemmer re-measurement found, rendered so a reader cannot take the
 * `german` label above as evidence that choosing a language buys recall.
 *
 * Both arms were re-run on the same 275-page German corpus with
 * `--fts-language german` (#1114, 2026-08-16). Recall@10 came back
 * bit-identical query-for-query on BOTH models — 197 ties, zero movement — so
 * the stemmer never changed which pages reached the top ten, only their order
 * inside it. The only nominally significant cell was a small Qwen3 Recall@1
 * regression (1W/8L, p = 0.039) that rests on nine discordant queries, dies
 * under a Bonferroni correction and has no partner on the other model.
 */
export const STEMMER_COMPARISON = {
  /** The configuration the German rows above were previously measured under. */
  previousFtsLanguage: 'simple',
  /** bge-m3 Recall@1 under `simple`, for the "within noise" claim. */
  previousBaselineRecallAt1: 0.6091,
  /** Qwen3-Embedding-4B Recall@1 under `simple`. */
  previousCandidateRecallAt1: 0.6904,
} as const;

export const EMBEDDING_BENCHMARKS: BenchmarkLanguage[] = [
  {
    code: 'de',
    label: 'German',
    // Re-measured 2026-08-16 with `--lang de --fts-language german` on the
    // same 275-page corpus (corpusManifestSha 9ee0892c95a7…, 197 queries,
    // identical queryId set). The `simple` figures these replace are kept in
    // STEMMER_COMPARISON above, because the *difference* between the two runs
    // is itself a published result: there isn't one worth acting on.
    ftsLanguage: 'german',
    rows: [
      {
        model: 'bge-m3',
        dimensions: 1024,
        baseline: true,
        recallAt1: { value: 0.5939, established: null },
        recallAt5: { value: 0.8477, established: null },
        mrr: { value: 0.7052, established: null },
        chunksPerSecond: 10.4,
      },
      {
        model: 'Qwen3-Embedding-4B',
        dimensions: 2560,
        baseline: false,
        // +0.061, 27W/15L, p = 0.0884, 95% CI [-0.005, +0.127]. Nominally
        // significant under `simple` (p = 0.026) and not under `german`; the
        // point estimate barely moved (+0.081 → +0.061), so read this as
        // "top-1 was always the noisiest cell", not as the stemmer eroding
        // the model gap. Neither value survived a ×4 multiplicity correction.
        recallAt1: { value: 0.6548, established: false },
        // +0.056, 19W/8L, p = 0.0522, 95% CI [+0.005, +0.102] — positive, and
        // just the wrong side of the line.
        recallAt5: { value: 0.9036, established: false },
        // +0.065, 95% CI [+0.021, +0.110] (graded, so bootstrap rather than
        // McNemar). The one cell in this block that clears on its own terms.
        mrr: { value: 0.7702, established: true },
        // Unchanged by the re-run: the two arms of the `german` re-seed took
        // 4m21s (bge-m3) and 40m55s (Qwen3), reproducing the ~10x ingest gap
        // these figures were derived from.
        chunksPerSecond: 1.0,
      },
    ],
  },
  {
    code: 'en',
    label: 'English',
    // Unchanged, and deliberately: every English baseline — CI's included —
    // was measured under `simple`, and re-deriving the configuration from the
    // corpus language would silently re-measure all of them.
    ftsLanguage: 'simple',
    rows: [
      {
        model: 'bge-m3',
        dimensions: 1024,
        baseline: true,
        recallAt1: { value: 0.6091, established: null },
        recallAt5: { value: 0.8477, established: null },
        mrr: { value: 0.7131, established: null },
        chunksPerSecond: 10.4,
      },
      {
        model: 'Qwen3-Embedding-4B',
        dimensions: 2560,
        baseline: false,
        // p = 0.174, 95% CI [-0.020, +0.117] — the headline that isn't one.
        recallAt1: { value: 0.6599, established: false },
        // p = 0.00154
        recallAt5: { value: 0.9289, established: true },
        // 95% CI [+0.025, +0.115]
        mrr: { value: 0.7839, established: true },
        chunksPerSecond: 1.0,
      },
    ],
  },
];

/**
 * The row matching a configured model name, if it was measured.
 *
 * Providers spell the same model differently (`bge-m3`,
 * `text-embedding-bge-m3`, `BAAI/bge-m3`), so matching is on a normalised
 * substring rather than equality. Returns `undefined` for anything not in the
 * table — which the UI must present as "not measured", never as a negative.
 */
export function findBenchmarkRow(
  language: string,
  configuredModel: string | null | undefined,
): BenchmarkRow | undefined {
  if (!configuredModel) return undefined;
  const needle = configuredModel.toLowerCase();
  const lang = EMBEDDING_BENCHMARKS.find((l) => l.code === language);
  return lang?.rows.find((r) => {
    const key = r.model.toLowerCase();
    return needle.includes(key) || (key === 'qwen3-embedding-4b' && needle.includes('qwen3') && needle.includes('embed'));
  });
}
