/**
 * Durable BYTEA persistence and version-less HTML snapshots for collaboration.
 *
 * Every mutation enters the page-writer runtime/lifecycle fence before the
 * collaboration-init lock. Read-only rooms may load existing state (or the
 * authored HTML fallback) but never create collaborative bytes.
 *
 * `page_collaborative_docs.doc_epoch` identifies a document lineage (#2034).
 * The database generates it when the seed inserts the row; nothing rewrites a
 * row into another lineage. A room only updates the row it loaded: every
 * persist, merge and mark names the epoch it holds, and a missing or different
 * row answers `collab_lineage_changed` before any byte is applied or written.
 */
import type { PoolClient } from 'pg';
import * as Y from 'yjs';
import { query } from '../db/postgres.js';
import { COLLAB_INIT_LOCK_KEY } from '../db/advisory-locks.js';
import { htmlToText } from './content-converter.js';
import { logger } from '../utils/logger.js';
import {
  applyHtmlToYDoc,
  markAttachmentImages,
  markTaskIds,
  yDocToHtml,
  type AttachmentImageMarker,
  type TaskIdMarker,
} from './collab-schema.js';
import {
  logStoredCarriers,
  reconcileStoredCarriers,
  seededCarrierKinds,
  type StoredCarrierResult,
} from './confluence-carrier-recovery.js';
import {
  isCollabCommitPending,
  PageWriteError,
  withPageWriteTransaction,
  type PageRuntimeAdmission,
} from './page-write-admission.js';

export const COLLAB_PERSIST_DEBOUNCE_MS = 2_000;
export const COLLAB_LOAD_ORIGIN = 'load';
export const COLLAB_MERGE_ORIGIN = 'persisted-merge';
export const COLLAB_LINEAGE_CHANGED = 'collab_lineage_changed';

export type CollabPersistHandle = {
  pageId: number;
  doc: Y.Doc;
  /** Epoch of the row this document was loaded from; null without a persisted document. */
  docEpoch: string | null;
  admission: PageRuntimeAdmission | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persistChain: Promise<void>;
  persistError: unknown | null;
  /**
   * Told, never awaited, that a persist found the row of `docEpoch` gone or
   * replaced. The persist chain rejects after this returns, so the listener
   * must not wait for that chain here.
   */
  onLineageChanged?: (docEpoch: string) => void;
};

export type CollabLoadResult = {
  pagesVersion: number;
  lifecycleRevision: string;
  isFrozen: boolean;
  baselineId: string | null;
  hasPersistedDoc: boolean;
  /** Null exactly when no persisted document exists (`hasPersistedDoc` false). */
  docEpoch: string | null;
};

type LoadRow = {
  body_html: string | null;
  version: number;
  lifecycle_revision: string;
  baseline_id: string | null;
  deleted_at: Date | null;
  page_type: string | null;
  doc_state: Buffer | null;
  doc_epoch: string | null;
};

const LOAD_PAGE_AND_DOC = `SELECT p.body_html, p.version, p.lifecycle_revision::text,
                                  p.baseline_id, p.deleted_at, p.page_type,
                                  d.doc_state, d.doc_epoch::text
                             FROM pages p
                        LEFT JOIN page_collaborative_docs d ON d.page_id = p.id
                            WHERE p.id = $1`;

/** The persisted document a room holds was deleted or replaced by another lineage. */
export function collabLineageChanged(): PageWriteError {
  return new PageWriteError(
    409, COLLAB_LINEAGE_CHANGED,
    'The collaborative document was replaced after this session loaded it',
  );
}

export function isCollabLineageChanged(error: unknown): boolean {
  return error instanceof PageWriteError && error.reason === COLLAB_LINEAGE_CHANGED;
}

/**
 * `seed` (#1953, Z5) is passed only by the writable load of a missing document: its HTML replaces `body_html` in
 * the one initialization, and its carrier kinds become the room key in that same update.
 */
function applyLoadRow(
  doc: Y.Doc,
  row: LoadRow,
  seed?: { seedHtml: string; carrierKinds: readonly string[] | null },
): CollabLoadResult | 'missing' {
  if (row.deleted_at || (row.page_type ?? 'page') === 'folder') return 'missing';
  if (row.doc_state) {
    Y.applyUpdate(doc, new Uint8Array(row.doc_state), COLLAB_LOAD_ORIGIN);
  } else if (seed) {
    applyHtmlToYDoc(doc, seed.seedHtml, seed.carrierKinds ? { carrierKinds: seed.carrierKinds } : {});
  } else {
    applyHtmlToYDoc(doc, row.body_html ?? '<p></p>');
  }
  return {
    pagesVersion: row.version,
    lifecycleRevision: String(row.lifecycle_revision),
    isFrozen: row.baseline_id !== null,
    baselineId: row.baseline_id,
    hasPersistedDoc: row.doc_state !== null,
    docEpoch: row.doc_state !== null ? row.doc_epoch : null,
  };
}

async function lockCollabInit(client: PoolClient, pageId: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);
}

/**
 * Load a room from authoritative PostgreSQL. Supplying a writable admission
 * also initializes missing BYTEA under runtime -> lifecycle -> collab-init
 * ordering; that seed is the only statement that inserts a collaborative row,
 * and the database gives it a new epoch. A read-only load deliberately leaves
 * BYTEA absent.
 */
export async function loadOrInitCollabDoc(
  pageId: number,
  doc: Y.Doc,
  admission?: PageRuntimeAdmission,
): Promise<CollabLoadResult | 'missing'> {
  try {
    if (!admission) {
      const result = await query<LoadRow>(LOAD_PAGE_AND_DOC, [pageId]);
      const row = result.rows[0];
      return row ? applyLoadRow(doc, row) : 'missing';
    }

    // A missing seed writes BYTEA only, never a protected page row, so the
    // page's own pending collaborative Save does not fence the load (#1763).
    let seedCarriers: StoredCarrierResult | null = null;
    const loaded = await withPageWriteTransaction([pageId], async (client) => {
      await lockCollabInit(client, pageId);
      const result = await client.query<LoadRow>(LOAD_PAGE_AND_DOC, [pageId]);
      const row = result.rows[0];
      if (!row) return 'missing';
      seedCarriers = row.doc_state || row.deleted_at ? null : await chooseSeedCarriers(client, pageId, row.body_html);
      const seed = seedCarriers
        ? { seedHtml: seedCarriers.html, carrierKinds: seededCarrierKinds(seedCarriers) }
        : undefined;
      const applied = applyLoadRow(doc, row, seed);
      if (applied === 'missing' || applied.hasPersistedDoc) return applied;
      const docEpoch = await seedDocState(client, pageId, doc);
      if (docEpoch === null) return 'missing';
      return { ...applied, hasPersistedDoc: true, docEpoch };
    }, { admission, ownCollabCommit: 'proceed' });
    // #1953 (Y8, Z5, Z6): the seed's line is written only once its insert committed.
    if (loaded !== 'missing' && seedCarriers) {
      logStoredCarriers({ pageId, writer: 'collab_seed', result: seedCarriers, final: 'reserved' });
    }
    return loaded;
  } catch (err) {
    logger.warn({ err, pageId }, 'collab: load/init failed');
    throw err;
  }
}

/** Insert the seed row of a new lineage; null when the page row no longer exists. */
async function seedDocState(client: PoolClient, pageId: number, doc: Y.Doc): Promise<string | null> {
  const docState = Buffer.from(Y.encodeStateAsUpdate(doc));
  const stateVector = Buffer.from(Y.encodeStateVector(doc));
  try {
    const seeded = await client.query<{ doc_epoch: string }>(
      `INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector, version, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       RETURNING doc_epoch::text`,
      [pageId, docState, stateVector],
    );
    return seeded.rows[0]!.doc_epoch;
  } catch (err) {
    if ((err as { code?: string }).code === '23503') return null;
    throw err;
  }
}

/**
 * #1953 (§3.8, Y7, Z5): what a new lineage of a missing document is seeded with. Only this branch reads the
 * evidence (the storage and the lockstep columns) and the pending intents, in the seed's own transaction, under
 * the page lifecycle lock that also serializes every reservation. A lockstep row with no pending write intent
 * reconciles the stored body with itself; a seed under the page's own pending collaborative Save (the one intent
 * admission lets pass) runs unrecovered and writes no key. Null: seed the ordinary HTML exactly as before.
 */
async function chooseSeedCarriers(client: PoolClient, pageId: number, bodyHtml: string | null): Promise<StoredCarrierResult | null> {
  if (!bodyHtml) return null;
  const evidence = await client.query<{
    source: string; body_storage: string | null; local_modified_at: Date | null;
    confluence_id: string | null; space_key: string | null; pending: boolean;
  }>(
    `SELECT p.source, p.body_storage, p.local_modified_at, p.confluence_id, p.space_key,
            EXISTS (SELECT 1 FROM page_write_intents i
                     WHERE i.status = 'pending' AND i.page_ids && ARRAY[p.id]::integer[]) AS pending
       FROM pages p
      WHERE p.id = $1 AND p.source = 'confluence' AND p.body_storage IS NOT NULL`,
    [pageId],
  );
  const row = evidence.rows[0];
  if (!row || row.pending) return null;
  const result = reconcileStoredCarriers({ row: { ...row, body_html: bodyHtml, has_collab_doc: false }, targetHtml: bodyHtml });
  return result.applicable ? result : null;
}

/** Replace the bytes of the row of `docEpoch`; refuses when that row is gone or belongs to another lineage. */
async function updateDocState(
  client: PoolClient,
  pageId: number,
  docEpoch: string,
  docState: Buffer,
  stateVector: Buffer,
): Promise<void> {
  const updated = await client.query(
    `UPDATE page_collaborative_docs
        SET doc_state = $3, state_vector = $4, version = version + 1, updated_at = NOW()
      WHERE page_id = $1 AND doc_epoch = $2::uuid`,
    [pageId, docEpoch, docState, stateVector],
  );
  if (updated.rowCount !== 1) throw collabLineageChanged();
}

/** The epoch of the page's persisted document, or null when it has none. */
export async function readCollabDocEpoch(pageId: number, client?: PoolClient): Promise<string | null> {
  const sql = 'SELECT doc_epoch::text FROM page_collaborative_docs WHERE page_id = $1';
  const result = client
    ? await client.query<{ doc_epoch: string }>(sql, [pageId])
    : await query<{ doc_epoch: string }>(sql, [pageId]);
  return result.rows[0]?.doc_epoch ?? null;
}

/**
 * What the rows say about a page's document lineage: `page_absent` when the
 * `pages` row itself is gone (a hard delete cascades the collaborative row
 * with it), otherwise the epoch of its persisted document, or null without
 * one. Only a read under the page lifecycle lock is proof of either.
 */
export type CollabLineageRow = 'page_absent' | { docEpoch: string | null };

export async function readCollabLineageRow(client: PoolClient, pageId: number): Promise<CollabLineageRow> {
  const result = await client.query<{ doc_epoch: string | null }>(
    `SELECT d.doc_epoch::text
       FROM pages p
  LEFT JOIN page_collaborative_docs d ON d.page_id = p.id
      WHERE p.id = $1`,
    [pageId],
  );
  const row = result.rows[0];
  return row ? { docEpoch: row.doc_epoch } : 'page_absent';
}

/**
 * Current-epoch assertion: the caller's transaction holds the page lifecycle
 * lock and is about to consume or emit document bytes for the generation
 * `docEpoch`. Two rooms can agree on a superseded epoch, so equality between
 * them proves nothing; only the row does.
 */
export async function assertCurrentCollabDocEpoch(
  client: PoolClient,
  pageId: number,
  docEpoch: string | null,
): Promise<void> {
  if (docEpoch === null || (await readCollabDocEpoch(pageId, client)) !== docEpoch) {
    throw collabLineageChanged();
  }
}

/** The persisted document and its epoch; the caller holds the lifecycle lock. */
export async function readPersistedCollabDoc(
  client: PoolClient,
  pageId: number,
): Promise<{ docState: Uint8Array; docEpoch: string } | null> {
  const persisted = await client.query<{ doc_state: Buffer; doc_epoch: string }>(
    'SELECT doc_state, doc_epoch::text FROM page_collaborative_docs WHERE page_id = $1', [pageId],
  );
  const row = persisted.rows[0];
  return row ? { docState: new Uint8Array(row.doc_state), docEpoch: row.doc_epoch } : null;
}

/**
 * Merge the persisted bytes of the lineage `docEpoch` into `doc`. The caller
 * holds the admitted lifecycle lock. A missing row or another epoch refuses
 * before any byte is applied; never seed a second document here.
 */
export async function mergePersistedCollabDoc(
  client: PoolClient,
  pageId: number,
  doc: Y.Doc,
  docEpoch: string,
): Promise<void> {
  const persisted = await readPersistedCollabDoc(client, pageId);
  if (!persisted || persisted.docEpoch !== docEpoch) throw collabLineageChanged();
  Y.applyUpdate(doc, persisted.docState, COLLAB_MERGE_ORIGIN);
}

/**
 * Mark the images a settled Confluence commit uploaded in the persisted
 * document (#1764). Every later room load, persist (which merges this row
 * first) and commit snapshot starts from it, so the markers survive when no
 * room owns the page or the owning room missed the in-place marks. The caller
 * holds that commit's request admission. No row: the next writable join seeds
 * from `body_html`, which the commit published with the markers. `docEpoch` is
 * the lineage of the commit's snapshot: a row of another lineage is left as it
 * is (#2034).
 */
export async function markPersistedAttachmentImages(
  pageId: number,
  admission: PageRuntimeAdmission,
  markers: readonly AttachmentImageMarker[],
  docEpoch: string,
): Promise<number> {
  return markPersistedDoc(pageId, admission, docEpoch, (doc) => markAttachmentImages(doc, markers, COLLAB_LOAD_ORIGIN));
}

/**
 * Give the persisted document the task ids a settled Confluence commit wrote
 * (#1751), as markPersistedAttachmentImages does for image markers. No row:
 * the next writable join seeds from `body_html`, which the commit published
 * with those ids.
 */
export async function markPersistedTaskIds(
  pageId: number,
  admission: PageRuntimeAdmission,
  markers: readonly TaskIdMarker[],
  docEpoch: string,
): Promise<number> {
  return markPersistedDoc(pageId, admission, docEpoch, (doc) => markTaskIds(doc, markers, COLLAB_LOAD_ORIGIN));
}

/** Apply `mark` to the persisted document of `docEpoch` in one fenced transaction and store it when it changed. */
async function markPersistedDoc(
  pageId: number,
  admission: PageRuntimeAdmission,
  docEpoch: string,
  mark: (doc: Y.Doc) => number,
): Promise<number> {
  return withPageWriteTransaction([pageId], async (client) => {
    await lockCollabInit(client, pageId);
    const persisted = await readPersistedCollabDoc(client, pageId);
    if (!persisted) return 0;
    if (persisted.docEpoch !== docEpoch) {
      logger.info({ pageId }, 'collab.mark_skipped_other_lineage');
      return 0;
    }
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, persisted.docState, COLLAB_LOAD_ORIGIN);
      const before = Y.encodeStateVector(doc);
      const marked = mark(doc);
      // A mark can change the document without marking a node: the task-id
      // record of a commit whose tasks all carried their ids (#1751).
      if (!Buffer.from(before).equals(Buffer.from(Y.encodeStateVector(doc)))) {
        await updateDocState(
          client, pageId, docEpoch,
          Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)),
        );
      }
      return marked;
    } finally {
      doc.destroy();
    }
  }, { admission });
}

export async function persistCollabDocState(
  pageId: number,
  doc: Y.Doc,
  admission: PageRuntimeAdmission,
  docEpoch: string,
): Promise<number> {
  return withPageWriteTransaction([pageId], async (client) => {
    await lockCollabInit(client, pageId);
    const docState = Buffer.from(Y.encodeStateAsUpdate(doc));
    await updateDocState(client, pageId, docEpoch, docState, Buffer.from(Y.encodeStateVector(doc)));
    return docState.length;
  }, { admission });
}

/**
 * Store the room document and its HTML snapshot for the lineage `docEpoch`.
 * A room never inserts: when the row of that epoch is gone or was replaced the
 * transaction answers `collab_lineage_changed` before `pages.body_html` is
 * touched. `cancelled` lets the owning room withdraw a persist that was still
 * waiting for its locks.
 */
export async function persistAndSnapshot(
  pageId: number,
  doc: Y.Doc,
  admission: PageRuntimeAdmission,
  docEpoch: string,
  options: { cancelled?: () => boolean } = {},
): Promise<void> {
  if (options.cancelled?.()) return;
  const t0 = Date.now();
  // This writes `body_html`, which advances `content_revision` under a pending
  // collaborative commit's stored revisions and would fail its completion after
  // the provider PUT (#1763). It waits for that Save instead.
  const sizes = await withPageWriteTransaction([pageId], async (client) => {
    await lockCollabInit(client, pageId);
    if (options.cancelled?.()) return null;
    // A partitioned peer may have flushed and retired since our last message.
    // Merge its durable updates before capturing every representation together.
    await mergePersistedCollabDoc(client, pageId, doc, docEpoch);
    const docState = Buffer.from(Y.encodeStateAsUpdate(doc));
    const stateVector = Buffer.from(Y.encodeStateVector(doc));
    const html = yDocToHtml(doc);
    const bodyText = htmlToText(html);
    await updateDocState(client, pageId, docEpoch, docState, stateVector);
    await client.query(
      `UPDATE pages SET
         body_html = $2,
         body_text = $3,
         embedding_dirty = TRUE,
         image_analysis_dirty = CASE
           WHEN body_html IS DISTINCT FROM $2 THEN TRUE
           ELSE image_analysis_dirty
         END
       WHERE id = $1 AND deleted_at IS NULL`,
      [pageId, html, bodyText],
    );
    return { doc: docState.length, html: Buffer.byteLength(html) };
  }, { admission, ownCollabCommit: 'defer' });
  if (!sizes) return;
  logger.info({ pageId, duration_ms: Date.now() - t0, bytes: sizes.doc }, 'collab.persist');
  logger.info({ pageId, duration_ms: Date.now() - t0, html_bytes: sizes.html }, 'collab.snapshot');
}

export function scheduleCollabPersist(room: CollabPersistHandle & { persistable?: boolean }): void {
  if (room.persistable === false || !room.admission) return;
  if (room.persistTimer) clearTimeout(room.persistTimer);
  room.persistTimer = setTimeout(() => {
    room.persistTimer = null;
    enqueuePersist(room);
  }, COLLAB_PERSIST_DEBOUNCE_MS);
  if (typeof room.persistTimer.unref === 'function') room.persistTimer.unref();
}

export async function flushCollabPersist(
  room: CollabPersistHandle & { persistable?: boolean },
): Promise<void> {
  if (room.persistTimer) {
    clearTimeout(room.persistTimer);
    room.persistTimer = null;
  }
  if (room.persistable !== false && room.admission) enqueuePersist(room);
  await room.persistChain;
  if (room.persistError) throw room.persistError;
}

function enqueuePersist(room: CollabPersistHandle & { persistable?: boolean }): void {
  const previous = room.persistChain.catch(() => undefined);
  room.persistChain = previous.then(async () => {
    const docEpoch = room.docEpoch;
    if (room.persistable === false || !room.admission || docEpoch === null) return;
    try {
      await persistAndSnapshot(room.pageId, room.doc, room.admission, docEpoch, {
        cancelled: () => room.persistable === false,
      });
      room.persistError = null;
    } catch (err) {
      room.persistError = err;
      if (isCollabCommitPending(err)) logger.info({ pageId: room.pageId }, 'collab.persist_deferred');
      else if (isCollabLineageChanged(err)) {
        logger.info({ pageId: room.pageId }, 'collab.persist_lineage_changed');
        room.onLineageChanged?.(docEpoch);
      } else logger.warn({ err, pageId: room.pageId }, 'collab: persist failed');
      throw err;
    }
  });
  // Timed/background persists have no waiter. Mark the rejection handled while
  // retaining it on persistChain so a disconnect flush can refuse clean release.
  void room.persistChain.catch(() => undefined);
}

export async function deleteCollabDocRow(pageId: number): Promise<void> {
  await withPageWriteTransaction([pageId], async (client) => {
    await lockCollabInit(client, pageId);
    await client.query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
  });
}

export function snapshotRoomHtml(doc: Y.Doc): string {
  return yDocToHtml(doc);
}

export async function htmlFromPersistedDoc(pageId: number): Promise<string | null> {
  const r = await query<{ doc_state: Buffer }>(
    'SELECT doc_state FROM page_collaborative_docs WHERE page_id = $1',
    [pageId],
  );
  if (r.rows.length === 0) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(r.rows[0]!.doc_state), COLLAB_LOAD_ORIGIN);
    return yDocToHtml(doc);
  } finally {
    doc.destroy();
  }
}
