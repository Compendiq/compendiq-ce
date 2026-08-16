import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  EMBEDDING_BENCHMARKS,
  BENCHMARK_PROVENANCE,
  type BenchmarkMetric,
} from './embedding-benchmarks';

/**
 * Measured retrieval quality per embedding model and language (#1114).
 *
 * An admin picking an embedding model had nothing to go on. This gives them
 * the measurements — and, just as importantly, everything that stops the
 * measurements being misread:
 *
 * - **Language is the top-level split, not a footnote.** The two models do not
 *   rank the same way in both: Qwen3's Recall@1 gain is established in German
 *   and is NOT established in English. A single blended table would have hidden
 *   the one distinction most likely to change an operator's decision.
 * - **Significance is shown per metric**, because the mean alone points the
 *   wrong way. English Recall@1 moves +0.051 and does not survive a paired
 *   test; presenting it as a win is the mistake this column exists to prevent.
 * - **Ingest speed sits in the same table as quality.** Qwen3 is ~10x slower
 *   to embed. A quality-only comparison recommends a model while hiding the
 *   bill, and on a large corpus that cost is the dominant fact about switching.
 * - **Provenance is rendered, not buried in a tooltip.** These are vendored
 *   OSS docs, not the operator's pages, so the deltas transfer and the absolute
 *   scores do not.
 *
 * Presentation follows ADR-010's rule for a MEASUREMENT rather than a state:
 * neutral throughout, no status hues. `status-connected` green for "best" would
 * borrow a reserved pipeline colour for a benchmark, which is the borrowing the
 * QualityScoreBadge de-colouring removed. The signal is the number and the word.
 */

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * A metric cell. `established === false` is the load-bearing case: the value is
 * higher, and the difference did not survive a paired test. It is marked in
 * words rather than by omission, because a bare higher number reads as a win.
 */
function Metric({ metric }: { metric: BenchmarkMetric }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 font-mono text-xs tabular-nums">
      {pct(metric.value)}
      {metric.established === false && (
        <span className="font-sans text-[11px] text-muted-foreground" title="Higher, but the difference did not survive a paired significance test">
          not established
        </span>
      )}
    </span>
  );
}

export function EmbeddingModelBenchmarks() {
  const [open, setOpen] = useState(false);

  return (
    <div className="nm-card p-4">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="embedding-benchmarks-toggle"
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-sm font-medium">Model comparison (reference corpus)</span>
        <span className="ml-auto text-xs text-muted-foreground">
          measured {BENCHMARK_PROVENANCE.measuredOn}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-4" data-testid="embedding-benchmarks-body">
          {/*
            First, not last. Someone who reads only one line must read this one,
            because the failure mode is an operator treating 69% as a forecast
            for their own knowledge base.
          */}
          <p className="text-sm text-muted-foreground">
            Measured on {BENCHMARK_PROVENANCE.corpusPages} pages of{' '}
            {BENCHMARK_PROVENANCE.corpus.toLowerCase()} with{' '}
            {BENCHMARK_PROVENANCE.queries} labelled questions.{' '}
            <strong className="font-medium text-foreground">{BENCHMARK_PROVENANCE.note}</strong>
          </p>

          {EMBEDDING_BENCHMARKS.map((lang) => (
            <div key={lang.code} className="space-y-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {lang.label}
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" className="py-1.5 pr-3 font-medium">Model</th>
                      <th scope="col" className="py-1.5 pr-3 font-medium">Top&nbsp;result</th>
                      <th scope="col" className="py-1.5 pr-3 font-medium">Top&nbsp;5</th>
                      <th scope="col" className="py-1.5 pr-3 font-medium">MRR</th>
                      <th scope="col" className="py-1.5 font-medium">Indexing speed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lang.rows.map((row) => (
                      <tr key={row.model} className="border-b border-border/60 last:border-0">
                        <td className="py-1.5 pr-3">
                          <span className="font-medium">{row.model}</span>
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {row.dimensions}d{row.baseline ? ' · baseline' : ''}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3"><Metric metric={row.recallAt1} /></td>
                        <td className="py-1.5 pr-3"><Metric metric={row.recallAt5} /></td>
                        <td className="py-1.5 pr-3"><Metric metric={row.mrr} /></td>
                        <td className="py-1.5 font-mono text-xs tabular-nums">
                          {row.chunksPerSecond.toFixed(1)} chunks/s
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {/*
            Muted, never amber. This is a scope note on a table an admin opened
            deliberately, not a warning about a system state — and ADR-010
            reserves amber for attention. A permanent amber notice here would
            teach people to ignore amber elsewhere.
          */}
          <p className="text-xs text-muted-foreground">
            Differences between models transfer to your content better than the scores
            themselves. &ldquo;Not established&rdquo; means the model scored higher but the
            difference did not survive a paired significance test, so it should not be
            counted as a win. Indexing speed is measured on the same corpus and hardware:
            a slower model makes the initial re-embed proportionally longer. A model absent
            from this table has not been measured, which is not the same as measuring badly.
          </p>
        </div>
      )}
    </div>
  );
}
