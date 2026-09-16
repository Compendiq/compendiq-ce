/**
 * The eval rig's shared command-line surface (#1114 review r2).
 *
 * `benchmark-query-latency.ts` refused an unrecognised flag; the retrieval
 * eval — the script whose mislabelled output is this issue's whole subject —
 * ignored one. So `--fts-langauge german` parsed cleanly and ran the full hour
 * of embedding under `simple`. The run stayed self-describing (it prints the
 * configuration and records it in the report), so nothing was published under
 * the wrong label — but an hour is an expensive way to learn about a typo, and
 * the two entrypoints disagreeing about whether an unknown flag is an error is
 * the kind of drift a shared refusal exists to stop, exactly as
 * `assertDisposableDatabase` does for the destructive-database guard.
 */

/** Both spellings, so `-h` does not run a full eval. */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * Read one flag's value out of an argv, in either spelling.
 *
 * Shared by both entrypoints (#1114 review r3), because they disagreed and the
 * disagreement was invisible. `assertKnownFlags` admits `--out=/tmp/x.json` —
 * it checks the name half — while `run-retrieval-eval.ts` read its values with
 * `process.argv.indexOf('--out')`, which cannot see that token at all. So
 * `--baseline=prev.json` passed the guard added to stop silent typos and was
 * then silently ignored: a full seed-and-score that prints no comparison.
 *
 * A flag present with **no** value is refused rather than answered as
 * "unset". Two callers used to reach for `||` and paper over it — an empty
 * `--base-url` fell back to the environment and an empty `--out` to the
 * default path, which are exactly the two flags that decide where a run points
 * and where its report lands. `--out --rerank` is the same mistake as `--out=`
 * and gets the same answer, and never reads the following flag as a value.
 */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  const index = argv.indexOf(`--${name}`);
  if (inline === undefined && index === -1) return undefined;

  const raw = inline !== undefined
    ? inline.slice(`--${name}=`.length)
    : argv[index + 1];
  if (raw === undefined || raw === '' || raw.startsWith('--')) {
    throw new Error(`--${name} needs a value, spelled "--${name} <value>" or "--${name}=<value>".`);
  }
  return raw;
}

/**
 * Refuse any `--flag` outside `known`, quoting the caller's usage text.
 *
 * Only tokens beginning with `--` are candidates: an argv carries values too
 * (`--out /tmp/report.json`), and reading a path as a flag would refuse every
 * correct invocation. `--flag=value` is checked on its name half. The
 * single-dash form is left alone — `-h` is the only one defined and
 * `wantsHelp` reads it before this runs.
 *
 * `valueless` names the switches: flags read with `argv.includes('--rerank')`,
 * which no `=` spelling can ever satisfy. Admitting `--flag=value` for the
 * value flags obliges refusing it for these, or `--rerank=true` measures plain
 * retrieval under a report that says reranked — the silent-ignore failure this
 * guard exists to end, one flag class over (review r3).
 */
export function assertKnownFlags(
  argv: readonly string[],
  known: readonly string[],
  usage: string,
  valueless: readonly string[] = [],
): void {
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2).split('=')[0]!;
    if (!known.includes(name)) {
      throw new Error(`Unknown flag "--${name}".\n\n${usage}`);
    }
    if (arg.includes('=') && valueless.includes(name)) {
      throw new Error(
        `--${name} takes no value: it is a switch, read as a bare flag, so "${arg}" would be ignored. `
        + `Pass "--${name}" on its own, or leave it off.\n\n${usage}`,
      );
    }
  }
}

/**
 * Every flag `scripts/run-retrieval-eval.ts` reads. `script-wiring.test.ts`
 * scans that script's source for `--flag` literals and `arg('flag')` calls and
 * fails on anything missing here, so the list cannot drift away from the
 * parsing it guards.
 */
export const EVAL_KNOWN_FLAGS = [
  'out', 'baseline', 'lang', 'fts-language', 'rerank', 'deep-search',
  'no-assemble', 'no-pin', 'mmr', 'mmr-lambda', 'images', 'arm', 'control',
  'backfill-timeout', 'help',
] as const;

/**
 * The subset of `EVAL_KNOWN_FLAGS` the script reads with
 * `process.argv.includes('--flag')`. Nothing reads a value from these, so
 * `--rerank=true` must be refused rather than accepted-and-dropped.
 *
 * Tied down in both directions, because one direction was not enough (review
 * r4): `cli-flags.test.ts` asserts this list is a subset of `EVAL_KNOWN_FLAGS`,
 * and `script-wiring.test.ts` scans the script for `process.argv.includes`
 * literals and fails on any that is missing here. Without the second, dropping
 * a switch from this list re-opened the silent `--rerank=true` drop with the
 * whole suite green.
 */
export const EVAL_VALUELESS_FLAGS = [
  'rerank', 'deep-search', 'no-assemble', 'no-pin', 'mmr', 'images', 'help',
] as const;

/**
 * The flag reference, printed by `--help` and quoted into the unknown-flag
 * refusal — the same contract `BENCHMARK_USAGE` is held to, so a flag added
 * without a line here is a flag only the source explains.
 */
export const EVAL_USAGE = [
  'scripts/run-retrieval-eval.ts — seed the eval corpus, run the fixture, score it (#1102)',
  '',
  '  --out <file>          report path (default: retrieval-eval.json, or retrieval-eval-images.json',
  '                        with --images — the two axes are not comparable, so they never share a file)',
  '  --baseline <file>     compare against an earlier report. Refuses a pair that differs in',
  '                        model, corpus, language, FTS configuration or rerank — and, on the',
  '                        image axis, in the VL model, its width or its endpoint.',
  '  --lang en|de          which corpus AND fixture to measure (default: en)',
  '  --fts-language <cfg>  the PostgreSQL text-search configuration BOTH legs of the lexical',
  '                        half run under (default: simple, for EVERY language — every recorded',
  '                        baseline was measured under it, so it is never derived from --lang)',
  '  --rerank              run the #1104 rerank stage (needs a rerank assignment in this DB)',
  '  --deep-search         run every query through #1112 multi-query expansion',
  '  --no-assemble         turn #1106 sibling assembly off (default: on)',
  '  --no-pin              turn #1107 identifier pinning off (default: on)',
  '  --mmr                 turn #1109 MMR diversification on (default: off)',
  '  --mmr-lambda <n>      MMR relevance/diversity trade-off (default: 0.5)',
  '  --images              #1115 P5b: measure the IMAGE axis instead of the text gate — seed the',
  '                        German image corpus through the real intake and run every fixture query',
  '                        twice, image leg off then on, paired. Writes retrieval-eval-images.json',
  '                        unless --out says otherwise, so it cannot overwrite a text-gate baseline.',
  '                        Implies --lang de and refuses any',
  '                        other; --fts-language still applies to the lexical leg. Needs the VL',
  '                        endpoint (see Environment). A --baseline from the other axis is refused.',
  '                        Refuses --deep-search: it reformulates per request, so the two arms would',
  '                        be paraphrased separately and the difference would be read as the leg\'s.',
  '  --arm A|B|C           #1614 PR2 / ADR-027: run ONE arm of the pre-registered comparison on the',
  '                        image corpus (needs --images). A = legacy text + image leg (needs the',
  '                        EVAL_IMAGE_EMBEDDING_* endpoint); B = candidate with derived chunks (needs',
  '                        the post-#1617 revision, image_analysis assigned, image_analysis_max_output_tokens',
  '                        set and the backfill run on this database — see --backfill-timeout; refused',
  '                        right after the migrations, before any seed, when any of these is absent);',
  '                        C = ablation, authored text only (refuses EVAL_IMAGE_EMBEDDING_*, asserts',
  '                        page_image_embeddings empty, image_analysis unassigned and no derived rows).',
  '                        Writes retrieval-eval-arm-<A|B|C>.json unless --out says otherwise. A',
  '                        --baseline must be another arm\'s report of the same corpus, query set,',
  '                        embedder, FTS configuration, rerank, answer model and every retrieval knob;',
  '                        it is compared with the page-cluster bootstrap and McNemar exact per ADR-027.',
  '                        The report records `git rev-parse HEAD` of a CLEAN tree and the command line.',
  '  --control legacy-revision-C',
  '                        label an --arm C run made on the LEGACY revision as the regression control',
  '                        ADR-027 names; such a report is never accepted as arm C of a pair — the one',
  '                        comparison it is read in is --baseline against the candidate C, descriptive only.',
  '  --backfill-timeout <sec>',
  '                        --arm B only: how long to wait for the vision-analysis backfill (the product',
  '                        worker, run against this database) to analyse every corpus image before',
  '                        querying (default 0: refuse unless already complete).',
  '  --help                this text',
  '',
  'A value flag takes either spelling — "--out report.json" or "--out=report.json" — and is refused',
  'if given without a value. The switches (--rerank, --deep-search, --no-assemble, --no-pin, --mmr,',
  '--images) take none and refuse one: they are read as bare flags, so "--rerank=true" would be',
  'ignored.',
  '',
  'Environment: EVAL_EMBEDDING_BASE_URL and EVAL_EMBEDDING_MODEL (the eval never mocks the',
  'embedder), and POSTGRES_URL — a database this script may TRUNCATE and RETYPE. With --arm:',
  'EVAL_HARDWARE (O9 provenance; --unblind refuses a report without it) and, ONLY for a tree without',
  'git history, EVAL_REVISION_SHA — where git answers, HEAD is recorded, the tree must be clean and the',
  'variable must agree with HEAD.',
  '',
  'With --images, additionally: EVAL_IMAGE_EMBEDDING_BASE_URL and EVAL_IMAGE_EMBEDDING_MODEL (the',
  'vision-language endpoint — required, and deliberately NOT the text pair, which speaks a different',
  'request shape into a different vector space), optional EVAL_IMAGE_EMBEDDING_DIMENSIONS (MRL',
  'truncation width; unset = the model\'s native width) and optional EVAL_IMAGE_EMBEDDING_BACKEND (a',
  'free-text provenance label recorded in the report, e.g. llama | mlx | vllm).',
].join('\n');

/**
 * #1614 PR2 — `scripts/run-arm-answers.ts`: one arm's answers through the real
 * ask route, arm-blinded. `script-wiring.test.ts` holds it to this list the
 * way it holds the eval script to `EVAL_KNOWN_FLAGS`.
 */
export const ARM_ANSWERS_KNOWN_FLAGS = ['arm', 'run-id', 'out-dir', 'report', 'help'] as const;
export const ARM_ANSWERS_VALUELESS_FLAGS = ['help'] as const;
export const ARM_ANSWERS_USAGE = [
  'scripts/run-arm-answers.ts — ask every image-fixture question through POST /api/llm/ask on ONE arm',
  'and write the arm-blinded judging artifacts (#1614 PR2, ADR-027 "Judging protocol")',
  '',
  '  --arm A|B|C           which arm this database is in. Recorded in the MAPPING only — the answers',
  '                        file never carries it.',
  '  --run-id <id>         names the artifacts: answers-<id>.jsonl (itemId, question, answer, refused,',
  '                        sources, evidenceImages — NO arm, query id, config or chunk provenance),',
  '                        mapping-<id>.json (itemId → { arm, queryId }) and provenance-<id>.json (the',
  '                        run\'s configuration and both files\' sha256). Default: <arm>-<timestamp>.',
  '  --out-dir <dir>       where to write them (default: the current directory)',
  '  --report <file>       the retrieval report the same arm wrote on this database',
  '                        (run-retrieval-eval.ts --images --arm X --out <file>); its revision, corpus',
  '                        and query-set hashes must match this run or the answers are refused as',
  '                        belonging to a different arm state.',
  '  --help                this text',
  '',
  'The route runs with rag_answer_max_images = 0 (written to admin_settings for the run), deepSearch',
  'false and no conversation, so the answer model is text-only by construction in every arm and the',
  'temperature is the provider default (ADR-027 O10 erratum; recorded in provenance).',
  '',
  'Environment: POSTGRES_URL — the SAME disposable database the arm\'s retrieval run seeded (the guard',
  'from eval/disposable-db.ts applies); REDIS_URL and JWT_SECRET (buildApp needs both); EVAL_HARDWARE',
  '(free text naming the host, GPU and server software, recorded per O9; refused absent at --unblind);',
  'EVAL_REVISION_SHA only for a tree without git history (otherwise HEAD of a clean tree is recorded).',
  'A `semantic_index_unavailable` refusal from the route is an outage, not the protocol\'s refusal: the',
  'run aborts on the first one and writes nothing. Refusal reasons are counted in provenance-<id>.json,',
  'never on a row the judge sees.',
].join('\n');

/**
 * #1614 PR2 — `scripts/judge-arms.ts`: the blinded sheet, the judging
 * progress check, and `--unblind` (which refuses until every item has exactly
 * one judgment and then runs the paired scoring).
 */
export const JUDGE_KNOWN_FLAGS = [
  'merge', 'check', 'unblind', 'answers', 'mappings', 'mapping', 'judgments', 'run-id', 'out-dir',
  'arm-report', 'control-a', 'control-b', 'control-c', 'out', 'allow-underpowered', 'help',
] as const;
export const JUDGE_VALUELESS_FLAGS = ['merge', 'check', 'unblind', 'allow-underpowered', 'help'] as const;
export const JUDGE_USAGE = [
  'scripts/judge-arms.ts — the arm-blinded judgment sheet and the un-blinded paired verdict (#1614 PR2,',
  'ADR-027 "Judging protocol" and "Decision rule")',
  '',
  'Modes (exactly one):',
  '  --merge               shuffle several arms\' answers-*.jsonl into ONE blinded sheet, so the judge',
  '                        cannot tell arms apart by file. --answers a,b,c --mappings ma,mb,mc',
  '                        --run-id <sheet id> [--out-dir]. Each answers-<runId>.jsonl must have its',
  '                        provenance-<runId>.json beside it (run-arm-answers.ts writes all three);',
  '                        the merge refuses a run whose provenance does not hash its files. Writes',
  '                        answers-<id>.jsonl, mapping-<id>.json and sheet-<id>.json (every source\'s',
  '                        and the sheet\'s sha256, recorded BEFORE judging starts).',
  '  --check               report judging progress and refuse malformed rows. --answers <sheet>',
  '                        --judgments <file> [--mapping <mapping-<sheet>.json>]. With --mapping',
  '                        (the operator\'s file) it prints the ADR-027 pilot: ψ over the first 30',
  '                        image-dependent A/B pairs in judgedAt order, ONE aggregate number; below',
  '                        0.20 it says STOP and exits 3 — stop judging, the run is inconclusive by',
  '                        design.',
  '  --unblind             refuse until every item has exactly one judgment by one judge, re-read every',
  '                        answer run\'s provenance-<runId>.json from --out-dir and hold it to its arm',
  '                        report (answer model, hardware, revision, hashes, knobs), then join the',
  '                        mapping, pair the arms and score every endpoint. --run-id <sheet id>',
  '                        [--out-dir] --arm-report A=<file>,B=<file>[,C=<file>]',
  '                        [--control-b en.json,de.json --control-c en.json,de.json',
  '                        [--control-a en.json,de.json]] --out <verdict.json>.',
  '',
  '  --answers <files>     comma-separated answers-*.jsonl (merge) or one sheet (check)',
  '  --mappings <files>    comma-separated mapping-*.json, in the same order as --answers (merge)',
  '  --mapping <file>      the sheet\'s mapping-<id>.json, for the pilot readout (check; optional)',
  '  --judgments <file>    judgments-<id>.jsonl (check; --unblind reads it from --out-dir by run id)',
  '  --run-id <id>         the sheet id (merge writes it; unblind reads it)',
  '  --out-dir <dir>       where the artifacts live (default: the current directory)',
  '  --arm-report <list>   the arm retrieval reports, as A=<file>,B=<file>,C=<file> (unblind)',
  '  --control-a <files>   arm A\'s EN and DE text-gate reports, comma-separated (unblind, optional;',
  '                        the C vs A control — unmeasured, and therefore blocking, without it)',
  '  --control-b <files>   arm B\'s EN and DE text-gate reports, comma-separated (unblind, optional)',
  '  --control-c <files>   arm C\'s EN and DE text-gate reports, comma-separated (unblind, optional)',
  '  --out <file>          where the verdict report is written (unblind)',
  '  --allow-underpowered  score a sample below ADR-027 O2 (190 image-dependent on ≥ 45 pages, ≤ 5',
  '                        per page / 48 image-negative / 197 control queries per language). The',
  '                        verdict is then labelled TOOLING VERIFICATION and decides nothing; without',
  '                        this the run is refused.',
  '  --help                this text',
  '',
  'One judge (the repository owner), blind to arm, one row per item in judgments-<id>.jsonl:',
  '{ itemId, judge, correctness: correct|partial|incorrect|refused, citationFaithful: yes|no|na,',
  'unsupportedClaim, notes, judgedAt }. No second rater, no adjudication, no κ — the report says so.',
].join('\n');
