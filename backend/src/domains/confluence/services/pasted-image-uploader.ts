import { readFile } from 'fs/promises';
import path from 'path';
import type { ConfluenceClient } from './confluence-client.js';
import type { FastifyBaseLogger } from 'fastify';

const ATTACHMENTS_BASE = process.env.ATTACHMENTS_DIR ?? 'data/attachments';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

/**
 * Scan editor HTML for locally-pasted images (those with /api/attachments/ src
 * but missing data-confluence-filename). Upload each to Confluence as a page
 * attachment, then add data-confluence-filename so htmlToConfluence() generates
 * a valid ri:attachment reference.
 */
export async function uploadLocalImagesToConfluence(
  html: string,
  confluencePageId: string,
  client: ConfluenceClient,
  log: FastifyBaseLogger,
): Promise<string> {
  // Quick check — skip DOM parsing if no pasted images
  if (!html.includes('/api/attachments/')) return html;

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;

  const localImages = doc.querySelectorAll('img[src^="/api/attachments/"]');
  let changed = false;

  for (const img of localImages) {
    // Skip images that already have a Confluence filename (synced from Confluence)
    if (img.getAttribute('data-confluence-filename')) continue;
    if (img.getAttribute('data-confluence-image-source')) continue;

    const src = img.getAttribute('src') ?? '';
    // src = /api/attachments/{pageId}/{filename}
    const parts = src.split('/');
    const filename = decodeURIComponent(parts[parts.length - 1] ?? '');
    const pageId = parts[parts.length - 2] ?? '';
    if (!filename || !pageId) continue;

    // Read the file from local attachment cache.
    // Both `pageId` and `filename` are parsed out of the `src` attribute of
    // an <img> tag produced by our own editor and are passed through
    // `path.basename()` to strip any `..` / path separators before
    // concatenation with the trusted `ATTACHMENTS_BASE` root.
    // nosemgrep
    const filePath = path.join(ATTACHMENTS_BASE, path.basename(pageId), path.basename(filename));
    let fileData: Buffer;
    try {
      fileData = await readFile(filePath);
    } catch {
      log.warn({ filePath, filename }, 'Local pasted image not found, skipping upload');
      continue;
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    try {
      await client.updateAttachment(confluencePageId, filename, fileData, mimeType);
      // Mark as a Confluence attachment so htmlToConfluence() uses the right filename
      img.setAttribute('data-confluence-filename', filename);
      img.setAttribute('data-confluence-image-source', 'attachment');
      changed = true;
      log.info({ confluencePageId, filename }, 'Uploaded pasted image to Confluence');
    } catch (err) {
      log.error({ err, confluencePageId, filename }, 'Failed to upload pasted image to Confluence');
    }
  }

  return changed ? doc.body.innerHTML : html;
}
