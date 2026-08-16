import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * #1114 review r1 — the eval entrypoints are the one place no other test can
 * reach.
 *
 * `scripts/run-retrieval-eval.ts` and `scripts/benchmark-query-latency.ts` both
 * call `main()` at the top level, so importing either one runs a destructive
 * eval or a full benchmark as a side effect. Everything they compute lives in
 * tested modules — but the WIRING between those modules is untested, and a
 * mutant that leaves the measurement correct while making the report lie about
 * it passes the entire suite, lint and typecheck. That is exactly #1114's own
 * failure: a published number whose configuration nobody recorded.
 *
 * Two mutants motivated this file, both applied and both green before it
 * existed: publishing `ftsLanguage: DEFAULT_EVAL_FTS_LANGUAGE` instead of the
 * parsed flag, and comparing `report.ftsLanguage` against itself so `--baseline`
 * could never refuse.
 *
 * Reading source text is the repo's established answer for wiring no unit test
 * can see (`frontend/src/ai-scroll-chain.test.ts`,
 * `frontend/src/nginx-api-body-limit.test.ts`). Assertions are made against
 * whitespace-collapsed source where the shape matters, so reflowing a call does
 * not fail the test — only changing what it passes does.
 */

function source(name: string): string {
  return readFileSync(new URL(`../../../../scripts/${name}`, import.meta.url), 'utf8');
}

/** Collapsed, so an argument list broken across lines still matches. */
function collapsed(name: string): string {
  return source(name).replace(/\s+/g, ' ');
}

describe('run-retrieval-eval.ts wiring (#1114)', () => {
  const raw = source('run-retrieval-eval.ts');
  const flat = collapsed('run-retrieval-eval.ts');

  it('publishes the PARSED fts configuration, never a constant', () => {
    // The shorthand is the whole point: `ftsLanguage,` in the report literal
    // is the value parseFtsLanguageArg returned. Any `ftsLanguage: <expr>`
    // outside the interface declaration is a label decoupled from the run.
    expect(raw).toMatch(/\n\s*ftsLanguage,\n/);
    const annotated = [...raw.matchAll(/ftsLanguage:\s*([^,;\n]+)/g)].map((m) => m[1]!.trim());
    expect(annotated).toEqual(['string']);
  });

  it('compares the BASELINE against the run, not the run against itself', () => {
    expect(flat).toContain('assertComparableFtsLanguage(baseline.ftsLanguage, report.ftsLanguage)');
  });

  it('writes the configuration before the seed and certifies it after', () => {
    // Migration 049 builds pages.tsv from a BEFORE INSERT trigger reading that
    // row, so the ordering IS the fix — a write moved below seedCorpus leaves
    // the corpus indexed under one configuration and queried under another,
    // and every function involved would still pass its own tests.
    const write = raw.indexOf('await configureFtsLanguage(ftsLanguage)');
    const seed = raw.indexOf('await seedCorpus(');
    const certify = raw.indexOf('await assertSeededFtsLanguage(ftsLanguage)');
    expect(write).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(write);
    expect(certify).toBeGreaterThan(seed);
  });

  it('records the seeded corpus language only after the corpus is in', () => {
    // The row states what the database holds; written before the seed it would
    // survive a run that died halfway and claim a corpus that is not there.
    const seed = raw.indexOf('await seedCorpus(');
    const record = raw.indexOf('await recordCorpusLanguage(language)');
    expect(record).toBeGreaterThan(seed);
  });
});

describe('benchmark-query-latency.ts wiring (#1114)', () => {
  const flat = collapsed('benchmark-query-latency.ts');

  it('resolves the search half\'s model from the database and refuses a mislabelled arm', () => {
    // hybridSearch takes no model: rag-service resolves one from the
    // `embedding` assignment. Passing config.models here instead of the
    // resolved pair would make the refusal compare a label with itself.
    expect(flat).toContain("await resolveUsecase('embedding')");
    expect(flat).toContain(
      'assertSearchArmMatchesAssignment({ model, baseUrl: config.baseUrl, '
      + 'assignedModel: searchModel, assignedBaseUrl: searchBaseUrl, })',
    );
  });

  it('records the RESOLVED pair in the report, not the flags that labelled it', () => {
    expect(flat).toContain('searchModel, searchBaseUrl,');
    expect(flat).not.toContain('searchModel: config.models');
    expect(flat).not.toContain('searchBaseUrl: config.baseUrl');
  });

  it('measures without writing: no analytics rows for questions nobody asked', () => {
    expect(flat).toContain('recordAnalytics: false');
  });

  it('reads the live ceilings a search rung above 4 is really measuring', () => {
    expect(flat).toContain('llmConcurrency: getMetrics().concurrency');
    expect(flat).toContain('vectorPoolMax: getVectorPool().options.max');
  });
});
