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
  // #1731 — tables keep every cell on a span-aware logical grid
  // ========================================================================
  //
  // The column count came from the first row's cells, ignoring colspan, so a
  // spanning header made a one-column table and every later cell of each row
  // was never drawn ('Heading Alpha', no Bravo, no Charlie). These assert where
  // each cell is drawn and where the borders run: a cell drawn in the wrong
  // column, or crossed by a border, still extracts.
  describe('table grid (#1731)', () => {
    // Geometry the renderer uses (pdf-service.ts constants).
    const LEFT = 50; // MARGIN_LEFT
    const WIDTH = 495.28; // CONTENT_WIDTH
    const PAD = 6; // TABLE_CELL_PADDING
    const BORDER = '#bfc7d1'; // COLOR_TABLE_BORDER rgb(0.75, 0.78, 0.82), as pdf.js reports the stroke
    const SHADE = '#f5f7fa'; // COLOR_TABLE_HEADER_BG rgb(0.96, 0.97, 0.98), as pdf.js reports the fill
    const EPS = 0.01;

    interface Run { page: number; str: string; x: number; y: number; width: number; height: number }
    interface Rule { page: number; x: number; bottom: number; top: number }
    interface Edge { page: number; y: number; left: number; right: number }

    /** Visible text runs (page footers excluded), border lines, header backgrounds, and the text without whitespace or footers. */
    async function tableLayout(html: string): Promise<{
      text: string; runs: Run[]; verticals: Rule[]; horizontals: Edge[]; shades: number; pages: number;
    }> {
      const pdf = await getDocumentProxy(new Uint8Array(await generatePdf(html, {})));
      const { OPS } = await getResolvedPDFJS();
      const runs: Run[] = [];
      const verticals: Rule[] = [];
      const horizontals: Edge[] = [];
      let shades = 0;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        for (const item of (await page.getTextContent()).items) {
          if (!('str' in item) || !item.str.trim() || /^Page \d+ of \d+$/.test(item.str)) continue;
          const [, , , , x, y] = item.transform as number[];
          runs.push({ page: n, str: item.str, x: x!, y: y!, width: item.width, height: item.height });
        }
        // pdf-lib strokes each border as q, RG, w, m, l, S, Q (absolute coordinates)
        // and fills a header background as q, rg, cm, re, f, Q.
        const { fnArray, argsArray } = await page.getOperatorList();
        let [stroke, fill] = ['', ''];
        fnArray.forEach((fn, i) => {
          const args = argsArray[i];
          if (fn === OPS.setStrokeRGBColor) stroke = args[0];
          else if (fn === OPS.setFillRGBColor) fill = args[0];
          else if (fn === OPS.constructPath && args[0] === OPS.fill && fill === SHADE) shades++;
          else if (fn === OPS.constructPath && args[0] === OPS.stroke && stroke === BORDER) {
            const [minX, minY, maxX, maxY] = args[2] as number[];
            if (minX === maxX) verticals.push({ page: n, x: minX!, bottom: minY!, top: maxY! });
            else if (minY === maxY) horizontals.push({ page: n, y: minY!, left: minX!, right: maxX! });
          }
        });
      }
      const { text: raw } = await extractText(pdf, { mergePages: true });
      const text = (raw as string).replace(/Page \d+ of \d+/g, '').replace(/\s+/g, '');
      return { text, runs, verticals, horizontals, shades, pages: pdf.numPages };
    }

    /** x of the vertical borders through a run's row, left to right. */
    const bordersAt = (verticals: Rule[], run: Run): number[] => [...new Set(verticals
      .filter((rule) => rule.page === run.page && rule.bottom <= run.y && run.y <= rule.top)
      .map((rule) => +rule.x.toFixed(2)))].sort((a, b) => a - b);

    /** No vertical border lies strictly inside a run's horizontal extent on its row. */
    function expectNoBorderThrough(runs: Run[], verticals: Rule[]): void {
      for (const run of runs) {
        for (const x of bordersAt(verticals, run)) {
          expect(x > run.x + EPS && x < run.x + run.width - EPS, `border at ${x} through ${run.str} at ${run.x}`).toBe(false);
        }
      }
    }

    /** Each run as [text, x]. */
    const at = (runs: Run[]): Array<[string, number]> => runs.map((run) => [run.str, +run.x.toFixed(2)]);

    it('keeps Bravo and Charlie after a header that spans three columns', async () => {
      const { text, runs, verticals } = await tableLayout(
        '<table><tr><th colspan="3">Heading</th></tr><tr><td>Alpha</td><td>Bravo</td><td>Charlie</td></tr></table>',
      );
      expect(text).toBe('HeadingAlphaBravoCharlie');
      expect(at(runs)).toEqual([['Heading', 56], ['Alpha', 56], ['Bravo', 221.09], ['Charlie', 386.19]]);
      // The header row has borders only at the table's edges; the body row at every column.
      expect(bordersAt(verticals, runs[0]!)).toEqual([50, 545.28]);
      expect(bordersAt(verticals, runs[1]!)).toEqual([50, 215.09, 380.19, 545.28]);
    });

    it('widens the grid to a body row with more cells than the header', async () => {
      const { text, runs, verticals } = await tableLayout(
        '<table><tr><th>One</th><th>Two</th></tr><tr><td>a</td><td>b</td><td>c</td><td>d</td></tr></table>',
      );
      expect(text).toBe('OneTwoabcd');
      expect(at(runs)).toEqual([['One', 56], ['Two', 179.82], ['a', 56], ['b', 179.82], ['c', 303.64], ['d', 427.46]]);
      // The header row ends in two empty cells.
      expect(bordersAt(verticals, runs[0]!)).toEqual([50, 173.82, 297.64, 421.46, 545.28]);
    });

    it('wraps a spanning body cell across its columns and draws no border through it', async () => {
      const words = 'This body cell spans the first two columns and wraps only at their combined width';
      const { text, runs, verticals } = await tableLayout(
        `<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan="2">${words}</td><td>Charlie</td></tr></table>`,
      );
      expect(text).toBe(`ABC${words.replace(/\s+/g, '')}Charlie`);
      const span = runs.filter((run) => !['A', 'B', 'C', 'Charlie'].includes(run.str));
      expect(span.map((run) => run.str).join(' ')).toBe(words);
      expect(span.length).toBeGreaterThan(1);
      // Wider than one column's text box, and inside the two columns' box.
      expect(Math.max(...span.map((run) => run.width))).toBeGreaterThan(WIDTH / 3 - 2 * PAD);
      for (const run of span) {
        expect(run.x).toBeCloseTo(LEFT + PAD);
        expect(run.x + run.width, run.str).toBeLessThanOrEqual(LEFT + (2 * WIDTH) / 3 - PAD + EPS);
        expect(bordersAt(verticals, run)).toEqual([50, 380.19, 545.28]);
      }
      expect(at(runs.filter((run) => run.str === 'Charlie'))).toEqual([['Charlie', 386.19]]);
      expectNoBorderThrough(runs, verticals);
    });

    it('repeats a spanning header on every continuation page', async () => {
      const sentences = Array.from({ length: 500 }, (_, i) =>
        `Sentence${String(i).padStart(3, '0')} is ordinary readable prose.`,
      );
      const { text, runs, verticals, pages } = await tableLayout(`<table>
        <thead><tr><th colspan="2">Spanning header</th></tr></thead>
        <tbody><tr><td>${sentences.join(' ')}</td><td>Column marker</td></tr>
        <tr><td>Following row</td><td>Following value</td></tr></tbody></table>`);
      for (const sentence of sentences) expect(text).toContain(sentence.replace(/\s+/g, ''));
      for (const cell of ['Columnmarker', 'FollowingrowFollowingvalue']) expect(text).toContain(cell);
      expect(pages).toBeGreaterThan(2);
      for (let n = 1; n <= pages; n++) {
        const onPage = runs.filter((run) => run.page === n);
        expect(onPage[0]!.str, `page ${n}`).toBe('Spanning header');
        expect(onPage[0]!.x).toBeCloseTo(LEFT + PAD);
        expect(bordersAt(verticals, onPage[0]!), `page ${n}`).toEqual([50, 545.28]);
        expect(onPage[1]!.str, `page ${n}`).toMatch(/^(Sentence|Following row)/);
      }
      expect(at(runs.filter((run) => run.str === 'Column marker'))).toEqual([['Column marker', 303.64]]);
    });

    it('treats a colspan of 0, a missing one and a non-numeric one as 1', async () => {
      const { text, runs, verticals } = await tableLayout(`<table>
        <tr><th colspan="2">Two</th><th colspan="0">Zero</th><th>None</th><th colspan="x">Text</th></tr>
        <tr><td>a</td><td>b</td><td>c</td><td>d</td><td>e</td></tr></table>`);
      expect(text).toBe('TwoZeroNoneTextabcde');
      expect(at(runs)).toEqual([
        ['Two', 56], ['Zero', 254.11], ['None', 353.17], ['Text', 452.22],
        ['a', 56], ['b', 155.06], ['c', 254.11], ['d', 353.17], ['e', 452.22],
      ]);
      expect(bordersAt(verticals, runs[0]!)).toEqual([50, 248.11, 347.17, 446.22, 545.28]);
    });

    it('ignores rowspan: the cells of the next row shift left, and none is lost', async () => {
      // A recorded non-goal: modelling rowspan would change how tall rows split across pages (#1845).
      const { text, runs } = await tableLayout(
        '<table><tr><td rowspan="2">Tall</td><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
      );
      expect(text).toBe('Tallabcd');
      expect(at(runs)).toEqual([['Tall', 56], ['a', 221.09], ['b', 386.19], ['c', 56], ['d', 221.09]]);
    });

    it('prints tfoot rows after the body, wherever the source puts them', async () => {
      const { text } = await tableLayout(`<table>
        <tfoot><tr><td>Total</td><td>3</td></tr></tfoot>
        <thead><tr><th>Item</th><th>Qty</th></tr></thead>
        <tbody><tr><td>Apples</td><td>3</td></tr></tbody></table>`);
      expect(text).toBe('ItemQtyApples3Total3');
    });

    it('takes only a row\'s own cells, so a nested table adds no columns and prints once', async () => {
      const { text, runs } = await tableLayout(
        '<table><tr><td>outer<table><tr><td>N1</td><td>N2</td></tr></table></td><td>RIGHT</td></tr></table>',
      );
      expect(text.match(/N1|N2/g)).toEqual(['N1', 'N2']);
      expect(at(runs.filter((run) => run.str === 'RIGHT'))).toEqual([['RIGHT', 303.64]]);
    });

    describe('narrow columns', () => {
      // A column is never narrower than 495.28 / 14 = 35.38 pt: its 23.38 pt text box fits any two
      // Latin-1 glyphs, so a word broken to fit its box (#1730) never ends up one glyph per line.
      // Wider grids print in bands of at most 14 columns, one below the other.
      it('keeps 14 columns in one band and prints 15 as two bands of 8 and 7', async () => {
        const [fourteen, fifteen] = await Promise.all([14, 15].map((n) => tableLayout(
          `<table><tr>${Array.from({ length: n }, (_, c) => `<td>k${c}</td>`).join('')}</tr></table>`,
        )));
        expect(fourteen!.runs.map((run) => +run.y.toFixed(2))).toEqual(Array(14).fill(760.89));
        expect(fourteen!.runs.at(-1)!.x).toBeCloseTo(LEFT + 13 * (WIDTH / 14) + PAD);
        expect(fifteen!.runs.map((run) => run.str)).toEqual(Array.from({ length: 15 }, (_, c) => `k${c}`));
        expect(new Set(fifteen!.runs.map((run) => +run.y.toFixed(2))).size).toBe(2);
        expect(fifteen!.runs.map((run) => +((run.x - LEFT - PAD) / (WIDTH / 8)).toFixed(2))).toEqual(
          [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6],
        );
      });

      it('prints a table wider than 14 columns in bands, every cell whole and inside its column', async () => {
        const head = Array.from({ length: 40 }, (_, c) => `c${c + 1}`);
        const body = Array.from({ length: 40 }, (_, c) => `v${c + 1}`);
        const { text, runs, verticals, horizontals } = await tableLayout(`<table>
          <tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>
          <tr>${body.map((v) => `<td>${v}</td>`).join('')}</tr></table>`);
        // 40 columns → 3 bands of 14, 14 and 12 columns, each 495.28 / 14 = 35.38 pt wide.
        const expected = [[0, 14], [14, 28], [28, 40]].flatMap(([from, to]) => [...head.slice(from, to), ...body.slice(from, to)]);
        expect(runs.map((run) => run.str)).toEqual(expected);
        expect(text).toBe(expected.join(''));
        for (const run of runs) {
          const left = LEFT + ((Number(run.str.slice(1)) - 1) % 14) * (WIDTH / 14);
          expect(run.x, run.str).toBeCloseTo(left + PAD);
          expect(run.x + run.width, run.str).toBeLessThanOrEqual(left + WIDTH / 14 - PAD + EPS);
        }
        expectNoBorderThrough(runs, verticals);
        // The third band is 12 columns wide: its top and bottom borders stop at its right edge.
        expect([...new Set(horizontals.map((rule) => +rule.right.toFixed(2)))].sort((a, b) => a - b)).toEqual([474.53, 545.28]);
      });

      it('prints a header that spans a band edge in each band, with no border inside it', async () => {
        const months = Array.from({ length: 20 }, (_, m) => `m${m + 1}`);
        const { runs, verticals } = await tableLayout(`<table>
          <tr><th colspan="20">Quarterly figures</th></tr>
          <tr>${months.map((m) => `<td>${m}</td>`).join('')}</tr></table>`);
        // 20 columns → 2 bands of 10, each 49.53 pt wide.
        expect(runs.map((run) => run.str)).toEqual(
          ['Quarterly figures', ...months.slice(0, 10), 'Quarterly figures', ...months.slice(10)],
        );
        for (const run of runs.filter((run) => run.str === 'Quarterly figures')) {
          expect(bordersAt(verticals, run)).toEqual([50, 545.28]);
        }
      });

      it('wraps a cell that crosses a band edge mid-band at its width in each band', async () => {
        // 20 columns of 49.53 pt. B covers columns 5-16: five in the first band (a 235.64 pt text box),
        // seven in the second (334.70 pt), so it wraps in the first and not in the second.
        const b = 'Spans twelve columns, from the sixth to the seventeenth';
        const months = Array.from({ length: 20 }, (_, m) => `m${m + 1}`);
        const { text, runs, verticals } = await tableLayout(`<table>
          <tr><th colspan="5">A</th><th colspan="12">${b}</th><th colspan="3">C</th></tr>
          <tr>${months.map((m) => `<td>${m}</td>`).join('')}</tr></table>`);
        expect(text).toBe(['A', b, ...months.slice(0, 10), b, 'C', ...months.slice(10)].join('').replace(/\s+/g, ''));
        const header = runs.filter((run) => !/^m\d+$/.test(run.str));
        expect(at(header)).toEqual([
          ['A', 56], ['Spans twelve columns, from the sixth to the', 303.64], ['seventeenth', 303.64],
          [b, 56], ['C', 402.7],
        ]);
        expect(header[1]!.x + header[1]!.width).toBeLessThanOrEqual(LEFT + 10 * (WIDTH / 10) - PAD + EPS);
        expect(header[3]!.x + header[3]!.width).toBeLessThanOrEqual(LEFT + 7 * (WIDTH / 10) - PAD + EPS);
        expect(bordersAt(verticals, header[1]!)).toEqual([50, 297.64, 545.28]);
        expect(bordersAt(verticals, header[3]!)).toEqual([50, 396.7, 545.28]);
      });

      it('finds a row\'s later cells again after a band in which nothing starts', async () => {
        // 42 columns → 3 bands of 14 (35.38 pt). No cell starts in the middle band, so it is skipped;
        // the third band holds Tail and z, each row with the cell it carries over from the first band.
        const { runs, verticals, shades } = await tableLayout(`<table>
          <tr><th colspan="30">Group</th><th colspan="12">Tail</th></tr>
          <tr><td>a</td><td colspan="40">wide</td><td>z</td></tr></table>`);
        expect(at(runs)).toEqual([
          ['Group', 56], ['a', 56], ['wide', 91.38],
          ['Group', 56], ['Tail', 126.75], ['wide', 56], ['z', 515.9],
        ]);
        expect(shades).toBe(2);
        expect(bordersAt(verticals, runs.at(-1)!)).toEqual([50, 509.9, 545.28]);
      });

      it('prints only bands in which a cell starts, so colspan="1000" adds no empty bands', async () => {
        const { runs, pages } = await tableLayout(
          '<table><tr><th colspan="1000">Title</th></tr><tr><td>a</td><td>b</td></tr></table>',
        );
        // 1000 columns → 72 bands of 14; only the first holds the start of a cell.
        expect(runs.map((run) => run.str)).toEqual(['Title', 'a', 'b']);
        expect(pages).toBe(1);
      });

      it('prints a later band\'s rows only where a cell starts, so a 280-column header over 100 short rows stays on 6 pages', async () => {
        // 20 bands of 14: the header prints its share in each; the one-cell rows only in the first.
        // Printing every row in every band took 78 pages.
        const { runs, pages } = await tableLayout(`<table>
          <tr>${Array.from({ length: 280 }, (_, c) => `<th>${c}</th>`).join('')}</tr>
          ${Array.from({ length: 100 }, (_, r) => `<tr><td>r${r}</td></tr>`).join('')}</table>`);
        expect(pages).toBeLessThanOrEqual(6);
        const labels = runs.filter((run) => /^\d+$/.test(run.str));
        expect(new Set(labels.map((run) => run.str)).size).toBe(280);
        for (const run of labels) expect(run.x, run.str).toBeCloseTo(LEFT + (Number(run.str) % 14) * (WIDTH / 14) + PAD);
        expect(runs.filter((run) => /^r\d+$/.test(run.str))).toHaveLength(100);
      });

      it('leaves the header row out of the bands it does not reach', async () => {
        const months = Array.from({ length: 20 }, (_, m) => `m${m + 1}`);
        const { runs, shades } = await tableLayout(`<table>
          <tr><th>H1</th><th>H2</th></tr>
          <tr>${months.map((m) => `<td>${m}</td>`).join('')}</tr></table>`);
        expect(runs.map((run) => run.str)).toEqual(['H1', 'H2', ...months]);
        // One shaded header row: the second band starts with the body row, not an empty header.
        expect(shades).toBe(1);
      });

      it('prints a header too tall to repeat only in its first band', async () => {
        // A header that leaves no room for a body line does not repeat on continuation pages (#1845),
        // so it does not repeat in later bands either: a long spanning header is printed once.
        const words = Array.from({ length: 1000 }, (_, w) => `w${w}`).join(' ');
        const months = Array.from({ length: 20 }, (_, m) => `m${m + 1}`);
        const { text, runs } = await tableLayout(`<table>
          <tr><th colspan="20">${words} HEADEREND</th></tr>
          <tr>${months.map((m) => `<td>${m}</td>`).join('')}</tr></table>`);
        expect(text.match(/HEADEREND/g)).toEqual(['HEADEREND']);
        expect(runs.filter((run) => /^m\d+$/.test(run.str)).map((run) => run.str)).toEqual(months);
      });

      it('keeps a 40-column table of 32-character ids to 20 pages', async () => {
        // With #1730's hard break, ids in 40 equal 12.38 pt columns stacked one character per line,
        // one row per page (40 pages); in 35.38 pt band columns they wrap 3-5 characters per line.
        const ids = Array.from({ length: 40 }, (_, r) => (r * 2654435761 >>> 0).toString(16).padStart(8, '0').repeat(4));
        const head = `<tr>${Array.from({ length: 40 }, (_, c) => `<th>c${c}</th>`).join('')}</tr>`;
        const body = ids.map((id) => `<tr><td>${id}</td>${'<td>ok</td>'.repeat(39)}</tr>`).join('');
        const { text, runs, pages } = await tableLayout(`<table>${head}${body}</table>`);
        expect(pages).toBeLessThanOrEqual(20);
        for (const id of ids) expect(text).toContain(id);
        expect(runs.filter((run) => run.str === 'ok')).toHaveLength(40 * 39);
      });
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
});
