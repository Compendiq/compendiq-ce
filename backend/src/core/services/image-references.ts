import { createHash } from 'crypto';
import path from 'path';
import { JSDOM } from 'jsdom';
import type { PageSource } from '@compendiq/contracts';

export const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

export interface AttachmentImageSource {
  kind: 'attachment';
  attachmentFilename: string;
  sourcePageTitle: string | null;
  sourceSpaceKey: string | null;
}

interface ExternalUrlImageSource {
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

/**
 * One image the STORED body points at, addressed the way
 * `resolveAttachmentBytes` wants it (#1115 P2).
 *
 * `source` is a STORE, not `pages.source`: `'confluence'` is the cache tree
 * under `<ATTACHMENTS_DIR>/<confluence_id | page id>/`, `'local'` the local
 * store under `<ATTACHMENTS_DIR>/local/<page_id>/`.
 */
export interface PageImageReference {
  source: 'confluence' | 'local';
  /**
   * The on-disk filename — the URL-DECODED **final segment** of a
   * `/api/(local-)attachments/<dir>/<file>` src.
   *
   * Not `basename(src)`: `path.basename('/api/attachments/7/')` is `'7'`, so a
   * bare directory reference would produce a key naming a file that does not
   * exist. A bare directory and a nested path are both refused below.
   */
  key: string;
}

/** `/api/local-attachments/<page id>/<file>` — must be tested BEFORE the next. */
const LOCAL_ATTACHMENT_PREFIX = '/api/local-attachments/';
/** `/api/attachments/<confluence id | page id>/<file>`. */
const CONFLUENCE_ATTACHMENT_PREFIX = '/api/attachments/';

/**
 * The name `buildExternalLocalFilename` writes: `external-` + 12 hex + the
 * upstream extension when it was one we recognise.
 *
 * Anchored to that exact shape rather than the `external-` word, because a
 * human-uploaded `external-diagram.png` is an ordinary page image and
 * excluding it under the "don't index images fetched off the internet" knob
 * would be a silent, unexplainable omission.
 */
const EXTERNAL_IMAGE_KEY = /^external-[0-9a-f]{12}(\.[A-Za-z0-9]+)?$/;

/** Whether a key names an image this page pulled from an external URL. */
export function isExternalImageKey(key: string): boolean {
  return EXTERNAL_IMAGE_KEY.test(key);
}

/**
 * The Confluence-tree directory key for a page: its `confluence_id` when the
 * page is Confluence-sourced, its numeric id as text otherwise.
 *
 * **One definition, three users**: this function, the paste/import writer
 * (`routes/knowledge/pages-crud.ts`) and `parentKeyFor`
 * (`domains/knowledge/services/page-relocate-service.ts`). It used to be four
 * — `attachment-store.ts` carried a private copy, which now imports this one —
 * and a reader keying differently from the writer reads the wrong directory
 * and answers `null`, silently. The remaining two live in `domains/`, which
 * `core` may not import (`backend/eslint.config.js`), so they stay restated;
 * if any of them changes, all of them must.
 *
 * `pageSource` is a REQUIRED input rather than something inferred from
 * `confluenceId`: `confluenceId ?? pageId` agrees with the writers on every
 * row one can currently produce and disagrees on `source = 'standalone'` with
 * a non-null `confluence_id`, so the obvious `SELECT id, confluence_id FROM
 * pages` would name a different page's directory the day such a row exists.
 *
 * Truthiness, not `!= null`: an empty-string `confluence_id` keys on the
 * numeric id, matching `parentKeyFor`. No writer can produce that state
 * (`validatePageId('')` throws and sync never sets an empty id), but the two
 * must not disagree about the case either way.
 */
export function confluenceAttachmentDirKey(
  pageSource: PageSource,
  pageId: number,
  confluenceId: string | null | undefined,
): string {
  return pageSource === 'confluence' && confluenceId ? confluenceId : String(pageId);
}

/** The page identity a stored `(source, key)` pair needs to become a URL. */
export interface PageImageUrlInput extends PageImageReference {
  /** `pages.id` — the numeric PK, also the local store's directory key. */
  pageId: number;
  /** `pages.source`. Decides the Confluence-tree key; see {@link confluenceAttachmentDirKey}. */
  pageSource: PageSource;
  /** `pages.confluence_id`, or null for a standalone page. */
  confluenceId?: string | null;
}

/**
 * The `<img src>` a stored image row corresponds to — the exact INVERSE of
 * {@link extractImageReferencesFromHtml} (#1115 P3).
 *
 * The image leg answers with `(source, attachment_key)` and the ask route has
 * to give the browser a URL the authenticated attachment routes really serve.
 * Deriving that URL at the consumer is how it drifts: the store follows the
 * PREFIX, the Confluence directory follows `pageSource`, and the filename is
 * percent-encoded on the wire while the bytes sit on disk under the raw name
 * (`content-converter.ts` writes `encodeURIComponent(localFilename)`). Getting
 * any one of the three wrong produces a 404 in a source chip, which reads as a
 * missing picture rather than a wrong URL.
 *
 * `encodeURIComponent`, not `encodeURI`: a filename may legitimately contain
 * `#`, `?` or `/`-adjacent characters, and only the component form escapes
 * them out of the path.
 */
export function buildPageImageUrl(input: PageImageUrlInput): string {
  const file = encodeURIComponent(input.key);
  if (input.source === 'local') {
    return `/api/local-attachments/${input.pageId}/${file}`;
  }
  const dir = confluenceAttachmentDirKey(input.pageSource, input.pageId, input.confluenceId);
  return `/api/attachments/${encodeURIComponent(dir)}/${file}`;
}

/**
 * Every attachment image the CLEAN body (`pages.body_html`) references, in
 * document order, deduped by `(source, key)`.
 *
 * **Source follows the URL PREFIX, never `confluence_id IS NULL`** (ADR-025,
 * `attachment-store.ts`'s header). `relocateToLocal` copies a detached page's
 * bytes into the local store, rewrites its body onto `/api/local-attachments/`
 * and PERSISTS that body, so the pages whose `confluence_id` is NULL are
 * exactly the ones whose bytes are no longer in the Confluence tree — and a
 * page pasted into after that move carries both prefixes at once.
 *
 * Two things this deliberately does not do:
 *
 *  - It ignores the directory segment. The reader derives that from the page
 *    row (`pageSource`/`confluenceId`/`pageId`), and a body that names another
 *    page's directory resolves to nothing and is counted as a miss — the same
 *    silent absence a deleted file produces. Trusting the segment instead
 *    would read bytes from a directory this page does not own.
 *  - It does not fall back to `body_storage`. That is Confluence's own format
 *    (`extractImageReferences` below), which standalone pages never have and
 *    which a relocated page still carries verbatim, describing attachments its
 *    body no longer points at.
 */
export function extractImageReferencesFromHtml(bodyHtml: string | null | undefined): PageImageReference[] {
  if (!bodyHtml) return [];
  const dom = new JSDOM(`<body>${bodyHtml}</body>`, { contentType: 'text/html' });
  const refs = new Map<string, PageImageReference>();

  for (const img of [...dom.window.document.getElementsByTagName('img')]) {
    const src = img.getAttribute('src');
    if (!src) continue;

    // Strip a query string and a fragment before anything else: `a.png?v=2` is
    // a cache-buster on the same file, and `basename` would fold the whole
    // thing into the key.
    const pathOnly = src.split('#')[0]!.split('?')[0]!;

    const matched: [PageImageReference['source'], string] | null = pathOnly.startsWith(
      LOCAL_ATTACHMENT_PREFIX,
    )
      ? ['local', pathOnly.slice(LOCAL_ATTACHMENT_PREFIX.length)]
      : pathOnly.startsWith(CONFLUENCE_ATTACHMENT_PREFIX)
        ? ['confluence', pathOnly.slice(CONFLUENCE_ATTACHMENT_PREFIX.length)]
        : null;
    if (!matched) continue;
    const [source, rest] = matched;

    // `<dir>/<file>`, exactly — never a bare directory (`…/7/`, whose
    // `basename` is the directory itself) and never a nested path, neither of
    // which any route serves.
    const slash = rest.indexOf('/');
    if (slash < 0) continue;
    const raw = rest.slice(slash + 1);
    if (!raw || raw.includes('/')) continue;
    // `decodeURIComponent` throws on a lone `%`, which a real filename may
    // legitimately contain (`100%.png`). The raw name is then what is on disk.
    let key: string;
    try {
      key = decodeURIComponent(raw);
    } catch {
      key = raw;
    }
    // The same shape `resolveAttachmentBytes` accepts. Emitting anything else
    // would write a row that can never be resolved back to bytes.
    if (key.includes('\0') || key.startsWith('.') || path.basename(key) !== key) continue;

    const dedupeKey = `${source}:${key}`;
    if (!refs.has(dedupeKey)) refs.set(dedupeKey, { source, key });
  }

  return [...refs.values()];
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
