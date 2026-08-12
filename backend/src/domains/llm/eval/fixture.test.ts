import { describe, expect, it } from 'vitest';
import {
  loadCorpus,
  loadFixture,
  corpusFilesOnDisk,
  assertFixturePower,
  FixtureValidationError,
  MIN_FIXTURE_SIZE,
  type CorpusPage,
} from './fixture.js';

// #1102 — the fixture guards. Each of these failures is silent without a
// check: a bad filename reads as a permanent retrieval miss, a duplicate query
// inflates N without adding evidence, and an undersized fixture makes the gate
// look functional while being unable to represent the deltas it must detect.

/**
 * Words carrying no discriminative signal for "did this query reuse the page's
 * wording": ordinary English function words, plus the three product names,
 * which appear in nearly every page of the corpus and so cannot distinguish
 * one target from another.
 */
const NON_CONTENT = new Set(
  `a an the and or but if of for to in on at by with from as is are was were be been being do does did
   done can could should would will shall may might must have has had how what why when where which who
   whom this that these those it its i my we our you your they them their he she his her not no into over
   under about after before between during without within out up down off again then than there here more
   most other some such only own same so too very just now also get got make makes made use uses used
   using need needs me us via per vs versus want wants fastify vite vitest docs guide reference md`.split(/\s+/),
);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !NON_CONTENT.has(w));
}

const corpus: CorpusPage[] = [
  { file: 'a.md', title: 'A', markdown: '# A', source: 'x' },
  { file: 'b.md', title: 'B', markdown: '# B', source: 'x' },
];

function fixture(labels: Array<Partial<{ id: string; query: string; expectedFiles: string[] }>>) {
  return {
    corpusManifestSha: 'deadbeef',
    labeledBy: 'test',
    labels: labels.map((l, i) => ({
      id: l.id ?? `q${i}`,
      query: l.query ?? `query number ${i}`,
      expectedFiles: l.expectedFiles ?? ['a.md'],
      style: 'question' as const,
      rationale: '',
    })),
  };
}

describe('loadFixture (#1102)', () => {
  it('accepts labels whose expected files are all in the corpus', () => {
    const parsed = loadFixture(fixture([{ expectedFiles: ['a.md'] }, { expectedFiles: ['b.md', 'a.md'] }]), corpus);
    expect(parsed.labels).toHaveLength(2);
  });

  it('rejects a hallucinated filename instead of scoring it as a permanent miss', () => {
    expect(() => loadFixture(fixture([{ id: 'q7', expectedFiles: ['nope.md'] }]), corpus)).toThrow(
      /q7 expects a file not in the corpus: nope\.md/,
    );
  });

  it('rejects duplicate query text, which the bootstrap would treat as independent evidence', () => {
    const raw = fixture([{ query: 'How do I add a hook?' }, { query: '  how do I ADD a hook?  ' }]);
    expect(() => loadFixture(raw, corpus)).toThrow(/duplicate query/i);
  });

  it('rejects duplicate ids, which would silently collapse a pair in the baseline/candidate join', () => {
    const raw = fixture([{ id: 'same' }, { id: 'same', query: 'a different question entirely' }]);
    expect(() => loadFixture(raw, corpus)).toThrow(/duplicate label id/i);
  });

  it('reports every problem at once rather than one per run', () => {
    const raw = fixture([{ id: 'q1', expectedFiles: ['missing-one.md'] }, { id: 'q2', expectedFiles: ['missing-two.md'] }]);
    try {
      loadFixture(raw, corpus);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FixtureValidationError);
      expect((err as Error).message).toContain('missing-one.md');
      expect((err as Error).message).toContain('missing-two.md');
    }
  });
});

describe('assertFixturePower (#1102)', () => {
  it(`refuses a fixture below N=${MIN_FIXTURE_SIZE}, naming why`, () => {
    expect(() => assertFixturePower(fixture([{}, {}]) as never)).toThrow(/at least 100/);
  });

  it('passes at the floor', () => {
    const big = fixture(Array.from({ length: MIN_FIXTURE_SIZE }, (_, i) => ({ id: `q${i}`, query: `question ${i}` })));
    expect(() => assertFixturePower(big as never)).not.toThrow();
  });
});

describe('the shipped fixture (#1102)', () => {
  it('validates against the corpus, clears the power floor, and matches the manifest it was labelled from', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { computeCorpusManifestSha } = await import('./fixture.js');

    const raw = JSON.parse(readFileSync(join(import.meta.dirname, 'fixture.json'), 'utf8'));
    const parsed = loadFixture(raw, loadCorpus());
    assertFixturePower(parsed);

    // Re-vendoring the corpus without re-labelling would leave the fixture
    // pointing at text that no longer says what the labeller read. The hash
    // is what makes that loud instead of silent.
    // computeCorpusManifestSha is the ONE implementation, and it covers every
    // corpus directory. Recomputing it here with a second hand-rolled hash is
    // exactly how the vendored-only version survived the synthetic corpus
    // being added: the sha would not have moved while the corpus doubled.
    expect(parsed.corpusManifestSha).toBe(computeCorpusManifestSha());
  });

  it('spreads across query styles, so the score is not one phrasing measured 144 times', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const parsed = loadFixture(JSON.parse(readFileSync(join(import.meta.dirname, 'fixture.json'), 'utf8')), loadCorpus());

    const styles = new Map<string, number>();
    for (const l of parsed.labels) styles.set(l.style, (styles.get(l.style) ?? 0) + 1);

    // Every style present, and none dominating: keyword-only queries flatter
    // FTS, natural questions flatter the vector leg, and a fixture made of
    // one of them measures half the system. The #1107 identifier styles are
    // deliberately SMALL probes (3 positives, 3 negatives), so they get a
    // presence floor of their own rather than the core styles' 10.
    expect([...styles.keys()].sort()).toEqual([
      'diversity', 'diversity-negative', 'error-text', 'how-to',
      'identifier', 'identifier-negative', 'keywords', 'question',
      'ranking-prior', 'ranking-prior-negative', 'vocabulary-gap',
    ]);
    for (const [style, count] of styles.entries()) {
      // Small deliberate probes (#1107 identifier, #1109 diversity) get a
      // floor of 3; the core styles carry the statistical weight and keep 10.
      //
      // `vocabulary-gap` (#1112) is NOT a probe and takes the core floor of
      // 10 — it ships at 33. A three-label probe cannot answer the question
      // it exists for: multi-query expansion is expected to move a handful of
      // queries, and Recall@K over three of them moves in thirds, so any
      // result would be indistinguishable from noise.
      const isProbe = style.startsWith('identifier') || style.startsWith('diversity') || style.startsWith('ranking-prior');
      expect(count).toBeGreaterThanOrEqual(isProbe ? 3 : 10);
      expect(count / parsed.labels.length).toBeLessThan(0.6);
    }
  });

  it('keeps the vocabulary-gap slice lexically clear of its targets (#1112)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const parsed = loadFixture(JSON.parse(readFileSync(join(import.meta.dirname, 'fixture.json'), 'utf8')), loadCorpus());
    const pages = new Map(loadCorpus().map((p) => [p.file, p]));

    // The whole point of the slice, made checkable. A `vocabulary-gap` label
    // whose query is written from the page's own sentences measures nothing
    // that the existing 158 do not already measure — and the failure is
    // SILENT, because such a label validates, scores well and quietly makes
    // the slice look easy. Nothing but this assertion stops a future label
    // from being labelled `vocabulary-gap` while reusing the page's wording.
    //
    // Overlap is against the title plus the opening ~1500 characters: that is
    // the text a title-boosted lexical match and the first chunk's embedding
    // both see, so it is where reused wording actually pays off.
    const overlap = (query: string, file: string): number => {
      const page = pages.get(file)!;
      const q = new Set(contentWords(query));
      if (q.size === 0) return 0;
      const target = new Set(contentWords(`${page.title} ${page.markdown.slice(0, 1500)}`));
      return [...q].filter((w) => target.has(w)).length / q.size;
    };

    const scored = parsed.labels.map((l) => ({ ...l, overlap: overlap(l.query, l.expectedFiles[0]!) }));
    const gap = scored.filter((l) => l.style === 'vocabulary-gap');
    const rest = scored.filter((l) => l.style !== 'vocabulary-gap');
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    const gapMean = mean(gap.map((l) => l.overlap));
    const restMean = mean(rest.map((l) => l.overlap));

    // Measured when the slice landed: 0.13 against 0.57. The thresholds sit
    // well clear of both so an ordinary re-labelling does not trip them, and
    // well below the level a page-worded query lands at.
    expect(gapMean).toBeLessThan(0.3);
    expect(gapMean).toBeLessThan(restMean / 2);

    // Named individually: a mean can absorb one label that gives the game
    // away, and a single trivially-matching label is a label that measures
    // nothing at all.
    const leaky = gap.filter((l) => l.overlap > 0.45).map((l) => `${l.id} (${l.overlap.toFixed(2)}): ${l.query}`);
    expect(leaky).toEqual([]);
  });

  it('does not concentrate on a handful of pages', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const parsed = loadFixture(JSON.parse(readFileSync(join(import.meta.dirname, 'fixture.json'), 'utf8')), loadCorpus());

    // A fixture whose queries all point at ten pages measures those ten pages.
    const distinct = new Set(parsed.labels.flatMap((l) => l.expectedFiles));
    expect(distinct.size).toBeGreaterThan(parsed.labels.length * 0.75);
  });
});

describe('the vendored corpus itself (#1102)', () => {
  it('has a manifest that matches what is actually on disk', () => {
    // A page added or removed without re-running the vendor script would
    // otherwise change what the labels were written against, invisibly.
    const manifestFiles = new Set(loadCorpus().map((p) => p.file));
    const diskFiles = corpusFilesOnDisk();
    expect([...diskFiles].filter((f) => !manifestFiles.has(f))).toEqual([]);
    expect([...manifestFiles].filter((f) => !diskFiles.has(f))).toEqual([]);
  });

  it('carries enough pages for retrieval to be non-trivial, and every page has real text', () => {
    const pages = loadCorpus();
    expect(pages.length).toBeGreaterThanOrEqual(200);
    expect(pages.every((p) => p.markdown.trim().length >= 500)).toBe(true);
    expect(pages.every((p) => p.title.trim().length > 0)).toBe(true);
  });

  it('strips front matter, so VitePress config keys never reach the embedding text', () => {
    const withFrontMatter = loadCorpus().filter((p) => p.markdown.startsWith('---'));
    expect(withFrontMatter.map((p) => p.file)).toEqual([]);
  });
});
