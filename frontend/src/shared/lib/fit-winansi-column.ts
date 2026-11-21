import type { PDFFont } from 'pdf-lib';

/** pdf-lib measures standard-font strings with kerning, but draws plain Tj
 * with no pair adjustments. Fit the advances the PDF reader actually uses. */
export function fitWinAnsiColumn(text: string, maxWidth: number, font: PDFFont, size: number): string {
  const limit = maxWidth * 1000 / size;
  const ellipsis = font.widthOfTextAtSize('…', 1000);
  let units = 0, prefix = 0;
  // Input is guarded WinAnsi: each code unit is one printable glyph.
  for (let i = 0; i < text.length; i++) {
    units += font.widthOfTextAtSize(text[i]!, 1000);
    if (units > limit) return ellipsis <= limit ? text.slice(0, prefix) + '…' : '';
    if (units + ellipsis <= limit) prefix = i + 1;
  }
  return text;
}
