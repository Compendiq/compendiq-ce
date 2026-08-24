/**
 * BYTEA persist + HTML snapshot without version fights (#1445).
 * Real Postgres (:5433) + real Redis. Never mock the DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type RedisClientType } from 'redis';
import * as Y from 'yjs';
import type { WebSocket } from 'ws';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../db/postgres.js';
import { COLLAB_INIT_LOCK_KEY } from '../db/advisory-locks.js';
import { setRedisClient } from './redis-cache.js';
import {
  createCollabRuntime,
  COLLAB_EMPTY_ROOM_GRACE_MS,
  type CollabRuntime,
} from './collab-room-service.js';
import { COLLAB_PERSIST_DEBOUNCE_MS } from './collab-persistence.js';
import { yDocToHtml } from './collab-schema.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await isRedisAvailable() : false;
const canRun = dbAvailable && redisAvailable;

const UNIQUE = 'UNIQUE_INIT_PHRASE_1445';

let main: RedisClientType | null = null;
let runtime: CollabRuntime | null = null;

function stubWs(): WebSocket {
  return { readyState: 1, send() {}, close() {} } as unknown as WebSocket;
}

function fragmentText(doc: Y.Doc): string {
  return collectText(doc.getXmlFragment('default'));
}

function collectText(node: Y.XmlFragment | Y.XmlElement): string {
  let s = '';
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText) s += child.toString();
    else if (child instanceof Y.XmlElement || child instanceof Y.XmlFragment) s += collectText(child);
  }
  return s;
}

function appendText(doc: Y.Doc, text: string): void {
  const frag = doc.getXmlFragment('default');
  const walk = (n: Y.XmlFragment | Y.XmlElement): boolean => {
    for (let i = 0; i < n.length; i++) {
      const child = n.get(i);
      if (child instanceof Y.XmlText) {
        child.insert(child.length, text);
        return true;
      }
      if (child instanceof Y.XmlElement && walk(child)) return true;
    }
    return false;
  };
  if (!walk(frag)) {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, t);
    frag.insert(frag.length, p);
  }
}

async function insertUser(username: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'user') RETURNING id`,
    [username],
  );
  return r.rows[0]!.id;
}

async function insertPage(opts: {
  ownerId: string;
  html: string;
  title?: string;
}): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (
        space_key, title, body_storage, body_html, body_text, version, source, visibility,
        created_by_user_id, page_type, embedding_dirty, image_embedding_dirty,
        summary_status, quality_status, local_modified_at, local_modified_by
     ) VALUES (
        '_standalone', $1, $2, $2, 'seed', 1, 'standalone', 'shared',
        $3, 'page', FALSE, FALSE, 'summarized', 'analyzed', NULL, NULL
     ) RETURNING id`,
    [opts.title ?? 'Persist page', opts.html, opts.ownerId],
  );
  return r.rows[0]!.id;
}

async function collabRow(pageId: number) {
  return query<{
    doc_state: Buffer;
    state_vector: Buffer | null;
    version: number;
  }>(
    'SELECT doc_state, state_vector, version FROM page_collaborative_docs WHERE page_id = $1',
    [pageId],
  );
}

async function pageRow(pageId: number) {
  return query<{
    body_html: string;
    body_text: string;
    version: number;
    embedding_dirty: boolean;
    image_embedding_dirty: boolean;
    local_modified_at: Date | null;
    local_modified_by: string | null;
    summary_status: string;
    quality_status: string;
  }>(
    `SELECT body_html, body_text, version, embedding_dirty, image_embedding_dirty,
            local_modified_at, local_modified_by, summary_status, quality_status
       FROM pages WHERE id = $1`,
    [pageId],
  );
}

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  main = createClient({ url }) as RedisClientType;
  main.on('error', () => { /* assertions surface failures */ });
  await main.connect();
  setRedisClient(main);
}, 30_000);

afterAll(async () => {
  if (!canRun) return;
  if (runtime) await runtime.close();
  if (main) await main.quit();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun || !main) return;
  if (runtime) await runtime.close();
  await truncateAllTables();
  runtime = await createCollabRuntime(main, 'persist-pod');
});

describe.skipIf(!canRun)('collab persistence init (#1445)', () => {
  it('first join with no BYTEA row inits from body_html; dual-join does not duplicate', async () => {
    const owner = await insertUser('persist_init');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });

    const roomA = await runtime!.getOrCreateRoom(pageId);
    expect(fragmentText(roomA.doc)).toContain(UNIQUE);
    expect(fragmentText(roomA.doc).split(UNIQUE)).toHaveLength(2);

    const bytea = await collabRow(pageId);
    expect(bytea.rows).toHaveLength(1);
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, new Uint8Array(bytea.rows[0]!.doc_state));
    expect(fragmentText(loaded)).toContain(UNIQUE);
    expect(Buffer.from(bytea.rows[0]!.state_vector ?? [])).toEqual(
      Buffer.from(Y.encodeStateVector(roomA.doc)),
    );

    const roomSame = await runtime!.getOrCreateRoom(pageId);
    expect(roomSame).toBe(roomA);
    expect(fragmentText(roomSame.doc).split(UNIQUE)).toHaveLength(2);

    const runtimeB = await createCollabRuntime(main!, 'persist-pod-b');
    try {
      const roomB = await runtimeB.getOrCreateRoom(pageId);
      await vi.waitFor(() => {
        expect(fragmentText(roomB.doc)).toContain(UNIQUE);
      }, { timeout: 4_000 });
      expect(fragmentText(roomB.doc).split(UNIQUE)).toHaveLength(2);
    } finally {
      await runtimeB.close();
    }
  });

  it('takes the two-key advisory lock COLLAB_INIT_LOCK_KEY', () => {
    expect(COLLAB_INIT_LOCK_KEY).toBe(1_411_001);
    const persistSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'collab-persistence.ts'),
      'utf8',
    );
    const roomSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'collab-room-service.ts'),
      'utf8',
    );
    const src = persistSrc + roomSrc;
    expect(src).toContain('pg_advisory_xact_lock($1, $2)');
    expect(src).toContain('COLLAB_INIT_LOCK_KEY');
    expect(src).not.toMatch(/pg_advisory_xact_lock\(\s*\$1\s*\)/);
  });
});

describe.skipIf(!canRun)('collab BYTEA persist + snapshot (#1445)', () => {
  it('persists encodeStateAsUpdate / encodeStateVector after the 2s debounce', async () => {
    const owner = await insertUser('persist_debounce');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });
    await runtime!.attachSocket(pageId, {
      id: 'editor-1',
      ws: stubWs(),
      userId: owner,
      writable: true,
    });
    const room = runtime!.getRoom(pageId)!;
    const before = await collabRow(pageId);
    expect(before.rows[0]!.version).toBe(1);

    appendText(room.doc, ' TYPED');
    await new Promise((r) => setTimeout(r, 800));
    const mid = await collabRow(pageId);
    expect(mid.rows[0]!.version).toBe(1);

    await vi.waitFor(async () => {
      const after = await collabRow(pageId);
      expect(after.rows[0]!.version).toBeGreaterThan(1);
    }, { timeout: COLLAB_PERSIST_DEBOUNCE_MS + 2_000 });

    const stored = await collabRow(pageId);
    const round = new Y.Doc();
    Y.applyUpdate(round, new Uint8Array(stored.rows[0]!.doc_state));
    expect(fragmentText(round)).toContain('TYPED');
    expect(Buffer.from(stored.rows[0]!.state_vector ?? [])).toEqual(
      Buffer.from(Y.encodeStateVector(room.doc)),
    );
    expect(COLLAB_PERSIST_DEBOUNCE_MS).toBe(2_000);
  }, 15_000);

  it('flushes BYTEA immediately on last disconnect (does not wait for debounce)', async () => {
    const owner = await insertUser('persist_flush');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });
    await runtime!.attachSocket(pageId, {
      id: 'last-editor',
      ws: stubWs(),
      userId: owner,
      writable: true,
    });
    const room = runtime!.getRoom(pageId)!;
    appendText(room.doc, ' FLUSHME');
    await runtime!.detachSocket(pageId, 'last-editor');

    const stored = await vi.waitFor(async () => {
      const row = await collabRow(pageId);
      expect(row.rows).toHaveLength(1);
      const probe = new Y.Doc();
      Y.applyUpdate(probe, new Uint8Array(row.rows[0]!.doc_state));
      expect(fragmentText(probe)).toContain('FLUSHME');
      return row;
    }, { timeout: 800 });
    expect(stored.rows[0]!.version).toBeGreaterThan(1);
  });

  it('snapshot writes body_html/body_text/embedding flags and does not bump version, local_modified, or re-queue summary/quality', async () => {
    const owner = await insertUser('persist_snap');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });
    await runtime!.attachSocket(pageId, {
      id: 'snap-ed',
      ws: stubWs(),
      userId: owner,
      writable: true,
    });
    const room = runtime!.getRoom(pageId)!;
    appendText(room.doc, ' SNAPSHOTTED');
    await runtime!.detachSocket(pageId, 'snap-ed');

    const page = await vi.waitFor(async () => {
      const row = await pageRow(pageId);
      expect(row.rows[0]!.body_html).toContain('SNAPSHOTTED');
      return row.rows[0]!;
    }, { timeout: 2_000 });

    expect(page.version).toBe(1);
    expect(page.local_modified_at).toBeNull();
    expect(page.local_modified_by).toBeNull();
    expect(page.summary_status).toBe('summarized');
    expect(page.quality_status).toBe('analyzed');
    expect(page.embedding_dirty).toBe(true);
    expect(page.body_text.length).toBeGreaterThan(0);
    expect(yDocToHtml(room.doc)).toContain('SNAPSHOTTED');
  });
});

describe.skipIf(!canRun)('empty-room BYTEA invalidation (#1445)', () => {
  it('DELETE FROM page_collaborative_docs lets the next join re-init from HTML', async () => {
    const owner = await insertUser('persist_inval');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });
    const room = await runtime!.getOrCreateRoom(pageId);
    expect(fragmentText(room.doc)).toContain(UNIQUE);
    expect((await collabRow(pageId)).rows).toHaveLength(1);

    await runtime!.close();
    await new Promise((r) => setTimeout(r, COLLAB_EMPTY_ROOM_GRACE_MS + 50));

    await query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
    await query(`UPDATE pages SET body_html = '<p>AFTER_WRITE</p>', body_text = 'AFTER_WRITE' WHERE id = $1`, [pageId]);

    runtime = await createCollabRuntime(main!, 'persist-pod-reinit');
    const again = await runtime.getOrCreateRoom(pageId);
    expect(fragmentText(again.doc)).toContain('AFTER_WRITE');
    expect(fragmentText(again.doc)).not.toContain(UNIQUE);
  }, 20_000);
});
