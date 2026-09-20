/**
 * Durable BYTEA persistence and version-less HTML snapshots for collaboration.
 *
 * Every mutation enters the page-writer runtime/lifecycle fence before the
 * collaboration-init lock. Read-only rooms may load existing state (or the
 * authored HTML fallback) but never create collaborative bytes.
 */
import type { PoolClient } from 'pg';
import * as Y from 'yjs';
import { query } from '../db/postgres.js';
import { COLLAB_INIT_LOCK_KEY } from '../db/advisory-locks.js';
import { htmlToText } from './content-converter.js';
import { logger } from '../utils/logger.js';
import { applyHtmlToYDoc, yDocToHtml } from './collab-schema.js';
import {
  withPageWriteTransaction,
  type PageRuntimeAdmission,
} from './page-write-admission.js';

export const COLLAB_PERSIST_DEBOUNCE_MS = 2_000;
export const COLLAB_LOAD_ORIGIN = 'load';
export const COLLAB_MERGE_ORIGIN = 'persisted-merge';

export type CollabPersistHandle = {
  pageId: number;
  doc: Y.Doc;
  admission: PageRuntimeAdmission | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persistChain: Promise<void>;
  persistError: unknown | null;
};

export type CollabLoadResult = {
  pagesVersion: number;
  lifecycleRevision: string;
  isFrozen: boolean;
  baselineId: string | null;
  hasPersistedDoc: boolean;
};

type LoadRow = {
  body_html: string | null;
  version: number;
  lifecycle_revision: string;
  baseline_id: string | null;
  deleted_at: Date | null;
  page_type: string | null;
  doc_state: Buffer | null;
};

const LOAD_PAGE_AND_DOC = `SELECT p.body_html, p.version, p.lifecycle_revision::text,
                                  p.baseline_id, p.deleted_at, p.page_type,
                                  d.doc_state
                             FROM pages p
                        LEFT JOIN page_collaborative_docs d ON d.page_id = p.id
                            WHERE p.id = $1`;

function applyLoadRow(doc: Y.Doc, row: LoadRow): CollabLoadResult | 'missing' {
  if (row.deleted_at || (row.page_type ?? 'page') === 'folder') return 'missing';
  if (row.doc_state) {
    Y.applyUpdate(doc, new Uint8Array(row.doc_state), COLLAB_LOAD_ORIGIN);
  } else {
    applyHtmlToYDoc(doc, row.body_html ?? '<p></p>');
  }
  return {
    pagesVersion: row.version,
    lifecycleRevision: String(row.lifecycle_revision),
    isFrozen: row.baseline_id !== null,
    baselineId: row.baseline_id,
    hasPersistedDoc: row.doc_state !== null,
  };
}

async function lockCollabInit(client: PoolClient, pageId: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);
}

/**
 * Load a room from authoritative PostgreSQL. Supplying a writable admission
 * also initializes missing BYTEA under runtime -> lifecycle -> collab-init
 * ordering. A read-only load deliberately leaves BYTEA absent.
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

    return await withPageWriteTransaction([pageId], async (client) => {
      await lockCollabInit(client, pageId);
      const result = await client.query<LoadRow>(LOAD_PAGE_AND_DOC, [pageId]);
      const row = result.rows[0];
      if (!row) return 'missing';
      const loaded = applyLoadRow(doc, row);
      if (loaded === 'missing' || loaded.hasPersistedDoc) return loaded;
      await upsertDocState(client, pageId, doc);
      return { ...loaded, hasPersistedDoc: true };
    }, { admission });
  } catch (err) {
    logger.warn({ err, pageId }, 'collab: load/init failed');
    throw err;
  }
}


const resettingPageIds = new Set<number>();

export function beginCollabReset(pageId: number): void {
  resettingPageIds.add(pageId);
}

export function endCollabReset(pageId: number): void {
  resettingPageIds.delete(pageId);
}

export function isCollabResetting(pageId: number): boolean {
  return resettingPageIds.has(pageId);
}

const UPSERT_DOC_STATE = `INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector, version, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (page_id) DO UPDATE SET
         doc_state = EXCLUDED.doc_state,
         state_vector = EXCLUDED.state_vector,
         version = page_collaborative_docs.version + 1,
         updated_at = NOW()`;

async function upsertDocState(client: PoolClient, pageId: number, doc: Y.Doc): Promise<number> {
  const docState = Buffer.from(Y.encodeStateAsUpdate(doc));
  const stateVector = Buffer.from(Y.encodeStateVector(doc));
  try {
    await client.query(UPSERT_DOC_STATE, [pageId, docState, stateVector]);
  } catch (err) {
    if ((err as { code?: string }).code === '23503') return 0;
    throw err;
  }
  return docState.length;
}

/** The caller holds the admitted lifecycle lock; never seed a second document here. */
export async function mergePersistedCollabDoc(
  client: PoolClient,
  pageId: number,
  doc: Y.Doc,
): Promise<boolean> {
  const existing = await client.query<{ doc_state: Buffer }>(
    'SELECT doc_state FROM page_collaborative_docs WHERE page_id = $1', [pageId],
  );
  if (!existing.rows[0]) return false;
  Y.applyUpdate(doc, new Uint8Array(existing.rows[0].doc_state), COLLAB_MERGE_ORIGIN);
  return true;
}

export async function persistCollabDocState(
  pageId: number,
  doc: Y.Doc,
  admission: PageRuntimeAdmission,
): Promise<number> {
  return withPageWriteTransaction([pageId], async (client) => {
    await lockCollabInit(client, pageId);
    return upsertDocState(client, pageId, doc);
  }, { admission });
}

/**
 * Existing inbound-body reset. The caller has already published authored HTML;
 * this fenced SQL-only mutation only replaces the derived collaborative bytes.
 */
export async function replaceCollabDocFromHtml(pageId: number, html: string): Promise<void> {
  const doc = new Y.Doc();
  try {
    applyHtmlToYDoc(doc, html);
    await withPageWriteTransaction([pageId], async (client) => {
      await lockCollabInit(client, pageId);
      await upsertDocState(client, pageId, doc);
    });
  } finally {
    doc.destroy();
  }
}

export async function persistAndSnapshot(
  pageId: number,
  doc: Y.Doc,
  admission: PageRuntimeAdmission,
): Promise<void> {
  if (resettingPageIds.has(pageId)) return;
  const t0 = Date.now();
  const sizes = await withPageWriteTransaction([pageId], async (client) => {
    await lockCollabInit(client, pageId);
    if (resettingPageIds.has(pageId)) return null;
    // A partitioned peer may have flushed and retired since our last message.
    // Merge its durable updates before capturing every representation together.
    await mergePersistedCollabDoc(client, pageId, doc);
    const docState = Buffer.from(Y.encodeStateAsUpdate(doc));
    const stateVector = Buffer.from(Y.encodeStateVector(doc));
    const html = yDocToHtml(doc);
    const bodyText = htmlToText(html);
    try {
      await client.query(UPSERT_DOC_STATE, [pageId, docState, stateVector]);
    } catch (err) {
      if (err !== null && typeof err === 'object' && 'code' in err && err.code === '23503') return null;
      throw err;
    }
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
  }, { admission });
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
    if (room.persistable === false || !room.admission) return;
    try {
      await persistAndSnapshot(room.pageId, room.doc, room.admission);
      room.persistError = null;
    } catch (err) {
      room.persistError = err;
      logger.warn({ err, pageId: room.pageId }, 'collab: persist failed');
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
