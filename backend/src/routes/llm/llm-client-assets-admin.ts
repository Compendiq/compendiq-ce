import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ClientAssetInspectSchema,
  ClientAssetInstallRequestSchema,
  ClientAssetInstallStatusSchema,
  ClientAssetSearchResponseSchema,
  HfRepoIdSchema,
  HunspellInstallRequestSchema,
} from '@compendiq/contracts';
import {
  CLIENT_ASSET_UPLOAD_CHUNK_BYTES,
  writeClientAssetChunk,
} from '../../core/services/client-model-assets.js';
import {
  getClientModelInstallStatus,
  inspectClientModel,
  installClientModel,
  installHunspellModel,
  searchClientModels,
} from '../../core/services/client-model-hub.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_RATE_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

const RANGE = /^bytes[ =](\d+)-(\d+)\/(\d+)$/;
const SearchQuerySchema = z.object({ q: z.string().optional() });
const InspectQuerySchema = z.object({ repo: HfRepoIdSchema });

export async function llmClientAssetAdminRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.requireAdmin);

  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  fastify.get('/admin/client-assets/search', ADMIN_RATE_LIMIT, async (request) => {
    const { q } = SearchQuerySchema.parse(request.query);
    return ClientAssetSearchResponseSchema.parse(await searchClientModels(q ?? ''));
  });

  fastify.get('/admin/client-assets/inspect', ADMIN_RATE_LIMIT, async (request) => {
    const { repo } = InspectQuerySchema.parse(request.query);
    return ClientAssetInspectSchema.parse(await inspectClientModel(repo));
  });

  fastify.get('/admin/client-assets/install', ADMIN_RATE_LIMIT, async () => {
    return ClientAssetInstallStatusSchema.parse(getClientModelInstallStatus());
  });

  fastify.post('/admin/client-assets/install', ADMIN_RATE_LIMIT, async (request, reply) => {
    const body = ClientAssetInstallRequestSchema.parse(request.body);
    if (getClientModelInstallStatus().status === 'running') {
      return reply.code(409).send({ error: 'An install is already running', statusCode: 409 });
    }
    void installClientModel(body.repo).catch(() => {});
    return reply.code(202).send(ClientAssetInstallStatusSchema.parse(getClientModelInstallStatus()));
  });

  fastify.post('/admin/client-assets/hunspell/install', ADMIN_RATE_LIMIT, async (request, reply) => {
    const body = HunspellInstallRequestSchema.parse(request.body);
    await installHunspellModel(body.id);
    return reply.code(200).send({ ok: true, id: body.id });
  });

  fastify.put<{ Params: { modelId: string; '*': string } }>(
    '/admin/client-assets/:modelId/files/*',
    { ...ADMIN_RATE_LIMIT, bodyLimit: CLIENT_ASSET_UPLOAD_CHUNK_BYTES },
    async (request, reply) => {
      const file = request.params['*'] ?? '';
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw fastify.httpErrors.badRequest('Expected application/octet-stream');
      }
      let start: number | undefined;
      let total: number | undefined;
      const rangeHeader = request.headers['content-range'];
      if (typeof rangeHeader === 'string' && rangeHeader.length > 0) {
        const match = RANGE.exec(rangeHeader.trim());
        if (!match) throw fastify.httpErrors.badRequest('Invalid Content-Range');
        start = Number(match[1]);
        const end = Number(match[2]);
        total = Number(match[3]);
        if (end - start + 1 !== body.length) {
          throw fastify.httpErrors.badRequest('Content-Range does not match body length');
        }
      }
      try {
        const result = await writeClientAssetChunk({
          modelId: request.params.modelId,
          file,
          body,
          start,
          total,
        });
        return reply.send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        if (/not allowed/i.test(message)) throw fastify.httpErrors.notFound(message);
        throw fastify.httpErrors.badRequest(message);
      }
    },
  );
}
