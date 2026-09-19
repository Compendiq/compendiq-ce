import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { UpdatePageIconSchema, type PageIcon } from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { getUserAccessibleSpaces, userCanAccessPage } from '../../core/services/rbac-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { toPageIcon } from '../../core/services/page-icon.js';
import {
  activatePageIconImage,
  deletePageIconImage,
  MAX_ICON_BYTES,
  PageIconStoreError,
  readPageIconImage,
  stagePageIconImage,
  validatePageIconImage,
} from '../../core/services/page-icon-store.js';
import {
  advancePageWriteIntent,
  completePageWriteIntent,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
} from '../../core/services/page-write-admission.js';
import { readFrozenPageAttachment } from '../../core/services/page-baseline-service.js';

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
  icon_color: string | null;
  icon_filled: boolean | null;
  content_revision: string;
  lifecycle_revision: string;
};

async function loadPage(id: string): Promise<PageIconRow | null> {
  const isNumericId = /^\d+$/.test(id);
  const result = await query<PageIconRow>(
    `SELECT id, source, created_by_user_id, visibility, space_key, deleted_at,
            icon_kind, icon_value, icon_color, icon_filled,
            content_revision::text, lifecycle_revision::text
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
    color: string | null,
    filled: boolean | null,
    client: PoolClient,
  ) {
    await client.query(
      `UPDATE pages
          SET icon_kind = $2, icon_value = $3, icon_color = $4, icon_filled = $5,
              content_revision = content_revision + 1
        WHERE id = $1`,
      [page.id, kind, value, color, filled],
    );
    return { icon: toPageIcon(kind, value, color, filled) };
  }

  async function finalizeIconMutation(
    page: PageIconRow,
    kind: string | null,
    userId: string,
    request: FastifyRequest,
  ): Promise<void> {
    if (page.visibility === 'shared' || page.source === 'confluence') {
      await cache.invalidateAcrossUsers('pages');
    } else {
      await cache.invalidate(userId, 'pages');
    }
    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(page.id), { icon: kind }, request);
  }

  fastify.patch('/pages/:id/icon', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const body = UpdatePageIconSchema.parse(request.body);
    const userId = request.userId;
    const page = await loadPage(id);
    if (!page) throw fastify.httpErrors.notFound('Page not found');
    await assertCanEdit(fastify, userId, page);
    const previousUploadedSha = page.icon_kind === 'image' &&
      typeof page.icon_value === 'string' &&
      /^[a-f0-9]{64}$/.test(page.icon_value)
      ? page.icon_value
      : null;
    if (page.icon_kind === 'image' && previousUploadedSha === null) {
      throw fastify.httpErrors.conflict('The uploaded page icon identity is invalid');
    }

    const intent = await reservePageWriteIntent({
      pageIds: [page.id],
      expectedRevisions: {
        [page.id]: {
          contentRevision: page.content_revision,
          lifecycleRevision: page.lifecycle_revision,
        },
      },
      kind: 'icon.metadata.patch',
      actorId: userId,
      effect: {
        effectClass: 'local',
        pageId: page.id,
        iconKind: body.icon?.kind ?? null,
        iconValue: body.icon?.value ?? null,
        iconColor:
          body.icon?.kind === 'lucide' || body.icon?.kind === 'brand'
            ? body.icon.color ?? null
            : null,
        iconFilled: body.icon?.kind === 'lucide' ? Boolean(body.icon.filled) : false,
        removesUploadedImage: page.icon_kind === 'image',
        previousSha256: previousUploadedSha,
      },
    });
    let result: { icon: PageIcon | null };
    if (page.icon_kind === 'image') {
      result = await runPageWriteIntentEffect(intent, { kind: 'local' }, () => advancePageWriteIntent(intent, async (client) => {
        await deletePageIconImage(page.id, previousUploadedSha!, client);
        return body.icon === null
          ? persistIcon(page, null, null, null, false, client)
          : persistIcon(
              page,
              body.icon.kind,
              body.icon.value,
              body.icon.kind === 'lucide' || body.icon.kind === 'brand'
                ? body.icon.color ?? null
                : null,
              body.icon.kind === 'lucide' ? Boolean(body.icon.filled) : false,
              client,
            );
      }));
      await completePageWriteIntent(intent, async () => undefined);
    } else {
      result = await completePageWriteIntent(intent, async (client) => {
        if (body.icon === null) {
          return persistIcon(page, null, null, null, false, client);
        }
        const color =
          body.icon.kind === 'lucide' || body.icon.kind === 'brand'
            ? body.icon.color ?? null
            : null;
        const filled = body.icon.kind === 'lucide' ? Boolean(body.icon.filled) : false;
        return persistIcon(page, body.icon.kind, body.icon.value, color, filled, client);
      });
    }
    await finalizeIconMutation(page, body.icon?.kind ?? null, userId, request);
    return result;
  });

  fastify.post('/pages/:id/icon-image', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const { dataUri } = ImageBodySchema.parse(request.body);
    const userId = request.userId;
    const page = await loadPage(id);
    if (!page) throw fastify.httpErrors.notFound('Page not found');
    await assertCanEdit(fastify, userId, page);

    try {
      const bytes = parseDataUri(dataUri);
      const image = validatePageIconImage(bytes);
      const intent = await reservePageWriteIntent({
        pageIds: [page.id],
        expectedRevisions: {
          [page.id]: {
            contentRevision: page.content_revision,
            lifecycleRevision: page.lifecycle_revision,
          },
        },
        kind: 'icon.image.put',
        actorId: userId,
        effect: {
          effectClass: 'local',
          pageId: page.id,
          sha256: image.sha,
          size: bytes.length,
          expectsMetadata: true,
          format: image.format,
        },
      });
      const staged = await runPageWriteIntentEffect(intent, { kind: 'local' }, () => stagePageIconImage(page.id, intent, bytes));
      const result = await runPageWriteIntentEffect(intent, { kind: 'local' }, () => advancePageWriteIntent(intent, async (client) => {
        await activatePageIconImage(page.id, staged, intent, client);
        return persistIcon(page, 'image', staged.sha, null, false, client);
      }));
      await completePageWriteIntent(intent, async () => undefined);
      await finalizeIconMutation(page, 'image', userId, request);
      return result;
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
    const sha = v ?? page.icon_value;
    if (!sha) throw fastify.httpErrors.notFound('Page not found');
    const frozen = await readFrozenPageAttachment({
      pageId: page.id,
      actorId: userId,
      locator: { store: 'icon', sha256: sha },
    });
    if (frozen.state === 'frozen_missing') {
      throw fastify.httpErrors.notFound('Page not found');
    }
    if (frozen.state === 'frozen') {
      return reply
        .header('Content-Type', frozen.mediaType)
        .header('Content-Length', String(frozen.size))
        .header('Cache-Control', 'private, max-age=86400')
        .send(frozen.stream);
    }
    if (page.icon_kind !== 'image' || !page.icon_value) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const file = await readPageIconImage(page.id, sha);
    if (!file) throw fastify.httpErrors.notFound('Page not found');
    return reply
      .header('Content-Type', file.contentType)
      .header('Cache-Control', 'private, max-age=86400')
      .send(file.bytes);
  });
}
