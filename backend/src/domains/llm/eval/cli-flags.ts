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
  'no-assemble', 'no-pin', 'mmr', 'mmr-lambda', 'help',
] as const;

/**
 * The subset of `EVAL_KNOWN_FLAGS` the script reads with
 * `process.argv.includes('--flag')`. Nothing reads a value from these, so
 * `--rerank=true` must be refused rather than accepted-and-dropped —
 * `cli-flags.test.ts` ties this list back to `EVAL_KNOWN_FLAGS`.
 */
export const EVAL_VALUELESS_FLAGS = [
  'rerank', 'deep-search', 'no-assemble', 'no-pin', 'mmr', 'help',
] as const;

/**
 * The flag reference, printed by `--help` and quoted into the unknown-flag
 * refusal — the same contract `BENCHMARK_USAGE` is held to, so a flag added
 * without a line here is a flag only the source explains.
 */
export const EVAL_USAGE = [
  'scripts/run-retrieval-eval.ts — seed the eval corpus, run the fixture, score it (#1102)',
  '',
  '  --out <file>          report path (default: retrieval-eval.json)',
  '  --baseline <file>     compare against an earlier report. Refuses a pair that differs in',
  '                        model, corpus, language, FTS configuration or rerank.',
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
  '  --help                this text',
  '',
  'A value flag takes either spelling — "--out report.json" or "--out=report.json" — and is refused',
  'if given without a value. The switches (--rerank, --deep-search, --no-assemble, --no-pin, --mmr)',
  'take none and refuse one: they are read as bare flags, so "--rerank=true" would be ignored.',
  '',
  'Environment: EVAL_EMBEDDING_BASE_URL and EVAL_EMBEDDING_MODEL (the eval never mocks the',
  'embedder), and POSTGRES_URL — a database this script may TRUNCATE and RETYPE.',
].join('\n');
