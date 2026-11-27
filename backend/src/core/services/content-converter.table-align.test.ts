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

/** What an editor serialises for a 3-column aligned table: generated colgroup, one paragraph per cell. */
const EDITOR_TABLE = '<table style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;">'
  + '<col style="min-width: 25px;"></colgroup><tbody><tr>'
  + '<th colspan="1" rowspan="1" align="left"><p>a</p></th><th colspan="1" rowspan="1" align="center"><p>b</p></th>'
  + '<th colspan="1" rowspan="1"><p>c</p></th></tr><tr>'
  + '<td colspan="1" rowspan="1" align="left"><p>1</p></td><td colspan="1" rowspan="1" align="center"><p>2</p></td>'
  + '<td colspan="1" rowspan="1"><p>3</p></td></tr></tbody></table>';

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

function dom(html: string): Document {
  return new JSDOM(`<body>${html}</body>`).window.document;
}

/** An editor-serialised, unresized two-column table: generated colgroup, one paragraph per cell, first column aligned. */
function editorTable(align: string, header: readonly [string, string], body: readonly [string, string]): string {
  const cell = (tag: string, html: string, aligned: boolean): string =>
    `<${tag} colspan="1" rowspan="1"${aligned ? ` align="${align}"` : ''}><p>${html}</p></${tag}>`;
  return '<table style="min-width: 50px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody>'
    + `<tr>${cell('th', header[0], true)}${cell('th', header[1], false)}</tr><tr>${cell('td', body[0], true)}${cell('td', body[1], false)}</tr>`
    + '</tbody></table>';
}

function serialized(html: string): string {
  return dom(html).querySelector('table')!.outerHTML;
}

interface ImproveBaseCase { html: string; markdown: string; applied: string }

/** Captured at the slice base bda4d1ed (decision D12; provenance in the fixture). */
const IMPROVE_BASE: { cases: Record<string, ImproveBaseCase> } = JSON.parse(
  readFileSync(join(here, '__fixtures__/table-align-improve-base.json'), 'utf8'),
);

describe('AI Improve: a table without alignment converts exactly as at the slice base (D12, #1956)', () => {
  it.each(Object.entries(IMPROVE_BASE.cases))('%s: the same Markdown and the same applied HTML', async (_name, base) => {
    const { markdown, applied } = await improveChain(base.html);
    expect(markdown).toBe(base.markdown);
    expect(applied).toBe(base.applied);
  });
});

describe('AI Improve: an aligned table (D12, #1956)', () => {
  it('converts through the stock GFM rule when its markers state every cell, and Apply brings the alignment back', async () => {
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

  it('freezes an editor-serialised table: the model sees one token, Apply replays the table verbatim', async () => {
    const { markdown, applied } = await improveChain(`<p>before</p>${EDITOR_TABLE}<p>after</p>`);
    expect(markdown).toBe('before\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nafter');
    const doc = dom(applied);
    expect([...doc.body.children].map((el) => el.nodeName)).toEqual(['P', 'TABLE', 'P']);
    expect(doc.querySelector('table')!.outerHTML).toBe(EDITOR_TABLE);
  });

  const frozen: Array<[string, string]> = [
    ['an editor table (generated colgroup)', EDITOR_TABLE],
    ['a body cell aligned differently from its header', '<table><thead><tr><th align="left">a</th></tr></thead><tbody><tr><td align="right">1</td></tr></tbody></table>'],
    ['a body cell without its header\'s alignment', '<table><thead><tr><th align="center">a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'],
    ['a header alignment the stock rule cannot read', '<table><thead><tr><th align=" Right ">a</th></tr></thead><tbody><tr><td align=" Right ">1</td></tr></tbody></table>'],
    ['a style that decides against the attribute', '<table><thead><tr><th style="text-align: right" align="left">a</th></tr></thead><tbody><tr><td align="left">1</td></tr></tbody></table>'],
    ['a column span', '<table><thead><tr><th colspan="2" align="center">name</th></tr></thead><tbody><tr><td align="center">a</td><td>b</td></tr></tbody></table>'],
    ['a row span', '<table><tbody><tr><th align="left">a</th><th>b</th></tr><tr><td rowspan="2" align="left">1</td><td>2</td></tr><tr><td>3</td></tr></tbody></table>'],
    ['a paragraph in a cell', '<table><thead><tr><th align="left"><p>a</p></th></tr></thead><tbody><tr><td align="left"><p>1</p></td></tr></tbody></table>'],
    ['a line break in a cell', '<table><thead><tr><th align="left">a</th></tr></thead><tbody><tr><td align="left">x<br>y</td></tr></tbody></table>'],
    ['a caption', '<table><caption>Revenue</caption><thead><tr><th align="left">a</th></tr></thead><tbody><tr><td align="left">1</td></tr></tbody></table>'],
    ['a footer', '<table><thead><tr><th align="left">a</th></tr></thead><tbody><tr><td align="left">1</td></tr></tbody><tfoot><tr><td>t</td></tr></tfoot></table>'],
    ['a comment between rows', '<table><tbody><tr><th align="left">a</th></tr><!-- c --><tr><td align="left">1</td></tr></tbody></table>'],
    ['a header row that is not all th', '<table><tbody><tr><th align="left">a</th><td>b</td></tr><tr><td align="left">1</td><td>2</td></tr></tbody></table>'],
    ['a nested table', '<table><thead><tr><th align="left">a</th></tr></thead><tbody><tr><td align="left"><table><tbody><tr><td>n</td></tr></tbody></table></td></tr></tbody></table>'],
  ];

  it.each(frozen)('freezes %s and replays it verbatim', async (_label, html) => {
    const { html: protectedHtml, media } = protectMedia(html);
    expect(media.map((m) => m.html)).toEqual([serialized(html)]);
    expect(protectedHtml).not.toContain('<table');
    expect(serialized((await improveChain(html)).applied)).toBe(serialized(html));
  });

  it('freezes only the table that carries the alignment: an unaligned outer table keeps converting around it', async () => {
    const html = `<table><tbody><tr><td>${EDITOR_TABLE}</td></tr></tbody></table>`;
    const { html: protectedHtml, media } = protectMedia(html);
    expect(media.map((m) => m.html)).toEqual([EDITOR_TABLE]);
    expect(protectedHtml).toBe('<table><tbody><tr><td> CQ_MEDIA_PLACEHOLDER_0 </td></tr></tbody></table>');
    const doc = dom((await improveChain(html)).applied);
    expect(doc.querySelectorAll('table')).toHaveLength(2);
    expect(doc.querySelector('td > table')!.outerHTML).toBe(EDITOR_TABLE);
  });

  it('carries media inside a frozen table in the table, not as tokens of their own', () => {
    const html = editorTable('center', ['H', 'I'], ['<img src="/attachments/x.png" alt="d">', '<span class="confluence-status" data-color="green">OK</span>']);
    expect(protectMedia(html).media.map((m) => m.html)).toEqual([serialized(html)]);
  });

  // Review r2 A2-1 / A2-2: content and link attributes of an aligned table reach the page unchanged.
  it('keeps literal markup, non-breaking spaces, code whitespace and link attributes, also in the storage write', async () => {
    const html = editorTable(
      'center',
      ['This is &lt;EM &gt;demo&lt;/EM&gt;', '&nbsp;unit&nbsp;'],
      ['<code>cmd   /help</code>', '<a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/guide">guide</a>'],
    );
    const { applied } = await improveChain(html);
    expect(serialized(applied)).toBe(serialized(html));
    const doc = dom(applied);
    expect([...doc.querySelectorAll('th, td')].map((c) => c.textContent)).toEqual([
      'This is <EM >demo</EM>', '\u00a0unit\u00a0', 'cmd   /help', 'guide',
    ]);
    expect(doc.querySelector('td em, th em')).toBeNull();
    const link = dom(htmlToConfluence(applied)).querySelector('a')!;
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')])
      .toEqual(['https://example.com/guide', '_blank', 'noopener noreferrer nofollow']);
  });

  // Review r2 A2-3: a table in an existing (non-native) panel.
  it.each([
    ['first in the panel', (t: string) => `<div class="panel-info">${t}</div><p>after</p>`],
    ['after a paragraph, before multi-line code', (t: string) => `<div class="panel-info"><p>Note</p>${t}<pre><code>a\n\n**literal**</code></pre></div><p>after</p>`],
  ])('keeps an aligned table %s: one table, its cells, contents and alignment', async (_label, wrap) => {
    const table = editorTable('right', ['H', 'I'], ['b', '<img src="/attachments/x.png" alt="d">']);
    const doc = dom((await improveChain(wrap(table))).applied);
    expect(doc.querySelectorAll('table')).toHaveLength(1);
    expect(doc.querySelector('table')!.outerHTML).toBe(table);
    expect(cells(doc.body.innerHTML).map((c) => [c.textContent, c.getAttribute('align')]))
      .toEqual([['H', 'right'], ['I', null], ['b', 'right'], ['', null]]);
    expect(doc.querySelector('td img')!.getAttribute('src')).toBe('/attachments/x.png');
  });

  // Review r2 A2-4: layout tokens inside and around an aligned table.
  it('keeps a literal layout token and a real layout inside the table, and one surrounding layout', async () => {
    const inner = '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="single">'
      + '<div class="confluence-layout-cell"><p>inner</p></div></div></div>';
    const table = editorTable('left', ['Literal [[[EXPAND]]] text', `<span title="[[[LAYOUT]]]">t</span>`], [inner, 'b']);
    const page = '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="single">'
      + `<div class="confluence-layout-cell"><p>x</p>${table}</div></div></div>`;
    const { applied } = await improveChain(page);
    const doc = dom(applied);
    expect(doc.querySelector('table')!.outerHTML).toBe(serialized(table));
    expect(doc.querySelectorAll('div.confluence-layout')).toHaveLength(2);
    expect(doc.querySelector('th')!.textContent).toBe('Literal [[[EXPAND]]] text');
    expect(htmlToConfluence(applied).match(/<ac:layout>/g)).toHaveLength(2);
    expect(htmlToConfluence(page).match(/<ac:layout>/g)).toHaveLength(2);
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

  // AI Improve (D12): a table carrying `align` either converts through the stock rule because its markers state every
  // cell, or is frozen; either way an unchanged echo gives every cell the alignment the schemas read before.
  it.each(CELL_ALIGN_VECTORS.filter(([, attrs]) => /align="/i.test(attrs)))(
    'AI Improve keeps the alignment the schemas read for %s',
    async (_label, attrs, expected) => {
      const html = `<table><thead><tr><th ${attrs}>h</th></tr></thead><tbody><tr><td ${attrs}>c</td></tr></tbody></table>`;
      const { applied } = await improveChain(html);
      expect(cells(yDocToHtml(htmlToYDoc(applied))).map((cell) => cell.getAttribute('align'))).toEqual([expected, expected]);
    },
  );
});
