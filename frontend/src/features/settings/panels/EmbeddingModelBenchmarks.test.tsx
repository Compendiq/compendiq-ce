import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmbeddingModelBenchmarks } from './EmbeddingModelBenchmarks';
import { EMBEDDING_BENCHMARKS, BENCHMARK_PROVENANCE, findBenchmarkRow } from './embedding-benchmarks';

/**
 * The risk this panel carries is not that it renders wrongly — it is that it
 * renders persuasively. An admin who reads "69%" as a forecast for their own
 * knowledge base, or a higher-but-not-significant number as a win, has been
 * misled by a feature meant to inform them. These tests pin the parts that
 * exist to prevent that, not the layout.
 */
describe('EmbeddingModelBenchmarks (#1114)', () => {
  it('is collapsed by default — reference material, not a setting', () => {
    render(<EmbeddingModelBenchmarks />);
    expect(screen.queryByTestId('embedding-benchmarks-body')).not.toBeInTheDocument();
    expect(screen.getByTestId('embedding-benchmarks-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands on click', () => {
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    expect(screen.getByTestId('embedding-benchmarks-body')).toBeInTheDocument();
  });

  it('states that the corpus is NOT the operator’s content, in visible text', () => {
    // The single most important line. It must be readable at rest — a caveat
    // that lives only in a `title` is unreachable by touch, keyboard and
    // screen readers, which is the ADR-010 rule the deep-search toggle
    // established.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    const body = screen.getByTestId('embedding-benchmarks-body');
    expect(body).toHaveTextContent(/not your content/i);
    expect(body).toHaveTextContent(/197 labelled questions/i);
  });

  it('names the text-search configuration EACH language block ran under (#1114)', () => {
    // The rule this issue established is "every report SAYS which FTS
    // configuration it used" — and this table is the only surface where these
    // numbers reach a human. The two blocks no longer share one answer: the
    // German arms were re-measured under `german` on 2026-08-16, the English
    // ones are still `simple`. A single global label would now be wrong for
    // one of the two blocks, which is the same omission one layer along.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    expect(screen.getByTestId('embedding-benchmarks-fts-de')).toHaveTextContent(/german/);
    expect(screen.getByTestId('embedding-benchmarks-fts-en')).toHaveTextContent(/simple/);
    expect(screen.getByTestId('embedding-benchmarks-body')).toHaveTextContent(
      /text-search configuration/i,
    );
  });

  it('reports the German re-measurement as done, not pending', () => {
    // The re-run under `--fts-language german` happened (2026-08-16). A note
    // still calling those rows "pending re-measurement" would be describing a
    // state that ended, on the one surface where these numbers reach a human.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    const body = screen.getByTestId('embedding-benchmarks-body');
    expect(body).toHaveTextContent(/German rows/);
    expect(body).not.toHaveTextContent(/pending/i);
  });

  it('states the measured stemmer result, so `german` does not read as a recall upgrade', () => {
    // What the re-run found: the stemmer moved a handful of queries either
    // way and Recall@10 was bit-identical query-for-query on both models. A
    // panel that quietly swaps `simple` for `german` in its provenance line
    // and says nothing else invites the opposite conclusion — that the
    // earlier numbers were understating German retrieval and that picking a
    // language buys recall. Neither is true, and this is the surface an
    // operator reads before touching the keyword-index control.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    const body = screen.getByTestId('embedding-benchmarks-body');
    expect(body).toHaveTextContent(/within noise/i);
    expect(body).toHaveTextContent(/simple/);
  });

  it('says which metrics carry the German model gap, since the table omits them', () => {
    // The table has three columns; the two cells that clear significance
    // under a Bonferroni correction (Recall@3 p = 0.0037, Recall@10
    // p = 0.0075) are not among them. Under `german` the Top result and Top 5
    // columns both read "not established", so the block on screen understates
    // a comparison the runbook calls the sturdiest thing in the data. Naming
    // the missing metrics costs one sentence.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    const body = screen.getByTestId('embedding-benchmarks-body');
    expect(body).toHaveTextContent(/Recall@3/);
    expect(body).toHaveTextContent(/Recall@10/);
  });

  it('marks a higher-but-unproven number as "not established"', () => {
    // The load-bearing assertion. English Recall@1 is HIGHER for Qwen3
    // (0.6599 vs 0.6091) and did not survive a paired test (p = 0.174).
    // Rendering the number without the qualifier would present the one
    // result this whole investigation showed to be an artifact as the win.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    expect(screen.getAllByText(/not established/i).length).toBeGreaterThanOrEqual(2);
  });

  it('splits by language at the top level, because the ranking differs by language', () => {
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    expect(screen.getByRole('heading', { name: /german/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /english/i })).toBeInTheDocument();
  });

  it('shows indexing speed beside quality, so the table is not one-sided', () => {
    // Qwen3 is ~10x slower to embed. A quality-only table recommends a model
    // while hiding the dominant cost of switching to it.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    const body = screen.getByTestId('embedding-benchmarks-body');
    expect(body).toHaveTextContent(/10\.4 chunks\/s/);
    expect(body).toHaveTextContent(/1\.0 chunks\/s/);
  });

  it('says that an absent model is unmeasured, not bad', () => {
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    expect(screen.getByTestId('embedding-benchmarks-body')).toHaveTextContent(/has not been measured/i);
  });

  it('uses no status colours — a measurement is not a pipeline state (ADR-010)', () => {
    // The QualityScoreBadge de-colouring argument: green-for-best would
    // borrow `status-connected`, a hue reserved for pipeline state, for a
    // benchmark. The number and the word are the channel.
    const { container } = render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    expect(container.innerHTML).not.toMatch(/status-(connected|disconnected|syncing|embedding)/);
    expect(container.innerHTML).not.toMatch(/text-(success|warning|destructive)\b/);
  });
});

describe('embedding-benchmarks data (#1114)', () => {
  it('carries significance for every non-baseline metric', () => {
    // A delta without its significance is what produced the wrong English
    // conclusion in the first place; the data shape makes omitting it
    // impossible rather than merely discouraged.
    for (const lang of EMBEDDING_BENCHMARKS) {
      for (const row of lang.rows) {
        for (const m of [row.recallAt1, row.recallAt5, row.mrr]) {
          expect(row.baseline ? m.established === null : typeof m.established === 'boolean').toBe(true);
        }
      }
    }
  });

  it('records that Recall@1 is established in NEITHER language once German is scored under `german`', () => {
    // This flag moved, and the movement is the point. Under `simple` the
    // German Recall@1 delta was nominally significant (31W/15L, p = 0.026) and
    // was the one `established: true` top-1 number a swap decision leaned on.
    // Re-measured under `german` it is 27W/15L, p = 0.088 — the point estimate
    // barely moved (+0.081 → +0.061) but it no longer clears the line, and it
    // never survived a multiplicity correction in either configuration. So the
    // honest table says top-1 is unestablished in both languages. Pinned so a
    // later edit cannot quietly restore "Qwen3 wins the top result".
    const de = EMBEDDING_BENCHMARKS.find((l) => l.code === 'de')!.rows.find((r) => !r.baseline)!;
    const en = EMBEDDING_BENCHMARKS.find((l) => l.code === 'en')!.rows.find((r) => !r.baseline)!;
    expect(de.recallAt1.established).toBe(false);
    expect(en.recallAt1.established).toBe(false);
    // MRR is what survives on both sides — bootstrap CI clear of zero in each.
    expect(de.mrr.established).toBe(true);
    expect(en.mrr.established).toBe(true);
  });

  it('carries the German scores measured under `german`, not the `simple` ones', () => {
    // The exact means from the 2026-08-16 re-run. Pinned as values because a
    // partial edit — new provenance label, old numbers — is the failure this
    // whole correction exists to undo.
    const de = EMBEDDING_BENCHMARKS.find((l) => l.code === 'de')!;
    const base = de.rows.find((r) => r.baseline)!;
    const qwen = de.rows.find((r) => !r.baseline)!;
    expect(base.recallAt1.value).toBeCloseTo(0.5939, 4);
    expect(base.recallAt5.value).toBeCloseTo(0.8477, 4);
    expect(base.mrr.value).toBeCloseTo(0.7052, 4);
    expect(qwen.recallAt1.value).toBeCloseTo(0.6548, 4);
    expect(qwen.recallAt5.value).toBeCloseTo(0.9036, 4);
    expect(qwen.mrr.value).toBeCloseTo(0.7702, 4);
  });

  it('carries the FTS configuration per language, because the two blocks differ (#1114)', () => {
    // "Rendered verbatim — a number without it is a rumour" is this file's own
    // standard. It used to be one global field, which was true while every run
    // behind the table was `simple`. The German re-measurement ended that: a
    // single label would now certify the English rows against a configuration
    // they were never measured under.
    const de = EMBEDDING_BENCHMARKS.find((l) => l.code === 'de')!;
    const en = EMBEDDING_BENCHMARKS.find((l) => l.code === 'en')!;
    expect(de.ftsLanguage).toBe('german');
    expect(en.ftsLanguage).toBe('simple');
    // The headline provenance names the German configuration — those are the
    // rows a swap decision leans on — and must not drift from the block.
    expect(BENCHMARK_PROVENANCE.ftsLanguage).toBe('german');
    expect(BENCHMARK_PROVENANCE.ftsLanguage).toBe(de.ftsLanguage);
  });

  it('matches a configured model across provider naming conventions', () => {
    for (const name of ['bge-m3', 'text-embedding-bge-m3', 'BAAI/bge-m3']) {
      expect(findBenchmarkRow('de', name)?.model, name).toBe('bge-m3');
    }
    for (const name of ['text-embedding-qwen3-embedding-4b', 'Qwen/Qwen3-Embedding-4B', 'qwen3-embedding:4b']) {
      expect(findBenchmarkRow('de', name)?.model, name).toBe('Qwen3-Embedding-4B');
    }
  });

  it('returns undefined for an unmeasured model rather than guessing', () => {
    expect(findBenchmarkRow('de', 'nomic-embed-text')).toBeUndefined();
    expect(findBenchmarkRow('de', null)).toBeUndefined();
    expect(findBenchmarkRow('de', '')).toBeUndefined();
  });
});
