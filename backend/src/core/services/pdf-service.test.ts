import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDocumentProxy, extractText, getResolvedPDFJS } from 'unpdf';
import { generatePdf, closeBrowser } from './pdf-service.js';

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

  // ========================================================================
  // #1730 — long lines stay inside the printable width
  // ========================================================================
  //
  // Code lines were cut at 120 characters and even the kept part ran off the
  // page: pdf.js extracted 94 of 150 `x` and no SENTINEL_END. A word wider
  // than its line overflowed paragraphs and table cells the same way. These
  // assert the drawn text AND where it is drawn — every code run inside the
  // 475.28 pt code box and inside a code background on its own page — because
  // text that survives extraction can still sit outside its box.
  describe('long lines (#1730)', () => {
    // Geometry the renderer uses (pdf-service.ts constants).
    const CODE_X = 60; // CODE_TEXT_X = MARGIN_LEFT + CODE_PADDING
    const CODE_RIGHT = 535.28; // CODE_TEXT_X + CODE_TEXT_WIDTH = PAGE_WIDTH - MARGIN_RIGHT - CODE_PADDING
    const BODY_RIGHT = 545.28; // PAGE_WIDTH - MARGIN_RIGHT
    const CODE_ROW = 13.5; // FONT_SIZE_CODE + 4
    const CELL = 5.7; // one Courier cell at 9.5 pt (0.6 em)
    const CODE_BG = '#f0f2f5'; // COLOR_CODE_BG rgb(0.94, 0.95, 0.96), as pdf.js reports the fill
    const EPS = 0.01;

    interface Drawn { page: number; str: string; x: number; y: number; width: number; height: number }
    interface Box { page: number; x: number; y: number; width: number; height: number }

    /** Visible text runs (page footers excluded) and code-background rectangles; `text` has no whitespace. */
    async function layout(
      html: string,
      options: { title?: string } = {},
    ): Promise<{ text: string; items: Drawn[]; backgrounds: Box[] }> {
      const pdf = await getDocumentProxy(new Uint8Array(await generatePdf(html, options)));
      const { OPS } = await getResolvedPDFJS();
      const items: Drawn[] = [];
      const backgrounds: Box[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        for (const item of (await page.getTextContent()).items) {
          if (!('str' in item) || !item.str.trim() || /^Page \d+ of \d+$/.test(item.str)) continue;
          const [, , , , x, y] = item.transform as number[];
          items.push({ page: n, str: item.str, x: x!, y: y!, width: item.width, height: item.height });
        }
        // pdf-lib fills a rectangle as: q, rg, cm (translate), path, f, Q.
        const { fnArray, argsArray } = await page.getOperatorList();
        const saved: Array<[number, number, string]> = [];
        let [tx, ty, fill] = [0, 0, ''];
        fnArray.forEach((fn, i) => {
          const args = argsArray[i];
          if (fn === OPS.save) saved.push([tx, ty, fill]);
          else if (fn === OPS.restore) [tx, ty, fill] = saved.pop()!;
          else if (fn === OPS.setFillRGBColor) fill = args[0];
          else if (fn === OPS.transform) {
            expect(args.slice(0, 4)).toEqual([1, 0, 0, 1]); // translations only
            tx += args[4];
            ty += args[5];
          } else if (fn === OPS.constructPath && fill === CODE_BG) {
            const [minX, minY, maxX, maxY] = args[2] as number[];
            backgrounds.push({ page: n, x: tx + minX!, y: ty + minY!, width: maxX! - minX!, height: maxY! - minY! });
          }
        });
      }
      const { text } = await extractText(pdf, { mergePages: true });
      return { text: (text as string).replace(/\s+/g, ''), items, backgrounds };
    }

    /** Each run fits the printable code width and lies inside a code background on its own page. */
    function expectInsideCodeBox(items: Drawn[], backgrounds: Box[]): void {
      for (const item of items) {
        const where = `${item.str.slice(0, 16)}… on page ${item.page} at y=${item.y}`;
        expect(item.x, where).toBeGreaterThanOrEqual(CODE_X - EPS);
        expect(item.x + item.width, where).toBeLessThanOrEqual(CODE_RIGHT + EPS);
        expect(item.y, where).toBeGreaterThanOrEqual(60);
        expect(item.y + item.height, where).toBeLessThanOrEqual(841.89 - 50);
        const inside = backgrounds.some((bg) => bg.page === item.page
          && bg.x <= item.x && item.x + item.width <= bg.x + bg.width
          && bg.y <= item.y && item.y + item.height <= bg.y + bg.height);
        expect(inside, `${where} has no code background`).toBe(true);
      }
    }

    /** Where each run starts, in Courier cells from the code box's left edge. */
    const cells = (items: Drawn[]): number[] => items.map((item) => +((item.x - CODE_X) / CELL).toFixed(2));

    describe('code blocks', () => {
      const issueLine = `${'x'.repeat(150)}SENTINEL_END`;

      it('keeps all 150 x and SENTINEL_END inside the code box', async () => {
        const { text, items, backgrounds } = await layout(`<pre>${issueLine}</pre>`);
        expect(text.match(/x/g)).toHaveLength(150);
        expect(text).toContain(issueLine);
        expectInsideCodeBox(items, backgrounds);
      });

      it('continues a long line flush left after 83 Courier cells, with no marker', async () => {
        // 475.28 pt / 5.7 pt = 83 whole cells per row.
        const { items } = await layout(`<pre>${issueLine}</pre>`);
        expect(items.map((item) => item.str)).toEqual(['x'.repeat(83), `${'x'.repeat(67)}SENTINEL_END`]);
        expect(cells(items)).toEqual([0, 0]);
        expect(items[0]!.y - items[1]!.y).toBeCloseTo(CODE_ROW);
      });

      it('breaks only past 83 cells and never adds an empty row', async () => {
        const { items } = await layout(`<pre>${'a'.repeat(83)}\n${'b'.repeat(84)}\n${'c'.repeat(166)}</pre>`);
        expect(items.map((item) => item.str)).toEqual(
          ['a'.repeat(83), 'b'.repeat(83), 'b', 'c'.repeat(83), 'c'.repeat(83)],
        );
        const top = items[0]!.y;
        expect(items.map((item) => +((top - item.y) / CODE_ROW).toFixed(2))).toEqual([0, 1, 2, 3, 4]);
      });

      it('gives every wrapped row its own background entry across a page break', async () => {
        // 40 lines of 200 characters, three rows each (83 + 83 + 34); 52 rows fit on page 1.
        const lines = Array.from({ length: 40 }, (_, i) => {
          const tag = String(i).padStart(2, '0');
          return `L${tag}${'0123456789'.repeat(19)}abcdE${tag}`;
        });
        const { items, backgrounds } = await layout(`<pre>${lines.join('\n')}</pre>`);
        expect(items.map((item) => item.str)).toEqual(
          lines.flatMap((line) => [line.slice(0, 83), line.slice(83, 166), line.slice(166)]),
        );
        expectInsideCodeBox(items, backgrounds);
        // The fixture does cross a page: some line starts on one page and ends on the next.
        expect(lines.some((_, i) => items[3 * i]!.page !== items[3 * i + 2]!.page)).toBe(true);
      });

      it('keeps an empty line between wrapped rows as one blank row', async () => {
        const { items, backgrounds } = await layout(`<pre>FIRST\n\n${'y'.repeat(100)}\n\nLAST</pre>`);
        expect(items.map((item) => item.str)).toEqual(['FIRST', 'y'.repeat(83), 'y'.repeat(17), 'LAST']);
        const top = items[0]!.y;
        expect(items.map((item) => +((top - item.y) / CODE_ROW).toFixed(2))).toEqual([0, 2, 3, 5]);
        expect(backgrounds).toHaveLength(1);
        expectInsideCodeBox(items, backgrounds);
      });

      it('expands a tab to four spaces before measuring where to wrap', async () => {
        const { items, backgrounds } = await layout(`<pre>start\n\t${'w'.repeat(80)}TAIL\na\tb</pre>`);
        // '    ' + 79 w fill the 83 cells; pdf.js reports a run from its first visible glyph.
        expect(items.map((item) => item.str)).toEqual(['start', 'w'.repeat(79), 'wTAIL', 'a', 'b']);
        expect(cells(items)).toEqual([0, 4, 0, 0, 5]);
        expectInsideCodeBox(items, backgrounds);
      });

      it('splits whitespace at a row break verbatim, even inside a tab\'s expansion', async () => {
        // The tab's four spaces sit in cells 81-84: two end row 1, two open row 2.
        const { items, backgrounds } = await layout(`<pre>${'w'.repeat(81)}\tz</pre>`);
        expect(items.map((item) => item.str)).toEqual(['w'.repeat(81), 'z']);
        expect(cells(items)).toEqual([0, 2]);
        expectInsideCodeBox(items, backgrounds);
      });

      it('measures after sanitizing, so a stripped emoji neither splits nor shifts the wrap', async () => {
        const { text, items } = await layout(`<pre>${'x'.repeat(82)}\u{1F600}${'x'.repeat(3)}</pre>`);
        expect(items.map((item) => item.str)).toEqual(['x'.repeat(83), 'xx']);
        expect(text.replace(/Page\d+of\d+$/, '')).toBe('x'.repeat(85));
      });
    });

    describe('wrapped text', () => {
      it('breaks a paragraph word wider than the line and keeps the next word on its last row', async () => {
        const token = `T${'0123456789'.repeat(25)}TOKEN_END`;
        const { text, items } = await layout(`<p>Lead ${token} trail</p>`);
        expect(text).toContain(`Lead${token}trail`);
        for (const item of items) {
          expect(item.x, item.str).toBeGreaterThanOrEqual(50 - EPS);
          expect(item.x + item.width, item.str).toBeLessThanOrEqual(BODY_RIGHT + EPS);
        }
        expect(items[0]!.str).toBe('Lead');
        expect(items.at(-1)!.str).toMatch(/TOKEN_END trail$/);
      });

      it('keeps a long token inside its table column', async () => {
        const hash = `${'0123456789abcdef'.repeat(8)}HASH_END`;
        const { text, items } = await layout(
          `<table><tr><th>Key</th><th>Value</th></tr><tr><td>${hash}</td><td>right</td></tr></table>`,
        );
        expect(text).toContain(hash);
        // Two 247.64 pt columns from x = 50; cell text keeps 6 pt padding on both sides.
        for (const item of items.filter((i) => i.x < 50 + 247.64)) {
          expect(item.x + item.width, item.str).toBeLessThanOrEqual(50 + 247.64 - 6 + EPS);
        }
        expect(items.find((item) => item.str === 'right')!.x).toBeCloseTo(50 + 247.64 + 6);
      });

      it('measures wrapped lines as drawn, without kerning', async () => {
        // Helvetica's AFM kerns A-V/V-A by -70/-80 per mille. widthOfTextAtSize subtracts that,
        // but pdf-lib draws with Tj, which never applies it: three of these words measure
        // 477.62 pt kerned and are drawn 534.38 pt wide.
        const words = Array.from({ length: 6 }, () => 'AV'.repeat(12));
        const { text, items } = await layout(`<p>${words.join(' ')}</p>`);
        expect(text).toContain(words.join(''));
        for (const item of items) {
          expect(item.x + item.width, item.str).toBeLessThanOrEqual(BODY_RIGHT + EPS);
        }
      });

      it('counts the space between words, so a line of short words stays inside the margin', async () => {
        // At 11 pt 'a' is 6.116 pt and a space 3.058 pt: 54 words fill 492.34 of 495.28 pt, 55 would not.
        const { text, items } = await layout(`<p>${'a '.repeat(300)}</p>`);
        expect(text).toContain('a'.repeat(300));
        expect(items.map((item) => item.str.split(' ').length)).toEqual([54, 54, 54, 54, 54, 30]);
        for (const item of items) {
          expect(item.x + item.width, item.str).toBeLessThanOrEqual(BODY_RIGHT + EPS);
        }
      });

      it('stacks one character per line in a column narrower than a glyph', async () => {
        // 45 columns leave each cell 495.28 / 45 - 2 * 6 = -0.99 pt to wrap in.
        const row = ['<td>ABCD</td>', ...Array.from({ length: 44 }, () => '<td></td>')].join('');
        const { text, items } = await layout(`<table><tr>${row}</tr></table>`);
        expect(text).toContain('ABCD');
        expect(items.map((item) => item.str)).toEqual(['A', 'B', 'C', 'D']);
        // First baseline: 781.89 page top - 4 table offset - 6 cell padding - 11 font size; 14 pt pitch.
        expect(items.map((item) => +item.y.toFixed(2))).toEqual([760.89, 746.89, 732.89, 718.89]);
      });

      it('centres a wrapped cover title by its drawn width', async () => {
        // Two 16-letter A/V words fill 495.05 of 495.28 pt in bold 22 pt; kerning would claim 442.24 pt.
        const title = Array.from({ length: 6 }, () => 'AV'.repeat(8)).join(' ');
        const { items } = await layout('<p>body</p>', { title });
        const titleLines = items.filter((item) => /^[AV ]+$/.test(item.str));
        expect(titleLines.map((item) => item.str).join(' ')).toBe(title);
        for (const item of titleLines) {
          expect(item.x, item.str).toBeGreaterThanOrEqual(50 - EPS);
          expect(item.x + item.width, item.str).toBeLessThanOrEqual(BODY_RIGHT + EPS);
          expect(item.x, `${item.str} is centred`).toBeCloseTo(595.28 - (item.x + item.width));
        }
      });
    });
  });

  describe('closeBrowser', () => {
    it('should be a no-op (pdf-lib has no browser)', async () => {
      await expect(closeBrowser()).resolves.toBeUndefined();
    });
  });
});
