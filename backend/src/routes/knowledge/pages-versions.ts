import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import {
  getVersionHistory,
  getVersion,
  getSemanticDiff,
  saveVersionSnapshotByPageId,
  restoreVersion,
  type RestoreResult,
} from '../../domains/knowledge/services/version-tracker.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { getClientForUser, isConfluenceEnabled } from '../../domains/confluence/services/sync-service.js';
import { htmlToConfluence } from '../../core/services/content-converter.js';
import {
  describeConfluencePagePut,
  publishConfluencePagePut,
  registerConfluencePagePutIntentReconcilers,
} from '../../domains/confluence/services/page-put-intent-reconciler.js';
import {
  backfillVersionHistory,
  getHistoricalBody,
} from '../../domains/confluence/services/version-backfill.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { emitWebhookEvent } from '../../core/services/webhook-emit-hook.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { invalidateCollabDocAfterBodyWrite, rejectIfLiveCollabRoom } from '../../core/services/collab-guard.js';
import {
  cancelPageWriteIntentBeforeEffect,
  completePageWriteIntent,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
  withPageWriteTransaction,
} from '../../core/services/page-write-admission.js';
import {
  RestoreVersionSchema,
  PageVersionsResponseSchema,
  PageVersionDetailSchema,
  type VersionBackfillStatus,
} from '@compendiq/contracts';
import { z } from 'zod';

const IdParamSchema = z.object({ id: z.string().min(1) });
const VersionParamSchema = z.object({ id: z.string().min(1), version: z.coerce.number().int().positive() });
const SemanticDiffSchema = z.object({
  v1: z.number().int().positive(),
  v2: z.number().int().positive(),
  model: z.string().optional(),
});

/**
 * #780: the underlying backfill error is rendered inside the Version History
 * dialog, so make it dialog-safe before embedding: collapse all whitespace
 * runs (incl. newlines) to single spaces, trim, and cap the length with an
 * ellipsis. Returns '' (no parenthesised suffix) when there is nothing usable.
 */
const BACKFILL_REASON_MAX_CHARS = 200;
function formatBackfillFailureReason(err: unknown): string {
  if (!(err instanceof Error) || !err.message) return '';
  const collapsed = err.message.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const capped =
    collapsed.length > BACKFILL_REASON_MAX_CHARS
      ? `${collapsed.slice(0, BACKFILL_REASON_MAX_CHARS).trimEnd()}…`
      : collapsed;
  return ` (${capped})`;
}

/** Resolved page identity + the fields needed for RBAC and Confluence push. */
interface PageContext {
  id: number;
  confluenceId: string | null;
  source: string;
  spaceKey: string | null;
  visibility: string;
  createdByUserId: string | null;
  version: number;
}

export async function pagesVersionRoutes(fastify: FastifyInstance) {
  registerConfluencePagePutIntentReconcilers();
  fastify.addHook('onRequest', fastify.authenticate);

  const cache = new RedisCache(fastify.redis);

  /**
   * Resolve the `:id` route param (numeric PK or legacy confluence_id) to the
   * internal page row, then enforce RBAC — Confluence pages require space
   * access, standalone pages require ownership or shared visibility.
   *
   * Returns `null` when the page doesn't exist (callers decide 404 vs.
   * pass-through). Throws 403 when the user lacks access.
   */
  async function resolveAndAuthorize(userId: string, id: string): Promise<PageContext | null> {
    const isNumericId = /^\d+$/.test(id);
    const result = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string | null;
      source: string;
      visibility: string;
      created_by_user_id: string | null;
      version: number;
    }>(
      `SELECT id, confluence_id, space_key, source, visibility, created_by_user_id, version
       FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'} AND deleted_at IS NULL`,
      [isNumericId ? parseInt(id, 10) : id],
    );
    if (result.rows.length === 0) return null;
    const page = result.rows[0]!;

    if (page.source === 'standalone') {
      if (page.visibility === 'private' && page.created_by_user_id !== userId) {
        throw fastify.httpErrors.forbidden('Access denied');
      }
    } else if (page.space_key) {
      const accessibleSpaces = await getUserAccessibleSpaces(userId);
      if (!accessibleSpaces.includes(page.space_key)) {
        throw fastify.httpErrors.forbidden('Access denied to this space');
      }
    }

    return {
      id: page.id,
      confluenceId: page.confluence_id,
      source: page.source,
      spaceKey: page.space_key,
      visibility: page.visibility,
      createdByUserId: page.created_by_user_id,
      version: page.version,
    };
  }

  // GET /api/pages/:id/versions - list version history
  fastify.get('/pages/:id/versions', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const ctx = await resolveAndAuthorize(userId, id);
    if (!ctx) return PageVersionsResponseSchema.parse({ versions: [], pageId: id });

    // #722: Best-effort backfill of Confluence version list on dialog open.
    // #763: the outcome is surfaced as `backfillStatus` so the UI can tell
    // "history is complete" from "historical import never ran / failed"
    // instead of silently rendering an incomplete list. Stays undefined for
    // standalone pages, where no Confluence backfill applies.
    let backfillStatus: VersionBackfillStatus | undefined;
    let backfillDetail: string | undefined;
    if (ctx.confluenceId && !(await isConfluenceEnabled(userId))) {
      // #1623: Confluence off = standalone mode. The import is not supposed to
      // run, so it is answered BEFORE `getClientForUser` — no credential
      // lookup, no PAT decryption, nothing contacted. This is a deliberate
      // choice rather than a configuration gap, which is why it is its own
      // status and why the detail never asks for a URL or a PAT: the page
      // keeps its local history and stays fully usable.
      backfillStatus = 'skipped_confluence_off';
      backfillDetail =
        'The Confluence integration is off, so historical versions were not imported — the history below is this page’s local history.';
    } else if (ctx.confluenceId) {
      // Two distinct failure paths: constructing the client (stored-credential
      // lookup / PAT decryption) throwing means Confluence was never contacted,
      // so the detail points at the stored credentials rather than the import.
      let client: Awaited<ReturnType<typeof getClientForUser>> = null;
      try {
        client = await getClientForUser(userId);
      } catch (err) {
        backfillStatus = 'failed';
        backfillDetail =
          'Your stored Confluence credentials could not be used, so historical versions were not imported — the list below may be incomplete. Re-save your PAT in Settings → Confluence.';
        request.log.warn({ err, pageId: id }, '#763: version backfill skipped (Confluence client construction failed)');
      }
      if (client) {
        try {
          await backfillVersionHistory(ctx.id, ctx.confluenceId, client);
          backfillStatus = 'ok';
        } catch (err) {
          backfillStatus = 'failed';
          // #780: include the underlying Confluence error so the dialog shows
          // WHY the import failed (e.g. endpoint missing, permissions) instead
          // of a bare generic hint that leaves the user guessing. Sanitized
          // (single-line, length-capped) for the dialog surface.
          const reason = formatBackfillFailureReason(err);
          backfillDetail =
            `Importing historical versions from Confluence failed — the list below may be incomplete.${reason}`;
          request.log.warn({ err, pageId: id }, '#722: version backfill failed (Confluence unavailable)');
        }
      } else if (backfillStatus === undefined) {
        backfillStatus = 'skipped_no_credentials';
        backfillDetail =
          'No Confluence credentials are configured for your account, so historical versions could not be imported. Add your Confluence URL and PAT in Settings → Confluence.';
      }
    }

    const versions = await getVersionHistory(ctx.id);

    // Also include the current live version (not stored in page_versions until
    // it's superseded), surfaced as `isCurrent`.
    const currentResult = await query<{
      version: number;
      title: string;
      last_modified_at: Date | null;
    }>(
      'SELECT version, title, last_modified_at FROM pages WHERE id = $1',
      [ctx.id],
    );

    const currentVersion = currentResult.rows[0]
      ? {
          versionNumber: currentResult.rows[0].version,
          title: currentResult.rows[0].title,
          // #724: use real last_modified_at; null means never synced — don't substitute now()
          editedAt: currentResult.rows[0].last_modified_at?.toISOString() ?? null,
          syncedAt: currentResult.rows[0].last_modified_at?.toISOString() ?? null,
          author: null,
          message: null,
          isCurrent: true,
        }
      : null;

    // A snapshot whose version_number equals the live version (written on the
    // way to being superseded) would duplicate the synthetic current row — drop it.
    const historical = versions.filter(
      (v) => !currentVersion || v.versionNumber !== currentVersion.versionNumber,
    );

    return PageVersionsResponseSchema.parse({
      versions: [
        ...(currentVersion ? [currentVersion] : []),
        ...historical.map((v) => ({
          versionNumber: v.versionNumber,
          title: v.title,
          editedAt: v.editedAt?.toISOString() ?? null,
          syncedAt: v.syncedAt.toISOString(),
          author: v.author ?? null,
          message: v.message ?? null,
          isCurrent: false,
        })),
      ],
      pageId: id,
      backfillStatus,
      backfillDetail,
    });
  });

  // GET /api/pages/:id/versions/:version - get specific version
  fastify.get('/pages/:id/versions/:version', async (request) => {
    const { id, version: versionNum } = VersionParamSchema.parse(request.params);
    const userId = request.userId;

    const ctx = await resolveAndAuthorize(userId, id);
    if (!ctx) throw fastify.httpErrors.notFound('Page not found');

    // Check if requesting current version
    const currentResult = await query<{
      version: number;
      title: string;
      body_html: string;
      body_text: string;
    }>(
      'SELECT version, title, body_html, body_text FROM pages WHERE id = $1',
      [ctx.id],
    );

    if (currentResult.rows.length > 0 && currentResult.rows[0]!.version === versionNum) {
      return PageVersionDetailSchema.parse({
        confluenceId: ctx.confluenceId,
        versionNumber: versionNum,
        title: currentResult.rows[0]!.title,
        bodyHtml: currentResult.rows[0]!.body_html,
        bodyText: currentResult.rows[0]!.body_text,
        isCurrent: true,
      });
    }

    // Get from version history
    const pageVersion = await getVersion(ctx.id, versionNum);
    if (!pageVersion) {
      throw fastify.httpErrors.notFound(`Version ${versionNum} not found`);
    }

    // #722: Lazy-fetch the historical body from Confluence if we stored only metadata.
    let { bodyHtml, bodyText } = pageVersion;
    if (bodyHtml === null && ctx.confluenceId) {
      try {
        const client = await getClientForUser(userId);
        if (client) {
          const fetched = await getHistoricalBody(ctx.id, ctx.confluenceId, versionNum, client);
          bodyHtml = fetched.bodyHtml;
          bodyText = fetched.bodyText;
        }
      } catch (err) {
        request.log.warn({ err, pageId: id, version: versionNum }, '#722: lazy body fetch failed');
      }
    }

    return PageVersionDetailSchema.parse({
      confluenceId: pageVersion.confluenceId,
      versionNumber: pageVersion.versionNumber,
      title: pageVersion.title,
      bodyHtml,
      bodyText,
      editedAt: pageVersion.editedAt?.toISOString() ?? null,
      syncedAt: pageVersion.syncedAt?.toISOString() ?? null,
      author: pageVersion.author,
      message: pageVersion.message,
      isCurrent: false,
    });
  });

  // POST /api/pages/:id/versions/semantic-diff - AI-generated diff between two versions
  fastify.post('/pages/:id/versions/semantic-diff', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    // `model` is an optional client override. When omitted, getSemanticDiff
    // resolves the `chat` use-case server-side (ADR-021) — we deliberately do
    // NOT inject a hardcoded legacy default here, which would otherwise force a
    // model the configured provider may not host (issue #718 / PR #725 regression).
    const { v1, v2, model } = SemanticDiffSchema.parse(request.body);

    const ctx = await resolveAndAuthorize(userId, id);
    if (!ctx) throw fastify.httpErrors.notFound('Page not found');

    // For the current version, save a snapshot first so getSemanticDiff can find it
    const current = await query<{
      version: number;
      title: string;
      body_html: string;
      body_text: string;
    }>(
      'SELECT version, title, body_html, body_text FROM pages WHERE id = $1',
      [ctx.id],
    );

    if (current.rows.length > 0) {
      const row = current.rows[0]!;
      // Ensure current version exists in page_versions for comparison
      await saveVersionSnapshotByPageId(ctx.id, row.version, row.title, row.body_html, row.body_text);
    }

    // #722/#724: pass the Confluence client so getSemanticDiff can lazily fetch
    // bodies for backfilled (metadata-only) versions — otherwise they diff as
    // empty strings and the LLM reports "all content removed".
    let client: Awaited<ReturnType<typeof getClientForUser>> | null = null;
    if (ctx.confluenceId) {
      try {
        client = await getClientForUser(userId);
      } catch (err) {
        request.log.warn({ err, pageId: id }, '#722: semantic-diff client unavailable');
      }
    }

    const diff = await getSemanticDiff(ctx.id, v1, v2, model, ctx.confluenceId, client);
    return { diff, v1, v2, pageId: id };
  });

  // POST /api/pages/:id/versions/:version/restore - revert to an older version
  //
  // Confluence-style, non-destructive: the current live state becomes ordinary
  // history and the target becomes a NEW live version. A Confluence-sourced
  // restore writes upstream first under a durable intent, then atomically
  // adopts the accepted version locally; an unknown remote outcome never
  // advances local authored state or clears the intent. RBAC + the
  // optimistic-version guard mirror PUT /pages/:id.
  fastify.post('/pages/:id/versions/:version/restore', async (request) => {
    const { id, version: targetVersion } = VersionParamSchema.parse(request.params);
    const { version: expectedVersion } = RestoreVersionSchema.parse(request.body ?? {});
    const userId = request.userId;

    const ctx = await resolveAndAuthorize(userId, id);
    if (!ctx) throw fastify.httpErrors.notFound('Page not found');
    if (ctx.source === 'standalone' && ctx.createdByUserId !== userId && ctx.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to edit this page');
    }

    // Preserve the existing early UX error. The durable admission check below
    // is authoritative and closes the cross-process/freeze race.
    await rejectIfLiveCollabRoom(ctx.id, (m) => fastify.httpErrors.conflict(m));

    // Metadata-only history rows may be filled by a remote READ. Analysis and
    // historical reads remain available while frozen; no authored state is
    // mutated here, and restore admission still happens before any remote write.
    const targetBody = await query<{ body_html: string | null }>(
      'SELECT body_html FROM page_versions WHERE page_id = $1 AND version_number = $2',
      [ctx.id, targetVersion],
    );
    if (targetBody.rows[0]?.body_html === null && ctx.confluenceId) {
      const historyClient = await getClientForUser(userId);
      if (historyClient) {
        await getHistoricalBody(ctx.id, ctx.confluenceId, targetVersion, historyClient);
      }
    }

    const staysLocal = ctx.source !== 'confluence' || !(await isConfluenceEnabled(userId));
    let pushedToConfluence = false;
    let result: RestoreResult | null;

    if (staysLocal) {
      result = await withPageWriteTransaction([ctx.id], async (client) => {
        const current = await client.query<{ version: number }>(
          'SELECT version FROM pages WHERE id = $1 AND deleted_at IS NULL',
          [ctx.id],
        );
        const liveVersion = current.rows[0]?.version;
        if (liveVersion === undefined) throw fastify.httpErrors.notFound('Page not found');
        if (expectedVersion !== undefined && expectedVersion < liveVersion) {
          throw fastify.httpErrors.conflict(
            'Page has been modified since you loaded it. Please refresh and try again.',
          );
        }
        if (targetVersion === liveVersion) {
          throw fastify.httpErrors.badRequest('Cannot restore the current version');
        }
        return restoreVersion(ctx.id, targetVersion, { client, actorId: userId });
      });
    } else {
      if (!ctx.confluenceId) throw fastify.httpErrors.badRequest('Page is missing confluence_id');
      const client = await getClientForUser(userId);
      if (!client) throw fastify.httpErrors.badRequest('Confluence not configured');

      const intendedTarget = await query<{ title: string; body_html: string | null }>(
        'SELECT title, body_html FROM page_versions WHERE page_id = $1 AND version_number = $2',
        [ctx.id, targetVersion],
      );
      const intendedHistorical = intendedTarget.rows[0];
      if (!intendedHistorical) {
        throw fastify.httpErrors.notFound(`Version ${targetVersion} not found`);
      }
      if (intendedHistorical.body_html === null) {
        throw fastify.httpErrors.conflict('Historical version body is unavailable');
      }
      const storageBody = htmlToConfluence(intendedHistorical.body_html);
      const publication = describeConfluencePagePut({
        kind: 'page.version_restore',
        actorId: userId,
        pageId: ctx.id,
        confluenceId: ctx.confluenceId,
        title: intendedHistorical.title,
        bodyStorage: storageBody,
        expectedRemoteVersion: ctx.version,
        targetVersion,
      });

      // Durable conditional recovery metadata commits before updatePage. It
      // identifies the immutable history target and digest, never authored
      // title/body payload.
      const intent = await reservePageWriteIntent({
        pageIds: [ctx.id],
        kind: publication.kind,
        actorId: userId,
        effect: publication.effect,
      });

      const current = await query<{
        version: number;
        source: string;
        confluence_id: string | null;
      }>(
        'SELECT version, source, confluence_id FROM pages WHERE id = $1 AND deleted_at IS NULL',
        [ctx.id],
      );
      const fresh = current.rows[0];
      if (
        !fresh ||
        fresh.source !== 'confluence' ||
        fresh.confluence_id !== ctx.confluenceId ||
        fresh.version !== ctx.version ||
        (expectedVersion !== undefined && expectedVersion < fresh.version) ||
        targetVersion === fresh.version
      ) {
        await cancelPageWriteIntentBeforeEffect(intent);
        if (!fresh) throw fastify.httpErrors.notFound('Page not found');
        if (targetVersion === fresh.version) {
          throw fastify.httpErrors.badRequest('Cannot restore the current version');
        }
        throw fastify.httpErrors.conflict(
          'Page has been modified since you loaded it. Please refresh and try again.',
        );
      }

      const target = await query<{ title: string; body_html: string | null }>(
        'SELECT title, body_html FROM page_versions WHERE page_id = $1 AND version_number = $2',
        [ctx.id, targetVersion],
      );
      const historical = target.rows[0];
      if (
        !historical ||
        historical.body_html !== intendedHistorical.body_html ||
        historical.title !== intendedHistorical.title
      ) {
        await cancelPageWriteIntentBeforeEffect(intent);
        throw fastify.httpErrors.conflict('Historical version changed before restore could begin');
      }
      // Remote-first: if this fails, no local authored state changed. The
      // unresolved intent records that the remote outcome may be unknown.
      const confPage = await runPageWriteIntentEffect(intent, { kind: 'remote', completesRemoteWork: true }, () => client.updatePage(
        ctx.confluenceId!,
        historical.title,
        storageBody,
        fresh.version,
      ));
      result = await completePageWriteIntent(intent, (lockedClient) =>
        publishConfluencePagePut(lockedClient, publication, {
          confluenceId: confPage.id,
          title: confPage.title,
          bodyStorage: confPage.body?.storage?.value ?? storageBody,
          remoteVersion: confPage.version?.number,
        }, intent.id),
      );
      pushedToConfluence = true;
    }

    if (!result) throw fastify.httpErrors.notFound(`Version ${targetVersion} not found`);
    if (!pushedToConfluence) {
      await invalidateCollabDocAfterBodyWrite(ctx.id);
      await cache.invalidate(userId, 'pages');
    }

    await logAuditEvent(userId, 'PAGE_VERSION_RESTORED', 'page', String(ctx.id), {
      restoredFrom: targetVersion,
      newVersion: result.newVersion,
      title: result.title,
      source: ctx.source,
      pushedToConfluence,
    }, request);

    emitWebhookEvent({
      eventType: 'page.updated',
      payload: {
        pageId: ctx.id,
        title: result.title,
        spaceKey: ctx.spaceKey,
        updatedAt: new Date().toISOString(),
      },
    });

    return {
      id: ctx.id,
      title: result.title,
      version: result.newVersion,
      restoredFrom: targetVersion,
      source: ctx.source,
      pushedToConfluence,
    };
  });
}
