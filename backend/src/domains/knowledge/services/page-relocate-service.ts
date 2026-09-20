/**
 * Relocate an article between a local space and Confluence (#1123).
 *
 * This is the only code path in the app that mutates `pages.source` after
 * insert, so it is also the only one that changes which identifier a page's
 * children must store in `parent_id`. The whole local side runs in one
 * transaction under {@link PAGE_MOVE_ADVISORY_LOCK_ID}; the irreversible
 * upstream call is ordered so that no failure can destroy the user's article.
 *
 * ## Ordering (the part that matters)
 *
 * **local → Confluence.** Create upstream FIRST, commit `confluence_id` LAST.
 * Between the two, the row still has `confluence_id IS NULL`, so
 * `detectDeletedPages` — whose candidate query is
 * `WHERE space_key=$1 AND deleted_at IS NULL AND confluence_id IS NOT NULL` —
 * cannot see it. Committing a `confluence_id` for a page the upstream create
 * never produced would get the article soft-deleted on the next sync; that is
 * structurally impossible here. The acknowledged create identity and each
 * acknowledged attachment receipt are persisted in the operation-owned
 * preparation before any later provider work. Later failures keep the original
 * local article, upstream page, durable progress, and pending intent; recovery
 * only publishes after it can verify a complete bounded receipt set.
 *
 * **Confluence → local.** Commit the local flip FIRST, delete upstream after.
 * Once `confluence_id` is NULL the article is permanently outside deletion
 * reconciliation's reach. The inverse order — delete upstream, then commit —
 * would leave a window where a committed-`confluence_id` row points at a
 * trashed page, which reconciliation resolves by soft-deleting the user's
 * article. If the upstream delete then fails, we confirm via `getPage()`
 * whether it actually succeeded (404 / `status: 'trashed'`, exactly the test
 * `detectDeletedPages` uses); only if the page is provably still live do we
 * compensate by restoring the pre-move state, so neither side changed.
 *
 * ## Filesystem
 *
 * Attachment files cannot join a database transaction. Their exact digests and
 * names are therefore persisted in the operation-owned preparation before any
 * copy. Recovery verifies those bytes before publication, and terminal
 * settlement is withheld until every obsolete namespace is removed
 * successfully; a failed cleanup remains a pending, retryable intent.
 */

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { PoolClient } from 'pg';
import { query } from '../../../core/db/postgres.js';
import {
  ATTACHMENT_SNAPSHOT_LOCK_ID,
  PAGE_MOVE_ADVISORY_LOCK_ID,
} from '../../../core/db/advisory-locks.js';
import {
  invalidateCollabDocAfterBodyWrite,
  rejectIfLiveCollabRoom,
} from '../../../core/services/collab-guard.js';
import { logger } from '../../../core/utils/logger.js';
import {
  htmlToConfluence,
  confluenceToHtml,
  htmlToText,
} from '../../../core/services/content-converter.js';
import {
  listCachedAttachments,
  readCachedAttachmentFile,
  writeAttachmentCacheAt,
  getMimeType,
  isStorableAttachmentFilename,
  attachmentCacheDir,
} from '../../confluence/services/attachment-handler.js';
import {
  canStoreLocalFilename,
  listLocalAttachmentsForRelocate,
  writeLocalAttachmentFileForRelocate,
  removeLocalAttachmentDirectory,
  localAttachmentsDir,
} from '../../../core/services/local-attachment-service.js';
import {
  getUserAccessibleSpaces,
  userCanAccessPage,
} from '../../../core/services/rbac-service.js';
import { withLocalAttachmentMutationLock } from '../../../core/services/attachment-snapshot-lock.js';
import {
  advancePageWriteIntent,
  cancelPageWriteIntentBeforeEffect,
  completePageWriteIntent,
  PageWriteError,
  registerPageWriteIntentReconciler,
  withPageWriteTransaction,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
  type PageWriteIntent,
  type PageWriteIntentReconciler,
} from '../../../core/services/page-write-admission.js';
import { enqueuePageWriteInvalidation } from '../../../core/services/page-write-invalidation.js';
import {
  ConfluenceError,
  type ConfluenceClient,
} from '../../confluence/services/confluence-client.js';
import { getClientForUser } from '../../confluence/services/sync-service.js';
import type { RelocatePageInput, RelocatePageResponse } from '@compendiq/contracts';

/** Error carrying the HTTP status the route should surface. */
export class RelocateError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RelocateError';
  }
}

/**
 * The page columns a relocate reads and restores.
 *
 * Every column the move writes must appear here, because the compensating
 * transaction restores exactly this set. A column written but not captured
 * survives a rollback with the moved value — which is how a compensated
 * relocate could leave `local_modified_at > last_synced` and make sync report
 * a phantom conflict against content identical to upstream.
 */
export interface RelocatablePage {
  id: number;
  title: string;
  source: string;
  space_key: string | null;
  confluence_id: string | null;
  visibility: string;
  created_by_user_id: string | null;
  body_html: string | null;
  body_storage: string | null;
  body_text: string | null;
  version: number;
  inherit_perms: boolean;
  local_modified_at: Date | null;
  local_modified_by: string | null;
  content_revision: string;
  lifecycle_revision: string;
  embedding_dirty: boolean;
  /**
   * #1115 P2 (review r1) — captured because the move now WRITES it. The rule
   * above is not advisory: a column the move sets and the snapshot omits comes
   * back from a compensation still carrying the moved value.
   */
  /** ADR-027 D4 (#1616) — the analysis flag, written and restored beside the legacy one. */
  image_analysis_dirty: boolean;
  embedding_status: string | null;
  embedded_at: Date | null;
}

export const RELOCATABLE_COLUMNS =
  'id, title, source, space_key, confluence_id, visibility, created_by_user_id, ' +
  'body_html, body_storage, body_text, version, inherit_perms, local_modified_at, ' +
  'local_modified_by, embedding_dirty, image_analysis_dirty, embedding_status, embedded_at, ' +
  'content_revision::text, lifecycle_revision::text';

/** A mirrored Confluence page restriction, as stored in `access_control_entries`. */
interface PageAce {
  principal_type: string;
  principal_id: string;
  permission: string;
}

/** Everything the compensating restore needs; captured before any mutation. */
interface PreMoveSnapshot extends RelocatablePage {
  /** Direct children that stored the pre-move identifier. */
  childIds: number[];
  oldKey: string;
  /** Page-level ACEs the move deletes; restored verbatim on compensation. */
  aces: PageAce[];
}

interface RelocationAttachmentPreparation {
  sourceName: string;
  targetName: string;
  contentType: string;
  size: number;
  sha256: string;
}

interface ProviderAttachmentReceipt {
  id: string;
  title: string;
  version: number;
  mediaType: string | null;
  fileSize: number | null;
}

interface RelocationPreparation extends PreMoveSnapshot {
  intentId: string;
  direction: 'to_confluence' | 'to_local';
  actorId: string;
  targetSpaceKey: string | null;
  targetVisibility: 'private' | 'shared' | null;
  attachments: RelocationAttachmentPreparation[];
  expectedRemoteTitleSha256: string;
  expectedRemoteBodyStorageSha256: string;
  parentConfluenceId: string | null;
  createdConfluenceId: string | null;
  createdPageReceipt: RemotePageReceipt | null;
  attachmentReceipts: ProviderAttachmentReceipt[];
}

interface RemotePageReceipt {
  id: string;
  version: number;
  titleSha256: string;
  bodyStorageSha256: string;
}

/**
 * The identifier a page's children store in `parent_id`: its `confluence_id`
 * when Confluence-sourced, its numeric id as text when standalone. This is the
 * dual-identifier scheme the tree CTE resolves with
 * `COALESCE(t.confluence_id, t.id::text)` (`pages-crud.ts`).
 */
export function parentKeyFor(source: string, id: number, confluenceId: string | null): string {
  return source === 'confluence' && confluenceId ? confluenceId : String(id);
}

/**
 * Refuse the move when the identifier a child would resolve against is not
 * unique across the table.
 *
 * `parent_id` is an unconstrained TEXT column resolved against *either*
 * `confluence_id` *or* `id::text`, and Confluence DC page ids are numeric
 * strings — so a standalone page with `id = 1234567` and a Confluence page
 * with `confluence_id = '1234567'` are indistinguishable to every reader. If
 * either the old or the new key collides, rewriting `parent_id = <key>` would
 * silently re-parent another page's children. Detect it and refuse rather than
 * corrupt the tree.
 *
 * Shared with `PUT /api/pages/:id/move` since #1166 — the two writers of
 * `parent_id` must agree on what counts as ambiguous. `/move` cannot get away
 * with picking a winner instead: choosing one row settles the `path` and the
 * stored key, but the *stored key itself stays ambiguous*, so the cycle guard
 * would validate one candidate parent while readers follow the other. That is
 * how a page became its own parent (#891 regression, caught on #1166 review).
 */
export async function assertIdentifierUnambiguous(
  key: string,
  pageId: number,
  label: string,
  txClient?: PoolClient,
  action: 'relocate' | 'move' = 'relocate',
): Promise<void> {
  // Soft-deleted rows are deliberately IN scope. `pages_confluence_id_unique`
  // (migration 029) is partial on `confluence_id IS NOT NULL` and does not
  // exclude `deleted_at`, so a trashed row still owns its `confluence_id`:
  // filtering it out here turned a designed 409 into a constraint violation
  // surfacing as a 500. A trashed row can also be restored, at which point it
  // would compete for the same children.
  const sql = `SELECT id, title FROM pages
      WHERE id <> $2 AND (confluence_id = $1 OR id::text = $1)`;
  const clash = txClient
    ? await txClient.query<{ id: number; title: string }>(sql, [key, pageId])
    : await query<{ id: number; title: string }>(sql, [key, pageId]);
  const first = clash.rows[0];
  if (first) {
    throw new RelocateError(
      409,
      `Cannot ${action}: the ${label} identifier "${key}" is also used by page ${first.id} ` +
        `("${first.title}"), so the parent link would be ambiguous.`,
      { conflictingPageId: first.id },
    );
  }
}

/**
 * One rewritten reference. The two names are **not** interchangeable.
 *
 * `local` is the on-disk cache key — the last path segment of the URL, which
 * for a cross-page reference is a *synthetic* `stem.xref-<hash>.ext` minted by
 * `getLocalFilenameForImageSource` so two pages' same-named attachments cannot
 * collide in one cache directory.
 *
 * `target` is the real Confluence attachment filename, carried in
 * `data-confluence-filename`. That is the name `htmlToConfluence` must emit as
 * `ri:filename`, and therefore the name the bytes have to be uploaded under.
 */
export interface RewrittenRef {
  /** Filename in the source store — may be a synthetic `xref` name. */
  local: string;
  /** Real Confluence attachment filename to publish and key the new URL by. */
  target: string;
}

/**
 * Rewrite attachment URLs in editor HTML from one or more source prefixes to a
 * single destination prefix, returning the new HTML and the references touched.
 *
 * Both attachment stores appear in `body_html`:
 * `/api/attachments/<key>/<file>` (the Confluence cache — also where pasted
 * images on standalone pages land) and `/api/local-attachments/<id>/<file>`
 * (the local store). A relocate changes the key, so every reference must
 * follow.
 *
 * `markAsConfluenceAttachment` switches on the publish-side transform, and that
 * is where the two filenames diverge (review finding B1):
 *
 *  - `data-confluence-filename` is **preserved** when already present. It holds
 *    the true attachment name, while the URL's last segment may be the
 *    synthetic `xref` name; overwriting the attribute with that made
 *    `htmlToConfluence` emit `ri:filename="chart.xref-….png"`, a file that
 *    exists nowhere in Confluence. It is only *filled in* when absent — a
 *    pasted image, where the URL segment IS the real name.
 *  - `data-confluence-owner-page-title` / `-space-key` are **stripped**. They
 *    make the converter emit a nested `<ri:page>` owner, steering the reference
 *    at the page the image was originally borrowed from — but relocate uploads
 *    the bytes to the *new* page, so the reference must resolve there.
 *  - The rewritten URL is keyed by `target`, matching where the bytes are
 *    staged, so it survives `confluenceToHtml` regenerating the body after the
 *    upstream create.
 *
 * Without the mark, filenames pass through untouched (`target === local`): a
 * move to a local space re-keys the directory, never the file.
 */
export function rewriteAttachmentRefs(
  html: string,
  fromPrefixes: string[],
  toPrefix: string,
  markAsConfluenceAttachment: boolean,
): { html: string; refs: RewrittenRef[] } {
  if (!html) return { html, refs: [] };
  if (!fromPrefixes.some((p) => html.includes(p))) return { html, refs: [] };

  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;
  const refs = new Map<string, RewrittenRef>();
  let changed = false;

  /**
   * Handles `img[src]` AND `a[href]`. The anchor arm looks defensive but is
   * live (#1169): the Markdown import (#1133) produces one whenever a link
   * targets an internal attachment URL — `markdownToHtml` and DOMPurify both
   * keep `href` verbatim, and `htmlToConfluence` *preserves* the anchor rather
   * than dropping it, so it round-trips into `body_storage` and back. On a move
   * to local the bytes are staged under the new key and the old cache directory
   * is then removed, so an anchor left on the old prefix is a dead link into a
   * directory this very move deleted.
   *
   * Only images are marked for publish. `htmlToConfluence` converts nothing but
   * `img[src^="/api/attachments/"]` into an `ri:attachment`, so an anchor's
   * rewritten href survives to Confluence as a raw internal URL either way —
   * imperfect, pre-dates #1164, and out of scope here. Confluence's own
   * attachment links arrive as `<a href="#confluence-attachment:…">`, which
   * never carries the prefix and is left alone by the prefix test below.
   */
  const rewriteOne = (el: Element, attr: string): void => {
    const value = el.getAttribute(attr) ?? '';
    const matched = fromPrefixes.find((p) => value.startsWith(p));
    if (matched === undefined) return;
    const encodedName = value.slice(matched.length);
    if (!encodedName || encodedName.includes('/')) return;
    let local: string;
    try {
      local = decodeURIComponent(encodedName);
    } catch {
      local = encodedName;
    }

    // An external-URL image round-trips as ri:url, not ri:attachment — leave
    // its markers alone or htmlToConfluence emits the wrong element entirely.
    const isExternal = el.getAttribute('data-confluence-image-source') === 'external-url';
    const publish = markAsConfluenceAttachment && el.tagName.toLowerCase() === 'img' && !isExternal;
    const target = publish ? (el.getAttribute('data-confluence-filename') || local) : local;

    if (publish) {
      el.setAttribute('data-confluence-filename', target);
      el.setAttribute('data-confluence-image-source', 'attachment');
      el.removeAttribute('data-confluence-owner-page-title');
      el.removeAttribute('data-confluence-owner-space-key');
    }

    refs.set(local, { local, target });
    el.setAttribute(attr, `${toPrefix}${encodeURIComponent(target)}`);
    changed = true;
  };

  for (const img of doc.querySelectorAll('img[src]')) rewriteOne(img, 'src');
  for (const anchor of doc.querySelectorAll('a[href]')) rewriteOne(anchor, 'href');

  return { html: changed ? doc.body.innerHTML : html, refs: [...refs.values()] };
}


/** Number of local version snapshots a move to Confluence would discard. */
export async function countLocalVersions(pageId: number): Promise<number> {
  const res = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM page_versions WHERE page_id = $1',
    [pageId],
  );
  return parseInt(res.rows[0]?.count ?? '0', 10);
}

/** Every attachment filename a page owns, across both stores. */
export async function collectAttachmentFilenames(page: {
  id: number;
  source: string;
  confluence_id: string | null;
}): Promise<string[]> {
  const names = new Set<string>();
  for (const name of await listCachedAttachments(parentKeyFor(page.source, page.id, page.confluence_id))) {
    names.add(name);
  }
  if (page.source === 'standalone') {
    // A standalone page's pasted images land in the Confluence cache keyed by
    // its numeric id (`POST /pages/:id/images`), while draw.io saves and
    // explicit uploads land in the local store. Both must migrate.
    for (const row of await listLocalAttachmentsForRelocate(page.id)) names.add(row.filename);
  }
  return [...names];
}

async function reserveRelocateIntent(input: {
  page: RelocatablePage;
  userId: string;
  target: 'confluence' | 'local';
  targetSpaceKey: string | null;
}): Promise<PageWriteIntent> {
  const oldKey = parentKeyFor(input.page.source, input.page.id, input.page.confluence_id);
  const affected = await query<{
    id: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT id, content_revision::text, lifecycle_revision::text
       FROM pages
      WHERE id = $1 OR (parent_id = $2 AND id <> $1)
      ORDER BY id`,
    [input.page.id, oldKey],
  );
  const pageIds = affected.rows.map((row) => row.id);
  const expectedRevisions = Object.fromEntries(
    affected.rows.map((row) => [
      row.id,
      {
        contentRevision: row.content_revision,
        lifecycleRevision: row.lifecycle_revision,
      },
    ]),
  );
  const originalRoot = expectedRevisions[input.page.id];
  if (
    !originalRoot ||
    originalRoot.contentRevision !== input.page.content_revision ||
    originalRoot.lifecycleRevision !== input.page.lifecycle_revision
  ) {
    throw new RelocateError(409, 'Page changed while relocation was being prepared. Reload and try again.');
  }
  const intent = await reservePageWriteIntent({
    pageIds,
    kind: 'page.relocate',
    actorId: input.userId,
    expectedRevisions,
    effect: {
      effectClass: 'remote',
      pageId: input.page.id,
      target: input.target,
      fromSource: input.page.source,
      fromConfluenceId: input.page.confluence_id,
      fromSpaceKey: input.page.space_key,
      targetSpaceKey: input.targetSpaceKey,
      affectedPageIds: pageIds,
    },
  });

  // Reserving the root prevents participating reparent writers from crossing
  // this point. Re-expand and re-read the payload before any file/remote effect
  // so a waiter never operates on the pre-lock hierarchy or body.
  const reexpanded = await query<{ id: number }>(
    `SELECT id FROM pages
      WHERE id = $1 OR (parent_id = $2 AND id <> $1)
      ORDER BY id`,
    [input.page.id, oldKey],
  );
  const current = await query<Pick<
    RelocatablePage,
    'source' | 'confluence_id' | 'space_key' | 'version' | 'title' | 'body_html' | 'body_storage'
  >>(
    `SELECT source, confluence_id, space_key, version, title, body_html, body_storage
       FROM pages WHERE id = $1 AND deleted_at IS NULL`,
    [input.page.id],
  );
  const ids = reexpanded.rows.map((row) => row.id);
  const page = current.rows[0];
  const changed =
    ids.length !== pageIds.length ||
    ids.some((pageId, index) => pageId !== pageIds[index]) ||
    !page ||
    page.source !== input.page.source ||
    page.confluence_id !== input.page.confluence_id ||
    page.space_key !== input.page.space_key ||
    page.version !== input.page.version ||
    page.title !== input.page.title ||
    page.body_html !== input.page.body_html ||
    page.body_storage !== input.page.body_storage;
  if (changed) {
    await cancelPageWriteIntentBeforeEffect(intent);
    throw new RelocateError(409, 'Page or hierarchy changed while relocation was waiting. Reload and try again.');
  }
  return intent;
}

/**
 * Re-read the same three authority gates the route applied. Transactional
 * readers bypass RBAC caches, so both the pre-effect admission and the final
 * local commit observe current authority.
 */
async function assertCurrentRelocateAuthorityOnClient(
  client: PoolClient,
  userId: string,
  pageId: number,
  confluenceSpaceKey: string | null,
): Promise<void> {
  const actor = await client.query<{
    role: string;
    deactivated_at: Date | null;
    has_global_permission: boolean;
  }>(
    `SELECT u.role, u.deactivated_at,
            EXISTS (
              SELECT 1
                FROM space_role_assignments sra
                JOIN roles r ON r.id = sra.role_id
               WHERE 'pages:relocate' = ANY(r.permissions)
                 AND (
                   (sra.principal_type = 'user' AND sra.principal_id = u.id::text)
                   OR (
                     sra.principal_type = 'group'
                     AND sra.principal_id ~ '^\\d+$'
                     AND sra.principal_id::integer IN (
                       SELECT gm.group_id FROM group_memberships gm WHERE gm.user_id = u.id
                     )
                   )
                 )
            ) AS has_global_permission
       FROM users u
      WHERE u.id = $1`,
    [userId],
  );
  const currentActor = actor.rows[0];
  if (
    !currentActor ||
    currentActor.deactivated_at !== null ||
    (currentActor.role !== 'admin' && !currentActor.has_global_permission) ||
    !(await userCanAccessPage(userId, pageId, client))
  ) {
    throw new RelocateError(403, 'Relocation authority changed while this move was waiting. Reload and try again.');
  }
  if (
    confluenceSpaceKey !== null &&
    !(await getUserAccessibleSpaces(userId, client)).includes(confluenceSpaceKey)
  ) {
    throw new RelocateError(403, 'Access denied to the Confluence space');
  }
}

async function assertCurrentRelocateAuthority(
  intent: PageWriteIntent,
  userId: string,
  pageId: number,
  confluenceSpaceKey: string | null,
): Promise<void> {
  await withPageWriteTransaction(
    intent.pageIds,
    (client) =>
      assertCurrentRelocateAuthorityOnClient(client, userId, pageId, confluenceSpaceKey),
    { intent },
  );
}

type RelocationProviderState = 'original' | 'published_local';

/**
 * Resolve the original actor's provider only at the remote phase boundary.
 *
 * The route-level client is an early credential snapshot used for preflight.
 * A relocation can wait behind admission and filesystem preparation, so every
 * mutation phase must instead pair current authority and page identity with a
 * credential read from the same held database transaction.
 */
async function currentRelocationClient(
  intent: PageWriteIntent,
  prep: RelocationPreparation,
  expectedState: RelocationProviderState,
): Promise<ConfluenceClient> {
  return withPageWriteTransaction(
    intent.pageIds,
    async (client) => {
      const current = await lockAndReload(client, prep.id);
      const identityMatches = expectedState === 'original'
        ? current.source === prep.source &&
          current.confluence_id === prep.confluence_id &&
          current.space_key === prep.space_key
        : current.source === 'standalone' &&
          current.confluence_id === null &&
          current.space_key === prep.targetSpaceKey;
      if (!identityMatches) {
        throw new PageWriteError(
          409,
          'intent_local_evidence_mismatch',
          'The relocation source identity changed before remote dispatch',
        );
      }
      await assertCurrentRelocateAuthorityOnClient(
        client,
        prep.actorId,
        prep.id,
        prep.direction === 'to_confluence' ? prep.targetSpaceKey : prep.space_key,
      );
      const confluence = await getClientForUser(prep.actorId, client);
      if (!confluence) {
        throw new PageWriteError(
          409,
          'intent_actor_credentials_unavailable',
          'The original actor no longer has an active Confluence connection',
        );
      }
      return confluence;
    },
    { intent },
  );
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsePreparedAttachments(value: unknown): RelocationAttachmentPreparation[] {
  if (!Array.isArray(value)) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation attachment preparation is unavailable');
  }
  return value.map((item) => {
    if (
      item === null ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).sourceName !== 'string' ||
      typeof (item as Record<string, unknown>).targetName !== 'string' ||
      typeof (item as Record<string, unknown>).contentType !== 'string' ||
      typeof (item as Record<string, unknown>).size !== 'number' ||
      !Number.isSafeInteger((item as Record<string, unknown>).size) ||
      typeof (item as Record<string, unknown>).sha256 !== 'string' ||
      !canStoreLocalFilename((item as Record<string, unknown>).sourceName as string) ||
      !canStoreLocalFilename((item as Record<string, unknown>).targetName as string)
    ) {
      throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation attachment preparation is malformed');
    }
    const row = item as Record<string, unknown>;
    return {
      sourceName: row.sourceName as string,
      targetName: row.targetName as string,
      contentType: row.contentType as string,
      size: row.size as number,
      sha256: row.sha256 as string,
    };
  });
}

function parsePreparedAces(value: unknown): PageAce[] {
  if (!Array.isArray(value)) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation ACL preparation is unavailable');
  }
  return value.map((item) => {
    if (
      item === null ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).principal_type !== 'string' ||
      typeof (item as Record<string, unknown>).principal_id !== 'string' ||
      typeof (item as Record<string, unknown>).permission !== 'string'
    ) {
      throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation ACL preparation is malformed');
    }
    return item as PageAce;
  });
}

async function persistRelocationPreparation(
  intent: PageWriteIntent,
  input: {
    pageId: number;
    actorId: string;
    direction: 'to_confluence' | 'to_local';
    targetSpaceKey: string | null;
    targetVisibility: 'private' | 'shared' | null;
    attachments: RelocationAttachmentPreparation[];
    expectedRemoteTitleSha256: string;
    expectedRemoteBodyStorageSha256: string;
    parentConfluenceId: string | null;
  },
): Promise<RelocationPreparation> {
  return runPageWriteIntentEffect(
    intent,
    { kind: 'local' },
    () => withPageWriteTransaction(
      intent.pageIds,
      async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
        const page = await lockAndReload(client, input.pageId);
        await assertCurrentRelocateAuthorityOnClient(
          client,
          input.actorId,
          input.pageId,
          input.direction === 'to_confluence' ? input.targetSpaceKey : page.space_key,
        );
        const oldKey = parentKeyFor(page.source, page.id, page.confluence_id);
        const children = await client.query<{ id: number }>(
          'SELECT id FROM pages WHERE parent_id = $1 AND id <> $2 ORDER BY id',
          [oldKey, page.id],
        );
        const aces = await client.query<PageAce>(
          `SELECT principal_type, principal_id, permission
             FROM access_control_entries
            WHERE resource_type = 'page' AND resource_id = $1
            ORDER BY principal_type, principal_id, permission`,
          [page.id],
        );
        const childIds = children.rows.map((row) => row.id);
        await client.query(
          `INSERT INTO page_relocation_preparations (
             intent_id, page_id, direction, actor_id, target_space_key, target_visibility,
             original_source, original_confluence_id, original_space_key, original_title,
             original_body_html, original_body_storage, original_body_text, original_version,
             original_visibility, original_created_by_user_id, original_inherit_perms,
             original_local_modified_at, original_local_modified_by, original_embedding_dirty,
             original_image_analysis_dirty, original_embedding_status, original_embedded_at,
             original_key, child_ids, access_control_entries, attachments,
             expected_remote_title_sha256, expected_remote_body_storage_sha256, parent_confluence_id
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10,
             $11, $12, $13, $14,
             $15, $16, $17,
             $18, $19, $20,
             $21, $22, $23,
             $24, $25, $26::jsonb, $27::jsonb,
             $28, $29, $30
           )`,
          [
            intent.id,
            page.id,
            input.direction,
            input.actorId,
            input.targetSpaceKey,
            input.targetVisibility,
            page.source,
            page.confluence_id,
            page.space_key,
            page.title,
            page.body_html,
            page.body_storage,
            page.body_text,
            page.version,
            page.visibility,
            page.created_by_user_id,
            page.inherit_perms,
            page.local_modified_at,
            page.local_modified_by,
            page.embedding_dirty,
            page.image_analysis_dirty,
            page.embedding_status,
            page.embedded_at,
            oldKey,
            childIds,
            JSON.stringify(aces.rows),
            JSON.stringify(input.attachments),
            input.expectedRemoteTitleSha256,
            input.expectedRemoteBodyStorageSha256,
            input.parentConfluenceId,
          ],
        );
        return {
          ...page,
          intentId: intent.id,
          direction: input.direction,
          actorId: input.actorId,
          targetSpaceKey: input.targetSpaceKey,
          targetVisibility: input.targetVisibility,
          attachments: input.attachments,
          expectedRemoteTitleSha256: input.expectedRemoteTitleSha256,
          expectedRemoteBodyStorageSha256: input.expectedRemoteBodyStorageSha256,
          parentConfluenceId: input.parentConfluenceId,
          createdConfluenceId: null,
          createdPageReceipt: null,
          attachmentReceipts: [],
          childIds,
          oldKey,
          aces: aces.rows,
        };
      },
      { intent },
    ),
  );
}

async function loadRelocationPreparation(
  client: PoolClient,
  intent: { id: string; pageIds: number[]; actorId: string | null },
): Promise<RelocationPreparation> {
  const result = await client.query<{
    intent_id: string;
    page_id: number;
    direction: 'to_confluence' | 'to_local';
    actor_id: string;
    target_space_key: string | null;
    target_visibility: 'private' | 'shared' | null;
    original_source: string;
    original_confluence_id: string | null;
    original_space_key: string | null;
    original_title: string;
    original_body_html: string | null;
    original_body_storage: string | null;
    original_body_text: string | null;
    original_version: number;
    original_visibility: string;
    original_created_by_user_id: string | null;
    original_inherit_perms: boolean;
    original_local_modified_at: Date | null;
    original_local_modified_by: string | null;
    original_embedding_dirty: boolean;
    original_image_analysis_dirty: boolean;
    original_embedding_status: string | null;
    original_embedded_at: Date | null;
    original_key: string;
    child_ids: number[];
    access_control_entries: unknown;
    attachments: unknown;
    expected_remote_title_sha256: string;
    expected_remote_body_storage_sha256: string;
    parent_confluence_id: string | null;
    created_confluence_id: string | null;
    created_page_receipt: unknown;
    attachment_receipts: unknown;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT prep.*, p.content_revision::text, p.lifecycle_revision::text
       FROM page_relocation_preparations prep
       JOIN pages p ON p.id = prep.page_id
      WHERE prep.intent_id = $1
      FOR UPDATE OF prep`,
    [intent.id],
  );
  const row = result.rows[0];
  if (
    !row ||
    (intent.actorId !== null && row.actor_id !== intent.actorId) ||
    !intent.pageIds.includes(row.page_id) ||
    (row.direction !== 'to_confluence' && row.direction !== 'to_local')
  ) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation preparation identity is unavailable');
  }
  let createdPageReceipt: RemotePageReceipt | null = null;
  let attachmentReceipts: ProviderAttachmentReceipt[];
  try {
    if (row.created_page_receipt !== null) {
      createdPageReceipt = parseRemotePageReceipt(row.created_page_receipt);
    }
    attachmentReceipts = parseAttachmentReceipts(row.attachment_receipts);
  } catch {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation provider progress is malformed');
  }
  return {
    id: row.page_id,
    title: row.original_title,
    source: row.original_source,
    space_key: row.original_space_key,
    confluence_id: row.original_confluence_id,
    visibility: row.original_visibility,
    created_by_user_id: row.original_created_by_user_id,
    body_html: row.original_body_html,
    body_storage: row.original_body_storage,
    body_text: row.original_body_text,
    version: row.original_version,
    inherit_perms: row.original_inherit_perms,
    local_modified_at: row.original_local_modified_at,
    local_modified_by: row.original_local_modified_by,
    content_revision: row.content_revision,
    lifecycle_revision: row.lifecycle_revision,
    embedding_dirty: row.original_embedding_dirty,
    image_analysis_dirty: row.original_image_analysis_dirty,
    embedding_status: row.original_embedding_status,
    embedded_at: row.original_embedded_at,
    intentId: row.intent_id,
    direction: row.direction,
    actorId: row.actor_id,
    targetSpaceKey: row.target_space_key,
    targetVisibility: row.target_visibility,
    attachments: parsePreparedAttachments(row.attachments),
    expectedRemoteTitleSha256: row.expected_remote_title_sha256,
    expectedRemoteBodyStorageSha256: row.expected_remote_body_storage_sha256,
    parentConfluenceId: row.parent_confluence_id,
    createdConfluenceId: row.created_confluence_id,
    createdPageReceipt,
    attachmentReceipts,
    childIds: row.child_ids,
    oldKey: row.original_key,
    aces: parsePreparedAces(row.access_control_entries),
  };
}

function attachmentReceipt(value: unknown): ProviderAttachmentReceipt {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const version = typeof record.version === 'number'
    ? record.version
    : record.version !== null && typeof record.version === 'object'
      ? (record.version as Record<string, unknown>).number
      : null;
  const extensions = record.extensions !== null && typeof record.extensions === 'object'
    ? record.extensions as Record<string, unknown>
    : {};
  const metadata = record.metadata !== null && typeof record.metadata === 'object'
    ? record.metadata as Record<string, unknown>
    : {};
  const mediaType = typeof record.mediaType === 'string'
    ? record.mediaType
    : typeof metadata.mediaType === 'string' ? metadata.mediaType : null;
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    record.id.length > 1000 ||
    typeof record.title !== 'string' ||
    record.title.length === 0 ||
    record.title.length > 1000 ||
    (mediaType !== null && mediaType.length > 255) ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new RelocateError(502, 'Confluence did not return a versioned attachment identity');
  }
  return {
    id: record.id,
    title: record.title,
    version,
    mediaType,
    fileSize: typeof record.fileSize === 'number' &&
        Number.isSafeInteger(record.fileSize) &&
        record.fileSize >= 0
      ? record.fileSize
      : typeof extensions.fileSize === 'number' &&
          Number.isSafeInteger(extensions.fileSize) &&
          extensions.fileSize >= 0
        ? extensions.fileSize
        : null,
  };
}

/** Fixed fields and framed entries preserve order independently of JSONB key order. */
function attachmentReceiptsDigest(receipts: readonly ProviderAttachmentReceipt[]): string {
  const digest = createHash('sha256');
  for (const receipt of receipts) {
    digest.update(JSON.stringify([
      receipt.id, receipt.title, receipt.version, receipt.mediaType, receipt.fileSize,
    ]));
    digest.update('\n');
  }
  return digest.digest('hex');
}

function remotePageReceipt(value: unknown): RemotePageReceipt {
  const page = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const version = page.version !== null && typeof page.version === 'object'
    ? (page.version as Record<string, unknown>).number
    : null;
  const body = page.body !== null && typeof page.body === 'object'
    ? page.body as Record<string, unknown>
    : {};
  const storage = body.storage !== null && typeof body.storage === 'object'
    ? (body.storage as Record<string, unknown>).value
    : null;
  if (
    typeof page.id !== 'string' ||
    page.id.length === 0 ||
    typeof page.title !== 'string' ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof storage !== 'string'
  ) {
    throw new RelocateError(502, 'Confluence did not return an exact page identity');
  }
  return {
    id: page.id,
    version,
    titleSha256: sha256(page.title),
    bodyStorageSha256: sha256(storage),
  };
}

function parseRemotePageReceipt(value: unknown): RemotePageReceipt {
  const row = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    typeof row.version !== 'number' ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    typeof row.titleSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.titleSha256) ||
    typeof row.bodyStorageSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.bodyStorageSha256)
  ) {
    throw new PageWriteError(409, 'intent_terminal_result_invalid', 'Relocation page receipt is incomplete');
  }
  return row as unknown as RemotePageReceipt;
}

function parseAttachmentReceipts(value: unknown): ProviderAttachmentReceipt[] {
  if (!Array.isArray(value)) {
    throw new PageWriteError(409, 'intent_terminal_result_invalid', 'Relocation attachment receipts are incomplete');
  }
  try {
    return value.map(attachmentReceipt);
  } catch {
    throw new PageWriteError(409, 'intent_terminal_result_invalid', 'Relocation attachment receipts are malformed');
  }
}

async function recordRelocationCreate(
  intent: PageWriteIntent,
  confluenceId: string,
  receipt: RemotePageReceipt | null,
): Promise<void> {
  await advancePageWriteIntent(intent, async (client) => {
    const updated = await client.query(
      `UPDATE page_relocation_preparations
          SET created_confluence_id = $2,
              created_page_receipt = COALESCE(created_page_receipt, $3::jsonb)
        WHERE intent_id = $1
          AND direction = 'to_confluence'
          AND (created_confluence_id IS NULL OR created_confluence_id = $2)
          AND (
            created_page_receipt IS NULL
            OR $3::jsonb IS NULL
            OR created_page_receipt = $3::jsonb
          )`,
      [intent.id, confluenceId, receipt === null ? null : JSON.stringify(receipt)],
    );
    if (updated.rowCount !== 1) {
      throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation create progress could not be recorded exactly once');
    }
  });
}

async function recordRelocationAttachment(
  intent: PageWriteIntent,
  confluenceId: string,
  receiptIndex: number,
  receipt: ProviderAttachmentReceipt,
): Promise<void> {
  await advancePageWriteIntent(intent, async (client) => {
    const updated = await client.query(
      `UPDATE page_relocation_preparations
          SET attachment_receipts =
                attachment_receipts || jsonb_build_array($4::jsonb)
        WHERE intent_id = $1
          AND direction = 'to_confluence'
          AND created_confluence_id = $2
          AND jsonb_array_length(attachment_receipts) = $3`,
      [intent.id, confluenceId, receiptIndex, JSON.stringify(receipt)],
    );
    if (updated.rowCount !== 1) {
      throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation attachment progress could not be recorded in order');
    }
  });
}


async function verifyCreatedProviderState(
  confluence: ConfluenceClient,
  createdConfluenceId: string,
  exactPageReceipt: RemotePageReceipt | null,
  expectedTitleSha256: string,
  expectedBodyStorageSha256: string,
  requiredAttachments: ProviderAttachmentReceipt[],
  expectedParentId: string | null,
): Promise<{
  pageReceipt: RemotePageReceipt;
  observed: { title: string; bodyStorage: string; version: number };
}> {
  let page;
  let attachments;
  try {
    [page, attachments] = await Promise.all([
      confluence.getPage(createdConfluenceId),
      confluence.getPageAttachments(createdConfluenceId),
    ]);
  } catch (error) {
    throw new PageWriteError(409, 'intent_provider_state_unavailable', `The relocated Confluence page could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  let observedPageReceipt: RemotePageReceipt;
  try {
    observedPageReceipt = remotePageReceipt(page);
  } catch {
    throw new PageWriteError(409, 'intent_provider_state_unavailable', 'The relocated Confluence page identity could not be read');
  }
  const bodyStorage = page.body?.storage?.value;
  const observedParentId = page.ancestors?.at(-1)?.id ?? null;
  if (
    observedPageReceipt.id !== createdConfluenceId ||
    page.status === 'trashed' ||
    typeof page.title !== 'string' ||
    typeof bodyStorage !== 'string' ||
    observedPageReceipt.titleSha256 !== expectedTitleSha256 ||
    observedPageReceipt.bodyStorageSha256 !== expectedBodyStorageSha256 ||
    observedParentId !== expectedParentId ||
    (exactPageReceipt !== null && (
      observedPageReceipt.id !== exactPageReceipt.id ||
      observedPageReceipt.version !== exactPageReceipt.version ||
      observedPageReceipt.titleSha256 !== exactPageReceipt.titleSha256 ||
      observedPageReceipt.bodyStorageSha256 !== exactPageReceipt.bodyStorageSha256
    ))
  ) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The relocated Confluence page no longer matches its creation receipt');
  }
  let observedAttachments: ProviderAttachmentReceipt[];
  try {
    observedAttachments = attachments.results.map(attachmentReceipt);
  } catch {
    throw new PageWriteError(409, 'intent_provider_state_unavailable', 'The relocated Confluence attachment identities could not be read');
  }
  const expectedAttachments = [...requiredAttachments].sort((a, b) => a.id.localeCompare(b.id));
  observedAttachments.sort((a, b) => a.id.localeCompare(b.id));
  if (
    observedAttachments.length !== expectedAttachments.length ||
    observedAttachments.some((item, index) => {
      const wanted = expectedAttachments[index];
      return !wanted ||
        item.id !== wanted.id ||
        item.title !== wanted.title ||
        item.version !== wanted.version ||
        item.mediaType !== wanted.mediaType ||
        item.fileSize !== wanted.fileSize;
    })
  ) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The relocated Confluence attachments no longer match their upload receipts');
  }
  return {
    pageReceipt: observedPageReceipt,
    observed: {
      title: page.title,
      bodyStorage,
      version: observedPageReceipt.version,
    },
  };
}

async function readPreparedAttachmentBytes(
  prep: RelocationPreparation,
  attachment: RelocationAttachmentPreparation,
  destinationConfluenceId?: string,
): Promise<Buffer> {
  const candidates: Array<() => Promise<Buffer | null>> = [];
  if (destinationConfluenceId) {
    candidates.push(() => readCachedAttachmentFile(destinationConfluenceId, attachment.targetName));
  }
  candidates.push(() => readCachedAttachmentFile(prep.oldKey, attachment.sourceName));
  candidates.push(async () => {
    try {
      return await fs.readFile(`${localAttachmentsDir(prep.id)}/${attachment.sourceName}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  });
  for (const readCandidate of candidates) {
    const bytes = await readCandidate();
    if (bytes && bytes.length === attachment.size && sha256(bytes) === attachment.sha256) return bytes;
  }
  throw new PageWriteError(409, 'intent_local_evidence_mismatch', `Prepared attachment "${attachment.sourceName}" is missing or changed`);
}

async function removePreparedLocalFilesVerified(
  prep: RelocationPreparation,
): Promise<void> {
  const directory = localAttachmentsDir(prep.id);
  for (const attachment of prep.attachments) {
    await fs.rm(`${directory}/${attachment.targetName}`, { force: true });
  }
  try {
    await fs.rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
}

async function deleteRelocationPreparation(client: PoolClient, intentId: string): Promise<void> {
  const deleted = await client.query(
    'DELETE FROM page_relocation_preparations WHERE intent_id = $1',
    [intentId],
  );
  if (deleted.rowCount !== 1) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation preparation was not removed exactly once');
  }
}

/**
 * The refusal a relocate owes an attachment it cannot read.
 *
 * The stores distinguish an ABSENT file (`null` — a warning on the response,
 * the rest of the move proceeds) from one that is there and cannot be read
 * (`EACCES`, `EIO`, …: a throw). The second is actionable — fix the
 * permissions and retry — but as a bare `Error` it reached the route as an
 * opaque 500 with its message masked by the error handler, so it told the
 * mover nothing at all (#1626 review r3). The route already speaks
 * `RelocateError`, and this is the same refusal as the unstorable-filename
 * one above it: the move is declined, nothing has changed.
 */
class AttachmentReadError extends Error {
  constructor(public readonly cause: unknown) {
    super('attachment bytes could not be read');
    this.name = 'AttachmentReadError';
  }
}

function unreadableAttachmentError(filename: string, cause: unknown): RelocateError {
  logger.error({ err: cause, filename }, 'Relocate refused: an attachment could not be read');
  return new RelocateError(
    400,
    `Attachment "${filename}" cannot be moved: its bytes could not be read from the attachment ` +
      `store. Check the file's permissions on the server, then try again.`,
  );
}

/**
 * Read an attachment's bytes from whichever store currently holds it.
 *
 * Symmetric across the two stores: an ABSENT file answers `null` (reported as
 * a warning, the rest of the move proceeds), while a file that is there and
 * cannot be read THROWS and aborts the move. The cached reader draws that
 * line in the store itself; the local fallback used to swallow everything, so
 * a standalone page's `EACCES`-locked file was silently left behind under
 * "missing on disk; it was not published" (#1626 review r3).
 */
async function readAttachmentBytes(
  page: { id: number; source: string; confluence_id: string | null },
  filename: string,
): Promise<Buffer | null> {
  let cached: Buffer | null;
  try {
    cached = await readCachedAttachmentFile(
      parentKeyFor(page.source, page.id, page.confluence_id),
      filename,
    );
  } catch (err) {
    throw new AttachmentReadError(err);
  }
  if (cached) return cached;
  if (page.source !== 'standalone') return null;
  // Deliberately OUTSIDE the read wrapper: this is a database query, and a
  // Postgres fault here is not a file the mover can chmod (#1626 review r4).
  const row = (await listLocalAttachmentsForRelocate(page.id)).find((r) => r.filename === filename);
  // A null path is a row whose filename the store would refuse — unreadable by
  // definition, and reported to the caller as a missing file (#1169).
  if (!row || row.path === null) return null;
  try {
    return await fs.readFile(row.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AttachmentReadError(err);
  }
}

/**
 * Remove a Confluence-cache namespace without the legacy best-effort ambiguity.
 * Relocation may settle only after a later filesystem mutation is known to
 * have completed; the shared helper intentionally swallows `fs.rm` failures.
 */
async function removeAttachmentDirectoryVerified(pageKey: string): Promise<void> {
  await fs.rm(attachmentCacheDir(pageKey), { recursive: true, force: true });
}

/**
 * Take the page row for update inside the caller's transaction, re-reading it
 * under both the advisory lock and a row lock so nothing observed during the
 * pre-checks can have changed underneath.
 */
async function lockAndReload(txClient: PoolClient, pageId: number): Promise<RelocatablePage> {
  await txClient.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
  const fresh = await txClient.query<RelocatablePage>(
    `SELECT ${RELOCATABLE_COLUMNS} FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [pageId],
  );
  const row = fresh.rows[0];
  if (!row) throw new RelocateError(404, 'Page not found');
  return row;
}

/**
 * Resolve the Confluence id of a page's parent, if the parent is itself a
 * Confluence page. A standalone parent has no upstream counterpart, so the
 * relocated page is created at the target space's root.
 */
async function resolveConfluenceParent(pageId: number): Promise<string | null> {
  const res = await query<{ confluence_id: string | null }>(
    `SELECT parent.confluence_id
       FROM pages child
       JOIN pages parent
         ON (parent.confluence_id = child.parent_id OR parent.id::text = child.parent_id)
      WHERE child.id = $1 AND parent.deleted_at IS NULL AND parent.confluence_id IS NOT NULL
      LIMIT 1`,
    [pageId],
  );
  return res.rows[0]?.confluence_id ?? null;
}

async function publishToConfluenceOnClient(
  client: PoolClient,
  intentId: string,
  prep: RelocationPreparation,
  confluenceId: string,
  observed: { title: string; bodyStorage: string; version: number },
  userId: string,
  warnings: string[],
): Promise<RelocatePageResponse> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
  await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
  const fresh = await lockAndReload(client, prep.id);
  if (
    fresh.source !== prep.source ||
    fresh.confluence_id !== prep.confluence_id ||
    fresh.space_key !== prep.space_key
  ) {
    throw new PageWriteError(409, 'intent_local_evidence_mismatch', 'The local relocation source changed before publication');
  }
  await assertIdentifierUnambiguous(prep.oldKey, prep.id, 'current', client);
  await assertIdentifierUnambiguous(confluenceId, prep.id, 'new Confluence', client);
  await assertCurrentRelocateAuthorityOnClient(client, userId, prep.id, prep.targetSpaceKey);

  await withLocalAttachmentMutationLock(async () => {
    for (const attachment of prep.attachments) {
      const bytes = await readPreparedAttachmentBytes(prep, attachment, confluenceId);
      await writeAttachmentCacheAt(confluenceId, attachment.targetName, bytes);
    }
  }, client);

  const finalHtml = confluenceToHtml(observed.bodyStorage, confluenceId, prep.targetSpaceKey ?? '');
  const finalText = htmlToText(finalHtml);
  await client.query(
    `UPDATE pages SET
       title = $2,
       source = 'confluence',
       confluence_id = $3,
       space_key = $4,
       body_html = $5,
       body_storage = $6,
       body_text = $7,
       visibility = 'shared',
       version = $8,
       last_synced = NOW(),
       embedding_dirty = TRUE,
       image_analysis_dirty = TRUE,
       embedding_status = 'not_embedded',
       embedded_at = NULL
     WHERE id = $1`,
    [
      prep.id,
      observed.title,
      confluenceId,
      prep.targetSpaceKey,
      finalHtml,
      observed.bodyStorage,
      finalText,
      observed.version,
    ],
  );
  await invalidateCollabDocAfterBodyWrite(prep.id, client);
  let childrenRepointed = 0;
  if (prep.childIds.length > 0) {
    const repointed = await client.query(
      'UPDATE pages SET parent_id = $1 WHERE id = ANY($2::int[]) AND parent_id = $3',
      [confluenceId, prep.childIds, prep.oldKey],
    );
    childrenRepointed = repointed.rowCount ?? 0;
    if (childrenRepointed !== prep.childIds.length) {
      throw new PageWriteError(409, 'intent_local_evidence_mismatch', 'A prepared child link changed before relocation publication');
    }
  }
  const discarded = await client.query(
    `DELETE FROM page_versions pv
      WHERE pv.page_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM page_baselines baseline WHERE baseline.version_snapshot_id = pv.id
        )`,
    [prep.id],
  );
  await client.query('DELETE FROM local_attachments WHERE page_id = $1', [prep.id]);
  await enqueuePageWriteInvalidation(client, intentId);

  await withLocalAttachmentMutationLock(async (lockClient) => {
    if (confluenceId !== prep.oldKey) {
      await removeAttachmentDirectoryVerified(prep.oldKey);
    }
    await removeLocalAttachmentDirectory(prep.id, lockClient);
  }, client);

  return {
    pageId: prep.id,
    source: 'confluence',
    spaceKey: prep.targetSpaceKey,
    confluenceId,
    childrenRepointed,
    versionsDiscarded: discarded.rowCount ?? 0,
    attachmentsMigrated: prep.attachments.length,
    upstreamDeleted: false,
    warnings,
  };
}

/** Move a standalone article into Confluence. */
async function relocateToConfluence(opts: {
  page: RelocatablePage;
  userId: string;
  spaceKey: string;
  expectedVersionCount: number;
}): Promise<RelocatePageResponse> {
  const { page, userId, spaceKey } = opts;
  const oldKey = String(page.id);
  const warnings: string[] = [];

  await assertIdentifierUnambiguous(oldKey, page.id, 'current');
  const versionCount = await countLocalVersions(page.id);
  if (versionCount !== opts.expectedVersionCount) {
    throw new RelocateError(
      409,
      `Version count changed: ${versionCount} local version(s) would be discarded, but the ` +
        `confirmation acknowledged ${opts.expectedVersionCount}. Reload and confirm again.`,
      { localVersionCount: versionCount },
    );
  }

  const { html: normalisedHtml, refs } = rewriteAttachmentRefs(
    page.body_html ?? '',
    [`/api/attachments/${encodeURIComponent(oldKey)}/`, `/api/local-attachments/${page.id}/`],
    `/api/attachments/${encodeURIComponent(oldKey)}/`,
    true,
  );
  const storageBody = htmlToConfluence(normalisedHtml);
  const targetByLocal = new Map(refs.map((ref) => [ref.local, ref.target]));
  const payloads: Array<RelocationAttachmentPreparation & { data: Buffer }> = [];
  const claimedTargets = new Map<string, string>();
  const collisions: string[] = [];
  for (const sourceName of await collectAttachmentFilenames(page)) {
    if (!isStorableAttachmentFilename(sourceName) || !canStoreLocalFilename(sourceName)) {
      throw new RelocateError(
        400,
        `Attachment "${sourceName}" cannot be moved: its filename is not one the attachment stores accept. Remove or rename it, then try again.`,
      );
    }
    let data: Buffer | null;
    try {
      data = await readAttachmentBytes(page, sourceName);
    } catch (error) {
      if (error instanceof AttachmentReadError) throw unreadableAttachmentError(sourceName, error.cause);
      throw error;
    }
    if (data === null) {
      warnings.push(`Attachment "${sourceName}" is referenced but missing on disk; it was not published.`);
      continue;
    }
    const targetName = targetByLocal.get(sourceName) ?? sourceName;
    const previous = claimedTargets.get(targetName);
    if (previous !== undefined && previous !== sourceName) {
      collisions.push(`"${previous}" and "${sourceName}" both publish as "${targetName}"`);
    }
    claimedTargets.set(targetName, sourceName);
    payloads.push({
      sourceName,
      targetName,
      data,
      contentType: getMimeType(targetName),
      size: data.length,
      sha256: sha256(data),
    });
  }
  if (collisions.length > 0) {
    throw new RelocateError(
      409,
      `Cannot relocate: ${collisions.join('; ')}. A Confluence page can hold only one attachment ` +
        `per filename, so one image would be silently replaced by the other. Rename or remove the ` +
        `duplicate reference and try again.`,
      { collisions },
    );
  }

  const parentConfluenceId = await resolveConfluenceParent(page.id);
  const intent = await reserveRelocateIntent({
    page,
    userId,
    target: 'confluence',
    targetSpaceKey: spaceKey,
  });
  try {
    await assertCurrentRelocateAuthority(intent, userId, page.id, spaceKey);
  } catch (error) {
    await cancelPageWriteIntentBeforeEffect(intent);
    throw error;
  }
  const prep = await persistRelocationPreparation(intent, {
    pageId: page.id,
    actorId: userId,
    direction: 'to_confluence',
    targetSpaceKey: spaceKey,
    targetVisibility: null,
    attachments: payloads.map(({ data: _data, ...descriptor }) => descriptor),
    expectedRemoteTitleSha256: sha256(page.title),
    expectedRemoteBodyStorageSha256: sha256(storageBody),
    parentConfluenceId,
  });

  // Preparation is already a durable local phase. A refusal after this point
  // must remain pending so recovery can remove the retained snapshot from
  // no-remote-start evidence; cancelling it would orphan the restrictive FK.
  const remoteClient = await runPageWriteIntentEffect(
    intent,
    { kind: 'local' },
    () => currentRelocationClient(intent, prep, 'original'),
  );

  type RemoteOutcome = {
    kind: 'committed';
    createdConfluenceId: string;
    page: RemotePageReceipt | null;
    attachments: ProviderAttachmentReceipt[];
  };

  const remote = await runPageWriteIntentEffect(
    intent,
    {
      kind: 'remote',
      completesRemoteWork: true,
      terminalResult: (result: RemoteOutcome) => ({
        outcome: result.kind,
        pageId: page.id,
        createdConfluenceId: result.createdConfluenceId,
        page: result.page,
        attachmentCount: result.attachments.length,
        attachmentReceiptsSha256: attachmentReceiptsDigest(result.attachments),
      }),
    },
    async (): Promise<RemoteOutcome> => {
      const created = await remoteClient.createPage(
        spaceKey,
        page.title,
        storageBody,
        parentConfluenceId ?? undefined,
      );
      const newConfluenceId = typeof created.id === 'string' && created.id.length > 0
        ? created.id
        : null;
      if (newConfluenceId === null) {
        throw new RelocateError(502, 'Confluence created a page without returning its identity');
      }

      // This is the first fallible local step after the acknowledged create.
      // A process/DB failure between the HTTP response and this commit is the
      // inherent durability gap; once it returns, every later phase retains the
      // operation-owned provider identity and never compensates it away.
      await recordRelocationCreate(intent, newConfluenceId, null);
      prep.createdConfluenceId = newConfluenceId;

      let createdReceipt: RemotePageReceipt | null = null;
      try {
        createdReceipt = remotePageReceipt(created);
      } catch {
        // Compact create responses are read back below only when attachment
        // mutations remain. With none, the acknowledged id is already the
        // terminal provider receipt and read-only verification happens after
        // the remote phase has durably completed.
      }
      if (createdReceipt !== null) {
        await recordRelocationCreate(intent, newConfluenceId, createdReceipt);
        prep.createdPageReceipt = createdReceipt;
      }
      if (payloads.length === 0) {
        return {
          kind: 'committed',
          createdConfluenceId: newConfluenceId,
          page: createdReceipt,
          attachments: [],
        };
      }
      if (createdReceipt === null) {
        const readbackClient = await currentRelocationClient(intent, prep, 'original');
        createdReceipt = remotePageReceipt(await readbackClient.getPage(newConfluenceId));
        await recordRelocationCreate(intent, newConfluenceId, createdReceipt);
        prep.createdPageReceipt = createdReceipt;
      }
      if (
        createdReceipt.titleSha256 !== prep.expectedRemoteTitleSha256 ||
        createdReceipt.bodyStorageSha256 !== prep.expectedRemoteBodyStorageSha256
      ) {
        throw new RelocateError(502, 'Confluence created a page whose content does not match the admitted relocation');
      }
      await assertIdentifierUnambiguous(newConfluenceId, page.id, 'new Confluence');

      const attachmentReceipts = prep.attachmentReceipts;
      for (const payload of payloads) {
        const attachmentClient = await currentRelocationClient(intent, prep, 'original');
        const uploaded = await attachmentClient.updateAttachment(
          newConfluenceId,
          payload.targetName,
          payload.data,
          payload.contentType,
        );
        const receipt = attachmentReceipt(uploaded);
        await recordRelocationAttachment(
          intent,
          newConfluenceId,
          attachmentReceipts.length,
          receipt,
        );
        attachmentReceipts.push(receipt);
        if (receipt.title !== payload.targetName) {
          throw new RelocateError(502, 'Confluence returned an attachment identity for a different filename');
        }
      }
      return {
        kind: 'committed',
        createdConfluenceId: newConfluenceId,
        page: createdReceipt,
        attachments: attachmentReceipts,
      };
    },
  );

  let createdReceipt = remote.page;
  if (createdReceipt === null) {
    const readbackClient = await currentRelocationClient(intent, prep, 'original');
    createdReceipt = remotePageReceipt(await readbackClient.getPage(remote.createdConfluenceId));
    await recordRelocationCreate(intent, remote.createdConfluenceId, createdReceipt);
    prep.createdPageReceipt = createdReceipt;
  }
  if (
    createdReceipt.titleSha256 !== prep.expectedRemoteTitleSha256 ||
    createdReceipt.bodyStorageSha256 !== prep.expectedRemoteBodyStorageSha256
  ) {
    throw new RelocateError(502, 'Confluence created a page whose content does not match the admitted relocation');
  }
  await assertIdentifierUnambiguous(remote.createdConfluenceId, page.id, 'new Confluence');
  const observed = {
    title: page.title,
    bodyStorage: storageBody,
    version: createdReceipt.version,
  };
  const result = await runPageWriteIntentEffect(
    intent,
    { kind: 'local' },
    () => advancePageWriteIntent(intent, (txClient) =>
      publishToConfluenceOnClient(
        txClient,
        intent.id,
        prep,
        remote.createdConfluenceId,
        observed,
        userId,
        warnings,
      ),
    ),
  );
  await completePageWriteIntent(intent, (txClient) =>
    deleteRelocationPreparation(txClient, intent.id),
  );
  return result;
}

async function publishToLocalOnClient(
  client: PoolClient,
  intentId: string,
  prep: RelocationPreparation,
): Promise<RelocatePageResponse> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
  await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
  const fresh = await lockAndReload(client, prep.id);
  if (
    fresh.source !== prep.source ||
    fresh.confluence_id !== prep.confluence_id ||
    fresh.space_key !== prep.space_key
  ) {
    throw new PageWriteError(409, 'intent_local_evidence_mismatch', 'The local relocation source changed before publication');
  }
  await assertIdentifierUnambiguous(prep.oldKey, prep.id, 'current', client);
  await assertIdentifierUnambiguous(String(prep.id), prep.id, 'new local', client);
  await assertCurrentRelocateAuthorityOnClient(client, prep.actorId, prep.id, prep.space_key);

  await withLocalAttachmentMutationLock(async (lockClient) => {
    for (const attachment of prep.attachments) {
      const bytes = await readPreparedAttachmentBytes(prep, attachment);
      await writeLocalAttachmentFileForRelocate(prep.id, attachment.targetName, bytes, lockClient);
    }
  }, client);
  const { html: rewrittenHtml } = rewriteAttachmentRefs(
    prep.body_html ?? '',
    [`/api/attachments/${encodeURIComponent(prep.oldKey)}/`],
    `/api/local-attachments/${prep.id}/`,
    false,
  );
  await client.query(
    `UPDATE pages SET
       source = 'standalone',
       confluence_id = NULL,
       space_key = $2,
       visibility = $3,
       created_by_user_id = $4,
       body_html = $5,
       inherit_perms = TRUE,
       embedding_dirty = TRUE,
       image_analysis_dirty = TRUE,
       embedding_status = 'not_embedded',
       embedded_at = NULL,
       local_modified_at = NOW(),
       local_modified_by = $4
     WHERE id = $1`,
    [prep.id, prep.targetSpaceKey, prep.targetVisibility, prep.actorId, rewrittenHtml],
  );
  await invalidateCollabDocAfterBodyWrite(prep.id, client);
  await client.query(
    "DELETE FROM access_control_entries WHERE resource_type = 'page' AND resource_id = $1",
    [prep.id],
  );
  let childrenRepointed = 0;
  if (prep.childIds.length > 0) {
    const repointed = await client.query(
      'UPDATE pages SET parent_id = $1 WHERE id = ANY($2::int[]) AND parent_id = $3',
      [String(prep.id), prep.childIds, prep.oldKey],
    );
    childrenRepointed = repointed.rowCount ?? 0;
    if (childrenRepointed !== prep.childIds.length) {
      throw new PageWriteError(409, 'intent_local_evidence_mismatch', 'A prepared child link changed before relocation publication');
    }
  }
  for (const attachment of prep.attachments) {
    await client.query(
      `INSERT INTO local_attachments (page_id, filename, content_type, size_bytes, sha256, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (page_id, filename) DO UPDATE SET
         content_type = EXCLUDED.content_type,
         size_bytes = EXCLUDED.size_bytes,
         sha256 = EXCLUDED.sha256,
         updated_at = NOW()`,
      [
        prep.id,
        attachment.targetName,
        attachment.contentType,
        attachment.size,
        attachment.sha256,
        prep.actorId,
      ],
    );
  }
  await enqueuePageWriteInvalidation(client, intentId);
  return {
    pageId: prep.id,
    source: 'standalone',
    spaceKey: prep.targetSpaceKey,
    confluenceId: null,
    childrenRepointed,
    versionsDiscarded: 0,
    attachmentsMigrated: prep.attachments.length,
    upstreamDeleted: true,
    warnings: [],
  };
}

async function restorePreMoveStateOnClient(
  client: PoolClient,
  prep: RelocationPreparation,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
  await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
  const current = await lockAndReload(client, prep.id);
  const isOriginal =
    current.source === prep.source &&
    current.confluence_id === prep.confluence_id &&
    current.space_key === prep.space_key;
  const isPreparedLocal =
    prep.direction === 'to_local' &&
    current.source === 'standalone' &&
    current.confluence_id === null &&
    current.space_key === prep.targetSpaceKey;
  if (!isOriginal && !isPreparedLocal) {
    throw new PageWriteError(409, 'intent_local_evidence_mismatch', 'The local relocation state cannot be restored exactly');
  }
  if (!isOriginal) {
    // The relocation publication removes every page ACE.  A later grant is
    // therefore evidence that the ACL changed after cutover, not stale state
    // that compensation may overwrite.  The admin ACE routes use direct
    // INSERT/DELETE statements without a page lock, so take a relation lock:
    // it waits for their ROW EXCLUSIVE locks and prevents a new grant/revoke
    // between this exact-state check and the snapshot restoration.
    await client.query('LOCK TABLE access_control_entries IN SHARE ROW EXCLUSIVE MODE');
    const currentAces = await client.query<PageAce>(
      `SELECT principal_type, principal_id, permission
         FROM access_control_entries
        WHERE resource_type = 'page' AND resource_id = $1
        ORDER BY principal_type, principal_id, permission`,
      [prep.id],
    );
    if (currentAces.rows.length !== 0) {
      throw new PageWriteError(
        409,
        'intent_local_evidence_mismatch',
        'The page access controls changed after relocation publication',
      );
    }
    await client.query(
      `UPDATE pages SET
         title = $2,
         source = $3,
         confluence_id = $4,
         space_key = $5,
         visibility = $6,
         created_by_user_id = $7,
         body_html = $8,
         body_storage = $9,
         body_text = $10,
         version = $11,
         inherit_perms = $12,
         local_modified_at = $13,
         local_modified_by = $14,
         embedding_dirty = $15,
         image_analysis_dirty = $16,
         embedding_status = $17,
         embedded_at = $18
       WHERE id = $1`,
      [
        prep.id,
        prep.title,
        prep.source,
        prep.confluence_id,
        prep.space_key,
        prep.visibility,
        prep.created_by_user_id,
        prep.body_html,
        prep.body_storage,
        prep.body_text,
        prep.version,
        prep.inherit_perms,
        prep.local_modified_at,
        prep.local_modified_by,
        prep.embedding_dirty,
        prep.image_analysis_dirty,
        prep.embedding_status,
        prep.embedded_at,
      ],
    );
    await invalidateCollabDocAfterBodyWrite(prep.id, client);
    for (const ace of prep.aces) {
      await client.query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, $2, $3, $4)`,
        [prep.id, ace.principal_type, ace.principal_id, ace.permission],
      );
    }
  }
  if (prep.childIds.length > 0) {
    const restored = await client.query(
      `UPDATE pages
          SET parent_id = $1
        WHERE id = ANY($2::int[])
          AND parent_id = ANY($3::text[])`,
      [prep.oldKey, prep.childIds, [prep.oldKey, String(prep.id)]],
    );
    if ((restored.rowCount ?? 0) !== prep.childIds.length) {
      throw new PageWriteError(409, 'intent_local_evidence_mismatch', 'A prepared child link cannot be restored exactly');
    }
  }
  if (prep.attachments.length > 0) {
    await client.query(
      'DELETE FROM local_attachments WHERE page_id = $1 AND filename = ANY($2::text[])',
      [prep.id, prep.attachments.map((attachment) => attachment.targetName)],
    );
    await withLocalAttachmentMutationLock(
      () => removePreparedLocalFilesVerified(prep),
      client,
    );
  }
  await enqueuePageWriteInvalidation(client, prep.intentId);
}

/**
 * Move a Confluence-sourced article into a local space, deleting the upstream
 * page (product decision 1: this is a true move, not a detach — a detach would
 * be re-imported as a duplicate by the next `syncSpace`).
 */
async function relocateToLocal(opts: {
  page: RelocatablePage;
  userId: string;
  spaceKey: string | null;
  visibility: 'private' | 'shared';
}): Promise<RelocatePageResponse> {
  const { page, userId, spaceKey, visibility } = opts;
  const oldConfluenceId = page.confluence_id!;
  await assertIdentifierUnambiguous(oldConfluenceId, page.id, 'current');
  await assertIdentifierUnambiguous(String(page.id), page.id, 'new local');

  const sourceFiles: Array<RelocationAttachmentPreparation & { data: Buffer }> = [];
  for (const sourceName of await listCachedAttachments(oldConfluenceId)) {
    let data: Buffer | null;
    try {
      data = await readCachedAttachmentFile(oldConfluenceId, sourceName);
    } catch (error) {
      throw unreadableAttachmentError(sourceName, error);
    }
    if (data !== null) {
      sourceFiles.push({
        sourceName,
        targetName: sourceName,
        data,
        contentType: getMimeType(sourceName),
        size: data.length,
        sha256: sha256(data),
      });
    }
  }

  const intent = await reserveRelocateIntent({
    page,
    userId,
    target: 'local',
    targetSpaceKey: spaceKey,
  });
  try {
    await assertCurrentRelocateAuthority(intent, userId, page.id, page.space_key);
  } catch (error) {
    await cancelPageWriteIntentBeforeEffect(intent);
    throw error;
  }
  const prep = await persistRelocationPreparation(intent, {
    pageId: page.id,
    actorId: userId,
    direction: 'to_local',
    targetSpaceKey: spaceKey,
    targetVisibility: visibility,
    attachments: sourceFiles.map(({ data: _data, ...descriptor }) => descriptor),
    expectedRemoteTitleSha256: sha256(page.title),
    expectedRemoteBodyStorageSha256: sha256(page.body_storage ?? ''),
    parentConfluenceId: null,
  });

  const result = await runPageWriteIntentEffect(
    intent,
    { kind: 'local' },
    () => advancePageWriteIntent(intent, (txClient) =>
      publishToLocalOnClient(txClient, intent.id, prep),
    ),
  );

  // The local cutover can spend an unbounded interval behind its transaction
  // and filesystem locks. Resolve authority, mode, and credentials only after
  // it commits; a refusal here deliberately leaves the intent and preparation
  // pending rather than deleting upstream through the route's stale client.
  const remoteClient = await runPageWriteIntentEffect(
    intent,
    { kind: 'local' },
    () => currentRelocationClient(intent, prep, 'published_local'),
  );

  let deleteError: unknown;
  const deletionOutcome = await runPageWriteIntentEffect(
    intent,
    {
      kind: 'remote',
      completesRemoteWork: true,
      terminalResult: (outcome: RemoteDeletionOutcome) => ({
        outcome,
        pageId: page.id,
        confluenceId: oldConfluenceId,
      }),
    },
    async (): Promise<RemoteDeletionOutcome> => {
      try {
        await remoteClient.deletePage(oldConfluenceId);
        return 'gone';
      } catch (error) {
        deleteError = error;
        const observed = await remoteDeletionOutcome(remoteClient, oldConfluenceId, error);
        if (observed === 'unknown') throw error;
        return observed;
      }
    },
  );

  if (deletionOutcome === 'live') {
    await runPageWriteIntentEffect(
      intent,
      { kind: 'local' },
      () => advancePageWriteIntent(intent, (txClient) =>
        restorePreMoveStateOnClient(txClient, prep),
      ),
    );
    await completePageWriteIntent(intent, (txClient) =>
      deleteRelocationPreparation(txClient, intent.id),
    );
    throw deleteError;
  }

  await runPageWriteIntentEffect(
    intent,
    { kind: 'local' },
    () => advancePageWriteIntent(intent, async (txClient) => {
      await txClient.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
      await withLocalAttachmentMutationLock(
        () => removeAttachmentDirectoryVerified(oldConfluenceId),
        txClient,
      );
    }),
  );
  await completePageWriteIntent(intent, (txClient) =>
    deleteRelocationPreparation(txClient, intent.id),
  );
  return result;
}

type RemoteDeletionOutcome = 'gone' | 'live' | 'unknown';

/**
 * Prove the outcome of a failed remote delete. A successful read of a
 * non-trashed page is the only `live` proof; transport/auth/server failures are
 * `unknown` and must retain the durable write intent.
 */
async function remoteDeletionOutcome(
  client: ConfluenceClient,
  confluenceId: string,
  originalErr: unknown,
): Promise<RemoteDeletionOutcome> {
  if (originalErr instanceof ConfluenceError && originalErr.statusCode === 404) return 'gone';
  try {
    return (await client.getPage(confluenceId)).status === 'trashed' ? 'gone' : 'live';
  } catch (probeErr) {
    if (probeErr instanceof ConfluenceError && probeErr.statusCode === 404) return 'gone';
    return 'unknown';
  }
}

async function verifyOriginalProviderState(
  confluence: ConfluenceClient,
  prep: RelocationPreparation,
): Promise<void> {
  if (!prep.confluence_id) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'The original Confluence identity is unavailable');
  }
  let page;
  let attachments;
  try {
    [page, attachments] = await Promise.all([
      confluence.getPage(prep.confluence_id),
      confluence.getPageAttachments(prep.confluence_id),
    ]);
  } catch (error) {
    throw new PageWriteError(409, 'intent_provider_state_unavailable', `The original Confluence state could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    page.id !== prep.confluence_id ||
    page.status === 'trashed' ||
    page.version?.number !== prep.version ||
    sha256(page.title) !== prep.expectedRemoteTitleSha256 ||
    sha256(page.body?.storage?.value ?? '') !== prep.expectedRemoteBodyStorageSha256
  ) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The original Confluence page changed after relocation preparation');
  }
  for (const required of prep.attachments) {
    const matches = attachments.results.filter((attachment) => attachment.title === required.sourceName);
    if (matches.length !== 1 || !matches[0]?._links?.download) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', `Required Confluence attachment "${required.sourceName}" is missing or ambiguous`);
    }
    let bytes: Buffer;
    try {
      bytes = await confluence.downloadAttachment(matches[0]._links.download);
    } catch (error) {
      throw new PageWriteError(409, 'intent_provider_state_unavailable', `Required Confluence attachment "${required.sourceName}" could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (bytes.length !== required.size || sha256(bytes) !== required.sha256) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', `Required Confluence attachment "${required.sourceName}" changed after relocation preparation`);
    }
  }
}

async function verifyLocalToConfluencePublication(
  client: PoolClient,
  prep: RelocationPreparation,
  confluenceId: string,
  observed: { title: string; bodyStorage: string; version: number },
): Promise<void> {
  const row = await client.query<RelocatablePage>(
    `SELECT ${RELOCATABLE_COLUMNS} FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [prep.id],
  );
  const current = row.rows[0];
  const expectedHtml = confluenceToHtml(observed.bodyStorage, confluenceId, prep.targetSpaceKey ?? '');
  if (
    !current ||
    current.source !== 'confluence' ||
    current.confluence_id !== confluenceId ||
    current.space_key !== prep.targetSpaceKey ||
    current.visibility !== 'shared' ||
    current.title !== observed.title ||
    current.body_storage !== observed.bodyStorage ||
    current.body_html !== expectedHtml ||
    current.body_text !== htmlToText(expectedHtml) ||
    current.version !== observed.version ||
    current.embedding_dirty !== true ||
    current.image_analysis_dirty !== true ||
    current.embedding_status !== 'not_embedded' ||
    current.embedded_at !== null
  ) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The local Confluence publication does not match the provider receipt');
  }
  for (const attachment of prep.attachments) {
    const bytes = await readCachedAttachmentFile(confluenceId, attachment.targetName);
    if (
      bytes === null ||
      bytes.length !== attachment.size ||
      sha256(bytes) !== attachment.sha256
    ) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', `Published attachment "${attachment.targetName}" does not match the durable preparation`);
    }
  }
  const children = await client.query<{ id: number }>(
    'SELECT id FROM pages WHERE parent_id = $1 ORDER BY id',
    [confluenceId],
  );
  if (
    children.rows.length !== prep.childIds.length ||
    children.rows.some((child, index) => child.id !== prep.childIds[index])
  ) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The relocated child links do not match the durable preparation');
  }
  const remainingLocalAttachments = await client.query(
    'SELECT 1 FROM local_attachments WHERE page_id = $1 LIMIT 1',
    [prep.id],
  );
  const unprotectedHistory = await client.query(
    `SELECT 1
       FROM page_versions pv
      WHERE pv.page_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM page_baselines baseline WHERE baseline.version_snapshot_id = pv.id
        )
      LIMIT 1`,
    [prep.id],
  );
  if (remainingLocalAttachments.rowCount !== 0 || unprotectedHistory.rowCount !== 0) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The local Confluence publication cleanup is incomplete');
  }
}

async function verifyLocalPublicationState(
  client: PoolClient,
  prep: RelocationPreparation,
): Promise<void> {
  const row = await client.query<RelocatablePage>(
    `SELECT ${RELOCATABLE_COLUMNS} FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [prep.id],
  );
  const current = row.rows[0];
  const { html: expectedHtml } = rewriteAttachmentRefs(
    prep.body_html ?? '',
    [`/api/attachments/${encodeURIComponent(prep.oldKey)}/`],
    `/api/local-attachments/${prep.id}/`,
    false,
  );
  if (
    !current ||
    current.source !== 'standalone' ||
    current.confluence_id !== null ||
    current.space_key !== prep.targetSpaceKey ||
    current.visibility !== prep.targetVisibility ||
    current.created_by_user_id !== prep.actorId ||
    current.body_html !== expectedHtml ||
    current.body_storage !== prep.body_storage ||
    current.body_text !== prep.body_text ||
    current.version !== prep.version ||
    current.inherit_perms !== true ||
    current.local_modified_at === null ||
    current.local_modified_by !== prep.actorId ||
    current.embedding_dirty !== true ||
    current.image_analysis_dirty !== true ||
    current.embedding_status !== 'not_embedded' ||
    current.embedded_at !== null
  ) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The local relocation publication does not match its durable preparation');
  }
  const aces = await client.query(
    "SELECT 1 FROM access_control_entries WHERE resource_type = 'page' AND resource_id = $1 LIMIT 1",
    [prep.id],
  );
  if (aces.rowCount !== 0) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The local relocation ACL cutover is incomplete');
  }
  const children = await client.query<{ id: number }>(
    'SELECT id FROM pages WHERE parent_id = $1 ORDER BY id',
    [String(prep.id)],
  );
  if (
    children.rows.length !== prep.childIds.length ||
    children.rows.some((child, index) => child.id !== prep.childIds[index])
  ) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The local relocation child links are incomplete');
  }
  await verifyLocalPublicationAttachments(client, prep);
}

async function verifyLocalPublicationAttachments(
  client: PoolClient,
  prep: RelocationPreparation,
): Promise<void> {
  const rows = await client.query<{
    filename: string;
    content_type: string;
    size_bytes: number;
    sha256: string;
  }>(
    `SELECT filename, content_type, size_bytes, sha256
       FROM local_attachments
      WHERE page_id = $1
      ORDER BY filename`,
    [prep.id],
  );
  const expected = [...prep.attachments].sort((a, b) => a.targetName.localeCompare(b.targetName));
  if (
    rows.rows.length !== expected.length ||
    rows.rows.some((row, index) => {
      const wanted = expected[index];
      return !wanted ||
        row.filename !== wanted.targetName ||
        row.content_type !== wanted.contentType ||
        Number(row.size_bytes) !== wanted.size ||
        row.sha256 !== wanted.sha256;
    })
  ) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The local relocation attachment rows are incomplete');
  }
  for (const attachment of prep.attachments) {
    const bytes = await fs.readFile(`${localAttachmentsDir(prep.id)}/${attachment.targetName}`);
    if (bytes.length !== attachment.size || sha256(bytes) !== attachment.sha256) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', `Local attachment "${attachment.targetName}" does not match the durable preparation`);
    }
  }
}

async function assertUnchangedToConfluenceSource(
  client: PoolClient,
  intent: PageWriteIntent,
  pageId: number,
  expected: {
    source: unknown;
    confluenceId: unknown;
    spaceKey: unknown;
  },
): Promise<void> {
  if (
    expected.source !== 'standalone' ||
    expected.confluenceId !== null ||
    (expected.spaceKey !== null && typeof expected.spaceKey !== 'string')
  ) {
    throw new PageWriteError(
      409,
      'intent_recovery_metadata_invalid',
      'The original local relocation identity is unavailable',
    );
  }
  const revision = intent.revisions[pageId];
  if (!revision) {
    throw new PageWriteError(
      409,
      'intent_recovery_metadata_invalid',
      'The original local relocation revisions are unavailable',
    );
  }
  const current = await client.query<{
    source: string;
    confluence_id: string | null;
    space_key: string | null;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT source, confluence_id, space_key,
            content_revision::text, lifecycle_revision::text
       FROM pages
      WHERE id = $1 AND deleted_at IS NULL`,
    [pageId],
  );
  const row = current.rows[0];
  if (
    !row ||
    row.source !== expected.source ||
    row.confluence_id !== expected.confluenceId ||
    row.space_key !== expected.spaceKey ||
    row.content_revision !== String(revision.contentRevision) ||
    row.lifecycle_revision !== String(revision.lifecycleRevision)
  ) {
    throw new PageWriteError(
      409,
      'intent_local_evidence_mismatch',
      'A non-dispatched relocation changed locally',
    );
  }
}


const reconcileRelocate: PageWriteIntentReconciler = async (client, intent) => {
  const effect = intent.effect;
  const pageId = typeof effect.pageId === 'number' ? effect.pageId : null;
  if (
    pageId === null ||
    !intent.pageIds.includes(pageId) ||
    (effect.target !== 'local' && effect.target !== 'confluence') ||
    (
      intent.actorId === null &&
      (effect.target !== 'confluence' || intent.remoteEffectStartedAt !== null)
    )
  ) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation identity is incomplete');
  }
  const preparation = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM page_relocation_preparations WHERE intent_id = $1
     ) AS exists`,
    [intent.id],
  );
  if (!preparation.rows[0]?.exists) {
    if (
      intent.effectStartedAt === null ||
      intent.effectFinishedAt !== null ||
      intent.remoteEffectStartedAt !== null
    ) {
      throw new PageWriteError(
        409,
        'intent_recovery_metadata_invalid',
        'Relocation preparation is unavailable after a completed or remote phase',
      );
    }
    if (
      (effect.target === 'confluence' && (
        typeof effect.targetSpaceKey !== 'string' ||
        effect.fromSource !== 'standalone' ||
        effect.fromConfluenceId !== null ||
        (effect.fromSpaceKey !== null && typeof effect.fromSpaceKey !== 'string')
      )) ||
      (effect.target === 'local' &&
        effect.fromSpaceKey !== null &&
        typeof effect.fromSpaceKey !== 'string')
    ) {
      throw new PageWriteError(
        409,
        'intent_recovery_metadata_invalid',
        'Relocation authority metadata is unavailable',
      );
    }
    if (effect.target === 'confluence') {
      await assertUnchangedToConfluenceSource(client, intent, pageId, {
        source: effect.fromSource,
        confluenceId: effect.fromConfluenceId,
        spaceKey: effect.fromSpaceKey,
      });
    } else {
      if (!intent.actorId) {
        throw new PageWriteError(
          409,
          'intent_recovery_metadata_invalid',
          'Relocation actor identity is unavailable',
        );
      }
      try {
        await assertCurrentRelocateAuthorityOnClient(
          client,
          intent.actorId,
          pageId,
          typeof effect.fromSpaceKey === 'string' ? effect.fromSpaceKey : null,
        );
      } catch (error) {
        if (error instanceof RelocateError && error.statusCode === 403) {
          throw new PageWriteError(403, 'intent_access_changed', error.message);
        }
        throw error;
      }
    }
    // The local gate commits its start marker before the preparation
    // transaction. An absent row with an unfinished local phase therefore
    // proves that transaction did not commit, while remote_effect_started_at
    // independently proves that no provider call was dispatched.
    return {
      outcome: 'not_applied',
      proof: {
        kind: 'remote_effect_not_started',
        observedAt: new Date().toISOString(),
        reference: `page-relocate:${pageId}:preparation-not-committed`,
        details: { syscallSettled: true, remoteEffectStarted: false, observedAbsent: true },
      },
      result: { pageId, outcome: 'not_prepared' },
    };
  }
  const prep = await loadRelocationPreparation(client, intent);
  if (
    prep.id !== pageId ||
    (prep.direction === 'to_confluence') !== (effect.target === 'confluence')
  ) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Relocation preparation does not match its intent');
  }
  if (intent.remoteEffectStartedAt === null) {
    if (prep.direction === 'to_local') {
      try {
        await assertCurrentRelocateAuthorityOnClient(client, prep.actorId, prep.id, prep.space_key);
      } catch (error) {
        if (error instanceof RelocateError && error.statusCode === 403) {
          throw new PageWriteError(403, 'intent_access_changed', error.message);
        }
        throw error;
      }
      const confluence = await getClientForUser(prep.actorId, client);
      if (!confluence) {
        throw new PageWriteError(409, 'intent_actor_credentials_unavailable', 'The original writer credentials are unavailable for relocation recovery');
      }
      await verifyOriginalProviderState(confluence, prep);
      await restorePreMoveStateOnClient(client, prep);
    } else {
      if (
        prep.createdConfluenceId !== null ||
        prep.createdPageReceipt !== null ||
        prep.attachmentReceipts.length !== 0
      ) {
        throw new PageWriteError(
          409,
          'intent_terminal_evidence_mismatch',
          'Relocation provider progress exists without a durable remote-start marker',
        );
      }
      await assertUnchangedToConfluenceSource(client, intent, prep.id, {
        source: prep.source,
        confluenceId: prep.confluence_id,
        spaceKey: prep.space_key,
      });
    }
    await deleteRelocationPreparation(client, intent.id);
    return {
      outcome: 'not_applied',
      proof: {
        kind: 'remote_effect_not_started',
        observedAt: new Date().toISOString(),
        reference: `page-relocate:${pageId}:not-dispatched`,
        details: { syscallSettled: true, remoteEffectStarted: false, observedAbsent: true },
      },
      result: { pageId, outcome: 'restored' },
    };
  }
  const authoritySpace = prep.direction === 'to_confluence'
    ? prep.targetSpaceKey
    : prep.space_key;
  try {
    await assertCurrentRelocateAuthorityOnClient(client, prep.actorId, prep.id, authoritySpace);
  } catch (error) {
    if (error instanceof RelocateError && error.statusCode === 403) {
      throw new PageWriteError(403, 'intent_access_changed', error.message);
    }
    throw error;
  }
  const confluence = await getClientForUser(prep.actorId, client);
  if (!confluence) {
    throw new PageWriteError(409, 'intent_actor_credentials_unavailable', 'The original writer credentials are unavailable for relocation recovery');
  }
  if (prep.direction === 'to_confluence') {
    if (intent.remoteEffectsCompletedAt === null || !intent.remoteTerminalResult) {
      throw new PageWriteError(409, 'intent_outcome_unrecoverable', 'The relocation remote outcome is unknown');
    }
    const terminal = intent.remoteTerminalResult;
    if (
      terminal.outcome !== 'committed' ||
      typeof terminal.createdConfluenceId !== 'string'
    ) {
      throw new PageWriteError(409, 'intent_terminal_result_invalid', 'The Confluence creation receipt is unavailable');
    }
    const pageReceipt = terminal.page === null
      ? prep.createdPageReceipt
      : parseRemotePageReceipt(terminal.page);
    const attachmentReceipts = prep.attachmentReceipts;
    if (
      prep.createdConfluenceId !== terminal.createdConfluenceId ||
      (pageReceipt !== null && (
        prep.createdPageReceipt === null ||
        prep.createdPageReceipt.id !== pageReceipt.id ||
        prep.createdPageReceipt.version !== pageReceipt.version ||
        prep.createdPageReceipt.titleSha256 !== pageReceipt.titleSha256 ||
        prep.createdPageReceipt.bodyStorageSha256 !== pageReceipt.bodyStorageSha256
      ))
    ) {
      throw new PageWriteError(409, 'intent_terminal_result_invalid', 'The terminal creation receipt does not match durable relocation progress');
    }
    if (
      terminal.attachmentCount !== attachmentReceipts.length ||
      terminal.attachmentReceiptsSha256 !== attachmentReceiptsDigest(attachmentReceipts)
    ) {
      throw new PageWriteError(409, 'intent_terminal_result_invalid', 'The terminal attachment receipts do not match durable relocation progress');
    }

    if (
      prep.createdConfluenceId === null ||
      attachmentReceipts.length !== prep.attachments.length ||
      attachmentReceipts.some((receipt, index) =>
        receipt.title !== prep.attachments[index]?.targetName)
    ) {
      throw new PageWriteError(409, 'intent_terminal_result_invalid', 'The Confluence attachment receipt set is incomplete');
    }
    if (
      pageReceipt !== null &&
      (
        pageReceipt.id !== prep.createdConfluenceId ||
        pageReceipt.titleSha256 !== prep.expectedRemoteTitleSha256 ||
        pageReceipt.bodyStorageSha256 !== prep.expectedRemoteBodyStorageSha256
      )
    ) {
      throw new PageWriteError(409, 'intent_terminal_result_invalid', 'The Confluence creation receipt does not match the admitted relocation');
    }
    await assertIdentifierUnambiguous(
      prep.createdConfluenceId,
      prep.id,
      'new Confluence',
      client,
    );
    const verified = await verifyCreatedProviderState(
      confluence,
      prep.createdConfluenceId,
      pageReceipt,
      prep.expectedRemoteTitleSha256,
      prep.expectedRemoteBodyStorageSha256,
      attachmentReceipts,
      prep.parentConfluenceId,
    );
    const current = await client.query<{ source: string; confluence_id: string | null }>(
      'SELECT source, confluence_id FROM pages WHERE id = $1',
      [prep.id],
    );
    if (
      current.rows[0]?.source === prep.source &&
      current.rows[0]?.confluence_id === prep.confluence_id
    ) {
      await publishToConfluenceOnClient(
        client,
        intent.id,
        prep,
        verified.pageReceipt.id,
        verified.observed,
        prep.actorId,
        [],
      );
    } else {
      await verifyLocalToConfluencePublication(
        client,
        prep,
        verified.pageReceipt.id,
        verified.observed,
      );
      await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
      await withLocalAttachmentMutationLock(async (lockClient) => {
        if (verified.pageReceipt.id !== prep.oldKey) {
          await removeAttachmentDirectoryVerified(prep.oldKey);
        }
        await removeLocalAttachmentDirectory(prep.id, lockClient);
      }, client);
      await enqueuePageWriteInvalidation(client, intent.id);
    }
    await deleteRelocationPreparation(client, intent.id);
    return {
      outcome: 'applied',
      proof: {
        kind: 'remote_terminal_effect_verified',
        observedAt: new Date().toISOString(),
        reference: `page-relocate:${pageId}:confluence:${verified.pageReceipt.id}:version:${verified.pageReceipt.version}`,
        details: {
          remoteEffectsCompleted: true,
          terminalEvidence: pageReceipt === null
            ? 'acknowledged_create_identity_and_read_only_provider_verification_match'
            : 'page_and_attachment_receipts_match',
        },
      },
      result: { pageId, outcome: 'committed' },
    };
  }

  if (intent.remoteEffectsCompletedAt === null || !intent.remoteTerminalResult) {
    throw new PageWriteError(409, 'intent_outcome_unrecoverable', 'The relocation remote outcome is unknown');
  }
  const terminal = intent.remoteTerminalResult;

  if (
    typeof terminal.confluenceId !== 'string' ||
    terminal.confluenceId !== prep.confluence_id ||
    (terminal.outcome !== 'gone' && terminal.outcome !== 'live')
  ) {
    throw new PageWriteError(409, 'intent_terminal_result_invalid', 'The Confluence deletion receipt is unavailable');
  }
  if (terminal.outcome === 'live') {
    await verifyOriginalProviderState(confluence, prep);
    await restorePreMoveStateOnClient(client, prep);
    await deleteRelocationPreparation(client, intent.id);
    return {
      outcome: 'not_applied',
      proof: {
        kind: 'remote_terminal_effect_verified',
        observedAt: new Date().toISOString(),
        reference: `page-relocate:${pageId}:delete-not-applied`,
        details: { remoteEffectsCompleted: true, terminalEvidence: 'original_provider_state_live' },
      },
      result: { pageId, outcome: 'restored' },
    };
  }
  const remoteState = await remoteDeletionOutcome(
    confluence,
    prep.confluence_id!,
    new Error('recovery probe'),
  );
  if (remoteState !== 'gone') {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The deleted Confluence page is not proven absent');
  }
  const current = await client.query<{
    source: string;
    confluence_id: string | null;
    space_key: string | null;
  }>('SELECT source, confluence_id, space_key FROM pages WHERE id = $1', [prep.id]);
  if (
    current.rows[0]?.source !== 'standalone' ||
    current.rows[0]?.confluence_id !== null ||
    current.rows[0]?.space_key !== prep.targetSpaceKey
  ) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The local relocation publication is incomplete');
  }
  await verifyLocalPublicationState(client, prep);
  await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
  await withLocalAttachmentMutationLock(
    () => removeAttachmentDirectoryVerified(prep.oldKey),
    client,
  );
  await enqueuePageWriteInvalidation(client, intent.id);
  await deleteRelocationPreparation(client, intent.id);
  return {
    outcome: 'applied',
    proof: {
      kind: 'remote_terminal_effect_verified',
      observedAt: new Date().toISOString(),
      reference: `page-relocate:${pageId}:deleted`,
      details: { remoteEffectsCompleted: true, terminalEvidence: 'provider_absence_and_local_files_verified' },
    },
    result: { pageId, outcome: 'committed' },
  };
};

let relocateReconcilerRegistered = false;

export function registerPageRelocateReconciler(): void {
  if (relocateReconcilerRegistered) return;
  registerPageWriteIntentReconciler('page.relocate', reconcileRelocate);
  relocateReconcilerRegistered = true;
}



/**
 * Entry point. `page` must already have been authorised by the route
 * (`pages:relocate` + target-space write access + page access); this function
 * verifies the acknowledgements that depend on live state.
 */
export async function relocatePage(opts: {
  page: RelocatablePage;
  userId: string;
  input: RelocatePageInput;
  /** Route preflight snapshot only; remote phases always re-resolve it. */
  client: ConfluenceClient;
}): Promise<RelocatePageResponse> {
  const { page, userId, input } = opts;
  await rejectIfLiveCollabRoom(
    page.id,
    (message) => new RelocateError(409, message, { code: 'collab_session_active' }),
  );

  if (input.target === 'confluence') {
    if (page.source !== 'standalone') {
      throw new RelocateError(400, 'Page is already a Confluence page');
    }
    return relocateToConfluence({
      page,
      userId,
      spaceKey: input.spaceKey,
      expectedVersionCount: input.acknowledgeDiscardedVersions,
    });
  }

  if (page.source !== 'confluence' || !page.confluence_id) {
    throw new RelocateError(400, 'Page is already a local article');
  }
  return relocateToLocal({
    page,
    userId,
    spaceKey: input.spaceKey,
    visibility: input.visibility,
  });
}
