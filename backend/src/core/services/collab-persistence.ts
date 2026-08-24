/**
 * BYTEA persist + version-less HTML snapshot for collab rooms (#1445).
 *
 * Init is server-side, locked. Snapshots do not bump pages.version, do not
 * stamp local_modified_*, and do not re-queue summary/quality.
 */
import * as Y from 'yjs';
import { getPool, query } from '../db/postgres.js';
import { COLLAB_INIT_LOCK_KEY } from '../db/advisory-locks.js';
import { htmlToText } from './content-converter.js';
import { logger } from '../utils/logger.js';
import { applyHtmlToYDoc, yDocToHtml } from './collab-schema.js';

export const COLLAB_PERSIST_DEBOUNCE_MS = 2_000;
export const COLLAB_LOAD_ORIGIN = 'load';

export type CollabPersistHandle = {
  pageId: number;
  doc: Y.Doc;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persistChain: Promise<void>;
};

export async function loadOrInitCollabDoc(
  pageId: number,
  doc: Y.Doc,
): Promise<{ pagesVersion: number } | 'missing'> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);

    const page = await client.query<{
      body_html: string | null;
      version: number;
      deleted_at: Date | null;
      page_type: string | null;
    }>(
      'SELECT body_html, version, deleted_at, page_type FROM pages WHERE id = $1',
      [pageId],
    );
    if (page.rows.length === 0) {
      await client.query('COMMIT');
      return 'missing';
    }
    const row = page.rows[0]!;
    if (row.deleted_at || (row.page_type ?? 'page') === 'folder') {
      await client.query('COMMIT');
      return 'missing';
    }

    const existing = await client.query<{ doc_state: Buffer }>(
      'SELECT doc_state FROM page_collaborative_docs WHERE page_id = $1',
      [pageId],
    );
    if (existing.rows.length > 0) {
      Y.applyUpdate(doc, new Uint8Array(existing.rows[0]!.doc_state), COLLAB_LOAD_ORIGIN);
      await client.query('COMMIT');
      return { pagesVersion: row.version };
    }

    applyHtmlToYDoc(doc, row.body_html ?? '<p></p>');
    const docState = Buffer.from(Y.encodeStateAsUpdate(doc));
    const stateVector = Buffer.from(Y.encodeStateVector(doc));
    await client.query(
      `INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector, version, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (page_id) DO NOTHING`,
      [pageId, docState, stateVector],
    );
    await client.query('COMMIT');
    return { pagesVersion: row.version };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    logger.warn({ err, pageId }, 'collab: load/init failed');
    throw err;
  } finally {
    client.release();
  }
}

export async function persistAndSnapshot(pageId: number, doc: Y.Doc): Promise<void> {
  const t0 = Date.now();
  const docState = Buffer.from(Y.encodeStateAsUpdate(doc));
  const stateVector = Buffer.from(Y.encodeStateVector(doc));
  try {
    await query(
      `INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector, version, updated_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (page_id) DO UPDATE SET
         doc_state = EXCLUDED.doc_state,
         state_vector = EXCLUDED.state_vector,
         version = page_collaborative_docs.version + 1,
         updated_at = NOW()`,
      [pageId, docState, stateVector],
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23503') return;
    throw err;
  }
  logger.info({ pageId, duration_ms: Date.now() - t0, bytes: docState.length }, 'collab.persist');

  const t1 = Date.now();
  let html: string;
  try {
    html = yDocToHtml(doc);
  } catch (err) {
    logger.warn({ err, pageId }, 'collab: snapshot HTML failed');
    return;
  }
  const bodyText = htmlToText(html);
  await query(
    `UPDATE pages SET
       body_html = $2,
       body_text = $3,
       embedding_dirty = TRUE,
       image_embedding_dirty = CASE
         WHEN body_html IS DISTINCT FROM $2 THEN TRUE
         ELSE image_embedding_dirty
       END
     WHERE id = $1 AND deleted_at IS NULL`,
    [pageId, html, bodyText],
  );
  logger.info({ pageId, duration_ms: Date.now() - t1, html_bytes: html.length }, 'collab.snapshot');
}

export function scheduleCollabPersist(room: CollabPersistHandle & { persistable?: boolean }): void {
  if (room.persistable === false) return;
  if (room.persistTimer) clearTimeout(room.persistTimer);
  room.persistTimer = setTimeout(() => {
    room.persistTimer = null;
    enqueuePersist(room);
  }, COLLAB_PERSIST_DEBOUNCE_MS);
  if (typeof room.persistTimer.unref === 'function') room.persistTimer.unref();
}

export async function flushCollabPersist(room: CollabPersistHandle & { persistable?: boolean }): Promise<void> {
  if (room.persistable === false) return;
  if (room.persistTimer) {
    clearTimeout(room.persistTimer);
    room.persistTimer = null;
  }
  enqueuePersist(room);
  await room.persistChain;
}

function enqueuePersist(room: CollabPersistHandle): void {
  room.persistChain = room.persistChain
    .then(() => persistAndSnapshot(room.pageId, room.doc))
    .catch((err) => {
      logger.warn({ err, pageId: room.pageId }, 'collab: persist failed');
    });
}

export async function deleteCollabDocRow(pageId: number): Promise<void> {
  await query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
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
