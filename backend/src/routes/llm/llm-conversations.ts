import type { PoolClient } from 'pg';
import { FastifyInstance } from 'fastify';
import { getPool, query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import {
  ApplyImprovementRequestSchema,
  ConversationIdParamSchema,
  ConversationListQuerySchema,
  type ConversationDetail,
  type ConversationSummary,
  type StoredChatMessage,
  type TitleSource,
  UpdateConversationSchema,
} from '@compendiq/contracts';
import {
  admitLegacyCodeMetadata,
  assertCodeMacroStorage,
  assertLocalCodeMacroProjections,
  convertImproveOutput,
  htmlToConfluence,
  htmlToText,
  ImproveCodePlacementError,
  IMPROVE_CODE_NONCE_PATTERN,
  ImproveSuggestionUnboundError,
  IMPROVE_CODE_META_PROTOCOL,
  ImproveReplayBudgetError,
  ImproveReplayError,
  ImproveSuggestionFormatError,
  LayoutRecoveryError,
  type ConvertedImproveOutput,
  type ImproveSuggestionProvenance,
} from '../../core/services/content-converter.js';
import {
  assertCarrierRecoveryEligible,
  carrierKindsStorageMayCarry,
  isStaleCarrierReservation,
  legacyCodeApplicationHolds,
  lockstepStoredBody,
  logStoredCarriers,
  reconcileStoredCarriers,
  withinCarrierBound,
  type CarrierRow,
  type StoredCarrierResult,
} from '../../core/services/confluence-carrier-recovery.js';
import { ConfluenceStorageRefusedError } from '../../core/services/confluence-storage-reader.js';
import { isConfluenceEnabled } from '../../core/services/confluence-integration.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { type ConfluenceClient } from '../../domains/confluence/services/confluence-client.js';
import {
  CONFLUENCE_DISABLED_MESSAGE,
  pageWriteStaysLocal,
} from '../../domains/confluence/services/standalone-mode.js';
import {
  describeConfluencePagePut,
  publishConfluencePagePut,
  registerConfluencePagePutIntentReconcilers,
} from '../../domains/confluence/services/page-put-intent-reconciler.js';
import {
  confirmPagePublication,
  pagePublicationReceipt,
} from '../../domains/confluence/services/ordinary-page-write-reconciler.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import {
  getUserAccessibleSpaces,
  getUserAccessibleSpacesMemoized,
  userCanAccessPage,
  userCanEditPage,
} from '../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';
import { invalidateCollabDocAfterBodyWrite, rejectIfLiveCollabRoom } from '../../core/services/collab-guard.js';
import {
  assertNoPendingSyncConflict,
  cancelPageWriteIntentBeforeEffect,
  completePageWriteIntent,
  getPageWriterRuntimeId,
  lockPageLifecycle,
  lockPageWriterRuntime,
  PageWriteError,
  reservePageWriteIntentInTransaction,
  runPageWriteIntentEffect,
  withPageWriteTransaction,
  type PageWriteIntent,
} from '../../core/services/page-write-admission.js';
import { selectReplayableHistory } from '../../domains/llm/services/history-budget.js';
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
type ConversationListRow = ConversationRow & {
  /** PostgreSQL's full six-digit fractional precision, kept out of JavaScript Date. */
  cursor_updated_at: string;
};

/**
 * The summary columns every conversation route returns. `title` is COALESCEd
 * on read (a whitespace-only first question yields '' — the DB column stays
 * nullable so the migration cannot fail on a legacy row); the page join is
 * `deleted_at IS NULL` because pages are SOFT deleted and the FK's SET NULL
 * only fires on a hard delete. page_ref was authorised at write time
 * (llm-ask.ts), but the chip is re-authorised on every read through
 * `visiblePagesPredicate`: a page the caller can no longer read (a
 * restriction added after the ask, a revoked ACE or space role) answers
 * `pageId`/`pageTitle` null, the same as a trashed page. The row itself stays.
 */
const SUMMARY_COLUMNS = `c.id, COALESCE(NULLIF(trim(c.title), ''), 'Untitled conversation') AS title,
       c.title_source, c.model, p.id AS page_ref, p.title AS page_title, c.created_at, c.updated_at`;
/** FROM clause for the list and GET :id routes; binds accessible spaces and the caller. */
function summaryFrom(spacesParamIdx: number, userParamIdx: number): string {
  return `FROM llm_conversations c
    LEFT JOIN pages p ON p.id = c.page_ref AND p.deleted_at IS NULL
      AND ${visiblePagesPredicate(spacesParamIdx, userParamIdx, 'p')}`;
}

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

// Keyset cursor: the exact PostgreSQL (updated_at, id) of the last row served.
// Keep updated_at as a six-digit UTC string: node-postgres converts TIMESTAMPTZ
// to Date and silently truncates its microseconds. Keyset comparison must use
// the same precision as the ordering key or rows inside that millisecond vanish.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/;

function isCursorTimestamp(value: string): boolean {
  const match = CURSOR_TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const millisecondIso = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
  const parsed = new Date(millisecondIso);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === millisecondIso;
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt, id])).toString('base64url');
}

function decodeCursor(raw: string | undefined): { updatedAt: string; id: string } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) && parsed.length === 2
      && typeof parsed[0] === 'string' && isCursorTimestamp(parsed[0])
      && typeof parsed[1] === 'string' && UUID_RE.test(parsed[1])
    ) {
      return { updatedAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
}

/**
 * Read-time source annotation (#1361): mark a KB source `unavailable` when its
 * page is trashed or no longer readable by the caller under the non-RAG list
 * predicate (`visiblePagesPredicate`, which also applies page restrictions;
 * retrieval itself stays space-level). External/web
 * sources carry no pageId and are never annotated. Nothing is written back.
 */
async function annotateUnavailableSources(messages: StoredChatMessage[], userId: string): Promise<StoredChatMessage[]> {
  const ids = new Set<number>();
  for (const m of messages) for (const s of m.sources ?? []) if (typeof s.pageId === 'number' && s.pageId > 0) ids.add(s.pageId);
  if (ids.size === 0) return messages;
  const spaces = await getUserAccessibleSpacesMemoized(userId);
  const visible = await query<{ id: number }>(
    `SELECT cp.id FROM pages cp
      WHERE cp.id = ANY($3::int[]) AND ${visiblePagesPredicate(1, 2)} AND cp.deleted_at IS NULL`,
    [spaces, userId, [...ids]],
  );
  const ok = new Set(visible.rows.map((r) => r.id));
  return messages.map((m) => (
    m.sources
      ? { ...m, sources: m.sources.map((s) => (typeof s.pageId === 'number' && s.pageId > 0 && !ok.has(s.pageId) ? { ...s, unavailable: true as const } : s)) }
      : m
  ));
}

export async function llmConversationRoutes(fastify: FastifyInstance) {
  registerConfluencePagePutIntentReconcilers();
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
    const result = await query<ConversationListRow>(
      `SELECT ${SUMMARY_COLUMNS},
              to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
       ${summaryFrom(5, 1)}
       WHERE c.user_id = $1
         AND ($2::timestamptz IS NULL OR (c.updated_at, c.id) < ($2::timestamptz, $3::uuid))
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $4`,
      [
        request.userId,
        after?.updatedAt ?? null,
        after?.id ?? null,
        limit + 1,
        await getUserAccessibleSpacesMemoized(request.userId),
      ],
    );
    const page = result.rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = result.rows.length > limit && last ? encodeCursor(last.cursor_updated_at, last.id) : null;
    return { items: page.map(toSummary), nextCursor };
  });

  // GET /api/llm/conversations/:id — full detail for reopening (#1361)
  fastify.get('/llm/conversations/:id', async (request) => {
    const { id } = ConversationIdParamSchema.parse(request.params);
    const result = await query<ConversationRow & { messages: StoredChatMessage[] }>(
      `SELECT ${SUMMARY_COLUMNS}, c.messages
       ${summaryFrom(3, 2)}
       WHERE c.id = $1 AND c.user_id = $2`,
      [id, request.userId, await getUserAccessibleSpacesMemoized(request.userId)],
    );
    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Conversation not found');
    }
    const row = result.rows[0]!;
    const messages = await annotateUnavailableSources(row.messages, request.userId);
    return {
      ...toSummary(row),
      messages,
      // The reopen-time half of decision 10: the same walk the ask route runs,
      // so a long conversation says so the moment it opens.
      historyTruncated: selectReplayableHistory(row.messages).truncated,
    } satisfies ConversationDetail;
  });

  // PATCH /api/llm/conversations/:id — rename (#1361). Sets title_source =
  // 'user', which the auto-title never overwrites. Deliberately does
  // NOT bump updated_at: that would re-bucket the row into "Today".
  fastify.patch('/llm/conversations/:id', async (request) => {
    const { id } = ConversationIdParamSchema.parse(request.params);
    const { title } = UpdateConversationSchema.parse(request.body);
    const result = await query<ConversationRow>(
      `UPDATE llm_conversations c
          SET title = $3, title_source = 'user'
        WHERE c.id = $1 AND c.user_id = $2
        RETURNING c.id, c.title, c.title_source, c.model,
                  (SELECT p.id FROM pages p
                    WHERE p.id = c.page_ref AND p.deleted_at IS NULL
                      AND ${visiblePagesPredicate(4, 2, 'p')}) AS page_ref,
                  (SELECT p.title FROM pages p
                    WHERE p.id = c.page_ref AND p.deleted_at IS NULL
                      AND ${visiblePagesPredicate(4, 2, 'p')}) AS page_title,
                  c.created_at, c.updated_at`,
      [id, request.userId, title, await getUserAccessibleSpacesMemoized(request.userId)],
    );
    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Conversation not found');
    }
    return toSummary(result.rows[0]!);
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

    // The rows are the caller's own and all stay listed; the page link is
    // re-authorised on read, so a page they can no longer read (restricted,
    // revoked, trashed) answers no confluenceId and never matches the filter.
    let sql = `SELECT li.id, p.confluence_id, li.improvement_type, li.model, li.status, li.created_at
       FROM llm_improvements li
       LEFT JOIN pages p ON p.id = li.page_id AND p.deleted_at IS NULL
         AND ${visiblePagesPredicate(2, 1, 'p')}
      WHERE li.user_id = $1`;
    const values: unknown[] = [userId, await getUserAccessibleSpacesMemoized(userId)];

    if (pageId) {
      sql += ' AND p.confluence_id = $3';
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
    const { pageId, improvedMarkdown, version, title, improvementId: selectedImprovementId } = body;
    const userId = request.userId;

    // Resolve page by internal id or Confluence id. Both are numeric strings,
    // so the internal id (what the frontend's /pages/:id routes pass) wins,
    // with a Confluence-id fallback for API callers — same precedence as
    // resolvePageRef in the improve route. The digit cap keeps long Confluence
    // ids out of the int4 cast (a 10+ digit id would error, not 404).
    type PageRow = {
      id: number; version: number; remote_version: number | null; title: string; space_key: string | null;
      source: string; confluence_id: string | null; body_html: string | null;
      created_by_user_id: string | null; visibility: string;
      contentRevision: string; lifecycleRevision: string; bodyStorage: string | null;
      /** #1953: the evidence of a lockstep row. */
      localModifiedAt: Date | null; hasCollabDoc: boolean;
    };
    const PAGE_COLUMNS = `id, version, remote_version, title, space_key, source, confluence_id, body_html,
              created_by_user_id, visibility, content_revision::text AS "contentRevision",
              lifecycle_revision::text AS "lifecycleRevision", body_storage AS "bodyStorage",
              local_modified_at AS "localModifiedAt",
              EXISTS (SELECT 1 FROM page_collaborative_docs d WHERE d.page_id = pages.id) AS "hasCollabDoc"`;
    const currentConfluenceClient = async (
      client: PoolClient,
      intent: PageWriteIntent,
      expected: PageRow,
    ): Promise<ConfluenceClient> => {
      const actor = await client.query(
        'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
        [userId],
      );
      if (actor.rowCount !== 1) {
        throw new PageWriteError(403, 'not_authorized', 'Not authorized to edit this page');
      }
      const result = await client.query<PageRow>(
        `SELECT ${PAGE_COLUMNS} FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [expected.id],
      );
      const current = result.rows[0];
      if (!current) throw new PageWriteError(404, 'page_not_found', 'Page not found');
      const admittedRevision = intent.revisions[expected.id];
      if (
        !admittedRevision ||
        current.contentRevision !== admittedRevision.contentRevision ||
        current.lifecycleRevision !== admittedRevision.lifecycleRevision ||
        current.version !== expected.version ||
        (current.remote_version ?? current.version) !== (expected.remote_version ?? expected.version) ||
        current.body_html !== expected.body_html ||
        current.source !== 'confluence' ||
        current.confluence_id !== expected.confluence_id
      ) {
        throw new PageWriteError(
          409,
          'stale_content_revision',
          'Page has been modified since you loaded it. Please refresh and try again.',
        );
      }
      const accessibleSpaces = await getUserAccessibleSpaces(userId, client);
      if (
        !current.space_key ||
        !accessibleSpaces.includes(current.space_key) ||
        !(await userCanAccessPage(userId, current.id, client))
      ) {
        throw new PageWriteError(403, 'not_authorized', 'Access denied to this space');
      }
      if (!(await isConfluenceEnabled(userId, client))) {
        throw new PageWriteError(
          409,
          'confluence_integration_disabled',
          CONFLUENCE_DISABLED_MESSAGE,
        );
      }
      const confluence = await getClientForUser(userId, client);
      if (!confluence) {
        throw new PageWriteError(
          409,
          'confluence_connection_changed',
          'Confluence credentials changed before the remote write',
        );
      }
      return confluence;
    };
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

    // Page authority for a local write: the PUT /pages/:id rule — page access
    // AND edit rights. A synced page needs a role on its space (plus an ACE
    // when the page is restricted); a standalone article needs its owner or
    // shared visibility. With `client` it reads inside the write transaction
    // and bypasses the RBAC caches.
    const canWritePageLocally = async (pageId: number, client?: PoolClient): Promise<boolean> =>
      (await userCanAccessPage(userId, pageId, client))
      && (await userCanEditPage(userId, pageId, client));

    // #1623: a standalone article, and a synced one while the CALLER's
    // integration is off, take the local write below. That branch has no
    // Confluence-side authority, so it is authorized here — before the
    // version check, the collab-room 409 and the layout 422 — and answers
    // 404 exactly like a missing page, so a page the caller may not edit
    // leaks neither its existence nor its version (#734). The Confluence
    // branch re-resolves active identity, local page/space authority, mode,
    // and credentials under admission immediately before provider dispatch.
    const writeStaysLocal = await pageWriteStaysLocal(userId, existingPage.source);
    if (writeStaysLocal && !(await canWritePageLocally(existingPage.id))) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    // #1958 (review r1 CM-2, r2 CM2-3; the #1955 R4/W3 rule): before the
    // stored body supplies any evidence (media, skeleton, code metadata; from
    // #1953-2 on, recovery evidence and witnesses), the remote exit runs the
    // write-state authorization the page writers use (pages-crud.ts
    // `loadAuthorizedContentWriteState`): one transaction client, the page row
    // locked and reloaded, the active actor, the current space and page
    // authority read without the RBAC caches, and the content and lifecycle
    // revisions of the row this request read. The admitted transaction's
    // final fence before dispatch stays.
    if (!writeStaysLocal) {
      await withPageWriteTransaction([], async (client) => {
        const actor = await client.query('SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL', [userId]);
        if (actor.rowCount !== 1) {
          throw new PageWriteError(403, 'not_authorized', 'Not authorized to edit this page');
        }
        const locked = await client.query<{ spaceKey: string | null; contentRevision: string; lifecycleRevision: string }>(
          `SELECT space_key AS "spaceKey", content_revision::text AS "contentRevision",
                  lifecycle_revision::text AS "lifecycleRevision"
             FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [existingPage.id],
        );
        const current = locked.rows[0];
        if (!current) throw new PageWriteError(404, 'page_not_found', 'Page not found');
        const accessibleSpaces = await getUserAccessibleSpaces(userId, client);
        if (!current.spaceKey || !accessibleSpaces.includes(current.spaceKey)) {
          throw new PageWriteError(403, 'not_authorized', 'Access denied to this space');
        }
        if (!(await userCanAccessPage(userId, existingPage.id, client))) {
          throw new PageWriteError(403, 'not_authorized', 'Not authorized to edit this page');
        }
        if (current.lifecycleRevision !== existingPage.lifecycleRevision) {
          throw new PageWriteError(409, 'stale_lifecycle', 'The page lifecycle changed after the content was read');
        }
        if (current.contentRevision !== existingPage.contentRevision) {
          throw new PageWriteError(409, 'stale_content_revision', 'The page content changed after the content was read');
        }
      });
    }

    await rejectIfLiveCollabRoom(
      existingPage.id,
      (m) => fastify.httpErrors.conflict(m),
      'Collaborative editing session is active. Use in-editor Improve instead of Apply.',
    );

    const currentVersion = existingPage.version;
    const pageTitle = title ?? existingPage.title;
    // #1958 (coordinator decision D27): the request names the improvement the
    // user selected. Its provenance and its `applied` status are bound to that
    // row only, once it is the caller's, for this page and completed; the text
    // is never matched against stored rows. No id, or a row that fails these
    // checks (a manual Apply, an older client), is new input: the #1958 path
    // with exact-grammar carriers only, refused when the page has protected
    // code blocks (no nonce can place them, D28), and no row changes status.
    // Bound now, before conversion or remote latency.
    const linkedRow = selectedImprovementId === undefined ? undefined : (await query<{
      id: string; improveProtocol: number | null; codeNonce: string | null;
    }>(
      `SELECT id, improve_protocol AS "improveProtocol", improve_code_nonce AS "codeNonce"
         FROM llm_improvements
        WHERE id = $1
          AND user_id = $2
          AND page_id = $3
          AND status = 'completed'`,
      [selectedImprovementId, userId, existingPage.id],
    )).rows[0];
    const improvementId = linkedRow?.id ?? null;
    const provenance: ImproveSuggestionProvenance = !linkedRow ? 'unmatched'
      : linkedRow.improveProtocol === IMPROVE_CODE_META_PROTOCOL ? 'code-meta' : 'legacy';
    // D28: only a #1958 row's own nonce places a protected code block; every other spelling is text.
    const codeNonce = provenance === 'code-meta' && linkedRow?.codeNonce && IMPROVE_CODE_NONCE_PATTERN.test(linkedRow.codeNonce)
      ? linkedRow.codeNonce : undefined;

    if (version !== undefined && version < currentVersion) {
      throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
    }

    // A #1958 refusal: nothing is reserved, dispatched or stored. Remote
    // authority was established before any evidence was read (above).
    const refuseImproveResult = (error: unknown): never => {
      const reason = error instanceof ConfluenceStorageRefusedError ? error.reason
        : error instanceof ImproveReplayBudgetError ? 'replay-budget'
          : error instanceof ImproveReplayError ? 'replay-integrity'
            : error instanceof ImproveSuggestionFormatError ? 'suggestion-format'
              : error instanceof ImproveSuggestionUnboundError ? 'suggestion-unbound'
                : error instanceof ImproveCodePlacementError ? 'code-placement' : null;
      if (reason === null) throw error;
      fastify.log.warn(
        { pageId: existingPage.id, reason, provenance, exit: writeStaysLocal ? 'local' : 'remote' },
        '#1958: AI Improve result refused before write',
      );
      if (error instanceof ConfluenceStorageRefusedError) throw error;
      throw fastify.httpErrors.unprocessableEntity((error as Error).message);
    };

    // The conversion half of the Accept (#1958 `convertImproveOutput`; the
    // Improve generator caches only output it accepts):
    // - #723: the media tokens are re-derived from the page's CURRENT
    //   body_html (deterministic, document order) and the originals re-injected
    //   verbatim, so AI Improve can never strip images/draw.io. The Improve-time
    //   token set (from the editor `content`) and this one can diverge, and the
    //   LLM may drop tokens: a medium with no placement it can take is appended
    //   once; a code-carrying original without exactly one is refused (422),
    //   never duplicated.
    // - #781: the layout skeleton is derived from the PROTECTED body (whatever
    //   protectMedia froze emits no boundary tokens) and markdownToHtml aligns
    //   the LLM's boundary tokens against it; an unrecoverable layout is
    //   rejected with 422 instead of flattening the page.
    // - #1752: `protectedMedia` names the tokens the replay turns back into
    //   block HTML, so a task item holding one stays a plain item.
    // - #1958: code-block title and options travel as CODE-META echo tokens
    //   and are re-attached from this stored body only on exact identity; a
    //   pre-#1958 suggestion for a page with annotated code is refused first.
    // #1953-2 (§3.7 step 1): witnesses are asked for only on the remote Accept that may recover a legacy code
    // block: a lockstep row within the length bound whose storage may carry a code macro and whose stored body is
    // not carried (#1958's whole-body flag, read from the conversion's own protectMedia: `'uncarried'`). Every
    // other Accept keeps #1958's route.
    const carrierRow: CarrierRow = {
      source: existingPage.source,
      body_html: existingPage.body_html,
      body_storage: existingPage.bodyStorage,
      local_modified_at: existingPage.localModifiedAt,
      confluence_id: existingPage.confluence_id,
      space_key: existingPage.space_key,
      has_collab_doc: existingPage.hasCollabDoc,
    };
    // §3.6 stage 0: L and S are checked before the gate parses L (lockstepStoredBody does it first itself).
    const carrierGate = writeStaysLocal ? null : lockstepStoredBody(carrierRow);
    const storedWithinBound = withinCarrierBound(existingPage.body_html, existingPage.bodyStorage);
    const recoverable = carrierGate !== null && carrierGate.applicable && carrierGate.excluded === null && storedWithinBound;
    const wantWitnesses = recoverable
      && carrierKindsStorageMayCarry(existingPage.bodyStorage).includes('macro.code');
    let finalized: ConvertedImproveOutput;
    try {
      finalized = await convertImproveOutput(existingPage.body_html ?? '', improvedMarkdown, {
        provenance, codeNonce, witnesses: wantWitnesses ? 'uncarried' : false,
      });
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
      return refuseImproveResult(err);
    }
    if (finalized.dropped > 0) {
      fastify.log.warn(
        { pageId, dropped: finalized.dropped, total: finalized.entries },
        '#723: re-appended media dropped during AI Improve',
      );
    }
    // #1953-2 (§3.7 steps 2–5): on the remote exit of a lockstep row, the carriers of a page synced before
    // v0.10.0 are recovered into the finalized HTML, code only through #1958's witnesses (always passed, possibly
    // empty), checked against the operations it reports and admitted by #1958 before anything is derived from it.
    // The length of the string finalizeCodeMetadata returned is checked first (Z6, r2 CW-6): past the bound
    // nothing of #1953 runs, an exclusion included. An excluded row then only discloses its reason, from the gate
    // computed above (never a second parse).
    let carriers: StoredCarrierResult | null = null;
    const finalizedWithinBound = storedWithinBound && withinCarrierBound(finalized.html);
    if (finalizedWithinBound && carrierGate?.applicable && carrierGate.excluded !== null) {
      carriers = reconcileStoredCarriers({ row: carrierRow, targetHtml: finalized.html, gate: carrierGate });
    } else if (finalizedWithinBound && recoverable) {
      carriers = reconcileStoredCarriers({
        row: carrierRow,
        targetHtml: finalized.html,
        codeWitnesses: finalized.witnesses,
        gate: carrierGate,
      });
      const ops = carriers.report.codeOps;
      let admitted = true;
      try {
        admitted = legacyCodeApplicationHolds(finalized.html, carriers.html, ops)
          && (ops.length === 0 || admitLegacyCodeMetadata(finalized.allowance, ops) === ops.length);
      } catch {
        admitted = false;
      }
      if (!admitted) {
        logStoredCarriers({ pageId: existingPage.id, writer: 'ai_apply', result: carriers, final: 'refused' });
        return refuseImproveResult(new ConfluenceStorageRefusedError('unapproved-code-macro'));
      }
    }
    const bodyHtml = carriers?.html ?? finalized.html;
    const { report } = finalized;
    if (Object.values(report).some((count) => count > 0)) {
      const lossy = report.screened + report.stripped + report.forged + report.twins + report.appended > 0;
      fastify.log[lossy ? 'warn' : 'info'](
        { pageId: existingPage.id, codeMeta: report },
        '#1958: AI Improve code-block metadata',
      );
    }
    // Review r9 CM9-2: the bound-nonce check already projected this exact HTML. A body the recovery changed is
    // projected anew, and #1958's bound-nonce refusal runs again on that final HTML and that text (#1953-2 r1
    // CW-2): a recovered value may spell the nonce. Before any storage derivation, reservation or effect.
    let bodyText: string;
    if (bodyHtml === finalized.html && finalized.text !== undefined) {
      bodyText = finalized.text;
    } else {
      bodyText = htmlToText(bodyHtml);
      if (codeNonce !== undefined && bodyHtml !== finalized.html
        && (bodyHtml.includes(codeNonce) || bodyText.includes(codeNonce))) {
        logStoredCarriers({ pageId: existingPage.id, writer: 'ai_apply', result: carriers!, final: 'refused' });
        return refuseImproveResult(new ImproveCodePlacementError());
      }
    }

    const cache = new RedisCache(fastify.redis);
    let newVersion: number;

    // #1623 — a standalone page and a synced page while Confluence is off use
    // the same local-only fenced transaction. No upstream call is made.
    if (writeStaysLocal) {
      // #1958 (X2, Q8 as ruled): the stored HTML's publication projections
      // are read and judged before the write, whatever they spell.
      try {
        assertLocalCodeMacroProjections(bodyHtml, finalized.allowance, { body_storage: existingPage.bodyStorage });
      } catch (error) {
        return refuseImproveResult(error);
      }
      newVersion = await withPageWriteTransaction([existingPage.id], async (client) => {
        const fresh = await client.query<PageRow>(
          `SELECT ${PAGE_COLUMNS} FROM pages WHERE id = $1 AND deleted_at IS NULL`,
          [existingPage.id],
        );
        const page = fresh.rows[0];
        if (!page) throw fastify.httpErrors.notFound('Page not found');
        // Authority can change while the write waits for the page fence.
        const actor = await client.query(
          'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
          [userId],
        );
        if (actor.rowCount !== 1 || !(await canWritePageLocally(existingPage.id, client))) {
          throw fastify.httpErrors.notFound('Page not found');
        }
        // #1958: the stored storage the projections were judged with is evidence too.
        if (
          page.version !== currentVersion ||
          page.body_html !== existingPage.body_html ||
          page.bodyStorage !== existingPage.bodyStorage
        ) {
          throw fastify.httpErrors.conflict(
            'Page has been modified since you loaded it. Please refresh and try again.',
          );
        }
        const nextVersion = page.version + 1;
        await client.query(
          `UPDATE pages SET
             title = $2, body_html = $3, body_text = $4,
             version = $5, last_modified_at = NOW(), embedding_dirty = TRUE,
             image_analysis_dirty = CASE
               WHEN body_html IS DISTINCT FROM $3 THEN TRUE
               ELSE image_analysis_dirty
             END,
             embedding_status = 'not_embedded', embedded_at = NULL,
             local_modified_at = NOW(), local_modified_by = $6
           WHERE id = $1`,
          [existingPage.id, pageTitle, bodyHtml, bodyText, nextVersion, userId],
        );
        if (improvementId !== null) {
          const marked = await client.query(
            `UPDATE llm_improvements
                SET status = 'applied'
              WHERE id = $1
                AND user_id = $2
                AND page_id = $3
                AND status IN ('streaming', 'completed')`,
            [improvementId, userId, existingPage.id],
          );
          if (marked.rowCount !== 1) {
            throw fastify.httpErrors.conflict(
              'The AI improvement changed before it could be marked applied.',
            );
          }
        }
        return nextVersion;
      });
      await invalidateCollabDocAfterBodyWrite(existingPage.id);
      await cache.invalidate(userId, 'pages');
    } else {
      if (!existingPage.confluence_id) {
        throw fastify.httpErrors.badRequest('Page is missing confluence_id');
      }
      await assertNoPendingSyncConflict([existingPage.id]);
      // Preserve the existing early configuration error. The post-admission
      // resolver below is authoritative for dispatch.
      if (!await getClientForUser(userId)) {
        throw fastify.httpErrors.badRequest('Confluence not configured');
      }

      const confluenceId = existingPage.confluence_id;
      const storageBody = htmlToConfluence(bodyHtml, { previousStorage: existingPage.bodyStorage });
      // #1958: the exact string updatePage receives, after #1955's link stage.
      try {
        assertCodeMacroStorage(storageBody, finalized.allowance, { previousStorage: existingPage.bodyStorage });
      } catch (error) {
        return refuseImproveResult(error);
      }
      const remoteVersion = existingPage.remote_version ?? currentVersion;
      const publication = describeConfluencePagePut({
        kind: 'page.ai_apply',
        actorId: userId,
        pageId: existingPage.id,
        confluenceId,
        title: pageTitle,
        bodyStorage: storageBody,
        expectedRemoteVersion: remoteVersion,
        expectedLocalVersion: currentVersion,
        improvementId,
      });
      // #1953-2 (Y7): the PUT route's reservation pattern, so a recovered Accept re-establishes its lockstep
      // evidence under the lifecycle lock in the transaction that reserves the write. Either 409 rolls back all.
      const runtimeId = await getPageWriterRuntimeId();
      const reservationClient = await getPool().connect();
      let intent: PageWriteIntent;
      try {
        await reservationClient.query('BEGIN');
        await lockPageWriterRuntime(reservationClient, runtimeId);
        await lockPageLifecycle(reservationClient, [existingPage.id]);
        if (carriers?.changed) await assertCarrierRecoveryEligible(reservationClient, existingPage.id);
        intent = await reservePageWriteIntentInTransaction(reservationClient, {
          pageIds: [existingPage.id],
          kind: publication.kind,
          actorId: userId,
          expectedRevisions: {
            [existingPage.id]: {
              contentRevision: existingPage.contentRevision,
              lifecycleRevision: existingPage.lifecycleRevision,
            },
          },
          effect: publication.effect,
        });
        await reservationClient.query('COMMIT');
      } catch (error) {
        await reservationClient.query('ROLLBACK');
        if (carriers && isStaleCarrierReservation(error)) {
          logStoredCarriers({ pageId: existingPage.id, writer: 'ai_apply', result: carriers, final: 'stale' });
        }
        throw error;
      } finally {
        reservationClient.release();
      }
      if (carriers) logStoredCarriers({ pageId: existingPage.id, writer: 'ai_apply', result: carriers, final: 'reserved' });

      let admittedClient: ConfluenceClient;
      try {
        admittedClient = await withPageWriteTransaction(
          [existingPage.id],
          (lockedClient) => currentConfluenceClient(lockedClient, intent, existingPage),
          { intent },
        );
      } catch (error) {
        await cancelPageWriteIntentBeforeEffect(intent);
        throw error;
      }

      // Persist only bounded identity/digests after provider success. A compact
      // acknowledgment is durable before its confirming read, so a failed
      // readback remains recoverable without replaying this PUT.
      const publicationResult = await runPageWriteIntentEffect(
        intent,
        {
          kind: 'remote',
          completesRemoteWork: true,
          terminalResult: (result) => result.receipt,
        },
        async () => {
          const page = await admittedClient.updatePage(
            confluenceId,
            pageTitle,
            storageBody,
            remoteVersion,
          );
          return {
            page,
            receipt: pagePublicationReceipt(confluenceId, remoteVersion + 1, page),
          };
        },
      );
      const confirmed = await withPageWriteTransaction([existingPage.id], async (lockedClient) => {
        const currentClient = await currentConfluenceClient(lockedClient, intent, existingPage);
        return confirmPagePublication(
          currentClient,
          publicationResult.receipt,
          publicationResult.page,
        );
      }, { intent });
      const published = await completePageWriteIntent(intent, (lockedClient) =>
        publishConfluencePagePut(lockedClient, publication, {
          confluenceId: confirmed.id,
          title: confirmed.title,
          bodyStorage: confirmed.body.storage.value,
          remoteVersion: confirmed.version.number,
        }, intent.id),
      );
      newVersion = published.newVersion;
    }

    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(existingPage.id), { title: pageTitle, source: 'ai_improvement' }, request);

    return { id: existingPage.id, title: pageTitle, version: newVersion };
  });
}
