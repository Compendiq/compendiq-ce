// Shared by every authorized article in one export, never between requests.
export const MAX_PDF_CODE_ROWS = 1000;

export class PdfCodeLimitError extends Error {
  readonly statusCode = 413;

  constructor(limit: number) {
    super(`PDF export exceeds the limit of ${limit} printed code rows. Shorten the code blocks or export fewer articles.`);
  }
}

export class PdfCodeBudget {
  private remaining: number;

  constructor(private readonly limit = MAX_PDF_CODE_ROWS) {
    this.remaining = limit;
  }

  reserveRow(): void {
    if (this.remaining === 0) throw new PdfCodeLimitError(this.limit);
    this.remaining--;
  }
}
