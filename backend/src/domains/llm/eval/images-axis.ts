/**
 * #1115 P5b — what `--images` selects, and everything it refuses.
 *
 * The image axis is a SEPARATE measurement, exactly as `--lang de` is: its own
 * corpus (`corpus-de-images/`), its own fixture (`fixture-de-images.json`), its
 * own loader and its own report family. Nothing about it is a variant of the
 * English gate, and the refusals here are what keep the two from being
 * mistaken for one another.
 *
 * **#1618 stage 2 retired the PAIRED form of this axis** — leg-off against
 * leg-on, whose "on" arm was ADR-025's `page_image_embeddings` leg. What
 * `--images` selects now is the image CORPUS, and the one measurement over it
 * is an arm run (`--arm B|C`, ADR-027 "Arms and revisions"); `--images` on its
 * own is refused rather than silently producing a text-gate report over a
 * German picture corpus.
 *
 * Each refusal below closes a run that would otherwise COMPLETE and publish a
 * number describing something other than its label:
 *
 * 1. **`--lang` may only say `de`.** The corpus is 65 German Wikipedia
 *    articles; the fixture's own `lang` field carries the 58 English labels
 *    that measure the cross-lingual case, and that mix is a property of the
 *    fixture rather than a flag. `--lang en` used to resolve
 *    `corpusDirsForLanguage('en')` onto the English gate's two directories,
 *    which would have seeded a corpus with no pictures under a report that says
 *    `axis: 'images'`.
 * 2. **A cross-axis `--baseline` is refused.** The existing corpus-sha guard
 *    catches it too, but "the baseline was measured against a different corpus"
 *    sends the reader looking for a corpus edit that never happened — the same
 *    argument `--lang`'s own refusal is written out of.
 * 3. **`--deep-search` is refused on this axis.** Every stage flag is held
 *    constant across arms, which is what makes the difference between them
 *    attributable to the arm; deep search cannot be, because each run calls
 *    `reformulateQuery` for itself.
 */
import { flagValue } from './cli-flags.js';

/** The axis marker a `--images` report carries. */
export const IMAGE_AXIS = 'images';
/**
 * What an ABSENT `axis` means. Every report written before P5b is a text-gate
 * report, so the field is read with `?? TEXT_AXIS` rather than treated as
 * unknown — the same provenance rule `ftsLanguage` and `rerank` already use.
 */
export const TEXT_AXIS = 'text';
/**
 * #1614 PR2 — the ADR-027 arm axis: ONE arm per run on the image corpus,
 * paired across runs by `assertComparableArms` (eval/arms.ts). Its report is
 * `ArmRunReportSchema`, not the paired `images` block, so a `--baseline`
 * from either other axis is refused here before anything else is compared.
 */
export const ARM_AXIS = 'arm';
export type EvalAxis = typeof IMAGE_AXIS | typeof TEXT_AXIS | typeof ARM_AXIS;

/** The image corpus's language. Not a choice: the pages are German Wikipedia. */
export const IMAGE_AXIS_LANGUAGE = 'de';

/**
 * What an `--images` run writes into `admin_settings.eval_corpus_language`.
 *
 * DELIBERATELY not `de` (review r1). That row exists so #1114's latency
 * benchmark can refuse `--lang de` against a database seeded with a different
 * corpus, and the image corpus is a different corpus: 65 German Wikipedia
 * articles, not the ~200-page German text corpus `fixture-de.json`'s questions
 * are written against. Writing plain `de` made the two indistinguishable and
 * turned that refusal off for exactly the state it was added to catch — the
 * benchmark would time German text questions against the image corpus and
 * publish the result as a `de` measurement.
 *
 * It is not a `--lang` value either, and `checkCorpusLanguage` names it as such
 * rather than offering it as the remedy: `corpusDirsForLanguage` throws on any
 * language whose directory resolves onto `corpus-de-images/`.
 */
export const IMAGE_AXIS_CORPUS_CLAIM = 'de-images';

/** The fixture beside that corpus, loaded by `loadImageFixture`. */
export const IMAGE_AXIS_FIXTURE_FILE = 'fixture-de-images.json';

/** Read as a bare switch, which is why `--images=true` must be refused. */
export function wantsImageAxis(argv: readonly string[]): boolean {
  return argv.includes('--images');
}

/**
 * `de`, or a refusal naming what was asked for.
 *
 * The flag is admitted at all — rather than refused outright whenever
 * `--images` is present — because `--images --lang de` is an operator stating
 * the thing that is true, and refusing a correct statement teaches nothing. It
 * is any OTHER value that has no meaning here.
 */
export function parseImageAxisLanguage(argv: readonly string[]): string {
  const raw = flagValue(argv, 'lang');
  if (raw === undefined || raw === IMAGE_AXIS_LANGUAGE) return IMAGE_AXIS_LANGUAGE;
  throw new Error(
    `--images implies --lang ${IMAGE_AXIS_LANGUAGE}, but --lang ${raw} was given. The image corpus is ` +
      '65 German Wikipedia articles and it is the only corpus this axis seeds; the fixture carries its ' +
      "own per-label `lang`, which is where the cross-lingual English slice lives. Drop --lang, or spell " +
      `it "${IMAGE_AXIS_LANGUAGE}".`,
  );
}

/**
 * Refuse `--deep-search` on this axis.
 *
 * Every stage flag is held constant across arms (ADR-027 "Held fixed"), which
 * is what makes the difference between two arm reports attributable to the arm.
 * Deep search cannot be held constant: it asks the chat model for two
 * paraphrases per REQUEST (`multi-query-search.ts` → `reformulateQuery`),
 * uncached and unseeded, so two arm runs of the same query are asked different
 * questions while the reports claim the opposite. Refused before the
 * environment is read, before a connection is opened and long before anything
 * is embedded.
 */
export function assertImageAxisStagesPairable(argv: readonly string[]): void {
  if (!argv.includes('--deep-search')) return;
  throw new Error(
    '--images and --deep-search cannot be measured together. Deep search asks the chat model for two ' +
      'paraphrases per REQUEST (multi-query-search.ts → reformulateQuery), uncached and unseeded, so two ' +
      'arm runs over the same query would be paraphrased separately — their fused legs would then differ ' +
      'for a reason that is not the arm, while the reports claim every stage flag was held fixed. Drop ' +
      '--deep-search.',
  );
}

/**
 * Refuse a `--baseline` from the other axis.
 *
 * Checked BEFORE the corpus sha, for the reason the language check is: a
 * cross-axis pair fails that check too (the manifests differ), but "measured
 * against a different corpus" is a confusing way to be told you compared an
 * image run against the English text gate.
 */
export function assertComparableAxis(baselineAxis: string | undefined, runAxis: EvalAxis): void {
  const baseline = baselineAxis ?? TEXT_AXIS;
  if (baseline === runAxis) return;
  throw new Error(
    `Baseline measured the "${baseline}" axis, this run measured "${runAxis}" — these are separate ` +
      'measurements over different corpora with different fixtures and different metrics, not a ' +
      `before/after. Compare a text run against a text run, and an ${ARM_AXIS} run against another ` +
      'arm\'s run of the same corpus, query set, embedder and answer model.',
  );
}
