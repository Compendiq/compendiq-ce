/**
 * #1349 — attachment storage observability + the dry-run-first orphan sweep.
 *
 * `data/attachments` grows without bound: three intake paths write (Confluence
 * sync, paste/import, draw.io saves), the only removals are page-scoped, and
 * `local_attachments`' CASCADE removes rows, never files. This service walks
 * the two stores, measures them, and — only on an explicit live run — deletes
 * what the conservative orphan rules below admit, pruning the matching
 * `page_image_embeddings` rows and re-queueing the affected pages.
 *
 * ── The orphan rules (design of record, PR #1349) ─────────────────────────
 *
 * The two stores are walked SEPARATELY. The Confluence-style tree is
 * `readdir(attachmentsRootNow())` minus the reserved `local/` entry — that
 * entry lives INSIDE the same root and its name matches the tree's key
 * pattern, so a naive walk would list the entire local store as one "orphan
 * directory". The local store is walked under `localAttachmentsRoot()` only.
 *
 * (a) **Directory-level orphans**: a directory whose key matches NO page row
 *     at all — `pages.confluence_id` OR `pages.id` for the Confluence-style
 *     tree (both kinds share one keyspace: DC ids sit inside `pages.id`'s
 *     range), `pages.id` for the local store — where "page row" includes
 *     soft-deleted/trashed pages (restorable) and folders.
 * (b) **Per-file orphans**, judged against a GLOBAL keep-set per store, never
 *     the owning page's body alone: attachment URLs are copied verbatim
 *     between bodies (templates hand their `body_html` to every page created
 *     from them), and one directory key can belong to two page rows, so a
 *     filename referenced ANYWHERE is kept EVERYWHERE. The keep-set is fed
 *     from every `pages.body_html` / `draft_body_html` / `body_storage`
 *     (live AND trashed), every `page_versions.body_html`, every
 *     `pending_sync_versions.body_html`/`body_storage`, every
 *     `templates.body_html` and every `comments.body_html` — collecting BOTH
 *     `img[src]` and `a[href]`-style references via a raw-string regex
 *     (strictly more inclusive than an attribute parse), plus
 *     `getExpectedAttachmentFilenames` over storage format. In the Confluence
 *     tree only IMAGE-LIKE files are per-file candidates
 *     (`SUPPORTED_IMAGE_EXTENSIONS` + `external-<hash>` keys): the cache also
 *     holds lazily fetched non-image attachments no enumerator covers — those
 *     are left alone in this PR. In the local store a per-file candidate is a
 *     file with no `local_attachments` row (plus the same URL keep-set);
 *     rows whose FILE is missing are counted, never deleted — a mis-pointed
 *     `ATTACHMENTS_DIR` would otherwise wipe every row.
 * (c) **24h mtime grace at BOTH levels**: a file younger than the window is
 *     never a candidate, and a directory is a candidate only when the
 *     directory itself AND every contained file are older — paste stages
 *     bytes before the body save, and sync downloads a new page's attachments
 *     BEFORE the `pages` INSERT.
 * (d) Dot-files are skipped (#1169); `external-<hash>` cache files follow the
 *     same reference rules (no separate TTL).
 * (e) **Root sanity**: any run refuses when the root is missing/unreadable; a
 *     LIVE run additionally refuses when a store has zero files on disk while
 *     the database still references it (anomaly — nothing is ever deleted on
 *     the strength of an ENOENT alone, and a directory must have been
 *     successfully readdir'd before any of its files can be judged).
 *
 * A live run deletes only what the SAME walk lists now — never a stale
 * dry-run list — and re-verifies each candidate (page existence, grace) at
 * delete time. All removals go through the validated core helpers
 * (`removeCachedAttachment*`, `removeLocalAttachment*`); no path is ever
 * concatenated from DB values here.
 *
 * One residual TOCTOU window is ACCEPTED and bounded (review r3): the
 * keep-set is built once per run, so a body reference written to an
 * already-aged orphan file AFTER the build but BEFORE the delete loop reaches
 * it is not re-seen, and the file is deleted while a body now names it. Every
 * product path that creates a reference also writes the bytes — a fresh mtime
 * the grace re-check does honour — so the exposed spelling is a
 * reference-without-write: a raw attachment URL pasted as text into a body
 * mid-run, pointing at a >24h-old file no other body referenced. The window
 * is one run's duration. Tightening it would mean re-running
 * `collectAttachmentUrlReferences` over bodies modified since the run started
 * before each delete; not worth the extra read pass today.
 *
 * Lives in `domains/confluence` (not `core`): the keep-set needs
 * `getExpectedAttachmentFilenames`, which is confluence-domain, and `core`
 * may not import a domain. Routes reach it from `routes/confluence`.
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { z } from 'zod';
import {
  AttachmentStoreSweepStatsSchema,
  AttachmentSweepRunSchema,
  type AttachmentStoreSweepStats,
  type AttachmentSweepCandidate,
  type AttachmentSweepRun,
} from '@compendiq/contracts';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import {
  acquireWorkerLock,
  refreshWorkerLock,
  releaseWorkerLock,
} from '../../../core/services/redis-cache.js';
import {
  attachmentsRootNow,
  removeCachedAttachmentDirectory,
  removeCachedAttachmentFile,
} from '../../../core/services/attachment-store.js';
import {
  LOCAL_STORE_DIRNAME,
  localAttachmentsRoot,
  removeLocalAttachmentDirectory,
  removeLocalAttachmentFileForSweep,
} from '../../../core/services/local-attachment-service.js';
import { markPageImagesDirty } from '../../../core/services/image-embedding-dirty.js';
import { logAuditEvent } from '../../../core/services/audit-service.js';
import { SUPPORTED_IMAGE_EXTENSIONS, isExternalImageKey } from '../../../core/services/image-references.js';
import { getExpectedAttachmentFilenames } from './attachment-handler.js';

export const ATTACHMENT_SWEEP_WORKER_LOCK = 'attachment-sweep';
/** `admin_settings` key holding the last run's summary, as JSON. */
export const ATTACHMENT_SWEEP_LAST_RUN_KEY = 'attachment_sweep_last_run';
/** `admin_settings` key holding the per-store stats of the last COMPLETED walk. */
export const ATTACHMENT_STORAGE_STATS_KEY = 'attachment_storage_stats';

/**
 * Nothing younger than this is ever a candidate — paste and sync both write
 * files before the row/body that references them exists.
 */
export const ATTACHMENT_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/** Bounded candidate sample in the persisted record; totals stay exact. */
export const CANDIDATE_SAMPLE_MAX = 100;

/** Worker-lock TTL and its refresh cadence (a walk can outlive one TTL). */
const LOCK_TTL_SECONDS = 300;
const LOCK_REFRESH_MS = 60_000;

/** Rows per keep-set batch — only the filename Set stays in memory. */
const KEEP_SET_BATCH = 200;
/** Directory keys per page-existence query. */
const KEY_BATCH = 500;

/** Same allow-list as `attachment-store.ts` — a key that fails it is skipped. */
const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Local-store directories are numeric PKs as written by `String(pageId)`. */
const LOCAL_DIR_PATTERN = /^[1-9][0-9]*$/;
const PG_INT4_MAX = 2_147_483_647;

// ── Keep-set ───────────────────────────────────────────────────────────────

export interface AttachmentKeepSets {
  confluence: Set<string>;
  local: Set<string>;
}

/**
 * Every `/api/attachments/<key>/<file>` and `/api/local-attachments/<id>/<file>`
 * spelling in a body text, keyed into the store the prefix names.
 *
 * A raw-string regex, deliberately: it sees `img[src]`, `a[href]` (#1169 —
 * Markdown import produces anchor references and relocate rewrites them), and
 * any other attribute or plain-text spelling, without a JSDOM parse per row.
 * Strictly MORE inclusive than an attribute walk — over-keeping is safe,
 * under-keeping deletes a referenced file.
 *
 * Both the raw and the decoded spelling are kept: bytes sit on disk under the
 * URL-DECODED name (the converter percent-encodes on the way out), but a file
 * really can be named with literal `%` sequences, and the collector cannot
 * know which. Names that are not plain basenames are dropped — no store can
 * hold them (`validateFilename` refuses them at write time).
 *
 * The filename class deliberately ADMITS the apostrophe (review r2): every
 * URL writer in the product goes through `encodeURIComponent`, which leaves
 * `' ! ( ) * ~` literal, so `'` really occurs mid-name in the URLs bodies
 * carry — excluding it truncated `John's%20notes.png` to `John`, the on-disk
 * file missed the keep-set, and a live run deleted a referenced file. The
 * single-quoted-attribute spelling this admits (`src='…/a.png'`) drags the
 * closing quote into the match; the punctuation trim below adds the clean
 * variant, and keeping the quoted spelling too only over-keeps. When the
 * quote is chased by a slash (`src='…/a.png'/>`, review r3), the trim cannot
 * reach it — the apostrophe-truncated prefix in the loop below covers that
 * spelling instead.
 */
const ATTACHMENT_URL_RE = /\/api\/(local-attachments|attachments)\/[A-Za-z0-9_-]+\/([^"<>\s?#\\]+)/g;

export function collectAttachmentUrlReferences(
  text: string | null | undefined,
  into: AttachmentKeepSets,
): void {
  if (!text) return;
  for (const match of text.matchAll(ATTACHMENT_URL_RE)) {
    const store = match[1] === 'attachments' ? 'confluence' : 'local';
    const raw = match[2]!;
    const names = new Set<string>([raw]);
    try {
      names.add(decodeURIComponent(raw));
    } catch {
      // A lone `%` throws; the raw name is then what is on disk.
    }
    // Also keep punctuation-trimmed variants: a plain-text spelling can drag a
    // trailing bracket or period into the match, and a single-quoted attribute
    // its closing quote. More names kept = safer.
    for (const name of [...names]) {
      const trimmed = name.replace(/['")\]},.;:!]+$/, '');
      if (trimmed) names.add(trimmed);
    }
    // And the apostrophe-truncated prefix (review r3): `src='…/a.png'/>` with
    // no space before the self-closing slash drags `'/` into the match — `/`
    // is not in the trim set, so every variant above still ends in a slash and
    // the basename filter below drops the whole spelling. The pre-r2 regex
    // terminated at the quote and kept `a.png`; re-adding that spelling as one
    // more ADDED variant makes the keep-set a superset of both regimes (the
    // full apostrophe-carrying name stays kept — r2's fix is untouched).
    for (const name of [...names]) {
      const cut = name.indexOf("'");
      if (cut > 0) names.add(name.slice(0, cut));
    }
    for (const name of names) {
      if (!name || name.startsWith('.') || name.includes('\0')) continue;
      if (path.basename(name) !== name) continue;
      into[store].add(name);
    }
  }
}

/** Keyset-paginated read so concurrent inserts/deletes cannot shift a window. */
async function forEachBatch<T extends { __cursor: string | number }>(
  sqlFor: (cursor: string | number | null) => { sql: string; params: unknown[] },
  initialCursor: string | number | null,
  onRows: (rows: T[]) => void,
): Promise<void> {
  let cursor = initialCursor;
  for (;;) {
    const { sql, params } = sqlFor(cursor);
    const res = await query<T>(sql, params);
    if (res.rows.length === 0) return;
    onRows(res.rows);
    cursor = res.rows[res.rows.length - 1]!.__cursor;
    if (res.rows.length < KEEP_SET_BATCH) return;
  }
}

/**
 * The global keep-set, one `Set<filename>` per store, fed from every body
 * text in the system — see the module header for the full source list.
 *
 * `body_storage` additionally runs through `getExpectedAttachmentFilenames`
 * (a pure function, recomputed at sweep time — the cached
 * `expected_image_files` column is deliberately not consulted, which removes
 * its NULL-means-uncomputed question), because storage format references
 * attachments by `ri:filename`, not by URL. A parse failure THROWS: an
 * unparseable body means unknown references, and the safe verdict for
 * "unknown" is to fail the run, not to shrink the keep-set.
 */
export async function buildAttachmentKeepSets(): Promise<AttachmentKeepSets> {
  const keep: AttachmentKeepSets = { confluence: new Set(), local: new Set() };

  type PageRow = {
    __cursor: number;
    body_html: string | null;
    draft_body_html: string | null;
    body_storage: string | null;
    space_key: string | null;
  };
  await forEachBatch<PageRow>(
    (cursor) => ({
      sql: `SELECT id AS __cursor, body_html, draft_body_html, body_storage, space_key
              FROM pages WHERE id > $1 ORDER BY id LIMIT ${KEEP_SET_BATCH}`,
      params: [cursor ?? 0],
    }),
    0,
    (rows) => {
      for (const row of rows) {
        collectAttachmentUrlReferences(row.body_html, keep);
        collectAttachmentUrlReferences(row.draft_body_html, keep);
        if (row.body_storage) {
          collectAttachmentUrlReferences(row.body_storage, keep);
          for (const name of getExpectedAttachmentFilenames(row.body_storage, row.space_key ?? undefined)) {
            keep.confluence.add(name);
          }
        }
      }
    },
  );

  type VersionRow = { __cursor: string; body_html: string | null };
  await forEachBatch<VersionRow>(
    (cursor) => ({
      sql: `SELECT id::text AS __cursor, body_html
              FROM page_versions WHERE id::text > $1 ORDER BY id::text LIMIT ${KEEP_SET_BATCH}`,
      params: [cursor ?? ''],
    }),
    '',
    (rows) => {
      for (const row of rows) collectAttachmentUrlReferences(row.body_html, keep);
    },
  );

  type PendingRow = {
    __cursor: string;
    body_html: string | null;
    body_storage: string | null;
    space_key: string | null;
  };
  await forEachBatch<PendingRow>(
    (cursor) => ({
      sql: `SELECT psv.id::text AS __cursor, psv.body_html, psv.body_storage, p.space_key
              FROM pending_sync_versions psv
              LEFT JOIN pages p ON p.id = psv.page_id
             WHERE psv.id::text > $1 ORDER BY psv.id::text LIMIT ${KEEP_SET_BATCH}`,
      params: [cursor ?? ''],
    }),
    '',
    (rows) => {
      for (const row of rows) {
        collectAttachmentUrlReferences(row.body_html, keep);
        if (row.body_storage) {
          collectAttachmentUrlReferences(row.body_storage, keep);
          for (const name of getExpectedAttachmentFilenames(row.body_storage, row.space_key ?? undefined)) {
            keep.confluence.add(name);
          }
        }
      }
    },
  );

  type SimpleRow = { __cursor: number; body_html: string | null };
  for (const table of ['templates', 'comments'] as const) {
    await forEachBatch<SimpleRow>(
      (cursor) => ({
        sql: `SELECT id AS __cursor, body_html FROM ${table} WHERE id > $1 ORDER BY id LIMIT ${KEEP_SET_BATCH}`,
        params: [cursor ?? 0],
      }),
      0,
      (rows) => {
        for (const row of rows) collectAttachmentUrlReferences(row.body_html, keep);
      },
    );
  }

  return keep;
}

// ── Candidate predicates ───────────────────────────────────────────────────

/**
 * The only per-file candidate class in the Confluence tree: files the image
 * pipeline wrote — `SUPPORTED_IMAGE_EXTENSIONS` (which covers draw.io `.png`
 * exports) plus `external-<hash>` cache keys, which may carry no extension.
 * Everything else (lazily fetched PDFs, `.drawio` XML siblings, …) has no
 * enumerator and is left alone in this PR.
 */
export function isImageLikeCandidate(filename: string): boolean {
  if (isExternalImageKey(filename)) return true;
  return SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/** Keys castable to `pages.id` — the exact discipline of `markPageImagesDirtyByAttachmentKey`. */
function asPageId(key: string): number | null {
  const parsed = Number(key);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > PG_INT4_MAX) return null;
  if (String(parsed) !== key) return null; // zero-padded '007' must not match id 7
  return parsed;
}

/** Which of `keys` any page row (live, trashed, folder — all of them) claims. */
async function knownConfluenceTreeKeys(keys: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < keys.length; i += KEY_BATCH) {
    const batch = keys.slice(i, i + KEY_BATCH);
    const byConfluenceId = await query<{ confluence_id: string }>(
      `SELECT DISTINCT confluence_id FROM pages WHERE confluence_id = ANY($1::text[])`,
      [batch],
    );
    for (const row of byConfluenceId.rows) known.add(row.confluence_id);
    const numeric = batch.map(asPageId).filter((n): n is number => n !== null);
    if (numeric.length > 0) {
      const byId = await query<{ id: number }>(
        `SELECT id FROM pages WHERE id = ANY($1::int[])`,
        [numeric],
      );
      for (const row of byId.rows) known.add(String(row.id));
    }
  }
  return known;
}

async function knownLocalPageIds(ids: number[]): Promise<Set<number>> {
  const known = new Set<number>();
  for (let i = 0; i < ids.length; i += KEY_BATCH) {
    const batch = ids.slice(i, i + KEY_BATCH);
    const res = await query<{ id: number }>(`SELECT id FROM pages WHERE id = ANY($1::int[])`, [batch]);
    for (const row of res.rows) known.add(row.id);
  }
  return known;
}

// ── The walk ───────────────────────────────────────────────────────────────

interface WalkedFile {
  name: string;
  size: number;
  mtimeMs: number;
}

interface WalkedDir {
  key: string;
  files: WalkedFile[];
  bytes: number;
  dirMtimeMs: number;
}

function emptyStats(): AttachmentStoreSweepStats {
  return {
    bytes: 0,
    files: 0,
    directories: 0,
    orphanDirectories: 0,
    orphanDirectoryBytes: 0,
    orphanFiles: 0,
    orphanFileBytes: 0,
    graceSkipped: 0,
    unreadableDirectories: 0,
  };
}

class SweepAborted extends Error {
  constructor() {
    super('attachment sweep aborted: worker lock lost mid-run');
  }
}

/**
 * Read one key directory: plain files only, dot-files excluded, each stat'd.
 * `null` when the directory vanished mid-walk (ENOENT is not an error) or
 * could not be read (counted by the caller — never judged).
 */
async function readKeyDir(
  dirPath: string,
  key: string,
  stats: AttachmentStoreSweepStats,
): Promise<WalkedDir | null> {
  let entries;
  let dirStat;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
    dirStat = await fs.stat(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      stats.unreadableDirectories += 1;
    }
    return null;
  }
  const files: WalkedFile[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    try {
      const st = await fs.stat(path.join(dirPath, entry.name));
      files.push({ name: entry.name, size: st.size, mtimeMs: st.mtimeMs });
      bytes += st.size;
    } catch {
      // Vanished between readdir and stat — files appearing/disappearing
      // mid-walk is expected, not an error.
    }
  }
  stats.directories += 1;
  stats.files += files.length;
  stats.bytes += bytes;
  return { key, files, bytes, dirMtimeMs: dirStat.mtimeMs };
}

interface StoreWalkResult {
  stats: AttachmentStoreSweepStats;
  candidates: AttachmentSweepCandidate[];
}

function judgeDirectoryOrphan(
  store: 'confluence' | 'local',
  dir: WalkedDir,
  cutoffMs: number,
  stats: AttachmentStoreSweepStats,
  candidates: AttachmentSweepCandidate[],
): void {
  const aged = dir.dirMtimeMs < cutoffMs && dir.files.every((f) => f.mtimeMs < cutoffMs);
  if (!aged) {
    stats.graceSkipped += 1;
    return;
  }
  stats.orphanDirectories += 1;
  stats.orphanDirectoryBytes += dir.bytes;
  candidates.push({ store, key: dir.key, filename: null, bytes: dir.bytes, reason: 'orphan_directory' });
}

async function walkConfluenceTree(
  root: string,
  rootEntries: Array<{ name: string; isDirectory(): boolean }>,
  keep: Set<string>,
  assertNotAborted: () => void,
): Promise<StoreWalkResult> {
  const stats = emptyStats();
  const candidates: AttachmentSweepCandidate[] = [];
  const cutoffMs = Date.now() - ATTACHMENT_SWEEP_GRACE_MS;

  const keys = rootEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // The local store is walked separately; a dot-dir is debris; a key that
    // fails the allow-list is never judged and never touched.
    .filter((name) => name !== LOCAL_STORE_DIRNAME && !name.startsWith('.') && PAGE_ID_PATTERN.test(name));

  const known = await knownConfluenceTreeKeys(keys);

  for (const key of keys) {
    assertNotAborted();
    const dir = await readKeyDir(path.join(root, key), key, stats);
    if (dir === null) continue;

    if (!known.has(key)) {
      judgeDirectoryOrphan('confluence', dir, cutoffMs, stats, candidates);
    } else {
      for (const file of dir.files) {
        if (!isImageLikeCandidate(file.name)) continue;
        if (keep.has(file.name)) continue;
        if (file.mtimeMs >= cutoffMs) {
          stats.graceSkipped += 1;
          continue;
        }
        stats.orphanFiles += 1;
        stats.orphanFileBytes += file.size;
        candidates.push({
          store: 'confluence',
          key,
          filename: file.name,
          bytes: file.size,
          reason: 'orphan_file',
        });
      }
    }
    await yieldToLoop();
  }
  return { stats, candidates };
}

interface LocalWalkResult extends StoreWalkResult {
  /** `local_attachments` rows whose file was not seen on disk. */
  missingLocalFiles: number;
  /** Total `local_attachments` rows — the live-run anomaly check's referent. */
  totalRows: number;
}

async function walkLocalStore(
  keep: Set<string>,
  assertNotAborted: () => void,
): Promise<LocalWalkResult> {
  const stats = emptyStats();
  const candidates: AttachmentSweepCandidate[] = [];
  const cutoffMs = Date.now() - ATTACHMENT_SWEEP_GRACE_MS;

  // All rows, batched — the map holds filenames only.
  const rowsByPage = new Map<number, Set<string>>();
  type RowRow = { __cursor: number; page_id: number; filename: string };
  await forEachBatch<RowRow>(
    (cursor) => ({
      sql: `SELECT id AS __cursor, page_id, filename FROM local_attachments
             WHERE id > $1 ORDER BY id LIMIT ${KEEP_SET_BATCH}`,
      params: [cursor ?? 0],
    }),
    0,
    (rows) => {
      for (const row of rows) {
        let set = rowsByPage.get(row.page_id);
        if (!set) {
          set = new Set();
          rowsByPage.set(row.page_id, set);
        }
        set.add(row.filename);
      }
    },
  );
  const totalRows = [...rowsByPage.values()].reduce((n, s) => n + s.size, 0);

  const localRoot = localAttachmentsRoot();
  let rootEntries: Dirent[];
  try {
    rootEntries = await fs.readdir(localRoot, { withFileTypes: true });
  } catch {
    // No local store on disk at all. Every row's file is missing; whether
    // that is an anomaly is the live run's refusal check, not the walk's.
    return { stats, candidates, missingLocalFiles: totalRows, totalRows };
  }

  const seenByPage = new Map<number, Set<string>>();
  const ids = rootEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => LOCAL_DIR_PATTERN.test(name))
    .map((name) => Number(name))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= PG_INT4_MAX);

  const known = await knownLocalPageIds(ids);

  for (const pageId of ids) {
    assertNotAborted();
    const dir = await readKeyDir(path.join(localRoot, String(pageId)), String(pageId), stats);
    if (dir === null) continue;
    seenByPage.set(pageId, new Set(dir.files.map((f) => f.name)));

    if (!known.has(pageId)) {
      judgeDirectoryOrphan('local', dir, cutoffMs, stats, candidates);
    } else {
      const rows = rowsByPage.get(pageId);
      for (const file of dir.files) {
        if (rows?.has(file.name)) continue;
        if (keep.has(file.name)) continue;
        if (file.mtimeMs >= cutoffMs) {
          stats.graceSkipped += 1;
          continue;
        }
        stats.orphanFiles += 1;
        stats.orphanFileBytes += file.size;
        candidates.push({
          store: 'local',
          key: String(pageId),
          filename: file.name,
          bytes: file.size,
          reason: 'orphan_file',
        });
      }
    }
    await yieldToLoop();
  }

  let missingLocalFiles = 0;
  for (const [pageId, filenames] of rowsByPage) {
    const seen = seenByPage.get(pageId);
    for (const filename of filenames) {
      if (!seen?.has(filename)) missingLocalFiles += 1;
    }
  }

  return { stats, candidates, missingLocalFiles, totalRows };
}

// ── Live deletion (phase B) ────────────────────────────────────────────────

export interface DeletedTotals {
  directories: number;
  files: number;
  bytes: number;
  imageEmbeddingRows: number;
  pagesMarkedDirty: number;
}

export function emptyDeletedTotals(): DeletedTotals {
  return { directories: 0, files: 0, bytes: 0, imageEmbeddingRows: 0, pagesMarkedDirty: 0 };
}

/** Page ids owning a Confluence-tree directory key (0, 1 or 2 rows). */
async function confluenceKeyOwners(key: string): Promise<number[]> {
  const owners = new Set<number>();
  const byConfluenceId = await query<{ id: number }>(
    `SELECT id FROM pages WHERE confluence_id = $1`,
    [key],
  );
  for (const row of byConfluenceId.rows) owners.add(row.id);
  const asId = asPageId(key);
  if (asId !== null) {
    const byId = await query<{ id: number }>(`SELECT id FROM pages WHERE id = $1`, [asId]);
    for (const row of byId.rows) owners.add(row.id);
  }
  return [...owners];
}

/**
 * Delete the candidates the walk just listed, re-verifying each at delete
 * time: a directory's page may have appeared since phase A (first sync
 * creates `<confluence_id>/` before the `pages` INSERT), and any file may
 * have been rewritten inside the grace window. ENOENT anywhere is a skip,
 * never an error — nothing is deleted on the strength of a stale listing.
 *
 * For every FILE removed, the matching `page_image_embeddings` rows
 * `(page_id, source, attachment_key)` are pruned (a safety net — a `missing`
 * row kept by the reconcile belongs to a file the body still references,
 * which by definition sits in the keep-set and never becomes a candidate)
 * and the owning pages are re-queued via `image_embedding_dirty`.
 *
 * `totals` is the CALLER's object and is mutated per deletion, so a throw
 * mid-loop (a lost worker lock, an EACCES) leaves the partial counts in the
 * caller's hands — a failed run must still record and audit the destructive
 * work it already did (review r1). The dirty-marking flush runs in a
 * `finally` for the same reason: the owners of already-deleted files must be
 * re-queued whether or not a later candidate failed. Exported for the
 * delete-time re-verification tests; production callers reach it only
 * through `runAttachmentSweep`.
 */
export async function deleteCandidates(
  candidates: AttachmentSweepCandidate[],
  assertNotAborted: () => void,
  totals: DeletedTotals,
): Promise<DeletedTotals> {
  const cutoffMs = Date.now() - ATTACHMENT_SWEEP_GRACE_MS;
  const dirtyPages = new Set<number>();
  const ownersByKey = new Map<string, number[]>();

  // Re-verify directory orphans' page absence in one pass.
  const dirKeys = {
    confluence: candidates.filter((c) => c.reason === 'orphan_directory' && c.store === 'confluence').map((c) => c.key),
    local: candidates.filter((c) => c.reason === 'orphan_directory' && c.store === 'local').map((c) => c.key),
  };
  const stillKnownConfluence = await knownConfluenceTreeKeys(dirKeys.confluence);
  const stillKnownLocal = await knownLocalPageIds(dirKeys.local.map(Number));

  try {
    for (const candidate of candidates) {
      assertNotAborted();
      const dirPath =
        candidate.store === 'local'
          ? path.join(localAttachmentsRoot(), candidate.key)
          : path.join(attachmentsRootNow(), candidate.key);

      if (candidate.reason === 'orphan_directory') {
        const reappeared =
          candidate.store === 'local'
            ? stillKnownLocal.has(Number(candidate.key))
            : stillKnownConfluence.has(candidate.key);
        if (reappeared) continue;
        // Re-check the grace window over the directory's CURRENT contents.
        const recheck = await readKeyDir(dirPath, candidate.key, emptyStats());
        if (recheck === null) continue; // vanished or unreadable — do not judge
        const aged = recheck.dirMtimeMs < cutoffMs && recheck.files.every((f) => f.mtimeMs < cutoffMs);
        if (!aged) continue;
        if (candidate.store === 'local') {
          await removeLocalAttachmentDirectory(Number(candidate.key));
        } else {
          await removeCachedAttachmentDirectory(candidate.key);
        }
        totals.directories += 1;
        totals.files += recheck.files.length;
        totals.bytes += recheck.bytes;
        continue;
      }

      // orphan_file
      const filename = candidate.filename!;
      let st;
      try {
        st = await fs.stat(path.join(dirPath, filename));
      } catch {
        continue; // vanished — nothing to do
      }
      if (!st.isFile() || st.mtimeMs >= cutoffMs) continue;
      if (candidate.store === 'local') {
        // `false` = the name was refused, nothing was removed — skip WITHOUT
        // counting, or the record claims a deletion that did not happen.
        const removed = await removeLocalAttachmentFileForSweep(Number(candidate.key), filename);
        if (!removed) continue;
      } else {
        await removeCachedAttachmentFile(candidate.key, filename);
      }
      totals.files += 1;
      totals.bytes += st.size;

      // Index-row prune + dirty marking for the owning pages.
      const ownersCacheKey = `${candidate.store}:${candidate.key}`;
      const cachedOwners = ownersByKey.get(ownersCacheKey);
      const owners: number[] =
        cachedOwners ??
        (candidate.store === 'local'
          ? [...(await knownLocalPageIds([Number(candidate.key)]))]
          : await confluenceKeyOwners(candidate.key));
      if (cachedOwners === undefined) {
        ownersByKey.set(ownersCacheKey, owners);
      }
      if (owners.length > 0) {
        const pruned = await query(
          `DELETE FROM page_image_embeddings
            WHERE page_id = ANY($1::int[]) AND source = $2 AND attachment_key = $3`,
          [owners, candidate.store, filename],
        );
        totals.imageEmbeddingRows += pruned.rowCount ?? 0;
        for (const owner of owners) dirtyPages.add(owner);
      }
      await yieldToLoop();
    }
  } finally {
    // Owners of files that WERE deleted are re-queued even when a later
    // candidate threw — and the flush itself must not mask that error, so
    // each page's failure is logged and the loop continues.
    for (const pageId of dirtyPages) {
      try {
        await markPageImagesDirty(pageId);
        totals.pagesMarkedDirty += 1;
      } catch (err) {
        logger.warn({ err, pageId }, 'attachment-sweep: failed to mark a page image-dirty');
      }
    }
  }
  return totals;
}

// ── Persistence ────────────────────────────────────────────────────────────

const StatsRecordSchema = z.object({
  at: z.string(),
  stores: z.object({
    confluence: AttachmentStoreSweepStatsSchema,
    local: AttachmentStoreSweepStatsSchema,
  }),
  missingLocalFiles: z.number().int().nonnegative(),
});
export type AttachmentStorageStatsRecord = z.infer<typeof StatsRecordSchema>;

async function persistSetting(key: string, value: unknown): Promise<void> {
  try {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  } catch (err) {
    // Bookkeeping, not the work — a sweep that ran and failed to write its
    // own summary has still swept (the image-index precedent).
    logger.warn({ err, key }, 'attachment-sweep: failed to persist a record');
  }
}

async function readSetting<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
  const res = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [key],
  );
  const raw = res.rows[0]?.setting_value;
  if (!raw) return null;
  try {
    return schema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn({ err, key }, 'attachment-sweep: ignoring an unreadable record');
    return null;
  }
}

/** The persisted last run, or null when none has been recorded. */
export async function readAttachmentSweepLastRun(): Promise<AttachmentSweepRun | null> {
  return readSetting(ATTACHMENT_SWEEP_LAST_RUN_KEY, AttachmentSweepRunSchema);
}

/** The persisted per-store stats of the last completed walk, or null. */
export async function readAttachmentStorageStatsRecord(): Promise<AttachmentStorageStatsRecord | null> {
  return readSetting(ATTACHMENT_STORAGE_STATS_KEY, StatsRecordSchema);
}

// ── The run ────────────────────────────────────────────────────────────────

interface RunShapeInput {
  dryRun: boolean;
  startedAt: number;
  status: AttachmentSweepRun['status'];
  note: string | null;
  stores: AttachmentSweepRun['stores'];
  missingLocalFiles: number;
  candidates: AttachmentSweepCandidate[];
  deleted: AttachmentSweepRun['deleted'];
}

function shapeRun(input: RunShapeInput): AttachmentSweepRun {
  return {
    at: new Date().toISOString(),
    dryRun: input.dryRun,
    status: input.status,
    note: input.note,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    stores: input.stores,
    missingLocalFiles: input.missingLocalFiles,
    candidateSample: input.candidates.slice(0, CANDIDATE_SAMPLE_MAX),
    candidatesTotal: input.candidates.length,
    deleted: input.deleted,
  };
}

/**
 * Acquire the sweep's worker lock on behalf of a caller that will pass the
 * token into `runAttachmentSweep` (the POST trigger). Exists so the route can
 * derive `started` from the ACTUAL acquisition — an advisory `isWorkerLocked`
 * read followed by a detached self-acquiring run let two concurrent triggers
 * both be answered `started: true` while the loser's `null` return vanished
 * into the fire-and-forget (review, external round). One SET NX; the TTL is
 * this module's, so the route cannot pick a different bound than the runner
 * refreshes against. Mirrors `acquireWorkerLock`'s single-node fallback: a
 * token (never `null`) when Redis is absent or errored.
 */
export async function acquireAttachmentSweepLock(): Promise<string | null> {
  return acquireWorkerLock(ATTACHMENT_SWEEP_WORKER_LOCK, LOCK_TTL_SECONDS);
}

/**
 * Run one sweep. Without `opts.token` it acquires the worker lock itself and
 * answers `null` when another holder has it (`alreadyRunning`); with a
 * caller-acquired token (from `acquireAttachmentSweepLock`) it takes OWNERSHIP
 * of that token — no second acquire, and the epilogue's `finally` releases it,
 * so the caller must not. Otherwise always answers the run it recorded —
 * `completed`, `refused` or `failed` — and persists it for the admin GETs.
 * Fire-and-forget callers must catch their own rejection; this function only
 * throws on a programming error before the lock is taken.
 *
 * `triggeredBy` is the admin whose trigger started this run (the POST route's
 * `request.userId`) and becomes the RETENTION_PRUNED event's actor — the sweep
 * is manual-only, so a destructive run always has a person behind it, and an
 * audit trail that never says WHO pressed Delete orphans is half a trail
 * (verification r1). Absent means a non-request caller: a null-actor system
 * event, the retention service's own convention.
 */
export async function runAttachmentSweep(opts: {
  dryRun: boolean;
  token?: string;
  triggeredBy?: string | null;
}): Promise<AttachmentSweepRun | null> {
  const token = opts.token ?? (await acquireWorkerLock(ATTACHMENT_SWEEP_WORKER_LOCK, LOCK_TTL_SECONDS));
  if (!token) return null;

  let lockLost = false;
  const guard = setInterval(() => {
    void refreshWorkerLock(ATTACHMENT_SWEEP_WORKER_LOCK, token, LOCK_TTL_SECONDS)
      .then((holder) => {
        if (holder !== token) lockLost = true;
      })
      .catch(() => undefined); // transient Redis error: keep going, next tick retries
  }, LOCK_REFRESH_MS);

  const startedAt = Date.now();
  const assertNotAborted = () => {
    if (lockLost) throw new SweepAborted();
  };

  // Filled in by `executeSweep` the moment the delete phase starts, so a
  // throw mid-delete still records and audits the partial destructive work
  // (review r1): `null` here means the delete phase never ran at all.
  const partial: { deleted: DeletedTotals | null } = { deleted: null };

  let run: AttachmentSweepRun;
  try {
    try {
      run = await executeSweep(opts.dryRun, startedAt, assertNotAborted, partial);
    } catch (err) {
      logger.error({ err, dryRun: opts.dryRun }, 'attachment-sweep: run failed');
      run = shapeRun({
        dryRun: opts.dryRun,
        startedAt,
        status: 'failed',
        note: err instanceof SweepAborted ? err.message : 'sweep failed — see the server logs',
        stores: null,
        missingLocalFiles: 0,
        candidates: [],
        deleted: partial.deleted,
      });
    }

    // Persist BEFORE the lock is released (review, external round): `running`
    // on both admin GETs is read off the lock, so an observer that sees it
    // free must also see this run's record — released first, the card could
    // pair `running: false` with the previous run's summary, and a second run
    // started inside that window could have its fresh record overwritten by
    // this run's stale one landing late. `persistSetting` swallows its own
    // errors (bookkeeping, not the work), so holding the lock through it
    // cannot wedge it; the release below still sits in a `finally`.
    await persistSetting(ATTACHMENT_SWEEP_LAST_RUN_KEY, run);
    if (run.stores) {
      await persistSetting(ATTACHMENT_STORAGE_STATS_KEY, {
        at: run.at,
        stores: run.stores,
        missingLocalFiles: run.missingLocalFiles,
      } satisfies AttachmentStorageStatsRecord);
    }
  } finally {
    clearInterval(guard);
    await releaseWorkerLock(ATTACHMENT_SWEEP_WORKER_LOCK, token);
  }

  // RETENTION_PRUNED-style heartbeat: one event per run, dry included, with
  // counts by reason class — the auditor can tell "ran, nothing matched"
  // from "never ran". The actor is the triggering admin when there is one.
  await logAuditEvent(opts.triggeredBy ?? null, 'RETENTION_PRUNED', 'table', 'attachments_orphan_sweep', {
    dry_run: run.dryRun,
    status: run.status,
    note: run.note,
    candidates_total: run.candidatesTotal,
    orphan_directories:
      (run.stores?.confluence.orphanDirectories ?? 0) + (run.stores?.local.orphanDirectories ?? 0),
    orphan_files: (run.stores?.confluence.orphanFiles ?? 0) + (run.stores?.local.orphanFiles ?? 0),
    files_pruned: run.deleted?.files ?? 0,
    directories_pruned: run.deleted?.directories ?? 0,
    bytes_pruned: run.deleted?.bytes ?? 0,
    image_embedding_rows_pruned: run.deleted?.imageEmbeddingRows ?? 0,
    missing_local_files: run.missingLocalFiles,
  });

  logger.info(
    {
      dryRun: run.dryRun,
      status: run.status,
      durationMs: run.durationMs,
      candidatesTotal: run.candidatesTotal,
      orphanDirectories:
        (run.stores?.confluence.orphanDirectories ?? 0) + (run.stores?.local.orphanDirectories ?? 0),
      orphanFiles: (run.stores?.confluence.orphanFiles ?? 0) + (run.stores?.local.orphanFiles ?? 0),
      deleted: run.deleted,
      missingLocalFiles: run.missingLocalFiles,
    },
    'attachment-sweep: run recorded',
  );
  return run;
}

async function executeSweep(
  dryRun: boolean,
  startedAt: number,
  assertNotAborted: () => void,
  partial: { deleted: DeletedTotals | null },
): Promise<AttachmentSweepRun> {
  const refused = (note: string): AttachmentSweepRun =>
    shapeRun({
      dryRun,
      startedAt,
      status: 'refused',
      note,
      stores: null,
      missingLocalFiles: 0,
      candidates: [],
      deleted: null,
    });

  // (e) Root sanity — never judge anything through an unreadable root.
  const root = attachmentsRootNow();
  let rootEntries;
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return refused('attachments root is not a directory');
    rootEntries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return refused('attachments root missing or unreadable');
  }

  const keep = await buildAttachmentKeepSets();
  const confluence = await walkConfluenceTree(root, rootEntries, keep.confluence, assertNotAborted);
  const local = await walkLocalStore(keep.local, assertNotAborted);

  const stores = { confluence: confluence.stats, local: local.stats };
  const candidates = [...confluence.candidates, ...local.candidates];

  // (e) Live-run anomaly: a store that is empty on disk while the database
  // still references it is a mis-pointed or unmounted ATTACHMENTS_DIR, not a
  // clean tree. The dry run reports the same figures; only deletion refuses.
  const anomaly =
    !dryRun && confluence.stats.files === 0 && keep.confluence.size > 0
      ? 'confluence store has zero files while the database references attachments — refusing to delete'
      : !dryRun && local.stats.files === 0 && (local.totalRows > 0 || keep.local.size > 0)
        ? 'local store has zero files while the database references attachments — refusing to delete'
        : null;
  if (anomaly) {
    const run = refused(anomaly);
    return { ...run, stores, missingLocalFiles: local.missingLocalFiles };
  }

  if (dryRun) {
    return shapeRun({
      dryRun,
      startedAt,
      status: 'completed',
      note: null,
      stores,
      missingLocalFiles: local.missingLocalFiles,
      candidates,
      deleted: null,
    });
  }

  partial.deleted = emptyDeletedTotals();
  const deleted = await deleteCandidates(candidates, assertNotAborted, partial.deleted);
  return shapeRun({
    dryRun,
    startedAt,
    status: 'completed',
    note: null,
    stores,
    missingLocalFiles: local.missingLocalFiles,
    candidates,
    deleted,
  });
}
