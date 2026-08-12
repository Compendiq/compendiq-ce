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
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

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
    const normalized = label.query.trim().toLowerCase().replace(/\s+/g, ' ');
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

export function assertFixturePower(fixture: Fixture): void {
  if (fixture.labels.length < MIN_FIXTURE_SIZE) {
    throw new FixtureValidationError(
      `Fixture has ${fixture.labels.length} labels; #1102 requires at least ${MIN_FIXTURE_SIZE} — ` +
        'below that a Recall@K delta smaller than 1/N cannot occur, so the gate cannot detect the ' +
        'effects it exists to detect.',
    );
  }
}
