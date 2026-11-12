import { StandardFonts, type Color, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';

export interface PdfFonts { font: PDFFont; fontBold: PDFFont; fontItalic: PDFFont; fontMono: PDFFont }

/** The four text faces of an article PDF. */
export async function embedFonts(doc: PDFDocument): Promise<PdfFonts> {
  return {
    font: await doc.embedFont(StandardFonts.Helvetica),
    fontBold: await doc.embedFont(StandardFonts.HelveticaBold),
    fontItalic: await doc.embedFont(StandardFonts.HelveticaOblique),
    fontMono: await doc.embedFont(StandardFonts.Courier),
  };
}

/** Replace characters outside WinAnsi (Latin-1) encoding that StandardFonts can't render. */
export function normalizeText(text: string): string {
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
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ''); // strip remaining non-Latin-1
}

/** The width of `text` in `font` at `fontSize`. */
export function measureText(text: string, font: PDFFont, fontSize: number): number {
  return font.widthOfTextAtSize(text, fontSize);
}

export interface DrawTextOptions { x: number; y: number; size: number; font: PDFFont; color: Color }

/** Draws `text` on `page`. */
export function drawText(page: PDFPage, text: string, options: DrawTextOptions): void {
  page.drawText(text, options);
}
