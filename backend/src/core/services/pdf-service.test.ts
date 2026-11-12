import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDocumentProxy, extractText } from 'unpdf';
import { generatePdf, closeBrowser } from './pdf-service.js';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream, type PDFObject } from 'pdf-lib';

describe('pdf-service (pdf-lib)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generatePdf', () => {
    it('should generate a valid PDF buffer from HTML content', async () => {
      const html = '<p>Hello, World!</p>';
      const result = await generatePdf(html, { title: 'Test Article' });

      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeGreaterThan(100);
      // PDF magic bytes
      expect(result.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('should include a cover page when title is provided', async () => {
      const result = await generatePdf('<p>Content</p>', { title: 'My Title' });

      expect(result).toBeInstanceOf(Buffer);
      // With title: cover page + content page = at least 2 pages
      expect(result.length).toBeGreaterThan(200);
    });

    it('should render without cover page when no title is provided', async () => {
      const result = await generatePdf('<p>Content only</p>', {});

      expect(result).toBeInstanceOf(Buffer);
      expect(result.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('should handle headings', async () => {
      const html = '<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>';
      const result = await generatePdf(html, {});

      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeGreaterThan(100);
    });

    it('should handle code blocks', async () => {
      const html = '<pre><code>const x = 1;\nconsole.log(x);</code></pre>';
      const result = await generatePdf(html, {});

      expect(result).toBeInstanceOf(Buffer);
    });

    it('should handle tables', async () => {
      const html = '<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>';
      const result = await generatePdf(html, {});

      expect(result).toBeInstanceOf(Buffer);
    });

    it('paginates oversized rows without losing text or shifting columns', async () => {
      const sentences = Array.from({ length: 500 }, (_, i) =>
        `Sentence${String(i).padStart(3, '0')} is ordinary readable prose.`,
      );
      const html = `<table><thead><tr><th>First column</th><th>Second column</th></tr></thead>
        <tbody><tr><td>${sentences.join(' ')}</td><td>Column marker</td></tr>
        <tr><td>Following row</td><td>Following value</td></tr></tbody></table>`;
      const pdf = await getDocumentProxy(new Uint8Array(await generatePdf(html, {})));
      expect(pdf.numPages).toBeGreaterThan(2);
      const text: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const items = content.items.filter((item) => 'str' in item && item.str.trim());
        const strings = items.map((item) => 'str' in item ? item.str : '');
        text.push(strings.join(' '));
        expect(strings.join(' ')).toContain('First column');
        expect(strings.join(' ')).toContain('Second column');
        for (const item of items) {
          if (!('str' in item) || item.str.startsWith('Page ')) continue;
          expect(item.transform[5]).toBeGreaterThanOrEqual(60);
          expect(item.transform[5] + item.height).toBeLessThanOrEqual(841.89 - 50);
          if (item.str.includes('Sentence')) expect(item.transform[4]).toBeCloseTo(56);
          if (item.str.includes('Second column') || item.str.includes('Column marker')) {
            expect(item.transform[4]).toBeCloseTo(303.64);
          }
        }
      }
      const all = text.join(' ');
      for (const sentence of sentences) expect(all).toContain(sentence);
      expect(all).toContain('Following row');
      expect(all).toContain('Following value');
    });

    it('should handle lists', async () => {
      const html = '<ul><li>Item 1</li><li>Item 2</li></ul><ol><li>First</li><li>Second</li></ol>';
      const result = await generatePdf(html, {});

      expect(result).toBeInstanceOf(Buffer);
    });

    it('should handle blockquotes', async () => {
      const html = '<blockquote>This is a quote</blockquote>';
      const result = await generatePdf(html, {});

      expect(result).toBeInstanceOf(Buffer);
    });

    it('should handle empty HTML', async () => {
      const result = await generatePdf('', {});

      expect(result).toBeInstanceOf(Buffer);
      expect(result.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('should handle complex mixed content', async () => {
      const html = `
        <h1>Report</h1>
        <p>This is an introduction paragraph.</p>
        <h2>Data</h2>
        <table>
          <tr><th>Metric</th><th>Value</th></tr>
          <tr><td>Users</td><td>1000</td></tr>
        </table>
        <h2>Code Example</h2>
        <pre>function hello() { return "world"; }</pre>
        <blockquote>Important note here</blockquote>
        <ul><li>Point one</li><li>Point two</li></ul>
      `;
      const result = await generatePdf(html, { title: 'Full Report' });

      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeGreaterThan(500);
    });

    it('should handle XSS-like content safely', async () => {
      const html = '<p><script>alert("xss")</script>Safe text</p>';
      const result = await generatePdf(html, { title: '<script>alert("xss")</script>' });

      expect(result).toBeInstanceOf(Buffer);
    });
  });

  // ========================================================================
  // #1227 — expand sections keep a title row in the export
  // ========================================================================
  //
  // An untitled section stores no `title` parameter, and the label the app
  // shows for one is a ProseMirror decoration — neither reaches a server-side
  // pdf-lib render. Without a fallback here the section printed with no header
  // row at all and its body ran straight on from the preceding paragraph.
  //
  // These assert the rendered TEXT rather than the buffer's shape: a label
  // that is computed but never drawn is exactly the failure worth catching.
  describe('expand sections (#1227)', () => {
    async function pdfText(html: string): Promise<string> {
      const buffer = await generatePdf(html, {});
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return (text as string).replace(/\s+/g, ' ');
    }

    it('labels an untitled native expand with Confluence\'s own default', async () => {
      const text = await pdfText(
        '<details data-macro-name="expand"><summary></summary><p>Section body</p></details>',
      );
      expect(text).toContain('Click here to expand...');
      expect(text).toContain('Section body');
    });

    it('labels an untitled ui-expand with Refined\'s string, which has no ellipsis', async () => {
      const text = await pdfText(
        '<details data-macro-name="ui-expand"><summary></summary><p>B</p></details>',
      );
      expect(text).toContain('Click here to expand');
      expect(text).not.toContain('Click here to expand...');
    });

    it('falls back to a generic label for an unstamped section', async () => {
      const text = await pdfText('<details><summary></summary><p>B</p></details>');
      expect(text).toContain('Click to expand');
    });

    it('prints a real title and no default label', async () => {
      const text = await pdfText(
        '<details data-macro-name="expand"><summary>Release notes</summary><p>B</p></details>',
      );
      expect(text).toContain('Release notes');
      expect(text).not.toContain('Click here to expand');
    });
  });

  describe('closeBrowser', () => {
    it('should be a no-op (pdf-lib has no browser)', async () => {
      await expect(closeBrowser()).resolves.toBeUndefined();
    });
  });

  // ========================================================================
  // #1729 — non-Latin text survives the export
  // ========================================================================
  //
  // Text was run through a WinAnsi sanitizer for the four standard fonts,
  // which deleted every character outside Latin-1: the issue's
  // `<p>ASCII Установка 手順 łść ğ</p>` exported as 'ASCII'. These assert the
  // extracted text AND which vendored font draws each run where — a run in
  // the wrong font, or a glyph drawn as an empty box, still extracts.
  describe('non-Latin text (#1729)', () => {
    const ISSUE = 'ASCII Установка 手順 łść ğ';
    const FONT_DIR = join(import.meta.dirname, 'fonts');
    const BODY_RIGHT = 545.28; // PAGE_WIDTH - MARGIN_RIGHT
    const EPS = 0.01;

    interface Run { page: number; str: string; font: string; x: number; y: number; width: number }

    /** Visible runs (page footers excluded) with the font each is drawn in; `text` has its whitespace collapsed. */
    async function drawn(html: string, options: { title?: string } = {}): Promise<{ text: string; runs: Run[]; pdf: Uint8Array }> {
      const pdf = new Uint8Array(await generatePdf(html, options));
      const doc = await getDocumentProxy(pdf.slice());
      const runs: Run[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const { items } = await page.getTextContent();
        await page.getOperatorList(); // loads the page's fonts into commonObjs
        for (const item of items) {
          if (!('str' in item) || !item.str.trim() || /^Page \d+ of \d+$/.test(item.str)) continue;
          // pdf-lib names an embedded font `<PostScript name>-<random suffix>`.
          const loaded: unknown = page.commonObjs.get(item.fontName);
          const name = loaded && typeof loaded === 'object' && 'name' in loaded ? String(loaded.name) : '';
          const [, , , , x, y] = item.transform as number[];
          runs.push({ page: n, str: item.str, font: name.replace(/-\d+$/, ''), x: x!, y: y!, width: item.width });
        }
      }
      const { text } = await extractText(doc, { mergePages: true });
      return { text: (text as string).replace(/Page \d+ of \d+/g, '').replace(/\s+/g, ' ').trim(), runs, pdf };
    }

    /** Each run as [text, font, x]. */
    const at = (runs: Run[]): Array<[string, string, number]> => runs.map((run) => [run.str, run.font, +run.x.toFixed(2)]);

    interface EmbeddedFont { name: string; bytes: number; glyphs: Array<{ char: string; inked: boolean; sameOutline: boolean }> }

    /** Every embedded font program, and per ToUnicode entry whether its glyph has the vendored font's outline for that character. */
    async function embeddedFonts(pdf: Uint8Array): Promise<EmbeddedFont[]> {
      const doc = await PDFDocument.load(pdf);
      const streamBytes = (ref: PDFObject | undefined): Uint8Array => {
        const stream = doc.context.lookup(ref);
        if (!(stream instanceof PDFRawStream)) throw new Error('expected a stream');
        return decodePDFRawStream(stream).decode();
      };
      const fonts: EmbeddedFont[] = [];
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
        const name = obj.get(PDFName.of('BaseFont'))!.toString().slice(1).replace(/-\d+$/, '');
        const cidFont = doc.context.lookup(doc.context.lookup(obj.get(PDFName.of('DescendantFonts')), PDFArray).get(0), PDFDict);
        const descriptor = doc.context.lookup(cidFont.get(PDFName.of('FontDescriptor')), PDFDict);
        const program = streamBytes(descriptor.get(PDFName.of('FontFile2')));
        const cmap = new TextDecoder().decode(streamBytes(obj.get(PDFName.of('ToUnicode'))));
        const subset = fontkit.create(program);
        const vendored = fontkit.create(readFileSync(join(FONT_DIR, `${name}.ttf`)));
        const glyphs = [...cmap.matchAll(/<([0-9A-F]+)> <([0-9A-F]+)>/g)].map(([, glyphId, utf16]) => {
          const char = String.fromCharCode(...utf16!.match(/.{4}/g)!.map((unit) => parseInt(unit, 16)));
          const outline = subset.getGlyph(parseInt(glyphId!, 16)).path.toSVG();
          return { char, inked: outline !== '', sameOutline: outline === vendored.glyphForCodePoint(char.codePointAt(0)!).path.toSVG() };
        });
        fonts.push({ name, bytes: program.length, glyphs });
      }
      return fonts;
    }

    it('keeps the issue\'s Cyrillic, CJK and Latin Extended text in the body', async () => {
      const { text, runs } = await drawn(`<p>${ISSUE}</p>`);
      expect(text).toBe(ISSUE);
      // Each run starts where the previous one ended (plus a 2.86 pt space): measured as drawn.
      expect(at(runs)).toEqual([
        ['ASCII Установка', 'NotoSans-Regular', 50], ['手順', 'NotoSansSC-Regular', 138.08], ['łść ğ', 'NotoSans-Regular', 162.94],
      ]);
    });

    it('prints a non-Latin title on the cover page, centred', async () => {
      const { runs } = await drawn('', { title: ISSUE });
      const title = runs.filter((run) => run.page === 1 && !/\d{4}$/.test(run.str));
      expect(title.map((run) => run.str).join(' ')).toBe(ISSUE);
      expect(at(title)).toEqual([
        ['ASCII Установка', 'NotoSans-Bold', 154.5], ['手順', 'NotoSansSC-Regular', 342.33], ['łść ğ', 'NotoSans-Bold', 392.05],
      ]);
      expect(title[0]!.x).toBeCloseTo(595.28 - (title.at(-1)!.x + title.at(-1)!.width));
    });

    it('wraps a cover title at the content width, not the page width', async () => {
      // Two 16-letter A/V words fill 478.10 of 495.28 pt in Noto Sans Bold 22 pt. The closing `A`
      // (15.22 pt) only fits on its own line at the content width; at any wrap width from 499.05 pt
      // (the page width, or the page width minus one margin) it joins the third line, which then
      // starts at x 48.12.
      const word = 'AV'.repeat(8);
      const title = `${Array(6).fill(word).join(' ')} A`;
      const { runs } = await drawn('<p>body</p>', { title });
      const lines = runs.filter((run) => run.page === 1 && /^[AV ]+$/.test(run.str));
      expect(lines.map((run) => run.str)).toEqual([`${word} ${word}`, `${word} ${word}`, `${word} ${word}`, 'A']);
      for (const run of lines) {
        expect(run.x, run.str).toBeGreaterThanOrEqual(50 - EPS);
        expect(run.x + run.width, run.str).toBeLessThanOrEqual(BODY_RIGHT + EPS);
        expect(run.x, `${run.str} is centred`).toBeCloseTo(595.28 - (run.x + run.width));
      }
    });

    it('keeps non-Latin text in headings and list items', async () => {
      const { text, runs } = await drawn('<h2>Установка 手順</h2><ul><li>Сервер 한국어</li></ul><ol><li>手順 ğ</li></ol>');
      expect(text).toBe('Установка 手順 • Сервер 한국어 1. 手順 ğ');
      expect(at(runs)).toEqual([
        ['Установка', 'NotoSans-Bold', 50], ['手順', 'NotoSansSC-Regular', 151.07],
        ['•', 'NotoSans-Bold', 54], ['Сервер', 'NotoSans-Regular', 70], ['한국어', 'NotoSansKR-Regular', 111.6],
        ['1.', 'NotoSans-Regular', 54], ['手順', 'NotoSansSC-Regular', 70], ['ğ', 'NotoSans-Regular', 94.86],
      ]);
    });

    it('labels an image with its non-Latin alt text instead of dropping the label', async () => {
      // The label used to be drawn inside a try/catch that dropped it when the alt could not be encoded.
      const { runs } = await drawn('<img alt="Установка 手順 😀"><img alt="Install">');
      expect(at(runs)).toEqual([
        ['[Image: Установка', 'NotoSans-Italic', 240.78], ['手順', 'NotoSansSC-Regular', 322.55], ['\uFFFD]', 'NotoSans-Italic', 342.89],
        ['[Image: Install]', 'NotoSans-Italic', 267.53],
      ]);
      // Centred in the content width, measured across its fonts.
      expect(runs[0]!.x - 50).toBeCloseTo(545.28 - (runs[2]!.x + runs[2]!.width));
    });

    it('draws a code block in Noto Sans Mono, with fallbacks for what it lacks', async () => {
      const code = `${ISSUE} → ≤ ─ ✓`;
      const { text, runs } = await drawn(`<pre>${code}</pre>`);
      expect(text).toBe(code);
      // 5.7 pt Mono cells from x 60; CJK and ✓ come from Noto Sans SC.
      expect(at(runs)).toEqual([
        ['ASCII', 'NotoSansMono-Regular', 60], ['Установка', 'NotoSansMono-Regular', 94.2], ['手順', 'NotoSansSC-Regular', 151.2],
        ['łść ğ → ≤ ─', 'NotoSansMono-Regular', 175.9], ['✓', 'NotoSansSC-Regular', 244.3],
      ]);
    });

    it('draws non-Latin table cells, and drops no cell text', async () => {
      // Cells used to be drawn inside a try/catch that skipped what could not be encoded; it is gone,
      // and a character no font covers is drawn as U+FFFD.
      const { text, runs } = await drawn(
        `<table><tr><th>Параметр</th><th>手順</th></tr><tr><td>${ISSUE}</td><td>ع😀✔</td></tr></table>`,
      );
      expect(text).toBe(`Параметр 手順 ${ISSUE} \uFFFD\uFFFD\uFFFD`);
      expect(at(runs)).toEqual([
        ['Параметр', 'NotoSans-Bold', 56], ['手順', 'NotoSansSC-Regular', 303.64],
        ['ASCII Установка', 'NotoSans-Regular', 56], ['手順', 'NotoSansSC-Regular', 144.08], ['łść ğ', 'NotoSans-Regular', 168.94],
        ['\uFFFD\uFFFD\uFFFD', 'NotoSans-Regular', 303.64],
      ]);
    });

    it('draws a word no bundled font covers as U+FFFD, and never skips it', async () => {
      // wrapText used to skip a word whose measurement threw; measuring now never throws, and each
      // code point no bundled font covers is drawn as U+FFFD in the style's face.
      const { text, runs } = await drawn(
        '<h3>عربي</h3><p>Arabic عربي Hebrew עברית Thai ไทย emoji 😀 check ✔</p><table><tr><td>हिन्दी</td></tr></table>',
      );
      const fffd = (word: string): string => '\uFFFD'.repeat([...word].length);
      expect(text).toBe(`${fffd('عربي')} Arabic ${fffd('عربي')} Hebrew ${fffd('עברית')} Thai ${fffd('ไทย')} emoji \uFFFD check \uFFFD ${fffd('हिन्दी')}`);
      expect(at(runs)).toEqual([
        [fffd('عربي'), 'NotoSans-Bold', 50],
        [`Arabic ${fffd('عربي')} Hebrew ${fffd('עברית')} Thai ${fffd('ไทย')} emoji \uFFFD check \uFFFD`, 'NotoSans-Regular', 50],
        [fffd('हिन्दी'), 'NotoSans-Regular', 56],
      ]);
    });

    it('draws nothing for controls and other invisible code points', async () => {
      const { text } = await drawn('<p>soft\u00ADhyphen zero\u200Bwidth joiner\u200Dhere variation\uFE0F bom\uFEFF bell\u0007</p>');
      expect(text).toBe('softhyphen zerowidth joinerhere variation bom bell');
    });

    it('keeps the symbols Noto Sans lacks, drawn by a fallback font', async () => {
      const symbols = '→ ← ✓ ≤ ≥ ∑ ─ ■ □ — – … ‘’ “” •';
      const { text, runs } = await drawn(`<p>${symbols}</p>`);
      expect(text).toBe(symbols);
      expect(at(runs)).toEqual([
        ['→', 'NotoSansMono-Regular', 50], ['←', 'NotoSansMono-Regular', 59.46], ['✓', 'NotoSansSC-Regular', 68.92],
        ['≤', 'NotoSansMono-Regular', 79.29], ['≥', 'NotoSansMono-Regular', 88.75], ['∑', 'NotoSansSC-Regular', 98.21],
        ['─', 'NotoSansMono-Regular', 112.07], ['■', 'NotoSansMono-Regular', 121.53], ['□', 'NotoSansMono-Regular', 130.99],
        ['— – … ‘’ “” •', 'NotoSans-Regular', 140.45],
      ]);
    });

    it('measures each run in the font that draws it, so mixed-script lines wrap inside the margin', async () => {
      // `手順手順手順手順` is 88 pt in Noto Sans SC; measured in Noto Sans (its 600-unit empty box per
      // character) it would claim 52.8 pt, and four more words would join each line.
      const words = Array.from({ length: 24 }, (_, i) => (i % 2 ? '手順手順手順手順' : 'Setup'));
      const { text, runs } = await drawn(`<p>${words.join(' ')}</p>`);
      expect(text).toBe(words.join(' '));
      for (const run of runs) expect(run.x + run.width, run.str).toBeLessThanOrEqual(BODY_RIGHT + EPS);
      const line = [50, 82.64, 173.5, 206.13, 296.99, 329.63, 420.49, 453.13];
      expect(runs.map((run) => +run.x.toFixed(2))).toEqual([...line, ...line, ...line]);
      expect(runs.map((run) => +run.y.toFixed(2))).toEqual([...Array(8).fill(781.89), ...Array(8).fill(765.89), ...Array(8).fill(749.89)]);
    });

    it('exports a blockquote whose text is entirely non-Latin, emoji or control characters', async () => {
      const { text, runs } = await drawn('<blockquote>Установка</blockquote><blockquote>😀</blockquote><blockquote>\u0007</blockquote><p>after</p>');
      expect(text).toBe('Установка \uFFFD after');
      expect(at(runs)).toEqual([['Установка', 'NotoSans-Italic', 66], ['\uFFFD', 'NotoSans-Italic', 66], ['after', 'NotoSans-Regular', 50]]);
    });

    it('keeps a surrogate pair whole: one glyph, or one placeholder, per astral character', async () => {
      // U+20087 is in Noto Sans SC; U+1F600 is in no bundled font.
      const { text, runs } = await drawn('<p>ext-B 𠂇 emoji 😀</p><pre>ext-B 𠂇 emoji 😀</pre>');
      expect(text).toBe('ext-B 𠂇 emoji \uFFFD ext-B 𠂇 emoji \uFFFD');
      expect(at(runs.filter((run) => run.str.includes('𠂇')))).toEqual([['𠂇', 'NotoSansSC-Regular', 79.55], ['𠂇', 'NotoSansSC-Regular', 94.2]]);
    });

    it('keeps a surrogate pair whole at a code row\'s end', async () => {
      // A code row ends after 120 code points on a tree without #1730's wrapping, and at 83 Mono
      // cells with it. In the first line 117 zero-width spaces put U+20087 (Noto Sans SC) across the
      // 120th UTF-16 unit without moving it off the page; in the second it ends the first wrapped row.
      // Split into its two halves, it would draw two U+FFFD.
      const code = `${'\u200B'.repeat(117)}xx\u{20087}\n${'x'.repeat(81)}\u{20087}xxx`;
      const { text } = await drawn(`<pre>${code}</pre>`);
      expect([...text.matchAll(/\u{20087}/gu)]).toHaveLength(2);
      expect(text).not.toContain('\uFFFD');
    });

    it('separates words that only a newline separates, as HTML does', async () => {
      const { runs } = await drawn(
        '<h2>Getting\nStarted</h2><table><tr><td>first\nsecond</td></tr></table><blockquote>quoted\nlines</blockquote><div>bare\ntext</div>',
        { title: 'Release\nnotes' },
      );
      const lines = runs.filter((run) => !/\d{4}$/.test(run.str));
      expect(lines.map((run) => run.str)).toEqual(['Release notes', 'Getting Started', 'first second', 'quoted lines', 'bare text']);
      expect(lines.slice(1).map((run) => +run.x.toFixed(2))).toEqual([50, 56, 66, 50]);
    });

    it('draws every character with the vendored font\'s outline, never an empty box', async () => {
      const fixture = `${ISSUE} 한국어 → ✓ ∑ 😀`;
      const { pdf } = await drawn(`<h1>${fixture}</h1><p>${fixture}</p><pre>${fixture}</pre><blockquote>${fixture}</blockquote>`, { title: fixture });
      const glyphs = (await embeddedFonts(pdf)).flatMap((font) => font.glyphs.map((glyph) => ({ font: font.name, ...glyph })));
      expect(glyphs.filter((glyph) => !glyph.sameOutline || (!glyph.inked && glyph.char.trim()))).toEqual([]);
      const drawnChars = new Set(glyphs.map((glyph) => glyph.char));
      expect([...new Set(`${fixture.replace(/\s|😀/gu, '')}\uFFFD`)].filter((char) => !drawnChars.has(char))).toEqual([]);
    });

    it('embeds each font as a subset, and Noto Sans SC and KR only for characters that need them', async () => {
      const latin = await embeddedFonts((await drawn('<p>Hello</p>')).pdf);
      const cjk = await embeddedFonts((await drawn('<p>手順 한국어</p>')).pdf);
      const faces = ['NotoSans-Regular', 'NotoSans-Bold', 'NotoSans-Italic', 'NotoSansMono-Regular'];
      expect(latin.map((font) => font.name)).toEqual(faces);
      expect(cjk.map((font) => font.name)).toEqual([...faces, 'NotoSansSC-Regular', 'NotoSansKR-Regular']);
      // A subset holds the glyphs drawn: under 1 % of the vendored file, which a batch export repeats per article.
      for (const font of [...latin, ...cjk]) {
        expect(font.bytes, font.name).toBeLessThan(readFileSync(join(FONT_DIR, `${font.name}.ttf`)).length / 100);
      }
    });

    it('draws a glyph wider than its table column whole, on the cell\'s first line', async () => {
      // U+2E3B THREE-EM DASH is 31.24 pt at 11 pt, wider than a 14-column cell's 23.38 pt text box:
      // the only bundled glyph that is. It gets the cell's first line, unbroken, and extends past the box.
      const row = ['<td>⸻</td>', ...Array.from({ length: 13 }, () => '<td></td>')].join('');
      const { text, runs } = await drawn(`<table><tr>${row}</tr></table>`);
      expect(text).toBe('⸻');
      // First baseline: 781.89 page top - 4 table offset - 6 cell padding - 11 font size.
      expect(runs.map((run) => [run.str, +run.x.toFixed(2), +run.y.toFixed(2), +run.width.toFixed(2)])).toEqual([['⸻', 56, 760.89, 31.24]]);
    });

    it('keeps sequential exports apart: a later document extracts as drawn', async () => {
      // pdf-lib parses each embedded font per document. A parsed font shared across documents keeps
      // the glyph objects an earlier subset created for accent components (the c of ć) without their
      // code points, and a later document's plain c then extracts as a control character. A fresh
      // module instance makes these the process's first exports, whatever ran before.
      vi.resetModules();
      const fresh = await import('./pdf-service.js');
      const textOf = async (html: string): Promise<string> => {
        const { text } = await extractText(await getDocumentProxy(new Uint8Array(await fresh.generatePdf(html, {}))), { mergePages: true });
        return (text as string).replace(/Page \d+ of \d+/g, '').trim();
      };
      expect(await textOf('<p>ć ś ż ń ó ę ą</p>')).toBe('ć ś ż ń ó ę ą');
      expect(await textOf('<p>arabic c s z n o e a</p>')).toBe('arabic c s z n o e a');
    });

    it('merges exports into one PDF that extracts every article, as the batch export does', async () => {
      // routes/knowledge/pages-export.ts: one document per article, pages copied into one PDF.
      const articles = [ISSUE, '한국어 문서 — Сервер', 'Plain ASCII → ✓'];
      const merged = await PDFDocument.create();
      for (const body of articles) {
        const article = await PDFDocument.load(await generatePdf(`<p>${body}</p>`, { title: body }));
        for (const page of await merged.copyPages(article, article.getPageIndices())) merged.addPage(page);
      }
      const { text } = await extractText(await getDocumentProxy(await merged.save()), { mergePages: true });
      const all = (text as string).replace(/\s+/g, ' ');
      for (const body of articles) expect(all.split(body)).toHaveLength(3); // each title and body
    });

    it('renders decomposed Latin and conjoining Hangul as composed glyphs', async () => {
      // NFC first: e + U+0301, e + U+0323 + U+0302, u + U+0306 and the jamo U+1112 U+1161 U+11AB
      // become é, ệ, ŭ and 한, which the fonts draw as single glyphs (pdf-lib positions no marks).
      const { text, runs } = await drawn('<p>e\u0301 e\u0323\u0302 u\u0306 \u1112\u1161\u11AB</p>');
      expect(text).toBe('é ệ ŭ 한');
      expect(at(runs)).toEqual([['é ệ ŭ', 'NotoSans-Regular', 50], ['한', 'NotoSansKR-Regular', 77.79]]);
    });
  });
});
