import fs from 'fs/promises';
import path from 'path';
import { JSDOM } from 'jsdom';
import { ConfluenceClient, ConfluenceAttachment } from './confluence-client.js';
import { logger } from '../utils/logger.js';

const ATTACHMENTS_BASE = process.env.ATTACHMENTS_DIR ?? 'data/attachments';

/**
 * Files larger than this threshold are streamed directly to disk
 * instead of buffering in memory. Default: 5 MB.
 */
export const STREAM_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * Maximum allowed attachment size for streaming downloads. Default: 50 MB.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * Attachments are now stored in a shared directory keyed only by pageId.
 * The userId parameter is kept in public-facing functions for backward
 * compatibility with callers, but is no longer used in the path.
 */
function attachmentDir(_userId: string, pageId: string): string {
  return path.join(ATTACHMENTS_BASE, pageId);
}

function attachmentPath(userId: string, pageId: string, filename: string): string {
  // Sanitize filename to prevent path traversal
  const safe = path.basename(filename);
  return path.join(attachmentDir(userId, pageId), safe);
}

/**
 * Download and cache an attachment locally.
 * Uses streaming for files above STREAM_THRESHOLD_BYTES to avoid
 * buffering large attachments in memory.
 *
 * @param fileSizeHint - Optional known file size in bytes. When provided and above
 *   the streaming threshold, the download is streamed directly to disk.
 */
export async function cacheAttachment(
  client: ConfluenceClient,
  userId: string,
  pageId: string,
  downloadPath: string,
  filename: string,
  fileSizeHint?: number,
): Promise<string> {
  const dir = attachmentDir(userId, pageId);
  await fs.mkdir(dir, { recursive: true });

  const filePath = attachmentPath(userId, pageId, filename);

  const useStreaming = fileSizeHint !== undefined && fileSizeHint > STREAM_THRESHOLD_BYTES;

  if (useStreaming) {
    logger.debug({ userId, pageId, filename, fileSizeHint }, 'Streaming large attachment to disk');
    await client.downloadAttachmentToFile(downloadPath, filePath, MAX_ATTACHMENT_BYTES);
  } else {
    const data = await client.downloadAttachment(downloadPath);
    await fs.writeFile(filePath, data);
  }

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
    '.xml': 'application/xml',
  };
  return mimeTypes[ext] ?? 'application/octet-stream';
}

/**
 * Parse draw.io diagram names from Confluence XHTML storage format using JSDOM.
 * Handles arbitrary attribute ordering and nested parameters reliably,
 * unlike fragile regex approaches.
 */
function extractDrawioDiagramNames(bodyStorage: string): string[] {
  const dom = new JSDOM(`<body>${bodyStorage}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;
  const names: string[] = [];

  for (const macro of [...doc.getElementsByTagName('ac:structured-macro')]) {
    const macroName = macro.getAttribute('ac:name') ?? macro.getAttribute('data-macro-name') ?? '';
    if (macroName !== 'drawio') continue;

    for (const param of [...macro.getElementsByTagName('ac:parameter')]) {
      if (param.getAttribute('ac:name') === 'diagramName') {
        const value = param.textContent?.trim();
        if (value) names.push(value);
        break;
      }
    }
  }

  return names;
}

/**
 * Sync draw.io attachments for a page.
 * Prefers the PNG export attachment; falls back to the raw XML source file
 * when no PNG export is available (e.g. diagrams stored as `.xml` only).
 * Skips download if a cached copy already exists (idempotent).
 * Accepts pre-fetched attachments to avoid duplicate API calls.
 */
export async function syncDrawioAttachments(
  client: ConfluenceClient,
  userId: string,
  pageId: string,
  bodyStorage: string,
  attachments: ConfluenceAttachment[],
): Promise<string[]> {
  const diagramNames = extractDrawioDiagramNames(bodyStorage);
  if (diagramNames.length === 0) return [];

  const cachedFiles: string[] = [];

  for (const name of diagramNames) {
    // Prefer the PNG export; fall back to the raw XML source file.
    const pngName = `${name}.png`;
    const xmlName = `${name}.xml`;

    let attachment = attachments.find((a) => a.title === pngName);
    let cacheAs = pngName;

    if (!attachment) {
      // Fall back to XML attachment or attachment stored without extension
      const xmlAttachment = attachments.find((a) => a.title === xmlName || a.title === name);
      if (xmlAttachment) {
        attachment = xmlAttachment;
        // Preserve the actual attachment title to avoid saving with the wrong extension
        cacheAs = xmlAttachment.title;
      }
    }

    if (attachment?._links?.download) {
      try {
        const filePath = attachmentPath(userId, pageId, cacheAs);

        // Skip download if already cached (idempotent)
        try {
          await fs.access(filePath);
          cachedFiles.push(cacheAs);
          continue;
        } catch {
          // File does not exist — proceed with download
        }

        const fileSize = attachment.extensions?.fileSize;
        await cacheAttachment(client, userId, pageId, attachment._links.download, cacheAs, fileSize);
        cachedFiles.push(cacheAs);
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
 * Skips download if a cached copy already exists (idempotent).
 * Accepts pre-fetched attachments to avoid duplicate API calls.
 */
export async function syncImageAttachments(
  client: ConfluenceClient,
  userId: string,
  pageId: string,
  bodyStorage: string,
  attachments: ConfluenceAttachment[],
): Promise<string[]> {
  // Find image attachment filenames in the storage format
  const imagePattern = /<ac:image[^>]*>[\s\S]*?<ri:attachment\s+ri:filename="([^"]+)"[\s\S]*?<\/ac:image>/g;
  const filenames: string[] = [];
  let match;

  while ((match = imagePattern.exec(bodyStorage)) !== null) {
    filenames.push(match[1]);
  }

  if (filenames.length === 0) return [];

  const cachedFiles: string[] = [];

  for (const filename of filenames) {
    // Only sync known image types
    const ext = path.extname(filename).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;

    const attachment = attachments.find((a) => a.title === filename);

    if (attachment?._links?.download) {
      try {
        const filePath = attachmentPath(userId, pageId, filename);

        // Skip download if already cached (idempotent)
        try {
          await fs.access(filePath);
          cachedFiles.push(filename);
          continue;
        } catch {
          // File does not exist — proceed with download
        }

        const fileSize = attachment.extensions?.fileSize;
        await cacheAttachment(client, userId, pageId, attachment._links.download, filename, fileSize);
        cachedFiles.push(filename);
      } catch (err) {
        logger.error({ err, pageId, filename }, 'Failed to cache image attachment');
      }
    }
  }

  return cachedFiles;
}

/**
 * Fetch a single attachment from Confluence on-demand, cache it locally,
 * and return the file contents. Used as a fallback when the local cache misses.
 *
 * For large attachments (above STREAM_THRESHOLD_BYTES), streams directly to disk
 * and then reads back from the cached file, avoiding holding the full content in memory
 * during the download phase.
 *
 * Returns null if the attachment cannot be found or downloaded.
 */
export async function fetchAndCacheAttachment(
  client: ConfluenceClient,
  userId: string,
  pageId: string,
  filename: string,
): Promise<Buffer | null> {
  const safe = path.basename(filename);

  // Fetch the page's attachment list from Confluence
  const { results: attachments } = await client.getPageAttachments(pageId);
  const attachment = attachments.find((a) => a.title === safe);

  if (!attachment?._links?.download) {
    logger.debug({ userId, pageId, filename: safe }, 'Attachment not found in Confluence');
    return null;
  }

  const fileSize = attachment.extensions?.fileSize;
  const useStreaming = fileSize !== undefined && fileSize > STREAM_THRESHOLD_BYTES;

  const dir = attachmentDir(userId, pageId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = attachmentPath(userId, pageId, safe);

  if (useStreaming) {
    // Stream large files directly to disk
    logger.debug({ userId, pageId, filename: safe, fileSize }, 'Streaming large on-demand attachment to disk');
    await client.downloadAttachmentToFile(attachment._links.download, filePath, MAX_ATTACHMENT_BYTES);
    // Read back from cache
    const data = await fs.readFile(filePath);
    logger.info({ userId, pageId, filename: safe, fileSize }, 'On-demand streamed and cached attachment');
    return data;
  }

  // Small files: buffer in memory (original behavior)
  const data = await client.downloadAttachment(attachment._links.download);
  await fs.writeFile(filePath, data);

  logger.info({ userId, pageId, filename: safe }, 'On-demand fetched and cached attachment');
  return data;
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
 * Attachments are now stored in a shared directory, so this is a no-op.
 * Individual page attachments are cleaned via cleanPageAttachments when pages are deleted.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function cleanUserAttachments(_userId: string): Promise<void> {
  // No-op: attachments are now shared across users, keyed only by pageId.
  // Use cleanPageAttachments(userId, pageId) when a specific page is deleted.
}
