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

describe('table cell alignment: GFM tables on the Improve conversion (#1956)', () => {
  it('turns an editor-serialised table into a GFM table with its alignment', () => {
    expect(htmlToMarkdown(EDITOR_TABLE, IMPROVE).trim()).toBe('| a | b | c |\n| :-- | :-: | --- |\n| 1 | 2 | 3 |');
  });

  it('writes left, center, right and unspecified markers, and the cell texts survive the round trip', async () => {
    const md = htmlToMarkdown(
      '<table><colgroup><col><col><col><col></colgroup><tbody><tr><th align="left"><p>a</p></th><th align="center"><p>b</p></th><th align="right"><p>c</p></th><th><p>d</p></th></tr>'
      + '<tr><td align="left"><p>1</p></td><td align="center"><p>2</p></td><td align="right"><p>3</p></td><td><p>4</p></td></tr></tbody></table>',
      IMPROVE,
    );
    expect(md.trim().split('\n')[1]).toBe('| :-- | :-: | --: | --- |');
    const back = new JSDOM(`<body>${await markdownToHtml(md)}</body>`).window.document;
    expect([...back.querySelectorAll('th')].map((c) => [c.textContent, c.getAttribute('align')]))
      .toEqual([['a', 'left'], ['b', 'center'], ['c', 'right'], ['d', null]]);
    expect([...back.querySelectorAll('td')].map((c) => [c.textContent, c.getAttribute('align')]))
      .toEqual([['1', 'left'], ['2', 'center'], ['3', 'right'], ['4', null]]);
  });

  it('is stable over a Markdown → HTML → Markdown → HTML cycle', async () => {
    const md = '| a | b |\n| :-: | --: |\n| 1 | 2 |';
    const once = htmlToMarkdown(await markdownToHtml(md), IMPROVE).trim();
    expect(once).toBe(md);
    expect(htmlToMarkdown(await markdownToHtml(once), IMPROVE).trim()).toBe(once);
  });

  it('keeps inline formatting, links and images in a cell on one line, and escapes pipes', async () => {
    const html = '<table><colgroup><col><col></colgroup><tbody><tr><th><p>a|b</p></th><th><p>c\\|d</p></th></tr>'
      + '<tr><td><p><strong>x</strong> <a href="https://example.com/p">l</a> <code>y|z</code></p></td><td><p></p></td></tr></tbody></table>';
    const md = htmlToMarkdown(html, IMPROVE);
    expect(md).toContain('| a\\|b | c\\\\\\|d |');
    expect(md).toContain('| **x** [l](https://example.com/p) `y\\|z` |  |');
    const back = new JSDOM(`<body>${await markdownToHtml(md)}</body>`).window.document;
    expect([...back.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['a|b', 'c\\|d']);
    expect(back.querySelector('td code')?.textContent).toBe('y|z');
  });

  it('reads the alignment of legacy style-only cells', () => {
    const md = htmlToMarkdown(
      '<table class="wrapped"><colgroup><col /><col /></colgroup><tbody><tr><th class="confluenceTh" style="text-align: center;">H</th>'
      + '<th class="confluenceTh" style="text-align: right">I</th></tr><tr><td class="confluenceTd" style="text-align: center;">x</td><td class="confluenceTd" style="text-align: right">y</td></tr></tbody></table>',
      IMPROVE,
    );
    expect(md.trim()).toBe('| H | I |\n| :-: | --: |\n| x | y |');
  });

  it('keeps the tables stock turndown converted before as GFM', () => {
    expect(htmlToMarkdown('<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>', IMPROVE).trim())
      .toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(htmlToMarkdown('<table>\n<thead>\n<tr>\n<th align="left">a</th>\n</tr>\n</thead>\n<tbody><tr>\n<td align="left">1</td>\n</tr>\n</tbody></table>\n', IMPROVE).trim())
      .toBe('| a |\n| :-- |\n| 1 |');
  });

  const declined: Array<[string, string]> = [
    ['a column span in a thead header', '<table><thead><tr><th colspan="2">name</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>'],
    ['a row span', '<table><tbody><tr><th>a</th><th>b</th></tr><tr><td rowspan="2">1</td><td>2</td></tr><tr><td>3</td></tr></tbody></table>'],
    ['an authored column width', '<table><colgroup><col style="width: 120px"><col></colgroup><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>'],
    ['a resized cell', '<table style="width: 300px"><colgroup><col style="width: 100px"></colgroup><tbody><tr><th colwidth="100">a</th></tr><tr><td>1</td></tr></tbody></table>'],
    ['a caption', '<table><caption>Revenue</caption><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'],
    ['a two-paragraph cell', '<table><tbody><tr><th><p>a</p><p>a2</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>'],
    ['a list in a cell', '<table><tbody><tr><th>a</th></tr><tr><td><ul><li>x</li></ul></td></tr></tbody></table>'],
    ['a line break in a cell', '<table><tbody><tr><th>a</th></tr><tr><td>x<br>y</td></tr></tbody></table>'],
    ['a nested table', '<table><tbody><tr><th>a</th></tr><tr><td><table><tbody><tr><td>n</td></tr></tbody></table></td></tr></tbody></table>'],
    ['a highlighted cell', '<table><tbody><tr><th>a</th></tr><tr><td data-highlight-colour="red" style="background-color: rgb(255, 0, 0);">1</td></tr></tbody></table>'],
    ['a cell with a semantic class', '<table><tbody><tr><th>a</th></tr><tr><td class="highlight-red">1</td></tr></tbody></table>'],
    ['a paragraph with its own alignment', '<table><tbody><tr><th>a</th></tr><tr><td><p style="text-align: center">1</p></td></tr></tbody></table>'],
    ['a body cell aligned differently from its header', '<table><tbody><tr><th align="left">a</th></tr><tr><td align="right">1</td></tr></tbody></table>'],
    ['a table layout', '<table data-layout="full-width"><tbody><tr><th>a</th></tr><tr><td>1</td></tr></tbody></table>'],
    ['a footer', '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody><tfoot><tr><td>t</td></tr></tfoot></table>'],
    ['a header row that is not the first row', '<table><tbody><tr><td>1</td></tr><tr><th>a</th></tr></tbody></table>'],
    ['a ragged row', '<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr></tbody></table>'],
    ['a table without a header row', '<table><colgroup><col></colgroup><tbody><tr><td>1</td></tr></tbody></table>'],
    ['an invalid alignment value', '<table><tbody><tr><th align="justify">a</th></tr><tr><td>1</td></tr></tbody></table>'],
    // Review T4: only TipTap's generated 25px-per-column sizing is not the author's.
    ['an authored minimum width', '<table style="min-width: 540px;"><colgroup><col style="min-width: 540px;"></colgroup><tbody><tr><th>H</th></tr><tr><td>b</td></tr></tbody></table>'],
    ['a colgroup with fewer columns than the rows', '<table style="min-width: 25px;"><colgroup><col style="min-width: 25px;"></colgroup><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>'],
    ['a table minimum that is not the sum of its columns', '<table style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>'],
    ['a table minimum without a colgroup', '<table style="min-width: 25px;"><tbody><tr><th>a</th></tr><tr><td>1</td></tr></tbody></table>'],
    // Review T1/T2: content GFM would read back differently.
    ['literal markup in cell text', '<table><tbody><tr><th>a</th></tr><tr><td>The spelling &lt;em&gt;demo&lt;/em&gt;</td></tr></tbody></table>'],
    ['a character reference spelled in cell text', '<table><tbody><tr><th>a</th></tr><tr><td>literal &amp;copy;</td></tr></tbody></table>'],
    ['a backslash before a pipe in code', '<table><tbody><tr><th>a</th></tr><tr><td><code>left\\|right</code></td></tr></tbody></table>'],
    ['highlight, underline and subscript', '<table><tbody><tr><th>a</th></tr><tr><td>H<sub>2</sub>O; <mark>Review</mark>; <u>due</u></td></tr></tbody></table>'],
    ['a link with an id', '<table><tbody><tr><th>a</th></tr><tr><td><a href="https://example.com/p" id="anchor">l</a></td></tr></tbody></table>'],
    ['a link with an authored rel', '<table><tbody><tr><th>a</th></tr><tr><td><a href="https://example.com/p" rel="noreferrer">l</a></td></tr></tbody></table>'],
    ['an inline element with a class', '<table><tbody><tr><th>a</th></tr><tr><td><span class="term">t</span></td></tr></tbody></table>'],
    ['a bare URL Markdown would turn into a link', '<table><tbody><tr><th>a</th></tr><tr><td>see https://example.com/p</td></tr></tbody></table>'],
  ];

  it.each(declined)('keeps %s as its raw HTML, every attribute intact', (_label, html) => {
    const md = htmlToMarkdown(html, IMPROVE).trim();
    const original = new JSDOM(`<body>${html}</body>`).window.document.body.innerHTML;
    expect(md).toBe(original);
    expect(md).not.toMatch(/^\|/m);
  });

  it('keeps a table with more cells than the bound as raw HTML', () => {
    const row = `<tr>${'<td>x</td>'.repeat(100)}</tr>`;
    const html = `<table><tbody><tr>${'<th>h</th>'.repeat(100)}</tr>${row.repeat(60)}</tbody></table>`;
    expect(htmlToMarkdown(html, IMPROVE).trim().startsWith('<table>')).toBe(true);
  });

  it('keeps a raw table next to GFM prose and tables in one document', () => {
    const md = htmlToMarkdown(`<p>before</p>${EDITOR_TABLE}<p>mid</p>${declined[0]![1]}<p>after</p>`, IMPROVE);
    expect(md).toContain('| a | b | c |');
    expect(md).toContain('<table><thead><tr><th colspan="2">name</th></tr>');
    expect(md).toMatch(/before\n\n\| a/);
    expect(md).toMatch(/\|\n\nmid\n\n<table>/);
  });
});

/**
 * An unchanged model echo through the persisting Improve path, as the routes run it: the Improve request converts
 * protectMedia(content) with layout tokens (`_helpers.ts`); Accept re-protects the stored body, parses the echo with
 * its layout skeleton and media, then restores the media (`llm-conversations.ts`).
 */
async function applyUnchangedEcho(body: string): Promise<Document> {
  const markdown = htmlToMarkdown(protectMedia(body).html, IMPROVE);
  const { html: protectedBody, media } = protectMedia(body);
  const applied = await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedBody), protectedMedia: media });
  return new JSDOM(`<body>${restoreMedia(applied, media)}</body>`).window.document;
}

/** An editor-serialised, unresized table: generated colgroup, one paragraph per cell, every column centred. */
function editorTable(header: readonly string[], body: readonly string[]): string {
  const cell = (tag: string, html: string): string => `<${tag} colspan="1" rowspan="1" align="center"><p>${html}</p></${tag}>`;
  return `<table style="min-width: ${25 * header.length}px;"><colgroup>${'<col style="min-width: 25px;">'.repeat(header.length)}</colgroup>`
    + `<tbody><tr>${header.map((h) => cell('th', h)).join('')}</tr><tr>${body.map((b) => cell('td', b)).join('')}</tr></tbody></table>`;
}

function firstTableHtml(html: string): string {
  return new JSDOM(`<body>${html}</body>`).window.document.querySelector('table')!.outerHTML;
}

describe('table cell alignment: an unchanged Improve echo through Apply (#1956)', () => {
  it('keeps an ordinary editor table as GFM and brings back its alignment and text', async () => {
    expect(htmlToMarkdown(EDITOR_TABLE, IMPROVE).trim().startsWith('| a | b | c |')).toBe(true);
    const doc = await applyUnchangedEcho(EDITOR_TABLE);
    expect([...doc.querySelectorAll('th, td')].map((c) => [c.nodeName, c.textContent, c.getAttribute('align')])).toEqual([
      ['TH', 'a', 'left'], ['TH', 'b', 'center'], ['TH', 'c', null], ['TD', '1', 'left'], ['TD', '2', 'center'], ['TD', '3', null],
    ]);
  });

  it('keeps literal markup, a spelled character reference and a backslash before a pipe in code as they were', async () => {
    const html = editorTable(['a', 'b', 'c'], ['The spelling &lt;em&gt;demo&lt;/em&gt;', 'literal &amp;copy;', '<code>left\\|right</code>']);
    const doc = await applyUnchangedEcho(html);
    const tds = [...doc.querySelectorAll('td')];
    expect(tds.map((td) => td.textContent)).toEqual(['The spelling <em>demo</em>', 'literal &copy;', 'left\\|right']);
    expect(doc.querySelector('td em')).toBeNull();
    expect(tds[2]!.querySelector('code')!.textContent).toBe('left\\|right');
    expect(doc.querySelector('table')!.outerHTML).toBe(firstTableHtml(html));
  });

  it('keeps highlight, underline, subscript, a link id and an inline class', async () => {
    const html = editorTable(['a'], ['H<sub>2</sub>O; <mark>Review</mark>; <u>due</u> <a href="https://example.com/p" id="anchor">l</a> <span class="term">t</span>']);
    const doc = await applyUnchangedEcho(html);
    expect(doc.querySelector('table')!.outerHTML).toBe(firstTableHtml(html));
    expect(['sub', 'mark', 'u', 'a#anchor', 'span.term'].map((selector) => doc.querySelector(`td ${selector}`) !== null))
      .toEqual([true, true, true, true, true]);
  });

  it('sends a formatted link Markdown can state as GFM and brings back the same link', async () => {
    const html = editorTable(['a'], ['<a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/p" title="T"><strong>bold</strong> link</a>']);
    expect(htmlToMarkdown(html, IMPROVE)).toContain('| [**bold** link](https://example.com/p "T") |');
    const link = (await applyUnchangedEcho(html)).querySelector('td a')!;
    expect([link.getAttribute('href'), link.getAttribute('title'), link.textContent, link.querySelector('strong')?.textContent])
      .toEqual(['https://example.com/p', 'T', 'bold link', 'bold']);
    expect(link.attributes).toHaveLength(2);
  });

  it('carries a declined table with multi-line code, significant whitespace and media, between its neighbours', async () => {
    const html = '<p>before</p><table><tbody><tr><th>a</th><th>b</th></tr>'
      + '<tr><td><pre><code>one\n\n**literal**\n\nlast</code></pre></td><td style="white-space: pre-wrap">a   b</td></tr>'
      + '<tr><td><img src="/attachments/x.png" alt="diagram"></td><td>z</td></tr></tbody></table><p>after</p>';
    expect(htmlToMarkdown(protectMedia(html).html, IMPROVE).split('\n').filter((line) => line.includes('<table'))).toHaveLength(1);
    const doc = await applyUnchangedEcho(html);
    expect([...doc.body.children].map((el) => [el.nodeName, el.nodeName === 'P' ? el.textContent : ''])).toEqual([
      ['P', 'before'], ['TABLE', ''], ['P', 'after'],
    ]);
    expect(doc.querySelector('td pre code')!.textContent).toBe('one\n\n**literal**\n\nlast');
    expect(doc.querySelector('td strong, td p')).toBeNull();
    const rows = doc.querySelectorAll('tr');
    expect(rows[1]!.children[1]!.textContent).toBe('a   b');
    expect(rows[1]!.children[1]!.getAttribute('style')).toBe('white-space: pre-wrap');
    expect(rows[2]!.children[0]!.querySelector('img')?.outerHTML).toBe('<img src="/attachments/x.png" alt="diagram">');
    expect(rows[2]!.children[1]!.textContent).toBe('z');
  });

  it.each([
    ['an authored minimum width', '<table style="min-width: 540px;"><colgroup><col style="min-width: 540px;"></colgroup><tbody><tr><th colspan="1" rowspan="1" align="center"><p>H</p></th></tr><tr><td colspan="1" rowspan="1" align="center"><p>b</p></td></tr></tbody></table>'],
    ['a colgroup that does not match the columns', '<table style="min-width: 25px;"><colgroup><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>a</p></th><th colspan="1" rowspan="1"><p>b</p></th></tr><tr><td colspan="1" rowspan="1"><p>1</p></td><td colspan="1" rowspan="1"><p>2</p></td></tr></tbody></table>'],
  ])('keeps %s through Apply', async (_label, html) => {
    expect((await applyUnchangedEcho(html)).querySelector('table')!.outerHTML).toBe(firstTableHtml(html));
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

  // Markdown (the Improve table rule reads the original DOM through jsdom): a table is GFM only for the plain forms;
  // for every ambiguous vector the cell is never read as aligned, whichever form the table takes.
  it.each(CELL_ALIGN_VECTORS)('htmlToMarkdown never reads %s differently from the schemas', (label, attrs, expected) => {
    const md = htmlToMarkdown(
      `<table><colgroup><col></colgroup><tbody><tr><th ${attrs}>h</th></tr><tr><td ${attrs}>c</td></tr></tbody></table>`, IMPROVE,
    ).trim();
    const marker = md.startsWith('|') ? md.split('\n')[1] : 'raw';
    const plain: Record<string, string> = {
      'align attribute': '| :-: |',
      'attribute case and whitespace': '| --: |',
      'plain style': '| :-- |',
      'style decides over the attribute': '| --: |',
    };
    if (plain[label]) expect(marker).toBe(plain[label]);
    else expect(['raw', '| --- |']).toContain(marker);
    if (expected === null) expect(marker).not.toMatch(/:/);
  });
});
