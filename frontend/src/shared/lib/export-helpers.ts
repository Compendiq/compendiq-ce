/**
 * Client-side export utilities for the analytics dashboards (#303).
 *
 * `exportToPdf` produces a multi-page PDF with cover, KPI summary, paginated
 * data tables, per-page footer, and a SHA-256 integrity hash over the raw
 * data (parity with the upcoming compliance reports — EE #115).
 *
 * `pdf-lib` is lazy-imported only when an export runs, so the ~300 kB
 * library never lands in the initial bundle.
 *
 * v0.4 scope: tables + KPIs as cells. Chart-image rendering is deferred
 * to a follow-up (see Risks on CE #303) because `recharts-to-png` has not
 * been validated against Tailwind 4.
 *
 * Excel export was removed in #303. CSV opens cleanly in Excel for every
 * dashboard that previously used the `.xlsx` path.
 */

/** Trigger a browser download from a Blob. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Clean up after a tick so the browser has time to initiate the download.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

/**
 * A single KPI the cover page shows as a table cell. Supplied by the
 * caller; dashboards know their own KPIs better than the generic export
 * helper does.
 */
export interface PdfKpi {
  label: string;
  value: string | number;
  /** Optional trailing unit (%, ms, req/s). Renders next to `value`. */
  unit?: string;
}

/** Metadata shown on the cover + used to shape the filename. */
export interface PdfReportMeta {
  /** Dashboard / report title. */
  title: string;
  /** Date range covered by the data. */
  dateRange?: { startDate: string; endDate: string };
  /** Admin email that ran the export (from the auth store). */
  generatedBy?: string;
  /** Instance URL for attribution + fraud-detection at report-review time. */
  instanceUrl?: string;
  /** KPI cards printed on the cover (max 6 rendered; the rest are dropped). */
  kpis?: PdfKpi[];
}

/**
 * Overlay hook for the EE package to swap the renderer without touching
 * CE. Mirrors the `setLlmAuditHook` pattern. In CE mode this stays null
 * and the default `exportToPdf` runs. When the EE plugin registers a
 * richer renderer (charts as PNG, custom branding, compliance-report
 * template) it calls `setPdfRendererOverlay(ee.render)` and the default
 * path defers to it.
 */
type PdfRenderer = (
  rows: Record<string, unknown>[],
  meta: PdfReportMeta,
) => Promise<Uint8Array>;

let _overlay: PdfRenderer | null = null;

export function setPdfRendererOverlay(overlay: PdfRenderer | null): void {
  _overlay = overlay;
}

/**
 * Export tabular data to a multi-page PDF.
 *
 * Layout:
 *   - Page 1: cover (title, date range, generated-at, generated-by,
 *     instance URL, KPI grid, data integrity hash)
 *   - Page 2+: data rows, paginated; header redrawn on each page;
 *     column widths driven by content; footer on every page.
 *
 * Returns nothing — triggers a browser download on the current tab.
 */
export async function exportToPdf(
  filename: string,
  rows: Record<string, unknown>[],
  titleOrMeta: string | PdfReportMeta,
): Promise<void> {
  const meta: PdfReportMeta =
    typeof titleOrMeta === 'string' ? { title: titleOrMeta } : titleOrMeta;

  const bytes = _overlay
    ? await _overlay(rows, meta)
    : await renderPdfCe(rows, meta);

  triggerDownload(
    new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }),
    filename,
  );
}

// ---------------------------------------------------------------------------
// Default (CE) renderer
// ---------------------------------------------------------------------------

async function renderPdfCe(
  rows: Record<string, unknown>[],
  meta: PdfReportMeta,
): Promise<Uint8Array> {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const A4: [number, number] = [595, 842];
  const MARGIN = 50;
  const COLOR_TEXT = rgb(0.12, 0.12, 0.18);
  const COLOR_MUTED = rgb(0.45, 0.45, 0.5);
  const COLOR_HAIR = rgb(0.86, 0.86, 0.89);

  // Integrity hash over the raw data. Recomputed client-side on report
  // review to detect tampering. Uses the browser's Web Crypto API — no
  // extra deps.
  const integrityHash = await sha256Hex(canonicalJson(rows));

  // ── Cover page ────────────────────────────────────────────────────────
  const cover = doc.addPage(A4);
  let y = A4[1] - MARGIN;

  cover.drawText('Compendiq', { x: MARGIN, y, font: boldFont, size: 11, color: COLOR_MUTED });
  y -= 28;
  cover.drawText(meta.title, { x: MARGIN, y, font: boldFont, size: 22, color: COLOR_TEXT });
  y -= 36;

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  drawKeyValue(cover, 'Generated at', generatedAt, { x: MARGIN, y, font, boldFont, color: COLOR_TEXT, muted: COLOR_MUTED });
  y -= 18;
  if (meta.dateRange) {
    drawKeyValue(
      cover,
      'Date range',
      `${meta.dateRange.startDate} → ${meta.dateRange.endDate}`,
      { x: MARGIN, y, font, boldFont, color: COLOR_TEXT, muted: COLOR_MUTED },
    );
    y -= 18;
  }
  if (meta.generatedBy) {
    drawKeyValue(cover, 'Generated by', meta.generatedBy, { x: MARGIN, y, font, boldFont, color: COLOR_TEXT, muted: COLOR_MUTED });
    y -= 18;
  }
  if (meta.instanceUrl) {
    drawKeyValue(cover, 'Instance', meta.instanceUrl, { x: MARGIN, y, font, boldFont, color: COLOR_TEXT, muted: COLOR_MUTED });
    y -= 18;
  }
  drawKeyValue(cover, 'Row count', String(rows.length), { x: MARGIN, y, font, boldFont, color: COLOR_TEXT, muted: COLOR_MUTED });
  y -= 28;

  // KPI grid (2 columns × up to 3 rows). Purely optional — if the caller
  // didn't supply kpis, we skip straight to the integrity hash.
  if (meta.kpis && meta.kpis.length > 0) {
    cover.drawText('Key metrics', { x: MARGIN, y, font: boldFont, size: 13, color: COLOR_TEXT });
    y -= 20;

    const cellW = (A4[0] - MARGIN * 2) / 2;
    const cellH = 44;
    const kpis = meta.kpis.slice(0, 6);
    for (let i = 0; i < kpis.length; i++) {
      const kpi = kpis[i]!;
      const col = i % 2;
      const row = Math.floor(i / 2);
      const cx = MARGIN + col * cellW;
      const cy = y - row * (cellH + 8);
      cover.drawRectangle({
        x: cx, y: cy - cellH, width: cellW - 8, height: cellH,
        borderColor: COLOR_HAIR, borderWidth: 1,
      });
      cover.drawText(kpi.label, { x: cx + 10, y: cy - 14, font, size: 8, color: COLOR_MUTED });
      const valueText = `${kpi.value}${kpi.unit ? ' ' + kpi.unit : ''}`;
      cover.drawText(valueText, { x: cx + 10, y: cy - 32, font: boldFont, size: 16, color: COLOR_TEXT });
    }
    const kpiRows = Math.ceil(kpis.length / 2);
    y -= kpiRows * (cellH + 8) + 10;
  }

  // Data integrity footer on the cover.
  cover.drawLine({
    start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y },
    thickness: 0.5, color: COLOR_HAIR,
  });
  y -= 16;
  cover.drawText('Data integrity (SHA-256)', { x: MARGIN, y, font: boldFont, size: 8, color: COLOR_MUTED });
  y -= 12;
  cover.drawText(integrityHash, { x: MARGIN, y, font, size: 7, color: COLOR_TEXT });

  // ── Data pages ────────────────────────────────────────────────────────
  const cols = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const pagesWritten: Array<{ page: ReturnType<typeof doc.addPage>; pageNo: number }> = [];
  if (rows.length > 0) {
    const layout = computeColumnLayout(cols, rows, font, boldFont, { portraitSize: A4, margin: MARGIN });
    const dataPageContext = renderDataPages(
      doc, rows, cols, meta.title, layout,
      { MARGIN, COLOR_TEXT, COLOR_MUTED, COLOR_HAIR, font, boldFont },
    );
    pagesWritten.push(...dataPageContext);
  } else {
    const p = doc.addPage(A4);
    p.drawText('No data', { x: MARGIN, y: A4[1] - MARGIN, font, size: 12, color: COLOR_MUTED });
    pagesWritten.push({ page: p, pageNo: 1 });
  }

  // ── Footer on every page (cover + data) ───────────────────────────────
  const totalPages = 1 + pagesWritten.length;
  drawFooter(cover, 1, totalPages, meta, font, COLOR_MUTED);
  pagesWritten.forEach((p) => drawFooter(p.page, p.pageNo + 1, totalPages, meta, font, COLOR_MUTED));

  return await doc.save();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DrawKvOpts {
  x: number;
  y: number;
  font: Awaited<ReturnType<Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>['embedFont']>>;
  boldFont: Awaited<ReturnType<Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>['embedFont']>>;
  color: ReturnType<typeof import('pdf-lib')['rgb']>;
  muted: ReturnType<typeof import('pdf-lib')['rgb']>;
}

function drawKeyValue(
  page: ReturnType<Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>['addPage']>,
  label: string,
  value: string,
  opts: DrawKvOpts,
): void {
  page.drawText(label, { x: opts.x, y: opts.y, font: opts.font, size: 9, color: opts.muted });
  page.drawText(value, { x: opts.x + 110, y: opts.y, font: opts.boldFont, size: 10, color: opts.color });
}

interface RenderCtx {
  MARGIN: number;
  COLOR_TEXT: ReturnType<typeof import('pdf-lib')['rgb']>;
  COLOR_MUTED: ReturnType<typeof import('pdf-lib')['rgb']>;
  COLOR_HAIR: ReturnType<typeof import('pdf-lib')['rgb']>;
  font: Awaited<ReturnType<Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>['embedFont']>>;
  boldFont: Awaited<ReturnType<Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>['embedFont']>>;
}

/**
 * Paginate rows across data pages. Uses the precomputed `layout` for
 * per-column widths + page orientation (portrait or landscape) so wide
 * tables don't overflow the right margin. Returns the list of pages so
 * the caller can stamp footers.
 */
function renderDataPages(
  doc: Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>,
  rows: Record<string, unknown>[],
  cols: string[],
  title: string,
  layout: ColumnLayout,
  ctx: RenderCtx,
): Array<{ page: ReturnType<typeof doc.addPage>; pageNo: number }> {
  const { MARGIN, COLOR_TEXT, COLOR_MUTED, COLOR_HAIR, font, boldFont } = ctx;
  const { pageSize, colWidths } = layout;
  const rowHeight = 12;
  const headerHeight = 20;
  const available = pageSize[1] - MARGIN * 2 - headerHeight - 30 /* footer */;
  const rowsPerPage = Math.max(1, Math.floor(available / rowHeight));

  const pageCount = Math.ceil(rows.length / rowsPerPage);
  const pages: Array<{ page: ReturnType<typeof doc.addPage>; pageNo: number }> = [];

  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage(pageSize);
    let y = pageSize[1] - MARGIN;

    page.drawText(`${title} — data`, {
      x: MARGIN, y, font: boldFont, size: 12, color: COLOR_TEXT,
    });
    y -= 22;

    // Column headers
    cols.forEach((col, i) => {
      const x = MARGIN + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
      page.drawText(truncateToWidth(col, colWidths[i]! - 4, boldFont, 8), {
        x, y, font: boldFont, size: 8, color: COLOR_TEXT,
      });
    });
    y -= 4;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: pageSize[0] - MARGIN, y }, thickness: 0.5, color: COLOR_HAIR });
    y -= 10;

    // Data rows for this page
    const sliceStart = p * rowsPerPage;
    const sliceEnd = Math.min(sliceStart + rowsPerPage, rows.length);
    for (let r = sliceStart; r < sliceEnd; r++) {
      const row = rows[r]!;
      cols.forEach((col, i) => {
        const x = MARGIN + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
        const raw = row[col];
        const s = raw == null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        page.drawText(truncateToWidth(s, colWidths[i]! - 4, font, 7), {
          x, y, font, size: 7, color: COLOR_MUTED,
        });
      });
      y -= rowHeight;
    }

    pages.push({ page, pageNo: p + 1 });
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Column layout — content-driven widths + portrait/landscape selection.
// ---------------------------------------------------------------------------

type PdfFont = Awaited<
  ReturnType<Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>['embedFont']>
>;

/** Result of the layout pass — what `renderDataPages` consumes. */
export interface ColumnLayout {
  /** 'portrait' (A4 595×842) or 'landscape' (A4 842×595). */
  orientation: 'portrait' | 'landscape';
  /** Concrete [width, height] page size for the data pages. */
  pageSize: [number, number];
  /** Per-column widths in PDF units. Sum ≤ contentWidth. */
  colWidths: number[];
}

interface LayoutOptions {
  /** Default portrait size — `[595, 842]` for A4. */
  portraitSize?: [number, number];
  /** Page margin on each side. */
  margin?: number;
  /** Minimum column width (keeps even single-char cols readable). */
  minColWidth?: number;
  /** Maximum column width per column (prevents one column hogging the row). */
  maxColWidth?: number;
  /** At or above this column count, data pages switch to landscape. */
  landscapeThresholdCols?: number;
  /** Sample at most this many rows when measuring content. */
  maxSampleRows?: number;
  /** Header font size (used for header width measurement). */
  headerSize?: number;
  /** Body font size (used for cell width measurement). */
  bodySize?: number;
  /** Cell padding added to the widest content width per column. */
  cellPadding?: number;
}

/**
 * Compute per-column widths driven by content + pick an orientation.
 *
 * Two-pass algorithm:
 *   1. For each column measure `max(headerWidth, max(cellWidth over samples))`,
 *      add padding, clamp to `[min, max]`.
 *   2. If the sum exceeds portrait content width and we have many columns,
 *      flip the page to landscape A4 (swap page dimensions). Recompute
 *      content width.
 *   3. If the sum still exceeds content width, scale every column down
 *      proportionally (respecting min-width floor) so the table fits.
 *
 * Exported for unit testing + for EE renderers that want to reuse the
 * same sizing algorithm.
 */
export function computeColumnLayout(
  cols: string[],
  rows: Record<string, unknown>[],
  font: PdfFont,
  boldFont: PdfFont,
  opts: LayoutOptions = {},
): ColumnLayout {
  const portraitSize = opts.portraitSize ?? [595, 842];
  const margin = opts.margin ?? 50;
  const minColWidth = opts.minColWidth ?? 40;
  const maxColWidth = opts.maxColWidth ?? 220;
  const landscapeThresholdCols = opts.landscapeThresholdCols ?? 11;
  const maxSampleRows = opts.maxSampleRows ?? 200;
  const headerSize = opts.headerSize ?? 8;
  const bodySize = opts.bodySize ?? 7;
  const cellPadding = opts.cellPadding ?? 6;

  if (cols.length === 0) {
    return { orientation: 'portrait', pageSize: portraitSize, colWidths: [] };
  }

  // Measure desired widths. Sample up to `maxSampleRows` evenly-spaced rows
  // to bound measurement cost on huge datasets.
  const sampleStep = Math.max(1, Math.ceil(rows.length / maxSampleRows));
  const desiredRaw = cols.map((col) => {
    let w = safeWidth(boldFont, col, headerSize);
    for (let r = 0; r < rows.length; r += sampleStep) {
      const raw = rows[r]![col];
      const s = raw == null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
      const cellW = safeWidth(font, s, bodySize);
      if (cellW > w) w = cellW;
    }
    return w + cellPadding;
  });
  const desired = desiredRaw.map((w) => clamp(w, minColWidth, maxColWidth));

  // Pass 1: try portrait.
  const portraitContentWidth = portraitSize[0] - margin * 2;
  const total = desired.reduce((a, b) => a + b, 0);
  const portraitFits = total <= portraitContentWidth;
  const tooManyCols = cols.length >= landscapeThresholdCols;

  if (portraitFits && !tooManyCols) {
    return {
      orientation: 'portrait',
      pageSize: portraitSize,
      colWidths: fitToWidth(desired, portraitContentWidth, minColWidth),
    };
  }

  // Pass 2: try landscape.
  const landscapeSize: [number, number] = [portraitSize[1], portraitSize[0]];
  const landscapeContentWidth = landscapeSize[0] - margin * 2;
  const landscapeFits = total <= landscapeContentWidth;

  if (tooManyCols || !portraitFits) {
    if (landscapeFits) {
      return {
        orientation: 'landscape',
        pageSize: landscapeSize,
        colWidths: fitToWidth(desired, landscapeContentWidth, minColWidth),
      };
    }
    // Still too wide even in landscape — scale down proportionally.
    return {
      orientation: 'landscape',
      pageSize: landscapeSize,
      colWidths: fitToWidth(desired, landscapeContentWidth, minColWidth),
    };
  }

  // Fallback: portrait with proportional scale-down.
  return {
    orientation: 'portrait',
    pageSize: portraitSize,
    colWidths: fitToWidth(desired, portraitContentWidth, minColWidth),
  };
}

/**
 * Scale a list of desired widths so their sum is exactly `target` — but
 * never shrink a column below `minWidth`. If even the min-width floors
 * sum to more than `target`, return all-min (accepting right-edge clip
 * rather than collapsing columns to zero; in practice the caller has
 * already picked a wider page when this matters).
 */
function fitToWidth(desired: number[], target: number, minWidth: number): number[] {
  const total = desired.reduce((a, b) => a + b, 0);
  if (total <= target) {
    // Distribute the leftover room proportionally so the table fills the
    // page — easier on the eye than leaving a gap on the right.
    const extra = target - total;
    return desired.map((w) => w + (extra * w) / total);
  }
  // Shrink proportionally, but respect min-width floor.
  const minSum = minWidth * desired.length;
  if (minSum >= target) return desired.map(() => target / desired.length);
  const shrinkable = total - minSum;
  const shrinkTarget = total - target;
  const ratio = shrinkTarget / shrinkable;
  return desired.map((w) => w - (w - minWidth) * ratio);
}

function safeWidth(font: PdfFont, text: string, size: number): number {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    // pdf-lib should never throw for standard fonts, but guard against
    // future API changes or unusual glyphs. Fall back to a rough estimate.
    return text.length * size * 0.5;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function drawFooter(
  page: ReturnType<Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>['addPage']>,
  pageNo: number,
  totalPages: number,
  meta: PdfReportMeta,
  font: Awaited<ReturnType<Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>['embedFont']>>,
  muted: ReturnType<typeof import('pdf-lib')['rgb']>,
): void {
  const { width } = page.getSize();
  const y = 24;
  const left = `${meta.title}`;
  const right = `Page ${pageNo} of ${totalPages}`;
  page.drawText(left, { x: 50, y, font, size: 8, color: muted });
  const rightWidth = font.widthOfTextAtSize(right, 8);
  page.drawText(right, { x: width - 50 - rightWidth, y, font, size: 8, color: muted });
}

/**
 * Truncate a string so its rendered width at `size` fits within `maxWidth`.
 * Falls back to character-count truncation when the font metric lookup
 * ever throws (pdf-lib does not currently throw, but guard against future
 * behaviour changes).
 */
function truncateToWidth(
  text: string,
  maxWidth: number,
  font: Awaited<ReturnType<Awaited<ReturnType<typeof import('pdf-lib')['PDFDocument']['create']>>['embedFont']>>,
  size: number,
): string {
  try {
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && font.widthOfTextAtSize(out + '…', size) > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + '…';
  } catch {
    return text.slice(0, Math.max(1, Math.floor(maxWidth / (size * 0.5))));
  }
}

/**
 * Canonical JSON: stable key ordering so the hash is deterministic
 * regardless of object-key iteration order. Exported so tests — and any
 * EE renderer — can produce the same hash the CE renderer stamps on the
 * cover page.
 */
export function canonicalJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

/** Web Crypto SHA-256, formatted as lowercase hex. Exported for tests. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
