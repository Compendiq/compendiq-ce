import { createHash } from 'crypto';
import path from 'path';
import { JSDOM } from 'jsdom';

export const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

export interface AttachmentImageSource {
  kind: 'attachment';
  attachmentFilename: string;
  sourcePageTitle: string | null;
  sourceSpaceKey: string | null;
}

export interface ExternalUrlImageSource {
  kind: 'external-url';
  url: string;
}

export type ImageReferenceSource = AttachmentImageSource | ExternalUrlImageSource;

export interface ImageReference {
  localFilename: string;
  source: ImageReferenceSource;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function basename(filename: string): string {
  return path.basename(filename);
}

function buildCrossPageLocalFilename(filename: string, sourcePageTitle: string, sourceSpaceKey: string | null): string {
  const safe = basename(filename);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  const suffix = shortHash(`attachment:${sourceSpaceKey ?? ''}:${sourcePageTitle}:${safe}`);
  return `${stem}.xref-${suffix}${ext}`;
}

function buildExternalLocalFilename(url: string): string {
  let ext = '';
  try {
    const parsed = new URL(url);
    const candidate = path.extname(parsed.pathname).toLowerCase();
    if (SUPPORTED_IMAGE_EXTENSIONS.has(candidate)) {
      ext = candidate;
    }
  } catch {
    // Ignore malformed URLs here; validation happens later during download.
  }

  return `external-${shortHash(`external:${url}`)}${ext}`;
}

export function getAttachmentImageSource(
  attachRef: Element,
  currentSpaceKey?: string,
): AttachmentImageSource | null {
  const attachmentFilename = attachRef.getAttribute('ri:filename');
  if (!attachmentFilename) return null;

  const pageRef = [...attachRef.getElementsByTagName('ri:page')][0];
  const sourcePageTitle = pageRef?.getAttribute('ri:content-title')
    ?? attachRef.getAttribute('ri:content-title')
    ?? null;
  const sourceSpaceKey = pageRef?.getAttribute('ri:space-key')
    ?? attachRef.getAttribute('ri:space-key')
    ?? (sourcePageTitle ? currentSpaceKey ?? null : null);

  return {
    kind: 'attachment',
    attachmentFilename,
    sourcePageTitle,
    sourceSpaceKey,
  };
}

export function getLocalFilenameForImageSource(source: ImageReferenceSource): string {
  if (source.kind === 'attachment') {
    if (!source.sourcePageTitle) {
      return basename(source.attachmentFilename);
    }

    return buildCrossPageLocalFilename(
      source.attachmentFilename,
      source.sourcePageTitle,
      source.sourceSpaceKey,
    );
  }

  return buildExternalLocalFilename(source.url);
}

export function extractImageReferences(bodyStorage: string, currentSpaceKey?: string): ImageReference[] {
  const dom = new JSDOM(`<body>${bodyStorage}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;
  const refs = new Map<string, ImageReference>();

  for (const image of [...doc.getElementsByTagName('ac:image')]) {
    const attachRef = [...image.getElementsByTagName('ri:attachment')][0];
    if (attachRef) {
      const source = getAttachmentImageSource(attachRef, currentSpaceKey);
      if (!source) continue;
      const localFilename = getLocalFilenameForImageSource(source);
      refs.set(localFilename, { localFilename, source });
      continue;
    }

    const urlRef = [...image.getElementsByTagName('ri:url')][0];
    const url = urlRef?.getAttribute('ri:value');
    if (!url) continue;

    const source: ExternalUrlImageSource = {
      kind: 'external-url',
      url,
    };
    const localFilename = getLocalFilenameForImageSource(source);
    refs.set(localFilename, { localFilename, source });
  }

  return [...refs.values()];
}
