/**
 * Local-page attachment storage (#302 Gap 4).
 *
 * Confluence pages cache attachments under `ATTACHMENTS_DIR/<confluence_id>/`
 * and the authoritative source stays in Confluence. Local / standalone pages
 * have no upstream — we must be the source of truth. Files live under a
 * parallel tree `ATTACHMENTS_DIR/local/<page_id>/` keyed by the page's
 * numeric PK, and metadata rows go in the `local_attachments` table created
 * in migration 064.
 *
 * Authorisation is enforced at the route layer (Confluence-RBAC doesn't
 * apply here because local pages have no `space_key`; ownership + visibility
 * from the pages table is used instead).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../db/advisory-locks.js';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { markPageImagesDirty } from './image-analysis-dirty.js';
import { withLocalAttachmentMutationLock } from './attachment-snapshot-lock.js';
import {
  advancePageWriteIntent,
  completePageWriteIntent,
  registerPageWriteIntentReconciler,
  type PageWriteRecoveryIntent,
  type PageRevision,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
  type PageWriteIntent,
} from './page-write-admission.js';

/** Sub-directory under ATTACHMENTS_DIR reserved for local-page files. */
const LOCAL_SUBDIR = 'local';
/**
 * Resolve the attachments base at **call time** rather than module-load
 * time so tests that set `process.env.ATTACHMENTS_DIR` after imports pick
 * up the override, and so a running instance can hot-swap the dir via
 * config (rare, but harmless to support).
 */
function attachmentsBase(): string {
  return process.env.ATTACHMENTS_DIR ?? 'data/attachments';
}
/** Size cap per attachment. 25 MB covers diagram PNGs + large XMLs. */
const MAX_LOCAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class LocalAttachmentError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'PAGE_NOT_FOUND' | 'FORBIDDEN' | 'TOO_LARGE' | 'INVALID_FILENAME' | 'STORAGE_UNWRITABLE',
    message: string,
  ) {
    super(message);
    this.name = 'LocalAttachmentError';
  }
}

export interface LocalAttachmentRecord {
  id: number;
  pageId: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resolve the absolute filesystem directory for a local page. Walks the
 * path traversal guard: basename sanitises filenames, and resolve() +
 * prefix check blocks escape from ATTACHMENTS_BASE.
 */
function localPageDir(pageId: number): string {
  const base = attachmentsBase();
  const dir = path.join(base, LOCAL_SUBDIR, String(pageId));
  const resolved = path.resolve(dir);
  const baseResolved = path.resolve(base);
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new LocalAttachmentError('FORBIDDEN', 'Path resolution escaped attachments base');
  }
  return dir;
}

/**
 * The rule {@link localFilePath} enforces, asked as a question. Callers that
 * merely *found* a filename — a `local_attachments` row written outside this
 * module — need to know before they resolve a path, because the throw carries
 * no way to say which file was at fault (#1169).
 *
 * Deliberately **not** identical to the Confluence cache's
 * `isStorableAttachmentFilename`: both reject backslashes so backup paths stay
 * portable, while this store caps length and that one rejects NUL bytes. A
 * filename moving between the stores must satisfy both, so relocate asks both.
 */
export function canStoreLocalFilename(filename: string): boolean {
  if (filename.includes('\\')) return false;
  const safe = path.basename(filename);
  return Boolean(safe) && !safe.startsWith('.') && safe.length <= 255;
}

function localFilePath(pageId: number, filename: string): string {
  if (!canStoreLocalFilename(filename)) {
    throw new LocalAttachmentError(
      'INVALID_FILENAME',
      'Filename is empty, hidden, too long, or contains a backslash',
    );
  }
  return path.join(localPageDir(pageId), path.basename(filename));
}

function mapRow(r: {
  id: string;
  page_id: number;
  filename: string;
  content_type: string;
  size_bytes: string;
  sha256: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}): LocalAttachmentRecord {
  return {
    id: parseInt(r.id, 10),
    pageId: r.page_id,
    filename: r.filename,
    contentType: r.content_type,
    sizeBytes: parseInt(r.size_bytes, 10),
    sha256: r.sha256,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Check that the caller is permitted to read/write attachments for a
 * standalone page. Returns the page row on success; throws PAGE_NOT_FOUND
 * or FORBIDDEN otherwise. Confluence-synced pages are explicitly rejected
 * so the two stores stay separate.
 */
async function assertLocalPageAccess(
  pageId: number,
  userId: string,
  client?: PoolClient,
): Promise<{
  id: number;
  source: string;
  visibility: string;
  created_by_user_id: string | null;
  content_revision: string;
  lifecycle_revision: string;
}> {
  const statement = `SELECT id, source, visibility, created_by_user_id, deleted_at,
                            content_revision::text, lifecycle_revision::text
       FROM pages
      WHERE id = $1`;
  const res = client
    ? await client.query<{
        id: number;
        source: string;
        visibility: string;
        created_by_user_id: string | null;
        deleted_at: Date | null;
        content_revision: string;
        lifecycle_revision: string;
      }>(statement, [pageId])
    : await query<{
        id: number;
        source: string;
        visibility: string;
        created_by_user_id: string | null;
        deleted_at: Date | null;
        content_revision: string;
        lifecycle_revision: string;
      }>(statement, [pageId]);
  const row = res.rows[0];
  if (!row) throw new LocalAttachmentError('PAGE_NOT_FOUND', 'Page not found');
  if (row.deleted_at) throw new LocalAttachmentError('PAGE_NOT_FOUND', 'Page is trashed');
  if (row.source !== 'standalone') {
    throw new LocalAttachmentError(
      'FORBIDDEN',
      'Use /api/attachments/:confluenceId/... for Confluence-backed pages',
    );
  }
  // Ownership / visibility gate: private pages are owner-only; shared
  // pages are any authenticated user. Admins also pass through
  // (the route layer has separate requireAdmin-style plumbing if needed;
  // for read/write parity with page edits we mirror the PUT /pages rules).
  if (row.visibility !== 'shared' && row.created_by_user_id !== userId) {
    throw new LocalAttachmentError('FORBIDDEN', 'Not authorised to access this page');
  }
  return row;
}

export interface LocalAttachmentWrite {
  filename: string;
  contentType: string;
  data: Buffer;
}

interface StagedLocalAttachment extends LocalAttachmentWrite {
  sha256: string;
  stagePath: string;
}

async function stageLocalAttachments(
  pageId: number,
  intent: PageWriteIntent,
  attachments: readonly LocalAttachmentWrite[],
): Promise<StagedLocalAttachment[]> {
  const dir = localPageDir(pageId);
  await fs.mkdir(dir, { recursive: true });
  const staged: StagedLocalAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const sha256 = crypto.createHash('sha256').update(attachment.data).digest('hex');
    const stagePath = path.join(dir, `.page-write-${intent.id}-${index}.stage`);
    const handle = await fs.open(stagePath, 'wx', 0o600);
    try {
      await handle.writeFile(attachment.data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    staged.push({ ...attachment, sha256, stagePath });
  }
  return staged;
}

/**
 * Persist one logical attachment mutation.
 *
 * Admission is durable before any byte is staged. Activation, metadata, the
 * attachment-only revision and intent advance/settlement run under one
 * lifecycle callback and transaction-scoped backup barrier, so a backup
 * cannot pair one generation's metadata with another generation's bytes.
 *
 * `expectedRevisions` is the handoff fence for a multi-phase caller. The
 * reservation compares it under the lifecycle lock, and the returned revisions
 * come only from this operation's committed advance — never from a later
 * post-hoc page read.
 */
export async function putLocalAttachments(opts: {
  pageId: number;
  attachments: readonly LocalAttachmentWrite[];
  userId: string;
  expectedRevisions?: Readonly<Record<number, PageRevision>>;
}): Promise<{
  records: LocalAttachmentRecord[];
  revisions: Record<number, PageRevision>;
}> {
  if (opts.attachments.length === 0) {
    return {
      records: [],
      revisions: { ...(opts.expectedRevisions ?? {}) },
    };
  }
  const names = new Set<string>();
  const prepared = opts.attachments.map((attachment) => {
    if (attachment.data.length > MAX_LOCAL_ATTACHMENT_BYTES) {
      throw new LocalAttachmentError(
        'TOO_LARGE',
        `Attachment exceeds maximum size of ${MAX_LOCAL_ATTACHMENT_BYTES / (1024 * 1024)} MB`,
      );
    }
    const filename = path.basename(attachment.filename);
    localFilePath(opts.pageId, attachment.filename);
    if (names.has(filename)) {
      throw new LocalAttachmentError('INVALID_FILENAME', 'Duplicate attachment filename');
    }
    names.add(filename);
    return { ...attachment, filename };
  });

  // Authorization is checked before admission so an ordinary denial performs
  // no filesystem work. It is checked again on the completion client.
  const authorizedPage = await assertLocalPageAccess(opts.pageId, opts.userId);
  // A read-only preflight may refuse before admission without leaving an
  // unknown effect. Never translate errors after staging starts into this
  // verdict: permissions can change between this check and the actual write.
  let storageParent = path.resolve(localPageDir(opts.pageId));
  for (;;) {
    try {
      await fs.access(storageParent, fs.constants.W_OK | fs.constants.X_OK);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(storageParent);
      if (code === 'ENOENT' && parent !== storageParent) {
        storageParent = parent;
        continue;
      }
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new LocalAttachmentError(
          'STORAGE_UNWRITABLE',
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }
  const expectedRevisions = opts.expectedRevisions ?? {
    [opts.pageId]: {
      contentRevision: authorizedPage.content_revision,
      lifecycleRevision: authorizedPage.lifecycle_revision,
    },
  };
  const intent = await reservePageWriteIntent({
    pageIds: [opts.pageId],
    kind: 'attachment.local.put',
    expectedRevisions,
    actorId: opts.userId,
    effect: {
      effectClass: 'local',
      pageId: opts.pageId,
      files: prepared.map((attachment, stageIndex) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        stageIndex,
        size: attachment.data.length,
        sha256: crypto.createHash('sha256').update(attachment.data).digest('hex'),
      })),
    },
  });
  if (!intent.pageIds.includes(opts.pageId)) {
    throw new LocalAttachmentError('PAGE_NOT_FOUND', 'Local page not found');
  }

  const staged = await runPageWriteIntentEffect(intent, { kind: 'local' }, () => stageLocalAttachments(opts.pageId, intent, prepared));
  const records = await runPageWriteIntentEffect(intent, { kind: 'local' }, () => advancePageWriteIntent(intent, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    await assertLocalPageAccess(opts.pageId, opts.userId, client);
    for (const attachment of staged) {
      await fs.rename(
        attachment.stagePath,
        localFilePath(opts.pageId, attachment.filename),
      );
    }
    const rows: LocalAttachmentRecord[] = [];
    for (const attachment of staged) {
      const res = await client.query<{
        id: string;
        page_id: number;
        filename: string;
        content_type: string;
        size_bytes: string;
        sha256: string;
        created_by: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO local_attachments
           (page_id, filename, content_type, size_bytes, sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (page_id, filename) DO UPDATE SET
           content_type = EXCLUDED.content_type,
           size_bytes   = EXCLUDED.size_bytes,
           sha256       = EXCLUDED.sha256,
           updated_at   = NOW()
         RETURNING id, page_id, filename, content_type, size_bytes, sha256,
                   created_by, created_at, updated_at`,
        [
          opts.pageId,
          attachment.filename,
          attachment.contentType,
          attachment.data.length,
          attachment.sha256,
          opts.userId,
        ],
      );
      rows.push(mapRow(res.rows[0]!));
    }
    await markPageImagesDirty(opts.pageId, client);
    await client.query(
      'UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1',
      [opts.pageId],
    );
    return rows;
  }));
  await completePageWriteIntent(intent, async () => undefined);
  logger.info(
    {
      pageId: opts.pageId,
      files: records.map((record) => record.filename),
      userId: opts.userId,
      intentId: intent.id,
    },
    'local-attachment-service: committed local attachment mutation',
  );
  return { records, revisions: { ...intent.revisions } };
}

/** Backwards-compatible single-file entry point, still one durable mutation. */
export async function putLocalAttachment(opts: {
  pageId: number;
  filename: string;
  contentType: string;
  data: Buffer;
  userId: string;
  expectedRevisions?: Readonly<Record<number, PageRevision>>;
}): Promise<LocalAttachmentRecord> {
  const { records } = await putLocalAttachments({
    pageId: opts.pageId,
    attachments: [{
      filename: opts.filename,
      contentType: opts.contentType,
      data: opts.data,
    }],
    userId: opts.userId,
    expectedRevisions: opts.expectedRevisions,
  });
  return records[0]!;
}

/**
 * Read a local attachment. Throws NOT_FOUND if the DB row is missing,
 * the file is missing on disk, or the caller lacks access.
 */
export async function getLocalAttachment(
  pageId: number,
  filename: string,
  userId: string,
): Promise<{ data: Buffer; record: LocalAttachmentRecord }> {
  await assertLocalPageAccess(pageId, userId);

  const res = await query<{
    id: string;
    page_id: number;
    filename: string;
    content_type: string;
    size_bytes: string;
    sha256: string;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, page_id, filename, content_type, size_bytes, sha256,
            created_by, created_at, updated_at
       FROM local_attachments
      WHERE page_id = $1 AND filename = $2`,
    [pageId, path.basename(filename)],
  );
  const row = res.rows[0];
  if (!row) throw new LocalAttachmentError('NOT_FOUND', 'Attachment not found');

  try {
    const data = await fs.readFile(localFilePath(pageId, filename));
    return { data, record: mapRow(row) };
  } catch (err) {
    logger.warn(
      { err, pageId, filename },
      'local-attachment-service: DB row present but file missing — treating as not found',
    );
    throw new LocalAttachmentError('NOT_FOUND', 'Attachment file missing');
  }
}

export async function listLocalAttachments(
  pageId: number,
  userId: string,
): Promise<LocalAttachmentRecord[]> {
  await assertLocalPageAccess(pageId, userId);
  const res = await query<{
    id: string;
    page_id: number;
    filename: string;
    content_type: string;
    size_bytes: string;
    sha256: string;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, page_id, filename, content_type, size_bytes, sha256,
            created_by, created_at, updated_at
       FROM local_attachments
      WHERE page_id = $1
      ORDER BY filename`,
    [pageId],
  );
  return res.rows.map(mapRow);
}

/**
 * Ungated listing of a page's local attachments, with each file's absolute
 * path (#1123 relocate).
 *
 * Deliberately skips {@link assertLocalPageAccess}: relocate authorises the
 * whole operation up front (`pages:relocate` + per-space write check + page
 * access), and it must be able to migrate the attachments of a page it is in
 * the act of flipping to `source='confluence'` — a state the gate rejects by
 * design. Not exported through any route; callers must have authorised first.
 *
 * `path` is null for a row this store would refuse to write — one inserted
 * outside {@link localFilePath}, e.g. by hand. Throwing instead would take down
 * the caller (and the relocate preview behind it) with an error that cannot
 * name the offending file; a null hands that decision back (#1169).
 */
export async function listLocalAttachmentsForRelocate(
  pageId: number,
): Promise<Array<{ filename: string; contentType: string; path: string | null }>> {
  const res = await query<{ filename: string; content_type: string }>(
    'SELECT filename, content_type FROM local_attachments WHERE page_id = $1 ORDER BY filename',
    [pageId],
  );
  return res.rows.map((r) => ({
    filename: r.filename,
    contentType: r.content_type,
    path: canStoreLocalFilename(r.filename) ? localFilePath(pageId, r.filename) : null,
  }));
}

/**
 * Write bytes into the local attachment store for a page without the access
 * gate, returning nothing. Companion to
 * {@link listLocalAttachmentsForRelocate} for the Confluence→local direction,
 * where the row is still `source='confluence'` when the files are staged.
 *
 * Writes the file only — the `local_attachments` row is inserted by the
 * caller's transaction so it can roll back with the rest of the move.
 */
export async function writeLocalAttachmentFileForRelocate(
  pageId: number,
  filename: string,
  data: Buffer,
  client?: PoolClient,
): Promise<void> {
  await withLocalAttachmentMutationLock(async () => {
    const dir = localPageDir(pageId);
    const filePath = localFilePath(pageId, filename);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, data);
  }, client);
}

/**
 * Undo {@link writeLocalAttachmentFileForRelocate} for named files.
 *
 * A Confluence→local move stages bytes *before* the transaction that inserts
 * their `local_attachments` rows, so a transaction that rolls back leaves the
 * files behind (#1169 review). Removing exactly the filenames the move staged —
 * rather than the whole directory — is what makes this safe to call on a
 * failure path: it cannot touch a file some other writer put there.
 *
 * Best-effort and never throws. The caller is already unwinding, and an
 * orphaned file is inert: nothing in the database references it, and a retry
 * overwrites it by name. Losing the real error to a cleanup failure would be
 * strictly worse.
 */
export async function removeLocalAttachmentFilesForRelocate(
  pageId: number,
  filenames: string[],
  client?: PoolClient,
): Promise<void> {
  try {
    await withLocalAttachmentMutationLock(async () => {
      await Promise.all(
        filenames.map(async (filename) => {
          if (!canStoreLocalFilename(filename)) return;
          await fs.rm(localFilePath(pageId, filename), { force: true }).catch(() => undefined);
        }),
      );
    }, client);
  } catch {
    // Best-effort even when connecting, locking, unlocking or resetting fails.
  }
}

/**
 * Remove one local-store file for the orphan sweep (#1349, review r1).
 *
 * The sweep must COUNT what it deleted — the run record, the audit event and
 * the admin card all report those totals — so unlike
 * {@link removeLocalAttachmentFilesForRelocate} (an unwind path that swallows
 * everything), this reports its outcome: `false` when the name is refused
 * (skipped, nothing removed — the caller must not count it), and it THROWS on
 * a real `fs.rm` failure so the run records `failed` instead of claiming a
 * deletion that did not happen. A name that is not its own basename is
 * refused outright, the `removeCachedAttachmentFile` discipline: a deleter
 * must never `basename`-collapse its way onto a different file than the
 * caller named. ENOENT stays a no-op via `force` — the stat-then-rm window is
 * real and a vanished orphan is a success.
 */
export async function removeLocalAttachmentFileForSweep(
  pageId: number,
  filename: string,
  client?: PoolClient,
): Promise<boolean> {
  if (path.basename(filename) !== filename || !canStoreLocalFilename(filename)) {
    return false;
  }
  return withLocalAttachmentMutationLock(async () => {
    await fs.rm(localFilePath(pageId, filename), { force: true });
    return true;
  }, client);
}

/** Absolute directory holding a page's local attachments (#1123 relocate cleanup). */
export function localAttachmentsDir(pageId: number): string {
  return localPageDir(pageId);
}

/**
 * The local store's root, `<ATTACHMENTS_DIR>/local` (#1349).
 *
 * Exported for the orphan sweep, which walks the two stores SEPARATELY: the
 * `local/` entry sits INSIDE the Confluence-style tree's root and its name
 * matches that tree's key pattern, so a walker that derived this path itself
 * would sooner or later list the whole local store as one orphan directory.
 */
export function localAttachmentsRoot(): string {
  return path.join(attachmentsBase(), LOCAL_SUBDIR);
}

/**
 * Create ATTACHMENTS_DIR if missing. Named volumes mounted over an empty
 * image dir are often root-owned; mkdir then throws EACCES and Notion
 * import drops images / paste fails. Call at boot so a writable volume is
 * ready before the first write, and so an unwritable one is logged once.
 */
export async function ensureAttachmentsRoot(): Promise<void> {
  const dir = path.resolve(attachmentsBase());
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    logger.error(
      { err, dir },
      'Cannot create ATTACHMENTS_DIR; image paste will fail and Notion import will drop images until it is writable by this process',
    );
  }
}

/** The reserved entry name the Confluence-tree walk must skip (#1349). */
export const LOCAL_STORE_DIRNAME = LOCAL_SUBDIR;

/**
 * Remove a page's whole local-store directory (#1349).
 *
 * For the standalone hard-delete/purge cleanup and the orphan sweep — the
 * `local/<page_id>/` key is the numeric PK and belongs to exactly one page,
 * so unlike the Confluence-style tree there is no shared-keyspace question.
 * Throws on a non-integer id (a `NaN` would resolve to a literal `local/NaN`
 * directory); ENOENT is a no-op via `force`.
 */
export async function removeLocalAttachmentDirectory(
  pageId: number,
  client?: PoolClient,
): Promise<void> {
  if (!Number.isInteger(pageId) || pageId <= 0) {
    throw new LocalAttachmentError('INVALID_FILENAME', 'Invalid page id');
  }
  await withLocalAttachmentMutationLock(async () => {
    await fs.rm(localPageDir(pageId), { recursive: true, force: true });

  }, client);
}
type LocalAttachmentRecoveryFile = {
  filename: string;
  contentType: string;
  stageIndex: number;
  size: number;
  sha256: string;
};

function localAttachmentRecoveryEffect(intent: PageWriteRecoveryIntent): {
  pageId: number;
  files: LocalAttachmentRecoveryFile[];
} {
  const pageId = intent.effect.pageId;
  const rawFiles = intent.effect.files;
  if (
    typeof pageId !== 'number' ||
    !Number.isSafeInteger(pageId) ||
    !intent.pageIds.includes(pageId) ||
    !Array.isArray(rawFiles) ||
    rawFiles.length === 0
  ) {
    throw new Error('Local attachment recovery descriptor is invalid');
  }
  const files = rawFiles.map((raw): LocalAttachmentRecoveryFile => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Local attachment recovery file descriptor is invalid');
    }
    const file = raw as Record<string, unknown>;
    if (
      typeof file.filename !== 'string' ||
      !canStoreLocalFilename(file.filename) ||
      typeof file.contentType !== 'string' ||
      typeof file.stageIndex !== 'number' ||
      !Number.isSafeInteger(file.stageIndex) ||
      file.stageIndex < 0 ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error('Local attachment recovery file descriptor is invalid');
    }
    return {
      filename: file.filename,
      contentType: file.contentType,
      stageIndex: file.stageIndex,
      size: file.size,
      sha256: file.sha256,
    };
  });
  const stageIndexes = files.map((file) => file.stageIndex).sort((left, right) => left - right);
  if (stageIndexes.some((value, index) => value !== index)) {
    throw new Error('Local attachment recovery stage indexes are invalid');
  }
  files.sort((left, right) => left.filename.localeCompare(right.filename));
  return { pageId, files };
}

function attachmentStateDigest(files: LocalAttachmentRecoveryFile[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

type ObservedFileState = 'absent' | 'exact' | 'mismatch';

async function observeAttachmentFile(
  filePath: string,
  expected: LocalAttachmentRecoveryFile,
): Promise<ObservedFileState> {
  try {
    const bytes = await fs.readFile(filePath);
    return bytes.length === expected.size &&
      crypto.createHash('sha256').update(bytes).digest('hex') === expected.sha256
      ? 'exact'
      : 'mismatch';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

async function observeLocalAttachmentPut(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
) {
  const expected = localAttachmentRecoveryEffect(intent);
  const files = await Promise.all(expected.files.map(async (file) => ({
    file,
    finalState: await observeAttachmentFile(
      localFilePath(expected.pageId, file.filename),
      file,
    ),
    stageState: await observeAttachmentFile(
      path.join(
        localPageDir(expected.pageId),
        `.page-write-${intent.id}-${file.stageIndex}.stage`,
      ),
      file,
    ),
  })));
  const metadata = await client.query<{
    filename: string;
    content_type: string;
    size_bytes: string;
    sha256: string;
  }>(
    `SELECT filename, content_type, size_bytes::text, sha256
       FROM local_attachments
      WHERE page_id = $1 AND filename = ANY($2::text[])`,
    [expected.pageId, expected.files.map((file) => file.filename)],
  );
  const metadataByFilename = new Map(metadata.rows.map((row) => [row.filename, row]));
  const metadataMatches = metadata.rows.length === expected.files.length &&
    expected.files.every((file) => {
      const row = metadataByFilename.get(file.filename);
      return row !== undefined &&
        row.content_type === file.contentType &&
        Number(row.size_bytes) === file.size &&
        row.sha256 === file.sha256;
    });
  return { expected, files, metadataMatches };
}

async function reconcileLocalAttachmentPut(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
) {
  const observed = await observeLocalAttachmentPut(client, intent);
  const exactFinals = observed.files.filter(({ finalState }) => finalState === 'exact');
  const allFinalsExact = exactFinals.length === observed.files.length;
  const allStagesAbsent = observed.files.every(({ stageState }) => stageState === 'absent');
  const everyStageSafe = observed.files.every(
    ({ stageState }) => stageState === 'exact' || stageState === 'absent',
  );
  const exactStages = observed.files.filter(({ stageState }) => stageState === 'exact');
  const everyFileRecoverable = observed.files.every(
    ({ finalState, stageState }) => finalState === 'exact' || stageState === 'exact',
  );
  const intendedStateDigest = attachmentStateDigest(observed.expected.files);
  const intendedSize = observed.expected.files.reduce((total, file) => total + file.size, 0);
  const reference =
    `local-attachments:${observed.expected.pageId}:` +
    observed.expected.files.map((file) => file.filename).join(',');

  if (observed.metadataMatches && allStagesAbsent && allFinalsExact) {
    return {
      outcome: 'applied' as const,
      proof: {
        kind: 'local_bytes_verified' as const,
        observedAt: new Date().toISOString(),
        reference,
        details: {
          syscallSettled: true as const,
          intendedStateDigest,
          observedStateDigest: intendedStateDigest,
          intendedSize,
          observedSize: intendedSize,
        },
      },
      result: {
        pageId: observed.expected.pageId,
        files: observed.expected.files.map((file) => file.filename),
      },
    };
  }
  if (exactFinals.length === 0 && allStagesAbsent && !observed.metadataMatches) {
    return {
      outcome: 'not_applied' as const,
      proof: {
        kind: 'local_effect_absence_verified' as const,
        observedAt: new Date().toISOString(),
        reference,
        details: { syscallSettled: true as const, observedAbsent: true as const },
      },
      result: {
        pageId: observed.expected.pageId,
        files: observed.expected.files.map((file) => file.filename),
      },
    };
  }
  if (
    exactFinals.length === 0 &&
    exactStages.length > 0 &&
    everyStageSafe &&
    !observed.metadataMatches
  ) {
    return { outcome: 'repair_required' as const, observedState: 'staged_only' as const };
  }
  if (
    everyFileRecoverable &&
    (exactFinals.length > 0 || observed.metadataMatches)
  ) {
    return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
  }
  throw new Error('Local attachment effect is incomplete or does not match its durable descriptor');
}

async function repairLocalAttachmentPut(intent: PageWriteRecoveryIntent): Promise<void> {
  await advancePageWriteIntent(intent, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    const observed = await observeLocalAttachmentPut(client, intent);
    const exactFinals = observed.files.filter(({ finalState }) => finalState === 'exact');
    const everyStageSafe = observed.files.every(
      ({ stageState }) => stageState === 'exact' || stageState === 'absent',
    );
    const exactStages = observed.files.filter(({ stageState }) => stageState === 'exact');
    if (
      exactFinals.length === 0 &&
      exactStages.length > 0 &&
      everyStageSafe &&
      !observed.metadataMatches
    ) {
      for (const { file } of exactStages) {
        await fs.rm(
          path.join(
            localPageDir(observed.expected.pageId),
            `.page-write-${intent.id}-${file.stageIndex}.stage`,
          ),
        );
      }
      return;
    }
    const everyFileRecoverable = observed.files.every(
      ({ finalState, stageState }) => finalState === 'exact' || stageState === 'exact',
    );
    if (!everyFileRecoverable || (exactFinals.length === 0 && !observed.metadataMatches)) {
      throw new Error('Local attachment state changed before trusted repair');
    }
    if (!intent.actorId) {
      throw new Error('Local attachment repair has no active actor identity');
    }
    const activeActor = await client.query(
      'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
      [intent.actorId],
    );
    if (activeActor.rowCount !== 1) {
      throw new Error('Local attachment repair actor is no longer active');
    }
    await assertLocalPageAccess(observed.expected.pageId, intent.actorId, client);
    for (const { file, stageState } of observed.files) {
      if (stageState === 'exact') {
        await fs.rename(
          path.join(
            localPageDir(observed.expected.pageId),
            `.page-write-${intent.id}-${file.stageIndex}.stage`,
          ),
          localFilePath(observed.expected.pageId, file.filename),
        );
      }
    }
    for (const file of observed.expected.files) {
      await client.query(
        `INSERT INTO local_attachments
           (page_id, filename, content_type, size_bytes, sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (page_id, filename) DO UPDATE SET
           content_type = EXCLUDED.content_type,
           size_bytes = EXCLUDED.size_bytes,
           sha256 = EXCLUDED.sha256,
           updated_at = NOW()`,
        [
          observed.expected.pageId,
          file.filename,
          file.contentType,
          file.size,
          file.sha256,
          intent.actorId,
        ],
      );
    }
    await markPageImagesDirty(observed.expected.pageId, client);
    await client.query(
      'UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1',
      [observed.expected.pageId],
    );
  });
}

registerPageWriteIntentReconciler(
  'attachment.local.put',
  reconcileLocalAttachmentPut,
  repairLocalAttachmentPut,
);

export { MAX_LOCAL_ATTACHMENT_BYTES };
