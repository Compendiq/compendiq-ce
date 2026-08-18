import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UpdatePageIconSchema } from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { getUserAccessibleSpaces, userCanAccessPage } from '../../core/services/rbac-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { toPageIcon } from '../../core/services/page-icon.js';
import {
  deletePageIconImage,
  MAX_ICON_BYTES,
  PageIconStoreError,
  readPageIconImage,
  writePageIconImage,
} from '../../core/services/page-icon-store.js';

const IdParamSchema = z.object({ id: z.string().min(1) });
const ImageQuerySchema = z.object({ v: z.string().min(1).max(128).optional() });
const ImageBodySchema = z.object({
  dataUri: z.string().min(1).max(700_000),
});

type PageIconRow = {
  id: number;
  source: string;
  created_by_user_id: string | null;
  visibility: string;
  space_key: string | null;
  deleted_at: Date | null;
  icon_kind: string | null;
  icon_value: string | null;
};

async function loadPage(id: string): Promise<PageIconRow | null> {
  const isNumericId = /^\d+$/.test(id);
  const result = await query<PageIconRow>(
    `SELECT id, source, created_by_user_id, visibility, space_key, deleted_at, icon_kind, icon_value
       FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'}`,
    [isNumericId ? parseInt(id, 10) : id],
  );
  return result.rows[0] ?? null;
}

async function assertCanEdit(
  fastify: FastifyInstance,
  userId: string,
  page: PageIconRow,
): Promise<void> {
  if (page.deleted_at) {
    throw fastify.httpErrors.badRequest('Cannot edit a page that is in the trash');
  }
  if (page.source === 'standalone') {
    if (page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to edit this page');
    }
    return;
  }
  if (page.space_key) {
    const spaces = await getUserAccessibleSpaces(userId);
    if (!spaces.includes(page.space_key)) {
      throw fastify.httpErrors.forbidden('Access denied to this space');
    }
  }
}

function parseDataUri(dataUri: string): Buffer {
  const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUri);
  if (!match) {
    throw new PageIconStoreError('UNSUPPORTED', 'Use a PNG, JPEG, or WebP image');
  }
  const bytes = Buffer.from(match[1]!.replace(/\s/g, ''), 'base64');
  if (bytes.length === 0) {
    throw new PageIconStoreError('UNSUPPORTED', 'Use a PNG, JPEG, or WebP image');
  }
  if (bytes.length > MAX_ICON_BYTES) {
    throw new PageIconStoreError('TOO_LARGE', 'Image is larger than 512 KB');
  }
  return bytes;
}

export async function pagesIconRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  async function persistIcon(
    page: PageIconRow,
    kind: string | null,
    value: string | null,
    userId: string,
    request: FastifyRequest,
  ) {
    await query('UPDATE pages SET icon_kind = $2, icon_value = $3 WHERE id = $1', [
      page.id,
      kind,
      value,
    ]);
    if (page.visibility === 'shared' || page.source === 'confluence') {
      await cache.invalidateAcrossUsers('pages');
    } else {
      await cache.invalidate(userId, 'pages');
    }
    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(page.id), { icon: kind }, request);
    return { icon: toPageIcon(kind, value) };
  }

  fastify.patch('/pages/:id/icon', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const body = UpdatePageIconSchema.parse(request.body);
    const userId = request.userId;
    const page = await loadPage(id);
    if (!page) throw fastify.httpErrors.notFound('Page not found');
    await assertCanEdit(fastify, userId, page);

    if (body.icon === null) {
      await deletePageIconImage(page.id);
      return persistIcon(page, null, null, userId, request);
    }

    await deletePageIconImage(page.id);
    return persistIcon(page, body.icon.kind, body.icon.value, userId, request);
  });

  fastify.post('/pages/:id/icon-image', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const { dataUri } = ImageBodySchema.parse(request.body);
    const userId = request.userId;
    const page = await loadPage(id);
    if (!page) throw fastify.httpErrors.notFound('Page not found');
    await assertCanEdit(fastify, userId, page);

    try {
      const written = await writePageIconImage(page.id, parseDataUri(dataUri));
      return persistIcon(page, 'image', written.sha, userId, request);
    } catch (err) {
      if (err instanceof PageIconStoreError) {
        if (err.code === 'TOO_LARGE') throw fastify.httpErrors.payloadTooLarge(err.message);
        throw fastify.httpErrors.unprocessableEntity(err.message);
      }
      throw err;
    }
  });

  fastify.get('/pages/:id/icon-image', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const { v } = ImageQuerySchema.parse(request.query);
    const userId = request.userId;
    const page = await loadPage(id);
    if (!page || page.deleted_at) throw fastify.httpErrors.notFound('Page not found');
    if (!(await userCanAccessPage(userId, page.id))) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    if (page.icon_kind !== 'image' || !page.icon_value) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const sha = v ?? page.icon_value;
    const file = await readPageIconImage(page.id, sha);
    if (!file) throw fastify.httpErrors.notFound('Page not found');
    return reply
      .header('Content-Type', file.contentType)
      .header('Cache-Control', 'private, max-age=86400')
      .send(file.bytes);
  });
}
