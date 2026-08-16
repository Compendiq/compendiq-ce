/**
 * #1114 — which PostgreSQL text-search configuration an eval run measured.
 *
 * Hybrid retrieval has two legs and this names the lexical one. `pages.tsv` is
 * built by migration 049's BEFORE INSERT trigger, which reads
 * `admin_settings.fts_language` at insert time, and `keywordSearch` reads the
 * same row per query through `getFtsLanguage()`. Nothing in the eval rig ever
 * wrote that row, so it sat at migration 049's seeded 'simple' for every run
 * ever made — including every `--lang de` run, whose German numbers therefore
 * describe a German corpus indexed with a language-neutral stemmer.
 *
 * Two rules follow, and both are enforced here rather than in the runbook:
 *
 * 1. **The default stays 'simple' for BOTH languages.** Every recorded
 *    baseline, CI's included, was measured under 'simple'; deriving the
 *    configuration from `--lang` would silently re-measure all of them and
 *    report the difference as a retrieval change. Choosing 'german' is an
 *    explicit act.
 * 2. **A report states its configuration, and a comparison refuses a mismatched
 *    pair.** A forgotten `--fts-language` on one side is exactly the class of
 *    mistake the `--rerank` and `--lang` guards already exist for: a confident
 *    verdict about a flag rather than about the checkout.
 */
import { ALLOWED_FTS_LANGUAGES } from '../../../core/services/fts-language.js';
import { flagValue } from './cli-flags.js';

/**
 * The configuration every recorded baseline was measured under, and therefore
 * the only default that keeps old reports byte-comparable with new ones.
 * Deliberately NOT derived from `--lang` — see rule 1 above.
 */
export const DEFAULT_EVAL_FTS_LANGUAGE = 'simple';

/**
 * Read `--fts-language` out of an argv, validated against the same allow-list
 * the product interpolates into SQL.
 *
 * Validation is not optional politeness: `getFtsLanguage()` answers 'simple'
 * for any value Postgres would not accept, so an unvalidated flag produces a
 * run labelled `klingon` whose lexical leg is plain 'simple'.
 *
 * The READING is `flagValue`'s, not this function's (review r4). It used to
 * hand-roll the two spellings — the same shape, agreeing by coincidence — and
 * "one reader, not two policies" is worth nothing if the rig keeps a second
 * copy: a change to `flagValue` (last-wins on a repeated flag, say) would
 * simply not have reached `--fts-language`. What stays here is the part that
 * is genuinely this flag's own: the allow-list, and a missing-value message
 * naming the configurations and the default, which is more use than the
 * generic "needs a value" the shared reader can offer.
 */
export function parseFtsLanguageArg(argv: readonly string[]): string {
  let raw: string | undefined;
  try {
    // Throws on `--fts-language` with no value, on `--fts-language=` and on
    // `--fts-language --rerank`, which must never read the next flag as a
    // value: that would fail the allow-list below with a confusing message
    // about "--rerank".
    raw = flagValue(argv, 'fts-language');
  } catch {
    throw new Error(
      `--fts-language needs a value, one of: ${[...ALLOWED_FTS_LANGUAGES].join(', ')}. ` +
        `Omit the flag entirely to measure under "${DEFAULT_EVAL_FTS_LANGUAGE}", which is what every ` +
        'recorded baseline used.',
    );
  }
  if (raw === undefined) return DEFAULT_EVAL_FTS_LANGUAGE;

  if (!ALLOWED_FTS_LANGUAGES.has(raw)) {
    throw new Error(
      `Unknown FTS configuration "${raw}". Allowed: ${[...ALLOWED_FTS_LANGUAGES].join(', ')}. ` +
        'An unknown value would silently resolve back to "simple" at query time, and the report ' +
        'would name a configuration the run never used.',
    );
  }
  return raw;
}

/**
 * Refuse a baseline/candidate pair measured under different lexical
 * configurations, in the style of the neighbouring cross-model and
 * cross-language refusals.
 *
 * A baseline that carries no `ftsLanguage` predates this field, and every such
 * report was measured under 'simple' — so absent is read as 'simple' and the
 * message says so, or the refusal reads as a missing-field bug instead of the
 * fact it is.
 */
export function assertComparableFtsLanguage(
  baselineFtsLanguage: string | undefined,
  runFtsLanguage: string,
): void {
  const baseline = baselineFtsLanguage ?? DEFAULT_EVAL_FTS_LANGUAGE;
  if (baseline === runFtsLanguage) return;

  const provenance =
    baselineFtsLanguage === undefined
      ? `The baseline records no ftsLanguage: it predates #1114, and every report written before it was ` +
        `measured under "${DEFAULT_EVAL_FTS_LANGUAGE}", so it is read as that. `
      : '';
  throw new Error(
    `${provenance}Baseline measured FTS configuration "${baseline}", this run measured "${runFtsLanguage}" — ` +
      'the lexical leg of hybrid retrieval is a different index in each, so this comparison would score ' +
      'the text-search configuration rather than the checkout. Measure both sides with the same ' +
      '--fts-language.',
  );
}
