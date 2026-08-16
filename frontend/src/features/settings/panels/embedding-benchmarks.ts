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
 *    paired test (p = 0.174); the German one is smaller in appearance but
 *    real. Shipping means without that distinction would invite exactly the
 *    wrong conclusion, so `established` is carried per metric and rendered.
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
  rows: BenchmarkRow[];
}

/** Provenance. Rendered verbatim — a number without it is a rumour. */
export const BENCHMARK_PROVENANCE = {
  measuredOn: '2026-08-16',
  corpus: 'Vendored open-source documentation (Fastify, Vitest, Vite) plus synthetic pages',
  corpusPages: 275,
  queries: 197,
  note: 'Not your content. Both models read identical text, so differences between models transfer better than the scores themselves.',
} as const;

export const EMBEDDING_BENCHMARKS: BenchmarkLanguage[] = [
  {
    code: 'de',
    label: 'German',
    rows: [
      {
        model: 'bge-m3',
        dimensions: 1024,
        baseline: true,
        recallAt1: { value: 0.6091, established: null },
        recallAt5: { value: 0.8528, established: null },
        mrr: { value: 0.7119, established: null },
        chunksPerSecond: 10.4,
      },
      {
        model: 'Qwen3-Embedding-4B',
        dimensions: 2560,
        baseline: false,
        // p = 0.0259, 95% CI [+0.015, +0.147]
        recallAt1: { value: 0.6904, established: true },
        // p = 0.1221, 95% CI [-0.005, +0.096] — positive but not established.
        recallAt5: { value: 0.8985, established: false },
        // 95% CI [+0.030, +0.122]
        mrr: { value: 0.7878, established: true },
        chunksPerSecond: 1.0,
      },
    ],
  },
  {
    code: 'en',
    label: 'English',
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
