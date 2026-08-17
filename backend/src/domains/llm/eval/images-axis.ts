/**
 * #1115 P5b — what `--images` selects, and everything it refuses.
 *
 * The image axis is a SEPARATE measurement, exactly as `--lang de` is: its own
 * corpus (`corpus-de-images/`), its own fixture (`fixture-de-images.json`), its
 * own schema and loader, and its own report family. Nothing about it is a
 * variant of the English gate, and the refusals here are what keep the two from
 * being mistaken for one another.
 *
 * Three of them, each closing a run that would otherwise COMPLETE and publish a
 * number describing something other than its label:
 *
 * 1. **`--lang` may only say `de`.** The corpus is 65 German Wikipedia
 *    articles; the fixture's own `lang` field carries the 58 English labels
 *    that measure the cross-lingual case, and that mix is a property of the
 *    fixture rather than a flag. `--lang en` used to resolve
 *    `corpusDirsForLanguage('en')` onto the English gate's two directories,
 *    which would have seeded a corpus with no pictures under a report that says
 *    `axis: 'images'`.
 * 2. **The VL endpoint is required, by name.** `EVAL_EMBEDDING_BASE_URL` is
 *    already in the operator's environment and points at the TEXT embedder,
 *    which would answer an image-embedding request — through the wrong shape,
 *    with a plausible vector from a different space (ADR-021's non-inheriting
 *    rule, `llm-provider-resolver.ts`). Defaulting to it is the one thing this
 *    module must never do.
 * 3. **A cross-axis `--baseline` is refused.** The existing corpus-sha guard
 *    catches it too, but "the baseline was measured against a different corpus"
 *    sends the reader looking for a corpus edit that never happened — the same
 *    argument `--lang`'s own refusal is written out of.
 */
import { VECTOR_MAX_DIMS } from '../../../core/db/vector-column-tier.js';
import { flagValue } from './cli-flags.js';

/** The axis marker a `--images` report carries. */
export const IMAGE_AXIS = 'images';
/**
 * What an ABSENT `axis` means. Every report written before P5b is a text-gate
 * report, so the field is read with `?? TEXT_AXIS` rather than treated as
 * unknown — the same provenance rule `ftsLanguage` and `rerank` already use.
 */
export const TEXT_AXIS = 'text';
export type EvalAxis = typeof IMAGE_AXIS | typeof TEXT_AXIS;

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

export interface ImageAxisEnv {
  /** Spelled as a provider row is — the client posts `${baseUrl}/embeddings`. */
  baseUrl: string;
  model: string;
  /** MRL truncation width, written to `admin_settings` for the run; null = native. */
  targetDimensions: number | null;
  /**
   * Free-text provenance label for the report (`llama`, `mlx`, `vllm`), if the
   * operator supplied one. RECORDED, never probed: nothing on the wire says
   * which of the three is behind an OpenAI-compatible endpoint, and a field
   * this rig inferred would be a guess printed as a fact.
   */
  backend?: string;
}

export const IMAGE_AXIS_ENV = {
  baseUrl: 'EVAL_IMAGE_EMBEDDING_BASE_URL',
  model: 'EVAL_IMAGE_EMBEDDING_MODEL',
  dimensions: 'EVAL_IMAGE_EMBEDDING_DIMENSIONS',
  backend: 'EVAL_IMAGE_EMBEDDING_BACKEND',
} as const;

/**
 * The VL endpoint for this run, or a refusal naming both variables.
 *
 * Deliberately its OWN pair of variables rather than a reuse of
 * `EVAL_EMBEDDING_*`: the two models are different spaces and the image one
 * speaks a different request shape, so a run that fell back would fill
 * `page_image_embeddings` with text-space vectors and score them.
 */
export function readImageAxisEnv(env: NodeJS.ProcessEnv = process.env): ImageAxisEnv {
  const baseUrl = env[IMAGE_AXIS_ENV.baseUrl];
  const model = env[IMAGE_AXIS_ENV.model];
  if (!baseUrl || !model) {
    throw new Error(
      `--images needs ${IMAGE_AXIS_ENV.baseUrl} and ${IMAGE_AXIS_ENV.model} — the vision-language ` +
        'endpoint that fills and queries the image index (the shim from ' +
        'docs/runbooks/vl-embedding-dev.md locally, vLLM in production). They are separate from ' +
        `${'EVAL_EMBEDDING_BASE_URL'}/${'EVAL_EMBEDDING_MODEL'} on purpose: the text embedder would ` +
        'answer an image-embedding request with a well-formed vector from a different space, and an ' +
        'index built from those is indistinguishable from bad retrieval. Spell the base URL with its ' +
        '/v1, exactly as a provider row does.',
    );
  }
  const raw = env[IMAGE_AXIS_ENV.dimensions];
  let targetDimensions: number | null = null;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > VECTOR_MAX_DIMS) {
      throw new Error(
        `${IMAGE_AXIS_ENV.dimensions}="${raw}" is not a width pgvector can hold (1..${VECTOR_MAX_DIMS}). ` +
          'It is the MRL truncation this run REQUESTS on every image-side call, so an unusable value ' +
          'cannot be discarded the way a stray admin_settings row is: the run would measure the ' +
          "model's native width under a report naming the truncated one. Unset it for native width.",
      );
    }
    targetDimensions = parsed;
  }
  const backend = env[IMAGE_AXIS_ENV.backend];
  return {
    baseUrl,
    model,
    targetDimensions,
    ...(backend ? { backend } : {}),
  };
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
      `before/after. Compare an ${IMAGE_AXIS} run against another ${IMAGE_AXIS} run (which compares ` +
      'leg-on against leg-on and leg-off against leg-off), and a text run against a text run.',
  );
}
