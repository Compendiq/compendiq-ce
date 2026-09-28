import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { generatePdf } from '../../core/services/pdf-service.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';
import { PDFDocument } from 'pdf-lib';
import { BatchExportBodySchema } from '@compendiq/contracts';
import { z } from 'zod';

const IdParamSchema = z.object({ id: z.string().min(1) });

export async function pagesExportRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/pages/:id/export/pdf - single article PDF
  fastify.post('/pages/:id/export/pdf', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const pageId = parseInt(id, 10);

    // Access control is the list definition (space access, standalone
    // ownership or sharing, page restrictions): an unreadable page answers
    // exactly like a missing one.
    const spaces = await getUserAccessibleSpaces(request.userId);
    const result = await query<{ title: string; body_html: string }>(
      `SELECT cp.title, cp.body_html
         FROM pages cp
        WHERE cp.id = $1
          AND cp.deleted_at IS NULL
          AND ${visiblePagesPredicate(2, 3)}`,
      [pageId, spaces, request.userId],
    );

    if (!result.rows.length) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const row = result.rows[0]!;

    const pdfBuffer = await generatePdf(row.body_html, { title: row.title });

    const filename = row.title
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
    const { pageIds } = BatchExportBodySchema.parse(request.body);

    // Only pages the caller may read under the list definition; unreadable
    // ids are indistinguishable from missing ones.
    const spaces = await getUserAccessibleSpaces(request.userId);
    const result = await query<{ id: number; title: string; body_html: string }>(
      `SELECT cp.id, cp.title, cp.body_html
         FROM pages cp
        WHERE cp.id = ANY($1::int[])
          AND cp.deleted_at IS NULL
          AND ${visiblePagesPredicate(2, 3)}
        ORDER BY cp.title`,
      [pageIds, spaces, request.userId],
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
