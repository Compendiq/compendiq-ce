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
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

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
    public readonly code: 'NOT_FOUND' | 'PAGE_NOT_FOUND' | 'FORBIDDEN' | 'TOO_LARGE' | 'INVALID_FILENAME',
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

function localFilePath(pageId: number, filename: string): string {
  const safe = path.basename(filename);
  if (!safe || safe.startsWith('.') || safe.length > 255) {
    throw new LocalAttachmentError('INVALID_FILENAME', 'Filename is empty, hidden, or too long');
  }
  return path.join(localPageDir(pageId), safe);
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
async function assertLocalPageAccess(pageId: number, userId: string): Promise<{
  id: number;
  source: string;
  visibility: string;
  created_by_user_id: string | null;
}> {
  const res = await query<{
    id: number;
    source: string;
    visibility: string;
    created_by_user_id: string | null;
    deleted_at: Date | null;
  }>(
    `SELECT id, source, visibility, created_by_user_id, deleted_at
       FROM pages
      WHERE id = $1`,
    [pageId],
  );
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

/**
 * Persist a local attachment: writes bytes to disk and upserts the
 * `local_attachments` row. Returns the post-write record.
 */
export async function putLocalAttachment(opts: {
  pageId: number;
  filename: string;
  contentType: string;
  data: Buffer;
  userId: string;
}): Promise<LocalAttachmentRecord> {
  if (opts.data.length > MAX_LOCAL_ATTACHMENT_BYTES) {
    throw new LocalAttachmentError(
      'TOO_LARGE',
      `Attachment exceeds maximum size of ${MAX_LOCAL_ATTACHMENT_BYTES / (1024 * 1024)} MB`,
    );
  }
  await assertLocalPageAccess(opts.pageId, opts.userId);

  const dir = localPageDir(opts.pageId);
  const filePath = localFilePath(opts.pageId, opts.filename);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, opts.data);

  const sha = crypto.createHash('sha256').update(opts.data).digest('hex');

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
    [opts.pageId, path.basename(opts.filename), opts.contentType, opts.data.length, sha, opts.userId],
  );
  logger.info(
    { pageId: opts.pageId, filename: opts.filename, size: opts.data.length, userId: opts.userId },
    'local-attachment-service: wrote local attachment',
  );
  return mapRow(res.rows[0]!);
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

export { MAX_LOCAL_ATTACHMENT_BYTES };
