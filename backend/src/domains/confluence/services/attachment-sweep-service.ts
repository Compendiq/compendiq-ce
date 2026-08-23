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
 * `readdir(attachmentsRootNow())` minus the RESERVED entries
 * (`ATTACHMENT_ROOT_RESERVED_DIRNAMES`: `local/` and `page-icons/`) — each
 * lives INSIDE the same root and each name matches the tree's key pattern, so
 * a naive walk lists a whole other store as one "orphan directory" and a live
 * run deletes it recursively. The local store is walked under
 * `localAttachmentsRoot()` only; the page-icon store is not walked at all —
 * its files are never referenced from a body, so this service has no rule that
 * could keep them.
 *
 * (a) **Directory-level orphans**: a directory whose key matches NO page row
 *     at all — `pages.confluence_id` OR `pages.id` for the Confluence-style
 *     tree (both kinds share one keyspace: DC ids sit inside `pages.id`'s
 *     range), `pages.id` for the local store — where "page row" includes
 *     soft-deleted/trashed pages (restorable) and folders. The keep-set
 *     outranks this verdict (fixer r1): a pageless directory holding even
 *     ONE filename some body still references (a template handed the URL to
 *     pages it created, say) is skipped whole and counted
 *     (`keepProtectedDirectories`) — the no-referenced-file-is-ever-deleted
 *     invariant of (b) does not stop at the directory boundary.
 * (b) **Per-file orphans**, judged against a GLOBAL keep-set per store, never
 *     the owning page's body alone: attachment URLs are copied verbatim
 *     between bodies (templates hand their `body_html` to every page created
 *     from them), and one directory key can belong to two page rows, so a
 *     filename referenced ANYWHERE is kept EVERYWHERE. The keep-set is fed
 *     from every `pages.body_html` / `draft_body_html` / `body_storage`
 *     (live AND trashed), every `page_versions.body_html`, every
 *     `pending_sync_versions.body_html`/`body_storage`, every
 *     `templates.body_html`, every `comments.body_html` and every
 *     `llm_conversations.messages` (#1361 persists an image source's
 *     `attachmentUrl` per assistant turn) — collecting BOTH
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
  ATTACHMENT_ROOT_RESERVED_DIRNAMES,
  attachmentsRootNow,
  removeCachedAttachmentDirectory,
  removeCachedAttachmentFile,
} from '../../../core/services/attachment-store.js';
import {
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
 * More inclusive than an attribute walk for every spelling that can carry a
 * working reference — over-keeping is safe, under-keeping deletes a
 * referenced file. The one class the bare regex missed (fixer r1): a literal
 * SPACE inside a QUOTED attribute value is legal HTML and the reference
 * works (the browser percent-encodes it on request, the route decodes it
 * back), but `\s` is outside the filename class, so only the pre-space
 * prefix reached the keep-set. When a match sits inside a quoted attribute
 * value — decided by scanning BACK to the opening quote, so an absolute
 * `src="https://host/api/attachments/…"` counts too — the collector therefore
 * ALSO extends the candidate to the closing
 * quote below — a plain-text spelling with a space stays unextended, because
 * outside a quoted attribute there is no delimiter and a bare URL with a
 * literal space does not function as a reference.
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
 *
 * The filename half admits `#` ONLY as part of an `&#` pair (review r1): a
 * bare `#` still terminates the match (that is the fragment rule the tests
 * pin), but a numeric character reference (`&#38;` / `&#x26;`) is an entity
 * spelling of the name, not a fragment, and excluding `#` outright cut the
 * match at `a&` before the decoder below could ever see it.
 */
const ATTACHMENT_URL_RE =
  // `&#` sits FIRST in the alternation: the char class also matches `&`, and
  // with it first the match just stops at `#` (success needs no backtracking)
  // instead of consuming the pair.
  /\/api\/(local-attachments|attachments)\/[A-Za-z0-9_-]+\/((?:&#|[^"<>\s?#\\])+)/g;

/**
 * One decode step over the HTML character references a body text can carry
 * (review r1). `body_html` is HTML, so a DECODED attachment URL pasted as
 * plain text is serialised with `&` as `&amp;` — the stored spelling names
 * `a&amp;b.png` while the disk holds `a&b.png`, and product-written URLs
 * never hit this (encodeURIComponent turns `&` into `%26`), so the entity
 * spelling can be the ONLY reference anywhere. Named entities for the five
 * HTML-escaped characters plus decimal/hex numeric references; anything
 * unrecognised is left alone (over-keeping is the safe direction, and a
 * malformed reference is then simply a literal part of the raw name).
 */
function decodeHtmlEntitiesOnce(name: string): string {
  return name.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g, (entity) => {
    switch (entity) {
      case '&amp;':
        return '&';
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      case '&apos;':
        return "'";
      default: {
        const code =
          entity[2] === 'x' || entity[2] === 'X'
            ? Number.parseInt(entity.slice(3, -1), 16)
            : Number.parseInt(entity.slice(2, -1), 10);
        try {
          return String.fromCodePoint(code);
        } catch {
          return entity; // an invalid code point stays literal
        }
      }
    }
  });
}

/**
 * Longest quoted-attribute continuation the collector will extend a match by.
 * Real filenames are bounded well under this (`validateFilename` refuses
 * anything near it at write time); the cap only stops a body whose closing
 * quote sits megabytes away (malformed HTML) from seeding giant Set entries.
 */
const QUOTED_CONTINUATION_MAX = 512;

/** How far back the enclosing-quote scan below will look. Bounds the cost. */
const QUOTED_LOOKBACK_MAX = 2048;

/**
 * The quote that OPENS the attribute value a match sits inside, or `''`.
 *
 * The first cut read `text[match.index - 1]` and so only ever recognised a
 * ROOT-RELATIVE spelling (`src="/api/attachments/…"`), where the quote really
 * is the previous character. An ABSOLUTE spelling is equally common and just
 * as functional — `src="https://kb.example.com/api/attachments/123/my
 * file.png"` — and there the previous character is `m` from `.com`, so the
 * continuation never fired, the name truncated at the space, and a live run
 * deleted a referenced file. That is the same defect class r1–r3 patched one
 * instance at a time; this is the class-level form.
 *
 * Scanning BACKWARDS is what makes it general: whatever sits between the
 * opening quote and `/api/` (scheme, host, port, a proxy path prefix) is
 * skipped, and the scan stops at the first character that cannot appear inside
 * a quoted attribute value's leading run — a tag boundary, or any whitespace,
 * which also terminates an UNQUOTED attribute value and separates a plain-text
 * spelling from whatever precedes it. Finding a quote first therefore means
 * the match is inside that quoted value, whose spelling legally runs to the
 * matching closing quote.
 */
function enclosingAttributeQuote(text: string, matchIndex: number): '"' | "'" | '' {
  const floor = Math.max(0, matchIndex - QUOTED_LOOKBACK_MAX);
  for (let i = matchIndex - 1; i >= floor; i -= 1) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") return ch;
    if (ch === '<' || ch === '>' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      return '';
    }
  }
  return '';
}

export function collectAttachmentUrlReferences(
  text: string | null | undefined,
  into: AttachmentKeepSets,
): void {
  if (!text) return;
  for (const match of text.matchAll(ATTACHMENT_URL_RE)) {
    const store = match[1] === 'attachments' ? 'confluence' : 'local';
    const raw = match[2]!;
    const names = new Set<string>();
    const addSeed = (name: string): void => {
      if (!name) return;
      names.add(name);
      try {
        names.add(decodeURIComponent(name));
      } catch {
        // A lone `%` throws; the raw name is then what is on disk.
      }
    };
    addSeed(raw);
    // Quoted-attribute continuation (fixer r1, generalised in the external
    // round): a match INSIDE a quoted attribute value — root-relative or
    // absolute, see `enclosingAttributeQuote` — has a spelling that legally
    // runs to the closing quote, through characters the filename class
    // excludes (literal spaces above all). The extension is one more SEED, so every
    // decode/trim variant below applies to it too. The regex's own
    // query/fragment termination is REPLAYED on it (`?`, and `#` only when
    // it is not part of an `&#` entity): a spelling past either never
    // reaches the disk file — the browser cuts the URL there before
    // requesting — so keeping it would not protect anything, and the pinned
    // fragment rule stays exact.
    const quote = enclosingAttributeQuote(text, match.index);
    if (quote !== '') {
      const matchEnd = match.index + match[0].length;
      const close = text.indexOf(quote, matchEnd);
      if (close > matchEnd && close - matchEnd <= QUOTED_CONTINUATION_MAX) {
        const prefixLength = match[0].length - raw.length;
        const extended = text.slice(match.index + prefixLength, close);
        const cut = extended.search(/\?|(?<!&)#/);
        addSeed(cut === -1 ? extended : extended.slice(0, cut));
      }
    }
    // Entity-decoded variants (review r1), BEFORE the trims below so they see
    // the decoded spellings too. Stepwise to a bounded fixpoint, keeping every
    // intermediate (a double-escaped `&amp;amp;` names both regimes), each one
    // percent-decoded as well — the two decodings compose in that order in
    // the serializer (percent-encode first, then HTML-escape the attribute).
    for (const name of [...names]) {
      let current = name;
      for (let step = 0; step < 3; step += 1) {
        const decoded = decodeHtmlEntitiesOnce(current);
        if (decoded === current) break;
        names.add(decoded);
        try {
          names.add(decodeURIComponent(decoded));
        } catch {
          // Not percent-decodable — the entity-decoded spelling itself stays.
        }
        current = decoded;
      }
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

/**
 * Keyset start for a UUID primary key (`page_versions`, `pending_sync_versions`).
 *
 * The cursor is carried in JS as `id::text`, but the COMPARISON is native
 * (`id > $1::uuid`) so the primary-key index can serve it (review, external
 * round). `WHERE id::text > $1 ORDER BY id::text` was correct — canonical
 * lowercase UUID text sorts the same as the uuid type — and unusable by any
 * index, so every 200-row batch was a full-table scan plus a top-N sort:
 * O(N²/200) per sweep over the two largest body tables in the system.
 * `gen_random_uuid()` never yields the nil UUID, so excluding it is free.
 */
const UUID_CURSOR_START = '00000000-0000-0000-0000-000000000000';

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
              FROM page_versions WHERE id > $1::uuid ORDER BY id LIMIT ${KEEP_SET_BATCH}`,
      params: [cursor ?? UUID_CURSOR_START],
    }),
    UUID_CURSOR_START,
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
             WHERE psv.id > $1::uuid ORDER BY psv.id LIMIT ${KEEP_SET_BATCH}`,
      params: [cursor ?? UUID_CURSOR_START],
    }),
    UUID_CURSOR_START,
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

  // Persisted AI answers (#1361, added in the external review round). Since
  // that PR `toPersistedSources` copies an image source's `attachmentUrl`
  // verbatim into `llm_conversations.messages`, and `GET
  // /llm/conversations/:id` renders the thumbnail back from it — so a file
  // whose only surviving reference is a saved answer was judged an orphan and
  // swept, and reopening the thread showed a broken picture. The jsonb is
  // cast to TEXT and run through the same raw-string collector: the URLs sit
  // inside it verbatim (JSON escapes no forward slash), so no shape knowledge
  // and no per-row parse is needed, and a future field carrying an attachment
  // URL is covered without a change here.
  type ConversationRow = { __cursor: string; messages_text: string | null };
  await forEachBatch<ConversationRow>(
    (cursor) => ({
      sql: `SELECT id::text AS __cursor, messages::text AS messages_text
              FROM llm_conversations WHERE id > $1::uuid ORDER BY id LIMIT ${KEEP_SET_BATCH}`,
      params: [cursor ?? UUID_CURSOR_START],
    }),
    UUID_CURSOR_START,
    (rows) => {
      for (const row of rows) collectAttachmentUrlReferences(row.messages_text, keep);
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
    keepProtectedDirectories: 0,
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
  keep: Set<string>,
  stats: AttachmentStoreSweepStats,
  candidates: AttachmentSweepCandidate[],
): void {
  // The keep-set outranks the directory verdict (fixer r1): a pageless
  // directory can still hold a file some OTHER body references by URL — a
  // template that handed the URL out, a page created from it — and deleting
  // the directory whole would take that referenced file with it. Checked
  // before the grace window because it is the permanent verdict; skipping is
  // all-or-nothing (conservative), and counted separately so the record says
  // why the directory was left standing.
  if (dir.files.some((f) => keep.has(f.name))) {
    stats.keepProtectedDirectories += 1;
    return;
  }
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
    // Reserved STORES are skipped whole (`local/`, walked separately, and
    // `page-icons/`, which is not walked at all): both sit inside this root
    // and both names pass PAGE_ID_PATTERN, so without this each is a keyless
    // directory the rules below judge an orphan and a live run deletes
    // recursively. A dot-dir is debris; a key that fails the allow-list is
    // never judged and never touched.
    .filter(
      (name) =>
        !ATTACHMENT_ROOT_RESERVED_DIRNAMES.has(name) &&
        !name.startsWith('.') &&
        PAGE_ID_PATTERN.test(name),
    );

  const known = await knownConfluenceTreeKeys(keys);

  for (const key of keys) {
    assertNotAborted();
    const dir = await readKeyDir(path.join(root, key), key, stats);
    if (dir === null) continue;

    if (!known.has(key)) {
      judgeDirectoryOrphan('confluence', dir, cutoffMs, keep, stats, candidates);
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
      judgeDirectoryOrphan('local', dir, cutoffMs, keep, stats, candidates);
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

/**
 * What a live delete phase removed, PER STORE, in the walk's own units
 * (fixer, external round).
 *
 * The walk's figures describe the tree BEFORE the delete loop ran, and the
 * run persisted them verbatim as the stats record — so a completed live run
 * left the card reporting the orphans it had just destroyed as current
 * candidates, dated "Measured just now", beside "deleted N files". An
 * operator reading that presses Delete orphans again believing the sweep did
 * nothing. `DeletedTotals` cannot answer it: it is one global figure and the
 * card renders the two stores separately.
 *
 * These are SUBTRACTIONS, taken from the delete loop's own re-verified reads
 * (the same `recheck`/`stat` the removal itself used), so the adjusted figures
 * describe what is left on disk rather than what the walk once saw.
 */
export interface StoreStatsAdjustment {
  directories: number;
  files: number;
  bytes: number;
  orphanDirectories: number;
  orphanDirectoryBytes: number;
  orphanFiles: number;
  orphanFileBytes: number;
}
export type StoreStatsAdjustments = Record<'confluence' | 'local', StoreStatsAdjustment>;

export function emptyStatsAdjustments(): StoreStatsAdjustments {
  const zero = (): StoreStatsAdjustment => ({
    directories: 0,
    files: 0,
    bytes: 0,
    orphanDirectories: 0,
    orphanDirectoryBytes: 0,
    orphanFiles: 0,
    orphanFileBytes: 0,
  });
  return { confluence: zero(), local: zero() };
}

/**
 * The walk's figures minus what the delete phase removed. Clamped at zero:
 * a file that vanished between the walk and the delete is subtracted by
 * whoever removed it, and under-reporting a store's size is the harmless
 * direction — the figures are a measurement, not an accounting ledger.
 * `graceSkipped`, `keepProtectedDirectories` and `unreadableDirectories`
 * describe the WALK's verdicts and are carried through untouched.
 */
function applyStatsAdjustment(
  stats: AttachmentStoreSweepStats,
  adj: StoreStatsAdjustment,
): AttachmentStoreSweepStats {
  const sub = (a: number, b: number): number => Math.max(0, a - b);
  return {
    ...stats,
    bytes: sub(stats.bytes, adj.bytes),
    files: sub(stats.files, adj.files),
    directories: sub(stats.directories, adj.directories),
    orphanDirectories: sub(stats.orphanDirectories, adj.orphanDirectories),
    orphanDirectoryBytes: sub(stats.orphanDirectoryBytes, adj.orphanDirectoryBytes),
    orphanFiles: sub(stats.orphanFiles, adj.orphanFiles),
    orphanFileBytes: sub(stats.orphanFileBytes, adj.orphanFileBytes),
  };
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
 * creates `<confluence_id>/` before the `pages` INSERT), any file may have
 * been rewritten inside the grace window, and a directory candidate's
 * CURRENT contents are re-checked against the keep-set (fixer r1) — a
 * directory holding a filename some body references is never removed, no
 * matter how stale the listing that named it. ENOENT anywhere is a skip,
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
  keep: AttachmentKeepSets,
  assertNotAborted: () => void,
  totals: DeletedTotals,
  adjustments: StoreStatsAdjustments = emptyStatsAdjustments(),
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
        // Keep-set over the CURRENT contents (fixer r1): the walk already
        // refused a keep-intersecting directory, so this catches only a kept
        // filename that landed here after the listing — and stale hand-built
        // lists in the re-verification tests.
        if (recheck.files.some((f) => keep[candidate.store].has(f.name))) continue;
        if (candidate.store === 'local') {
          await removeLocalAttachmentDirectory(Number(candidate.key));
        } else {
          await removeCachedAttachmentDirectory(candidate.key);
        }
        totals.directories += 1;
        totals.files += recheck.files.length;
        totals.bytes += recheck.bytes;
        const dirAdj = adjustments[candidate.store];
        dirAdj.directories += 1;
        dirAdj.files += recheck.files.length;
        dirAdj.bytes += recheck.bytes;
        dirAdj.orphanDirectories += 1;
        dirAdj.orphanDirectoryBytes += recheck.bytes;
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
      const fileAdj = adjustments[candidate.store];
      fileAdj.files += 1;
      fileAdj.bytes += st.size;
      fileAdj.orphanFiles += 1;
      fileAdj.orphanFileBytes += st.size;

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
    // candidate threw — and the flush itself must not mask that error, so a
    // page that could not be marked is counted out and the loop continues.
    //
    // `markPageImagesDirty` swallows its own query error (a sync must not die
    // on the way to raising a flag), so the `try`/`catch` this used to wrap it
    // in was dead code AND the counter incremented on a failed UPDATE (#1349
    // review). It now reports whether the statement ran; the flag IS the
    // queue, so over-reporting hides the backlog an operator would look for.
    for (const pageId of dirtyPages) {
      if (await markPageImagesDirty(pageId)) {
        totals.pagesMarkedDirty += 1;
      } else {
        logger.warn({ pageId }, 'attachment-sweep: failed to mark a page image-dirty');
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
 * refreshes against.
 *
 * **`failClosed`** (review, external round): `acquireWorkerLock` degrades to
 * local execution on a Redis ERROR, handing every caller a token. That is
 * right for the idempotent workers it was written for and wrong here — this
 * is the degrade's first DESTRUCTIVE consumer, and a blip during two
 * concurrent Delete-orphans presses would run two delete loops over the same
 * tree, with the refresh guard's own `.catch` unable to notice because Redis
 * is still erroring. `null` answers `alreadyRunning`, the card says so, and
 * pressing again is the remedy. Redis being ABSENT (a single-node deployment)
 * still returns a token — that is a configuration, not a failure.
 */
export async function acquireAttachmentSweepLock(): Promise<string | null> {
  return acquireWorkerLock(ATTACHMENT_SWEEP_WORKER_LOCK, LOCK_TTL_SECONDS, { failClosed: true });
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
  // `failClosed` for the same reason `acquireAttachmentSweepLock` uses it.
  const token = opts.token ?? (await acquireAttachmentSweepLock());
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

  // Filled in by `executeSweep` as it goes, so a throw ANYWHERE past the walk
  // still records and audits what the run found and what it destroyed
  // (review r1, widened in the external round): the first cut carried only
  // `deleted`, so a run that failed mid-delete recorded `stores: null` and
  // `candidatesTotal: 0` although the walk had completed — and its
  // RETENTION_PRUNED event then said `orphan_files: 0` beside a non-zero
  // `files_pruned`, an audit row that contradicts itself. `stores === null`
  // now means the walk never finished; `deleted === null`, that the delete
  // phase never started.
  const walk: SweepProgress = {
    stores: null,
    missingLocalFiles: 0,
    candidates: [],
    deleted: null,
    adjustments: null,
  };

  let run: AttachmentSweepRun;
  try {
    try {
      run = await executeSweep(opts.dryRun, startedAt, assertNotAborted, walk);
    } catch (err) {
      logger.error({ err, dryRun: opts.dryRun }, 'attachment-sweep: run failed');
      run = shapeRun({
        dryRun: opts.dryRun,
        startedAt,
        status: 'failed',
        note: err instanceof SweepAborted ? err.message : 'sweep failed — see the server logs',
        stores: residualStores(walk),
        missingLocalFiles: walk.missingLocalFiles,
        candidates: walk.candidates,
        deleted: walk.deleted,
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
    // The stats record is the last COMPLETED run only (review r1): the
    // anomaly refusal carries `stores` too — a zero-file walk over a store
    // the database still references — and persisting those figures would
    // clobber the one reference record an operator diagnosing the suspected
    // mis-mount needs. The refused run keeps its figures in the RUN record.
    // A FAILED run is excluded for a different reason: its delete phase may
    // have stopped anywhere, so `residualStores` is a floor rather than a
    // measurement, and the card's amber strip already sends the operator to
    // Dry run. `run.stores` for a completed LIVE run is post-delete —
    // see `residualStores`.
    if (run.status === 'completed' && run.stores) {
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
  //
  // The orphan counts come from the WALK (`walk.stores`), never from
  // `run.stores`: an audit row states what was FOUND beside what was
  // destroyed, and `run.stores` is deliberately the post-delete residue, so
  // reading it here would report `orphan_files: 0` next to `files_pruned: 5`.
  await logAuditEvent(opts.triggeredBy ?? null, 'RETENTION_PRUNED', 'table', 'attachments_orphan_sweep', {
    dry_run: run.dryRun,
    status: run.status,
    note: run.note,
    candidates_total: run.candidatesTotal,
    orphan_directories:
      (walk.stores?.confluence.orphanDirectories ?? 0) + (walk.stores?.local.orphanDirectories ?? 0),
    orphan_files: (walk.stores?.confluence.orphanFiles ?? 0) + (walk.stores?.local.orphanFiles ?? 0),
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
        (walk.stores?.confluence.orphanDirectories ?? 0) + (walk.stores?.local.orphanDirectories ?? 0),
      orphanFiles: (walk.stores?.confluence.orphanFiles ?? 0) + (walk.stores?.local.orphanFiles ?? 0),
      deleted: run.deleted,
      missingLocalFiles: run.missingLocalFiles,
    },
    'attachment-sweep: run recorded',
  );
  return run;
}

/**
 * What the run has established so far — owned by `runAttachmentSweep` and
 * filled in by `executeSweep`, so a throw anywhere past the walk still has
 * something honest to record. See the comment at its declaration.
 */
interface SweepProgress {
  /** The WALK's figures, pre-delete. `null` until the walk completes. */
  stores: AttachmentSweepRun['stores'];
  missingLocalFiles: number;
  candidates: AttachmentSweepCandidate[];
  /** `null` until the delete phase starts. */
  deleted: DeletedTotals | null;
  /** `null` until the delete phase starts; mutated per removal. */
  adjustments: StoreStatsAdjustments | null;
}

/**
 * The walk's figures minus what this run has already destroyed — i.e. what is
 * on disk NOW. This is what a run RECORD publishes as `stores`, and (for a
 * completed run) what the persisted stats record and the card then show.
 *
 * Publishing the raw walk was the defect (fixer, external round): a completed
 * live run wrote the pre-delete figures as the fresh stats record, so the card
 * listed the orphans the run had just deleted as current candidates, dated
 * "Measured just now", beside "deleted N files" — and an operator reading that
 * presses Delete orphans again believing nothing happened. The audit event
 * keeps reading the walk, because THAT surface states what was found.
 */
function residualStores(walk: SweepProgress): AttachmentSweepRun['stores'] {
  if (!walk.stores || !walk.adjustments) return walk.stores;
  return {
    confluence: applyStatsAdjustment(walk.stores.confluence, walk.adjustments.confluence),
    local: applyStatsAdjustment(walk.stores.local, walk.adjustments.local),
  };
}

async function executeSweep(
  dryRun: boolean,
  startedAt: number,
  assertNotAborted: () => void,
  walk: SweepProgress,
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
  walk.stores = stores;
  walk.missingLocalFiles = local.missingLocalFiles;
  walk.candidates = candidates;

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

  walk.deleted = emptyDeletedTotals();
  walk.adjustments = emptyStatsAdjustments();
  const deleted = await deleteCandidates(
    candidates,
    keep,
    assertNotAborted,
    walk.deleted,
    walk.adjustments,
  );
  return shapeRun({
    dryRun,
    startedAt,
    status: 'completed',
    note: null,
    // Post-delete: what is on disk now, not what the walk found — the audit
    // event carries the findings.
    stores: residualStores(walk),
    missingLocalFiles: local.missingLocalFiles,
    candidates,
    deleted,
  });
}
