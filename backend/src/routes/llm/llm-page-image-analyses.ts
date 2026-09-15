import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  ImageAnalysisInspectionSchema,
  type ImageAnalysisRow,
} from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import {
  getRetainedImageAnalysisIdentity,
  IMAGE_ANALYSIS_PROMPT_VERSION,
} from '../../domains/llm/services/image-analysis-identity.js';

/**
 * #1615 (ADR-027 D14) — the analysis inspection route: one row per referenced
 * image of a page, as `page_image_analyses` holds them. A diagnostic, not a
 * wire for readers: `error` is the D8 failure class (never the provider's
 * body), `payload` is withheld unless asked for, and both gates apply —
 * `requireAdmin` AND the caller's page visibility, so a shared `content_hash`
 * across pages grants nothing about a page the admin cannot see.
 */

const ADMIN_LIMIT = {
  config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } },
};

const ParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const QuerySchema = z.object({ payload: z.enum(['1', 'true']).optional() });

interface AnalysisRow {
  id: string;
  page_id: number;
  source: 'confluence' | 'local';
  attachment_key: string;
  content_hash: string;
  format: string;
  width: number | null;
  height: number | null;
  status: ImageAnalysisRow['status'];
  skip_reason: ImageAnalysisRow['skipReason'];
  provider_id: string | null;
  model: string | null;
  base_url: string | null;
  identity_hash: string | null;
  prompt_version: number | null;
  schema_version: number | null;
  analysis_version: number;
  attempts: number;
  next_attempt_at: Date | null;
  error: string | null;
  analyzed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  payload: unknown;
}

export async function llmPageImageAnalysesRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /admin/pages/:id/image-analyses[?payload=1]
  fastify.get(
    '/admin/pages/:id/image-analyses',
    { preHandler: fastify.requireAdmin, ...ADMIN_LIMIT },
    async (req, reply) => {
      const { id } = ParamsSchema.parse(req.params);
      const includePayload = QuerySchema.parse(req.query).payload !== undefined;

      // Visibility first, and 404 either way: "not found" and "not yours" are
      // one answer here, so the route confirms the existence of nothing it
      // would not also show.
      const spaces = await getUserAccessibleSpaces(req.userId);
      const visible = await query<{ id: number }>(
        `SELECT cp.id FROM pages cp
          WHERE cp.id = $3 AND cp.deleted_at IS NULL AND ${visiblePagesPredicate(1, 2)}`,
        [spaces, req.userId, id],
      );
      if (visible.rows.length === 0) return reply.code(404).send({ error: 'Page not found' });

      const [retainedIdentity, rows] = await Promise.all([
        getRetainedImageAnalysisIdentity(),
        query<AnalysisRow>(
          `SELECT id::text AS id, page_id, source, attachment_key, content_hash, format, width, height,
                  status, skip_reason, provider_id, model, base_url, identity_hash,
                  prompt_version, schema_version, analysis_version, attempts, next_attempt_at,
                  error, analyzed_at, created_at, updated_at,
                  ${includePayload ? 'payload' : 'NULL::jsonb AS payload'}
             FROM page_image_analyses
            WHERE page_id = $1
            ORDER BY source, attachment_key`,
          [id],
        ),
      ]);

      const retainedHash = retainedIdentity?.identityHash ?? null;
      return ImageAnalysisInspectionSchema.parse({
        pageId: id,
        retainedIdentity,
        promptVersion: IMAGE_ANALYSIS_PROMPT_VERSION,
        schemaVersion: IMAGE_ANALYSIS_SCHEMA_VERSION,
        rows: rows.rows.map((r) => ({
          id: Number(r.id),
          pageId: r.page_id,
          source: r.source,
          attachmentKey: r.attachment_key,
          contentHash: r.content_hash,
          format: r.format,
          width: r.width,
          height: r.height,
          status: r.status,
          skipReason: r.skip_reason,
          providerId: r.provider_id,
          model: r.model,
          baseUrl: r.base_url,
          identityHash: r.identity_hash,
          promptVersion: r.prompt_version,
          schemaVersion: r.schema_version,
          analysisVersion: r.analysis_version,
          attempts: r.attempts,
          nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
          error: r.error,
          analyzedAt: r.analyzed_at ? new Date(r.analyzed_at).toISOString() : null,
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
          // D5's validity predicate, exactly as composition and coverage bind it.
          valid:
            r.status === 'analyzed'
            && retainedHash !== null
            && r.identity_hash === retainedHash
            && r.prompt_version === IMAGE_ANALYSIS_PROMPT_VERSION
            && r.schema_version === IMAGE_ANALYSIS_SCHEMA_VERSION,
          ...(includePayload ? { payload: r.payload } : {}),
        })),
      });
    },
  );
}
