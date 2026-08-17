import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import {
  ApplyImprovementRequestSchema,
  ConversationIdParamSchema,
  ConversationListQuerySchema,
  type ConversationSummary,
  type StoredChatMessage,
  type TitleSource,
} from '@compendiq/contracts';
import { confluenceToHtml, htmlToConfluence, htmlToText, markdownToHtml, protectMedia, restoreMedia, extractLayoutSkeleton, LayoutRecoveryError } from '../../core/services/content-converter.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { ImprovementsQuerySchema } from './_helpers.js';

/** One row of the conversation list / detail SELECTs (#1361). */
type ConversationRow = {
  id: string;
  title: string;
  title_source: TitleSource;
  model: string;
  page_ref: number | null;
  page_title: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * The summary columns every conversation route returns. `title` is COALESCEd
 * on read (a whitespace-only first question yields '' — the DB column stays
 * nullable so the migration cannot fail on a legacy row); the page join is
 * `deleted_at IS NULL` because pages are SOFT deleted and the FK's SET NULL
 * only fires on a hard delete. No visibility predicate on the join: page_ref
 * was authorised at write time (llm-ask.ts), and the row records where the
 * user started a conversation they were allowed to have.
 */
const SUMMARY_COLUMNS = `c.id, COALESCE(NULLIF(trim(c.title), ''), 'Untitled conversation') AS title,
       c.title_source, c.model, c.page_ref, p.title AS page_title, c.created_at, c.updated_at`;
const SUMMARY_FROM = `FROM llm_conversations c
    LEFT JOIN pages p ON p.id = c.page_ref AND p.deleted_at IS NULL`;
// (`SUMMARY_FROM` is used by the list route below and by GET :id in Task 12.)

function toSummary(r: ConversationRow): ConversationSummary {
  return {
    id: r.id,
    title: r.title,
    titleSource: r.title_source,
    model: r.model,
    pageId: r.page_ref,
    pageTitle: r.page_title,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

// Keyset cursor: the (updated_at, id) of the last row served. Keyset rather
// than offset because this list is prepended-to on every ask (updated_at
// bumps), so an offset page shifts under the reader; rename does NOT bump
// updated_at, so paging is stable through it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function encodeCursor(updatedAtIso: string, id: string): string {
  return Buffer.from(JSON.stringify([updatedAtIso, id])).toString('base64url');
}
function decodeCursor(raw: string | undefined): { updatedAt: string; id: string } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) && parsed.length === 2
      && typeof parsed[0] === 'string' && !Number.isNaN(Date.parse(parsed[0]))
      && typeof parsed[1] === 'string' && UUID_RE.test(parsed[1])
    ) {
      return { updatedAt: new Date(parsed[0]).toISOString(), id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
}

export async function llmConversationRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/llm/conversations?limit&cursor — the user's list, newest first (#1361)
  fastify.get('/llm/conversations', async (request) => {
    const { limit, cursor } = ConversationListQuerySchema.parse(request.query);
    let after: { updatedAt: string; id: string } | null;
    try {
      after = decodeCursor(cursor);
    } catch {
      throw fastify.httpErrors.badRequest('Invalid cursor');
    }
    const result = await query<ConversationRow>(
      `SELECT ${SUMMARY_COLUMNS}
       ${SUMMARY_FROM}
       WHERE c.user_id = $1
         AND ($2::timestamptz IS NULL OR (c.updated_at, c.id) < ($2::timestamptz, $3::uuid))
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $4`,
      [request.userId, after?.updatedAt ?? null, after?.id ?? null, limit + 1],
    );
    const page = result.rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = result.rows.length > limit && last ? encodeCursor(last.updated_at.toISOString(), last.id) : null;
    return { items: page.map(toSummary), nextCursor };
  });

  // GET /api/llm/conversations/:id
  fastify.get('/llm/conversations/:id', async (request) => {
    const { id } = ConversationIdParamSchema.parse(request.params);
    const result = await query<{
      id: string;
      model: string;
      title: string;
      messages: StoredChatMessage[];
      created_at: Date;
    }>(
      'SELECT id, model, title, messages, created_at FROM llm_conversations WHERE id = $1 AND user_id = $2',
      [id, request.userId],
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Conversation not found');
    }

    const row = result.rows[0]!;
    return {
      id: row.id,
      model: row.model,
      title: row.title,
      messages: row.messages,
      createdAt: row.created_at,
    };
  });

  // DELETE /api/llm/conversations/:id
  fastify.delete('/llm/conversations/:id', async (request) => {
    const { id } = ConversationIdParamSchema.parse(request.params);
    await query('DELETE FROM llm_conversations WHERE id = $1 AND user_id = $2', [id, request.userId]);
    return { message: 'Conversation deleted' };
  });

  // GET /api/llm/improvements - improvement history for a page
  fastify.get('/llm/improvements', async (request) => {
    const { pageId } = ImprovementsQuerySchema.parse(request.query);
    const userId = request.userId;

    let sql = 'SELECT li.id, p.confluence_id, li.improvement_type, li.model, li.status, li.created_at FROM llm_improvements li LEFT JOIN pages p ON p.id = li.page_id WHERE li.user_id = $1';
    const values: unknown[] = [userId];

    if (pageId) {
      sql += ' AND p.confluence_id = $2';
      values.push(pageId);
    }

    sql += ' ORDER BY li.created_at DESC LIMIT 50';

    const result = await query<{
      id: string;
      confluence_id: string | null;
      improvement_type: string;
      model: string;
      status: string;
      created_at: Date;
    }>(sql, values);

    return result.rows.map((r) => ({
      id: r.id,
      confluenceId: r.confluence_id ?? undefined,
      type: r.improvement_type,
      model: r.model,
      status: r.status,
      createdAt: r.created_at,
    }));
  });

  // POST /api/llm/improvements/apply - apply accepted improvement to a page + sync to Confluence
  fastify.post('/llm/improvements/apply', async (request) => {
    const body = ApplyImprovementRequestSchema.parse(request.body);
    const { pageId, improvedMarkdown, version, title } = body;
    const userId = request.userId;

    // Resolve page by internal id or Confluence id. Both are numeric strings,
    // so the internal id (what the frontend's /pages/:id routes pass) wins,
    // with a Confluence-id fallback for API callers — same precedence as
    // resolvePageRef in the improve route. The digit cap keeps long Confluence
    // ids out of the int4 cast (a 10+ digit id would error, not 404).
    type PageRow = {
      id: number; version: number; title: string; space_key: string;
      source: string; confluence_id: string | null; body_html: string | null;
      created_by_user_id: string | null; visibility: string;
    };
    const PAGE_COLUMNS = `id, version, title, space_key, source, confluence_id, body_html,
              created_by_user_id, visibility`;
    let existing: { rows: PageRow[] } = { rows: [] };
    if (/^\d{1,9}$/.test(pageId)) {
      existing = await query<PageRow>(
        `SELECT ${PAGE_COLUMNS} FROM pages WHERE id = $1 AND deleted_at IS NULL`,
        [parseInt(pageId, 10)],
      );
    }
    if (existing.rows.length === 0) {
      existing = await query<PageRow>(
        `SELECT ${PAGE_COLUMNS} FROM pages WHERE confluence_id = $1 AND deleted_at IS NULL`,
        [pageId],
      );
    }
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const existingPage = existing.rows[0]!;

    // IDOR guard (#734): a standalone page is writable only by its owner
    // unless it is explicitly shared — same rule as PATCH /pages/:id.
    // Respond 404 (not 403/409) so another user's private page never leaks
    // its existence, title, or version; this must run before the version
    // check below to avoid a 404-vs-409 existence oracle. Confluence-sourced
    // pages are not gated here: that branch pushes through the caller's own
    // Confluence client, so Confluence ACLs apply.
    if (
      existingPage.source === 'standalone' &&
      existingPage.created_by_user_id !== userId &&
      existingPage.visibility !== 'shared'
    ) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const currentVersion = existingPage.version;
    const pageTitle = title ?? existingPage.title;

    if (version !== undefined && version < currentVersion) {
      throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
    }

    // #723: re-derive the same media tokens from the page's CURRENT body_html
    // (deterministic, document order) and re-inject originals verbatim so AI
    // Improve can never strip images/draw.io.
    //
    // The Improve-time token set (derived from the editor `content`) and this
    // Accept-time token set (derived from `body_html`) are decoupled, so they
    // can diverge — the LLM may also drop tokens entirely. The drop-guard below
    // is the backstop: any media original not present after restoreMedia
    // (including the worst case where restoreMedia was a complete no-op because
    // no tokens survived) is re-appended, so media is never silently lost.
    const { html: protectedCurrentHtml, media } = protectMedia(existingPage.body_html ?? '');

    // #781: derive the expected layout-token skeleton and let markdownToHtml
    // align the LLM's — possibly mangled — boundary tokens against it. When the
    // layout is unrecoverable (e.g. the model merged two cells' prose or
    // dropped every token), the apply is REJECTED with a 422 instead of
    // silently flattening the page and pushing the flattened body back to
    // Confluence.
    //
    // The source is `protectedCurrentHtml`, NOT `body_html`: whatever
    // protectMedia froze emits no boundary tokens, so a skeleton derived from
    // the raw document would expect tokens the markdown cannot carry and
    // rebuild a duplicate macro around the frozen subtree. Deterministic either
    // way — same re-derivation idea as the media tokens above — but only the
    // protected form agrees with what the model was shown. Pinned by
    // apply-improvement-media.test.ts.
    const layoutSkeleton = extractLayoutSkeleton(protectedCurrentHtml);
    let bodyHtml: string;
    try {
      bodyHtml = await markdownToHtml(improvedMarkdown, { layoutSkeleton });
    } catch (err) {
      if (err instanceof LayoutRecoveryError) {
        fastify.log.warn(
          { pageId, ...err.details },
          '#781: AI Improve output lost the page layout — apply rejected, page not modified',
        );
        throw fastify.httpErrors.unprocessableEntity(
          // #1221: no longer only columns — an expand section is now the most
          // likely way a user meets this, and an FAQ page has no columns at all.
          "The AI response lost this page's structure (columns or collapsible sections) and it could not be recovered, so the change was not applied. The page is unchanged — run AI Improve again, or edit the page manually.",
        );
      }
      throw err;
    }
    bodyHtml = restoreMedia(bodyHtml, media);
    const dropped = media.filter((m) => !bodyHtml.includes(m.html));
    if (dropped.length > 0) {
      bodyHtml += dropped.map((m) => m.html).join('\n');
      fastify.log.warn(
        { pageId, dropped: dropped.length, total: media.length },
        '#723: re-appended media dropped during AI Improve',
      );
    }
    const bodyText = htmlToText(bodyHtml);

    const cache = new RedisCache(fastify.redis);
    let newVersion: number;

    if (existingPage.source === 'standalone') {
      // --- Standalone page: update local DB only (no Confluence sync) ---
      newVersion = currentVersion + 1;
      await query(
        `UPDATE pages SET
           title = $2, body_html = $3, body_text = $4,
           version = $5, last_modified_at = NOW(), embedding_dirty = TRUE,
           embedding_status = 'not_embedded', embedded_at = NULL,
           -- Stamp local-edit markers (#305): chat write-back is a local
           -- AI edit. Previously the write was invisible to sync, which
           -- would overwrite the AI-improved content on the next pull.
           local_modified_at = NOW(), local_modified_by = $6
         WHERE id = $1`,
        [existingPage.id, pageTitle, bodyHtml, bodyText, newVersion, userId],
      );
    } else {
      // --- Confluence page: sync to Confluence ---
      if (!existingPage.confluence_id) {
        throw fastify.httpErrors.badRequest('Page is missing confluence_id');
      }
      const client = await getClientForUser(userId);
      if (!client) {
        throw fastify.httpErrors.badRequest('Confluence not configured');
      }

      const confluenceId = existingPage.confluence_id;
      const storageBody = htmlToConfluence(bodyHtml);
      const page = await client.updatePage(confluenceId, pageTitle, storageBody, currentVersion);

      const updatedBodyHtml = confluenceToHtml(
        page.body?.storage?.value ?? storageBody,
        confluenceId,
        existingPage.space_key,
      );
      const updatedBodyText = htmlToText(updatedBodyHtml);
      newVersion = page.version.number;

      await query(
        `UPDATE pages SET
           title = $2, body_storage = $3, body_html = $4, body_text = $5,
           version = $6, last_synced = NOW(), embedding_dirty = TRUE,
           embedding_status = 'not_embedded', embedded_at = NULL,
           -- Clear local-edit markers (#305): the Confluence push for
           -- the AI-improved content has succeeded, so the local state
           -- is now in sync with the remote.
           local_modified_at = NULL, local_modified_by = NULL
         WHERE id = $1`,
        [existingPage.id, pageTitle, page.body?.storage?.value ?? storageBody, updatedBodyHtml, updatedBodyText, newVersion],
      );
    }

    // Mark the most recent improvement record for this page as applied
    await query(
      `UPDATE llm_improvements SET status = 'applied'
       WHERE id = (
         SELECT li.id FROM llm_improvements li
         WHERE li.user_id = $1 AND li.page_id = $2 AND li.status IN ('streaming', 'completed')
         ORDER BY li.created_at DESC LIMIT 1
       )`,
      [userId, existingPage.id],
    );

    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(existingPage.id), { title: pageTitle, source: 'ai_improvement' }, request);

    return { id: existingPage.id, title: pageTitle, version: newVersion };
  });
}
