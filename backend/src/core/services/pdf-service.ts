import { PDFDocument, rgb, PDFPage, PDFFont } from 'pdf-lib';
import { JSDOM } from 'jsdom';
import { logger } from '../utils/logger.js';
import { drawText, embedFonts, measureText, normalizeText } from './pdf-fonts.js';

// ── Constants ──────────────────────────────────────────────────────
const PAGE_WIDTH = 595.28;   // A4 width in points
const PAGE_HEIGHT = 841.89;  // A4 height in points
const MARGIN_TOP = 60;
const MARGIN_BOTTOM = 60;
const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const LINE_HEIGHT = 16;
const HEADING_SPACING = 24;
const PARAGRAPH_SPACING = 12;
const CODE_PADDING = 10;
const TABLE_CELL_PADDING = 6;

// ── Font sizes ─────────────────────────────────────────────────────
const FONT_SIZE_BODY = 11;
const FONT_SIZE_H1 = 22;
const FONT_SIZE_H2 = 18;
const FONT_SIZE_H3 = 15;
const FONT_SIZE_H4 = 13;
const FONT_SIZE_CODE = 9.5;
const FONT_SIZE_SMALL = 9;
const FONT_SIZE_FOOTER = 8;

// ── Code blocks (#1730) ────────────────────────────────────────────
// Code text starts inside the shaded box and must end inside it too:
// 475.28 pt is 83 Noto Sans Mono cells at FONT_SIZE_CODE (0.6 em = 5.7 pt each).
const CODE_TEXT_X = MARGIN_LEFT + CODE_PADDING;
const CODE_TEXT_WIDTH = CONTENT_WIDTH - 2 * CODE_PADDING;

// ── Colors ─────────────────────────────────────────────────────────
const COLOR_TEXT = rgb(0.1, 0.1, 0.1);
const COLOR_HEADING = rgb(0.05, 0.05, 0.15);
const COLOR_MUTED = rgb(0.4, 0.4, 0.45);
const COLOR_CODE_BG = rgb(0.94, 0.95, 0.96);
const COLOR_CODE_TEXT = rgb(0.15, 0.15, 0.15);
const COLOR_BLOCKQUOTE_BORDER = rgb(0.39, 0.4, 0.95);
const COLOR_TABLE_BORDER = rgb(0.75, 0.78, 0.82);
const COLOR_TABLE_HEADER_BG = rgb(0.96, 0.97, 0.98);
const COLOR_LIST_BULLET = rgb(0.35, 0.35, 0.4);

// ── Expand-section default labels (#1227) ──────────────────────────
/**
 * What Confluence's own renderers show for an expand macro carrying no `title`
 * parameter. Since #1227 an untitled section genuinely stores nothing, so any
 * renderer that wants to show a title row has to supply the label itself.
 *
 * The app does that with a ProseMirror decoration, which a server-side PDF
 * render — no stylesheet, no ProseMirror — never sees. Hence this second copy,
 * deliberately kept in step with `EXPAND_PLACEHOLDER_LABELS` in
 * `frontend/src/shared/components/article/article-extensions.ts`. They cannot
 * share a module (backend and frontend share only `@compendiq/contracts`), so
 * a frontend test reads this file and fails if the two drift apart.
 *
 * Both strings were measured, not recalled: `expand` from
 * `expand-macro.default-title` in the bundled `confluence-expand-macro-19.2.44`
 * plugin of a Confluence DC 9.2.14 container (note the ellipsis), `ui-expand`
 * from Refined's public DC demo rendered through
 * `/rest/api/contentbody/convert/view` (no ellipsis — the near-collision is
 * real, not a typo).
 */
const EXPAND_DEFAULT_LABELS: Record<string, string> = {
  expand: 'Click here to expand...',
  'ui-expand': 'Click here to expand',
};

/**
 * Shown for a `<details>` with no identity stamp (pre-#1211 body_html, and
 * editor-created sections) or an unrecognised one. Generic on purpose:
 * guessing a third-party macro's wording would be the same fabrication in the
 * export that #1227 removed from the storage format.
 */
const DEFAULT_EXPAND_LABEL = 'Click to expand';

// ── Types ──────────────────────────────────────────────────────────
interface RenderContext {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  pageNum: number;
  font: PDFFont;
  fontBold: PDFFont;
  fontItalic: PDFFont;
  fontMono: PDFFont;
  title?: string;
}

// ── Public API (same signature as before) ──────────────────────────

export async function generatePdf(
  html: string,
  options: { title?: string },
): Promise<Buffer> {
  try {
    const doc = await PDFDocument.create();
    // Parse first: which fonts to embed depends on the characters to draw.
    const body = new JSDOM(html).window.document.body;
    const alts = Array.from(body.querySelectorAll('img'), (img) => img.getAttribute('alt') ?? '');
    const fonts = await embedFonts(doc, [options.title ?? '', body.textContent ?? '', ...alts].join('\n'));

    const ctx: RenderContext = {
      doc,
      page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
      y: PAGE_HEIGHT - MARGIN_TOP,
      pageNum: 1,
      ...fonts,
      title: options.title,
    };

    // Cover page
    if (options.title) {
      renderCoverPage(ctx, options.title);
    }

    renderChildren(ctx, body);

    // Add footers to all pages
    addFooters(ctx);

    const bytes = await doc.save();
    return Buffer.from(bytes);
  } catch (err) {
    logger.error({ err }, 'PDF generation failed');
    throw err;
  }
}

/** Backward-compat: no-op since pdf-lib doesn't use a browser. */
export async function closeBrowser(): Promise<void> {
  // No browser to close — pdf-lib is pure JS.
}

// ── Page management ────────────────────────────────────────────────

function newPage(ctx: RenderContext): void {
  ctx.page = ctx.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  ctx.y = PAGE_HEIGHT - MARGIN_TOP;
  ctx.pageNum++;
}

function ensureSpace(ctx: RenderContext, needed: number): void {
  if (ctx.y - needed < MARGIN_BOTTOM) {
    newPage(ctx);
  }
}

function addFooters(ctx: RenderContext): void {
  const pages = ctx.doc.getPages();
  const total = pages.length;
  // Skip cover page if title is present
  const startIdx = ctx.title ? 1 : 0;
  for (let i = startIdx; i < total; i++) {
    const page = pages[i]!;
    const pageNumber = i - startIdx + 1;
    const text = `Page ${pageNumber} of ${total - startIdx}`;
    const w = measureText(text, ctx.font, FONT_SIZE_FOOTER);
    drawText(page, text, {
      x: PAGE_WIDTH - MARGIN_RIGHT - w,
      y: MARGIN_BOTTOM / 2 - FONT_SIZE_FOOTER / 2,
      size: FONT_SIZE_FOOTER,
      font: ctx.font,
      color: COLOR_MUTED,
    });
  }
}

// ── Cover page ─────────────────────────────────────────────────────

function renderCoverPage(ctx: RenderContext, title: string): void {
  const titleLines = wrapText(title, ctx.fontBold, FONT_SIZE_H1, CONTENT_WIDTH);
  const titleHeight = titleLines.length * (FONT_SIZE_H1 + 6);
  const startY = PAGE_HEIGHT / 2 + titleHeight / 2;

  for (let i = 0; i < titleLines.length; i++) {
    // Centre by the drawn width, the width the line was wrapped to (#1730).
    const lineW = measureText(titleLines[i]!, ctx.fontBold, FONT_SIZE_H1);
    drawText(ctx.page, titleLines[i]!, {
      x: (PAGE_WIDTH - lineW) / 2,
      y: startY - i * (FONT_SIZE_H1 + 6),
      size: FONT_SIZE_H1,
      font: ctx.fontBold,
      color: COLOR_HEADING,
    });
  }

  const date = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const dateW = measureText(date, ctx.font, FONT_SIZE_BODY);
  drawText(ctx.page, date, {
    x: (PAGE_WIDTH - dateW) / 2,
    y: startY - titleHeight - 24,
    size: FONT_SIZE_BODY,
    font: ctx.font,
    color: COLOR_MUTED,
  });

  // Start content on next page
  newPage(ctx);
}

// ── DOM rendering ──────────────────────────────────────────────────

function renderChildren(ctx: RenderContext, node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    renderNode(ctx, child);
  }
}

function renderNode(ctx: RenderContext, node: Node): void {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const text = node.textContent?.trim();
    if (text) {
      renderTextBlock(ctx, text, ctx.font, FONT_SIZE_BODY, COLOR_TEXT);
    }
    return;
  }

  if (node.nodeType !== 1 /* ELEMENT_NODE */) return;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'h1':
      renderHeading(ctx, el.textContent?.trim() ?? '', FONT_SIZE_H1);
      break;
    case 'h2':
      renderHeading(ctx, el.textContent?.trim() ?? '', FONT_SIZE_H2);
      break;
    case 'h3':
      renderHeading(ctx, el.textContent?.trim() ?? '', FONT_SIZE_H3);
      break;
    case 'h4':
    case 'h5':
    case 'h6':
      renderHeading(ctx, el.textContent?.trim() ?? '', FONT_SIZE_H4);
      break;
    case 'p':
      renderParagraph(ctx, el);
      break;
    case 'pre':
      renderCodeBlock(ctx, el.textContent?.trim() ?? '');
      break;
    case 'blockquote':
      renderBlockquote(ctx, el.textContent?.trim() ?? '');
      break;
    case 'ul':
      renderList(ctx, el, false);
      break;
    case 'ol':
      renderList(ctx, el, true);
      break;
    case 'table':
      renderTable(ctx, el);
      break;
    case 'hr':
      renderHorizontalRule(ctx);
      break;
    case 'br':
      ctx.y -= LINE_HEIGHT;
      break;
    case 'img':
      renderImagePlaceholder(ctx, el);
      break;
    case 'summary':
      renderExpandSummary(ctx, el);
      break;
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'details':
    case 'figure':
    case 'figcaption':
      renderChildren(ctx, el);
      break;
    default:
      // For unknown elements, try to render their text content
      if (el.children.length > 0) {
        renderChildren(ctx, el);
      } else {
        const text = el.textContent?.trim();
        if (text) {
          renderTextBlock(ctx, text, ctx.font, FONT_SIZE_BODY, COLOR_TEXT);
        }
      }
  }
}

// ── Block renderers ────────────────────────────────────────────────

function renderHeading(ctx: RenderContext, text: string, fontSize: number): void {
  if (!text) return;
  ensureSpace(ctx, fontSize + HEADING_SPACING * 2);
  ctx.y -= HEADING_SPACING;

  const lines = wrapText(text, ctx.fontBold, fontSize, CONTENT_WIDTH);
  for (const line of lines) {
    ensureSpace(ctx, fontSize + 4);
    drawText(ctx.page, line, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: fontSize,
      font: ctx.fontBold,
      color: COLOR_HEADING,
    });
    ctx.y -= fontSize + 4;
  }

  // Draw underline for h1/h2
  if (fontSize >= FONT_SIZE_H2) {
    ctx.page.drawLine({
      start: { x: MARGIN_LEFT, y: ctx.y + 2 },
      end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: ctx.y + 2 },
      thickness: fontSize >= FONT_SIZE_H1 ? 1.5 : 0.75,
      color: rgb(0.85, 0.86, 0.88),
    });
    ctx.y -= 4;
  }

  ctx.y -= PARAGRAPH_SPACING / 2;
}

/**
 * An expand section's title row (#1227).
 *
 * `<summary>` used to fall through to the default branch, which draws its text
 * as an ordinary body paragraph — and drew *nothing at all* once #1227 stopped
 * fabricating a title for an untitled section, leaving the section with no
 * header row and its body running straight on. Bold, and falling back to the
 * macro's own default label, so an exported page reads the way the section
 * does in the app and in Confluence's own export.
 *
 * The label comes from the parent `<details>`' `data-macro-name` stamp
 * (#1211); a stray summary with no expand parent gets the generic fallback.
 */
function renderExpandSummary(ctx: RenderContext, el: Element): void {
  const title = extractTextContent(el);
  const macroName = el.parentElement?.getAttribute('data-macro-name');
  const label = title || (macroName && EXPAND_DEFAULT_LABELS[macroName]) || DEFAULT_EXPAND_LABEL;
  renderTextBlock(ctx, label, ctx.fontBold, FONT_SIZE_BODY, COLOR_HEADING);
  ctx.y -= PARAGRAPH_SPACING / 2;
}

function renderParagraph(ctx: RenderContext, el: Element): void {
  const text = extractTextContent(el);
  if (!text) return;
  renderTextBlock(ctx, text, ctx.font, FONT_SIZE_BODY, COLOR_TEXT);
  ctx.y -= PARAGRAPH_SPACING;
}

function renderTextBlock(
  ctx: RenderContext,
  text: string,
  font: PDFFont,
  fontSize: number,
  color: ReturnType<typeof rgb>,
): void {
  const lines = wrapText(text, font, fontSize, CONTENT_WIDTH);
  for (const line of lines) {
    ensureSpace(ctx, LINE_HEIGHT);
    drawText(ctx.page, line, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: fontSize,
      font,
      color,
    });
    ctx.y -= LINE_HEIGHT;
  }
}

function renderCodeBlock(ctx: RenderContext, code: string): void {
  if (!code) return;
  // A source line wider than the code box continues flush left on the next
  // row (#1730); every row, continuation or not, is positioned like a line.
  const rows = code.split('\n').flatMap((line) =>
    breakToWidth(normalizeText(line), ctx.fontMono, FONT_SIZE_CODE, CODE_TEXT_WIDTH),
  );
  const lineHeight = FONT_SIZE_CODE + 4;

  ensureSpace(ctx, Math.min(rows.length * lineHeight + CODE_PADDING * 2, 200));
  ctx.y -= 4;

  // Collect row positions first, then draw backgrounds, then text.
  // This handles page breaks correctly: background per page segment, text on top.
  interface CodeLine { page: PDFPage; y: number; text: string }
  const rendered: CodeLine[] = [];

  // Pass 1: calculate positions (may trigger page breaks)
  for (const text of rows) {
    ensureSpace(ctx, lineHeight + CODE_PADDING);
    rendered.push({ page: ctx.page, y: ctx.y, text });
    ctx.y -= lineHeight;
  }

  // Pass 2: draw backgrounds per page segment
  let segStart = 0;
  for (let i = 0; i <= rendered.length; i++) {
    if (i === rendered.length || (i > 0 && rendered[i]!.page !== rendered[i - 1]!.page)) {
      // Draw background for segment [segStart, i-1]
      const segPage = rendered[segStart]!.page;
      const top = rendered[segStart]!.y + FONT_SIZE_CODE + CODE_PADDING;
      const bottom = rendered[i - 1]!.y - CODE_PADDING;
      drawCodeBg(segPage, top, bottom);
      segStart = i;
    }
  }

  // Pass 3: draw text on top of backgrounds
  for (const line of rendered) {
    if (line.text) {
      drawText(line.page, line.text, {
        x: CODE_TEXT_X,
        y: line.y,
        size: FONT_SIZE_CODE,
        font: ctx.fontMono,
        color: COLOR_CODE_TEXT,
      });
    }
  }

  ctx.y -= CODE_PADDING + PARAGRAPH_SPACING;
}

function drawCodeBg(page: PDFPage, top: number, bottom: number): void {
  const height = top - bottom;
  if (height <= 0) return;
  page.drawRectangle({
    x: MARGIN_LEFT,
    y: bottom,
    width: CONTENT_WIDTH,
    height,
    color: COLOR_CODE_BG,
    borderWidth: 0,
  });
}

function renderBlockquote(ctx: RenderContext, text: string): void {
  if (!text) return;
  ensureSpace(ctx, LINE_HEIGHT + PARAGRAPH_SPACING);

  const indent = 16;
  const lines = wrapText(text, ctx.fontItalic, FONT_SIZE_BODY, CONTENT_WIDTH - indent);

  // Collect positions first, then draw borders per page, then text on top
  interface QLine { page: PDFPage; y: number; text: string }
  const rendered: QLine[] = [];

  for (const line of lines) {
    ensureSpace(ctx, LINE_HEIGHT);
    rendered.push({ page: ctx.page, y: ctx.y, text: line });
    ctx.y -= LINE_HEIGHT;
  }

  // Draw left border per page segment
  let segStart = 0;
  for (let i = 0; i <= rendered.length; i++) {
    if (i === rendered.length || (i > 0 && rendered[i]!.page !== rendered[i - 1]!.page)) {
      const segPage = rendered[segStart]!.page;
      const top = rendered[segStart]!.y + LINE_HEIGHT;
      const bottom = rendered[i - 1]!.y;
      segPage.drawRectangle({
        x: MARGIN_LEFT,
        y: bottom,
        width: 3,
        height: top - bottom,
        color: COLOR_BLOCKQUOTE_BORDER,
      });
      segStart = i;
    }
  }

  // Draw text
  for (const line of rendered) {
    drawText(line.page, line.text, {
      x: MARGIN_LEFT + indent,
      y: line.y,
      size: FONT_SIZE_BODY,
      font: ctx.fontItalic,
      color: COLOR_MUTED,
    });
  }

  ctx.y -= PARAGRAPH_SPACING;
}

function renderList(ctx: RenderContext, el: Element, ordered: boolean): void {
  const items = Array.from(el.querySelectorAll(':scope > li'));
  const indent = 20;

  for (let i = 0; i < items.length; i++) {
    const text = extractTextContent(items[i]!);
    if (!text) continue;

    ensureSpace(ctx, LINE_HEIGHT);

    const bullet = ordered ? `${i + 1}.` : '•';
    drawText(ctx.page, bullet, {
      x: MARGIN_LEFT + 4,
      y: ctx.y,
      size: FONT_SIZE_BODY,
      font: ordered ? ctx.font : ctx.fontBold,
      color: COLOR_LIST_BULLET,
    });

    const lines = wrapText(text, ctx.font, FONT_SIZE_BODY, CONTENT_WIDTH - indent);
    for (const line of lines) {
      ensureSpace(ctx, LINE_HEIGHT);
      drawText(ctx.page, line, {
        x: MARGIN_LEFT + indent,
        y: ctx.y,
        size: FONT_SIZE_BODY,
        font: ctx.font,
        color: COLOR_TEXT,
      });
      ctx.y -= LINE_HEIGHT;
    }
  }

  ctx.y -= PARAGRAPH_SPACING;
}

/**
 * The narrowest a table column may be (#1731): two em of text plus the cell
 * padding. CONTENT_WIDTH holds 14 such columns — 35.38 pt, a 23.38 pt text box
 * that fits any two glyphs of Latin-1 (the widest, Noto Sans Bold `m`, is
 * 10.73 pt), CJK, Hangul or U+FFFD (at most 11 pt) — so words in those scripts
 * never break one glyph per line; a wider grid prints in bands. Only U+2E3B
 * THREE-EM DASH (31.24 pt) is wider than the box: it gets a line of its own.
 */
const TABLE_MIN_COLUMN_WIDTH = 2 * FONT_SIZE_BODY + 2 * TABLE_CELL_PADDING;

/** A cell on a table's logical grid: it covers columns [start, start + span). */
interface GridCell { start: number; span: number; text: string }

/** A table row on the logical grid: its own cells, left to right from column 0. */
interface GridRow { isHeader: boolean; cells: GridCell[] }

/** A row's slice of one band: a piece per cell or empty column, `column` counted from the band's left edge. */
interface BandRow {
  isHeader: boolean;
  font: PDFFont;
  pieces: Array<{ column: number; lines: string[] }>;
  count: number;
}

function renderTable(ctx: RenderContext, el: Element): void {
  // thead rows, then tbody (and bare) rows, then tfoot rows; never a nested table's.
  const rows = Array.from((el as HTMLTableElement).rows);
  if (rows.length === 0) return;
  const { grid, width } = tableGrid(rows);

  // Narrow-column policy: no column is narrower than TABLE_MIN_COLUMN_WIDTH, so
  // a grid of more than 14 columns prints as bands of whole columns, one below
  // the other, all at the same column width.
  const perBand = Math.ceil(width / Math.ceil(width / Math.floor(CONTENT_WIDTH / TABLE_MIN_COLUMN_WIDTH)));
  const colWidth = CONTENT_WIDTH / perBand;
  // The first band holds every row; a later band only the rows with a cell
  // starting in it, and the header row's share of it: the header cells that
  // reach into the band, each printed again only if its piece could repeat on
  // a continuation page (repeatsAsHeader). Every cell prints in the band it
  // starts in, so the work grows with the cells, not with bands × rows; a band
  // in which no cell starts is skipped.
  const startingRows = new Map<number, number[]>();
  grid.forEach((row, r) => {
    for (const cell of row.cells) {
      const band = Math.floor(cell.start / perBand);
      const rowsHere = startingRows.get(band);
      if (!rowsHere) startingRows.set(band, [r]);
      else if (rowsHere.at(-1) !== r) rowsHere.push(r);
    }
  });
  const next = grid.map(() => 0); // per row: its first cell starting at or right of the band
  // Header cells too tall to repeat print once, in the band they start in. A
  // cell's later pieces are no wider (full bands, then its last piece), and
  // wrapText gives a narrower width no fewer lines, so one check per cell holds.
  const tooTall = new Set<GridCell>();
  for (let from = 0; from < width; from += perBand) {
    const starting = startingRows.get(from / perBand) ?? [];
    if (from > 0 && starting.length === 0) continue;
    const to = Math.min(from + perBand, width);
    const candidates = from === 0 ? grid.keys() : new Set(grid[0]!.isHeader ? [0, ...starting] : starting);
    const band: BandRow[] = [];
    let header: BandRow | undefined;
    for (const r of candidates) {
      const row = grid[r]!;
      let i = next[r]!;
      while (i < row.cells.length && row.cells[i]!.start < from) i++;
      next[r] = i;
      const carried = i > 0 && row.cells[i - 1]!.start + row.cells[i - 1]!.span > from ? row.cells[i - 1] : undefined;
      const startsHere = i < row.cells.length && row.cells[i]!.start < to;
      if (from > 0 && r === 0 && row.isHeader && carried && !tooTall.has(carried)) {
        const piece = sliceRow(ctx, row, i - 1, from, Math.min(carried.start + carried.span, to), colWidth);
        if (!repeatsAsHeader(piece)) tooTall.add(carried);
      }
      // Only header cells are ever too tall: their piece here stays blank, and
      // with no header cell starting here the header row has nothing to show.
      const blank = carried !== undefined && tooTall.has(carried);
      if (from > 0 && !startsHere && (!carried || blank)) continue;
      const slice = sliceRow(ctx, row, carried ? i - 1 : i, from, to, colWidth, blank);
      if (r === 0 && row.isHeader) header = slice;
      band.push(slice);
    }
    renderTableBand(ctx, band, header, colWidth, (to - from) * colWidth);
  }
}

/**
 * The table's span-aware logical grid (#1731): each row's own cells, left to
 * right from column 0, each covering `colSpan` columns (HTML rules: missing, 0
 * or non-numeric → 1, at most 1000). The grid is as wide as its widest row; a
 * shorter row ends in empty columns. rowspan is ignored, so the cells of a row
 * below a rowspan cell shift left.
 */
function tableGrid(rows: HTMLTableRowElement[]): { grid: GridRow[]; width: number } {
  let width = 1;
  const grid = rows.map((row): GridRow => {
    let column = 0;
    const cells = Array.from(row.cells, (cell): GridCell => {
      const placed = { start: column, span: cell.colSpan, text: cell.textContent?.trim() ?? '' };
      column += cell.colSpan;
      return placed;
    });
    width = Math.max(width, column);
    return { isHeader: row.cells[0]?.tagName.toLowerCase() === 'th', cells };
  });
  return { grid, width };
}

/**
 * A row's slice of columns [from, to): each cell from `first` on that reaches
 * into them, clipped to the band and wrapped at its clipped width (a cell that
 * crosses a band edge prints its text in each band its row prints in, unless
 * `blankFirst` leaves that first piece empty), then an empty column for each
 * column past the row's last cell.
 */
function sliceRow(
  ctx: RenderContext, row: GridRow, first: number, from: number, to: number, colWidth: number, blankFirst = false,
): BandRow {
  const font = row.isHeader ? ctx.fontBold : ctx.font;
  const pieces: BandRow['pieces'] = [];
  let column = from;
  for (let i = first; i < row.cells.length && row.cells[i]!.start < to; i++) {
    const cell = row.cells[i]!;
    const end = Math.min(cell.start + cell.span, to);
    const width = (end - column) * colWidth - 2 * TABLE_CELL_PADDING;
    const lines = i === first && blankFirst ? [] : wrapText(cell.text, font, FONT_SIZE_BODY, width);
    pieces.push({ column: column - from, lines });
    column = end;
  }
  for (; column < to; column++) pieces.push({ column: column - from, lines: [] });
  return { isHeader: row.isHeader, font, pieces, count: Math.max(1, ...pieces.map((piece) => piece.lines.length)) };
}

/**
 * Whether a header slice repeats — on a continuation page, or as the header
 * row's share of a later band: only when a line of the row below still fits
 * under it on a fresh page. A header cell too tall for that prints once, in
 * the band it starts in.
 */
function repeatsAsHeader(header: BandRow): boolean {
  const lineHeight = FONT_SIZE_BODY + 3;
  const padding = TABLE_CELL_PADDING * 2;
  return header.count * lineHeight + padding + lineHeight + padding <= PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
}

/**
 * Draws one band of a table, paginating like a whole table (#1845): rows stay
 * together when they fit a fresh page, taller rows split between lines, and
 * `header` (the band's slice of a first header row, `prepared[0]`) repeats on
 * continuation pages when a body line still fits below it.
 */
function renderTableBand(
  ctx: RenderContext, prepared: BandRow[], header: BandRow | undefined, colWidth: number, bandWidth: number,
): void {
  ensureSpace(ctx, LINE_HEIGHT * 2);
  ctx.y -= 4;

  const lineHeight = FONT_SIZE_BODY + 3;
  const padding = TABLE_CELL_PADDING * 2;
  const pageCapacity = PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const repeatHeader = header && repeatsAsHeader(header) ? header : undefined;

  const drawFragment = (row: BandRow, start: number, count: number): void => {
    const height = count * lineHeight + padding;
    const top = ctx.y;
    const bottom = top - height;
    if (row.isHeader) {
      ctx.page.drawRectangle({
        x: MARGIN_LEFT, y: bottom, width: bandWidth, height,
        color: COLOR_TABLE_HEADER_BG,
      });
    }
    for (const piece of row.pieces) {
      for (let l = start; l < Math.min(start + count, piece.lines.length); l++) {
        drawText(ctx.page, piece.lines[l]!, {
          x: MARGIN_LEFT + piece.column * colWidth + TABLE_CELL_PADDING,
          y: ctx.y - TABLE_CELL_PADDING - FONT_SIZE_BODY - (l - start) * lineHeight,
          size: FONT_SIZE_BODY, font: row.font, color: COLOR_TEXT,
        });
      }
    }
    for (const y of [top, bottom]) {
      ctx.page.drawLine({
        start: { x: MARGIN_LEFT, y }, end: { x: MARGIN_LEFT + bandWidth, y },
        thickness: 0.5, color: COLOR_TABLE_BORDER,
      });
    }
    // Vertical borders only along cell edges, so none crosses a spanning cell.
    for (const x of [...row.pieces.map((piece) => MARGIN_LEFT + piece.column * colWidth), MARGIN_LEFT + bandWidth]) {
      ctx.page.drawLine({
        start: { x, y: top }, end: { x, y: bottom },
        thickness: 0.5, color: COLOR_TABLE_BORDER,
      });
    }
    ctx.y -= height;
  };

  const continueTable = (rowIndex: number): void => {
    newPage(ctx);
    if (rowIndex > 0 && repeatHeader) drawFragment(repeatHeader, 0, repeatHeader.count);
  };

  for (let r = 0; r < prepared.length; r++) {
    const row = prepared[r]!;
    const fullHeight = row.count * lineHeight + padding;
    const freshCapacity = pageCapacity - (r > 0 && repeatHeader ? repeatHeader.count * lineHeight + padding : 0);
    // Keep ordinary rows together when they fit on a fresh page.
    if (fullHeight <= freshCapacity && ctx.y - fullHeight < MARGIN_BOTTOM) continueTable(r);
    let start = 0;
    while (start < row.count) {
      const available = Math.floor((ctx.y - MARGIN_BOTTOM - padding) / lineHeight);
      if (available < 1) {
        continueTable(r);
        continue;
      }
      const count = Math.min(available, row.count - start);
      drawFragment(row, start, count);
      start += count;
      if (start < row.count) continueTable(r);
    }
  }

  ctx.y -= PARAGRAPH_SPACING;
}

function renderHorizontalRule(ctx: RenderContext): void {
  ensureSpace(ctx, 20);
  ctx.y -= 8;
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y },
    end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: ctx.y },
    thickness: 0.75,
    color: rgb(0.82, 0.84, 0.86),
  });
  ctx.y -= 12;
}

function renderImagePlaceholder(ctx: RenderContext, el: Element): void {
  const alt = el.getAttribute('alt') || 'Image';
  ensureSpace(ctx, 40);
  ctx.y -= 4;

  // Draw a placeholder box
  ctx.page.drawRectangle({
    x: MARGIN_LEFT,
    y: ctx.y - 30,
    width: CONTENT_WIDTH,
    height: 30,
    borderWidth: 0.5,
    borderColor: rgb(0.8, 0.8, 0.85),
    color: rgb(0.97, 0.97, 0.98),
  });

  const label = normalizeText(`[Image: ${alt}]`);
  const textW = measureText(label, ctx.fontItalic, FONT_SIZE_SMALL);
  drawText(ctx.page, label, {
    x: MARGIN_LEFT + (CONTENT_WIDTH - textW) / 2,
    y: ctx.y - 20,
    size: FONT_SIZE_SMALL,
    font: ctx.fontItalic,
    color: COLOR_MUTED,
  });

  ctx.y -= 36 + PARAGRAPH_SPACING;
}

// ── Utilities ──────────────────────────────────────────────────────

function extractTextContent(el: Element): string {
  // Get text, collapsing whitespace
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  if (!text) return [];
  // normalizeText turns every line break into a space: the text is one paragraph.
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  const spaceWidth = measureText(' ', font, fontSize);

  let currentLine = '';
  let currentWidth = 0;
  for (const word of words) {
    // Widths add up (nothing is kerned), so each word is measured once.
    const wordWidth = measureText(word, font, fontSize);
    const width = currentLine ? currentWidth + spaceWidth + wordWidth : wordWidth;
    if (width <= maxWidth) {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
      currentWidth = width;
      continue;
    }
    if (currentLine) lines.push(currentLine);
    // The word starts a new line; one wider than a whole line (URL, hash)
    // breaks between characters (#1730), its last piece left open for the
    // words that follow.
    const pieces = breakToWidth(word, font, fontSize, maxWidth);
    for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i]!);
    currentLine = pieces[pieces.length - 1]!;
    currentWidth = measureText(currentLine, font, fontSize);
  }
  // A word, or the last piece of one: never empty.
  lines.push(currentLine);
  return lines;
}

/**
 * Splits `text` between code points into consecutive slices, each at most
 * `maxWidth` wide; joining them gives back `text`, and `''` yields `['']`.
 * A code point wider than `maxWidth` still gets a slice of its own, so a
 * `maxWidth` of zero or less yields one code point per slice. One pass, and
 * nothing is re-measured or rebuilt character by character.
 */
function breakToWidth(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  let end = 0;
  let width = 0;
  for (const char of text) {
    const charWidth = measureText(char, font, fontSize);
    if (end > start && width + charWidth > maxWidth) {
      pieces.push(text.slice(start, end));
      start = end;
      width = 0;
    }
    width += charWidth;
    end += char.length;
  }
  pieces.push(text.slice(start));
  return pieces;
}
