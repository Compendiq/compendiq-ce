import { query, getPool } from '../../../core/db/postgres.js';
import type { PoolClient } from 'pg';
import { resolveUsecase } from '../../llm/services/llm-provider-resolver.js';
import { chat, type TransportContext } from '../../llm/services/openai-compatible-client.js';
import { asRevision, loadProviderMetadata } from '../../llm/services/ai-policy-admission.js';
import { admitArticleStage, ArticleStageRefusedError, historicalVersionDigest } from '../../llm/services/article-stage-admission.js';
import { isAiPolicy } from '../../../core/services/ai-policy-service.js';
import { newAiOperation } from '../../../core/enterprise/ai-policy-hooks.js';
import { htmlToMarkdown, htmlToText } from '../../../core/services/content-converter.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';
import { getHistoricalBody } from '../../confluence/services/version-backfill.js';
import type { ConfluenceClient } from '../../confluence/services/confluence-client.js';
import { PageWriteError } from '../../../core/services/page-write-admission.js';
import { isVersionPlaceholderTitle, livePageVersion, type PageVersionSource } from '../../../core/services/version-snapshot.js';

import type { PageVersionRef } from '@compendiq/contracts';

// Re-export from core so existing consumers keep working
export { saveVersionSnapshot, saveVersionSnapshotByPageId } from '../../../core/services/version-snapshot.js';

interface PageVersion {
  id: string;
  pageId: number;
  confluenceId: string | null;
  versionNumber: number;
  source: PageVersionSource;
  title: string;
  bodyHtml: string | null;
  bodyText: string | null;
  syncedAt: Date;
  editedAt: Date | null;
  author: string | null;
  message: string | null;
}

// The internal legacy lookup prefers the page provenance for callers without a source.
const PREFERRED_VERSION_SOURCE = `CASE WHEN p.source = 'confluence' THEN 'confluence' ELSE 'local' END`;

/**
 * Get version history for a page, keyed by the internal integer `page_id`.
 *
 * History is stored against `page_versions.page_id` (the universal FK since
 * migration 030), so both Confluence-synced and standalone/local pages surface
 * their snapshots here. RBAC is enforced by the caller before this runs (the
 * route resolves and access-checks the page first).
 */
export async function getVersionHistory(
  pageId: number,
): Promise<Omit<PageVersion, 'bodyHtml' | 'bodyText'>[]> {
  const result = await query<{
    id: string;
    page_id: number;
    confluence_id: string | null;
    version_number: number;
    source: PageVersionSource;
    title: string;
    synced_at: Date;
    edited_at: Date | null;
    author: string | null;
    message: string | null;
  }>(
    `SELECT pv.id, pv.page_id, p.confluence_id, pv.version_number, pv.source, pv.title, pv.synced_at,
            pv.edited_at, pv.author, pv.message
     FROM page_versions pv
     JOIN pages p ON pv.page_id = p.id
     WHERE pv.page_id = $1
       AND p.deleted_at IS NULL
     ORDER BY COALESCE(pv.edited_at, pv.synced_at) DESC NULLS LAST, pv.version_number DESC, pv.source ASC`,
    [pageId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    pageId: row.page_id,
    confluenceId: row.confluence_id,
    versionNumber: row.version_number,
    source: row.source,
    title: row.title,
    syncedAt: row.synced_at,
    editedAt: row.edited_at ?? null,
    author: row.author ?? null,
    message: row.message ?? null,
  }));
}

/**
 * Get a specific version of a page by internal `page_id` + version number.
 * RBAC is enforced by the caller before this runs.
 */
export async function getVersion(
  pageId: number,
  versionNumber: number,
  { source, client }: { source?: PageVersionSource; client?: PoolClient } = {},
): Promise<PageVersion | null> {
  const readQuery: typeof query = client ? client.query.bind(client) : query;
  const result = await readQuery<{
    id: string;
    page_id: number;
    confluence_id: string | null;
    version_number: number;
    source: PageVersionSource;
    title: string;
    body_html: string | null;
    body_text: string | null;
    synced_at: Date;
    edited_at: Date | null;
    author: string | null;
    message: string | null;
  }>(
    `SELECT pv.id, pv.page_id, p.confluence_id, pv.version_number, pv.source, pv.title, pv.body_html, pv.body_text,
            pv.synced_at, pv.edited_at, pv.author, pv.message
     FROM page_versions pv
     JOIN pages p ON pv.page_id = p.id
     WHERE pv.page_id = $1
       AND p.deleted_at IS NULL
       AND pv.version_number = $2
       AND ($3::text IS NULL OR pv.source = $3)
     ORDER BY (pv.source = ${PREFERRED_VERSION_SOURCE}) DESC LIMIT 1`,
    [pageId, versionNumber, source ?? null],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0]!;
  return {
    id: row.id,
    pageId: row.page_id,
    confluenceId: row.confluence_id,
    versionNumber: row.version_number,
    source: row.source,
    title: row.title,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    syncedAt: row.synced_at,
    editedAt: row.edited_at ?? null,
    author: row.author ?? null,
    message: row.message ?? null,
  };
}

export interface RestoreResult {
  pageId: number;
  title: string;
  /** New live version after the restore (old version + bump, or the remote accepted version). */
  newVersion: number;
  bodyHtml: string | null;
  bodyText: string | null;
}

export interface RestoreVersionOptions {
  source?: PageVersionSource;
  /**
   * A caller-owned transaction which already holds the page lifecycle fence.
   * When supplied, this function never begins, commits, rolls back, or releases
   * the transaction.
   */
  client?: PoolClient;
  /**
   * Optimistic version observed by the caller. When present, it is checked
   * against the row acquired by `FOR UPDATE`, before history or live content
   * changes. Omission deliberately preserves unconditional restore behavior.
   */
  expectedVersion?: number;
  /** Actor recorded for a local-only restore. */
  actorId?: string;
}

/**
 * Non-destructive local restore of an older snapshot.
 *
 * In one caller-owned or locally-owned transaction:
 *   1. Lock the live page and, when supplied, validate `expectedVersion`.
 *   2. Snapshot the CURRENT live state into `page_versions` (so the revert is
 *      itself reversible and intermediate manual edits aren't lost — a plain
 *      edit-save does not snapshot, only sync/draft-publish/this path do).
 *   3. Apply the target snapshot's title / body_html / body_text to the live
 *      `pages` row, re-deriving body_text from body_html when needed.
 *   4. Bump `version` and mark the page
 *      dirty so the change flows through search/embedding like an edit-save.
 *
 * The inserted `page_versions` row is ordinary best-effort history, not
 * baseline evidence. Baseline publication independently compares and links an
 * exact matching snapshot; ON CONFLICT here deliberately never overwrites an
 * existing same-version row.
 *
 * @returns the applied content + new version, or `null` if the target version
 *          doesn't exist for the page.
 */
export async function restoreVersion(
  pageId: number,
  targetVersion: number,
  options: RestoreVersionOptions = {},
): Promise<RestoreResult | null> {
  const ownsTransaction = options.client === undefined;
  const txClient = options.client ?? await getPool().connect();
  try {
    if (ownsTransaction) await txClient.query('BEGIN');

    // Lock the live row so concurrent edits/restores serialise. Production
    // mutation callers acquire the lifecycle advisory lock before reaching
    // this row lock; the locally-owned form remains for focused service tests.
    const liveRes = await txClient.query<{
      version: number;
      remote_version: number | null;
      local_modified_at: Date | null;
      title: string;
      body_html: string | null;
      body_text: string | null;
      source: string;
    }>(
      `SELECT version, remote_version, local_modified_at, title, body_html, body_text, source
       FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [pageId],
    );
    if (liveRes.rows.length === 0) {
      if (ownsTransaction) await txClient.query('ROLLBACK');
      return null;
    }
    const live = liveRes.rows[0]!;

    if (options.expectedVersion !== undefined && options.expectedVersion < live.version) {
      throw new PageWriteError(
        409,
        'stale_content_revision',
        'Page has been modified since you loaded it. Please refresh and try again.',
      );
    }

    const liveIdentity = livePageVersion(live);
    if (targetVersion === liveIdentity.versionNumber && options.source === liveIdentity.source) {
      throw new PageWriteError(400, 'current_version', 'Cannot restore the current version');
    }
    const target = await getVersion(pageId, targetVersion, {
      client: txClient, ...(options.source === undefined ? {} : { source: options.source }),
    });
    if (!target) {
      if (ownsTransaction) await txClient.query('ROLLBACK');
      return null;
    }

    // Backfilled rows are metadata-only until lazily fetched. Never blank a
    // live page or push an empty body upstream.
    if (target.bodyHtml === null) {
      if (ownsTransaction) await txClient.query('ROLLBACK');
      throw new Error(
        `Cannot restore version ${targetVersion} of page ${pageId}: historical body is unavailable (not yet fetched from Confluence).`,
      );
    }

    // Ordinary history only. Never overwrite a same-version row: it may differ
    // from the current payload, and the immutable baseline remains authoritative.
    await txClient.query(
      `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, $6, $2, $3, $4, $5, NOW())
       ON CONFLICT (page_id, source, version_number) DO NOTHING`,
      [pageId, live.version, live.title, live.body_html, live.body_text, liveIdentity.source],
    );

    const newVersion = live.version + 1;
    const restoredTitle = isVersionPlaceholderTitle(target.title, targetVersion) ? live.title : target.title;
    const restoredBodyText = target.bodyText ?? htmlToText(target.bodyHtml);
    await txClient.query(
      `UPDATE pages SET
         title = $2, body_html = $3, body_text = $4,
         version = $5,
         last_modified_at = NOW(),
         embedding_dirty = TRUE,
         image_analysis_dirty = CASE
           WHEN body_html IS DISTINCT FROM $3 THEN TRUE
           ELSE image_analysis_dirty
         END,
         embedding_status = 'not_embedded', embedded_at = NULL,
         local_modified_at = NOW(),
         local_modified_by = $6::uuid
       WHERE id = $1`,
      [
        pageId,
        restoredTitle,
        target.bodyHtml,
        restoredBodyText,
        newVersion,
        options.actorId ?? null,
      ],
    );

    if (ownsTransaction) await txClient.query('COMMIT');
    return {
      pageId,
      title: restoredTitle,
      newVersion,
      bodyHtml: target.bodyHtml,
      bodyText: restoredBodyText,
    };
  } catch (err) {
    if (ownsTransaction) await txClient.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    if (ownsTransaction) txClient.release();
  }
}

/**
 * Resolve a version's `bodyHtml`, lazily fetching it from Confluence and
 * persisting it when the stored row is metadata-only (body_html IS NULL).
 *
 * Returns the resolved HTML, or the row's existing `bodyHtml` (possibly null)
 * when there is nothing to fetch (no Confluence id / client, or the fetch fails).
 * Best-effort: a Confluence failure must not break the diff — we fall back to
 * whatever body we have.
 */
async function resolveVersionBodyHtml(
  pageId: number,
  version: PageVersion,
  confluenceId?: string | null,
  client?: ConfluenceClient | null,
): Promise<string | null> {
  if (version.bodyHtml !== null) return version.bodyHtml;
  if (version.source !== 'confluence' || !confluenceId || !client) return version.bodyHtml;
  try {
    const fetched = await getHistoricalBody(pageId, confluenceId, version.versionNumber, client);
    return fetched.bodyHtml;
  } catch {
    return version.bodyHtml;
  }
}

/**
 * Generate a semantic diff between two versions using LLM.
 *
 * Sends both versions' text to the LLM and asks for a human-readable
 * description. `model` is an optional caller override; when falsy the `chat`
 * use-case assignment (resolved below) supplies the concrete model, so the
 * route never has to depend on a hardcoded model name (ADR-021).
 */
export async function getSemanticDiff(
  pageId: number,
  v1: PageVersionRef,
  v2: PageVersionRef,
  model?: string,
  confluenceId?: string | null,
  client?: ConfluenceClient | null,
  userId?: string,
): Promise<string> {
  if (!userId) throw new ArticleStageRefusedError();
  const current = await query<{
    source: string; version: number; remote_version: number | null; local_modified_at: Date | null;
    title: string; body_html: string | null; body_text: string | null;
    ai_policy: string; ai_policy_revision: string; content_revision: string;
  }>(
    `SELECT source, version, remote_version, local_modified_at, title, body_html, body_text,
            ai_policy, ai_policy_revision, content_revision
       FROM pages WHERE id = $1 AND deleted_at IS NULL`,
    [pageId],
  );
  const row = current.rows[0];
  if (!row) throw new ArticleStageRefusedError();
  const identity = livePageVersion(row);
  const liveDigest = historicalVersionDigest(row.title, row.body_html, row.body_text);

  const resolve = async (reference: PageVersionRef) => {
    if (reference.source === identity.source && reference.versionNumber === identity.versionNumber) {
      if (row.body_html === null && row.body_text === null) throw new ArticleStageRefusedError();
      return { ...reference, title: row.title, bodyHtml: row.body_html, bodyText: row.body_text, history: null };
    }
    const version = await getVersion(pageId, reference.versionNumber, { source: reference.source });
    if (!version) throw new PageWriteError(404, 'version_not_found', `Version ${reference.versionNumber} not found`);
    const bodyHtml = await resolveVersionBodyHtml(pageId, version, confluenceId, client);
    // A lazy fill can race an import or retention. Use only the exact bytes
    // and snapshot identity captured in the provenance.
    const saved = await getVersion(pageId, reference.versionNumber, { source: reference.source });
    if (!saved || saved.id !== version.id || saved.title !== version.title || saved.bodyHtml !== bodyHtml
      || (bodyHtml === null && saved.bodyText !== version.bodyText)
      || (saved.bodyHtml === null && saved.bodyText === null)) throw new ArticleStageRefusedError();
    return { ...saved, history: { pageId, versionId: saved.id, ...reference,
      digest: historicalVersionDigest(saved.title, saved.bodyHtml, saved.bodyText) } };
  };
  const [version1, version2] = await Promise.all([resolve(v1), resolve(v2)]);
  const { bodyHtml: body1 } = version1;
  const { bodyHtml: body2 } = version2;

  // Convert to markdown for LLM consumption
  const text1 = body1 ? htmlToMarkdown(body1) : (version1.bodyText ?? '');
  const text2 = body2 ? htmlToMarkdown(body2) : (version2.bodyText ?? '');

  // Truncate to prevent excessive LLM input
  const maxLen = 8000;
  const t1 = text1.length > maxLen ? text1.slice(0, maxLen) + '\n[...truncated]' : text1;
  const t2 = text2.length > maxLen ? text2.slice(0, maxLen) + '\n[...truncated]' : text2;

  const { sanitized: sanitized1 } = sanitizeLlmInput(t1);
  const { sanitized: sanitized2 } = sanitizeLlmInput(t2);

  const systemPrompt = `You are a technical documentation reviewer. Compare the two versions of a document below and provide a concise, human-readable summary of what changed between them. Focus on:
1. Content additions (new sections, paragraphs, information)
2. Content removals (deleted sections, information)
3. Content modifications (rewording, restructuring)
4. Significance of changes (is this a minor edit or major revision?)

Format your response as a clear bullet-point list. Be specific about what changed.`;

  const userPrompt = `## Version ${v1.versionNumber} [${v1.source}] (Title: "${version1.title}")
${sanitized1}

---

## Version ${v2.versionNumber} [${v2.source}] (Title: "${version2.title}")
${sanitized2}`;

  const { config, model: resolvedModel } = await resolveUsecase('chat');
  const policyRevision = asRevision(row.ai_policy_revision);
  const contentRevision = asRevision(row.content_revision);
  const provider = await loadProviderMetadata({ query }, config.providerId);
  if (!isAiPolicy(row.ai_policy) || policyRevision === null || contentRevision === null
    || !provider || provider.configRevision !== config.configRevision) throw new ArticleStageRefusedError();
  const historicalVersions = [version1.history, version2.history].filter((version) => version !== null);
  const liveVersion = version1.history === null || version2.history === null
    ? { pageId, ...identity, digest: liveDigest }
    : undefined;
  const transportContext: TransportContext = { kind: 'article', stage: {
    provenance: { version: 1, providerId: config.providerId, configRevision: provider.configRevision,
      locality: provider.effectiveLocality, pages: [{ pageId, policy: row.ai_policy, policyRevision, contentRevision }] },
    userId, usecase: 'chat', context: { operation: newAiOperation('semantic_diff', { kind: 'user', id: userId }),
      stage: 'semantic_diff', attempt: 1, historicalVersions,
      ...(liveVersion === undefined ? {} : { liveVersion }),
      modelSelection: model ? { kind: 'explicit', model } : { kind: 'assigned' } },
  } };
  await admitArticleStage(transportContext.stage.provenance, userId, 'chat', undefined, transportContext.stage.context);
  const result = await chat(config, model || resolvedModel, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], { transportContext });
  await admitArticleStage(transportContext.stage.provenance, userId, 'chat', async () => undefined, transportContext.stage.context);
  return result;
}
