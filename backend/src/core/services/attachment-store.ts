/**
 * Attachment READER for both stores (#1115 P0).
 *
 * The path resolution and read half of
 * `domains/confluence/services/attachment-handler.ts`, hoisted verbatim into
 * `core`. Nothing here changed in the move except its address — the download,
 * cache-write and Confluence-client logic stayed behind in the confluence
 * domain, and that module re-exports these names so its importers did not
 * move either.
 *
 * **Why it had to move.** `domains/llm` may import `core` and nothing else
 * (`backend/eslint.config.js:50-53`), and the image-embedding worker (P2) plus
 * the answer path (P4) both need bytes off disk. Copying the resolver into
 * `llm` would have made two implementations of the traversal guard, which is
 * the one thing here that must never diverge.
 *
 * ── The two trees ─────────────────────────────────────────────────────────
 *
 *   <ATTACHMENTS_DIR>/<confluence_id | numeric page id>/<filename>
 *       The Confluence cache. Keyed by `pages.confluence_id` for a
 *       Confluence-sourced page, and by the numeric PK otherwise — the
 *       paste/import routes write pasted images under the PK on a standalone
 *       page (`pages-crud.ts:2723-2728`) and hand the editor that URL.
 *       Referenced in `body_html` as `/api/attachments/<key>/<file>`.
 *
 *   <ATTACHMENTS_DIR>/local/<page_id>/<filename>
 *       The local store (#302 Gap 4), whose metadata rows live in
 *       `local_attachments`. Layout owned by `local-attachment-service.ts`.
 *       Referenced in `body_html` as `/api/local-attachments/<page_id>/<file>`.
 *
 * **BOTH prefixes really occur in `body_html`, and one page can carry both.**
 * `relocateToLocal` copies every cached Confluence attachment into the local
 * store (`page-relocate-service.ts:672-684`), rewrites the body to
 * `/api/local-attachments/<page.id>/` (`:692-696`) and PERSISTS that body in
 * the same UPDATE that nulls `confluence_id` (`:729-752`), then deletes the old
 * cache directory (`:820`). The output shape is pinned by
 * `page-relocate-refs.test.ts:92-95`, and `rewriteAttachmentRefs`' own JSDoc
 * (`:214-218`) has said so all along. Nothing rewrites an `<img src>` at render
 * time — `ArticleViewer` fetches whichever of the two prefixes it finds.
 *
 * So the store an enumerator (P2) must ask for follows the URL PREFIX, never
 * `pages.confluence_id IS NULL`:
 *
 *   /api/attachments/…        ⇒ source: 'confluence'
 *   /api/local-attachments/…  ⇒ source: 'local'
 *
 * A relocated page has `confluence_id IS NULL` and its bytes in the LOCAL
 * store, so deriving the store from that column sends the read at
 * `<ATTACHMENTS_DIR>/<page_id>/`, where they have never been — and this
 * function answers `null`, which is indistinguishable from "no such
 * attachment". A page pasted into after the relocate then carries a
 * `/api/attachments/<page_id>/…` reference beside the local ones, which is why
 * `source` is part of `page_image_embeddings`' unique key.
 *
 * ── Authorisation ─────────────────────────────────────────────────────────
 *
 * {@link resolveAttachmentBytes} is a **system read**. It applies no user ACL
 * at all — no page visibility, no space RBAC, no per-page ACE. It exists for
 * the embedding worker (which runs outside any request) and for the answer
 * path AFTER retrieval has already applied the visibility predicate to the
 * pages it returned.
 *
 * It must never be reachable from a route without an authorisation check in
 * front of it. Routes have gated readers already: `getLocalAttachment`
 * (ACL-checked, DB-backed) for local pages, and `readAttachment` behind
 * `routes/confluence/attachments.ts`'s own page-access check for the
 * Confluence tree. `attachment-store.test.ts` walks `src/routes` and fails if
 * any file there so much as names this function.
 */

import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';
import { sniffImageFormat } from './image-validator.js';
import { canStoreLocalFilename, localAttachmentsDir } from './local-attachment-service.js';
import { confluenceAttachmentDirKey } from './image-references.js';
import type { ImageFormat, PageSource } from '@compendiq/contracts';

const ATTACHMENTS_BASE = process.env.ATTACHMENTS_DIR ?? 'data/attachments';
const ATTACHMENTS_BASE_RESOLVED = path.resolve(ATTACHMENTS_BASE);

// Allowed shape for a Confluence page identifier as we use it on disk.
// Confluence DC native IDs are numeric; our tests and a few legacy callers
// also use short kebab-style IDs (e.g. `page-1`). We accept letters, digits,
// `_`, `-` only — slashes, dots, NUL bytes, and any other separator-like
// character cause rejection up front, so a malicious pageId can never reach
// `path.resolve` / `path.join`.
const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function validatePageId(pageId: string): string {
  if (typeof pageId !== 'string' || pageId.length === 0 || !PAGE_ID_PATTERN.test(pageId)) {
    throw new Error('Invalid page ID');
  }
  return pageId;
}

/**
 * Whether an attachment filename is one the stores will hold — the same rule
 * {@link validateFilename} enforces, asked as a question instead of thrown.
 *
 * Callers that must not blow up on a file they merely *found* need to check
 * before they read: `validateFilename` throws a bare `Error`, which surfaces as
 * a masked 500 several layers up (#1169).
 */
export function isStorableAttachmentFilename(filename: string): boolean {
  if (typeof filename !== 'string') {
    return false;
  }
  // `path.basename` strips any directory components — `../../etc/passwd`
  // collapses to `passwd`, `/abs/file` to `file`. We then re-validate.
  const base = path.basename(filename);
  if (base.length === 0) {
    return false;
  }
  if (base.includes('\0')) {
    return false;
  }
  // Reject hidden / metadata files (`.`, `..`, `.htaccess`, …). After
  // `basename`, `..` and `.` would otherwise round-trip through the
  // containment check unchanged, which is still safe but pointless.
  if (base.startsWith('.')) {
    return false;
  }
  return true;
}

export function validateFilename(filename: string): string {
  if (!isStorableAttachmentFilename(filename)) {
    throw new Error('Invalid filename');
  }
  return path.basename(filename);
}

/**
 * Attachments are stored in a shared directory keyed only by pageId.
 * The public-facing functions still accept a `userId` argument for
 * backward compatibility / observability, but the on-disk path no longer
 * depends on it.
 */
export function attachmentDir(pageId: string): string {
  const safeId = validatePageId(pageId);
  // safeId is constrained to /^[A-Za-z0-9_-]+$/ by validatePageId above,
  // so it cannot contain `..`, separators, NUL bytes, or anything else
  // path.resolve would interpret as an escape.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- pageId is validated against an allow-list (PAGE_ID_PATTERN) above; containment is asserted below
  const resolved = path.resolve(ATTACHMENTS_BASE_RESOLVED, safeId);
  if (!resolved.startsWith(ATTACHMENTS_BASE_RESOLVED + path.sep)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/**
 * Build the on-disk path for an attachment, with explicit traversal-safe
 * validation of both `pageId` and `filename`. Throws on any input that
 * does not fit the strict allow-list — no unvalidated user-controlled
 * input reaches `path.resolve`.
 *
 * Replaces the previous `attachmentPath(userId, pageId, filename)` helper,
 * which relied on `path.basename` sanitisation plus a generic `// nosemgrep`
 * annotation. The new helper makes the invariant explicit and asserts the
 * resolved path stays under the attachments root (with `path.sep`, so the
 * `/base-evil` prefix-overlap trick is rejected).
 */
export function safeAttachmentPath(pageId: string, filename: string): string {
  const safeFilename = validateFilename(filename);
  const dir = attachmentDir(pageId);
  // Both inputs are validated by helpers above: pageId by an allow-list,
  // filename by basename + checks for empty / NUL / dotfile. The
  // containment assertion that follows is the final defence-in-depth.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- both arguments are validated above (validatePageId, validateFilename) and containment is asserted below
  const resolved = path.resolve(dir, safeFilename);
  if (!resolved.startsWith(ATTACHMENTS_BASE_RESOLVED + path.sep)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/**
 * Read a cached attachment. If the exact filename is not found, searches for
 * cross-page reference variants (.xref-{hash}) that match the same base name.
 * This handles the case where stale cached HTML references a plain filename
 * but the sync stored the file with an xref suffix.
 */
export async function readAttachment(userId: string, pageId: string, filename: string): Promise<Buffer | null> {
  const fullPath = safeAttachmentPath(pageId, filename);
  try {
    return await fs.readFile(fullPath);
  } catch (err) {
    logger.debug({ pageId, filename, fullPath, error: (err as NodeJS.ErrnoException).code }, 'Exact attachment path miss');
  }

  // Search for .xref- variants: "foo.jpg" matches "foo.xref-{hash}.jpg"
  const safe = validateFilename(filename);
  const dir = attachmentDir(pageId);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  const prefix = `${stem}.xref-`;

  try {
    const entries = await fs.readdir(dir);
    const match = entries.find((e) => e.startsWith(prefix) && e.endsWith(ext));
    if (match) {
      logger.debug({ pageId, filename, xrefMatch: match }, 'Serving attachment via xref fallback');
      return await fs.readFile(safeAttachmentPath(pageId, match));
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
    // draw.io XML sibling uploaded by the PUT route with content-type
    // application/xml — keep the served Content-Type consistent so browsers
    // don't fall back to octet-stream (download-only) when a user inspects
    // the cached .drawio file directly.
    '.drawio': 'application/xml',
  };
  return mimeTypes[ext] ?? 'application/octet-stream';
}

/**
 * Resolve the attachments root at CALL time (#1123).
 *
 * `ATTACHMENTS_BASE` above is captured at module load, which is right for the
 * long-lived process but pins the directory for anything importing this module
 * — including integration tests that point `ATTACHMENTS_DIR` at a temp dir
 * after the import graph is already resolved. The relocate helpers below run
 * rarely and must be testable, so they re-read the env each call. Same
 * rationale as `attachmentsBase()` in `core/services/local-attachment-service`.
 *
 * Exported since #1349: the orphan sweep walks the tree top-down and must
 * anchor every judgement under the same root the removal helpers below
 * resolve against — a walker deriving its own root is how a stat and the rm
 * beside it start naming different files.
 */
export function attachmentsRootNow(): string {
  return path.resolve(process.env.ATTACHMENTS_DIR ?? ATTACHMENTS_BASE);
}

/** Call-time equivalent of {@link attachmentDir}, with the same traversal guard. */
function attachmentDirNow(pageId: string): string {
  const safeId = validatePageId(pageId);
  const root = attachmentsRootNow();
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- pageId is validated against PAGE_ID_PATTERN by validatePageId; containment is asserted below
  const resolved = path.resolve(root, safeId);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/** Absolute path of the Confluence-cache directory for an attachment key. */
export function attachmentCacheDir(pageId: string): string {
  return attachmentDirNow(pageId);
}

/**
 * Filenames cached for an attachment key. Empty when the directory is absent.
 *
 * Hidden entries are skipped: no write path in either store can create one
 * (`validateFilename` here, `localFilePath` in the local store both refuse a
 * leading dot), so a dot-named file is always something else writing into the
 * directory — `.DS_Store`, an AppleDouble sidecar, an rsync temp file. Listing
 * it made the caller's very next read throw `Invalid filename`, which failed an
 * entire relocate over debris nothing references (#1169).
 */
export async function listCachedAttachments(pageId: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(attachmentDirNow(pageId), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && isStorableAttachmentFilename(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The on-disk path of one cached attachment, with the containment check.
 *
 * Extracted so the reader and {@link resolveAttachmentByteSize} cannot end up
 * resolving the same key to two different files: a `stat` that names a
 * different path than the `readFile` beside it measures the wrong file, which
 * is the exact failure a size ceiling exists to prevent. Throws on traversal
 * rather than answering null, because a refused path is a bug in the caller
 * and not an absent file.
 */
function cachedAttachmentPath(pageId: string, filename: string): string {
  const dir = attachmentDirNow(pageId);
  const safeFilename = validateFilename(filename);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- both inputs validated above (validatePageId via attachmentDirNow, validateFilename); containment asserted below
  const resolved = path.resolve(dir, safeFilename);
  if (!resolved.startsWith(attachmentsRootNow() + path.sep)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/** Read one cached attachment's bytes by key + filename, or null if absent. */
export async function readCachedAttachmentFile(
  pageId: string,
  filename: string,
): Promise<Buffer | null> {
  const resolved = cachedAttachmentPath(pageId, filename);
  try {
    return await fs.readFile(resolved);
  } catch {
    return null;
  }
}

// ── Validated removal (#1349) ──────────────────────────────────────────────
//
// The ONLY sanctioned deleters in the Confluence-style tree outside
// `domains/confluence`'s own page-scoped cleanup. Both resolve through the
// same validated, containment-checked path helpers the readers use, so a key
// or filename that came off `readdir` of a hostile disk (or a DB row edited
// by hand) can never turn an `rm` loose outside the attachments root. They
// THROW on a refused input rather than silently no-op, because a refused path
// is a bug in the caller and not an absent file — the orphan sweep and the
// standalone-delete cleanup both wrap them.

/**
 * Remove one attachment key's whole directory (recursive, idempotent).
 * Throws on an invalid key or traversal; ENOENT is a no-op via `force`.
 */
export async function removeCachedAttachmentDirectory(pageId: string): Promise<void> {
  await fs.rm(attachmentDirNow(pageId), { recursive: true, force: true });
}

/**
 * Remove exactly one cached file under an attachment key.
 *
 * Stricter than the readers about the filename: `validateFilename` collapses
 * `../b.png` to `b.png` via `basename`, which for a *read* returns the wrong
 * bytes and for a *delete* would destroy a different file than the caller
 * named. A deleter must never guess, so a filename that is not its own
 * basename is refused outright. Throws on any refused input or traversal;
 * ENOENT is a no-op via `force`.
 */
export async function removeCachedAttachmentFile(pageId: string, filename: string): Promise<void> {
  if (typeof filename !== 'string' || path.basename(filename) !== filename) {
    throw new Error('Invalid filename');
  }
  await fs.rm(cachedAttachmentPath(pageId, filename), { force: true });
}

// ── The one new API (#1115) ────────────────────────────────────────────────

/** Which store an `attachment_key` resolves in — mirrors `page_image_embeddings.source`. */
export type AttachmentStoreSource = 'confluence' | 'local';

/**
 * The Confluence-tree directory key for a page — {@link
 * confluenceAttachmentDirKey}, imported rather than restated.
 *
 * It used to be a private copy here. #1115 P3 needs the same rule to build the
 * `<img src>` an image source points at, and a third definition of "which
 * directory holds this page's bytes" is how a reader and a writer start
 * disagreeing silently: this module answers `null` for a mis-keyed directory,
 * and a mis-keyed URL 404s in a source chip. `image-references.ts` is where it
 * lives now, beside the enumerator that parses the same URLs back apart, and
 * its JSDoc carries the reasoning (including why `pageSource` is required and
 * why the empty-string case matches `parentKeyFor`).
 */
const confluenceTreeKey = confluenceAttachmentDirKey;

export interface ResolveAttachmentBytesInput {
  /** `pages.id` — the numeric PK, also the local store's directory key. */
  pageId: number;
  /** `pages.confluence_id`, or null/undefined for a standalone page. */
  confluenceId?: string | null;
  /**
   * `pages.source` — `'confluence' | 'standalone'`. Required, and NOT the same
   * field as {@link ResolveAttachmentBytesInput.source} below, which names a
   * STORE and whose values are `'confluence' | 'local'`.
   *
   * It is what decides the Confluence-tree directory key, and it is required
   * so that decision cannot be inferred from `confluenceId` alone. Two places
   * already own this derivation and both branch on `pages.source`:
   * `pages-crud.ts:2723-2728` (the paste/import writer) and `parentKeyFor` in
   * `page-relocate-service.ts:140-142`. `confluenceId ?? pageId` agrees with
   * them on every row a writer can currently produce and disagrees on
   * `source = 'standalone'` with a non-null `confluence_id` — so a caller doing
   * the obvious `SELECT id, confluence_id FROM pages` would read a different
   * page's directory the day such a row exists. Ignored when `source` is
   * `'local'`, whose key is always the numeric PK.
   */
  pageSource: PageSource;
  /** Which STORE the key resolves in — see {@link AttachmentStoreSource}. */
  source: AttachmentStoreSource;
  /**
   * Filename inside that store, as it is ON DISK: the basename of the
   * `<img src>` in `body_html`, **URL-decoded**. The converter and the paste
   * route both percent-encode the filename into the `src`
   * (`content-converter.ts:366`, `pages-crud.ts:2730`) while the bytes are
   * written under the raw name, so an enumerator must call
   * `decodeURIComponent` on the basename. A raw `Screen%20shot.png` resolves
   * to nothing against an existing `Screen shot.png`, and this function
   * answers `null` either way — the miss is silent.
   */
  key: string;
}

export interface ResolvedAttachmentBytes {
  bytes: Buffer;
  /**
   * `null` means the bytes are not one of the four raster formats #1154
   * accepts — most often Confluence's draw.io export, which is `<mxfile>` XML
   * behind a `.png` name. Reported rather than swallowed so the caller can
   * skip and COUNT it; `null` for the whole call would be indistinguishable
   * from "no such attachment".
   */
  sniffedFormat: ImageFormat | null;
}

/**
 * A key names one file directly inside one page's directory. Anything else —
 * a traversal, a sub-path, an absolute path, a dotfile — is refused rather
 * than collapsed with `path.basename`, because `basename('../secret.png')` is
 * `secret.png` and a basename-and-read would then return a *different* file
 * that happens to share the name: the wrong bytes in the index, under the
 * right key.
 */
function isDirectChildKey(key: string): boolean {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    !key.includes('\0') &&
    path.basename(key) === key &&
    isStorableAttachmentFilename(key)
  );
}

/**
 * Bytes for one of a page's attachments, from whichever store holds it, plus
 * the format sniffed from those bytes. `null` when the key is refused or the
 * file is not there.
 *
 * **This applies NO authorisation** — see the module header. It is for the
 * embedding worker and for the post-retrieval answer path, never for a route.
 *
 * Never throws: a page's images are enumerated from its HTML, and one bad key
 * must not abort the whole page's batch. A refusal is logged and answered as
 * an absence.
 *
 * Note it reads the EXACT key and does not run `readAttachment`'s `.xref-`
 * fallback. Normally the key IS the on-disk name: it comes out of the same
 * `body_html` the converter wrote when the sync named the file. But not
 * always — `readAttachment`'s fallback exists precisely because a legacy or
 * stale `body_html` can still name the pre-xref filename for a file stored
 * with an `.xref-{hash}` suffix (see its docstring above), and this reader
 * answers `null` for that case. That is the accepted trade: the image is
 * skipped and counted, never read as the wrong bytes, and an index pays no
 * per-image `readdir` for a name the next sync rewrites anyway — where a
 * route serving one page to a waiting user does find the extra `readdir`
 * worth it.
 *
 * "Exact" includes the encoding: this does NOT `decodeURIComponent` the key,
 * and must not start to. The key is the on-disk name (see
 * {@link ResolveAttachmentBytesInput.key}) and a file may legitimately be
 * named `a%20b.png`; decoding here would read a different file for it. The
 * decode belongs in the enumerator that lifts the name out of an `<img src>`.
 */
export async function resolveAttachmentBytes(
  input: ResolveAttachmentBytesInput,
): Promise<ResolvedAttachmentBytes | null> {
  const { pageId, confluenceId, pageSource, source, key } = input;

  if (!isDirectChildKey(key)) {
    logger.warn({ pageId, source, key }, 'attachment-store: refused an attachment key that is not a plain filename');
    return null;
  }

  try {
    const bytes = source === 'local'
      ? await readLocalStoreFile(pageId, key)
      : await readCachedAttachmentFile(confluenceTreeKey(pageSource, pageId, confluenceId), key);

    if (bytes === null) return null;
    return { bytes, sniffedFormat: sniffImageFormat(bytes) };
  } catch (err) {
    logger.warn({ err, pageId, source, key }, 'attachment-store: could not resolve attachment bytes');
    return null;
  }
}

/**
 * `<ATTACHMENTS_DIR>/local/<page_id>/<filename>`, layout owned by the local
 * store — the local half of {@link cachedAttachmentPath}, extracted for the
 * same reason.
 */
function localStorePath(pageId: number, key: string): string {
  if (!Number.isInteger(pageId) || pageId <= 0) {
    throw new Error('Invalid page id');
  }
  if (!canStoreLocalFilename(key)) {
    // The two stores' filename rules differ by design (this one caps length,
    // the Confluence one rejects NUL bytes), so a key must satisfy the rule of
    // the store it is being read from.
    throw new Error('Invalid filename');
  }
  const dir = localAttachmentsDir(pageId);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `key` is asserted to equal its own basename by isDirectChildKey, `dir` is containment-checked by localAttachmentsDir
  const resolved = path.resolve(dir, key);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

async function readLocalStoreFile(pageId: number, key: string): Promise<Buffer | null> {
  const resolved = localStorePath(pageId, key);
  try {
    return await fs.readFile(resolved);
  } catch {
    return null;
  }
}

/**
 * How many bytes {@link resolveAttachmentBytes} would return for this input,
 * WITHOUT reading them — or `null` when that cannot be established.
 *
 * The ceilings around images are all post-hoc: `validateImage` measures
 * `buf.length` and `MAX_IMAGE_DIMENSION` reads a header, both of which need
 * the whole buffer in memory first. That is fine for the intake worker, which
 * reads a page's images once and off the request path. It is not fine for
 * #1115 P4, which reads candidates on the ANSWER path, before `reply.hijack()`
 * and with no cache in front of it: an attachment that has been replaced since
 * it was indexed can be any size the store will hold (the draw.io route admits
 * 40 MiB), and the pick would load each one whole only to refuse it.
 *
 * So the answer path stats first and skips. `null` is deliberately ambiguous —
 * absent file, refused key, unreadable directory — and callers must treat it
 * as "unknown, go and read": failing OPEN keeps a stat that a hardened
 * filesystem refuses from turning a perfectly readable picture into a skip,
 * and the read behind it is still bounded by the caller's own gate. It is a
 * mitigation, not a guarantee: a file can grow between the stat and the read.
 */
export async function resolveAttachmentByteSize(
  input: ResolveAttachmentBytesInput,
): Promise<number | null> {
  const { pageId, confluenceId, pageSource, source, key } = input;
  if (!isDirectChildKey(key)) return null;
  try {
    const resolved = source === 'local'
      ? localStorePath(pageId, key)
      : cachedAttachmentPath(confluenceTreeKey(pageSource, pageId, confluenceId), key);
    const stat = await fs.stat(resolved);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

// Test-only: expose validators so unit tests can exercise the validation logic
// directly without going through the higher-level cache functions (which mock
// out `fs` and `client`). Not part of the public module surface.
export const __internal = {
  validatePageId,
  validateFilename,
  safeAttachmentPath,
  attachmentDir,
  ATTACHMENTS_BASE,
  ATTACHMENTS_BASE_RESOLVED,
};
