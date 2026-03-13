import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { generatePdf } from '../../core/services/pdf-service.js';
import { PDFDocument } from 'pdf-lib';

export async function pagesExportRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/pages/:id/export/pdf - single article PDF
  fastify.post('/pages/:id/export/pdf', async (request, reply) => {
    const { id } = request.params as { id: string };
    const pageId = parseInt(id, 10);

    const result = await query<{ title: string; body_html: string }>(
      'SELECT title, body_html FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [pageId],
    );

    if (!result.rows.length) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const { title, body_html } = result.rows[0];
    const pdfBuffer = await generatePdf(body_html, { title });

    const filename = title
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase();

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}.pdf"`)
      .send(pdfBuffer);
  });

  // POST /api/pages/export/pdf - batch export multiple articles
  fastify.post('/pages/export/pdf', async (request, reply) => {
    const { pageIds } = (request.body ?? {}) as { pageIds?: number[] };

    if (!pageIds?.length) {
      throw fastify.httpErrors.badRequest('pageIds required');
    }
    if (pageIds.length > 50) {
      throw fastify.httpErrors.badRequest('Maximum 50 pages per export');
    }

    const placeholders = pageIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await query<{ id: number; title: string; body_html: string }>(
      `SELECT id, title, body_html FROM pages WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY title`,
      pageIds,
    );

    if (!result.rows.length) {
      throw fastify.httpErrors.notFound('No pages found');
    }

    // Generate individual PDFs and merge with pdf-lib
    const merged = await PDFDocument.create();

    for (const row of result.rows) {
      const pdfBytes = await generatePdf(row.body_html, { title: row.title });
      const doc = await PDFDocument.load(pdfBytes);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }

    const mergedBytes = await merged.save();

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'attachment; filename="kb-export.pdf"')
      .send(Buffer.from(mergedBytes));
  });
}
