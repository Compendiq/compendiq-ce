import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { JSDOM } from 'jsdom';
import { PageWriteError } from '../../../core/services/page-write-admission.js';
import type {
  ConfluenceAttachment,
  ConfluenceClient,
} from './confluence-client.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

export interface PlannedPastedImage {
  filename: string;
  mimeType: string;
  size: number;
  contentSha256: string;
  filePath: string;
}

export interface PastedImagePlan {
  bodyHtml: string;
  images: PlannedPastedImage[];
}

export interface PreparedPastedImage extends PlannedPastedImage {
  bytes: Buffer;
}

/**
 * Compact durable evidence that the corresponding immutable-plan upload
 * returned a valid Confluence attachment object. The filename binds the
 * ordered marker to that plan entry. Provider attachment IDs are deliberately
 * not retained, and the marker is not independent provider byte attestation.
 */
export interface PastedImageUploadReceipt {
  accepted: true;
  filename: string;
  attachmentVersion?: number;
}

function unavailableImage(): PageWriteError {
  return new PageWriteError(
    409,
    'pasted_image_unavailable',
    'A pasted image changed or is no longer available; reload it before saving',
  );
}

/**
 * Resolve every local image, hash its exact bytes, and render the final HTML
 * before any Confluence mutation. Missing files and filename collisions are a
 * refusal: publishing their ri:attachment references would create broken or
 * ambiguous media.
 */
export async function planLocalImagesForConfluence(html: string): Promise<PastedImagePlan> {
  if (!html.includes('/api/attachments/')) return { bodyHtml: html, images: [] };

  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;
  const imagesByFilename = new Map<string, PlannedPastedImage>();
  let changed = false;

  for (const img of doc.querySelectorAll('img[src^="/api/attachments/"]')) {
    if (img.getAttribute('data-confluence-filename')) continue;
    if (img.getAttribute('data-confluence-image-source')) continue;

    const src = img.getAttribute('src') ?? '';
    const parts = src.split('/');
    const rawFilename = parts.at(-1) ?? '';
    const pageId = parts.at(-2) ?? '';
    let filename = rawFilename;
    try {
      filename = decodeURIComponent(rawFilename);
    } catch {
      // A literal '%' is a valid attachment filename and is written that way
      // by older editor versions.
    }
    if (
      !filename
      || filename === '.'
      || filename === '..'
      || !pageId
      || pageId === '.'
      || pageId === '..'
      || path.basename(filename) !== filename
      || path.basename(pageId) !== pageId
    ) {
      throw unavailableImage();
    }

    // Both components come from an editor-produced attachment URL. basename
    // keeps the final path under the configured attachment root.
    // nosemgrep
    const filePath = path.join(
      process.env.ATTACHMENTS_DIR ?? 'data/attachments',
      path.basename(pageId),
      filename,
    );
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      throw unavailableImage();
    }
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    const mimeType = MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
    const planned: PlannedPastedImage = {
      filename,
      mimeType,
      size: bytes.length,
      contentSha256,
      filePath,
    };
    const prior = imagesByFilename.get(filename);
    if (
      prior
      && (prior.contentSha256 !== planned.contentSha256
        || prior.size !== planned.size
        || prior.mimeType !== planned.mimeType)
    ) {
      throw new PageWriteError(
        409,
        'pasted_image_filename_collision',
        'Two pasted images use the same Confluence filename with different content',
      );
    }
    if (!prior) imagesByFilename.set(filename, planned);

    img.setAttribute('data-confluence-filename', filename);
    img.setAttribute('data-confluence-image-source', 'attachment');
    changed = true;
  }

  return {
    bodyHtml: changed ? doc.body.innerHTML : html,
    images: [...imagesByFilename.values()],
  };
}

/**
 * Re-read the complete plan after durable ownership is reserved. The returned
 * buffers are immutable inputs for all later remote phases; a missing or
 * changed file refuses the commit before its first remote mutation.
 */
export async function preparePastedImagePlan(
  plan: PastedImagePlan,
): Promise<PreparedPastedImage[]> {
  const prepared: PreparedPastedImage[] = [];
  for (const image of plan.images) {
    let bytes: Buffer;
    try {
      bytes = await readFile(image.filePath);
    } catch {
      throw unavailableImage();
    }
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== image.size || contentSha256 !== image.contentSha256) {
      throw unavailableImage();
    }
    prepared.push({ ...image, bytes });
  }
  return prepared;
}

export async function uploadPreparedPastedImage(
  image: PreparedPastedImage,
  confluencePageId: string,
  client: ConfluenceClient,
  log: FastifyBaseLogger,
): Promise<PastedImageUploadReceipt> {
  let attachment: ConfluenceAttachment;
  try {
    attachment = await client.updateAttachment(
      confluencePageId,
      image.filename,
      image.bytes,
      image.mimeType,
    );
  } catch (err) {
    log.error(
      { err, confluencePageId, filename: image.filename },
      'Failed to upload pasted image to Confluence',
    );
    throw err;
  }
  if (
    !attachment
    || typeof attachment.id !== 'string'
    || attachment.id.length === 0
    || attachment.title !== image.filename
  ) {
    throw new PageWriteError(
      409,
      'pasted_image_acknowledgment_invalid',
      'Confluence did not acknowledge the planned pasted image',
    );
  }
  log.info(
    { confluencePageId, filename: image.filename, contentSha256: image.contentSha256 },
    'Uploaded pasted image to Confluence',
  );
  const attachmentVersion = attachment.version?.number;
  return {
    accepted: true,
    filename: image.filename,
    ...(typeof attachmentVersion === 'number'
      && Number.isSafeInteger(attachmentVersion)
      && attachmentVersion > 0
      ? { attachmentVersion }
      : {}),
  };
}

/**
 * Compatibility wrapper for the ordinary page-save path. Its caller already
 * reserves a terminal-only page intent before invoking this function.
 */
export async function uploadLocalImagesToConfluence(
  html: string,
  confluencePageId: string,
  client: ConfluenceClient,
  log: FastifyBaseLogger,
): Promise<string> {
  const plan = await planLocalImagesForConfluence(html);
  const prepared = await preparePastedImagePlan(plan);
  for (const image of prepared) {
    await uploadPreparedPastedImage(image, confluencePageId, client, log);
  }
  return plan.bodyHtml;
}
