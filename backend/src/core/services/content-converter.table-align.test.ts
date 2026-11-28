import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  confluenceToHtml,
  extractLayoutSkeleton,
  htmlToConfluence,
  htmlToEmbeddingText,
  htmlToMarkdown,
  markdownToHtml,
  protectMedia,
  restoreMedia,
} from './content-converter.js';
import { htmlToYDoc, yDocToHtml } from './collab-schema.js';
import { NO_STORAGE_DERIVATION_FEATURES } from './storage-derivation.js';
import { TABLE_PAGE } from './__fixtures__/confluence-xhtml.js';

const here = dirname(fileURLToPath(import.meta.url));

function cells(html: string): Element[] {
  return [...new JSDOM(`<body>${html}</body>`).window.document.querySelectorAll('th, td')];
}

function table(cellHtml: string): string {
  return `<table><tbody><tr>${cellHtml}</tr></tbody></table>`;
}

const IMPROVE = { layoutTokens: true } as const;

describe('table cell alignment: confluenceToHtml (#1956)', () => {
  it.each([
    ['left', '<td class="confluenceTd" style="text-align: left;">x</td>'],
    ['center', '<td class="confluenceTd" style="text-align: center;">x</td>'],
    ['right', '<th style="text-align:right">x</th>'],
    ['center', '<td style="text-align: center !important">x</td>'],
    ['right', '<td style="background-color: rgb(1, 2, 3); text-align: right;">x</td>'],
  ])('adds align="%s" next to a plain text-align style and keeps the style', (align, cell) => {
    const html = confluenceToHtml(table(cell));
    const [out] = cells(html);
    expect(out!.getAttribute('align')).toBe(align);
    expect(out!.getAttribute('style')).toBe(cell.match(/style="([^"]*)"/)![1]);
    expect(html).toContain(' align="' + align + '">x</t');
  });

  it.each([
    ['justify', 'text-align: justify'],
    ['inherit', 'text-align: inherit'],
    ['a duplicate declaration', 'text-align: left; text-align: right'],
    ['duplicates with differing priority', 'text-align: left !important; text-align: right'],
    ['a quoted value holding a semicolon', "content: 'a;text-align: center'"],
    ['a custom property', '--x: text-align: center'],
    ['an upper-case property', 'TEXT-ALIGN: RIGHT'],
    ['a mixed-case property', 'Text-Align:center'],
    ['a comment', 'text-align: center /* x */'],
    ['text-align-last', 'text-align-last: center'],
    ['an over-long style', `text-align: center; ${'color: red; '.repeat(100)}`],
    ['no text-align', 'color: red'],
  ])('adds nothing for %s', (_label, style) => {
    const html = confluenceToHtml(table(`<td style="${style}">x</td>`));
    expect(cells(html)[0]!.hasAttribute('align')).toBe(false);
    expect(cells(html)[0]!.getAttribute('style')).toBe(style);
  });

  it('does not touch an unaligned cell or one that already carries align', () => {
    expect(confluenceToHtml(table('<td class="confluenceTd">x</td>'))).toBe(table('<td class="confluenceTd">x</td>'));
    expect(confluenceToHtml(table('<td align="right" style="text-align: left;">x</td>')))
      .toBe(table('<td align="right" style="text-align: left;">x</td>'));
  });

  it('is idempotent', () => {
    const once = confluenceToHtml(table('<td style="text-align: center;">x</td>'));
    expect(confluenceToHtml(once)).toBe(once);
  });
});

describe('table cell alignment: htmlToConfluence (#1956)', () => {
  it('writes style="text-align: X;" for align and removes the attribute (marked, editor and nested shapes)', () => {
    expect(htmlToConfluence('<table><tbody><tr><th align="center">a</th><td align="right">b</td><td>c</td></tr></tbody></table>'))
      .toBe('<table><tbody><tr><th style="text-align: center;">a</th><td style="text-align: right;">b</td><td>c</td></tr></tbody></table>');
    expect(htmlToConfluence('<table><tbody><tr><th colspan="1" rowspan="1" align="left"><p>a</p></th></tr></tbody></table>'))
      .toBe('<table><tbody><tr><th colspan="1" rowspan="1" style="text-align: left;"><p>a</p></th></tr></tbody></table>');
    expect(htmlToConfluence('<div class="panel-info"><table><tbody><tr><td align="center">x</td></tr></tbody></table></div>'))
      .toContain('<td style="text-align: center;">x</td>');
  });

  it('canonicalises the value and drops an invalid one without writing a style', () => {
    expect(htmlToConfluence(table('<td align=" CENTER ">x</td>'))).toBe(table('<td style="text-align: center;">x</td>'));
    for (const bad of ['justify', 'javascript:alert(1)', 'centre', '']) {
      expect(htmlToConfluence(table(`<td align="${bad}">x</td>`))).toBe(table('<td>x</td>'));
    }
  });

  it('keeps an existing style byte for byte when it decides, even if it disagrees with align', () => {
    for (const style of [
      'text-align: right;',
      'color: red; text-align: right',
      'text-align: justify',
      'text-align: left; text-align: right',
      'TEXT-ALIGN: RIGHT',
      "content: 'a;b'; text-align: right",
    ]) {
      expect(htmlToConfluence(table(`<td align="left" style="${style}">x</td>`))).toBe(table(`<td style="${style}">x</td>`));
    }
  });

  it('appends the declaration to an unrelated style and leaves the rest alone', () => {
    expect(htmlToConfluence(table('<td align="center" style="color: red">x</td>')))
      .toBe(table('<td style="color: red; text-align: center;">x</td>'));
    expect(htmlToConfluence(table('<td align="center" style="color: red;">x</td>')))
      .toBe(table('<td style="color: red; text-align: center;">x</td>'));
  });

  it('keeps a style that cannot take the declaration (unterminated string, over-long) and drops align', () => {
    expect(htmlToConfluence(table('<td align="center" style="content: \'abc">x</td>')))
      .toBe(table('<td style="content: \'abc">x</td>'));
    const long = `color: red; ${'margin: 0; '.repeat(120)}`;
    expect(htmlToConfluence(table(`<td align="center" style="${long}">x</td>`))).toBe(table(`<td style="${long}">x</td>`));
  });

  it('leaves a legacy style-only cell untouched', () => {
    const legacy = table('<td colspan="1" rowspan="1" style="text-align: center"><p>x</p></td>');
    expect(htmlToConfluence(legacy)).toBe(legacy);
  });

  it('is a gate: without feature cell-align the align attribute is written as before', () => {
    const html = table('<td align="center">x</td>');
    expect(htmlToConfluence(html, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES })).toBe(html);
    expect(htmlToConfluence(html, { derivationFeatures: new Set(['cell-align']) })).toBe(table('<td style="text-align: center;">x</td>'));
  });
});

describe('table cell alignment: round trip (#1956)', () => {
  it.each([
    ['a Confluence aligned cell with its other attributes', table('<td class="confluenceTd" style="text-align: center;" colspan="1" data-highlight-colour="red">x</td>')],
    ['a header cell', table('<th class="confluenceTh" style="text-align: right;">x</th>')],
    ['a multi-declaration style', table('<td style="text-align: center; background-color: rgb(1, 2, 3);">x</td>')],
    ['a style without a semicolon', table('<td style="text-align:left">x</td>')],
    ['!important', table('<td style="text-align: center !important;">x</td>')],
    ['an unaligned cell', table('<td class="confluenceTd">x</td>')],
    ['an ambiguous style', table('<td style="text-align: left; text-align: right;">x</td>')],
    ['an upper-case property', table('<td style="TEXT-ALIGN: RIGHT">x</td>')],
    ['a table with a colgroup', '<table class="wrapped"><colgroup><col /><col /></colgroup><tbody><tr><th style="text-align: center;">a</th><th>b</th></tr></tbody></table>'],
  ])('htmlToConfluence(confluenceToHtml(x)) is x for %s', (_label, storage) => {
    expect(htmlToConfluence(confluenceToHtml(storage))).toBe(storage);
  });

  it('writes the unaligned TABLE_PAGE fixture exactly as the base derivation does', () => {
    const html = confluenceToHtml(TABLE_PAGE);
    expect(html).not.toContain('align=');
    expect(htmlToConfluence(html)).toBe(htmlToConfluence(html, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }));
  });

  it('writes Markdown alignment back as Confluence storage styles', async () => {
    const storage = htmlToConfluence(await markdownToHtml('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |'));
    expect(storage).toContain('<th style="text-align: left;">a</th>');
    expect(storage).toContain('<th style="text-align: center;">b</th>');
    expect(storage).toContain('<td style="text-align: right;">3</td>');
    expect(storage).not.toContain('align="');
  });
});

/**
 * An unchanged model echo through the persisting Improve path, as the routes run it: the Improve request converts
 * protectMedia(body) with layout tokens (`_helpers.ts`); Accept re-protects the stored body, parses the echo with its
 * layout skeleton and media, then restores the media (`llm-conversations.ts`).
 */
async function improveChain(body: string): Promise<{ markdown: string; applied: string }> {
  const markdown = htmlToMarkdown(protectMedia(body).html, IMPROVE);
  const { html: protectedBody, media } = protectMedia(body);
  const applied = await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedBody), protectedMedia: media });
  return { markdown, applied: restoreMedia(applied, media) };
}

interface ImproveBaseCase { html: string; markdown: string; applied: string }

/** Captured at the slice base bda4d1ed (decisions D12, D15; provenance in the fixture). */
const IMPROVE_BASE: { cases: Record<string, ImproveBaseCase> } = JSON.parse(
  readFileSync(join(here, '__fixtures__/table-align-improve-base.json'), 'utf8'),
);

// Decision D15: #1956 makes no change to the AI Improve chain. Every table, aligned or not, converts and applies
// exactly as at the slice base: the stock GFM rule states the header row's alignment per column; what it mangles
// (a pipe in a cell, a table first in a flattened panel) it still mangles.
describe('AI Improve: every table converts exactly as at the slice base (D15, #1956)', () => {
  it.each(Object.entries(IMPROVE_BASE.cases))('%s: the same Markdown and the same applied HTML', async (_name, base) => {
    const { markdown, applied } = await improveChain(base.html);
    expect(markdown).toBe(base.markdown);
    expect(applied).toBe(base.applied);
  });
});

describe('AI Improve: column alignment through the stock GFM rule (issue criterion 5, #1956)', () => {
  it('writes the header row\'s markers, and Apply brings the alignment back on every cell of the column', async () => {
    const { markdown, applied } = await improveChain(IMPROVE_BASE.cases.alignedStockTable!.html);
    expect(markdown).toBe('| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |');
    expect(cells(applied).map((c) => [c.nodeName, c.textContent, c.getAttribute('align')])).toEqual([
      ['TH', 'a', 'left'], ['TH', 'b', 'center'], ['TH', 'c', 'right'], ['TH', 'd', null],
      ['TD', '1', 'left'], ['TD', '2', 'center'], ['TD', '3', 'right'], ['TD', '4', null],
    ]);
  });

  it('is stable over a Markdown → HTML → Markdown → HTML cycle', async () => {
    const md = '| a | b |\n| :-: | --: |\n| 1 | 2 |';
    const once = htmlToMarkdown(await markdownToHtml(md), IMPROVE).trim();
    expect(once).toBe(md);
    expect(htmlToMarkdown(await markdownToHtml(once), IMPROVE).trim()).toBe(once);
  });

  it('gives a body cell aligned differently from its header the header\'s alignment on Accept (recorded limit)', async () => {
    const { applied } = await improveChain(IMPROVE_BASE.cases.alignedBodyCellDiffersFromHeader!.html);
    expect(cells(applied).map((c) => c.getAttribute('align'))).toEqual(['left', 'left']);
  });

  it('keeps no media token for a table: the protected media of an aligned page are its media only', () => {
    expect(protectMedia(IMPROVE_BASE.cases.alignedEditorTableBeforeImage!.html).media.map((m) => m.html))
      .toEqual(['<img src="/api/attachments/1/diagram.png" alt="Diagram">']);
  });
});

interface BaseTable {
  html: string;
  markdown: string;
  markdownLayoutFalse: string;
  improve: string;
  embedding: string;
}

/**
 * Captured at origin/dev bff6d4ec in a clean checkout (decision D6, #1956): every htmlToMarkdown
 * caller except the Improve conversion must keep producing these bytes.
 */
const BASE = JSON.parse(readFileSync(join(here, '__fixtures__/table-align-base-markdown.json'), 'utf8')).tables as Record<string, BaseTable>;

describe('htmlToMarkdown outside the Improve conversion is unchanged (D6, #1956)', () => {
  it.each(Object.entries(BASE))('%s: the base bytes without options, with layoutTokens false and for embedding text', (_name, base) => {
    expect(htmlToMarkdown(base.html)).toBe(base.markdown);
    expect(htmlToMarkdown(base.html, {})).toBe(base.markdown);
    expect(htmlToMarkdown(base.html, { layoutTokens: false })).toBe(base.markdownLayoutFalse);
    expect(htmlToEmbeddingText(base.html)).toBe(base.embedding);
  });

  it('keeps an aligned editor table as raw HTML for those callers', () => {
    expect(BASE.editorAligned!.markdown.startsWith('<table style="min-width: 75px;">')).toBe(true);
    expect(htmlToMarkdown(BASE.editorAligned!.html).startsWith('<table')).toBe(true);
  });
});

/**
 * The converter reads cells through jsdom (confluenceToHtml, htmlToConfluence, the Improve table rule); the schemas
 * through the browser / happy-dom / jsdom. The shared guard makes them agree: the vectors are one fixture, also read
 * by collab-schema-parity.test.ts, article-extensions.test.ts and the e2e browser check.
 */
const vectorFixture: { vectors: Array<[string, string, string | null]> } = JSON.parse(
  readFileSync(join(here, '__fixtures__/table-cell-align-vectors.json'), 'utf8'),
);
const CELL_ALIGN_VECTORS = vectorFixture.vectors;

describe('the converter reads a cell as both schemas do (#1956)', () => {
  it.each(CELL_ALIGN_VECTORS.filter(([, attrs]) => !attrs.includes('align=') && attrs.includes('style=')))(
    'confluenceToHtml (jsdom), style only: %s',
    (_label, attrs, expected) => {
      const [cell] = cells(confluenceToHtml(table(`<td ${attrs}>c</td>`)));
      expect(cell!.getAttribute('align')).toBe(expected);
    },
  );

  it.each(CELL_ALIGN_VECTORS.filter(([, attrs]) => /align="/i.test(attrs)))(
    'htmlToConfluence (jsdom) keeps the deciding style or writes the alignment: %s',
    (label, attrs, expected) => {
      const [cell] = cells(htmlToConfluence(table(`<td ${attrs}>c</td>`)));
      expect(cell!.hasAttribute('align')).toBe(false);
      const style = attrs.match(/style="([^"]*)"/)?.[1];
      if (style === undefined) {
        expect(cell!.getAttribute('style')).toBe(expected === null ? null : `text-align: ${expected};`);
      } else if (label === 'unrelated style keeps the attribute') {
        expect(cell!.getAttribute('style')).toBe('color: red; text-align: left;');
      } else {
        expect(cell!.getAttribute('style')).toBe(style);
      }
    },
  );

  // C6 / review T5: Confluence storage → confluenceToHtml (jsdom) → collaborative schema (happy-dom) → save. A form
  // the guard reads keeps its alignment through the save; a form it declines is declined by every host alike.
  it.each(CELL_ALIGN_VECTORS.filter(([, attrs]) => !/align="/i.test(attrs)))(
    'storage read and collaborative save agree on %s',
    (_label, attrs, expected) => {
      const read = confluenceToHtml(table(`<td ${attrs}>c</td>`));
      expect(cells(read)[0]!.getAttribute('align')).toBe(expected);
      const collab = yDocToHtml(htmlToYDoc(read));
      expect(cells(collab)[0]!.getAttribute('align')).toBe(expected);
      const [saved] = cells(htmlToConfluence(collab));
      expect(saved!.getAttribute('style')).toBe(expected === null ? null : `text-align: ${expected};`);
    },
  );
});
