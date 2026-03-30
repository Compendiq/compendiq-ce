import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { ChatMessage } from '../../domains/llm/services/ollama-service.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { ApplyImprovementRequestSchema } from '@atlasmind/contracts';
import { confluenceToHtml, htmlToConfluence, htmlToText, markdownToHtml } from '../../core/services/content-converter.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { IdParamSchema, ImprovementsQuerySchema } from './_helpers.js';

export async function llmConversationRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/llm/conversations - list conversations
  fastify.get('/llm/conversations', async (request) => {
    const result = await query<{
      id: string;
      model: string;
      title: string;
      created_at: Date;
      updated_at: Date;
    }>(
      'SELECT id, model, title, created_at, updated_at FROM llm_conversations WHERE user_id = $1 ORDER BY updated_at DESC',
      [request.userId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      model: r.model,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  });

  // GET /api/llm/conversations/:id
  fastify.get('/llm/conversations/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const result = await query<{
      id: string;
      model: string;
      title: string;
      messages: ChatMessage[];
      created_at: Date;
    }>(
      'SELECT id, model, title, messages, created_at FROM llm_conversations WHERE id = $1 AND user_id = $2',
      [id, request.userId],
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Conversation not found');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      model: row.model,
      title: row.title,
      messages: row.messages,
      createdAt: row.created_at,
    };
  });

  // DELETE /api/llm/conversations/:id
  fastify.delete('/llm/conversations/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    await query('DELETE FROM llm_conversations WHERE id = $1 AND user_id = $2', [id, request.userId]);
    return { message: 'Conversation deleted' };
  });

  // GET /api/llm/improvements - improvement history for a page
  fastify.get('/llm/improvements', async (request) => {
    const { pageId } = ImprovementsQuerySchema.parse(request.query);
    const userId = request.userId;

    let sql = 'SELECT li.id, p.confluence_id, li.improvement_type, li.model, li.status, li.created_at FROM llm_improvements li LEFT JOIN pages p ON p.id = li.page_id WHERE li.user_id = $1';
    const values: unknown[] = [userId];

    if (pageId) {
      sql += ' AND p.confluence_id = $2';
      values.push(pageId);
    }

    sql += ' ORDER BY li.created_at DESC LIMIT 50';

    const result = await query<{
      id: string;
      confluence_id: string | null;
      improvement_type: string;
      model: string;
      status: string;
      created_at: Date;
    }>(sql, values);

    return result.rows.map((r) => ({
      id: r.id,
      confluenceId: r.confluence_id ?? undefined,
      type: r.improvement_type,
      model: r.model,
      status: r.status,
      createdAt: r.created_at,
    }));
  });

  // POST /api/llm/improvements/apply - apply accepted improvement to a page + sync to Confluence
  fastify.post('/llm/improvements/apply', async (request) => {
    const body = ApplyImprovementRequestSchema.parse(request.body);
    const { pageId, improvedMarkdown, version, title } = body;
    const userId = request.userId;

    // Resolve page by confluenceId or internal id (standalone pages use numeric id)
    const isNumericId = /^\d+$/.test(pageId);
    const existing = await query<{
      id: number; version: number; title: string; space_key: string;
      source: string; confluence_id: string | null;
    }>(
      `SELECT id, version, title, space_key, source, confluence_id FROM pages
       WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'} AND deleted_at IS NULL`,
      [isNumericId ? parseInt(pageId, 10) : pageId],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const existingPage = existing.rows[0];
    const currentVersion = existingPage.version;
    const pageTitle = title ?? existingPage.title;

    if (version !== undefined && version < currentVersion) {
      throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
    }

    // Convert improved Markdown → HTML
    const bodyHtml = await markdownToHtml(improvedMarkdown);
    const bodyText = htmlToText(bodyHtml);

    const cache = new RedisCache(fastify.redis);
    let newVersion: number;

    if (existingPage.source === 'standalone') {
      // --- Standalone page: update local DB only (no Confluence sync) ---
      newVersion = currentVersion + 1;
      await query(
        `UPDATE pages SET
           title = $2, body_html = $3, body_text = $4,
           version = $5, last_modified_at = NOW(), embedding_dirty = TRUE,
           embedding_status = 'not_embedded', embedded_at = NULL
         WHERE id = $1`,
        [existingPage.id, pageTitle, bodyHtml, bodyText, newVersion],
      );
    } else {
      // --- Confluence page: sync to Confluence ---
      if (!existingPage.confluence_id) {
        throw fastify.httpErrors.badRequest('Page is missing confluence_id');
      }
      const client = await getClientForUser(userId);
      if (!client) {
        throw fastify.httpErrors.badRequest('Confluence not configured');
      }

      const confluenceId = existingPage.confluence_id;
      const storageBody = htmlToConfluence(bodyHtml);
      const page = await client.updatePage(confluenceId, pageTitle, storageBody, currentVersion);

      const updatedBodyHtml = confluenceToHtml(
        page.body?.storage?.value ?? storageBody,
        confluenceId,
        existingPage.space_key,
      );
      const updatedBodyText = htmlToText(updatedBodyHtml);
      newVersion = page.version.number;

      await query(
        `UPDATE pages SET
           title = $2, body_storage = $3, body_html = $4, body_text = $5,
           version = $6, last_synced = NOW(), embedding_dirty = TRUE,
           embedding_status = 'not_embedded', embedded_at = NULL
         WHERE id = $1`,
        [existingPage.id, pageTitle, page.body?.storage?.value ?? storageBody, updatedBodyHtml, updatedBodyText, newVersion],
      );
    }

    // Mark the most recent improvement record for this page as applied
    await query(
      `UPDATE llm_improvements SET status = 'applied'
       WHERE id = (
         SELECT li.id FROM llm_improvements li
         WHERE li.user_id = $1 AND li.page_id = $2 AND li.status IN ('streaming', 'completed')
         ORDER BY li.created_at DESC LIMIT 1
       )`,
      [userId, existingPage.id],
    );

    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(existingPage.id), { title: pageTitle, source: 'ai_improvement' }, request);

    return { id: existingPage.id, title: pageTitle, version: newVersion };
  });
}
