import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ARM_ANSWERS_KNOWN_FLAGS, ARM_ANSWERS_VALUELESS_FLAGS, EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS,
  JUDGE_KNOWN_FLAGS, JUDGE_VALUELESS_FLAGS,
  LABEL_PACKET_KNOWN_FLAGS,
  VALIDATE_LABEL_PACKET_KNOWN_FLAGS, VALIDATE_LABEL_PACKET_VALUELESS_FLAGS,
} from './cli-flags.js';

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

/** The eval modules a script delegates to, for the same kind of pin. */
function evalModule(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
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
    // — the text gate's and the arm axis's (#1614 PR2) — and one that
    // published a constant while the other kept the shorthand would pass a
    // bare `toMatch`. #1618 stage 2 removed the third (the paired image
    // axis), so the count came down with it.
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
 * #1115 P5b — the image CORPUS's wiring, for exactly the reason the block
 * above exists: every module it composes has its own tests, and a mutant that
 * leaves each of them correct while composing them in the wrong ORDER passes
 * the whole suite. The orderings below are not stylistic — each one is a state
 * the product itself refuses to be in.
 *
 * **#1618 stage 2 retired the PAIRED image axis.** `--images` measured
 * ADR-025's image-embedding leg off against on, in one process, and every cell
 * about the VL environment, the index probe, the `imageHits` arms and the
 * paired verdict table went with the leg. What is left over the image corpus
 * is the ADR-027 arm axis below, which `--images` now REQUIRES.
 */
describe('run-retrieval-eval.ts image corpus wiring (#1115 P5b)', () => {
  const raw = source('run-retrieval-eval.ts');
  const flat = collapsed('run-retrieval-eval.ts');

  it('selects the axis from the flag and refuses a conflicting --lang', () => {
    expect(flat).toContain('wantsImageAxis(process.argv)');
    expect(flat).toContain('parseImageAxisLanguage(process.argv)');
    // The English gate's own branch must still be reachable, or `--lang de`
    // silently starts resolving through the image axis's rule.
    expect(flat).toContain("langArg && langArg !== 'en' ? langArg : 'en'");
  });

  it('REFUSES a bare --images, before the database is touched', () => {
    // The paired axis is gone, so `--images` alone selects nothing. Falling
    // through to the text gate would seed the ENGLISH corpus and score it
    // against a report the operator reads as the image one — and the refusal
    // has to land beside the flag parsing, before `assertDisposableDatabase`
    // opens a connection and runs the migrations.
    expect(flat).toContain('if (imageAxis && !arm) {');
    expect(flat).toContain('--images needs --arm B or --arm C.');
    const refusal = raw.indexOf('--images needs --arm B or --arm C.');
    expect(refusal).toBeGreaterThan(-1);
    expect(raw.indexOf('assertDisposableDatabase(')).toBeGreaterThan(refusal);
    expect(raw.indexOf('await runMigrations()')).toBeGreaterThan(refusal);
  });

  it('defaults its report to a DIFFERENT file, so it cannot overwrite a text baseline', () => {
    // Both axes defaulted to `retrieval-eval.json`, so an --images run started
    // without --out silently destroyed the text gate's recorded report — the
    // file the runbook tells operators to keep and pass as --baseline. The two
    // are not interchangeable: `assertComparableAxis` refuses the pair outright,
    // so there is no reading under which one path serves both.
    expect(flat).toContain("arg('out') ?? (arm ? `retrieval-eval-arm-${arm}.json` : imageAxis ? 'retrieval-eval-images.json' : 'retrieval-eval.json')");
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

  it('decides one verdict rule, never a second copy of the McNemar branch', () => {
    // The text gate's `compareArm` and the arm axis's `compareArmRetrieval`
    // both report a paired verdict; a second inline McNemar branch is how the
    // two would come to disagree about the same numbers.
    expect(raw.match(/mcnemar-exact/g)).toHaveLength(1);
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

  it('runs the single-arm runner over the seeded page map, under the whole-fixture power floor', () => {
    expect(flat).toContain('await runArmEval(fixture, { arm, userId: EVAL_USER_ID, pageIdByFile: seeded.pageIdByFile,');
    // The whole-fixture power floor applies to the image fixture as well —
    // Recall@K over N moves in 1/N steps whatever the labels carry.
    expect(flat).toContain('const fixture = loadImageFixture(); assertFixturePower(fixture);');
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
    // One call each on the text gate and the arm axis, so neither can quietly
    // go back to writing the language while the constant sits unused beside
    // it. Two before #1618 stage 2, when the paired axis seeded the same
    // corpus a second time.
    expect(raw.match(/recordCorpusLanguage\(language\)/g)).toHaveLength(1);
    expect(raw.match(/recordCorpusLanguage\(IMAGE_AXIS_CORPUS_CLAIM\)/g)).toHaveLength(1);
    expect(raw.indexOf('await recordCorpusLanguage(language)')).toBeLessThan(seed);
  });

  it('marks the report with its axis and refuses a cross-axis baseline FIRST', () => {
    expect(flat).toContain('axis: TEXT_AXIS');
    expect(flat).toContain('axis: ARM_AXIS');
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
});

/**
 * #1614 PR2 — the arm axis's wiring in the same script, and the two new
 * entrypoints. Same argument as both blocks above: `main()` runs at import,
 * so the seams between tested modules are pinned on the source.
 */
describe('run-retrieval-eval.ts arm axis wiring (#1614 PR2)', () => {
  const raw = source('run-retrieval-eval.ts');
  const flat = collapsed('run-retrieval-eval.ts');

  it('parses the arm beside the other flags, before the database is touched', () => {
    expect(flat).toContain('const arm = parseArmFlag(process.argv)');
    const parse = raw.indexOf('parseArmFlag(process.argv)');
    const db = raw.indexOf('assertDisposableDatabase(');
    expect(parse).toBeGreaterThan(-1);
    expect(db).toBeGreaterThan(parse);
    // #1618 stage 2: no arm reads a VL EMBEDDING environment. Arms B and C
    // never had one, arm A is retired, and a variable the script still read
    // would be an endpoint nothing can honour.
    expect(code('run-retrieval-eval.ts')).not.toMatch(/EVAL_IMAGE_EMBEDDING_[A-Z]+\b/);
  });

  it('reads B\u2019s precondition before the seed and asserts each arm state before the queries', () => {
    // "--arm B refuses at once" is only true where the probe runs: the
    // candidate table, the image_analysis assignment and its ceiling are
    // read right after the migrations and BEFORE the 65-page seed (review
    // r1 finding 8 — it used to sit inside `awaitArmBBackfill`).
    const migrate = raw.indexOf('await runMigrations()');
    const precondition = raw.indexOf('await readArmBState()');
    const seed = raw.lastIndexOf('await seedImageCorpus(');
    expect(migrate).toBeGreaterThan(-1);
    expect(precondition).toBeGreaterThan(migrate);
    expect(seed).toBeGreaterThan(precondition);
    // B then DRIVES the product's backfill (#1619), and C asserts the
    // ablation's state on the database — both after the seed, both before
    // the queries.
    const backfill = raw.indexOf('await runArmBBackfill(');
    const cState = raw.indexOf('await assertArmCState()');
    const run = raw.indexOf('await runArmEval(');
    expect(backfill).toBeGreaterThan(seed);
    expect(cState).toBeGreaterThan(seed);
    expect(run).toBeGreaterThan(backfill);
    expect(run).toBeGreaterThan(cState);
  });

  it('counts B\u2019s backfill by D5\u2019s validity predicate and decides it through the tested refusal', () => {
    // Since #1619 the count, the drive and the refusals live in
    // `eval/arm-b-backfill.ts` (the script drives the product's own worker
    // rather than waiting on a human-run one), so the predicate is pinned
    // THERE and the script is pinned to delegating to it exactly once.
    const driver = evalModule('arm-b-backfill.ts');
    // `status = 'analyzed'` alone counts a sweep-invalidated row as "backfill
    // complete" while the product would not compose it (review r1 finding
    // 18): the identity the assignment was read under is part of the count.
    expect(driver).toContain("FROM page_image_analyses WHERE status = 'analyzed' AND identity_hash = $1");
    expect(driver).toContain('[identityHash]');
    // The analyses and the re-embed are the PRODUCT's entrypoints, not copies.
    expect(driver).toContain('await runImageAnalysisBatch()');
    expect(driver).toContain('await processDirtyPages(opts.userId)');
    // The version-straddle refusal is not pinned as source text — a query
    // whose result is ignored passes such a pin. It is
    // `assertSingleAnalysisVersionPair`, unit-tested in `arms.test.ts`,
    // called EXACTLY ONCE, and its return IS the report's version pair.
    expect(driver.split('assertSingleAnalysisVersionPair(').length - 1).toBe(1);
    expect(driver).toContain('versions: assertSingleAnalysisVersionPair(valid),');
    // The report's version pair has exactly ONE writer, and it is that call.
    expect([...raw.matchAll(/imageAnalysisVersions\s*=\s*/g)]).toHaveLength(1);
    expect(flat).toContain('if (arm === \'B\') imageAnalysisVersions = await runArmBBackfill(');
    expect(raw.split('driveArmBBackfill(').length - 1).toBe(1); // exactly one call, in `runArmBBackfill`
    expect(flat).toContain('return backfill.versions;');
  });

  it('records the provenance the ADR refuses a report without, from the run rather than from constants', () => {
    expect(flat).toContain('axis: ARM_AXIS');
    expect(flat).toContain('revisionSha: sha');
    expect(flat).toContain('querySetSha: querySetSha()');
    expect(flat).toContain('rerank: held.rerank');
    expect(flat).toContain('answerModel: held.answerModel');
    expect(flat).toContain('imageEvidenceRecallAt5: imageEvidenceRecallAtK(arm, run.runs, 5)');
    expect(flat).toContain('imageNegativeLeakAt1: imageNegativeLeakAt1(run.runs)');
    expect(flat).toContain("const hardware = process.env.EVAL_HARDWARE?.trim() || null");
    // ADR-027 "Report provenance": the command line, on the file itself.
    expect(flat).toContain('command: commandLine()');
    expect(code('run-retrieval-eval.ts')).not.toMatch(/imageEvidenceRecallAt5:\s*(0|null)\b/);
  });

  it('refuses a cross-axis baseline before parsing it as an arm report, then pairs through the shared comparison', () => {
    const axisGuard = raw.indexOf('assertComparableAxis(json.axis, ARM_AXIS)');
    const parse = raw.indexOf('parseArmRunReport(json, armBaselinePath)');
    expect(axisGuard).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(axisGuard);
    expect(flat).toContain('compareArmRetrieval(baseline, candidate, { seed: 1614 })');
    // No verdict is decided here: the gate needs the judged endpoints.
    expect(code('run-retrieval-eval.ts')).not.toMatch(/decideGate\(/);
  });
});

describe('run-arm-answers.ts wiring (#1614 PR2)', () => {
  const raw = source('run-arm-answers.ts');
  const flat = collapsed('run-arm-answers.ts');
  const body = code('run-arm-answers.ts');

  it('refuses an unknown flag and knows every flag it reads', () => {
    expect(flat).toContain('assertKnownFlags(process.argv.slice(2), ARM_ANSWERS_KNOWN_FLAGS, ARM_ANSWERS_USAGE, ARM_ANSWERS_VALUELESS_FLAGS)');
    const inSource = new Set([
      ...[...body.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!),
      ...[...body.matchAll(/\barg\('([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]!),
    ]);
    expect(inSource.size).toBeGreaterThanOrEqual(3);
    expect([...inSource].filter((f) => !(ARM_ANSWERS_KNOWN_FLAGS as readonly string[]).includes(f))).toEqual([]);
    expect([...ARM_ANSWERS_VALUELESS_FLAGS].every((f) => (ARM_ANSWERS_KNOWN_FLAGS as readonly string[]).includes(f))).toBe(true);
  });

  it('guards the database, then writes rag_answer_max_images = 0 and drops its cache before the app is built', () => {
    const guard = raw.indexOf('assertDisposableDatabase(');
    const migrate = raw.indexOf('await runMigrations()');
    const write = raw.indexOf("VALUES ('rag_answer_max_images', '0', NOW())");
    const invalidate = raw.indexOf('invalidateRagAnswerMaxImagesCache()');
    const app = raw.indexOf('await buildApp()');
    expect(guard).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(guard);
    expect(write).toBeGreaterThan(migrate);
    expect(invalidate).toBeGreaterThan(write);
    expect(app).toBeGreaterThan(invalidate);
    // …and refuses to ask a single question if the read-back is not 0.
    expect(flat).toContain('if (held.retrieval.rag_answer_max_images !== 0)');
  });

  it('asks through the real route with a signed token and records the provenance from what was written', () => {
    expect(flat).toContain('generateArmAnswers(askThroughRoute(app, token), fixture, {');
    expect(flat).toContain("generateAccessToken({ sub: EVAL_USER_ID, username: 'eval-runner', role: 'admin' })");
    expect(flat).toContain('answersSha256: written.answersSha256');
    expect(flat).toContain('mappingSha256: written.mappingSha256');
    expect(flat).toContain("temperature: 'provider default'");
    expect(flat).toContain('deepSearch: false');
    // The chat model is never mocked here: no vi, no stub, no fake ask.
    expect(body).not.toMatch(/\b(mock|stub|fake)\b/i);
  });
});

describe('judge-arms.ts wiring (#1614 PR2)', () => {
  const raw = source('judge-arms.ts');
  const flat = collapsed('judge-arms.ts');
  const body = code('judge-arms.ts');

  it('refuses an unknown flag and knows every flag and every switch it reads', () => {
    expect(flat).toContain('assertKnownFlags(process.argv.slice(2), JUDGE_KNOWN_FLAGS, JUDGE_USAGE, JUDGE_VALUELESS_FLAGS)');
    const inSource = new Set([
      ...[...body.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!),
      ...[...body.matchAll(/\b(?:arg|list)\('([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]!),
    ]);
    expect(inSource.size).toBeGreaterThanOrEqual(8);
    expect([...inSource].filter((f) => !(JUDGE_KNOWN_FLAGS as readonly string[]).includes(f))).toEqual([]);
    const switches = [...body.matchAll(/process\.argv\.includes\(`--\$\{m\}`\)|process\.argv\.includes\('--([a-z][a-z0-9-]*)'\)/g)]
      .map((m) => m[1]).filter((f): f is string => f !== undefined);
    expect([...new Set(switches)].filter((f) => !(JUDGE_VALUELESS_FLAGS as readonly string[]).includes(f))).toEqual([]);
    expect([...JUDGE_VALUELESS_FLAGS].every((f) => (JUDGE_KNOWN_FLAGS as readonly string[]).includes(f))).toBe(true);
  });

  it('un-blinds only through buildArmVerdict, which refuses an incomplete sheet, and joins the mapping nowhere but the pilot', () => {
    expect(flat).toContain('buildArmVerdict({');
    expect(body).not.toMatch(/\bunblind\(/);
    // `--check --mapping` is the ONE place this script reads a mapping, and
    // it hands it straight to `pilotCheck`, which returns one aggregate ψ
    // and nothing per item (review r1 finding 3). The un-blind branch still
    // joins nothing itself: `buildArmVerdict` reads the mapping from the
    // artifacts directory.
    expect([...body.matchAll(/readMapping\(/g)]).toHaveLength(1);
    expect(flat).toContain("pilotCheck(answers, judgments, readMapping(mappingFile), loadImageFixture(), { baseline: 'C', candidate: 'B' })");
    // The verdict is written before it is printed, and anything but a pass
    // sets the exit code — the gate's answer is the process's answer.
    const write = raw.indexOf('writeFileSync(out,');
    const print = raw.indexOf('formatArmVerdict(report)');
    expect(write).toBeGreaterThan(-1);
    expect(print).toBeGreaterThan(write);
    expect(flat).toContain("if (report.decision.verdict !== 'pass') process.exitCode = 1");
    // …and a pilot stop is its own exit code, never the gate's 1.
    expect(flat).toContain('process.exitCode = PILOT_STOP_EXIT_CODE');
  });

  it('holds the judge\u2019s file to the merge in BOTH branches, and says in --check what --unblind will do', () => {
    // Review r2 finding 1: the sheet recorded the judge's file's sha256 and
    // nothing read it back. `--unblind` checks it inside `buildArmVerdict`
    // (`judgments.test.ts` proves the refusal); `--check` checks it too when
    // the operator's sheet is in --out-dir, so a rewritten row surfaces while
    // judging is still under way.
    // Review r3 finding 2: it must hash the file it was HANDED as --answers,
    // not the out-dir copy of that name, or the line it prints vouches for a
    // file whose judgments it never read.
    expect(flat).toContain('assertSheetIntegrity(sheetDir, sheetRunId, readSheet(sheetDir, sheetRunId), answersFile)');
    expect(flat).toContain('console.log(`sheet integrity: ${answersFile} still hashes to sheet-${sheetRunId}.json');
    expect(raw.indexOf('assertSheetIntegrity(')).toBeLessThan(raw.indexOf('const mappingFile = arg(\'mapping\')'));
    // Review r2 finding 10: the summary line reported only the missing count,
    // so a sheet with a duplicate and an unknown judgment said "0 items still
    // unjudged" two lines under the problems that refuse it.
    expect(body).not.toMatch(/items still unjudged`\)/);
    expect(flat).toContain('`--unblind will REFUSE this sheet: ${blockers.join(\'; \')}`');
    expect(flat).toContain('...(progress.duplicates.length > 0 ? [`${progress.duplicates.length} items judged more than once`] : [])');
  });

  it('touches no database', () => {
    expect(body).not.toMatch(/postgres\.js|runMigrations|closePool/);
  });
});

/**
 * #1619 — the O15 packet's two entrypoints. Same argument as every block
 * above (`main()` runs at import, so the seams are pinned on the source), and
 * one more that is specific to these two: the packet must never arrive with a
 * decision in it, and the validator must never write one the file did not
 * contain. Both are properties of these scripts' control flow.
 */
describe('build-label-packet.ts wiring (#1619)', () => {
  const raw = source('build-label-packet.ts');
  const flat = collapsed('build-label-packet.ts');
  const body = code('build-label-packet.ts');

  it('refuses an unknown flag and knows every flag it reads', () => {
    expect(flat).toContain('assertKnownFlags(process.argv.slice(2), LABEL_PACKET_KNOWN_FLAGS, LABEL_PACKET_USAGE, LABEL_PACKET_VALUELESS_FLAGS)');
    // Read sites only, not every `--x` in the source: this script's last line
    // prints the validator's command, and those are that script's flags.
    const read = [...body.matchAll(/\bflagValue\(process\.argv, '([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]!);
    expect(read.filter((f) => !(LABEL_PACKET_KNOWN_FLAGS as readonly string[]).includes(f))).toEqual([]);
    expect(read).toContain('out-dir');
  });

  it('hands off with a command line the validator would actually accept', () => {
    // The packet's last word to the owner is the next command. A renamed
    // validator flag must not leave that sentence quietly wrong.
    const handoff = raw.slice(raw.indexOf('validate-label-packet.ts --file'));
    const named = [...handoff.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((f) => !(VALIDATE_LABEL_PACKET_KNOWN_FLAGS as readonly string[]).includes(f))).toEqual([]);
  });

  it('refuses to write a packet that carries a decision, before any file exists', () => {
    const guard = raw.indexOf('packet row(s) carry a decision');
    const write = raw.indexOf('writeFileSync(files.csv');
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
    // The three files the runbook names, all from the one packet.
    expect(flat).toContain('writeFileSync(files.csv, packetCsv(rows))');
    expect(flat).toContain('writeFileSync(files.jsonl, packetJsonl(rows))');
    expect(flat).toContain('writeFileSync(files.readme, packetReadme(rows, fixture, files))');
  });

  it('touches no database and no model', () => {
    expect(body).not.toMatch(/postgres\.js|runMigrations|closePool|buildApp/);
    expect(body).not.toMatch(/fetch\(|openai|ollama/i);
  });
});

describe('validate-label-packet.ts wiring (#1619)', () => {
  const raw = source('validate-label-packet.ts');
  const flat = collapsed('validate-label-packet.ts');
  const body = code('validate-label-packet.ts');

  it('refuses an unknown flag, and --write is a switch', () => {
    expect(flat).toContain('assertKnownFlags( process.argv.slice(2), VALIDATE_LABEL_PACKET_KNOWN_FLAGS, VALIDATE_LABEL_PACKET_USAGE, VALIDATE_LABEL_PACKET_VALUELESS_FLAGS, )');
    const inSource = new Set([
      ...[...body.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!),
      ...[...body.matchAll(/\bflagValue\(process\.argv, '([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]!),
    ]);
    expect([...inSource].filter((f) => !(VALIDATE_LABEL_PACKET_KNOWN_FLAGS as readonly string[]).includes(f))).toEqual([]);
    const switches = [...body.matchAll(/process\.argv\.includes\('--([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]!);
    expect(switches.filter((f) => !(VALIDATE_LABEL_PACKET_VALUELESS_FLAGS as readonly string[]).includes(f))).toEqual([]);
  });

  it('returns before writing when the file is refused, and writes only the decisions it parsed', () => {
    const refuse = raw.indexOf('if (problems.length > 0) {');
    const apply = raw.indexOf('applyDecisions(raw, parsed.decisions)');
    const write = raw.indexOf('writeFileSync(fixturePath, serializeFixture(updated))');
    expect(refuse).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(refuse);
    expect(write).toBeGreaterThan(apply);
    // The refusal branch leaves before anything is written, and says so.
    expect(flat).toContain('console.error(\'\\nNothing was written. Fix these and run it again.\'); process.exitCode = 1; return;');
    // The write goes through the RAW json, never a schema round trip that
    // would drop a field the schema does not name.
    expect(flat).toContain('const raw = JSON.parse(readFileSync(fixturePath, \'utf8\')) as unknown;');
    // …and only under --write: a bare run reports and changes nothing.
    expect(flat).toContain('if (write) { writeFileSync(fixturePath, serializeFixture(updated));');
  });

  it('decides nothing itself: the verdict printed is auditSample\u2019s, and it sets the exit code', () => {
    expect(flat).toContain('const audit = auditSample(parseWrittenFixture(updated), []);');
    expect(flat).toContain('console.log(`\\nauditSample: ${audit.powerMode}`)');
    expect(flat).toContain("if (audit.powerMode === 'undecidable' || validation.shortfalls.length > 0) process.exitCode = 1;");
  });

  it('touches no database and no model', () => {
    expect(body).not.toMatch(/postgres\.js|runMigrations|closePool|buildApp/);
    expect(body).not.toMatch(/fetch\(|openai|ollama/i);
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
