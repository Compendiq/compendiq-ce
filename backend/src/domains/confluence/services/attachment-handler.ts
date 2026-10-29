import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { JSDOM } from 'jsdom';
import { request } from 'undici';
import type { RedisClientType } from 'redis';
import type { PoolClient } from 'pg';
import { ConfluenceClient, ConfluenceAttachment } from './confluence-client.js';
import { logger } from '../../../core/utils/logger.js';
import { assertNonSsrfUrl } from '../../../core/utils/ssrf-guard.js';
import { isValidPngFile as isPngFile } from '../../../core/services/valid-png.js';
import {
  extractImageReferences,
  SUPPORTED_IMAGE_EXTENSIONS,
  type AttachmentImageSource,
} from '../../../core/services/image-references.js';
import {
  getAttachmentFailureCount,
  recordAttachmentFailure,
  clearAttachmentFailures,
  MAX_ATTACHMENT_FAILURES,
  getRedisClient,
} from '../../../core/services/redis-cache.js';
import {
  attachmentCacheDir,
  attachmentDir,
  safeAttachmentPath,
  validateFilename,
} from '../../../core/services/attachment-store.js';
import { markPageImagesDirtyByAttachmentKey } from '../../../core/services/image-analysis-dirty.js';

/**
 * The path-resolution and READ half of this module lives in
 * `core/services/attachment-store.ts` since #1115 P0 — `domains/llm` may
 * import `core` and nothing else, and the image-embedding worker needs the
 * same resolver this module has always used. Nothing moved except the
 * address: the names below are re-exported so this module's importers
 * (`sync-service`, `sync-overview-service`, `pages-crud`,
 * `routes/knowledge/local-attachments`, `routes/confluence/attachments`,
 * `page-relocate-service`) did not change.
 *
 * What stayed here is everything that talks to Confluence or writes to disk:
 * downloading, caching, the draw.io and cross-page image sync, and the
 * relocate writers.
 */
export {
  isStorableAttachmentFilename,
  readAttachment,
  getMimeType,
  attachmentCacheDir,
  listCachedAttachments,
  readCachedAttachmentFile,
  __internal,
} from '../../../core/services/attachment-store.js';

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
  const dir = attachmentDir(pageId);
  await fs.mkdir(dir, { recursive: true });

  const filePath = safeAttachmentPath(pageId, filename);

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
export async function attachmentExists(pageId: string, filename: string): Promise<boolean> {
  try {
    await fs.access(safeAttachmentPath(pageId, filename));
    return true;
  } catch {
    return false;
  }
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


export function isDrawioXml(data: Buffer): boolean {
  const text = data.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return /^(?:<\?xml\b[^?]*\?>\s*)?<(?:mxfile|mxGraphModel)\b/i.test(text);
}

async function isDrawioXmlFile(filePath: string): Promise<boolean> {
  const file = await fs.open(filePath, 'r');
  try {
    const prefix = Buffer.alloc(1024);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    return isDrawioXml(prefix.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

/**
 * Cache a diagram's PNG export and editable source separately. Downloads are
 * staged before classification so XML is never exposed under a PNG URL.
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
  let changed = false;

  for (const name of diagramNames) {
    try {
      const pngName = `${name}.png`;
      const sourceName = `${name}.drawio`;
      const pngPath = safeAttachmentPath(pageId, pngName);
      const sourcePath = safeAttachmentPath(pageId, sourceName);
      let hasPng = false;
      let hasSource = await attachmentExists(pageId, sourceName);
      try {
        hasPng = await isPngFile(pngPath);
        if (!hasPng) {
          if (!hasSource && await isDrawioXmlFile(pngPath)) {
            await fs.rename(pngPath, sourcePath);
            hasSource = true;
            changed = true;
          } else {
            await fs.rm(pngPath, { force: true });
            changed = true;
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const pngAttachment = attachments.find((a) => a.title === pngName && a._links?.download);
      const bareAttachment = attachments.find((a) => a.title === name && a._links?.download);
      // Remember classification of an extensionless PNG separately: an
      // existing preview alone does not prove that the bare attachment is PNG.
      const markerPath = path.join(attachmentDir(pageId), `.drawio-bare-${createHash('sha256').update(name).digest('hex')}`);
      const bareIdentity = bareAttachment && JSON.stringify([
        bareAttachment.id, bareAttachment.version?.number, bareAttachment._links?.download,
      ]);
      let bareIsCachedPng = false;
      if (bareIdentity && hasPng && !hasSource) {
        try {
          bareIsCachedPng = await fs.readFile(markerPath, 'utf8') === bareIdentity;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      const bareSourceMarker = `${markerPath}-source`;
      let bareIsCachedSource = false;
      if (bareIdentity && hasSource && !hasPng) {
        try {
          bareIsCachedSource = await fs.readFile(bareSourceMarker, 'utf8') === bareIdentity;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      const pngSourceMarker = path.join(attachmentDir(pageId), `.drawio-png-source-${createHash('sha256').update(name).digest('hex')}`);
      const pngIdentity = pngAttachment && JSON.stringify([
        pngAttachment.id, pngAttachment.version?.number, pngAttachment._links?.download,
      ]);
      let pngIsCachedSource = false;
      if (pngIdentity && hasSource && !hasPng) {
        try {
          pngIsCachedSource = await fs.readFile(pngSourceMarker, 'utf8') === pngIdentity;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }

      // A unique staging name avoids publishing unclassified bytes and keeps
      // concurrent syncs from overwriting one another's partial downloads.
      const download = async (attachment: ConfluenceAttachment, kind: 'png' | 'source' | 'unknown') => {
        const temporaryName = `${randomUUID()}.tmp`;
        const temporaryPath = safeAttachmentPath(pageId, temporaryName);
        try {
          await cacheAttachment(client, userId, pageId, attachment._links!.download, temporaryName, attachment.extensions?.fileSize);
          const isPng = await isPngFile(temporaryPath);
          if (!isPng && !await isDrawioXmlFile(temporaryPath)) {
            logger.warn({ pageId, name }, 'Ignoring unrecognised draw.io attachment');
            return;
          }
          if (isPng && !hasPng) {
            await fs.rename(temporaryPath, pngPath);
            hasPng = true;
            downloaded++;
            changed = true;
          } else if (!isPng && !hasSource) {
            await fs.rename(temporaryPath, sourcePath);
            hasSource = true;
            downloaded++;
            changed = true;
          }
          if (kind === 'unknown' && isPng && bareIdentity) {
            await fs.writeFile(markerPath, bareIdentity);
          }
          if (kind === 'unknown' && !isPng && bareIdentity && hasSource) {
            await fs.writeFile(bareSourceMarker, bareIdentity);
          }
          if (kind === 'png' && !isPng && pngIdentity && hasSource) {
            await fs.writeFile(pngSourceMarker, pngIdentity);
          }
        } finally {
          await fs.rm(temporaryPath, { force: true });
        }
      };

      if (hasSource) skipped++;
      else {
        for (const sourceTitle of [sourceName, `${name}.xml`]) {
          if (hasSource) break;
          const sourceAttachment = attachments.find((a) => a.title === sourceTitle && a._links?.download);
          if (!sourceAttachment) continue;
          try { await download(sourceAttachment, 'source'); }
          catch (err) { logger.warn({ err, pageId, name }, 'Failed to cache draw.io source'); }
        }
      }
      if (hasPng) skipped++;
      else if (pngAttachment && !pngIsCachedSource) {
        try { await download(pngAttachment, 'png'); }
        catch (err) { logger.error({ err, pageId, name }, 'Failed to cache draw.io PNG'); }
      }
      if (bareAttachment && ((!hasSource && !bareIsCachedPng) || (!hasPng && !bareIsCachedSource))) {
        try { await download(bareAttachment, 'unknown'); }
        catch (err) { logger.warn({ err, pageId, name }, 'Failed to cache draw.io attachment'); }
      }
      if (hasPng) cachedFiles.push(pngName);
      if (hasSource) cachedFiles.push(sourceName);
    } catch (err) {
      logger.error({ err, pageId, name }, 'Failed to cache draw.io attachment');
    }
  }

  // Re-analyse only when bytes were added, migrated or removed; unchanged
  // caches must not dirty the page on every sync.
  if (changed) await markPageImagesDirtyByAttachmentKey(pageId);

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
      const filePath = safeAttachmentPath(pageId, ref.localFilename);

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

  // #1115 P2 — the other half of the version-unchanged hole. Same rule as
  // `syncDrawioAttachments` above: a download, not a skip. Note the writes here
  // reach the cache through `cacheAttachment`/`cacheExternalImage` rather than
  // `writeAttachmentCache`, which is why the flag is raised here rather than
  // being inherited from that one call site.
  if (downloaded > 0) await markPageImagesDirtyByAttachmentKey(pageId);

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
  const dir = attachmentDir(pageId);
  await fs.mkdir(dir, { recursive: true });

  const filePath = safeAttachmentPath(pageId, filename);
  const { data } = await downloadExternalImage(url);
  await fs.writeFile(filePath, data);
  return filePath;
}

async function downloadExternalImage(url: string): Promise<ExternalImageDownloadResult> {
  // Content-sourced external image URLs are untrusted (lifted verbatim from
  // synced Confluence page bodies, never allowlisted), so use the DNS-resolving
  // SSRF guard to block public hostnames that resolve to private/internal IPs.
  await assertNonSsrfUrl(url);

  const { statusCode, headers, body } = await request(url, {
    signal: AbortSignal.timeout(15_000),
  });

  if (statusCode !== 200) {
    throw new Error(`Failed to download external image: HTTP ${statusCode}`);
  }

  const contentTypeHeader = headers['content-type'];
  const contentType = typeof contentTypeHeader === 'string'
    ? contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? null
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
 * Tracks persistent download failures in Redis so that attachments which repeatedly
 * fail are skipped (short-circuited) after MAX_ATTACHMENT_FAILURES attempts, even
 * across container restarts.
 *
 * @param redis - Optional Redis client for failure tracking. When null, tracking is skipped.
 */
export async function fetchAndCacheAttachment(
  client: ConfluenceClient,
  userId: string,
  pageId: string,
  filename: string,
  redis?: RedisClientType | null,
): Promise<Buffer | null> {
  const safe = validateFilename(filename);

  // Short-circuit: skip Confluence API call if this attachment has failed too many times.
  // Prevents repeated hammering of Confluence for known-broken attachments across restarts.
  const failureCount = await getAttachmentFailureCount(redis ?? null, pageId, safe);
  if (failureCount >= MAX_ATTACHMENT_FAILURES) {
    logger.debug({ userId, pageId, filename: safe, failureCount }, 'Attachment skipped: failure cap reached');
    return null;
  }

  // Fetch the page's attachment list from Confluence
  const { results: attachments } = await client.getPageAttachments(pageId);
  let attachment = findAttachmentByFilename(attachments, safe);

  // An extensionless draw.io attachment can be either an export or source.
  // XML siblings are editable sources, never PNG responses.
  const isPngRequest = safe.toLowerCase().endsWith('.png');
  const isSourceRequest = safe.toLowerCase().endsWith('.drawio');
  if (!attachment && isPngRequest) {
    const baseName = safe.slice(0, -4);
    attachment = findAttachmentByFilename(attachments, baseName)
      ?? findAttachmentByFilename(attachments, `${baseName}.xml`)
      ?? findAttachmentByFilename(attachments, `${baseName}.drawio`);
  }
  const sourceAttachments = isSourceRequest
    ? [safe, `${safe.slice(0, -7)}.xml`, safe.slice(0, -7)]
      .map((title) => findAttachmentByFilename(attachments, title))
      .filter((candidate): candidate is ConfluenceAttachment => Boolean(candidate?._links?.download))
    : [];
  if (isSourceRequest) attachment = sourceAttachments[0];

  if (!attachment?._links?.download) {
    logger.debug({ userId, pageId, filename: safe }, 'Attachment not found in Confluence');
    // Record failure so repeated misses are tracked (not on infrastructure errors — see throw below)
    await recordAttachmentFailure(redis ?? null, pageId, safe);
    return null;
  }

  const fileSize = attachment.extensions?.fileSize;
  const useStreaming = fileSize !== undefined && fileSize > STREAM_THRESHOLD_BYTES;

  const dir = attachmentDir(pageId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = safeAttachmentPath(pageId, safe);

  if (isSourceRequest) {
    for (const sourceAttachment of sourceAttachments) {
      const temporaryPath = safeAttachmentPath(pageId, `${randomUUID()}.tmp`);
      try {
        const sourceStreaming = sourceAttachment.extensions?.fileSize !== undefined
          && sourceAttachment.extensions.fileSize > STREAM_THRESHOLD_BYTES;
        const data = sourceStreaming ? null : await client.downloadAttachment(sourceAttachment._links!.download);
        if (data) await fs.writeFile(temporaryPath, data);
        else await client.downloadAttachmentToFile(sourceAttachment._links!.download, temporaryPath, MAX_ATTACHMENT_BYTES);
        if (!await isDrawioXmlFile(temporaryPath)) {
          const pngName = `${safe.slice(0, -7)}.png`;
          if (await isPngFile(temporaryPath) && !await attachmentExists(pageId, pngName)) {
            await fs.rename(temporaryPath, safeAttachmentPath(pageId, pngName));
          }
          continue;
        }
        await fs.rename(temporaryPath, filePath);
        return data ?? await fs.readFile(filePath);
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }
    }
    return null;
  }

  if (isPngRequest) {
    const sourcePath = safeAttachmentPath(pageId, `${safe.slice(0, -4)}.drawio`);
    if (useStreaming) {
      const temporaryPath = safeAttachmentPath(pageId, `${randomUUID()}.tmp`);
      try {
        await client.downloadAttachmentToFile(attachment._links.download, temporaryPath, MAX_ATTACHMENT_BYTES);
        const png = await isPngFile(temporaryPath);
        if (png) {
          await fs.rename(temporaryPath, filePath);
          return await fs.readFile(filePath);
        }
        if (await isDrawioXmlFile(temporaryPath) && !await attachmentExists(pageId, `${safe.slice(0, -4)}.drawio`)) {
          await fs.rename(temporaryPath, sourcePath);
        }
        return null;
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }
    }
    const data = await client.downloadAttachment(attachment._links.download);
    const temporaryPath = safeAttachmentPath(pageId, `${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, data);
      if (await isPngFile(temporaryPath)) {
        await fs.rename(temporaryPath, filePath);
        return data;
      }
      if (isDrawioXml(data) && !await attachmentExists(pageId, `${safe.slice(0, -4)}.drawio`)) {
        await fs.rename(temporaryPath, sourcePath);
      }
      return null;
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

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

interface FetchAndCachePageImageOptions {
  client: ConfluenceClient;
  userId: string;
  pageId: string;
  localFilename: string;
  bodyStorage: string;
  currentSpaceKey?: string;
  redis?: ReturnType<typeof getRedisClient>;
}

/**
 * Lazily materialise one image the page's body already references.
 *
 * #1115 P2 (review r1) — this is the RECOVERY path for the index's `missing`
 * skip, and therefore a dirty-flag writer. A skip is terminal by design: the
 * worker counts the image and the page still clears its flag, so nothing would
 * ever re-queue that page once the bytes finally arrive. Raised only when
 * bytes really came back, matching the sync writers' download-not-skip rule;
 * the route only reaches here on a cache MISS, so a page whose images are all
 * cached never pays for it.
 */
export async function fetchAndCachePageImage(
  options: FetchAndCachePageImageOptions,
): Promise<Buffer | null> {
  const data = await fetchAndCachePageImageBytes(options);
  if (data) await markPageImagesDirtyByAttachmentKey(options.pageId);
  return data;
}

async function fetchAndCachePageImageBytes(
  options: FetchAndCachePageImageOptions,
): Promise<Buffer | null> {
  const { client, userId, pageId, localFilename, bodyStorage, currentSpaceKey, redis } = options;
  const safe = validateFilename(localFilename);
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
    return fetchAndCacheAttachment(client, userId, pageId, safe, redis);
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
  return fs.readFile(safeAttachmentPath(pageId, safe));
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
  client?: PoolClient,
): Promise<string> {
  const dir = attachmentDir(pageId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = safeAttachmentPath(pageId, filename);
  await fs.writeFile(filePath, data);
  // #1115 P2 — the bytes behind a key this page's `body_html` may reference
  // just changed. Every caller of this function is a write (a pasted image, an
  // imported external image, an edited draw.io PNG), so the flag is raised
  // unconditionally rather than by diffing: the page's own reconcile pass is
  // what decides whether anything is actually re-embedded, and an unchanged
  // file reuses its row by sha256 for the cost of one file read.
  await markPageImagesDirtyByAttachmentKey(pageId, client);
  logger.debug({ userId, pageId, filename, size: data.length }, 'Wrote attachment to local cache');
  return filePath;
}

/**
 * Check if local attachment cache exists for a page (has at least one file).
 * Used by sync-service to decide whether to retry attachment downloads
 * for pages whose content version hasn't changed.
 */
export async function hasLocalAttachments(pageId: string): Promise<boolean> {
  const dir = attachmentDir(pageId);
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
  pageId: string,
  bodyStorage: string,
  currentSpaceKey?: string,
): Promise<string[]> {
  const expected = getExpectedAttachmentFilenames(bodyStorage, currentSpaceKey);
  if (expected.length === 0) return [];

  const missing: string[] = [];
  for (const filename of expected) {
    const exists = await attachmentExists(pageId, filename);
    if (!exists) missing.push(filename);
  }
  return missing;
}

/**
 * Clean up all attachments for a page.
 * Also clears any Redis failure counters so re-synced attachments get a fresh start.
 */
export async function cleanPageAttachments(
  pageId: string,
  options?: { client?: PoolClient; strict?: boolean },
): Promise<void> {
  const dir = attachmentCacheDir(pageId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    if (options?.strict) throw error;
    // Legacy sync cleanup remains best-effort; admitted writes require removal.
  }
  // Clear Redis failure counters — after a sync the failures are stale
  await clearAttachmentFailures(getRedisClient(), pageId);
  // #1115 P2 — re-queue the page so the next scan RE-READS its images. It does
  // not delete their index rows, and saying so was wrong (review r3):
  // `embedPageImages` reconciles against the page's BODY, which this function
  // never touches, so every image comes back as a `missing` skip whose row is
  // deliberately kept — a stale row is recoverable, a deleted one costs a
  // re-embed, and the legacy leg counts "gone" and "the read failed" as the
  // same miss. The re-read is the point: on the sync path these bytes are about
  // to be downloaded again and may differ, and on a delete path the page row
  // (and its rows, by CASCADE) is going anyway.
  await markPageImagesDirtyByAttachmentKey(pageId, options?.client);
}

/**
 * Write bytes into the Confluence attachment cache under an explicit key,
 * resolving the attachments root at call time. {@link writeAttachmentCache}
 * does the same against the module-load root; relocate needs the call-time
 * variant for the same testability reason as `attachmentsRootNow` in
 * `core/services/attachment-store.ts`.
 */
export async function writeAttachmentCacheAt(
  pageId: string,
  filename: string,
  data: Buffer,
): Promise<void> {
  const dir = attachmentCacheDir(pageId);
  await fs.mkdir(dir, { recursive: true });
  const safeFilename = validateFilename(filename);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- dir is containment-checked by attachmentCacheDir; safeFilename is basename-sanitised by validateFilename
  await fs.writeFile(path.resolve(dir, safeFilename), data);
}

/**
 * Remove a page's cached attachment directory, resolving the root at call
 * time. Post-commit cleanup for relocate — best-effort by contract, so callers
 * must treat a throw as non-fatal (orphaned files only; the DB is consistent).
 */
export async function removeAttachmentDirectory(pageId: string): Promise<void> {
  try {
    await fs.rm(attachmentCacheDir(pageId), { recursive: true, force: true });
  } catch {
    // Directory may not exist, or the key may be unrepresentable on disk.
  }
  await clearAttachmentFailures(getRedisClient(), pageId);
}
