import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateTemplateSchema,
  UpdateTemplateSchema,
  UseTemplateSchema,
  TemplateListQuerySchema,
} from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

const TEMPLATE_COLUMNS = `
  id, title, description, category, icon, body_json, body_html, variables,
  created_by, is_global, space_key, use_count, created_at, updated_at
`;

interface TemplateRow {
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
}

function mapTemplate(r: TemplateRow) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    icon: r.icon,
    bodyJson: r.body_json,
    bodyHtml: r.body_html,
    variables: r.variables ?? [],
    createdBy: r.created_by,
    isGlobal: r.is_global,
    spaceKey: r.space_key,
    useCount: r.use_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

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

  // GET /api/templates/:id - full template if visible
  fastify.get('/templates/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const result = await query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS}
       FROM templates
       WHERE id = $1 AND (is_global = TRUE OR created_by = $2)`,
      [id, userId],
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    return mapTemplate(result.rows[0]!);
  });

  // POST /api/templates - create a template
  fastify.post('/templates', async (request, reply) => {
    const userId = request.userId;
    const body = CreateTemplateSchema.parse(request.body);
    const isAdmin = request.userRole === 'admin';

    if (body.isGlobal === true && !isAdmin) {
      throw fastify.httpErrors.forbidden('Only admins can create global templates');
    }

    const isGlobal = isAdmin ? (body.isGlobal ?? false) : false;

    const result = await query<TemplateRow>(
      `INSERT INTO templates (
         title, description, category, icon, body_json, body_html, variables,
         created_by, is_global, space_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${TEMPLATE_COLUMNS}`,
      [
        body.title,
        body.description ?? null,
        body.category ?? null,
        body.icon ?? null,
        body.bodyJson,
        body.bodyHtml,
        JSON.stringify(body.variables ?? []),
        userId,
        isGlobal,
        body.spaceKey ?? null,
      ],
    );

    const row = result.rows[0]!;
    await logAuditEvent(
      userId,
      'TEMPLATE_CREATED',
      'template',
      String(row.id),
      { title: row.title, isGlobal: row.is_global },
      request,
    );
    logger.info({ templateId: row.id, userId, isGlobal }, 'Template created');

    reply.code(201);
    return mapTemplate(row);
  });

  // PUT /api/templates/:id - owner or admin
  fastify.put('/templates/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const isAdmin = request.userRole === 'admin';
    const body = UpdateTemplateSchema.parse(request.body ?? {});

    const existing = await query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS}
       FROM templates
       WHERE id = $1 AND (is_global = TRUE OR created_by = $2)`,
      [id, userId],
    );

    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    const current = existing.rows[0]!;
    if (current.is_global && !isAdmin) {
      throw fastify.httpErrors.forbidden('Only admins can modify global templates');
    }
    if (current.created_by !== userId && !isAdmin) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    if (body.isGlobal === true && !isAdmin) {
      throw fastify.httpErrors.forbidden('Only admins can make templates global');
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (body.title !== undefined) {
      sets.push(`title = $${paramIdx++}`);
      values.push(body.title);
    }
    if (body.description !== undefined) {
      sets.push(`description = $${paramIdx++}`);
      values.push(body.description);
    }
    if (body.category !== undefined) {
      sets.push(`category = $${paramIdx++}`);
      values.push(body.category);
    }
    if (body.icon !== undefined) {
      sets.push(`icon = $${paramIdx++}`);
      values.push(body.icon);
    }
    if (body.bodyJson !== undefined) {
      sets.push(`body_json = $${paramIdx++}`);
      values.push(body.bodyJson);
    }
    if (body.bodyHtml !== undefined) {
      sets.push(`body_html = $${paramIdx++}`);
      values.push(body.bodyHtml);
    }
    if (body.variables !== undefined) {
      sets.push(`variables = $${paramIdx++}`);
      values.push(JSON.stringify(body.variables));
    }
    if (body.spaceKey !== undefined) {
      sets.push(`space_key = $${paramIdx++}`);
      values.push(body.spaceKey);
    }
    if (body.isGlobal !== undefined && isAdmin) {
      sets.push(`is_global = $${paramIdx++}`);
      values.push(body.isGlobal);
    }

    sets.push('updated_at = NOW()');
    values.push(id);

    const result = await query<TemplateRow>(
      `UPDATE templates SET ${sets.join(', ')} WHERE id = $${paramIdx}
       RETURNING ${TEMPLATE_COLUMNS}`,
      values,
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    const row = result.rows[0]!;
    await logAuditEvent(
      userId,
      'TEMPLATE_UPDATED',
      'template',
      String(row.id),
      { title: row.title, isGlobal: row.is_global },
      request,
    );
    logger.info({ templateId: row.id, userId }, 'Template updated');

    return mapTemplate(row);
  });

  // DELETE /api/templates/:id - owner or admin
  fastify.delete('/templates/:id', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const isAdmin = request.userRole === 'admin';

    const existing = await query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS}
       FROM templates
       WHERE id = $1 AND (is_global = TRUE OR created_by = $2)`,
      [id, userId],
    );

    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    const current = existing.rows[0]!;
    if (current.is_global && !isAdmin) {
      throw fastify.httpErrors.forbidden('Only admins can delete global templates');
    }
    if (current.created_by !== userId && !isAdmin) {
      throw fastify.httpErrors.notFound('Template not found');
    }

    await query('DELETE FROM templates WHERE id = $1', [id]);

    await logAuditEvent(
      userId,
      'TEMPLATE_DELETED',
      'template',
      String(id),
      { title: current.title, isGlobal: current.is_global },
      request,
    );
    logger.info({ templateId: id, userId }, 'Template deleted');

    reply.code(204);
    return;
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

    const row = tpl.rows[0]!;
    logger.info({ templateId: id, userId }, 'Template used');

    return {
      title: body.title ?? row.title,
      bodyJson: row.body_json,
      bodyHtml: row.body_html,
    };
  });
}
