import type { Color, PDFFont, PDFPage } from 'pdf-lib';

export interface ReportText {
  draw(page: PDFPage, value: string, options: { x: number; y: number; size: number; font: PDFFont; color: Color }, maxWidth?: number): void;
  width(font: PDFFont, value: string, size: number): number;
  readonly replaced: boolean;
}

/** #1732: ordinary space and NBSP are the only whitespace WinAnsi encodes. */
export function normalized(value: string): string {
  return value.normalize('NFC').replace(/[^\S \u00a0]/gu, ' ');
}
