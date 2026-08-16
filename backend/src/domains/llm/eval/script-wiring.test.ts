import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVAL_KNOWN_FLAGS, EVAL_VALUELESS_FLAGS } from './cli-flags.js';

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

/**
 * Comments in these scripts quote flags too — including the typo that motivated
 * the unknown-flag guard — so a scan for "which flags does this script read"
 * has to read CODE. The `[^:]` guard keeps a `http://` in a string from
 * swallowing the rest of its line.
 */
function code(name: string): string {
  return source(name)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
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

  // #1114 review r2 — the benchmark refused an unrecognised flag and this
  // script ignored one, so `--fts-langauge german` ran the full hour under
  // `simple`.
  it('refuses an unknown flag before anything is embedded', () => {
    expect(flat).toContain(
      'assertKnownFlags(process.argv.slice(2), EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS)',
    );
    // Ahead of the database and the provider probe: a typo must cost nothing.
    const guard = raw.indexOf('assertKnownFlags(');
    const db = raw.indexOf('assertDisposableDatabase(');
    expect(guard).toBeGreaterThan(-1);
    expect(db).toBeGreaterThan(guard);
  });

  // #1114 review r3 — the guard above admits `--out=/tmp/x.json` (it checks
  // the name half), and this script's own reader was
  // `process.argv.indexOf('--out')`, which cannot see that token. So
  // `--baseline=prev.json` passed the guard and was then dropped: an hour of
  // embedding whose comparison section never prints. One reader, unit-tested
  // in cli-flags.test.ts, is the fix — and this is the assertion that the
  // script is actually on it.
  it('reads its values through the shared reader, in both spellings', () => {
    // Matched on the DELEGATION, not on one spelling of the declaration: an
    // arrow and a `function arg(name) { return flagValue(…) }` are equally
    // correct, and pinning the exact text failed a reformat that changed
    // nothing (review r4). `[^;]` keeps the gap inside one statement, so a
    // stray `arg` elsewhere cannot pair with a `flagValue` call further down.
    expect(flat).toMatch(/\barg\b[^;]{0,80}flagValue\(process\.argv, name\)/);
    // No hand-rolled index arithmetic left anywhere — that is the whole bug,
    // and this is the assertion that actually catches it coming back.
    expect(code('run-retrieval-eval.ts')).not.toMatch(/process\.argv\.indexOf\(/);
  });

  it('reads --lang through that reader too, not a second bespoke parser', () => {
    // It carried its own `=`-aware branch, which is how the two spellings came
    // to disagree flag by flag in the first place.
    expect(flat).toContain("const langArg = arg('lang')");
    expect(code('run-retrieval-eval.ts')).not.toContain("startsWith('--lang=')");
  });

  it('knows every flag it reads — the list cannot drift from the parsing', () => {
    // Both spellings the script uses: a literal `--flag` test, and `arg('flag')`
    // (which is how --mmr-lambda is read, with no literal anywhere).
    const body = code('run-retrieval-eval.ts');
    const inSource = new Set([
      ...[...body.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!),
      ...[...body.matchAll(/\barg\('([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]!),
    ]);
    // The scan has to find something, or a broken regex passes silently.
    expect(inSource.size).toBeGreaterThanOrEqual(8);
    const unknown = [...inSource].filter((f) => !(EVAL_KNOWN_FLAGS as readonly string[]).includes(f));
    expect(unknown).toEqual([]);
  });

  // The mirror of the scan above, for the OTHER half of the guard (review r4).
  // `EVAL_KNOWN_FLAGS` being complete stops a typo; `EVAL_VALUELESS_FLAGS`
  // being complete is what stops `--rerank=true` measuring plain retrieval
  // under a report that says reranked. Nothing tied the second list to the
  // script, so dropping a switch from it re-opened exactly that hole with the
  // whole suite green — verified by removing 'rerank' from the list, which
  // fails this test and nothing else.
  it('knows every SWITCH it reads — the valueless list cannot drift either', () => {
    // A switch is a flag read as a bare token: no `=` spelling can satisfy
    // `includes`, which is the entire reason those flags must refuse a value.
    const body = code('run-retrieval-eval.ts');
    const switches = [...body.matchAll(/process\.argv\.includes\('--([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]!);
    // The scan has to find something, or a broken regex passes silently.
    expect(new Set(switches).size).toBeGreaterThanOrEqual(5);
    const unlisted = [...new Set(switches)].filter(
      (f) => !(EVAL_VALUELESS_FLAGS as readonly string[]).includes(f),
    );
    expect(unlisted).toEqual([]);
  });
});

describe('benchmark-query-latency.ts wiring (#1114)', () => {
  const raw = source('benchmark-query-latency.ts');
  const flat = collapsed('benchmark-query-latency.ts');

  // #1114 review r4 — the eval CERTIFIES the configuration it seeded under
  // (`assertSeededFtsLanguage` above); this script published the live
  // `admin_settings` row as `metadata.ftsLanguage` while certifying nothing.
  // The eval writes that row before it truncates the corpus, so a failure in
  // between leaves the previous corpus standing under a changed
  // configuration — and the search half's keyword leg then genuinely runs
  // mismatched, so the timing is wrong too, not only the label.
  it('certifies the seeded corpus was built under the configuration it reports', () => {
    const read = raw.indexOf('await getFtsLanguage()');
    const certify = raw.indexOf('await assertSeededFtsLanguage(ftsLanguage)');
    expect(read).toBeGreaterThan(-1);
    expect(certify).toBeGreaterThan(read);
    // Ahead of every timed call, or the refusal arrives after the run it was
    // supposed to prevent.
    expect(raw.indexOf('timeConcurrently(')).toBeGreaterThan(certify);
  });

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

  // #1114 review r2 — the shared guard's default message describes the eval
  // rig's TRUNCATE/RETYPE, which this script never does. Told that, an
  // operator of a read-only timing run reaches for
  // EVAL_ALLOW_DESTRUCTIVE — in a shell they may later reuse for the eval.
  it('tells the disposable-database guard that it only reads', () => {
    expect(flat).toMatch(/assertDisposableDatabase\(process\.env\.POSTGRES_URL \?\? '', \{ what: /);
    expect(flat).toMatch(/what: '[^']*READS[^']*'/);
  });
});
