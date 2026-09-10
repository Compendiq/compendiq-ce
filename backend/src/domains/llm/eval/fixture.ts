/**
 * #1102 — the fixture: `query → expected page(s)`, and the corpus it refers to.
 *
 * Two invariants this module exists to enforce, both of which fail silently
 * otherwise:
 *
 * 1. **Every expected file must exist in the corpus.** A labeller that
 *    hallucinates or mistypes a filename produces a query that can never be
 *    satisfied, which reads as a permanent retrieval failure and drags the
 *    score down for reasons that have nothing to do with retrieval.
 * 2. **The fixture is keyed by corpus FILENAME, resolved to page id at seed
 *    time.** Page ids are assigned by the database and differ between runs;
 *    filenames are stable. `#1106`'s page-merge changes page identity, and
 *    resolving late is what lets the fixture survive it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import { IMAGE_CORPUS_DIR, loadImageCorpusManifest } from './corpus-images.js';

export const CORPUS_DIR = join(import.meta.dirname, 'corpus');

export const FixtureLabelSchema = z.object({
  /** Stable identity for pairing baseline against candidate runs. */
  id: z.string().min(1),
  query: z.string().min(3),
  /** Corpus filenames, best first. */
  expectedFiles: z.array(z.string().min(1)).min(1),
  /**
   * `vocabulary-gap` (#1112) is the odd one out and deliberately so. Every
   * other style was written by an agent reading the page, so the query reuses
   * the page's own words — measured over the shipped fixture, a non-gap label
   * shares about half its content words with the target's title and opening.
   * A gap label asks for the same page in words the page never uses, which is
   * the only way a query-expansion step has anything to bridge.
   */
  style: z.enum(['question', 'keywords', 'error-text', 'how-to', 'identifier', 'identifier-negative', 'diversity', 'diversity-negative', 'ranking-prior', 'ranking-prior-negative', 'vocabulary-gap']),
  rationale: z.string().default(''),
});

export const FixtureSchema = z.object({
  /**
   * Which corpus the labels were written against. The eval runner refuses a
   * mismatch: re-vendoring the corpus without re-labelling would leave the
   * fixture pointing at text that no longer says what the labeller read.
   */
  corpusManifestSha: z.string().min(1),
  labeledBy: z.string().min(1),
  labels: z.array(FixtureLabelSchema),
});

export type FixtureLabel = z.infer<typeof FixtureLabelSchema>;
export type Fixture = z.infer<typeof FixtureSchema>;

export interface CorpusPage {
  file: string;
  title: string;
  markdown: string;
  source: string;
  qualityScore?: number;
  ageDays?: number;
}

interface ManifestEntry {
  file: string;
  title: string;
  source: string;
  /**
   * #1111 — optional ranking-signal fixtures. The vendored corpus carries
   * neither: every page seeded with NULL quality_score and NULL
   * last_modified_at, so a quality/recency prior was a measurable no-op and
   * the fixture could not have told a working blend from a dead one.
   *
   * `qualityScore` is deliberately absent on some pages rather than zero:
   * unscored is its own case, and the owner's ruling is that it must be
   * NEUTRAL (an unscored page ranks as it does today). Unscored correlates
   * with recently-synced, not with bad, so a naive blend would demote the
   * freshest content in the space.
   */
  qualityScore?: number;
  /** Days before the seed run; drives last_modified_at. */
  ageDays?: number;
}

/**
 * The hand-authored duplicative corpus (#1109). It is a SEPARATE directory
 * with its own manifest because `scripts/vendor-eval-corpus.ts` rebuilds
 * `corpus/MANIFEST.json` from scratch on every `--update` — anything added
 * there by hand would be deleted without a word. See its README for what the
 * pages are for and, more importantly, what they do not prove.
 */
export const SYNTHETIC_CORPUS_DIR = join(import.meta.dirname, 'corpus-synthetic');

/** Both corpus directories, in the order pages are seeded. */
export const CORPUS_DIRS = [CORPUS_DIR, SYNTHETIC_CORPUS_DIR] as const;

/**
 * Translated corpora (#1114), produced by `scripts/translate-eval-corpus.ts`.
 *
 * A translated run is a SEPARATE measurement, never a variant of the English
 * one. It gets its own directory and its own fixture file, so:
 *
 * - the English gate keeps its `corpusManifestSha`, and every baseline already
 *   recorded against it stays comparable. Merging translated pages into
 *   `CORPUS_DIRS` would have invalidated all of them at once, which is exactly
 *   the failure the sha exists to make loud;
 * - a translated report cannot be `--baseline`d against an English one. The
 *   manifests differ so the sha differs, and the existing corpus guard already
 *   refuses the comparison; carrying the language on the report only makes
 *   that refusal legible instead of arriving as an unexplained hash mismatch.
 *
 * The directory does not exist until someone runs the translator, so nothing
 * resolves it at module load.
 */
export function translatedCorpusDirs(lang: string): readonly string[] {
  const dir = join(import.meta.dirname, `corpus-${lang}`);
  // `corpus-<lang>` is a namespace, and #1115's image corpus lives inside it
  // under a name that is not a language: `--lang de-images` resolved onto
  // `corpus-de-images` and this function handed it back as a translated
  // corpus. It died a step later on a missing `fixture-de-images.json`, which
  // is luck rather than a guard — P5b wires that corpus in through its own
  // `--images` axis, on purpose, and nothing may reach it by spelling a
  // language.
  if (dir === IMAGE_CORPUS_DIR) {
    throw new Error(
      `--lang ${lang} resolves onto ${IMAGE_CORPUS_DIR}, which is #1115's image corpus and not a ` +
        'translation. It is measured on its own axis (P5b), never as a language variant of the ' +
        'English gate.',
    );
  }
  return [dir];
}

/** Corpus directories for a run: English by default, one translated dir otherwise. */
export function corpusDirsForLanguage(lang: string | undefined): readonly string[] {
  return !lang || lang === 'en' ? CORPUS_DIRS : translatedCorpusDirs(lang);
}

function loadCorpusDir(dir: string): CorpusPage[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as { pages: ManifestEntry[] };
  return manifest.pages.map((entry) => ({
    file: entry.file,
    title: entry.title,
    source: entry.source,
    markdown: readFileSync(join(dir, entry.file), 'utf8'),
    ...(entry.qualityScore === undefined ? {} : { qualityScore: entry.qualityScore }),
    ...(entry.ageDays === undefined ? {} : { ageDays: entry.ageDays }),
  }));
}

export function loadCorpus(dirs: readonly string[] = CORPUS_DIRS): CorpusPage[] {
  return dirs.flatMap(loadCorpusDir);
}

/**
 * The hash the fixture is bound to, computed HERE and nowhere else.
 *
 * It covers EVERY manifest, not just the vendored one. When the synthetic
 * corpus was added, a sha over `corpus/MANIFEST.json` alone would have stayed
 * unchanged while the corpus underneath the labels doubled — so a stale
 * baseline would have compared two different corpora and reported the
 * difference as a retrieval regression. That is the precise failure this hash
 * exists to make loud, and it would have been silent.
 *
 * One implementation, used by the fixture test and by any tooling that needs
 * it: two hash computations that must agree is its own defect class.
 */
export function computeCorpusManifestSha(dirs: readonly string[] = CORPUS_DIRS): string {
  const hash = createHash('sha256');
  for (const dir of dirs) hash.update(readFileSync(join(dir, 'MANIFEST.json')));
  return hash.digest('hex');
}

/**
 * Every markdown file present on disk, from the directory listing rather than
 * the manifest — so a page added without regenerating the manifest is caught
 * rather than silently excluded from the corpus the labels were written for.
 */
export function corpusFilesOnDisk(dirs: readonly string[] = CORPUS_DIRS): Set<string> {
  const NON_CORPUS = new Set(['LICENSE-ATTRIBUTION.md', 'README.md']);
  return new Set(
    dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.md') && !NON_CORPUS.has(f))),
  );
}

export class FixtureValidationError extends Error {}

/**
 * Parses and checks the fixture against the corpus. Throws rather than
 * filtering: a fixture that quietly drops broken labels changes N between
 * runs, and N is what the whole statistical gate is sized against.
 */
export function loadFixture(raw: unknown, corpus: CorpusPage[]): Fixture {
  const fixture = FixtureSchema.parse(raw);

  const known = new Set(corpus.map((p) => p.file));
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenQueries = new Set<string>();

  for (const label of fixture.labels) {
    if (seenIds.has(label.id)) problems.push(`duplicate label id: ${label.id}`);
    seenIds.add(label.id);

    // Near-duplicate queries inflate N without adding information, and the
    // bootstrap treats them as independent evidence when they are not.
    const normalized = normalizeQuery(label.query);
    if (seenQueries.has(normalized)) problems.push(`duplicate query: "${label.query}"`);
    seenQueries.add(normalized);

    for (const file of label.expectedFiles) {
      if (!known.has(file)) problems.push(`label ${label.id} expects a file not in the corpus: ${file}`);
    }
  }

  if (problems.length > 0) {
    throw new FixtureValidationError(`Fixture does not match the corpus:\n  ${problems.join('\n  ')}`);
  }
  return fixture;
}

/**
 * The issue's floor, enforced in code rather than in prose. Recall@K over N
 * queries moves in 1/N increments, so below 100 the deltas this harness is
 * meant to detect cannot be represented at all — a smaller fixture would make
 * the gate look like it works while being incapable of firing correctly.
 */
export const MIN_FIXTURE_SIZE = 100;

/**
 * Typed on `labels` alone rather than on `Fixture`, so #1115 P5b's image
 * fixture is held to the SAME floor. The two are separate schemas on purpose
 * (see `ImageFixtureSchema` below), and the arithmetic behind this floor —
 * Recall@K over N moves in 1/N steps — is a property of N, not of which fields
 * a label carries. A second copy of it for the image axis is how one of them
 * gets retuned alone.
 */
export function assertFixturePower(fixture: { labels: readonly unknown[] }): void {
  if (fixture.labels.length < MIN_FIXTURE_SIZE) {
    throw new FixtureValidationError(
      `Fixture has ${fixture.labels.length} labels; #1102 requires at least ${MIN_FIXTURE_SIZE} — ` +
        'below that a Recall@K delta smaller than 1/N cannot occur, so the gate cannot detect the ' +
        'effects it exists to detect.',
    );
  }
}

// ---------------------------------------------------------------------------
// #1115 P5c — the IMAGE fixture.
// ---------------------------------------------------------------------------

/**
 * A separate schema and a separate loader, never a widened `FixtureLabelSchema`.
 *
 * The two fixtures answer different questions and are scored on different
 * axes: the text fixture is `query → page`, and every recorded baseline in
 * `docs/runbooks/retrieval-eval.md` is a comparison against it. This one is
 * `query → page AND the image on that page that answers it`, measured on P5b's
 * own `--images` axis. Adding `lang` / `expectedImages` / two more `style`
 * values to the shipped schema would have made every existing label validate
 * with an absent image list and an unstated language — so the one thing the
 * image leg is scored on (`imageHit@K`) would have been a field the text
 * fixture is silently missing, rather than a fixture it does not belong to.
 * `fixture.test.ts` is untouched by this file for the same reason.
 */
export const ImageFixtureLabelSchema = z.object({
  /** Stable identity for pairing baseline against candidate runs. */
  id: z.string().min(1),
  query: z.string().min(3),
  /**
   * The corpus is German, so German is the ordinary case and English is the
   * CROSS-LINGUAL one — a query in a language the page never uses, which the
   * text leg cannot serve and a shared VL space is claimed to. It is carried
   * per label rather than inferred, because a slice that has to be recovered
   * by guessing the language of a sentence is a slice nobody will report on.
   */
  lang: z.enum(['de', 'en']),
  /** Corpus filenames, best first — resolved to page ids at seed time. */
  expectedFiles: z.array(z.string().min(1)).min(1),
  /**
   * Manifest-relative image paths (`images/…`), best first. EMPTY is legal and
   * meaningful: an `image-negative` label is a page whose *text* is about the
   * subject while none of its pictures show it, so the correct image answer is
   * "none of them". Those labels are what keeps `imageHit@K` honest — without
   * them a leg that returns an image for every query scores the same as one
   * that returns the right image.
   */
  expectedImages: z.array(z.string().min(1)),
  style: z.enum(['image', 'image-negative']),
  rationale: z.string().default(''),
});

/**
 * An image the labeller looked at and refused to write a query for, with the
 * reason. It exists so that "no label mentions this image" has two possible
 * causes and they are told apart: a labeller who judged a figure unusable said
 * so, and anything else is a slice that was silently skipped. The guard
 * requires the union of referenced + not-usable to cover the corpus, so an
 * image can be dropped only on the record.
 */
export const ImageFixtureNotUsableSchema = z.object({
  file: z.string().min(1),
  reason: z.string().min(1),
});

export const ImageFixtureSchema = z.object({
  /**
   * The image corpus's manifest hash — `computeCorpusManifestSha([IMAGE_CORPUS_DIR])`,
   * the same function and the same contract `fixture.json` has. The captions
   * these labels were written against live in that manifest, so re-vendoring
   * the corpus without re-labelling leaves every `expectedImages` entry
   * pointing at bytes nobody looked at.
   */
  corpusManifestSha: z.string().min(1),
  labeledBy: z.string().min(1),
  notUsable: z.array(ImageFixtureNotUsableSchema).default([]),
  labels: z.array(ImageFixtureLabelSchema),
});

export type ImageFixtureLabel = z.infer<typeof ImageFixtureLabelSchema>;
export type ImageFixtureNotUsable = z.infer<typeof ImageFixtureNotUsableSchema>;
export type ImageFixture = z.infer<typeof ImageFixtureSchema>;

/** The image fixture, beside the corpus it is labelled against. */
export const IMAGE_FIXTURE_PATH = join(import.meta.dirname, 'fixture-de-images.json');

/**
 * Parses and checks the image fixture against the image corpus. Throws rather
 * than filtering, exactly as `loadFixture` does and for the same reason: a
 * loader that quietly drops broken labels changes N between runs, and N is
 * what the statistical gate is sized against.
 *
 * Three checks are corpus-relative and none of them can be made from the
 * fixture alone:
 *
 * 1. **Every `expectedFile` is a page in the manifest.** A mistyped filename
 *    is a query that can never be satisfied, which scores as a permanent
 *    retrieval failure for a reason that has nothing to do with retrieval.
 * 2. **Every `expectedImage` exists on disk under `images/`.** The manifest is
 *    consulted for the page association below, but existence is checked
 *    against the bytes: a manifest entry for a file the builder did not write
 *    is exactly what `corpus-de-images.test.ts` exists to catch, and this
 *    loader must not inherit that lie.
 * 3. **Every `expectedImage` belongs to one of the label's own
 *    `expectedFiles`.** This is the one that cannot be eyeballed. `imageHit@K`
 *    is scored inside the retrieved page, so an image credited to the wrong
 *    page is unreachable however good the leg is — and because both the page
 *    and the image individually exist, nothing else in the pipeline notices.
 */
export function loadImageFixture(
  path: string = IMAGE_FIXTURE_PATH,
  corpusDir: string = IMAGE_CORPUS_DIR,
): ImageFixture {
  const fixture = ImageFixtureSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const manifest = loadImageCorpusManifest(corpusDir);

  const pageFiles = new Set(manifest.pages.map((p) => p.file));
  const imageOwner = new Map<string, string>();
  for (const page of manifest.pages) {
    for (const image of page.images) imageOwner.set(image.file, page.file);
  }

  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenQueries = new Set<string>();
  const referenced = new Set<string>();

  for (const label of fixture.labels) {
    if (seenIds.has(label.id)) problems.push(`duplicate label id: ${label.id}`);
    seenIds.add(label.id);

    // Near-duplicate queries inflate N without adding information, and the
    // bootstrap treats them as independent evidence when they are not.
    const normalized = normalizeQuery(label.query);
    if (seenQueries.has(normalized)) problems.push(`duplicate query: "${label.query}"`);
    seenQueries.add(normalized);

    for (const file of label.expectedFiles) {
      if (!pageFiles.has(file)) {
        problems.push(`label ${label.id} expects a page not in the image corpus: ${file}`);
      }
    }

    // `image-negative` is the whole point of the negative slice: the correct
    // image answer is "none". A negative carrying an image contradicts its own
    // name, and a positive carrying none can never contribute to `imageHit@K`
    // — both validate and both quietly measure nothing.
    if (label.style === 'image' && label.expectedImages.length === 0) {
      problems.push(`label ${label.id} is style 'image' but names no expected image`);
    }
    if (label.style === 'image-negative' && label.expectedImages.length > 0) {
      problems.push(
        `label ${label.id} is style 'image-negative' but names ${label.expectedImages.length} expected image(s)`,
      );
    }

    for (const image of label.expectedImages) {
      referenced.add(image);
      if (!existsSync(join(corpusDir, image))) {
        problems.push(`label ${label.id} expects an image not on disk: ${image}`);
        continue;
      }
      const owner = imageOwner.get(image);
      if (owner === undefined) {
        problems.push(`label ${label.id} expects an image absent from the manifest: ${image}`);
      } else if (!label.expectedFiles.includes(owner)) {
        problems.push(
          `label ${label.id} expects image ${image}, which the manifest puts on ${owner} — ` +
            `not on any of its expected pages (${label.expectedFiles.join(', ')})`,
        );
      }
    }
  }

  for (const entry of fixture.notUsable) {
    if (!imageOwner.has(entry.file)) {
      problems.push(`notUsable names an image absent from the manifest: ${entry.file}`);
    }
    if (referenced.has(entry.file)) {
      problems.push(`${entry.file} is both labelled and marked notUsable`);
    }
  }

  if (problems.length > 0) {
    throw new FixtureValidationError(
      `Image fixture does not match the corpus:\n  ${problems.join('\n  ')}`,
    );
  }
  return fixture;
}

/** Case- and whitespace-insensitive form, shared by the duplicate and caption rules. */
export function normalizeQuery(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}
