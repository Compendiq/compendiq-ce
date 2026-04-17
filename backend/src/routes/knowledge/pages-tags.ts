import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { autoTagPage, applyTags, autoTagAllPages, ALLOWED_TAGS, AllowedTag } from '../../domains/knowledge/services/auto-tagger.js';
import { getUsecaseLlmAssignment } from '../../core/services/admin-settings-service.js';
import { z } from 'zod';
import { logger } from '../../core/utils/logger.js';

const IdParamSchema = z.object({ id: z.string().min(1) });
// `model` is optional: when omitted, the route resolves the auto_tag use-case
// assignment from admin settings (issue #214). Frontend can stop asking the
// user to pick a model for auto-tag once the admin has configured one.
const AutoTagBodySchema = z.object({ model: z.string().min(1).optional() });
const ApplyTagsBodySchema = z.object({ tags: z.array(z.string().min(1)).min(1) });
const UpdateLabelsBodySchema = z.object({
  addLabels: z.array(z.string().min(1).max(100)).default([]),
  removeLabels: z.array(z.string().min(1).max(100)).default([]),
});

export async function pagesTagRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // POST /api/pages/:id/auto-tag - auto-tag a single page
  fastify.post('/pages/:id/auto-tag', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { model: bodyModel } = AutoTagBodySchema.parse(request.body);
    const model = bodyModel ?? (await getUsecaseLlmAssignment('auto_tag')).model;

    if (!model) {
      throw fastify.httpErrors.badRequest(
        'No model provided and no auto_tag model configured in admin settings',
      );
    }

    try {
      const result = await autoTagPage(userId, id, model);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error ? err.cause : undefined;
      const causeName = cause instanceof Error ? cause.name : '';
      request.log.error({ err, pageId: id, userId, model }, 'Auto-tag failed');

      if (message.startsWith('Page not found')) {
        throw fastify.httpErrors.notFound(message);
      }
      // Connection-level failures: server is genuinely unreachable
      if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        throw fastify.httpErrors.serviceUnavailable('LLM server is not reachable');
      }
      // Circuit breaker is open: server was recently failing (check cause
      // chain since autoTagContent wraps the original error)
      if (causeName === 'CircuitBreakerOpenError') {
        throw fastify.httpErrors.serviceUnavailable(cause instanceof Error ? cause.message : message);
      }
      // All other LLM errors: surface the actual error message so the user
      // (and logs) can see what really went wrong instead of a generic
      // "check LLM server connection" message (fixes #151).
      throw fastify.httpErrors.badGateway(`Auto-tagging failed: ${message}`);
    }
  });

  // POST /api/pages/:id/apply-tags - apply specific tags to a page
  fastify.post('/pages/:id/apply-tags', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { tags } = ApplyTagsBodySchema.parse(request.body);

    // Validate tags against allowed list
    const allowedSet = new Set<string>(ALLOWED_TAGS);
    const validTags = tags.filter((t) => allowedSet.has(t)) as AllowedTag[];
    if (validTags.length === 0) {
      throw fastify.httpErrors.badRequest(`No valid tags. Allowed: ${ALLOWED_TAGS.join(', ')}`);
    }

    const mergedLabels = await applyTags(userId, id, validTags);

    // Invalidate cache
    await cache.invalidate(userId, 'pages');

    return { labels: mergedLabels };
  });

  // PUT /api/pages/:id/labels - add/remove labels on a single page
  fastify.put('/pages/:id/labels', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { addLabels: labelsToAdd, removeLabels: labelsToRemove } = UpdateLabelsBodySchema.parse(request.body);

    if (labelsToAdd.length === 0 && labelsToRemove.length === 0) {
      throw fastify.httpErrors.badRequest('At least one of addLabels or removeLabels must be provided');
    }

    // Fetch existing labels — use integer PK for numeric IDs, confluence_id for strings
    const isNumericId = /^\d+$/.test(id);
    const existing = await query<{ id: number; confluence_id: string | null; labels: string[] }>(
      `SELECT id, confluence_id, labels FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'} AND deleted_at IS NULL`,
      [isNumericId ? parseInt(id, 10) : id],
    );

    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const page = existing.rows[0]!;
    let labels = page.labels || [];

    // Remove labels
    if (labelsToRemove.length > 0) {
      const removeSet = new Set(labelsToRemove);
      labels = labels.filter((l) => !removeSet.has(l));
    }

    // Add labels (deduplicating)
    if (labelsToAdd.length > 0) {
      const labelSet = new Set(labels);
      for (const label of labelsToAdd) {
        labelSet.add(label);
      }
      labels = [...labelSet];
    }

    await query(
      'UPDATE pages SET labels = $2 WHERE id = $1',
      [page.id, labels],
    );

    // Sync to Confluence (requires the Confluence page ID, not the integer PK)
    if (page.confluence_id) {
      const client = await getClientForUser(userId);
      if (client) {
        try {
          if (labelsToAdd.length > 0) {
            await client.addLabels(page.confluence_id, labelsToAdd);
          }
          for (const label of labelsToRemove) {
            await client.removeLabel(page.confluence_id, label);
          }
        } catch (err) {
          logger.error({ err, pageId: page.id, confluenceId: page.confluence_id, userId }, 'Failed to sync labels to Confluence');
        }
      }
    }

    // Invalidate cache
    await cache.invalidate(userId, 'pages');

    return { labels };
  });

  // POST /api/admin/auto-tag-all - auto-tag all pages without labels (admin)
  fastify.post('/admin/auto-tag-all', {
    preHandler: fastify.requireAdmin,
  }, async (request) => {
    const userId = request.userId;
    const { model: bodyModel } = AutoTagBodySchema.parse(request.body);
    const model = bodyModel ?? (await getUsecaseLlmAssignment('auto_tag')).model;

    if (!model) {
      throw fastify.httpErrors.badRequest(
        'No model provided and no auto_tag model configured in admin settings',
      );
    }

    // Run in background
    autoTagAllPages(userId, model).catch((err) => {
      logger.error({ err, userId }, 'Auto-tag all pages failed');
    });

    return { message: 'Auto-tagging started in background' };
  });
}
