/**
 * Relocate an article between a local space and Confluence (#1123).
 *
 *   GET  /api/pages/:id/relocate/preview  — what the confirmation must state
 *   POST /api/pages/:id/relocate          — perform the move
 *
 * Distinct from `PUT /api/pages/:id/move` (`local-spaces.ts`), which only
 * re-parents inside the local tree and never touches Confluence.
 *
 * Authorisation is three gates, all of which must pass:
 *   1. `pages:relocate` — a dedicated global permission, seeded by migration
 *      086 onto `editor` and `space_admin`. CE has no admin UI for granting
 *      permissions, so that seed is the only way it reaches a role.
 *   2. the same per-space write check `POST /api/pages` applies, against the
 *      Confluence space on whichever side of the move it sits. The permission
 *      is an *additional* gate, never a bypass of space authorisation.
 *   3. `userCanAccessPage` for the page itself (404, not 403, so restricted
 *      pages stay indistinguishable from missing ones).
 *
 * The transactional guarantees live in `page-relocate-service.ts`.
 */

import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { requireGlobalPermission } from '../../core/utils/rbac-guards.js';
import { userCanAccessPage, getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { getClientForUser, isSyncRunning } from '../../domains/confluence/services/sync-service.js';
import { emitWebhookEvent } from '../../core/services/webhook-emit-hook.js';
import { logger } from '../../core/utils/logger.js';
import {
  relocatePage,
  countLocalVersions,
  collectAttachmentFilenames,
  parentKeyFor,
  RelocateError,
  RELOCATABLE_COLUMNS,
  type RelocatablePage,
} from '../../domains/knowledge/services/page-relocate-service.js';
import {
  RelocatePageSchema,
  RelocatePreviewQuerySchema,
  type RelocatePreview,
  type RelocatePrincipal,
} from '@compendiq/contracts';
import { z } from 'zod';

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** How many space principals the preview enumerates before truncating. */
const MAX_LISTED_PRINCIPALS = 50;

/**
 * Everyone holding a role assignment on a Confluence space, resolved to
 * display labels. System admins are not enumerated — they bypass RBAC
 * entirely, so listing them would imply a change that is not happening.
 */
async function spacePrincipals(
  spaceKey: string,
): Promise<{ principals: RelocatePrincipal[]; truncated: boolean }> {
  const res = await query<{ principal_type: string; principal_id: string; label: string | null }>(
    `SELECT sra.principal_type, sra.principal_id,
            CASE WHEN sra.principal_type = 'user' THEN u.username ELSE g.name END AS label
       FROM space_role_assignments sra
       LEFT JOIN users u ON sra.principal_type = 'user' AND u.id::text = sra.principal_id
       -- Compare as TEXT rather than casting principal_id to int: user rows
       -- hold a UUID there, and PostgreSQL does not guarantee that the
       -- principal_type guard short-circuits before the cast is evaluated.
       LEFT JOIN groups g ON sra.principal_type = 'group' AND g.id::text = sra.principal_id
      WHERE sra.space_key = $1
      ORDER BY label NULLS LAST
      LIMIT $2`,
    [spaceKey, MAX_LISTED_PRINCIPALS + 1],
  );
  const truncated = res.rows.length > MAX_LISTED_PRINCIPALS;
  return {
    principals: res.rows.slice(0, MAX_LISTED_PRINCIPALS).map((r) => ({
      kind: r.principal_type === 'group' ? ('group' as const) : ('user' as const),
      label: r.label ?? `${r.principal_type}:${r.principal_id}`,
    })),
    truncated,
  };
}

/** Display name for a user id, falling back to the raw id. */
async function usernameFor(userId: string | null): Promise<string> {
  if (!userId) return 'nobody';
  const res = await query<{ username: string }>('SELECT username FROM users WHERE id = $1', [userId]);
  return res.rows[0]?.username ?? userId;
}

/**
 * Resolve who gains and who loses read access (product decision 4).
 *
 * Standalone visibility and Confluence space RBAC are disjoint models, so the
 * delta is expressed against whichever destination the caller has chosen. When
 * the destination is not yet known the prose describes the target model and
 * the lists stay empty — the dialog must re-fetch once the user picks.
 */
async function resolveAccessChange(
  page: RelocatablePage,
  target: 'confluence' | 'local',
  destination: { spaceKey?: string; visibility?: 'private' | 'shared' },
  actingUserId: string,
): Promise<RelocatePreview['accessChange']> {
  if (target === 'confluence') {
    const owner = await usernameFor(page.created_by_user_id);
    const from =
      page.visibility === 'private'
        ? `Private article — only ${owner} can read it`
        : 'Shared article — every signed-in user can read it';

    if (!destination.spaceKey) {
      return { from, to: 'Everyone with access to the chosen Confluence space', gains: [], loses: [], truncated: false };
    }
    const { principals, truncated } = await spacePrincipals(destination.spaceKey);
    const to = `Governed by Confluence space ${destination.spaceKey} — everyone assigned to that space can read it`;

    if (page.visibility === 'private') {
      const ownerKeepsAccess = principals.some((p) => p.kind === 'user' && p.label === owner);
      return {
        from,
        to,
        gains: principals,
        loses: ownerKeepsAccess || truncated ? [] : [{ kind: 'owner', label: owner }],
        truncated,
      };
    }
    // Shared → space-scoped is a narrowing: everyone signed in loses access
    // unless they are assigned to the target space.
    return {
      from,
      to,
      gains: [],
      loses: [
        {
          kind: 'everyone',
          label: `All signed-in users without a role in space ${destination.spaceKey}`,
        },
      ],
      truncated,
    };
  }

  const spaceKey = page.space_key ?? '(unknown space)';
  const { principals, truncated } = page.space_key
    ? await spacePrincipals(page.space_key)
    : { principals: [], truncated: false };
  const from = `Governed by Confluence space ${spaceKey} — everyone assigned to that space can read it`;

  if (destination.visibility === 'private') {
    const actor = await usernameFor(actingUserId);
    return {
      from,
      to: `Private article — only ${actor} can read it`,
      gains: [],
      loses: principals.filter((p) => !(p.kind === 'user' && p.label === actor)),
      truncated,
    };
  }
  if (destination.visibility === 'shared') {
    return {
      from,
      to: 'Shared article — every signed-in user can read it',
      gains: [{ kind: 'everyone', label: 'All signed-in users' }],
      loses: [],
      truncated,
    };
  }
  return { from, to: 'Governed by the local visibility you choose', gains: [], loses: [], truncated };
}

/** Load a relocatable page, or throw the route-appropriate error. */
async function loadPage(fastify: FastifyInstance, pageId: number, userId: string): Promise<RelocatablePage> {
  const res = await query<RelocatablePage>(
    `SELECT ${RELOCATABLE_COLUMNS} FROM pages WHERE id = $1 AND deleted_at IS NULL`,
    [pageId],
  );
  const page = res.rows[0];
  if (!page) throw fastify.httpErrors.notFound('Page not found');
  // 404 (not 403) so a restricted page is indistinguishable from a missing one.
  if (!(await userCanAccessPage(userId, pageId))) {
    throw fastify.httpErrors.notFound('Page not found');
  }
  return page;
}

export async function pagesRelocateRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/pages/:id/relocate/preview
  fastify.get(
    '/pages/:id/relocate/preview',
    { preHandler: requireGlobalPermission('pages:relocate') },
    async (request): Promise<RelocatePreview> => {
      const { id } = IdParamSchema.parse(request.params);
      const q = RelocatePreviewQuerySchema.parse(request.query);
      const userId = request.userId;
      const page = await loadPage(fastify, id, userId);

      const target = page.source === 'standalone' ? ('confluence' as const) : ('local' as const);
      const childKey = parentKeyFor(page.source, page.id, page.confluence_id);
      const children = await query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM pages WHERE parent_id = $1 AND deleted_at IS NULL AND id <> $2',
        [childKey, page.id],
      );

      return {
        pageId: page.id,
        title: page.title,
        source: page.source === 'standalone' ? 'standalone' : 'confluence',
        spaceKey: page.space_key,
        confluenceId: page.confluence_id,
        target,
        childCount: parseInt(children.rows[0]?.count ?? '0', 10),
        attachmentCount: (await collectAttachmentFilenames(page)).length,
        localVersionCount: target === 'confluence' ? await countLocalVersions(page.id) : 0,
        accessChange: await resolveAccessChange(
          page,
          target,
          { spaceKey: q.spaceKey, visibility: q.visibility },
          userId,
        ),
        upstreamDeletion:
          target === 'local' && page.confluence_id
            ? {
                confluenceId: page.confluence_id,
                spaceKey: page.space_key ?? '',
                title: page.title,
              }
            : null,
      };
    },
  );

  // POST /api/pages/:id/relocate
  fastify.post(
    '/pages/:id/relocate',
    { preHandler: requireGlobalPermission('pages:relocate') },
    async (request) => {
      const { id } = IdParamSchema.parse(request.params);
      const body = RelocatePageSchema.parse(request.body);
      const userId = request.userId;

      // Requirement 5: a relocate is BLOCKED BY an in-flight sync, never the
      // reverse. It mutates `source` / `confluence_id`, which the sync upsert
      // (`ON CONFLICT (confluence_id)`) and deletion reconciliation both key
      // off, and neither takes a lock a route could join. Refusing for the
      // duration of a run is cheap; making the whole sync pipeline lockable is
      // not. See docs/architecture/08-flow-sync.md.
      if (await isSyncRunning()) {
        throw fastify.httpErrors.conflict(
          'A Confluence sync is currently running. Wait for it to finish and try again.',
        );
      }

      const page = await loadPage(fastify, id, userId);

      if (body.target === 'confluence' && page.source !== 'standalone') {
        throw fastify.httpErrors.badRequest('This article already lives in Confluence');
      }
      if (body.target === 'local' && page.source !== 'confluence') {
        throw fastify.httpErrors.badRequest('This article already lives in a local space');
      }

      // Gate 2: the same per-space write check POST /api/pages applies, on the
      // Confluence side of the move.
      const confluenceSpace = body.target === 'confluence' ? body.spaceKey : page.space_key;
      if (confluenceSpace) {
        const accessible = await getUserAccessibleSpaces(userId);
        if (!accessible.includes(confluenceSpace)) {
          throw fastify.httpErrors.forbidden('Access denied to this space');
        }
      }

      if (body.target === 'confluence') {
        const space = await query<{ source: string }>('SELECT source FROM spaces WHERE space_key = $1', [
          body.spaceKey,
        ]);
        if (space.rows.length === 0) {
          throw fastify.httpErrors.badRequest('Target space not found');
        }
        if (space.rows[0]!.source !== 'confluence') {
          throw fastify.httpErrors.badRequest('Target space is not a Confluence space');
        }
      } else {
        // Decision 1: the confirmation must NAME the Confluence page and space
        // being deleted upstream. Matching it against the live row is what
        // makes it a real confirmation rather than a boolean the client can
        // set blindly.
        const confirm = body.confirmDeleteConfluencePage;
        if (confirm.confluenceId !== page.confluence_id || confirm.spaceKey !== (page.space_key ?? '')) {
          throw fastify.httpErrors.conflict(
            'Confirmation does not match this page. Reload and confirm the Confluence page and space being deleted.',
          );
        }
        if (body.spaceKey !== null) {
          const space = await query<{ source: string }>('SELECT source FROM spaces WHERE space_key = $1', [
            body.spaceKey,
          ]);
          if (space.rows.length === 0) {
            throw fastify.httpErrors.badRequest('Target space not found');
          }
          if (space.rows[0]!.source !== 'local') {
            throw fastify.httpErrors.badRequest('Target space is not a local space');
          }
        }
      }

      const client = await getClientForUser(userId);
      if (!client) {
        throw fastify.httpErrors.badRequest('Confluence not configured');
      }

      let result;
      try {
        result = await relocatePage({ page, userId, input: body, client });
      } catch (err) {
        if (err instanceof RelocateError) {
          throw fastify.httpErrors.createError(err.statusCode, err.message);
        }
        throw err;
      }

      // A relocate changes what every user sees in trees, lists and space page
      // counts — clear all users' caches, not just the mover's (#893).
      await cache.invalidateAcrossUsers('pages');
      await cache.invalidateAcrossUsers('spaces');

      await logAuditEvent(
        userId,
        'PAGE_RELOCATED',
        'page',
        String(page.id),
        {
          from: page.source,
          to: result.source,
          fromSpaceKey: page.space_key,
          toSpaceKey: result.spaceKey,
          previousConfluenceId: page.confluence_id,
          confluenceId: result.confluenceId,
          childrenRepointed: result.childrenRepointed,
          versionsDiscarded: result.versionsDiscarded,
          attachmentsMigrated: result.attachmentsMigrated,
          upstreamDeleted: result.upstreamDeleted,
        },
        request,
      );

      if (body.target === 'local' && !result.upstreamDeleted) {
        logger.error(
          { pageId: page.id, confluenceId: page.confluence_id },
          'Relocate committed locally but the Confluence page was not deleted — it will be re-imported by the next sync as a separate page',
        );
      }

      emitWebhookEvent({
        eventType: 'page.updated',
        payload: {
          pageId: page.id,
          title: page.title,
          spaceKey: result.spaceKey,
          isLocal: result.source === 'standalone',
          updatedAt: new Date().toISOString(),
        },
      });

      return result;
    },
  );
}
