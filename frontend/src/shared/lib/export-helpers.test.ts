import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  exportToPdf,
  setPdfRendererOverlay,
  computeColumnLayout,
  canonicalJson,
  sha256Hex,
  type PdfReportMeta,
} from './export-helpers';

describe('export-helpers (#303)', () => {
  let objectUrl = '';
  let revokedUrls: string[] = [];
  let createdAnchor: HTMLAnchorElement | null = null;
  let capturedBlobs: Blob[] = [];

  beforeEach(() => {
    // jsdom stubs to make `triggerDownload` observable without actually
    // downloading anything.
    objectUrl = 'blob:mock-' + Math.random().toString(36).slice(2);
    revokedUrls = [];
    createdAnchor = null;
    capturedBlobs = [];
    globalThis.URL.createObjectURL = vi.fn((b: Blob) => {
      capturedBlobs.push(b);
      return objectUrl;
    }) as typeof globalThis.URL.createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn((u: string) => { revokedUrls.push(u); });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        createdAnchor = el as HTMLAnchorElement;
        // Stub click so jsdom doesn't complain about navigation.
        el.click = vi.fn();
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPdfRendererOverlay(null);
  });

  it('produces a PDF blob and triggers a download with the correct filename', async () => {
    await exportToPdf('test.pdf', [{ a: 1, b: 2 }], 'Test report');
    expect(createdAnchor?.download).toBe('test.pdf');
    expect(createdAnchor?.href).toBe(objectUrl);
    // Download URL is revoked on the 100ms tick; advance timers or just assert
    // the click happened (the revoke cleanup is a nicety, not a contract).
    expect(createdAnchor?.click).toHaveBeenCalled();
  });

  it('accepts rich metadata (PdfReportMeta) and forwards it to the renderer', async () => {
    let capturedMeta: PdfReportMeta | null = null;
    setPdfRendererOverlay(async (_rows, meta) => {
      capturedMeta = meta;
      return new Uint8Array([37, 80, 68, 70]); // '%PDF' header
    });

    const meta: PdfReportMeta = {
      title: 'KPI Report',
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-22' },
      generatedBy: 'alice',
      instanceUrl: 'https://compendiq.example.com',
      kpis: [
        { label: 'Total requests', value: 1234 },
        { label: 'Error rate', value: 2.5, unit: '%' },
      ],
    };
    await exportToPdf('kpi.pdf', [], meta);

    expect(capturedMeta).not.toBeNull();
    expect(capturedMeta!.title).toBe('KPI Report');
    expect(capturedMeta!.kpis).toHaveLength(2);
    expect(capturedMeta!.kpis![1].unit).toBe('%');
  });

  it('string-title form builds a minimal meta object for back-compat', async () => {
    let capturedMeta: PdfReportMeta | null = null;
    setPdfRendererOverlay(async (_rows, meta) => {
      capturedMeta = meta;
      return new Uint8Array();
    });
    await exportToPdf('simple.pdf', [{ x: 1 }], 'Plain title');
    expect(capturedMeta!.title).toBe('Plain title');
    expect(capturedMeta!.kpis).toBeUndefined();
  });

  it('setPdfRendererOverlay(null) restores the default CE renderer', async () => {
    const overlay = vi.fn(async () => new Uint8Array([1, 2, 3]));
    setPdfRendererOverlay(overlay);
    await exportToPdf('first.pdf', [], 'x');
    expect(overlay).toHaveBeenCalledTimes(1);

    setPdfRendererOverlay(null);
    // Default renderer would import pdf-lib; we don't assert content here,
    // just that the overlay isn't consulted again.
    await exportToPdf('second.pdf', [{ a: 1 }], 'y');
    expect(overlay).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Default CE renderer — direct assertions on the produced PDF (AC-6).
  // No overlay is registered; these exercise the real `renderPdfCe` path.
  // ---------------------------------------------------------------------------

  it('default renderer produces cover + multi-page data PDF for >57 rows', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      id: `row-${i}`,
      value: i * 3,
    }));
    await exportToPdf('multipage.pdf', rows, 'Multi-page test');

    expect(capturedBlobs).toHaveLength(1);
    const bytes = new Uint8Array(await capturedBlobs[0]!.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    // Cover page + at least one data page. 80 rows with 12 px line-height on
    // an A4 content area of ~735 px yields ~57 rows per page, so 80 rows must
    // spill onto at least two data pages → total ≥ 3 pages.
    expect(doc.getPages().length).toBeGreaterThanOrEqual(3);
  });

  it('default renderer produces a single-page-of-data output for small datasets', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, v: `v-${i}` }));
    await exportToPdf('small.pdf', rows, 'Small');
    const bytes = new Uint8Array(await capturedBlobs[0]!.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    // Cover + 1 data page.
    expect(doc.getPages().length).toBe(2);
  });

  it('default renderer switches to landscape for many-column tables (>10 cols)', async () => {
    const cols = Array.from({ length: 13 }, (_, i) => `col_${i}_with_a_pretty_long_name`);
    const row = Object.fromEntries(cols.map((c) => [c, 'some_data_value_here']));
    await exportToPdf('wide.pdf', [row, row, row], 'Wide table');
    const bytes = new Uint8Array(await capturedBlobs[0]!.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    const pages = doc.getPages();
    // Cover is always portrait (595 × 842).
    const cover = pages[0]!.getSize();
    expect(cover.width).toBeLessThan(cover.height);
    // Data pages should be landscape (wider than tall) because 13 columns
    // cannot fit at sensible widths in portrait.
    const dataPage = pages[1]!.getSize();
    expect(dataPage.width).toBeGreaterThan(dataPage.height);
  });

  it('default renderer keeps portrait for few-column tables (≤7 cols)', async () => {
    const rows = [{ a: 1, b: 2, c: 3, d: 4 }];
    await exportToPdf('narrow.pdf', rows, 'Narrow table');
    const bytes = new Uint8Array(await capturedBlobs[0]!.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    const dataPage = doc.getPages()[1]!.getSize();
    expect(dataPage.width).toBeLessThan(dataPage.height);
  });

  // ---------------------------------------------------------------------------
  // computeColumnLayout — pure-function contract tests (content-driven widths).
  // ---------------------------------------------------------------------------

  describe('computeColumnLayout', () => {
    let font: Awaited<ReturnType<Awaited<ReturnType<typeof PDFDocument.create>>['embedFont']>>;
    let boldFont: typeof font;

    beforeEach(async () => {
      const doc = await PDFDocument.create();
      font = await doc.embedFont(StandardFonts.Helvetica);
      boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    });

    it('widens columns with long content more than columns with short content', () => {
      const cols = ['id', 'description'];
      const rows = [
        { id: '1', description: 'A very long descriptive string that needs more width than the tiny id column' },
        { id: '22', description: 'Another fairly long row of text data' },
        { id: '333', description: 'Short' },
      ];
      const layout = computeColumnLayout(cols, rows, font, boldFont);
      expect(layout.colWidths).toHaveLength(2);
      // Description column should be wider than id column — this is the
      // whole point of content-driven widths.
      expect(layout.colWidths[1]!).toBeGreaterThan(layout.colWidths[0]!);
    });

    it('clamps to a minimum column width so tiny columns stay readable', () => {
      const cols = ['x'];
      const rows = [{ x: '1' }];
      const layout = computeColumnLayout(cols, rows, font, boldFont);
      expect(layout.colWidths[0]!).toBeGreaterThanOrEqual(40);
    });

    it('returns portrait for few columns and landscape for 11+ columns', () => {
      const fewCols = ['a', 'b', 'c'];
      const fewRow = { a: 'x', b: 'y', c: 'z' };
      const portrait = computeColumnLayout(fewCols, [fewRow], font, boldFont);
      expect(portrait.orientation).toBe('portrait');

      const manyCols = Array.from({ length: 12 }, (_, i) => `col${i}`);
      const manyRow = Object.fromEntries(manyCols.map((c) => [c, 'data']));
      const landscape = computeColumnLayout(manyCols, [manyRow], font, boldFont);
      expect(landscape.orientation).toBe('landscape');
    });

    it('sum of column widths fits within the content area (no right-margin overflow)', () => {
      // Even at 15 columns with very long content, total width must fit the
      // page minus margins.
      const cols = Array.from({ length: 15 }, (_, i) => `column_${i}`);
      const row = Object.fromEntries(
        cols.map((c) => [c, 'some_long_value_that_might_overflow_a_single_column']),
      );
      const layout = computeColumnLayout(cols, [row], font, boldFont);
      const { pageSize } = layout;
      const contentWidth = pageSize[0] - 50 * 2; // MARGIN * 2
      const total = layout.colWidths.reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(contentWidth + 0.5); // tiny float tolerance
    });
  });

  // ---------------------------------------------------------------------------
  // Integrity hash determinism — tests canonicalJson + sha256Hex directly
  // so we don't have to parse compressed PDF content streams.
  // ---------------------------------------------------------------------------

  describe('integrity hash', () => {
    it('canonicalJson produces the same string regardless of key insertion order', () => {
      const a = canonicalJson([{ a: 1, b: 'two', c: [3, 3, 3] }]);
      const b = canonicalJson([{ c: [3, 3, 3], a: 1, b: 'two' }]);
      expect(a).toBe(b);
    });

    it('sha256Hex is deterministic across scrambled key order', async () => {
      const rows1 = [{ a: 1, b: 'two', nested: { x: 1, y: 2 } }];
      const rows2 = [{ nested: { y: 2, x: 1 }, b: 'two', a: 1 }];
      const hash1 = await sha256Hex(canonicalJson(rows1));
      const hash2 = await sha256Hex(canonicalJson(rows2));
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('sha256Hex changes when row content changes', async () => {
      const h1 = await sha256Hex(canonicalJson([{ a: 1 }]));
      const h2 = await sha256Hex(canonicalJson([{ a: 2 }]));
      expect(h1).not.toBe(h2);
    });
  });
});
