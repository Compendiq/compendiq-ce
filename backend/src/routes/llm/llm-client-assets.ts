import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { ClientAssetIdSchema, ClientAssetManifestSchema, clientAssetKind } from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';
import {
  clientAssetEtag,
  listClientAssetManifest,
  parseBytesRange,
  resolveClientAssetPath,
  statClientAsset,
} from '../../core/services/client-model-assets.js';
import { resolvePolicyClientAsset } from '../../core/services/client-model-asset-policy.js';

function isTruthyAdminFlag(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

async function slmEnabled(): Promise<boolean> {
  const result = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = 'client_inference_enabled'`,
  );
  return isTruthyAdminFlag(result.rows[0]?.setting_value);
}

export async function llmClientAssetRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/models/client-assets',
    { preHandler: requireGlobalPermission('llm:query') },
    async () => {
      const enabled = await slmEnabled();
      const manifest = await listClientAssetManifest(enabled);
      return ClientAssetManifestSchema.parse(manifest);
    },
  );

  fastify.get<{ Params: { modelId: string; '*': string } }>(
    '/models/client-assets/:modelId/*',
    { preHandler: requireGlobalPermission('llm:query') },
    async (request, reply) => {
      const file = request.params['*'] ?? '';
      const parsedId = ClientAssetIdSchema.safeParse(request.params.modelId);
      if (parsedId.success && clientAssetKind(parsedId.data) === 'onnx' && !(await slmEnabled())) {
        return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
      }
      const resolved = resolveClientAssetPath(request.params.modelId, file);
      if (!resolved.ok) return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
      const verified = await resolvePolicyClientAsset(resolved.modelId, resolved.file);
      try {
        const local = verified ? null : await statClientAsset(resolved.modelId, resolved.file);
        const found = verified ?? (local && {
          size: local.size,
          etag: clientAssetEtag(local.mtimeMs, local.size),
          stream: async (range?: { start: number; end: number }) => createReadStream(local.abs, range),
        });
        if (!found) return reply.code(404).send({ error: 'Not Found', statusCode: 404 });

        const range = parseBytesRange(request.headers.range, found.size);
        if (range === 'unsatisfiable') {
          reply.header('Content-Range', `bytes */${found.size}`);
          return reply.code(416).send({ error: 'Range Not Satisfiable', statusCode: 416 });
        }

        const etag = found.etag;
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
        reply.header('ETag', etag);
        reply.header('Accept-Ranges', 'bytes');

        if (range === 'full' && request.headers['if-none-match'] === etag) {
          return reply.code(304).send();
        }

        if (range === 'full') {
          reply.header('Content-Length', found.size);
          return reply.send(await found.stream());
        }

        reply.code(206);
        reply.header('Content-Range', `bytes ${range.start}-${range.end}/${found.size}`);
        reply.header('Content-Length', range.end - range.start + 1);
        return reply.send(await found.stream(range));
      } finally {
        await verified?.dispose();
      }
    },
  );
}
