import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { getVersionHistory, getVersion, getSemanticDiff, saveVersionSnapshot } from '../../domains/knowledge/services/version-tracker.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { z } from 'zod';

const IdParamSchema = z.object({ id: z.string().min(1) });
const VersionParamSchema = z.object({ id: z.string().min(1), version: z.coerce.number().int().positive() });
const SemanticDiffSchema = z.object({
  v1: z.number().int().positive(),
  v2: z.number().int().positive(),
  model: z.string().optional(),
});

export async function pagesVersionRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Verify user has RBAC access to the page's space before returning version data
  async function verifyPageAccess(userId: string, confluenceId: string): Promise<void> {
    const pageResult = await query<{ space_key: string | null; source: string; visibility: string; created_by_user_id: string | null }>(
      'SELECT space_key, source, visibility, created_by_user_id FROM pages WHERE confluence_id = $1',
      [confluenceId],
    );
    if (pageResult.rows.length === 0) return; // page not found — let downstream handle 404
    const page = pageResult.rows[0];
    if (page.source === 'standalone') {
      if (page.visibility === 'private' && page.created_by_user_id !== userId) {
        throw fastify.httpErrors.forbidden('Access denied');
      }
      return; // shared standalone pages are accessible to all
    }
    if (page.space_key) {
      const accessibleSpaces = await getUserAccessibleSpaces(userId);
      if (!accessibleSpaces.includes(page.space_key)) {
        throw fastify.httpErrors.forbidden('Access denied to this space');
      }
    }
  }

  // GET /api/pages/:id/versions - list version history
  fastify.get('/pages/:id/versions', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    await verifyPageAccess(userId, id);

    const versions = await getVersionHistory(userId, id);

    // Also include the current version from pages
    const currentResult = await query<{
      version: number;
      title: string;
      last_modified_at: Date | null;
    }>(
      'SELECT version, title, last_modified_at FROM pages WHERE confluence_id = $1',
      [id],
    );

    const currentVersion = currentResult.rows[0]
      ? {
          versionNumber: currentResult.rows[0].version,
          title: currentResult.rows[0].title,
          syncedAt: currentResult.rows[0].last_modified_at ?? new Date(),
          isCurrent: true,
        }
      : null;

    return {
      versions: [
        ...(currentVersion ? [currentVersion] : []),
        ...versions.map((v) => ({ ...v, isCurrent: false })),
      ],
      pageId: id,
    };
  });

  // GET /api/pages/:id/versions/:version - get specific version
  fastify.get('/pages/:id/versions/:version', async (request) => {
    const { id, version: versionNum } = VersionParamSchema.parse(request.params);
    const userId = request.userId;

    await verifyPageAccess(userId, id);

    // Check if requesting current version
    const currentResult = await query<{
      version: number;
      title: string;
      body_html: string;
      body_text: string;
    }>(
      'SELECT version, title, body_html, body_text FROM pages WHERE confluence_id = $1',
      [id],
    );

    if (currentResult.rows.length > 0 && currentResult.rows[0].version === versionNum) {
      return {
        confluenceId: id,
        versionNumber: versionNum,
        title: currentResult.rows[0].title,
        bodyHtml: currentResult.rows[0].body_html,
        bodyText: currentResult.rows[0].body_text,
        isCurrent: true,
      };
    }

    // Get from version history
    const pageVersion = await getVersion(userId, id, versionNum);
    if (!pageVersion) {
      throw fastify.httpErrors.notFound(`Version ${versionNum} not found`);
    }

    return {
      confluenceId: pageVersion.confluenceId,
      versionNumber: pageVersion.versionNumber,
      title: pageVersion.title,
      bodyHtml: pageVersion.bodyHtml,
      bodyText: pageVersion.bodyText,
      syncedAt: pageVersion.syncedAt,
      isCurrent: false,
    };
  });

  // POST /api/pages/:id/versions/semantic-diff - AI-generated diff between two versions
  fastify.post('/pages/:id/versions/semantic-diff', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const { v1, v2, model = 'qwen3:32b' } = SemanticDiffSchema.parse(request.body);

    await verifyPageAccess(userId, id);

    // For the current version, save a snapshot first so getSemanticDiff can find it
    const current = await query<{
      version: number;
      title: string;
      body_html: string;
      body_text: string;
    }>(
      'SELECT version, title, body_html, body_text FROM pages WHERE confluence_id = $1',
      [id],
    );

    if (current.rows.length > 0) {
      const row = current.rows[0];
      // Ensure current version exists in page_versions for comparison
      await saveVersionSnapshot(id, row.version, row.title, row.body_html, row.body_text);
    }

    const diff = await getSemanticDiff(userId, id, v1, v2, model);
    return { diff, v1, v2, pageId: id };
  });
}
