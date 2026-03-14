import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';

const CreateRequestSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  spaceKey: z.string().max(100).optional(),
});

const UpdateRequestSchema = z.object({
  assignedTo: z.string().uuid().nullable().optional(),
  status: z.enum(['open', 'in_progress', 'completed', 'declined']).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
});

const FulfillRequestSchema = z.object({
  pageId: z.number().int().positive(),
});

const ListRequestsQuerySchema = z.object({
  status: z.enum(['open', 'in_progress', 'completed', 'declined']).optional(),
  assignedToMe: z.enum(['true', 'false']).optional(),
  requestedByMe: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export async function knowledgeRequestRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/knowledge-requests - List requests with optional filters
  fastify.get('/knowledge-requests', async (request) => {
    const userId = request.userId;
    const { status, assignedToMe, requestedByMe, page, limit } = ListRequestsQuerySchema.parse(request.query);
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`kr.status = $${paramIdx++}`);
      params.push(status);
    }

    if (assignedToMe === 'true') {
      conditions.push(`kr.assigned_to = $${paramIdx++}`);
      params.push(userId);
    }

    if (requestedByMe === 'true') {
      conditions.push(`kr.requested_by = $${paramIdx++}`);
      params.push(userId);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM knowledge_requests kr ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await query<{
      id: number;
      title: string;
      description: string | null;
      requested_by: string;
      requester_username: string;
      assigned_to: string | null;
      assignee_username: string | null;
      space_key: string | null;
      status: string;
      fulfilled_by_page_id: number | null;
      priority: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT
         kr.id, kr.title, kr.description,
         kr.requested_by, u_req.username AS requester_username,
         kr.assigned_to, u_asgn.username AS assignee_username,
         kr.space_key, kr.status, kr.fulfilled_by_page_id, kr.priority,
         kr.created_at, kr.updated_at
       FROM knowledge_requests kr
       JOIN users u_req ON u_req.id = kr.requested_by
       LEFT JOIN users u_asgn ON u_asgn.id = kr.assigned_to
       ${whereClause}
       ORDER BY
         CASE kr.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END,
         kr.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );

    return {
      items: result.rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        requestedBy: { id: r.requested_by, username: r.requester_username },
        assignedTo: r.assigned_to ? { id: r.assigned_to, username: r.assignee_username } : null,
        spaceKey: r.space_key,
        status: r.status,
        fulfilledByPageId: r.fulfilled_by_page_id,
        priority: r.priority,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      total,
      page,
      limit,
    };
  });

  // POST /api/knowledge-requests - Create a new request
  fastify.post('/knowledge-requests', async (request, reply) => {
    const userId = request.userId;
    const body = CreateRequestSchema.parse(request.body);

    const result = await query<{ id: number; created_at: Date }>(
      `INSERT INTO knowledge_requests (title, description, requested_by, priority, space_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [body.title, body.description ?? null, userId, body.priority, body.spaceKey ?? null],
    );

    reply.status(201);
    return {
      id: result.rows[0].id,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority,
      status: 'open',
      createdAt: result.rows[0].created_at,
    };
  });

  // GET /api/knowledge-requests/:id - Get single request
  fastify.get('/knowledge-requests/:id', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);

    const result = await query<{
      id: number;
      title: string;
      description: string | null;
      requested_by: string;
      requester_username: string;
      assigned_to: string | null;
      assignee_username: string | null;
      space_key: string | null;
      status: string;
      fulfilled_by_page_id: number | null;
      priority: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT
         kr.id, kr.title, kr.description,
         kr.requested_by, u_req.username AS requester_username,
         kr.assigned_to, u_asgn.username AS assignee_username,
         kr.space_key, kr.status, kr.fulfilled_by_page_id, kr.priority,
         kr.created_at, kr.updated_at
       FROM knowledge_requests kr
       JOIN users u_req ON u_req.id = kr.requested_by
       LEFT JOIN users u_asgn ON u_asgn.id = kr.assigned_to
       WHERE kr.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return reply.notFound('Knowledge request not found');
    }

    const r = result.rows[0];
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      requestedBy: { id: r.requested_by, username: r.requester_username },
      assignedTo: r.assigned_to ? { id: r.assigned_to, username: r.assignee_username } : null,
      spaceKey: r.space_key,
      status: r.status,
      fulfilledByPageId: r.fulfilled_by_page_id,
      priority: r.priority,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });

  // PATCH /api/knowledge-requests/:id - Update a request
  fastify.patch('/knowledge-requests/:id', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const body = UpdateRequestSchema.parse(request.body);

    // Authorization: only requester or assignee can modify
    const existing = await query<{ requested_by: string; assigned_to: string | null }>(
      'SELECT requested_by, assigned_to FROM knowledge_requests WHERE id = $1',
      [id],
    );
    if (existing.rows.length === 0) {
      return reply.notFound('Knowledge request not found');
    }
    if (existing.rows[0].requested_by !== userId && existing.rows[0].assigned_to !== userId) {
      throw fastify.httpErrors.forbidden('Not authorized');
    }

    // Build SET clause dynamically
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    let paramIdx = 1;

    if (body.title !== undefined) {
      setClauses.push(`title = $${paramIdx++}`);
      params.push(body.title);
    }
    if (body.description !== undefined) {
      setClauses.push(`description = $${paramIdx++}`);
      params.push(body.description);
    }
    if (body.assignedTo !== undefined) {
      setClauses.push(`assigned_to = $${paramIdx++}`);
      params.push(body.assignedTo);
    }
    if (body.status !== undefined) {
      setClauses.push(`status = $${paramIdx++}`);
      params.push(body.status);
    }
    if (body.priority !== undefined) {
      setClauses.push(`priority = $${paramIdx++}`);
      params.push(body.priority);
    }

    if (setClauses.length === 0) {
      return reply.badRequest('No fields to update');
    }

    setClauses.push(`updated_at = NOW()`);

    const result = await query<{ id: number }>(
      `UPDATE knowledge_requests SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING id`,
      [...params, id],
    );

    if (result.rows.length === 0) {
      return reply.notFound('Knowledge request not found');
    }

    return { id, updated: true };
  });

  // POST /api/knowledge-requests/:id/fulfill - Link request to a page
  fastify.post('/knowledge-requests/:id/fulfill', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { pageId } = FulfillRequestSchema.parse(request.body);

    // Authorization: only requester or assignee can fulfill
    const existing = await query<{ requested_by: string; assigned_to: string | null }>(
      'SELECT requested_by, assigned_to FROM knowledge_requests WHERE id = $1',
      [id],
    );
    if (existing.rows.length === 0) {
      return reply.notFound('Knowledge request not found');
    }
    if (existing.rows[0].requested_by !== userId && existing.rows[0].assigned_to !== userId) {
      throw fastify.httpErrors.forbidden('Not authorized');
    }

    // Verify page exists
    const pageCheck = await query<{ id: number }>(
      'SELECT id FROM pages WHERE id = $1',
      [pageId],
    );
    if (pageCheck.rows.length === 0) {
      return reply.notFound('Page not found');
    }

    const result = await query<{ id: number }>(
      `UPDATE knowledge_requests
       SET status = 'completed', fulfilled_by_page_id = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id`,
      [pageId, id],
    );

    if (result.rows.length === 0) {
      return reply.notFound('Knowledge request not found');
    }

    return { id, fulfilled: true, pageId };
  });

  // DELETE /api/knowledge-requests/:id - Cancel a request (requester only)
  fastify.delete('/knowledge-requests/:id', async (request, reply) => {
    const userId = request.userId;
    const { id } = IdParamSchema.parse(request.params);

    // Only the requester can delete their own request
    const result = await query<{ id: number }>(
      'DELETE FROM knowledge_requests WHERE id = $1 AND requested_by = $2 RETURNING id',
      [id, userId],
    );

    if (result.rows.length === 0) {
      return reply.notFound('Knowledge request not found or not authorized');
    }

    return { id, deleted: true };
  });
}
