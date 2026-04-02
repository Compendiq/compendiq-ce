import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { generatePdf } from '../../core/services/pdf-service.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
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

    const result = await query<{
      title: string; body_html: string;
      source: string | null; space_key: string | null;
      created_by_user_id: string | null; visibility: string | null;
    }>(
      'SELECT title, body_html, source, space_key, created_by_user_id, visibility FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [pageId],
    );

    if (!result.rows.length) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const row = result.rows[0];

    // Access control: Confluence pages require RBAC space access; standalone pages
    // require ownership or shared visibility (matches pages-crud.ts pattern)
    if (row.source === 'confluence') {
      const spaces = await getUserAccessibleSpaces(request.userId);
      if (!row.space_key || !spaces.includes(row.space_key)) {
        throw fastify.httpErrors.notFound('Page not found');
      }
    } else {
      // Standalone: owner or shared
      if (row.created_by_user_id !== request.userId && row.visibility !== 'shared') {
        throw fastify.httpErrors.notFound('Page not found');
      }
    }

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

    const placeholders = pageIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await query<{
      id: number; title: string; body_html: string;
      source: string | null; space_key: string | null;
      created_by_user_id: string | null; visibility: string | null;
    }>(
      `SELECT id, title, body_html, source, space_key, created_by_user_id, visibility FROM pages WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY title`,
      pageIds,
    );

    if (!result.rows.length) {
      throw fastify.httpErrors.notFound('No pages found');
    }

    // RBAC: filter to pages the user can access
    const spaces = await getUserAccessibleSpaces(request.userId);
    const authorized = result.rows.filter((row) => {
      if (row.source === 'confluence') {
        return row.space_key ? spaces.includes(row.space_key) : false;
      }
      return row.created_by_user_id === request.userId || row.visibility === 'shared';
    });

    if (!authorized.length) {
      throw fastify.httpErrors.notFound('No accessible pages found');
    }

    // Generate individual PDFs and merge with pdf-lib
    const merged = await PDFDocument.create();

    for (const row of authorized) {
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
