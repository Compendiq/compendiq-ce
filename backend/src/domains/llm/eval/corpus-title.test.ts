import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanTitle, deriveCorpusTitle, deslugifyFilename, firstMarkdownHeading, type CorpusTitleSource } from './corpus-title.js';
import { CORPUS_DIR } from './fixture.js';

// #1102 — the corpus stands in for a Confluence knowledge base, and a
// Confluence page has a human title. Every assertion here corresponds to a
// non-title the first derivation actually shipped into the manifest.

interface VendoredEntry {
  file: string;
  title: string;
  titleSource: CorpusTitleSource;
  path: string;
}

function vendoredPages(): VendoredEntry[] {
  const raw = JSON.parse(readFileSync(join(CORPUS_DIR, 'MANIFEST.json'), 'utf8')) as { pages: VendoredEntry[] };
  return raw.pages;
}

describe('cleanTitle (#1102)', () => {
  it('drops a Vue component together with its decorative content', () => {
    expect(cleanTitle('Task Metadata <Badge type="danger">advanced</Badge>')).toBe('Task Metadata');
    expect(cleanTitle('Custom Benchmark Provider <Version type="experimental">5.0.0</Version> <Badge type="danger">advanced</Badge>')).toBe(
      'Custom Benchmark Provider',
    );
  });

  it('drops self-closing components and VitePress heading anchors', () => {
    expect(cleanTitle('Open Telemetry Support <Experimental /> {#open-telemetry-support}')).toBe('Open Telemetry Support');
    expect(cleanTitle('Trace View <Badge type="warning" text="Experimental" /> <Version>5.0.0</Version>')).toBe('Trace View');
  });

  it('drops inline code markers — a title is text, not Markdown', () => {
    expect(cleanTitle('`Content-Type` Parser')).toBe('Content-Type Parser');
  });

  it('is idempotent, which is what lets the manifest test re-check a front-matter title', () => {
    for (const raw of ['Task Metadata <Badge type="danger">advanced</Badge>', '`this.environment` in Hooks', 'Plain Title']) {
      expect(cleanTitle(cleanTitle(raw))).toBe(cleanTitle(raw));
    }
  });

  it('leaves a lowercase HTML tag alone rather than silently eating its text', () => {
    expect(cleanTitle('Using <code>fetch</code> directly')).toBe('Using <code>fetch</code> directly');
  });
});

describe('firstMarkdownHeading (#1102)', () => {
  it('ignores a `#` comment inside a fenced block', () => {
    // Three real pages were titled from one of these: a HAProxy config
    // comment, a Dockerfile comment and a shell-session output line.
    const body = ['```dockerfile', '# Use the official Node.js LTS image.', 'FROM node', '```', '', '## Serverless on AWS'].join('\n');
    expect(firstMarkdownHeading(body, 1)).toBeNull();
    expect(firstMarkdownHeading(body, 6)).toBe('Serverless on AWS');
  });

  it('does not close a backtick fence on a tilde line', () => {
    const body = ['```', '~~~', '# not a heading', '```', '# Real Heading'].join('\n');
    expect(firstMarkdownHeading(body, 1)).toBe('Real Heading');
  });

  it('respects the depth ceiling', () => {
    const body = ['### root', '', 'text'].join('\n');
    expect(firstMarkdownHeading(body, 2)).toBeNull();
    expect(firstMarkdownHeading(body, 6)).toBe('root');
  });
});

describe('deslugifyFilename (#1102)', () => {
  it('turns a slug into words', () => {
    expect(deslugifyFilename('docs/Guides/Fluent-Schema.md')).toBe('Fluent Schema');
    expect(deslugifyFilename('docs/guide/api-environment-instances.md')).toBe('Api Environment Instances');
  });

  it('keeps joining words lowercase', () => {
    expect(deslugifyFilename('docs/Reference/Validation-and-Serialization.md')).toBe('Validation and Serialization');
  });

  it('never lowercases a tail — upstream spells these this way', () => {
    expect(deslugifyFilename('docs/Reference/TypeScript.md')).toBe('TypeScript');
    expect(deslugifyFilename('docs/Reference/HTTP2.md')).toBe('HTTP2');
    expect(deslugifyFilename('docs/Reference/ContentTypeParser.md')).toBe('ContentTypeParser');
  });
});

describe('deriveCorpusTitle (#1102)', () => {
  it('prefers the front-matter title', () => {
    expect(deriveCorpusTitle({ frontMatterTitle: 'Custom Pool <Badge>advanced</Badge>', body: '# Something Else', filePath: 'docs/guide/pool.md' })).toEqual({
      title: 'Custom Pool',
      source: 'front-matter',
    });
  });

  it('then the first `#` heading', () => {
    expect(deriveCorpusTitle({ frontMatterTitle: null, body: '# Stated Title\n\nbody', filePath: 'docs/guide/slug-here.md' })).toEqual({
      title: 'Stated Title',
      source: 'heading',
    });
  });

  it('prefers the filename over a mere `##`, which is a first SECTION and not a subject', () => {
    // Measured: this leg is why Serverless.md is not titled "AWS" and
    // Server.md is not titled "Factory".
    const body = '<h1 align="center">Fastify</h1>\n\n## Factory\n\nThe Fastify module exports a factory function.';
    expect(deriveCorpusTitle({ frontMatterTitle: null, body, filePath: 'docs/Reference/Server.md' })).toEqual({
      title: 'Server',
      source: 'filename',
    });
  });

  it('falls back to the first heading of any depth for a positional filename', () => {
    // `Index.md` three times over is three pages with the same meaningless
    // title; the filename names a position in the tree, not a subject.
    const body = '<h1 align="center">Fastify</h1>\n\n## Guides Table Of Contents\n\ntext';
    expect(deriveCorpusTitle({ frontMatterTitle: null, body, filePath: 'docs/Guides/Index.md' })).toEqual({
      title: 'Guides Table Of Contents',
      source: 'heading',
    });
  });

  it('never returns a file path', () => {
    // The defect this module exists for: 29 pages carried their own path as
    // their title, which is one lexeme to `pages.tsv` and nothing a
    // Confluence page ever holds.
    const body = '<h1 align="center">Fastify</h1>\n\ntext with no heading at all';
    const { title } = deriveCorpusTitle({ frontMatterTitle: null, body, filePath: 'docs/Guides/Benchmarking.md' });
    expect(title).toBe('Benchmarking');
  });
});

describe('the committed vendored manifest (#1102)', () => {
  it('re-derives every title from the vendored bytes, so a script re-run reproduces it', () => {
    // `scripts/vendor-eval-corpus.ts` rebuilds this manifest from scratch on
    // every run, so a hand-edited title would be silently deleted the next
    // time the corpus is refreshed. The guarantee is that nothing IS hand
    // edited: each title is what the shared derivation produces, checked here
    // against the same bytes the script wrote.
    //
    // The vendored `.md` files have their front matter stripped, which is why
    // `titleSource` is recorded — a `front-matter` title cannot be re-derived
    // from the body and is checked for cleanliness instead.
    const mismatches = vendoredPages()
      .map((entry) => {
        const body = readFileSync(join(CORPUS_DIR, entry.file), 'utf8');
        const derived = deriveCorpusTitle({
          frontMatterTitle: entry.titleSource === 'front-matter' ? entry.title : null,
          body,
          filePath: entry.path,
        });
        return { file: entry.file, expected: entry.title, expectedSource: entry.titleSource, ...derived };
      })
      .filter((r) => r.title !== r.expected || r.source !== r.expectedSource);

    expect(mismatches).toEqual([]);
  });

  it('holds human titles: no paths, no markup, nothing empty', () => {
    const pages = vendoredPages();
    expect(pages.length).toBeGreaterThan(200);

    const pathLike = pages.filter((p) => p.title.includes('/') || /\.md$/i.test(p.title)).map((p) => `${p.file}: ${p.title}`);
    expect(pathLike).toEqual([]);

    const dirty = pages.filter((p) => cleanTitle(p.title) !== p.title).map((p) => `${p.file}: ${p.title}`);
    expect(dirty).toEqual([]);

    expect(pages.filter((p) => p.title.trim().length === 0)).toEqual([]);
  });
});
