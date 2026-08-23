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
import { sniffImageFormat } from './image-validator.js';
import type { ImageFormat } from '@compendiq/contracts';

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

const EXT: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};

export async function writePageIconImage(
  pageId: number,
  bytes: Buffer,
): Promise<{ sha: string; format: ImageFormat }> {
  if (bytes.length > MAX_ICON_BYTES) {
    throw new PageIconStoreError('TOO_LARGE', 'Image is larger than 512 KB');
  }
  const format = sniffImageFormat(bytes);
  if (!format || format === 'gif') {
    throw new PageIconStoreError('UNSUPPORTED', 'Use a PNG, JPEG, or WebP image');
  }
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = pageIconDir(pageId);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sha}.${EXT[format]}`), bytes);
  return { sha, format };
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

export async function deletePageIconImage(pageId: number): Promise<void> {
  await fs.rm(pageIconDir(pageId), { recursive: true, force: true });
}

export { MAX_ICON_BYTES };
