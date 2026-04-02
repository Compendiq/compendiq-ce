import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from 'pdf-lib';
import { JSDOM } from 'jsdom';
import { logger } from '../utils/logger.js';

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

// ── Colors ─────────────────────────────────────────────────────────
const COLOR_TEXT = rgb(0.1, 0.1, 0.1);
const COLOR_HEADING = rgb(0.05, 0.05, 0.15);
const COLOR_MUTED = rgb(0.4, 0.4, 0.45);
const COLOR_CODE_BG = rgb(0.94, 0.95, 0.96);
const COLOR_CODE_TEXT = rgb(0.15, 0.15, 0.15);
const COLOR_BLOCKQUOTE_BORDER = rgb(0.39, 0.4, 0.95);
const COLOR_TABLE_BORDER = rgb(0.75, 0.78, 0.82);
const COLOR_TABLE_HEADER_BG = rgb(0.96, 0.97, 0.98);
const COLOR_LINK = rgb(0.2, 0.3, 0.7);
const COLOR_LIST_BULLET = rgb(0.35, 0.35, 0.4);

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
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);
    const fontMono = await doc.embedFont(StandardFonts.Courier);

    const ctx: RenderContext = {
      doc,
      page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
      y: PAGE_HEIGHT - MARGIN_TOP,
      pageNum: 1,
      font,
      fontBold,
      fontItalic,
      fontMono,
      title: options.title,
    };

    // Cover page
    if (options.title) {
      renderCoverPage(ctx, options.title);
    }

    // Parse HTML and render content
    const dom = new JSDOM(html);
    const body = dom.window.document.body;
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
    const page = pages[i];
    const pageNumber = i - startIdx + 1;
    const text = `Page ${pageNumber} of ${total - startIdx}`;
    const w = ctx.font.widthOfTextAtSize(text, FONT_SIZE_FOOTER);
    page.drawText(text, {
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
    const lineW = ctx.fontBold.widthOfTextAtSize(titleLines[i], FONT_SIZE_H1);
    ctx.page.drawText(titleLines[i], {
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
  const dateW = ctx.font.widthOfTextAtSize(date, FONT_SIZE_BODY);
  ctx.page.drawText(date, {
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
    ctx.page.drawText(line, {
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
    ctx.page.drawText(line, {
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
  const lines = code.split('\n');
  const lineHeight = FONT_SIZE_CODE + 4;
  const blockHeight = lines.length * lineHeight + CODE_PADDING * 2;

  ensureSpace(ctx, Math.min(blockHeight, 200));
  ctx.y -= 4;

  // Calculate background bounds, then draw background FIRST (so text renders on top)
  const bgTop = ctx.y + FONT_SIZE_CODE + CODE_PADDING;
  const bgBottom = ctx.y - lines.length * lineHeight - CODE_PADDING + FONT_SIZE_CODE;
  drawCodeBg(ctx.page, bgTop, Math.max(bgBottom, MARGIN_BOTTOM));

  // Now draw text on top of the background
  for (let i = 0; i < lines.length; i++) {
    ensureSpace(ctx, lineHeight + CODE_PADDING);

    const sanitized = sanitizeForStandardFont(lines[i].substring(0, 120));
    if (sanitized) {
      ctx.page.drawText(sanitized, {
        x: MARGIN_LEFT + CODE_PADDING,
        y: ctx.y,
        size: FONT_SIZE_CODE,
        font: ctx.fontMono,
        color: COLOR_CODE_TEXT,
      });
    }
    ctx.y -= lineHeight;
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
  const startY = ctx.y;

  for (const line of lines) {
    ensureSpace(ctx, LINE_HEIGHT);
    ctx.page.drawText(line, {
      x: MARGIN_LEFT + indent,
      y: ctx.y,
      size: FONT_SIZE_BODY,
      font: ctx.fontItalic,
      color: COLOR_MUTED,
    });
    ctx.y -= LINE_HEIGHT;
  }

  // Draw left border
  ctx.page.drawRectangle({
    x: MARGIN_LEFT,
    y: ctx.y,
    width: 3,
    height: startY - ctx.y + LINE_HEIGHT,
    color: COLOR_BLOCKQUOTE_BORDER,
  });

  ctx.y -= PARAGRAPH_SPACING;
}

function renderList(ctx: RenderContext, el: Element, ordered: boolean): void {
  const items = Array.from(el.querySelectorAll(':scope > li'));
  const indent = 20;

  for (let i = 0; i < items.length; i++) {
    const text = extractTextContent(items[i]);
    if (!text) continue;

    ensureSpace(ctx, LINE_HEIGHT);

    const bullet = ordered ? `${i + 1}.` : '•';
    ctx.page.drawText(bullet, {
      x: MARGIN_LEFT + 4,
      y: ctx.y,
      size: FONT_SIZE_BODY,
      font: ordered ? ctx.font : ctx.fontBold,
      color: COLOR_LIST_BULLET,
    });

    const lines = wrapText(text, ctx.font, FONT_SIZE_BODY, CONTENT_WIDTH - indent);
    for (const line of lines) {
      ensureSpace(ctx, LINE_HEIGHT);
      ctx.page.drawText(line, {
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

function renderTable(ctx: RenderContext, el: Element): void {
  const rows = Array.from(el.querySelectorAll('tr'));
  if (rows.length === 0) return;

  // Determine column count from first row
  const firstRow = rows[0];
  const firstCells = Array.from(firstRow.querySelectorAll('th, td'));
  const colCount = firstCells.length || 1;
  const colWidth = CONTENT_WIDTH / colCount;

  ensureSpace(ctx, LINE_HEIGHT * 2);
  ctx.y -= 4;

  for (let r = 0; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll('th, td'));
    const isHeader = cells[0]?.tagName.toLowerCase() === 'th';
    const cellFont = isHeader ? ctx.fontBold : ctx.font;
    const fontSize = isHeader ? FONT_SIZE_BODY : FONT_SIZE_BODY;

    // Calculate row height (based on tallest cell)
    let maxLines = 1;
    const cellTexts: string[][] = [];
    for (let c = 0; c < colCount; c++) {
      const text = cells[c]?.textContent?.trim() ?? '';
      const lines = wrapText(text, cellFont, fontSize, colWidth - TABLE_CELL_PADDING * 2);
      cellTexts.push(lines);
      maxLines = Math.max(maxLines, lines.length);
    }

    const rowHeight = maxLines * (fontSize + 3) + TABLE_CELL_PADDING * 2;
    ensureSpace(ctx, rowHeight);

    // Draw header background
    if (isHeader) {
      ctx.page.drawRectangle({
        x: MARGIN_LEFT,
        y: ctx.y - rowHeight + TABLE_CELL_PADDING,
        width: CONTENT_WIDTH,
        height: rowHeight,
        color: COLOR_TABLE_HEADER_BG,
      });
    }

    // Draw cell text
    for (let c = 0; c < colCount; c++) {
      const lines = cellTexts[c] ?? [''];
      for (let l = 0; l < lines.length; l++) {
        try {
          ctx.page.drawText(lines[l], {
            x: MARGIN_LEFT + c * colWidth + TABLE_CELL_PADDING,
            y: ctx.y - TABLE_CELL_PADDING - l * (fontSize + 3),
            size: fontSize,
            font: cellFont,
            color: COLOR_TEXT,
          });
        } catch {
          // Skip unencodable characters
        }
      }
    }

    // Draw row borders
    const rowTop = ctx.y + TABLE_CELL_PADDING;
    const rowBottom = ctx.y - rowHeight + TABLE_CELL_PADDING;

    // Horizontal borders
    ctx.page.drawLine({
      start: { x: MARGIN_LEFT, y: rowTop },
      end: { x: MARGIN_LEFT + CONTENT_WIDTH, y: rowTop },
      thickness: 0.5,
      color: COLOR_TABLE_BORDER,
    });
    if (r === rows.length - 1) {
      ctx.page.drawLine({
        start: { x: MARGIN_LEFT, y: rowBottom },
        end: { x: MARGIN_LEFT + CONTENT_WIDTH, y: rowBottom },
        thickness: 0.5,
        color: COLOR_TABLE_BORDER,
      });
    }

    // Vertical borders
    for (let c = 0; c <= colCount; c++) {
      const x = MARGIN_LEFT + c * colWidth;
      ctx.page.drawLine({
        start: { x, y: rowTop },
        end: { x, y: rowBottom },
        thickness: 0.5,
        color: COLOR_TABLE_BORDER,
      });
    }

    ctx.y -= rowHeight;
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

  const label = `[Image: ${alt}]`;
  try {
    const textW = ctx.fontItalic.widthOfTextAtSize(label, FONT_SIZE_SMALL);
    ctx.page.drawText(label, {
      x: MARGIN_LEFT + (CONTENT_WIDTH - textW) / 2,
      y: ctx.y - 20,
      size: FONT_SIZE_SMALL,
      font: ctx.fontItalic,
      color: COLOR_MUTED,
    });
  } catch {
    // skip unencodable alt text
  }

  ctx.y -= 36 + PARAGRAPH_SPACING;
}

// ── Utilities ──────────────────────────────────────────────────────

/** Replace characters outside WinAnsi (Latin-1) encoding that StandardFonts can't render. */
function sanitizeForStandardFont(text: string): string {
  return text
    .replace(/\t/g, '    ')          // tabs to spaces
    .replace(/[\u2018\u2019]/g, "'") // smart single quotes
    .replace(/[\u201C\u201D]/g, '"') // smart double quotes
    .replace(/\u2013/g, '-')         // en-dash
    .replace(/\u2014/g, '--')        // em-dash
    .replace(/\u2026/g, '...')       // ellipsis
    .replace(/\u2192/g, '->')        // right arrow
    .replace(/\u2190/g, '<-')        // left arrow
    .replace(/\u2022/g, '*')         // bullet
    .replace(/\u00A0/g, ' ')         // non-breaking space
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ''); // strip remaining non-Latin-1
}

function extractTextContent(el: Element): string {
  // Get text, collapsing whitespace
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  if (!text) return [];
  const sanitized = sanitizeForStandardFont(text);
  if (!sanitized) return [];
  const lines: string[] = [];
  const paragraphs = sanitized.split('\n');

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      let width: number;
      try {
        width = font.widthOfTextAtSize(testLine, fontSize);
      } catch {
        // Character encoding issue — skip this word
        continue;
      }

      if (width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [''];
}
