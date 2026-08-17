/**
 * #1115 P5b — what `--images` selects, and everything it refuses.
 *
 * The image axis is a SEPARATE measurement, exactly as `--lang de` is: its own
 * corpus (`corpus-de-images/`), its own fixture (`fixture-de-images.json`), its
 * own schema and loader, and its own report family. Nothing about it is a
 * variant of the English gate, and the refusals here are what keep the two from
 * being mistaken for one another.
 *
 * Each of them closes a run that would otherwise COMPLETE and publish a number
 * describing something other than its label:
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
 * 4. **A same-axis `--baseline` measured through a different VL model is
 *    refused too** (review r2). The existing model guard reads `report.model`,
 *    which is the TEXT embedder and identical on both axes, so two runs made
 *    with different checkpoints passed every single check — including the
 *    corpus sha, which is the same committed manifest — and their difference
 *    was printed as `VERDICT: credible improvement` about retrieval logic. The
 *    runbook's own 2B/8B recipe produces exactly that pair.
 * 5. **`--deep-search` is refused on this axis** (review r2). Every other stage
 *    flag is held constant across the two arms, which is what makes the
 *    difference between them attributable to the leg; deep search cannot be,
 *    because each arm calls `reformulateQuery` for itself.
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

/**
 * Refuse the stage flags this axis cannot hold constant across its two arms.
 *
 * `--rerank`, `--mmr`, `--no-assemble` and `--no-pin` all name a stage that
 * runs identically in both arms of a pair: same rows, same vectors, same
 * configuration, so the only difference left is the leg. `--deep-search` looks
 * like one more of those and is not. Each arm calls `multiQuerySearch`, which
 * calls `reformulateQuery` — one chat completion per call, with no cache, no
 * seed and no seam for a precomputed list — so the two arms are paraphrased
 * SEPARATELY and two of each arm's three fused legs then differ for a reason
 * that has nothing to do with the image leg. `mergeMultiQueryResults` sums
 * weighted reciprocal ranks over those legs, so different paraphrases produce a
 * different fused order: a query flips arms because one of them was asked "Wie
 * hoch ist der Turm?" and the other "Höhe des Turms", and the flip is counted as
 * a discordant pair by McNemar and as leg cost by `queryCostMs`.
 *
 * Refused here rather than reported, because the report has no field that could
 * carry "two of these legs were different questions" and the whole axis is
 * written out of the premise that they were not. Making the combination honest
 * needs a seam that hands both arms the SAME paraphrases (a `paraphrases`
 * option on `MultiQuerySearchOptions`, reformulating once per label in
 * `runImageEval`); that is a change to the answer path's own module and it is
 * not part of this axis.
 */
export function assertImageAxisStagesPairable(argv: readonly string[]): void {
  if (!argv.includes('--deep-search')) return;
  throw new Error(
    '--images and --deep-search cannot be measured together. Deep search asks the chat model for two ' +
      'paraphrases per REQUEST (multi-query-search.ts → reformulateQuery), uncached and unseeded, so the ' +
      'leg-off and leg-on arms of every query would be paraphrased separately — two of each arm\'s three ' +
      'fused legs would then differ for a reason that is not the image leg, while the report claims the ' +
      'opposite and McNemar counts the difference as the leg\'s. Drop --deep-search. (Pairing it honestly ' +
      'needs a seam that reformulates once per query and hands both arms the same paraphrases; the image ' +
      'axis does not have one.)',
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

/** The fields of an `images` report block that say WHICH model produced it. */
export interface ImageAxisModelIdentity {
  imageModel: string;
  imageDims: number;
  imageIndexIdentity: string;
  imageEndpointBackend?: string | undefined;
}

/**
 * `imageIndexIdentityFor` is `${providerId}:${model}@${baseUrl}#${dims}`, and
 * the provider id is the one part that is NOT a property of the measurement:
 * `configureImageEmbeddingProvider` deletes and re-inserts the row every run, so
 * a fresh uuid heads the identity every time. Comparing identities whole would
 * refuse every legitimate re-run — a guard that always fires is a guard
 * operators learn to delete — so the endpoint half is compared instead. Split on
 * the FIRST colon: the uuid contains none, while a model id (`qwen3:8b`) can.
 */
function identityEndpoint(identity: string): string {
  const cut = identity.indexOf(':');
  return cut === -1 ? identity : identity.slice(cut + 1);
}

/**
 * Refuse a same-axis `--baseline` that was measured through a different VL
 * model, width or endpoint.
 *
 * The gate's existing model guard compares `report.model` — the TEXT embedder,
 * read from `EVAL_EMBEDDING_MODEL` and identical on both axes — so before this
 * existed a 2B run and an 8B run passed every check the harness makes: same
 * axis, same language, same fts configuration, same committed corpus sha, same
 * text model, same flags. `compareArm` then printed `VERDICT: credible
 * improvement` and could set a non-zero exit code, which is precisely the
 * cross-model comparison the text guard refuses and the runbook promises is
 * refused. The recipe in `docs/runbooks/retrieval-eval.md` produces that pair
 * two code blocks apart, both at 2048 dimensions, so nothing else in either
 * file contradicts it.
 *
 * A missing block on either side is refused too: `assertComparableAxis` has
 * already established that both files claim `axis: "images"`, so a file with no
 * `images` block is truncated or hand-edited, and the arm-by-arm comparison
 * below it would silently fall back to comparing the top-level runs.
 */
export function assertComparableImageModel(
  baseline: ImageAxisModelIdentity | undefined,
  run: ImageAxisModelIdentity | undefined,
): void {
  if (!baseline || !run) {
    throw new Error(
      `An ${IMAGE_AXIS}-axis comparison needs the "images" block on both sides, and ` +
        `${!run ? 'this run' : 'the baseline'} has none. Every --images report carries one, so a file ` +
        'without it was truncated or edited by hand — and compared blind it would fall back to the ' +
        'top-level runs, which are one arm of one axis wearing the shape of another.',
    );
  }
  if (baseline.imageModel !== run.imageModel) {
    throw new Error(
      `Baseline used image model ${baseline.imageModel}, this run used ${run.imageModel} — this axis ` +
        'compares what the image leg ADDS to a fixed pipeline, not one VL checkpoint against another. ' +
        'The text-model guard cannot see this: `model` is the text embedder and is the same on both ' +
        'runs. To compare checkpoints, run each one and read the two reports side by side.',
    );
  }
  if (baseline.imageDims !== run.imageDims) {
    throw new Error(
      `Baseline measured ${baseline.imageDims} image dimensions, this run measured ${run.imageDims} — ` +
        'a truncated and a native width are two different vector spaces at the same checkpoint, so the ' +
        'difference between these reports is the width, not the change you made.',
    );
  }
  if (identityEndpoint(baseline.imageIndexIdentity) !== identityEndpoint(run.imageIndexIdentity)) {
    throw new Error(
      `Baseline built its index as "${identityEndpoint(baseline.imageIndexIdentity)}", this run as ` +
        `"${identityEndpoint(run.imageIndexIdentity)}" — the endpoint and the REQUESTED truncation are ` +
        'both part of the index identity the product itself rebuilds on, because the same checkpoint ' +
        'served from a different URL is the nearest thing to a version change a client can see.',
    );
  }
  if (
    baseline.imageEndpointBackend !== undefined &&
    run.imageEndpointBackend !== undefined &&
    baseline.imageEndpointBackend !== run.imageEndpointBackend
  ) {
    throw new Error(
      `Baseline declared backend "${baseline.imageEndpointBackend}", this run "${run.imageEndpointBackend}" ` +
        '— the same checkpoint through mlx and through llama.cpp is quantised and computed differently, ' +
        'which moves the vector space (ADR-025 D11). Read the two reports side by side instead. (An ' +
        `absent ${IMAGE_AXIS_ENV.backend} on either side is not compared: it is a label, not a probe.)`,
    );
  }
}
