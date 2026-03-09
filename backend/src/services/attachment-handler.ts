import fs from 'fs/promises';
import path from 'path';
import { ConfluenceClient } from './confluence-client.js';
import { logger } from '../utils/logger.js';

const ATTACHMENTS_BASE = process.env.ATTACHMENTS_DIR ?? 'data/attachments';

function attachmentDir(userId: string, pageId: string): string {
  return path.join(ATTACHMENTS_BASE, userId, pageId);
}

function attachmentPath(userId: string, pageId: string, filename: string): string {
  // Sanitize filename to prevent path traversal
  const safe = path.basename(filename);
  return path.join(attachmentDir(userId, pageId), safe);
}

/**
 * Download and cache a draw.io attachment locally.
 */
export async function cacheAttachment(
  client: ConfluenceClient,
  userId: string,
  pageId: string,
  downloadPath: string,
  filename: string,
): Promise<string> {
  const dir = attachmentDir(userId, pageId);
  await fs.mkdir(dir, { recursive: true });

  const filePath = attachmentPath(userId, pageId, filename);
  const data = await client.downloadAttachment(downloadPath);
  await fs.writeFile(filePath, data);

  logger.debug({ userId, pageId, filename }, 'Cached attachment');
  return filePath;
}

/**
 * Check if an attachment exists locally.
 */
export async function attachmentExists(userId: string, pageId: string, filename: string): Promise<boolean> {
  try {
    await fs.access(attachmentPath(userId, pageId, filename));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a cached attachment.
 */
export async function readAttachment(userId: string, pageId: string, filename: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(attachmentPath(userId, pageId, filename));
  } catch {
    return null;
  }
}

/**
 * Get the MIME type from filename extension.
 */
export function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };
  return mimeTypes[ext] ?? 'application/octet-stream';
}

/**
 * Sync draw.io attachments for a page.
 */
export async function syncDrawioAttachments(
  client: ConfluenceClient,
  userId: string,
  pageId: string,
  bodyStorage: string,
): Promise<string[]> {
  // Find drawio macro names in the storage format
  const drawioPattern = /ac:structured-macro[^>]*ac:name="drawio"[^>]*>[\s\S]*?<ac:parameter ac:name="diagramName">([^<]+)<\/ac:parameter/g;
  const diagramNames: string[] = [];
  let match;

  while ((match = drawioPattern.exec(bodyStorage)) !== null) {
    diagramNames.push(match[1]);
  }

  if (diagramNames.length === 0) return [];

  // Fetch page attachments from Confluence
  const { results: attachments } = await client.getPageAttachments(pageId);
  const cachedFiles: string[] = [];

  for (const name of diagramNames) {
    // Draw.io attachments typically have .png suffix
    const pngName = `${name}.png`;
    const attachment = attachments.find(
      (a) => a.title === pngName || a.title === name,
    );

    if (attachment?._links?.download) {
      try {
        await cacheAttachment(client, userId, pageId, attachment._links.download, pngName);
        cachedFiles.push(pngName);
      } catch (err) {
        logger.error({ err, pageId, name }, 'Failed to cache draw.io attachment');
      }
    }
  }

  return cachedFiles;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

/**
 * Sync image attachments referenced in a page's XHTML body.
 * Downloads all <ac:image><ri:attachment ri:filename="..."> images from Confluence.
 */
export async function syncImageAttachments(
  client: ConfluenceClient,
  userId: string,
  pageId: string,
  bodyStorage: string,
): Promise<string[]> {
  // Find image attachment filenames in the storage format
  const imagePattern = /<ac:image[^>]*>[\s\S]*?<ri:attachment\s+ri:filename="([^"]+)"[\s\S]*?<\/ac:image>/g;
  const filenames: string[] = [];
  let match;

  while ((match = imagePattern.exec(bodyStorage)) !== null) {
    filenames.push(match[1]);
  }

  if (filenames.length === 0) return [];

  // Fetch page attachments from Confluence
  const { results: attachments } = await client.getPageAttachments(pageId);
  const cachedFiles: string[] = [];

  for (const filename of filenames) {
    // Only sync known image types
    const ext = path.extname(filename).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;

    const attachment = attachments.find((a) => a.title === filename);

    if (attachment?._links?.download) {
      try {
        await cacheAttachment(client, userId, pageId, attachment._links.download, filename);
        cachedFiles.push(filename);
      } catch (err) {
        logger.error({ err, pageId, filename }, 'Failed to cache image attachment');
      }
    }
  }

  return cachedFiles;
}

/**
 * Clean up all attachments for a page.
 */
export async function cleanPageAttachments(userId: string, pageId: string): Promise<void> {
  const dir = attachmentDir(userId, pageId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }
}

/**
 * Clean up all attachments for a user (on PAT change).
 */
export async function cleanUserAttachments(userId: string): Promise<void> {
  const dir = path.join(ATTACHMENTS_BASE, userId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }
}
