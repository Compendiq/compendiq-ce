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
 * Refuse any `--flag` outside `known`, quoting the caller's usage text.
 *
 * Only tokens beginning with `--` are candidates: an argv carries values too
 * (`--out /tmp/report.json`), and reading a path as a flag would refuse every
 * correct invocation. `--flag=value` is checked on its name half. The
 * single-dash form is left alone — `-h` is the only one defined and
 * `wantsHelp` reads it before this runs.
 */
export function assertKnownFlags(
  argv: readonly string[],
  known: readonly string[],
  usage: string,
): void {
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2).split('=')[0]!;
    if (!known.includes(name)) {
      throw new Error(`Unknown flag "--${name}".\n\n${usage}`);
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
  'Environment: EVAL_EMBEDDING_BASE_URL and EVAL_EMBEDDING_MODEL (the eval never mocks the',
  'embedder), and POSTGRES_URL — a database this script may TRUNCATE and RETYPE.',
].join('\n');
