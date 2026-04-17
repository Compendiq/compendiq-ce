/**
 * Client-side export utilities that lazy-load heavy libraries (pdf-lib, exceljs)
 * only when the user clicks an export button. These are never imported at module
 * level, keeping them out of the initial bundle.
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
 * Export tabular data to a single-page PDF.
 * Columns are inferred from the keys of the first row.
 */
export async function exportToPdf(
  filename: string,
  rows: Record<string, unknown>[],
  title?: string,
): Promise<void> {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const page = doc.addPage([595, 842]); // A4
  const { height } = page.getSize();
  let y = height - 50;

  // Title
  if (title) {
    page.drawText(title, { x: 50, y, font: boldFont, size: 16, color: rgb(0, 0, 0) });
    y -= 30;
  }

  if (rows.length === 0) {
    page.drawText('No data', { x: 50, y, font, size: 10, color: rgb(0.4, 0.4, 0.4) });
  } else {
    const cols = Object.keys(rows[0]!);

    // Header row
    const colWidth = Math.min(120, (495) / cols.length);
    cols.forEach((col, i) => {
      page.drawText(String(col).slice(0, 18), {
        x: 50 + i * colWidth,
        y,
        font: boldFont,
        size: 8,
        color: rgb(0, 0, 0),
      });
    });
    y -= 14;

    // Data rows
    for (const row of rows) {
      if (y < 50) break; // simple pagination guard
      cols.forEach((col, i) => {
        const val = row[col] != null ? String(row[col]).slice(0, 20) : '';
        page.drawText(val, {
          x: 50 + i * colWidth,
          y,
          font,
          size: 7,
          color: rgb(0.2, 0.2, 0.2),
        });
      });
      y -= 12;
    }
  }

  const bytes = await doc.save();
  triggerDownload(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }), filename);
}

/**
 * Export tabular data to an Excel workbook (.xlsx).
 * Each call produces a single-sheet workbook.
 */
export async function exportToExcel(
  filename: string,
  rows: Record<string, unknown>[],
  sheetName = 'Data',
): Promise<void> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  if (rows.length > 0) {
    sheet.columns = Object.keys(rows[0]!).map((key) => ({
      header: key,
      key,
      width: 20,
    }));
    for (const row of rows) {
      sheet.addRow(row);
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  triggerDownload(
    new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename,
  );
}
