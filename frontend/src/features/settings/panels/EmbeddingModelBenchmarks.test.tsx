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

  it('names the text-search configuration the keyword leg ran under (#1114)', () => {
    // The rule this issue established is "every report SAYS which FTS
    // configuration it used" — and this table is the only surface where these
    // numbers reach a human. Nothing in the eval rig wrote
    // admin_settings.fts_language until --fts-language existed, so every run
    // behind this table scored its keyword leg with a language-neutral
    // stemmer. Enforcing that on the JSON report and not here would leave the
    // correction living in a runbook.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    const body = screen.getByTestId('embedding-benchmarks-body');
    expect(body).toHaveTextContent(/simple/);
    expect(body).toHaveTextContent(/text-search configuration/i);
  });

  it('says the German rows are pending re-measurement, since german is the stemmer they should have used', () => {
    // A German deployment reads the German block as its own case. Those rows
    // are a German corpus scored through `simple`; RRF fuses the two legs
    // nonlinearly, so a stronger keyword leg can compress or amplify the gap
    // the swap decision leans on.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    expect(screen.getByTestId('embedding-benchmarks-body')).toHaveTextContent(/German rows/);
  });

  it('does not tell the operator the German comparison survives that re-measurement', () => {
    // Review r3. The rendered note said the absolute scores were pending "but
    // the comparison between them still holds" — the exact claim the runbook
    // and embedding-benchmarks.ts retract two paragraphs apart. Both arms did
    // read the same lexical leg, so the run was like-for-like; that is not the
    // same as the DELTA surviving, because RRF fuses a per-model vector leg
    // with the shared keyword leg as Σ 1/(k + rank), which is nonlinear. The
    // German Recall@1 delta is the one `established: true` number a swap
    // decision leans on, and this panel is the only place it reaches a human.
    render(<EmbeddingModelBenchmarks />);
    fireEvent.click(screen.getByTestId('embedding-benchmarks-toggle'));
    const body = screen.getByTestId('embedding-benchmarks-body');
    expect(body).not.toHaveTextContent(/comparison between them still holds/i);
    // The caveat has to name the deltas, not only the absolute scores…
    expect(body).toHaveTextContent(/differences between the two models/i);
    // …and say why, or it reads as an unexplained hedge.
    expect(body).toHaveTextContent(/nonlinear/i);
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

  it('records that Recall@1 is established in German and NOT in English', () => {
    // The finding that changed the decision. Pinned so a future data edit
    // cannot quietly flatten it back into "Qwen3 wins everywhere".
    const de = EMBEDDING_BENCHMARKS.find((l) => l.code === 'de')!.rows.find((r) => !r.baseline)!;
    const en = EMBEDDING_BENCHMARKS.find((l) => l.code === 'en')!.rows.find((r) => !r.baseline)!;
    expect(de.recallAt1.established).toBe(true);
    expect(en.recallAt1.established).toBe(false);
  });

  it('carries the FTS configuration in its provenance, beside the date (#1114)', () => {
    // "Rendered verbatim — a number without it is a rumour" is this file's own
    // standard, and the lexical configuration was missing from it. Pinned as a
    // field rather than as prose so a re-measurement under `german` has to
    // move the data, not only the sentence.
    expect(BENCHMARK_PROVENANCE.ftsLanguage).toBe('simple');
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
