import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS } from './cli-flags.js';

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

  it('publishes the PARSED fts configuration, never a constant — on BOTH axes', () => {
    // The shorthand is the whole point: `ftsLanguage,` in a report literal is
    // the value parseFtsLanguageArg returned. Any `ftsLanguage: <expr>`
    // outside a type declaration is a label decoupled from the run.
    //
    // Counted, not merely present (#1115 P5b): there are two report builders
    // now — the text gate's and the image axis's — and a second one that
    // published a constant while the first kept the shorthand would pass a
    // bare `toMatch`.
    expect(raw.match(/\n\s*ftsLanguage,\n/g)).toHaveLength(2);
    const annotated = [...raw.matchAll(/ftsLanguage:\s*([^,;\n]+)/g)].map((m) => m[1]!.trim());
    expect([...new Set(annotated)]).toEqual(['string']);
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

/**
 * #1115 P5b — the image axis's wiring, for exactly the reason the block above
 * exists: every module it composes has its own tests, and a mutant that leaves
 * each of them correct while composing them in the wrong ORDER passes the whole
 * suite. The orderings below are not stylistic — each one is a state the
 * product itself refuses to be in.
 */
describe('run-retrieval-eval.ts image axis wiring (#1115 P5b)', () => {
  const raw = source('run-retrieval-eval.ts');
  const flat = collapsed('run-retrieval-eval.ts');

  it('selects the axis from the flag and refuses a conflicting --lang', () => {
    expect(flat).toContain('wantsImageAxis(process.argv)');
    expect(flat).toContain('parseImageAxisLanguage(process.argv)');
    // The English gate's own branch must still be reachable, or `--lang de`
    // silently starts resolving through the image axis's rule.
    expect(flat).toContain("langArg && langArg !== 'en' ? langArg : 'en'");
  });

  it('requires the VL endpoint from ITS OWN variables before it touches the database', () => {
    expect(flat).toContain('readImageAxisEnv()');
    // Never the text pair: that endpoint would answer, in the wrong shape,
    // with a vector from a different space.
    expect(raw).not.toContain('EVAL_IMAGE_EMBEDDING_BASE_URL ?? process.env.EVAL_EMBEDDING_BASE_URL');
    // …and BEFORE the disposable-database guard, which is the first thing that
    // opens a connection and runs the migrations. Read inside the measurement
    // instead, a missing variable cost a connection, a migration run and a
    // provider probe before saying so — the whole argument the unknown-flag
    // guard is written out of, one environment over.
    const env = raw.indexOf('readImageAxisEnv()');
    const lang = raw.indexOf('parseImageAxisLanguage(process.argv)');
    const db = raw.indexOf('assertDisposableDatabase(');
    expect(env).toBeGreaterThan(-1);
    expect(lang).toBeGreaterThan(-1);
    expect(db).toBeGreaterThan(env);
    expect(db).toBeGreaterThan(lang);
  });

  it('defaults its report to a DIFFERENT file, so it cannot overwrite a text baseline', () => {
    // Both axes defaulted to `retrieval-eval.json`, so an --images run started
    // without --out silently destroyed the text gate's recorded report — the
    // file the runbook tells operators to keep and pass as --baseline. The two
    // are not interchangeable: `assertComparableAxis` refuses the pair outright,
    // so there is no reading under which one path serves both.
    expect(flat).toContain("arg('out') ?? (imageAxis ? 'retrieval-eval-images.json' : 'retrieval-eval.json')");
    // …and the flag reference says so, or the default is a fact only the source
    // carries — the contract EVAL_USAGE is held to for every other flag.
    expect(EVAL_USAGE).toContain('retrieval-eval-images.json');
  });

  it('refuses --deep-search on this axis, before the database is touched (review r2)', () => {
    // Every other stage flag is held constant across the two arms. Deep search
    // cannot be: each arm reformulates for itself, so two of each arm's three
    // fused legs are different questions and the paired verdict attributes that
    // to the leg. Beside the other flag parsing, so it costs a message rather
    // than a connection and a migration run.
    expect(flat).toContain('assertImageAxisStagesPairable(process.argv)');
    const stages = raw.indexOf('assertImageAxisStagesPairable(process.argv)');
    expect(stages).toBeGreaterThan(-1);
    expect(raw.indexOf('assertDisposableDatabase(')).toBeGreaterThan(stages);
    expect(raw.indexOf('await runMigrations()')).toBeGreaterThan(stages);
  });

  it('refuses a same-axis baseline measured through a different VL model (review r2)', () => {
    // `baseline.model` is the TEXT embedder and is identical on both axes, so
    // without this guard two runs of different checkpoints passed every check
    // the harness makes and their difference was printed as a verdict about
    // retrieval logic — the exact comparison the text-model guard refuses.
    expect(flat).toContain('assertComparableImageModel(baseline.images, report.images)');
    const axisGuard = raw.indexOf('assertComparableAxis(');
    const modelGuard = raw.indexOf('assertComparableImageModel(');
    const shaGuard = raw.indexOf('if (baseline.corpusManifestSha !== report.corpusManifestSha)');
    expect(modelGuard).toBeGreaterThan(axisGuard);
    expect(shaGuard).toBeGreaterThan(modelGuard);
  });

  it('stages the attachments directory before the seeder writes a byte', () => {
    // `attachment-store` resolves its root at call time, so this call is what
    // decides where the seeder writes AND where the intake reads. After the
    // seed it would be a temp directory nothing ever looked in.
    const stage = raw.indexOf('await stageEvalAttachmentsDir()');
    const seed = raw.indexOf('await seedImageCorpus(');
    expect(stage).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(stage);
  });

  it('prepares (and probes) the image index before any image is embedded', () => {
    // `prepareImageIndex` writes the truncation width, probes the pair and
    // types the column. Run after the seed, every image would be embedded
    // against an untyped column and fail on the first insert.
    const prepare = raw.indexOf('await prepareImageIndex(imageEnv)');
    const seed = raw.indexOf('await seedImageCorpus(');
    expect(prepare).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(prepare);
  });

  it('certifies the FTS configuration and records a DISTINCT corpus claim on this axis', () => {
    // Both are properties of the SEEDED corpus, and the image axis seeds one.
    const seed = raw.indexOf('await seedImageCorpus(');
    expect(raw.indexOf('await assertSeededFtsLanguage(ftsLanguage)', seed)).toBeGreaterThan(seed);
    // …and the claim is NOT `language` (review r1). It reads 'de' on this
    // axis, which is exactly what the German TEXT corpus writes — so the row
    // #1114 added to let benchmark-query-latency.ts refuse a question set
    // aimed at the wrong corpus could no longer tell the two apart, and the
    // refusal switched off for the state it exists to catch.
    expect(raw.indexOf('await recordCorpusLanguage(IMAGE_AXIS_CORPUS_CLAIM)', seed)).toBeGreaterThan(seed);
    // One call each, so the image axis cannot quietly go back to writing the
    // language while the constant sits unused beside it.
    expect(raw.match(/recordCorpusLanguage\(language\)/g)).toHaveLength(1);
    expect(raw.match(/recordCorpusLanguage\(IMAGE_AXIS_CORPUS_CLAIM\)/g)).toHaveLength(1);
    expect(raw.indexOf('await recordCorpusLanguage(language)')).toBeLessThan(seed);
  });

  it('publishes MEASURED participation counts, per query and from the leg-on arm', () => {
    // Zero is a refusal condition on the text gate (`runner.ts` throws when an
    // assembly-on run assembled nothing), so a hardcoded 0 in these fields
    // asserts the broken state the harness refuses to publish. And the counts
    // are the ON arm's, never a sum over both: `queries` is the label count, so
    // an arm-query total prints participation above 100% (review r1).
    expect(flat).toContain('assemblyParticipatingQueries: run.assemblyParticipatingQueries.on');
    expect(flat).toContain('pinParticipatingQueries: run.pinParticipatingQueries.on');
    expect(flat).toContain('expansionParticipatingQueries: run.expansionParticipatingQueries.on');
    expect(flat).toContain('expansionSkippedQueries: run.expansionSkippedQueries.on');
    expect(flat).not.toContain('assemblyParticipatingQueries: 0');
    expect(flat).not.toContain('pinParticipatingQueries: 0');
  });

  it('runs the paired runner over the seeded page map', () => {
    expect(flat).toContain('await runImageEval(fixture, { userId: EVAL_USER_ID, pageIdByFile: seeded.pageIdByFile,');
    // The whole-fixture power floor applies to the image fixture as well —
    // Recall@K over N moves in 1/N steps whatever the labels carry.
    expect(flat).toContain('const fixture = loadImageFixture(); assertFixturePower(fixture);');
  });

  it('marks the report with its axis and refuses a cross-axis baseline FIRST', () => {
    expect(flat).toContain('axis: IMAGE_AXIS');
    expect(flat).toContain('axis: TEXT_AXIS');
    expect(flat).toContain('assertComparableAxis(baseline.axis, report.axis ?? TEXT_AXIS)');
    // Ahead of the language and corpus-sha refusals: a cross-axis pair trips
    // those too, and "a different corpus" sends the reader looking for a
    // corpus edit that never happened.
    const axisGuard = raw.indexOf('assertComparableAxis(');
    const langGuard = raw.indexOf("if ((baseline.language ?? 'en') !== report.language)");
    const shaGuard = raw.indexOf('if (baseline.corpusManifestSha !== report.corpusManifestSha)');
    expect(axisGuard).toBeGreaterThan(-1);
    expect(langGuard).toBeGreaterThan(axisGuard);
    expect(shaGuard).toBeGreaterThan(axisGuard);
  });

  it('compares a same-axis baseline arm by arm, not only the arm the top-level runs carry', () => {
    // `runs` IS the leg-on arm, so comparing it alone would blame the image
    // leg for a change that moved the text legs.
    expect(flat).toContain("compareArm('leg OFF', baseline.images.runsOff, report.images.runsOff)");
    expect(flat).toContain("compareArm('leg ON', baseline.images.runsOn, report.images.runsOn)");
    // One verdict rule, shared — never a second copy of the McNemar branch.
    expect(raw.match(/mcnemar-exact/g)).toHaveLength(1);
  });

  it('publishes the leg-ON arm as the top-level scores, since that is the shipped configuration', () => {
    expect(flat).toContain('recallAtK: images.legOn.recallAtK');
    expect(flat).toContain('mrr: images.legOn.mrr');
    expect(flat).toContain("const runsOn = armRuns(run.pairs, 'on')");
  });

  it('prints the paired verdict table rather than the text gate\'s redundancy line', () => {
    expect(flat).toContain('formatImageAxisVerdict(report.images)');
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

  // #1285 — the scan depth stopped being a `process.env` constant visible in
  // the launching shell and became a row in the database under test, so two
  // identically-labelled runs can now measure different depths over one corpus
  // (0.39 ms per probe at 100 against 1.74 ms at 1000 — the very quantity this
  // script publishes). Its wiring is the shape this file exists for: deleting
  // both fields from the metadata literal leaves the measurement correct and
  // the report silent about what it measured, and lint, typecheck and every
  // other suite stay green (verified by mutation).
  it('publishes the ef_search floor it ran at, and its provenance, from the resolver', () => {
    // Through the product's own reader, so inheritance (row → deprecated
    // variable → default) cannot drift from what the timed kNN really runs at.
    expect(flat).toContain(
      '({ value: ragEfSearch, source: ragEfSearchSource } = await resolveRagEfSearch())',
    );
    // Shorthand: the published fields ARE what the resolver returned. Any
    // `ragEfSearch: <expr>` here is a label decoupled from the run — and the
    // source half is not optional, because "100" reached by a saved row, by
    // the deprecated variable and by the unconfigured default are three
    // different claims about the instance.
    expect(flat).toContain('ragEfSearch, ragEfSearchSource,');

    // Resolved ahead of the first timed call, so the report cannot describe a
    // depth read after the run it is supposed to characterise.
    const resolve = raw.indexOf('await resolveRagEfSearch()');
    expect(resolve).toBeGreaterThan(-1);
    expect(raw.indexOf('timeConcurrently(')).toBeGreaterThan(resolve);
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
