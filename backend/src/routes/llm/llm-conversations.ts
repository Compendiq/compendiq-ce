import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { ChatMessage } from '../../domains/llm/services/ollama-service.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { ApplyImprovementRequestSchema } from '@kb-creator/contracts';
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

    let sql = 'SELECT id, confluence_id, improvement_type, model, status, created_at FROM llm_improvements WHERE user_id = $1';
    const values: unknown[] = [userId];

    if (pageId) {
      sql += ' AND confluence_id = $2';
      values.push(pageId);
    }

    sql += ' ORDER BY created_at DESC LIMIT 50';

    const result = await query<{
      id: string;
      confluence_id: string;
      improvement_type: string;
      model: string;
      status: string;
      created_at: Date;
    }>(sql, values);

    return result.rows.map((r) => ({
      id: r.id,
      confluenceId: r.confluence_id,
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

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Fetch current page metadata from local cache
    const existing = await query<{ version: number; title: string; space_key: string }>(
      'SELECT version, title, space_key FROM pages WHERE confluence_id = $1',
      [pageId],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const currentVersion = existing.rows[0].version;
    const pageTitle = title ?? existing.rows[0].title;

    if (version !== undefined && version < currentVersion) {
      throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
    }

    // Convert improved Markdown → HTML → Confluence XHTML
    const bodyHtml = await markdownToHtml(improvedMarkdown);
    const storageBody = htmlToConfluence(bodyHtml);

    // Push update to Confluence and get back the new version
    const page = await client.updatePage(pageId, pageTitle, storageBody, currentVersion);

    // Update local cache
    const updatedBodyHtml = confluenceToHtml(
      page.body?.storage?.value ?? storageBody,
      pageId,
      existing.rows[0]?.space_key,
    );
    const bodyText = htmlToText(updatedBodyHtml);

    await query(
      `UPDATE pages SET
         title = $2, body_storage = $3, body_html = $4, body_text = $5,
         version = $6, last_synced = NOW(), embedding_dirty = TRUE,
         embedding_status = 'not_embedded', embedded_at = NULL
       WHERE confluence_id = $1`,
      [pageId, pageTitle, page.body?.storage?.value ?? storageBody, updatedBodyHtml, bodyText, page.version.number],
    );

    // Mark the most recent improvement record for this page as applied
    await query(
      `UPDATE llm_improvements SET status = 'applied'
       WHERE id = (
         SELECT id FROM llm_improvements
         WHERE user_id = $1 AND confluence_id = $2 AND status IN ('streaming', 'completed')
         ORDER BY created_at DESC LIMIT 1
       )`,
      [userId, pageId],
    );

    // Invalidate page list cache
    const cache = new RedisCache(fastify.redis);
    await cache.invalidate(userId, 'pages');

    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', pageId, { title: pageTitle, source: 'ai_improvement' }, request);

    return { id: pageId, title: pageTitle, version: page.version.number };
  });
}
