/**
 * #1115 P5c — the guard over the image fixture.
 *
 * Filesystem-only, like `corpus-de-images.test.ts` and for the same reason:
 * everything here is a property of committed bytes, and a guard that skips
 * wherever the fixture is most likely to be hand-edited is not a guard.
 *
 * What it exists to stop, in the order the failures actually happen:
 *
 * 1. **A label pointing at something that is not there.** A mistyped page or
 *    image filename scores as a permanent miss for a reason that has nothing
 *    to do with retrieval, and drags the leg's number down invisibly.
 * 2. **An image credited to the wrong page.** `imageHit@K` is scored inside
 *    the retrieved page, so this one is unreachable however good the leg is —
 *    and because the page and the image each exist, nothing else notices.
 * 3. **A query copied out of the caption.** The captions were stripped from
 *    the page bodies precisely so the picture carries information the prose
 *    does not (`corpus-images.ts`). A query that is the caption verbatim is a
 *    query the labeller read off the manifest instead of the image, and it
 *    scores the leg a win it did not earn — the same failure the corpus's own
 *    caption-leak test guards from the other side.
 * 4. **A slice quietly disappearing.** The counts below are the fixture's
 *    design, not observations: an English slice that erodes to five labels, a
 *    negative slice that erodes to zero, or a category that stops being
 *    measured all leave a fixture that validates and reports a number for
 *    something it is no longer measuring.
 * 5. **Re-vendoring the corpus without re-labelling.** `corpusManifestSha` is
 *    the same contract `fixture.json` has: these labels were written against
 *    the captions and the bytes in that manifest, and a refresh moves both.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FixtureValidationError,
  IMAGE_FIXTURE_PATH,
  MIN_FIXTURE_SIZE,
  computeCorpusManifestSha,
  loadImageFixture,
  normalizeQuery,
  type ImageFixtureLabel,
} from './fixture.js';
import { IMAGE_CORPUS_CATEGORIES, IMAGE_CORPUS_DIR, loadImageCorpusManifest } from './corpus-images.js';

const manifest = loadImageCorpusManifest();
const pageOf = new Map(manifest.pages.map((page) => [page.file, page]));

/**
 * The caption rule's own normaliser, deliberately WIDER than `normalizeQuery`
 * and deliberately not shared with it.
 *
 * `normalizeQuery` also backs `loadFixture`'s duplicate-query rule for the
 * shipped TEXT fixture, so folding punctuation into it would change that
 * fixture's dedupe semantics — a different gate, on a different corpus, for a
 * different reason. But an exact match is far too narrow for *this* rule: the
 * failure it exists to catch is "the labeller read the manifest instead of the
 * image", and a caption pasted with its commas dropped is that failure exactly.
 * `Rollout, Januar 2005` and `Rollout Januar 2005` are the same query.
 */
function normalizeCaption(text: string): string {
  return normalizeQuery(text.replace(/[^\p{L}\p{N}\s]/gu, ' '));
}

/**
 * How much of the corpus may be retired into `notUsable` before the fixture
 * stops MEASURING the corpus and starts merely accounting for it.
 *
 * The coverage rule below only requires labels ∪ `notUsable` to be total, and
 * "on the record" is an unbounded excuse: moving a third of the images into
 * `notUsable` with a reason and deleting their labels leaves every other
 * assertion in this file green while the image set the leg is actually scored
 * on shrinks by a third. A figure or two really can be unusable; a tenth of the
 * corpus cannot be, and if it is that is a corpus decision, not a re-label.
 */
const NOT_USABLE_CEILING_RATIO = 0.1;

function exceedsNotUsableCeiling(notUsable: number, totalImages: number): boolean {
  return notUsable > Math.floor(totalImages * NOT_USABLE_CEILING_RATIO);
}

/** A real page with real images, so a planted violation is the ONLY thing wrong. */
const HOST = manifest.pages.find((page) => page.images.length >= 2)!;
const OTHER = manifest.pages.find((page) => page.file !== HOST.file && page.images.length >= 1)!;

function label(overrides: Partial<ImageFixtureLabel> = {}): ImageFixtureLabel {
  return {
    id: 'img-00-001',
    query: 'ein Diagramm, das den Aufbau zeigt',
    lang: 'de',
    expectedFiles: [HOST.file],
    expectedImages: [HOST.images[0]!.file],
    style: 'image',
    rationale: '',
    ...overrides,
  };
}

/**
 * Writes a fixture to a scratch file and loads it against the REAL corpus.
 * The loader takes a path rather than parsed JSON, so the planted violation
 * travels the same route the shipped file does.
 */
function loadPlanted(fixture: unknown): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'image-fixture-'));
  const path = join(dir, 'fixture-de-images.json');
  writeFileSync(path, JSON.stringify(fixture));
  return loadImageFixture(path, IMAGE_CORPUS_DIR);
}

function fixtureOf(labels: ImageFixtureLabel[], notUsable: Array<{ file: string; reason: string }> = []) {
  return { corpusManifestSha: 'deadbeef', labeledBy: 'test', notUsable, labels };
}

describe('loadImageFixture (#1115 P5c)', () => {
  it('accepts a label whose page and image both exist and belong together', () => {
    const parsed = loadPlanted(fixtureOf([label()])) as { labels: unknown[] };
    expect(parsed.labels).toHaveLength(1);
  });

  it('rejects a page that is not in the image corpus', () => {
    expect(() => loadPlanted(fixtureOf([label({ expectedFiles: ['nope.md'] })]))).toThrow(
      /expects a page not in the image corpus: nope\.md/,
    );
  });

  it('rejects an expected image with no bytes on disk', () => {
    expect(() =>
      loadPlanted(fixtureOf([label({ expectedImages: ['images/nope__9.png'] })])),
    ).toThrow(/expects an image not on disk: images\/nope__9\.png/);
  });

  it("rejects an image that exists but belongs to another page — imageHit@K would never reach it", () => {
    const stray = OTHER.images[0]!.file;
    expect(() => loadPlanted(fixtureOf([label({ expectedImages: [stray] })]))).toThrow(
      new RegExp(`expects image ${stray.replace(/[/.]/g, '\\$&')}, which the manifest puts on ${OTHER.file}`),
    );
  });

  it('rejects duplicate ids, which would collapse a pair in the baseline/candidate join', () => {
    expect(() =>
      loadPlanted(fixtureOf([label(), label({ query: 'eine ganz andere Frage zum Bild' })])),
    ).toThrow(/duplicate label id/i);
  });

  it('rejects duplicate query text, case- and whitespace-insensitively', () => {
    expect(() =>
      loadPlanted(
        fixtureOf([
          label({ id: 'img-00-001', query: 'Wie sieht der Aufbau aus?' }),
          label({ id: 'img-00-002', query: '  wie sieht   DER Aufbau aus?  ' }),
        ]),
      ),
    ).toThrow(/duplicate query/i);
  });

  it('rejects an image-positive label naming no image, which can never contribute to imageHit@K', () => {
    expect(() => loadPlanted(fixtureOf([label({ expectedImages: [] })]))).toThrow(
      /style 'image' but names no expected image/,
    );
  });

  it("rejects an image-negative label naming an image, which contradicts its own name", () => {
    expect(() => loadPlanted(fixtureOf([label({ style: 'image-negative' })]))).toThrow(
      /style 'image-negative' but names 1 expected image/,
    );
  });

  it('rejects a notUsable entry for an image that is also labelled', () => {
    const used = HOST.images[0]!.file;
    expect(() =>
      loadPlanted(fixtureOf([label()], [{ file: used, reason: 'blurry' }])),
    ).toThrow(new RegExp(`${used.replace(/[/.]/g, '\\$&')} is both labelled and marked notUsable`));
  });

  it('rejects a notUsable entry naming an image the manifest has never heard of', () => {
    expect(() =>
      loadPlanted(fixtureOf([label()], [{ file: 'images/ghost__1.png', reason: 'blurry' }])),
    ).toThrow(/notUsable names an image absent from the manifest: images\/ghost__1\.png/);
  });

  it('reports every problem at once rather than one per run', () => {
    try {
      loadPlanted(
        fixtureOf([
          label({ id: 'a', query: 'erste kaputte Frage', expectedFiles: ['missing-one.md'], expectedImages: [] }),
          label({ id: 'b', query: 'zweite kaputte Frage', expectedFiles: ['missing-two.md'], expectedImages: [] }),
        ]),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FixtureValidationError);
      expect((err as Error).message).toContain('missing-one.md');
      expect((err as Error).message).toContain('missing-two.md');
    }
  });
});

/**
 * Loaded LAZILY, not at module scope. `loadImageFixture` throws, and a throw
 * during collection takes the whole file down as "no tests" — including the
 * planted-violation suite above, which is the part that says what a broken
 * label looks like. This way a bad fixture fails the tests below BY NAME, with
 * the loader's own message. It is the same trap `corpus-images.ts` documents
 * for a `.refine()` on a schema resolved at import time.
 */
let cached: ReturnType<typeof loadImageFixture> | undefined;
function shipped(): ReturnType<typeof loadImageFixture> {
  cached ??= loadImageFixture(IMAGE_FIXTURE_PATH, IMAGE_CORPUS_DIR);
  return cached;
}

describe('the shipped image fixture (#1115 P5c)', () => {
  it('validates against the corpus — every page and image exists, and each image is on its own page', () => {
    expect(shipped().labels.length).toBeGreaterThan(0);
  });

  it('matches the manifest it was labelled from', () => {
    const fixture = shipped();
    // The same contract `fixture.json` has, through the same function — the
    // captions these labels were written against live in that manifest, so a
    // refresh without a re-label leaves every `expectedImages` entry pointing
    // at bytes nobody looked at. Recomputing the hash here by hand is how the
    // text fixture's version survived a second corpus being added.
    expect(fixture.corpusManifestSha).toBe(computeCorpusManifestSha([IMAGE_CORPUS_DIR]));
  });

  it(`clears the N ≥ ${MIN_FIXTURE_SIZE} power floor`, () => {
    const fixture = shipped();
    // `assertFixturePower` takes the TEXT fixture's type and this one is not
    // that type — the styles differ and widening either schema to share the
    // helper is the merge this file exists to avoid. The floor is the same
    // constant and the same argument: Recall@K moves in 1/N increments, so
    // below 100 the deltas the gate must detect cannot be represented.
    expect(fixture.labels.length).toBeGreaterThanOrEqual(MIN_FIXTURE_SIZE);
  });

  it('carries a cross-lingual slice big enough to report on its own', () => {
    const fixture = shipped();
    // English over a German corpus is the case a shared VL space is claimed to
    // serve and the text leg cannot. Twenty is the floor at which a per-slice
    // Recall@K is worth quoting at all; the slice ships well above it.
    const english = fixture.labels.filter((l) => l.lang === 'en');
    expect(english.length).toBeGreaterThanOrEqual(20);

    // ...and spread, not one page asked fifty ways.
    const pages = new Set(english.flatMap((l) => l.expectedFiles));
    expect(pages.size).toBeGreaterThanOrEqual(20);
  });

  it('carries image-negative distractors in BOTH languages, and not so many that they dominate', () => {
    const fixture = shipped();
    // Without them a leg that returns an image for every query scores the same
    // as one that returns the right image. Too many and the fixture measures
    // abstention rather than retrieval.
    const negatives = fixture.labels.filter((l) => l.style === 'image-negative');
    expect(negatives.length).toBeGreaterThanOrEqual(8);
    // 22 rather than the 20 this first shipped with, and moved deliberately:
    // the four English distractors below are an addition, not a rebalancing,
    // and at 307 labels 22 is 7.2% of the fixture — the same share the German
    // slice already carried, nowhere near abstention dominating the measure.
    expect(negatives.length).toBeLessThanOrEqual(22);
    expect(negatives.every((l) => l.expectedImages.length === 0)).toBe(true);

    // PER LANGUAGE, because the whole-fixture count above is blind to a slice
    // that is all positives — and one was: all 18 negatives were German when
    // this fixture first shipped, so the English slice, the very one the test
    // above certifies as big enough to report on its own and the case a shared
    // VL space is claimed for, scored an always-answers leg exactly like a
    // correct one.
    const negativesIn = (lang: string) => negatives.filter((l) => l.lang === lang).length;
    expect(negativesIn('en')).toBeGreaterThanOrEqual(4);
    // ...and German keeps its own, so "the English slice needs distractors" can
    // never be satisfied by re-languaging the ones already there.
    expect(negativesIn('de')).toBeGreaterThanOrEqual(8);
  });

  it('measures all four content shapes, none below 15% of the fixture', () => {
    const fixture = shipped();
    // The corpus is four deliberate slices (`IMAGE_CORPUS_CATEGORIES`), and a
    // VL model is not equally good at all of them — a fixture that is 60%
    // photographs reports a photograph score under the name of an image score.
    const counts = new Map<string, number>(IMAGE_CORPUS_CATEGORIES.map((c) => [c, 0]));
    for (const l of fixture.labels) {
      for (const category of new Set(l.expectedFiles.map((f) => pageOf.get(f)!.category))) {
        counts.set(category, counts.get(category)! + 1);
      }
    }
    // Named per category rather than asserted in a loop over a number, so a
    // failure says WHICH shape stopped being measured.
    const thin = [...counts]
      .filter(([, count]) => count / fixture.labels.length < 0.15)
      .map(([category, count]) => `${category}: ${count}/${fixture.labels.length}`);
    expect(thin).toEqual([]);
  });

  it('covers every vendored image, or says on the record why not', () => {
    const fixture = shipped();
    // "No label mentions this image" has two causes and they must be told
    // apart: a labeller who judged a figure unusable said so in `notUsable`,
    // and anything else is a slice that was silently skipped — which reads as
    // a corpus of 187 images while the leg is only ever asked about 140.
    const accounted = new Set([
      ...fixture.labels.flatMap((l) => l.expectedImages),
      ...fixture.notUsable.map((n) => n.file),
    ]);
    const all = manifest.pages.flatMap((page) => page.images.map((image) => image.file));
    expect(all.filter((file) => !accounted.has(file))).toEqual([]);

    // Every page too: a page with no label is a page the leg is never scored on.
    const labelled = new Set(fixture.labels.flatMap((l) => l.expectedFiles));
    expect(manifest.pages.map((p) => p.file).filter((f) => !labelled.has(f))).toEqual([]);
  });

  it('caps how much of the corpus may be retired on the record', () => {
    const all = manifest.pages.flatMap((page) => page.images.map((image) => image.file));
    expect(exceedsNotUsableCeiling(shipped().notUsable.length, all.length)).toBe(false);

    // The mutation this exists to refuse, and which the coverage rule above
    // cannot see: 60 of 187 images moved into `notUsable` with a reason and
    // their labels deleted, leaving N at 200 and every other assertion green.
    expect(exceedsNotUsableCeiling(60, all.length)).toBe(true);
    // ...while a figure or two that really is unusable stays allowed, which is
    // what `notUsable` is for.
    expect(exceedsNotUsableCeiling(2, all.length)).toBe(false);
  });

  it('never restates a caption, punctuation included', () => {
    const fixture = shipped();
    // The captions were stripped from the page bodies so the picture carries
    // what the prose does not. A query that IS the caption is a query written
    // off the manifest rather than off the image, and it hands the leg a match
    // the corpus was built to deny it.
    const captions = new Map<string, string>();
    for (const page of manifest.pages) {
      for (const image of page.images) {
        if (image.caption.trim()) captions.set(normalizeCaption(image.caption), image.file);
      }
    }
    const copied = fixture.labels
      .filter((l) => captions.has(normalizeCaption(l.query)))
      .map((l) => `${l.id}: ${l.query} == caption of ${captions.get(normalizeCaption(l.query))}`);
    expect(copied).toEqual([]);
  });

  it('catches a caption copied without its punctuation, which an exact match does not', () => {
    // `Rollout, Januar 2005` is a real manifest caption (`airbus-a380__2.jpg`).
    // Under the shared `normalizeQuery` the comma-less copy is a different
    // string and the rule above passes it — which is the whole gap, since a
    // labeller pasting a caption is exactly who drops the punctuation.
    const caption = 'Rollout, Januar 2005';
    const pasted = 'Rollout Januar 2005';
    expect(normalizeQuery(caption)).not.toBe(normalizeQuery(pasted));
    expect(normalizeCaption(caption)).toBe(normalizeCaption(pasted));

    // And it must not fold two genuinely different queries together: the rule
    // reports a copied caption, so a false positive would retire a good label.
    expect(normalizeCaption('Rollout der A380')).not.toBe(normalizeCaption(caption));
  });

  it('records who labelled it and keeps every notUsable reason', () => {
    const fixture = shipped();
    expect(fixture.labeledBy).toMatch(/independent/i);
    expect(fixture.notUsable.every((n) => n.reason.trim().length > 0)).toBe(true);
  });
});
