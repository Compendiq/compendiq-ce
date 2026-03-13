import fs from 'fs/promises';
import path from 'path';
import { JSDOM } from 'jsdom';
import { request } from 'undici';
import { ConfluenceClient, ConfluenceAttachment } from './confluence-client.js';
import { logger } from '../../../core/utils/logger.js';
import { validateUrl } from '../../../core/utils/ssrf-guard.js';
import {
  extractImageReferences,
  SUPPORTED_IMAGE_EXTENSIONS,
  type AttachmentImageSource,
  type ImageReference,
} from '../../../core/services/image-references.js';

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
 * Read a cached attachment. If the exact filename is not found, searches for
 * cross-page reference variants (.xref-{hash}) that match the same base name.
 * This handles the case where stale cached HTML references a plain filename
 * but the sync stored the file with an xref suffix.
 */
export async function readAttachment(userId: string, pageId: string, filename: string): Promise<Buffer | null> {
  const fullPath = attachmentPath(userId, pageId, filename);
  try {
    return await fs.readFile(fullPath);
  } catch (err) {
    logger.debug({ pageId, filename, fullPath, error: (err as NodeJS.ErrnoException).code }, 'Exact attachment path miss');
  }

  // Search for .xref- variants: "foo.jpg" matches "foo.xref-{hash}.jpg"
  const safe = path.basename(filename);
  const dir = attachmentDir('', pageId);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  const prefix = `${stem}.xref-`;

  try {
    const entries = await fs.readdir(dir);
    const match = entries.find((e) => e.startsWith(prefix) && e.endsWith(ext));
    if (match) {
      logger.debug({ pageId, filename, xrefMatch: match }, 'Serving attachment via xref fallback');
      return await fs.readFile(path.join(dir, path.basename(match)));
    }
    logger.debug({ pageId, filename, dir, dirContents: entries.slice(0, 20) }, 'No xref match found — listing dir contents');
  } catch {
    logger.debug({ pageId, filename, dir }, 'Attachment directory does not exist');
  }

  return null;
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
export function extractDrawioDiagramNames(bodyStorage: string): string[] {
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
  let skipped = 0;
  let downloaded = 0;

  for (const name of diagramNames) {
    // Prefer the PNG export; fall back to the raw XML source file.
    const pngName = `${name}.png`;
    const xmlName = `${name}.xml`;

    let attachment = attachments.find((a) => a.title === pngName);
    let cacheAs = pngName;

    if (!attachment) {
      // Fall back to XML attachment or attachment stored without extension.
      // Always cache as pngName so the URL generated by the content converter
      // (/api/attachments/{pageId}/{name}.png) matches the cached filename.
      const xmlAttachment = attachments.find((a) => a.title === xmlName || a.title === name);
      if (xmlAttachment) {
        attachment = xmlAttachment;
        cacheAs = pngName;
      }
    }

    if (attachment?._links?.download) {
      try {
        const filePath = attachmentPath(userId, pageId, cacheAs);

        // Skip download if already cached (idempotent)
        try {
          await fs.access(filePath);
          cachedFiles.push(cacheAs);
          skipped++;
          continue;
        } catch {
          // File does not exist — proceed with download
        }

        const fileSize = attachment.extensions?.fileSize;
        await cacheAttachment(client, userId, pageId, attachment._links.download, cacheAs, fileSize);
        cachedFiles.push(cacheAs);
        downloaded++;
      } catch (err) {
        logger.error({ err, pageId, name }, 'Failed to cache draw.io attachment');
      }
    }
  }

  logger.debug(
    { pageId, found: diagramNames.length, skipped, downloaded },
    'syncDrawioAttachments complete',
  );

  return cachedFiles;
}

interface ExternalImageDownloadResult {
  data: Buffer;
  contentType: string | null;
}

/**
 * Parse image attachment filenames from Confluence XHTML storage format using JSDOM.
 * Handles arbitrary attribute ordering reliably, unlike regex approaches.
 */
export function extractImageFilenames(bodyStorage: string): string[] {
  return extractImageReferences(bodyStorage)
    .filter((ref): ref is ImageReference & { source: AttachmentImageSource } => ref.source.kind === 'attachment')
    .map((ref) => ref.source.attachmentFilename)
    .filter((filename) => SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase()));
}

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
  currentSpaceKey?: string,
): Promise<string[]> {
  const refs = extractImageReferences(bodyStorage, currentSpaceKey);
  if (refs.length === 0) return [];

  const cachedFiles: string[] = [];
  let skipped = 0;
  let downloaded = 0;
  const pageIdCache = new Map<string, string | null>();
  const attachmentsCache = new Map<string, ConfluenceAttachment[]>([[pageId, attachments]]);

  for (const ref of refs) {
    try {
      const filePath = attachmentPath(userId, pageId, ref.localFilename);

      try {
        await fs.access(filePath);
        cachedFiles.push(ref.localFilename);
        skipped++;
        continue;
      } catch {
        // File does not exist — proceed with download
      }

      if (ref.source.kind === 'attachment') {
        const ext = path.extname(ref.source.attachmentFilename).toLowerCase();
        if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) continue;

        const sourcePageId = await resolveAttachmentSourcePageId(
          client,
          pageIdCache,
          pageId,
          ref.source,
        );
        if (!sourcePageId) continue;

        const sourceAttachments = await getAttachmentsForPage(
          client,
          attachmentsCache,
          sourcePageId,
        );

        const attachment = findAttachmentByFilename(sourceAttachments, ref.source.attachmentFilename);
        if (!attachment?._links?.download) continue;

        const fileSize = attachment.extensions?.fileSize;
        await cacheAttachment(client, userId, pageId, attachment._links.download, ref.localFilename, fileSize);
      } else {
        await cacheExternalImage(userId, pageId, ref.localFilename, ref.source.url);
      }

      cachedFiles.push(ref.localFilename);
      downloaded++;
    } catch (err) {
      logger.error(
        { err, pageId, localFilename: ref.localFilename },
        'Failed to cache page image',
      );
    }
  }

  logger.debug(
    { pageId, found: refs.length, skipped, downloaded },
    'syncImageAttachments complete',
  );

  return cachedFiles;
}

function findAttachmentByFilename(
  attachments: ConfluenceAttachment[],
  filename: string,
): ConfluenceAttachment | undefined {
  const filenameLower = filename.toLowerCase();
  return attachments.find((a) => a.title === filename)
    ?? attachments.find((a) => a.title.toLowerCase() === filenameLower);
}

async function resolveAttachmentSourcePageId(
  client: ConfluenceClient,
  pageIdCache: Map<string, string | null>,
  currentPageId: string,
  source: AttachmentImageSource,
): Promise<string | null> {
  if (!source.sourcePageTitle) {
    return currentPageId;
  }

  const cacheKey = `${source.sourceSpaceKey ?? ''}:${source.sourcePageTitle}`;
  if (pageIdCache.has(cacheKey)) {
    return pageIdCache.get(cacheKey) ?? null;
  }

  const page = await client.findPageByTitle(source.sourceSpaceKey, source.sourcePageTitle);
  const resolvedPageId = page?.id ?? null;
  pageIdCache.set(cacheKey, resolvedPageId);
  return resolvedPageId;
}

async function getAttachmentsForPage(
  client: ConfluenceClient,
  attachmentsCache: Map<string, ConfluenceAttachment[]>,
  pageId: string,
): Promise<ConfluenceAttachment[]> {
  const cached = attachmentsCache.get(pageId);
  if (cached) return cached;

  const { results } = await client.getPageAttachments(pageId);
  attachmentsCache.set(pageId, results);
  return results;
}

async function cacheExternalImage(
  userId: string,
  pageId: string,
  filename: string,
  url: string,
): Promise<string> {
  const dir = attachmentDir(userId, pageId);
  await fs.mkdir(dir, { recursive: true });

  const filePath = attachmentPath(userId, pageId, filename);
  const { data } = await downloadExternalImage(url);
  await fs.writeFile(filePath, data);
  return filePath;
}

async function downloadExternalImage(url: string): Promise<ExternalImageDownloadResult> {
  validateUrl(url);

  const { statusCode, headers, body } = await request(url, {
    signal: AbortSignal.timeout(60_000),
  });

  if (statusCode !== 200) {
    throw new Error(`Failed to download external image: HTTP ${statusCode}`);
  }

  const contentTypeHeader = headers['content-type'];
  const contentType = typeof contentTypeHeader === 'string'
    ? contentTypeHeader.split(';')[0].trim().toLowerCase()
    : null;
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`External URL did not return an image: ${contentType}`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`External image too large: exceeded ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  return {
    data: Buffer.concat(chunks),
    contentType,
  };
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
  let attachment = findAttachmentByFilename(attachments, safe);

  // Draw.io fallback: the content converter generates {name}.png URLs, but
  // the Confluence attachment may be stored as {name}.xml or just {name}.
  if (!attachment && safe.endsWith('.png')) {
    const baseName = safe.slice(0, -4);
    const baseNameLower = baseName.toLowerCase();
    attachment = attachments.find((a) => a.title === `${baseName}.xml` || a.title === baseName)
      ?? attachments.find((a) => {
        const titleLower = a.title.toLowerCase();
        return titleLower === `${baseNameLower}.xml` || titleLower === baseNameLower;
      });
  }

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

export async function fetchAndCachePageImage(
  client: ConfluenceClient,
  userId: string,
  pageId: string,
  localFilename: string,
  bodyStorage: string,
  currentSpaceKey?: string,
): Promise<Buffer | null> {
  const safe = path.basename(localFilename);
  const refs = extractImageReferences(bodyStorage, currentSpaceKey);
  let ref = refs.find((candidate) => candidate.localFilename === safe);

  // If no exact match, the requested filename may come from stale cached HTML
  // that predates cross-page reference support. Search by base attachment
  // filename (ignoring the .xref- suffix) to find the correct cross-page ref.
  if (!ref) {
    ref = refs.find((candidate) =>
      candidate.source.kind === 'attachment' &&
      path.basename(candidate.source.attachmentFilename) === safe,
    );
  }

  if (!ref) {
    return fetchAndCacheAttachment(client, userId, pageId, safe);
  }

  if (ref.source.kind === 'external-url') {
    const filePath = await cacheExternalImage(userId, pageId, safe, ref.source.url);
    return fs.readFile(filePath);
  }

  const sourcePageId = await resolveAttachmentSourcePageId(
    client,
    new Map<string, string | null>(),
    pageId,
    ref.source,
  );
  if (!sourcePageId) {
    return null;
  }

  const { results: attachments } = await client.getPageAttachments(sourcePageId);
  let attachment = findAttachmentByFilename(attachments, ref.source.attachmentFilename);

  if (!attachment && ref.source.attachmentFilename.endsWith('.png')) {
    const baseName = ref.source.attachmentFilename.slice(0, -4);
    const baseNameLower = baseName.toLowerCase();
    attachment = attachments.find((a) => a.title === `${baseName}.xml` || a.title === baseName)
      ?? attachments.find((a) => {
        const titleLower = a.title.toLowerCase();
        return titleLower === `${baseNameLower}.xml` || titleLower === baseNameLower;
      });
  }

  if (!attachment?._links?.download) {
    logger.debug({ userId, pageId, localFilename: safe }, 'Page image not found in Confluence');
    return null;
  }

  const fileSize = attachment.extensions?.fileSize;
  await cacheAttachment(client, userId, pageId, attachment._links.download, safe, fileSize);
  return fs.readFile(attachmentPath(userId, pageId, safe));
}

/**
 * Write (or overwrite) a file in the local attachment cache.
 * Used when the user edits a diagram inline and we need to update
 * the cached PNG without re-downloading from Confluence.
 */
export async function writeAttachmentCache(
  userId: string,
  pageId: string,
  filename: string,
  data: Buffer,
): Promise<string> {
  const dir = attachmentDir(userId, pageId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = attachmentPath(userId, pageId, filename);
  await fs.writeFile(filePath, data);
  logger.debug({ userId, pageId, filename, size: data.length }, 'Wrote attachment to local cache');
  return filePath;
}

/**
 * Check if local attachment cache exists for a page (has at least one file).
 * Used by sync-service to decide whether to retry attachment downloads
 * for pages whose content version hasn't changed.
 */
export async function hasLocalAttachments(userId: string, pageId: string): Promise<boolean> {
  const dir = attachmentDir(userId, pageId);
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the list of expected attachment filenames for a page based on its XHTML body.
 * Combines image filenames and draw.io diagram PNG filenames.
 */
export function getExpectedAttachmentFilenames(bodyStorage: string, currentSpaceKey?: string): string[] {
  const imageFiles = extractImageReferences(bodyStorage, currentSpaceKey)
    .filter((ref) => {
      if (ref.source.kind === 'external-url') return true;
      return SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(ref.source.attachmentFilename).toLowerCase());
    })
    .map((ref) => ref.localFilename);
  const drawioFiles = extractDrawioDiagramNames(bodyStorage).map((name) => `${name}.png`);
  return [...imageFiles, ...drawioFiles];
}

/**
 * Compare expected attachments (from XHTML parsing) against locally cached files.
 * Returns the list of filenames that are expected but NOT present on disk.
 */
export async function getMissingAttachments(
  userId: string,
  pageId: string,
  bodyStorage: string,
  currentSpaceKey?: string,
): Promise<string[]> {
  const expected = getExpectedAttachmentFilenames(bodyStorage, currentSpaceKey);
  if (expected.length === 0) return [];

  const missing: string[] = [];
  for (const filename of expected) {
    const exists = await attachmentExists(userId, pageId, filename);
    if (!exists) missing.push(filename);
  }
  return missing;
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
