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
