import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

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
      sql += ` AND category = $${paramIdx}`;
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
