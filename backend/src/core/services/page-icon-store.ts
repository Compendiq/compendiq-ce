/**
 * Dedicated blob store for uploaded page marks.
 *
 * Not a page attachment: these files never appear in the attachments macro
 * and are not referenced from body_html. Layout:
 *
 *   <ATTACHMENTS_DIR>/page-icons/<pageId>/<sha>.<ext>
 *
 * Path resolution is call-time so tests can override ATTACHMENTS_DIR.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../db/advisory-locks.js';
import { withLocalAttachmentMutationLock } from './attachment-snapshot-lock.js';
import { sniffImageFormat } from './image-validator.js';
import { logger } from '../utils/logger.js';
import { getUserAccessibleSpaces } from './rbac-service.js';
import type { ImageFormat } from '@compendiq/contracts';
import {
  advancePageWriteIntent,
  registerPageWriteIntentReconciler,
  type PageWriteRecoveryIntent,
  type PageWriteIntent,
} from './page-write-admission.js';

/**
 * The reserved entry name this store owns under `ATTACHMENTS_DIR` (#1349).
 *
 * Exported because it is a RESERVATION, not an implementation detail: the tree
 * sits inside the Confluence-style attachment root and `page-icons` matches
 * that tree's key allow-list, so any walker over the root must skip it by name
 * or judge it a keyless — hence orphaned — directory. Migrations 095/096 store
 * only the sha, so these files are the only copy of an uploaded mark.
 */
export const PAGE_ICON_STORE_DIRNAME = 'page-icons';
const SUBDIR = PAGE_ICON_STORE_DIRNAME;
const MAX_ICON_BYTES = 512 * 1024;

export class PageIconStoreError extends Error {
  constructor(
    public readonly code: 'TOO_LARGE' | 'UNSUPPORTED' | 'NOT_FOUND' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'PageIconStoreError';
  }
}

function attachmentsBase(): string {
  return process.env.ATTACHMENTS_DIR ?? 'data/attachments';
}

function pageIconDir(pageId: number): string {
  const base = attachmentsBase();
  const dir = path.join(base, SUBDIR, String(pageId));
  const resolved = path.resolve(dir);
  const baseResolved = path.resolve(base);
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new PageIconStoreError('FORBIDDEN', 'Path resolution escaped attachments base');
  }
  return dir;
}
function pageIconStageDir(pageId: number): string {
  return path.join(attachmentsBase(), SUBDIR, '.staging', String(pageId));
}

function pageIconActivationMarker(pageId: number, intentId: string): string {
  return path.join(pageIconStageDir(pageId), `${intentId}.activating`);
}

const EXT: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};

export interface StagedPageIconImage {
  sha: string;
  format: ImageFormat;
  stagePath: string;
}

export function validatePageIconImage(bytes: Buffer): { sha: string; format: ImageFormat } {
  if (bytes.length > MAX_ICON_BYTES) {
    throw new PageIconStoreError('TOO_LARGE', 'Image is larger than 512 KB');
  }
  const format = sniffImageFormat(bytes);
  if (!format || format === 'gif') {
    throw new PageIconStoreError('UNSUPPORTED', 'Use a PNG, JPEG, or WebP image');
  }
  return {
    sha: crypto.createHash('sha256').update(bytes).digest('hex'),
    format,
  };
}

/** Write an exclusive, non-live icon stage after durable admission. */
export async function stagePageIconImage(
  pageId: number,
  intent: PageWriteIntent,
  bytes: Buffer,
): Promise<StagedPageIconImage> {
  const image = validatePageIconImage(bytes);
  const stageDir = pageIconStageDir(pageId);
  await fs.mkdir(stageDir, { recursive: true });
  const stagePath = path.join(stageDir, `${intent.id}.${EXT[image.format]}.stage`);
  const handle = await fs.open(stagePath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { ...image, stagePath };
}

/**
 * Activate a staged icon while the caller holds the intent lifecycle lock and
 * transaction-scoped backup barrier. The caller owns the surrounding effect
 * gate so durable markers are never updated from inside the locked transaction.
 */
export async function activatePageIconImage(
  pageId: number,
  staged: StagedPageIconImage,
  intent: PageWriteIntent,
  client: PoolClient,
): Promise<{ sha: string; format: ImageFormat }> {
  await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
  const markerPath = pageIconActivationMarker(pageId, intent.id);
  const marker = await fs.open(markerPath, 'wx', 0o600);
  try {
    await marker.writeFile('activating');
    await marker.sync();
  } finally {
    await marker.close();
  }
  const dir = pageIconDir(pageId);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.rename(staged.stagePath, path.join(dir, `${staged.sha}.${EXT[staged.format]}`));
  await fs.rm(markerPath);
  return { sha: staged.sha, format: staged.format };
}


export async function readPageIconImage(
  pageId: number,
  sha: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(sha)) return null;
  const dir = pageIconDir(pageId);
  for (const [format, ext] of Object.entries(EXT) as [ImageFormat, string][]) {
    const file = path.join(dir, `${sha}.${ext}`);
    try {
      const bytes = await fs.readFile(file);
      const contentType =
        format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/gif';
      return { bytes, contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

/**
 * Remove only the uploaded icon named by the page's durable metadata.
 *
 * The directory can contain unreadable or foreign residue after a crash. A
 * metadata patch owns the exact previous SHA, not every byte under the page
 * namespace, so unknown entries are deliberately preserved.
 */
export async function deletePageIconImage(
  pageId: number,
  expectedSha256: string,
  client: PoolClient,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new PageIconStoreError('NOT_FOUND', 'Uploaded page icon identity is invalid');
  }
  await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
  const dir = pageIconDir(pageId);
  await Promise.all(
    Object.values(EXT).map((ext) =>
      fs.rm(path.join(dir, `${expectedSha256}.${ext}`), { force: true })),
  );
  try {
    if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Evidence passed by a caller that obtained the id from its committed
 * `DELETE ... RETURNING id`. The callee still verifies absence before touching
 * the namespace, so a fabricated/stale token fails closed.
 */
export interface CommittedPageDeletion {
  id: number;
}

/**
 * Remove an icon namespace after its owning page row was hard-deleted.
 *
 * This is intentionally not a page write intent: there is no page left to
 * reserve. The committed deletion is the authority, and a surviving/recreated
 * row makes the helper preserve every byte.
 */
export async function discardPageIconForDeletedPage(
  deletion: CommittedPageDeletion,
  client?: PoolClient,
): Promise<void> {
  const pageId = deletion.id;
  try {
    if (!Number.isSafeInteger(pageId) || pageId <= 0) {
      throw new Error('Invalid committed page deletion id');
    }
    await withLocalAttachmentMutationLock(async (lockClient) => {
      const existing = await lockClient.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pages WHERE id = $1) AS exists',
        [pageId],
      );
      if (existing.rows[0]?.exists) {
        logger.warn(
          { pageId },
          'page-icon-store: refused to remove an icon namespace without a committed page deletion',
        );
        return;
      }
      await fs.rm(pageIconDir(pageId), { recursive: true, force: true });
    }, client);
  } catch (err) {
    logger.warn(
      { err, pageId },
      'page-icon-store: could not remove a hard-deleted page’s icon directory (orphaned files only — DB is consistent)',
    );
  }
}

async function assertPageIconRepairAccess(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
  pageId: number,
): Promise<void> {
  if (!intent.actorId) {
    throw new Error('Page icon repair has no active actor identity');
  }
  const access = await client.query<{
    source: string;
    created_by_user_id: string | null;
    visibility: string;
    space_key: string | null;
    deleted_at: Date | null;
    deactivated_at: Date | null;
  }>(
    `SELECT p.source, p.created_by_user_id, p.visibility, p.space_key, p.deleted_at,
            u.deactivated_at
       FROM pages p
       JOIN users u ON u.id = $2
      WHERE p.id = $1`,
    [pageId, intent.actorId],
  );
  const row = access.rows[0];
  if (!row || row.deactivated_at || row.deleted_at) {
    throw new Error('Page icon repair actor is no longer authorized');
  }
  if (row.source === 'standalone') {
    if (row.created_by_user_id !== intent.actorId && row.visibility !== 'shared') {
      throw new Error('Page icon repair actor is no longer authorized');
    }
    return;
  }
  if (row.space_key) {
    const spaces = await getUserAccessibleSpaces(intent.actorId, client);
    if (!spaces.includes(row.space_key)) {
      throw new Error('Page icon repair actor is no longer authorized');
    }
  }
}

type ObservedFileState = 'absent' | 'exact' | 'mismatch';

type PageIconPutDescriptor = {
  pageId: number;
  sha256: string;
  size: number;
  format: Exclude<ImageFormat, 'gif'>;
  expectsMetadata: boolean;
  filename: string;
  stagePath: string;
  markerPath: string;
};

function pageIconPutDescriptor(intent: PageWriteRecoveryIntent): PageIconPutDescriptor {
  const pageId = intent.effect.pageId;
  const sha256 = intent.effect.sha256;
  const size = intent.effect.size;
  const format = intent.effect.format;
  const expectsMetadata = intent.effect.expectsMetadata;
  if (
    typeof pageId !== 'number' ||
    !Number.isSafeInteger(pageId) ||
    !intent.pageIds.includes(pageId) ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    (format !== 'png' && format !== 'jpeg' && format !== 'webp') ||
    typeof expectsMetadata !== 'boolean'
  ) {
    throw new Error('Page icon recovery descriptor is invalid');
  }
  const filename = `${sha256}.${EXT[format]}`;
  return {
    pageId,
    sha256,
    size,
    format,
    expectsMetadata,
    filename,
    stagePath: path.join(pageIconStageDir(pageId), `${intent.id}.${EXT[format]}.stage`),
    markerPath: pageIconActivationMarker(pageId, intent.id),
  };
}

async function observeIconBytes(
  filePath: string,
  descriptor: PageIconPutDescriptor,
): Promise<ObservedFileState> {
  try {
    const bytes = await fs.readFile(filePath);
    return bytes.length === descriptor.size &&
      crypto.createHash('sha256').update(bytes).digest('hex') === descriptor.sha256
      ? 'exact'
      : 'mismatch';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

async function observePageIconPut(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
) {
  const descriptor = pageIconPutDescriptor(intent);
  const [finalState, stageState, markerState, entries, page] = await Promise.all([
    observeIconBytes(path.join(pageIconDir(descriptor.pageId), descriptor.filename), descriptor),
    observeIconBytes(descriptor.stagePath, descriptor),
    fs.readFile(descriptor.markerPath, 'utf8').then(
      (value): ObservedFileState => value === 'activating' ? 'exact' : 'mismatch',
      (err: NodeJS.ErrnoException): ObservedFileState => {
        if (err.code === 'ENOENT') return 'absent';
        throw err;
      },
    ),
    fs.readdir(pageIconDir(descriptor.pageId)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    }),
    client.query<{ icon_kind: string | null; icon_value: string | null }>(
      'SELECT icon_kind, icon_value FROM pages WHERE id = $1',
      [descriptor.pageId],
    ),
  ]);
  const metadataShowsIntended = page.rows[0]?.icon_kind === 'image' &&
    page.rows[0]?.icon_value === descriptor.sha256;
  return {
    descriptor,
    finalState,
    stageState,
    markerState,
    entries,
    metadataShowsIntended,
  };
}

async function reconcilePageIconPut(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
) {
  const observed = await observePageIconPut(client, intent);
  const metadataMatches = !observed.descriptor.expectsMetadata ||
    observed.metadataShowsIntended;
  const directoryExact =
    observed.entries.length === 1 &&
    observed.entries[0] === observed.descriptor.filename;
  const reference =
    `page-icon:${observed.descriptor.pageId}:${observed.descriptor.filename}`;

  if (
    observed.finalState === 'exact' &&
    observed.stageState === 'absent' &&
    observed.markerState === 'absent' &&
    directoryExact &&
    metadataMatches
  ) {
    return {
      outcome: 'applied' as const,
      proof: {
        kind: 'local_bytes_verified' as const,
        observedAt: new Date().toISOString(),
        reference,
        details: {
          syscallSettled: true as const,
          intendedStateDigest: observed.descriptor.sha256,
          observedStateDigest: observed.descriptor.sha256,
          intendedSize: observed.descriptor.size,
          observedSize: observed.descriptor.size,
        },
      },
      result: {
        pageId: observed.descriptor.pageId,
        sha256: observed.descriptor.sha256,
        format: observed.descriptor.format,
      },
    };
  }
  if (
    observed.finalState === 'absent' &&
    observed.stageState === 'absent' &&
    observed.markerState === 'absent' &&
    !observed.metadataShowsIntended
  ) {
    return {
      outcome: 'not_applied' as const,
      proof: {
        kind: 'local_effect_absence_verified' as const,
        observedAt: new Date().toISOString(),
        reference,
        details: { syscallSettled: true as const, observedAbsent: true as const },
      },
      result: {
        pageId: observed.descriptor.pageId,
        sha256: observed.descriptor.sha256,
        format: observed.descriptor.format,
      },
    };
  }
  if (
    observed.stageState === 'exact' &&
    observed.finalState !== 'exact' &&
    observed.markerState === 'absent' &&
    !observed.metadataShowsIntended
  ) {
    return { outcome: 'repair_required' as const, observedState: 'staged_only' as const };
  }
  if (
    observed.markerState === 'exact' &&
    (observed.stageState === 'exact' || observed.finalState === 'exact')
  ) {
    return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
  }
  if (
    observed.finalState === 'exact' &&
    observed.stageState !== 'mismatch' &&
    observed.markerState !== 'mismatch'
  ) {
    return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
  }
  if (
    observed.metadataShowsIntended &&
    (observed.stageState === 'exact' || observed.finalState === 'exact')
  ) {
    return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
  }
  throw new Error('Page icon effect is incomplete or does not match its durable descriptor');
}

async function repairPageIconPut(intent: PageWriteRecoveryIntent): Promise<void> {
  await advancePageWriteIntent(intent, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    const observed = await observePageIconPut(client, intent);
    if (
      observed.stageState === 'exact' &&
      observed.finalState !== 'exact' &&
      observed.markerState === 'absent' &&
      !observed.metadataShowsIntended
    ) {
      await fs.rm(observed.descriptor.stagePath);
      return;
    }
    if (
      observed.stageState === 'mismatch' ||
      observed.markerState === 'mismatch' ||
      (observed.stageState !== 'exact' && observed.finalState !== 'exact')
    ) {
      throw new Error('Page icon state changed before trusted repair');
    }
    await assertPageIconRepairAccess(client, intent, observed.descriptor.pageId);
    if (observed.stageState === 'exact') {
      if (observed.markerState === 'absent') {
        const marker = await fs.open(observed.descriptor.markerPath, 'wx', 0o600);
        try {
          await marker.writeFile('activating');
          await marker.sync();
        } finally {
          await marker.close();
        }
      }
      await fs.rm(pageIconDir(observed.descriptor.pageId), { recursive: true, force: true });
      await fs.mkdir(pageIconDir(observed.descriptor.pageId), { recursive: true });
      await fs.rename(
        observed.descriptor.stagePath,
        path.join(pageIconDir(observed.descriptor.pageId), observed.descriptor.filename),
      );
    } else {
      for (const entry of observed.entries) {
        if (entry !== observed.descriptor.filename) {
          await fs.rm(path.join(pageIconDir(observed.descriptor.pageId), entry), {
            recursive: true,
            force: true,
          });
        }
      }
    }
    await fs.rm(observed.descriptor.markerPath, { force: true });
    if (
      observed.descriptor.expectsMetadata &&
      !observed.metadataShowsIntended
    ) {
      await client.query(
        `UPDATE pages
            SET icon_kind = 'image', icon_value = $2, icon_color = NULL,
                icon_filled = FALSE, content_revision = content_revision + 1
          WHERE id = $1`,
        [observed.descriptor.pageId, observed.descriptor.sha256],
      );
    } else if (!observed.descriptor.expectsMetadata) {
      await client.query(
        'UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1',
        [observed.descriptor.pageId],
      );
    }
  });
}

export async function pageIconDirectoryAbsent(pageId: number): Promise<boolean> {
  try {
    await fs.stat(pageIconDir(pageId));
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

async function reconcilePageIconDelete(
  _client: PoolClient,
  intent: PageWriteRecoveryIntent,
) {
  const pageId = intent.effect.pageId;
  const intendedIdentity = intent.effect.intendedIdentity;
  if (
    typeof pageId !== 'number' ||
    !Number.isSafeInteger(pageId) ||
    !intent.pageIds.includes(pageId) ||
    typeof intendedIdentity !== 'string' ||
    intendedIdentity !== `page-icons/${pageId}`
  ) {
    throw new Error('Page icon deletion recovery descriptor is invalid');
  }
  if (!(await pageIconDirectoryAbsent(pageId))) {
    if (intent.effectStartedAt === null) {
      return {
        outcome: 'not_applied' as const,
        proof: {
          kind: 'local_effect_absence_verified' as const,
          observedAt: new Date().toISOString(),
          reference: `page-icon-delete:${pageId}`,
          details: { syscallSettled: true as const, observedAbsent: true as const },
        },
        result: { pageId },
      };
    }
    return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
  }
  return {
    outcome: 'applied' as const,
    proof: {
      kind: 'local_intended_absence_verified' as const,
      observedAt: new Date().toISOString(),
      reference: `page-icon-delete:${pageId}`,
      details: {
        syscallSettled: true as const,
        observedAbsent: true as const,
        intendedIdentity,
      },
    },
    result: { pageId },
  };
}

async function repairPageIconDelete(intent: PageWriteRecoveryIntent): Promise<void> {
  const pageId = intent.effect.pageId;
  const intendedIdentity = intent.effect.intendedIdentity;
  if (
    typeof pageId !== 'number' ||
    !Number.isSafeInteger(pageId) ||
    !intent.pageIds.includes(pageId) ||
    intendedIdentity !== `page-icons/${pageId}`
  ) {
    throw new Error('Page icon deletion recovery descriptor is invalid');
  }
  await advancePageWriteIntent(intent, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    if (await pageIconDirectoryAbsent(pageId)) return;
    await assertPageIconRepairAccess(client, intent, pageId);
    await fs.rm(pageIconDir(pageId), { recursive: true, force: true });
    await client.query(
      'UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1',
      [pageId],
    );
  });
}

type PriorIconState = 'absent' | 'exact' | 'mismatch';

async function observePriorIcon(pageId: number, sha256: string): Promise<PriorIconState> {
  const observed: Buffer[] = [];
  for (const ext of Object.values(EXT)) {
    try {
      observed.push(await fs.readFile(path.join(pageIconDir(pageId), `${sha256}.${ext}`)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  if (observed.length === 0) return 'absent';
  if (observed.length !== 1) return 'mismatch';
  return crypto.createHash('sha256').update(observed[0]!).digest('hex') === sha256
    ? 'exact'
    : 'mismatch';
}

type IconMetadataPatchDescriptor = {
  pageId: number;
  iconKind: string | null;
  iconValue: string | null;
  iconColor: string | null;
  iconFilled: boolean;
  removesUploadedImage: boolean;
  previousSha256: string | null;
};

function iconMetadataPatchDescriptor(
  intent: PageWriteRecoveryIntent,
): IconMetadataPatchDescriptor {
  const pageId = intent.effect.pageId;
  const iconKind = intent.effect.iconKind;
  const iconValue = intent.effect.iconValue;
  const iconColor = intent.effect.iconColor;
  const iconFilled = intent.effect.iconFilled;
  const removesUploadedImage = intent.effect.removesUploadedImage;
  const previousSha256 = intent.effect.previousSha256;
  if (
    typeof pageId !== 'number' ||
    !Number.isSafeInteger(pageId) ||
    !intent.pageIds.includes(pageId) ||
    (iconKind !== null && iconKind !== 'emoji' && iconKind !== 'lucide' && iconKind !== 'brand') ||
    (iconValue !== null && typeof iconValue !== 'string') ||
    (iconColor !== null && typeof iconColor !== 'string') ||
    typeof iconFilled !== 'boolean' ||
    typeof removesUploadedImage !== 'boolean' ||
    (removesUploadedImage &&
      (typeof previousSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(previousSha256))) ||
    (!removesUploadedImage && previousSha256 !== null)
  ) {
    throw new Error('Page icon metadata recovery descriptor is not independently verifiable');
  }
  return {
    pageId,
    iconKind,
    iconValue,
    iconColor,
    iconFilled,
    removesUploadedImage,
    previousSha256: typeof previousSha256 === 'string' ? previousSha256 : null,
  };
}

async function observeIconMetadataPatch(
  client: PoolClient,
  descriptor: IconMetadataPatchDescriptor,
) {
  const page = await client.query<{
    icon_kind: string | null;
    icon_value: string | null;
    icon_color: string | null;
    icon_filled: boolean | null;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT icon_kind, icon_value, icon_color, icon_filled,
            content_revision::text, lifecycle_revision::text
       FROM pages WHERE id = $1`,
    [descriptor.pageId],
  );
  const row = page.rows[0];
  const metadataMatches = Boolean(row) &&
    row!.icon_kind === descriptor.iconKind &&
    row!.icon_value === descriptor.iconValue &&
    row!.icon_color === descriptor.iconColor &&
    Boolean(row!.icon_filled) === descriptor.iconFilled;
  const metadataShowsPrevious = Boolean(row) &&
    descriptor.previousSha256 !== null &&
    row!.icon_kind === 'image' &&
    row!.icon_value === descriptor.previousSha256;
  const previousState = descriptor.previousSha256 === null
    ? 'absent' as const
    : await observePriorIcon(descriptor.pageId, descriptor.previousSha256);
  return { row, metadataMatches, metadataShowsPrevious, previousState };
}

async function reconcilePageIconMetadataPatch(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
) {
  const descriptor = iconMetadataPatchDescriptor(intent);
  const observed = await observeIconMetadataPatch(client, descriptor);
  const expectedRevision = intent.revisions[descriptor.pageId];
  const revisionsMatch = Boolean(observed.row && expectedRevision) &&
    observed.row!.content_revision === expectedRevision?.contentRevision &&
    observed.row!.lifecycle_revision === expectedRevision?.lifecycleRevision;
  const reference = `page-icon-metadata:${descriptor.pageId}`;

  // Metadata-only patches settle in the same transaction as the intent. A
  // pending row therefore proves they did not commit.
  if (!descriptor.removesUploadedImage) {
    if (intent.effectStartedAt !== null || observed.metadataMatches || !revisionsMatch) {
      throw new Error('Page icon metadata result cannot be distinguished from pre-existing state');
    }
    return {
      outcome: 'not_applied' as const,
      proof: {
        kind: 'local_effect_absence_verified' as const,
        observedAt: new Date().toISOString(),
        reference,
        details: { syscallSettled: true as const, observedAbsent: true as const },
      },
      result: { pageId: descriptor.pageId },
    };
  }

  if (observed.previousState === 'mismatch') {
    throw new Error('Previous page icon bytes do not match their durable identity');
  }
  const intendedIdentity =
    `page-icons/${descriptor.pageId}/${descriptor.previousSha256}`;
  if (
    intent.effectStartedAt !== null &&
    observed.metadataMatches &&
    observed.previousState === 'absent'
  ) {
    return {
      outcome: 'applied' as const,
      proof: {
        kind: 'local_intended_absence_verified' as const,
        observedAt: new Date().toISOString(),
        reference,
        details: {
          syscallSettled: true as const,
          observedAbsent: true as const,
          intendedIdentity,
        },
      },
      result: { pageId: descriptor.pageId },
    };
  }
  if (
    intent.effectStartedAt === null &&
    observed.metadataShowsPrevious &&
    revisionsMatch &&
    observed.previousState === 'exact'
  ) {
    return {
      outcome: 'not_applied' as const,
      proof: {
        kind: 'local_effect_absence_verified' as const,
        observedAt: new Date().toISOString(),
        reference,
        details: { syscallSettled: true as const, observedAbsent: true as const },
      },
      result: { pageId: descriptor.pageId },
    };
  }
  if (
    intent.effectStartedAt !== null &&
    (observed.metadataMatches || observed.metadataShowsPrevious) &&
    (observed.previousState === 'exact' || observed.previousState === 'absent')
  ) {
    return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
  }
  throw new Error('Page icon metadata changed before trusted reconciliation');
}

async function repairPageIconMetadataPatch(intent: PageWriteRecoveryIntent): Promise<void> {
  const descriptor = iconMetadataPatchDescriptor(intent);
  if (!descriptor.removesUploadedImage || descriptor.previousSha256 === null) {
    throw new Error('Page icon metadata repair has no uploaded image identity');
  }
  const previousSha256 = descriptor.previousSha256;
  await advancePageWriteIntent(intent, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    const observed = await observeIconMetadataPatch(client, descriptor);
    if (observed.previousState === 'mismatch') {
      throw new Error('Previous page icon bytes changed before trusted repair');
    }
    if (!observed.metadataMatches && !observed.metadataShowsPrevious) {
      throw new Error('Page icon metadata changed before trusted repair');
    }
    await assertPageIconRepairAccess(client, intent, descriptor.pageId);
    if (observed.previousState === 'exact') {
      await deletePageIconImage(descriptor.pageId, previousSha256, client);
    }
    if (!observed.metadataMatches) {
      await client.query(
        `UPDATE pages
            SET icon_kind = $2, icon_value = $3, icon_color = $4, icon_filled = $5,
                content_revision = content_revision + 1
          WHERE id = $1`,
        [
          descriptor.pageId,
          descriptor.iconKind,
          descriptor.iconValue,
          descriptor.iconColor,
          descriptor.iconFilled,
        ],
      );
    }
  });
}

registerPageWriteIntentReconciler(
  'icon.image.put',
  reconcilePageIconPut,
  repairPageIconPut,
);
registerPageWriteIntentReconciler(
  'icon.image.delete',
  reconcilePageIconDelete,
  repairPageIconDelete,
);
registerPageWriteIntentReconciler(
  'icon.metadata.patch',
  reconcilePageIconMetadataPatch,
  repairPageIconMetadataPatch,
);
export { MAX_ICON_BYTES };

