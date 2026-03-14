import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

const CreateTemplateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  icon: z.string().max(10).optional(),
  bodyJson: z.string().min(1),
  bodyHtml: z.string().min(1),
  variables: z.array(z.unknown()).optional(),
  isGlobal: z.boolean().optional(),
  spaceKey: z.string().optional(),
});

const UpdateTemplateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  icon: z.string().max(10).optional(),
  bodyJson: z.string().min(1).optional(),
  bodyHtml: z.string().min(1).optional(),
  variables: z.array(z.unknown()).optional(),
  isGlobal: z.boolean().optional(),
  spaceKey: z.string().nullable().optional(),
});

const UseTemplateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  spaceKey: z.string().optional(),
});

const TemplateListQuerySchema = z.object({
  category: z.string().optional(),
  scope: z.enum(['all', 'global', 'mine']).default('all'),
});

export async function templateRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/templates - list templates
  fastify.get('/templates', async (request) => {
    const userId = request.userId;
    const params = TemplateListQuerySchema.parse(request.query);
    const { category, scope } = params;

    let sql = `
      SELECT id, title, description, category, icon, is_global, use_count,
             created_by, created_at
      FROM templates
      WHERE 1=1
    `;
    const values: unknown[] = [];
    let paramIdx = 1;

    if (scope === 'global') {
      sql += ' AND is_global = TRUE';
    } else if (scope === 'mine') {
      sql += ` AND created_by = $${paramIdx++}`;
      values.push(userId);
    } else {
      // 'all': show global templates + user's own
      sql += ` AND (is_global = TRUE OR created_by = $${paramIdx++})`;
      values.push(userId);
    }

    if (category) {
      sql += ` AND category = $${paramIdx++}`;
      values.push(category);
    }

    sql += ' ORDER BY is_global DESC, use_count DESC, title ASC';

    const result = await query<{
      id: number;
      title: string;
      description: string | null;
      category: string | null;
      icon: string | null;
      is_global: boolean;
      use_count: number;
      created_by: string;
      created_at: Date;
    }>(sql, values);

    return result.rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      category: r.category,
      icon: r.icon,
      isGlobal: r.is_global,
      useCount: r.use_count,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  });

  // GET /api/templates/:id - get single template with body
  fastify.get('/templates/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const result = await query<{
      id: number;
      title: string;
      description: string | null;
      category: string | null;
      icon: string | null;
      body_json: string;
      body_html: string;
      variables: unknown;
      created_by: string;
      is_global: boolean;
      space_key: string | null;
      use_count: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT * FROM templates WHERE id = $1 AND (is_global = TRUE OR created_by = $2)`,
      [id, userId],
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    const r = result.rows[0];
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      category: r.category,
      icon: r.icon,
      bodyJson: r.body_json,
      bodyHtml: r.body_html,
      variables: r.variables,
      createdBy: r.created_by,
      isGlobal: r.is_global,
      spaceKey: r.space_key,
      useCount: r.use_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });

  // POST /api/templates - create template
  fastify.post('/templates', async (request, reply) => {
    const userId = request.userId;
    const body = CreateTemplateSchema.parse(request.body);

    // Only admins can create global templates
    if (body.isGlobal && request.userRole !== 'admin') {
      throw fastify.httpErrors.forbidden('Only admins can create global templates');
    }

    const result = await query<{ id: number; created_at: Date }>(
      `INSERT INTO templates (title, description, category, icon, body_json, body_html, variables, created_by, is_global, space_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, created_at`,
      [
        body.title,
        body.description ?? null,
        body.category ?? null,
        body.icon ?? null,
        body.bodyJson,
        body.bodyHtml,
        JSON.stringify(body.variables ?? []),
        userId,
        body.isGlobal ?? false,
        body.spaceKey ?? null,
      ],
    );

    const row = result.rows[0];
    logger.info({ templateId: row.id, userId }, 'Template created');

    reply.status(201);
    return { id: row.id, createdAt: row.created_at };
  });

  // POST /api/templates/:id/use - create page content from template
  fastify.post('/templates/:id/use', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const body = UseTemplateSchema.parse(request.body ?? {});

    const tpl = await query<{
      id: number;
      title: string;
      body_json: string;
      body_html: string;
      is_global: boolean;
      created_by: string;
    }>(
      `SELECT id, title, body_json, body_html, is_global, created_by
       FROM templates WHERE id = $1 AND (is_global = TRUE OR created_by = $2)`,
      [id, userId],
    );

    if (tpl.rows.length === 0) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    // Increment use_count
    await query('UPDATE templates SET use_count = use_count + 1 WHERE id = $1', [id]);

    const row = tpl.rows[0];
    logger.info({ templateId: id, userId }, 'Template used');

    return {
      title: body.title ?? row.title,
      bodyJson: row.body_json,
      bodyHtml: row.body_html,
    };
  });

  // PATCH /api/templates/:id - update template
  fastify.patch('/templates/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const body = UpdateTemplateSchema.parse(request.body);

    // Check ownership (owner or admin can update)
    const existing = await query<{ created_by: string }>(
      'SELECT created_by FROM templates WHERE id = $1',
      [id],
    );

    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    if (existing.rows[0].created_by !== userId && request.userRole !== 'admin') {
      throw fastify.httpErrors.forbidden('Only the template owner or an admin can update');
    }

    // Only admins can set is_global
    if (body.isGlobal !== undefined && request.userRole !== 'admin') {
      throw fastify.httpErrors.forbidden('Only admins can set global flag');
    }

    // Build dynamic UPDATE
    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (body.title !== undefined) { sets.push(`title = $${paramIdx++}`); values.push(body.title); }
    if (body.description !== undefined) { sets.push(`description = $${paramIdx++}`); values.push(body.description); }
    if (body.category !== undefined) { sets.push(`category = $${paramIdx++}`); values.push(body.category); }
    if (body.icon !== undefined) { sets.push(`icon = $${paramIdx++}`); values.push(body.icon); }
    if (body.bodyJson !== undefined) { sets.push(`body_json = $${paramIdx++}`); values.push(body.bodyJson); }
    if (body.bodyHtml !== undefined) { sets.push(`body_html = $${paramIdx++}`); values.push(body.bodyHtml); }
    if (body.variables !== undefined) { sets.push(`variables = $${paramIdx++}`); values.push(JSON.stringify(body.variables)); }
    if (body.isGlobal !== undefined) { sets.push(`is_global = $${paramIdx++}`); values.push(body.isGlobal); }
    if (body.spaceKey !== undefined) { sets.push(`space_key = $${paramIdx++}`); values.push(body.spaceKey); }

    if (sets.length === 0) {
      throw fastify.httpErrors.badRequest('No fields to update');
    }

    sets.push(`updated_at = NOW()`);
    values.push(id);

    const result = await query<{ id: number; updated_at: Date }>(
      `UPDATE templates SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING id, updated_at`,
      values,
    );

    logger.info({ templateId: id, userId }, 'Template updated');

    return { id: result.rows[0].id, updatedAt: result.rows[0].updated_at };
  });

  // DELETE /api/templates/:id - delete template (owner or admin only)
  fastify.delete('/templates/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const existing = await query<{ created_by: string }>(
      'SELECT created_by FROM templates WHERE id = $1',
      [id],
    );

    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    if (existing.rows[0].created_by !== userId && request.userRole !== 'admin') {
      throw fastify.httpErrors.forbidden('Only the template owner or an admin can delete');
    }

    await query('DELETE FROM templates WHERE id = $1', [id]);

    logger.info({ templateId: id, userId }, 'Template deleted');

    return { message: 'Template deleted' };
  });
}
