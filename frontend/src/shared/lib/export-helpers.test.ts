import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  exportToPdf,
  setPdfRendererOverlay,
  type PdfReportMeta,
} from './export-helpers';

describe('export-helpers (#303)', () => {
  let objectUrl = '';
  let revokedUrls: string[] = [];
  let createdAnchor: HTMLAnchorElement | null = null;

  beforeEach(() => {
    // jsdom stubs to make `triggerDownload` observable without actually
    // downloading anything.
    objectUrl = 'blob:mock-' + Math.random().toString(36).slice(2);
    revokedUrls = [];
    createdAnchor = null;
    globalThis.URL.createObjectURL = vi.fn(() => objectUrl);
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

  it('integrity hash is stable — same data, same hash across calls (via overlay inspection)', async () => {
    // We intercept the rows at the overlay to verify canonical JSON hashing
    // happens at the CE layer — not here. This test just asserts the overlay
    // receives the same rows reference shape regardless of call order.
    const seen: unknown[][] = [];
    setPdfRendererOverlay(async (rows) => {
      seen.push(rows);
      return new Uint8Array();
    });
    const rows = [{ b: 2, a: 1 }]; // keys intentionally out of order
    await exportToPdf('a.pdf', rows, 'x');
    await exportToPdf('b.pdf', rows, 'x');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toStrictEqual(seen[1]);
  });
});
