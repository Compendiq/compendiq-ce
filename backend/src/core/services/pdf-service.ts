import { chromium, type Browser } from 'playwright-core';
import { logger } from '../utils/logger.js';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    try {
      browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      logger.error({ err }, 'Failed to launch Chromium for PDF generation');
      throw new Error(
        'PDF generation unavailable: Chromium not installed. ' +
          'Install with: npx playwright install chromium',
        { cause: err },
      );
    }
  }
  return browser;
}

export async function generatePdf(
  html: string,
  options: { title?: string },
): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    const fullHtml = buildPdfHtml(html, options.title);
    await page.setContent(fullHtml, { waitUntil: 'networkidle' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '60px', bottom: '60px', left: '40px', right: '40px' },
      displayHeaderFooter: true,
      headerTemplate:
        '<div style="font-size:9px;width:100%;text-align:center;color:#666">' +
        '<span class="title"></span></div>',
      footerTemplate:
        '<div style="font-size:9px;width:100%;text-align:right;padding-right:20px;color:#666">' +
        'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      printBackground: true,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

function buildPdfHtml(bodyHtml: string, title?: string): string {
  const coverPage = title
    ? `<div class="cover-page"><h1>${escapeHtml(title)}</h1>` +
      `<div class="date">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div></div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { font-size: 28px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-top: 0; }
    h2 { font-size: 22px; margin-top: 24px; }
    h3 { font-size: 18px; margin-top: 20px; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 14px; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 8px; overflow-x: auto; }
    pre code { background: none; color: inherit; padding: 0; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; }
    th { background: #f9fafb; font-weight: 600; }
    blockquote { border-left: 4px solid #6366f1; padding-left: 16px; margin-left: 0; color: #4b5563; }
    img { max-width: 100%; height: auto; }
    .cover-page { text-align: center; padding-top: 200px; page-break-after: always; }
    .cover-page h1 { font-size: 36px; border: none; }
    .cover-page .date { color: #6b7280; font-size: 16px; margin-top: 20px; }
    @media print { .page-break { page-break-after: always; } }
  </style>
</head>
<body>
  ${coverPage}
  ${bodyHtml}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
