import { describe, expect, it } from 'vitest';
import { assertKnownFlags, wantsHelp, EVAL_KNOWN_FLAGS, EVAL_USAGE } from './cli-flags.js';

/**
 * #1114 review r2 — `run-retrieval-eval.ts` silently ignored an unrecognised
 * flag while `benchmark-query-latency.ts` refused one.
 *
 * `--fts-langauge german` therefore ran the whole hour of embedding under
 * `simple`. The run is self-describing (it prints and records the
 * configuration it used), so nothing was mislabelled — but an hour is an
 * expensive way to learn about a typo, and the two scripts disagreeing about
 * whether an unknown flag is an error is exactly the drift a shared refusal
 * exists to prevent.
 */

describe('assertKnownFlags', () => {
  const USAGE = 'usage: --alpha --beta';

  it('refuses a flag outside the list and quotes the usage', () => {
    const boom = () => assertKnownFlags(['--alfa'], ['alpha', 'beta'], USAGE);
    expect(boom).toThrow(/--alfa/);
    expect(boom).toThrow(/--alpha/);
  });

  it('admits every known flag, in both the value and the = spelling', () => {
    expect(() => assertKnownFlags(['--alpha', 'x', '--beta=2'], ['alpha', 'beta'], USAGE)).not.toThrow();
  });

  it('ignores values, which is what makes a flag list checkable at all', () => {
    // `--out /tmp/a.json`: the path is an argv element too, and a value that
    // is not a flag must never be read as one.
    expect(() => assertKnownFlags(['--alpha', '/tmp/report.json'], ['alpha'], USAGE)).not.toThrow();
  });

  it('leaves the single-dash short form alone — only -h is defined and it is read elsewhere', () => {
    expect(() => assertKnownFlags(['-h'], ['alpha'], USAGE)).not.toThrow();
  });
});

describe('wantsHelp', () => {
  it('reads both spellings, and nothing else', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['--out', 'x.json'])).toBe(false);
  });
});

describe('the retrieval eval CLI surface (#1114)', () => {
  it('refuses the typo that cost an hour of embedding', () => {
    const boom = () => assertKnownFlags(['--fts-langauge', 'german'], EVAL_KNOWN_FLAGS, EVAL_USAGE);
    expect(boom).toThrow(/--fts-langauge/);
    expect(boom).toThrow(/--fts-language/);
  });

  it('admits the flags the script actually reads', () => {
    expect(() => assertKnownFlags(
      ['--out', '/tmp/a.json', '--baseline', '/tmp/b.json', '--lang=de', '--fts-language', 'german',
        '--rerank', '--deep-search', '--no-assemble', '--no-pin', '--mmr', '--mmr-lambda', '0.7'],
      EVAL_KNOWN_FLAGS,
      EVAL_USAGE,
    )).not.toThrow();
  });

  it('documents every flag it knows, with the default that matters most', () => {
    // The same discipline BENCHMARK_USAGE is held to: a flag added without a
    // line here is a flag only the source explains.
    for (const flag of EVAL_KNOWN_FLAGS) expect(EVAL_USAGE).toContain(`--${flag}`);
    // The one default a reader must not have to infer — deriving it from
    // --lang would silently re-measure every recorded baseline.
    expect(EVAL_USAGE).toMatch(/default: simple/);
  });
});
