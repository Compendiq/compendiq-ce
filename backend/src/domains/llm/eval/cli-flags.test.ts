import { describe, expect, it } from 'vitest';
import {
  assertKnownFlags,
  flagValue,
  wantsHelp,
  EVAL_KNOWN_FLAGS,
  EVAL_USAGE,
  EVAL_VALUELESS_FLAGS,
} from './cli-flags.js';

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

  it('refuses a value on a switch, which no reader would ever see', () => {
    // #1114 review r3. `--rerank` is read with `process.argv.includes('--rerank')`,
    // so `--rerank=true` passed the name-half check and then measured the
    // UN-reranked pipeline under a report that says rerank. Admitting the `=`
    // spelling for value flags obliges refusing it for the switches.
    const boom = () => assertKnownFlags(['--gamma=true'], ['alpha', 'gamma'], USAGE, ['gamma']);
    expect(boom).toThrow(/--gamma/);
    expect(boom).toThrow(/takes no value/i);
    expect(() => assertKnownFlags(['--gamma'], ['alpha', 'gamma'], USAGE, ['gamma'])).not.toThrow();
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

describe('flagValue', () => {
  /**
   * #1114 review r3 — the defect this function exists to close.
   *
   * `assertKnownFlags` admits `--out=/tmp/x.json` (it checks the name half),
   * but `run-retrieval-eval.ts` read its values with
   * `process.argv.indexOf('--out')`, which cannot see that spelling. So
   * `--baseline=prev.json` passed the new guard and was then silently
   * dropped: an hour of embedding that reports absolute numbers and prints no
   * comparison at all. One reader, shared by both entrypoints, is the fix.
   */
  it('reads both --flag value and --flag=value', () => {
    expect(flagValue(['--out', '/tmp/x.json'], 'out')).toBe('/tmp/x.json');
    expect(flagValue(['--out=/tmp/x.json'], 'out')).toBe('/tmp/x.json');
  });

  it('keeps an = inside a value, so a URL survives the spelling', () => {
    expect(flagValue(['--base-url=http://h/v1?a=b'], 'base-url')).toBe('http://h/v1?a=b');
  });

  it('answers undefined for a flag that is not there', () => {
    expect(flagValue(['--other', 'x'], 'out')).toBeUndefined();
  });

  it('refuses a flag given with no value instead of defaulting silently', () => {
    // `--out` at the end of an argv, or followed by the next flag, used to
    // read as "unset" and write to the default path — the same silent
    // substitution as the `=` spelling, arriving from the other side.
    expect(() => flagValue(['--out'], 'out')).toThrow(/--out needs a value/);
    expect(() => flagValue(['--out', '--rerank'], 'out')).toThrow(/--out needs a value/);
    expect(() => flagValue(['--out='], 'out')).toThrow(/--out needs a value/);
  });

  it('reads a value that merely looks numeric or negative', () => {
    expect(flagValue(['--mmr-lambda', '0.7'], 'mmr-lambda')).toBe('0.7');
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

  it('refuses the = spelling on the switches, which are read with argv.includes', () => {
    // The eval's booleans are read as `process.argv.includes('--rerank')`, so
    // `--rerank=true` would time plain retrieval and label it reranked.
    for (const flag of EVAL_VALUELESS_FLAGS) {
      const boom = () => assertKnownFlags([`--${flag}=true`], EVAL_KNOWN_FLAGS, EVAL_USAGE, EVAL_VALUELESS_FLAGS);
      expect(boom).toThrow(new RegExp(`--${flag}`));
      expect(boom).toThrow(/takes no value/i);
    }
    expect(() => assertKnownFlags(
      [...EVAL_VALUELESS_FLAGS.filter((f) => f !== 'help')].map((f) => `--${f}`),
      EVAL_KNOWN_FLAGS,
      EVAL_USAGE,
      EVAL_VALUELESS_FLAGS,
    )).not.toThrow();
  });

  it('lists a switch as valueless only if it is a flag at all', () => {
    // Two lists, so one can drift from the other; this is the tie.
    for (const flag of EVAL_VALUELESS_FLAGS) expect(EVAL_KNOWN_FLAGS).toContain(flag);
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
