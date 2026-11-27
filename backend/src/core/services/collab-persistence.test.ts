/**
 * BYTEA persist + HTML snapshot without version fights (#1445).
 * Real Postgres (:5433) + real Redis. Never mock the DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import * as Y from 'yjs';
import type { WebSocket } from 'ws';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../db/postgres.js';
import { setRedisClient } from './redis-cache.js';
import {
  createCollabRuntime,
  COLLAB_EMPTY_ROOM_GRACE_MS,
  type CollabRuntime,
} from './collab-room-service.js';
import {
  COLLAB_PERSIST_DEBOUNCE_MS,
  loadOrInitCollabDoc,
  markPersistedTaskIds,
  mergePersistedCollabDoc,
  persistAndSnapshot,
  persistCollabDocState,
  readCollabDocEpoch,
} from './collab-persistence.js';
import { applyHtmlToYDoc, collabSeededCarrierKinds, yDocToHtml } from './collab-schema.js';
import { confluenceToHtml } from './content-converter.js';
import { LEGACY_CARRIER_FIXTURES as LEGACY } from './__fixtures__/confluence-carrier-legacy.js';
import { logger } from '../utils/logger.js';
import {
  admitPageRuntime,
  releasePageRuntime,
  withPageWriteTransaction,
  type PageRuntimeAdmission,
} from './page-write-admission.js';

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
        created_by_user_id, page_type, embedding_dirty,
        summary_status, quality_status, local_modified_at, local_modified_by
     ) VALUES (
        '_standalone', $1, $2, $2, 'seed', 1, 'standalone', 'shared',
        $3, 'page', FALSE, 'summarized', 'analyzed', NULL, NULL
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
    image_analysis_dirty: boolean;
    local_modified_at: Date | null;
    local_modified_by: string | null;
    summary_status: string;
    quality_status: string;
  }>(
    `SELECT body_html, body_text, version, embedding_dirty, image_analysis_dirty,
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
  await withPageWriteTransaction([], async () => undefined);
  runtime = await createCollabRuntime(main, 'persist-pod');
});

describe.skipIf(!canRun)('collab persistence init (#1445)', () => {
  it('read-only load stays BYTEA-free; first writable join initializes once from body_html', async () => {
    const owner = await insertUser('persist_init');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });

    const roomA = await runtime!.getOrCreateRoom(pageId);
    expect(fragmentText(roomA.doc)).toContain(UNIQUE);
    expect(fragmentText(roomA.doc).split(UNIQUE)).toHaveLength(2);
    expect((await collabRow(pageId)).rows).toHaveLength(0);

    await runtime!.attachSocket(pageId, {
      id: 'first-writer', ws: stubWs(), userId: owner, writable: true,
    });
    const bytea = await collabRow(pageId);
    expect(bytea.rows).toHaveLength(1);
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, new Uint8Array(bytea.rows[0]!.doc_state));
    expect(fragmentText(loaded)).toContain(UNIQUE);
    loaded.destroy();

    const roomSame = await runtime!.getOrCreateRoom(pageId);
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

  it('concurrent first writable joins share one initial document rather than duplicate its text', async () => {
    const owner = await insertUser('persist_concurrent_init');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });
    const runtimeB = await createCollabRuntime(main!, 'persist-init-pod-b');
    const merged = new Y.Doc();
    try {
      await Promise.all([
        runtime!.attachSocket(pageId, {
          id: 'initial-writer-a', ws: stubWs(), userId: owner, writable: true,
        }),
        runtime!.attachSocket(pageId, {
          id: 'initial-writer-a-second', ws: stubWs(), userId: owner, writable: true,
        }),
        runtimeB.attachSocket(pageId, {
          id: 'initial-writer-b', ws: stubWs(), userId: owner, writable: true,
        }),
      ]);
      for (const peer of [runtime!, runtimeB]) {
        const room = await peer.getOrCreateRoom(pageId);
        Y.applyUpdate(merged, Y.encodeStateAsUpdate(room.doc));
      }
      expect(fragmentText(merged)).toBe(UNIQUE);
    } finally {
      merged.destroy();
      await runtimeB.close();
    }
  });
});

describe.skipIf(!canRun)('collab BYTEA persist + snapshot (#1445)', () => {
  it('merges independently admitted room flushes instead of replacing an unseen peer edit', async () => {
    const owner = await insertUser('partitioned_flush');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });
    const admissionA = await admitPageRuntime(pageId, owner, 'collab_room');
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const restored = new Y.Doc();
    try {
      const seeded = await loadOrInitCollabDoc(pageId, docA, admissionA);
      if (seeded === 'missing' || seeded.docEpoch === null) throw new Error('seed did not create the document');
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
      appendText(docA, ' FIRST_ROOM');
      appendText(docB, ' SECOND_ROOM');
      const admissionB = await admitPageRuntime(pageId, owner, 'collab_room');
      try {
        await persistAndSnapshot(pageId, docA, admissionA, seeded.docEpoch);
        await persistAndSnapshot(pageId, docB, admissionB, seeded.docEpoch);
      } finally {
        await releasePageRuntime(admissionB);
      }
      const stored = (await collabRow(pageId)).rows[0]!;
      const published = (await pageRow(pageId)).rows[0]!;
      Y.applyUpdate(restored, new Uint8Array(stored.doc_state));
      expect(yDocToHtml(restored)).toBe(published.body_html);
      expect(published.body_html).toContain(UNIQUE);
      expect(published.body_html).toContain('FIRST_ROOM');
      expect(published.body_html).toContain('SECOND_ROOM');
      expect(published.body_text).toContain('FIRST_ROOM');
      expect(published.body_text).toContain('SECOND_ROOM');
    } finally {
      await releasePageRuntime(admissionA);
      docA.destroy();
      docB.destroy();
      restored.destroy();
    }
  });

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
    expect(page.image_analysis_dirty).toBe(true);
    expect(page.body_text.length).toBeGreaterThan(0);
    expect(yDocToHtml(room.doc)).toContain('SNAPSHOTTED');
  });
});

describe.skipIf(!canRun)('empty-room BYTEA invalidation (#1445)', () => {
  it('DELETE FROM page_collaborative_docs lets the next join re-init from HTML', async () => {
    const owner = await insertUser('persist_inval');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });
    await runtime!.attachSocket(pageId, {
      id: 'writer', ws: stubWs(), userId: owner, writable: true,
    });
    const room = runtime!.getRoom(pageId)!;
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

// The #1474 case (an in-flight room persist must not write over an inbound
// reset) is exercised on the real publication path since #2034:
// routes/knowledge/collab-inbound-publication.integration.test.ts.
describe.skipIf(!canRun)('document epoch at the persistence boundary (#2034)', () => {
  async function seed(pageId: number, owner: string): Promise<{
    doc: Y.Doc;
    admission: PageRuntimeAdmission;
    docEpoch: string;
  }> {
    const admission = await admitPageRuntime(pageId, owner, 'collab_room');
    const doc = new Y.Doc();
    const loaded = await loadOrInitCollabDoc(pageId, doc, admission);
    if (loaded === 'missing' || loaded.docEpoch === null) throw new Error('seed did not create the document');
    return { doc, admission, docEpoch: loaded.docEpoch };
  }

  async function storedRow(pageId: number) {
    return query<{ doc_epoch: string; doc_state: Buffer; version: number }>(
      'SELECT doc_epoch::text, doc_state, version FROM page_collaborative_docs WHERE page_id = $1', [pageId],
    );
  }

  it('a read-only load names no epoch; the seed takes the database value and every later load reads the same', async () => {
    const owner = await insertUser('epoch_seed');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });
    const reader = new Y.Doc();
    const again = new Y.Doc();
    const second = new Y.Doc();
    const admissions: PageRuntimeAdmission[] = [];
    try {
      expect(await loadOrInitCollabDoc(pageId, reader)).toMatchObject({ hasPersistedDoc: false, docEpoch: null });
      expect(await readCollabDocEpoch(pageId)).toBeNull();

      const seeded = await seed(pageId, owner);
      admissions.push(seeded.admission);
      const stored = await storedRow(pageId);
      expect(stored.rows).toHaveLength(1);
      expect(seeded.docEpoch).toBe(stored.rows[0]!.doc_epoch);
      expect(await readCollabDocEpoch(pageId)).toBe(seeded.docEpoch);

      // A reload, with or without an admission, continues that lineage: no second seed.
      expect(await loadOrInitCollabDoc(pageId, again)).toMatchObject({
        hasPersistedDoc: true, docEpoch: seeded.docEpoch,
      });
      const secondAdmission = await admitPageRuntime(pageId, owner, 'collab_room');
      admissions.push(secondAdmission);
      expect(await loadOrInitCollabDoc(pageId, second, secondAdmission)).toMatchObject({
        hasPersistedDoc: true, docEpoch: seeded.docEpoch,
      });
      expect((await storedRow(pageId)).rows).toEqual(stored.rows);

      // The room's own persist keeps the epoch.
      appendText(seeded.doc, ' OWN_PERSIST');
      await persistAndSnapshot(pageId, seeded.doc, seeded.admission, seeded.docEpoch);
      expect((await storedRow(pageId)).rows[0]).toMatchObject({ doc_epoch: seeded.docEpoch, version: 2 });
      seeded.doc.destroy();
    } finally {
      for (const admission of admissions) await releasePageRuntime(admission);
      reader.destroy();
      again.destroy();
      second.destroy();
    }
  });

  it.each(['deleted', 'replaced'] as const)(
    'a persist whose row was %s answers collab_lineage_changed and leaves body_html untouched',
    async (fate) => {
      const owner = await insertUser(`epoch_persist_${fate}`);
      const pageId = await insertPage({ ownerId: owner, html: '<p>SEED</p>' });
      const { doc, admission, docEpoch } = await seed(pageId, owner);
      try {
        appendText(doc, ' STALE_ROOM_EDIT');
        // What an inbound publication or a non-collab body write commits.
        await query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
        await query(`UPDATE pages SET body_html = '<p>PUBLISHED</p>', body_text = 'PUBLISHED' WHERE id = $1`, [pageId]);
        if (fate === 'replaced') {
          await query(
            `INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, '\\x0000'::bytea)`, [pageId],
          );
        }
        const before = await storedRow(pageId);

        await expect(persistAndSnapshot(pageId, doc, admission, docEpoch))
          .rejects.toMatchObject({ reason: 'collab_lineage_changed', statusCode: 409 });
        await expect(persistCollabDocState(pageId, doc, admission, docEpoch))
          .rejects.toMatchObject({ reason: 'collab_lineage_changed' });

        expect((await pageRow(pageId)).rows[0]).toMatchObject({
          body_html: '<p>PUBLISHED</p>', body_text: 'PUBLISHED',
        });
        // A room never inserts, and never writes into the row of another lineage.
        const after = await storedRow(pageId);
        expect(after.rows).toEqual(before.rows);
        expect(after.rows).toHaveLength(fate === 'deleted' ? 0 : 1);
      } finally {
        await releasePageRuntime(admission);
        doc.destroy();
      }
    },
  );

  it('merges only the persisted bytes of its own epoch, refusing before any byte is applied', async () => {
    const owner = await insertUser('epoch_merge');
    const pageId = await insertPage({ ownerId: owner, html: '<p>SEED</p>' });
    const { doc, admission, docEpoch } = await seed(pageId, owner);
    const foreign = new Y.Doc();
    try {
      foreign.getText('foreign').insert(0, 'FOREIGN_LINEAGE');
      await query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
      await query(
        'INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, $2)',
        [pageId, Buffer.from(Y.encodeStateAsUpdate(foreign))],
      );
      const before = Buffer.from(Y.encodeStateAsUpdate(doc));
      await expect(withPageWriteTransaction(
        [pageId],
        (client) => mergePersistedCollabDoc(client, pageId, doc, docEpoch),
        { admission, ownCollabCommit: 'proceed' },
      )).rejects.toMatchObject({ reason: 'collab_lineage_changed' });
      expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(true);
      expect(doc.getText('foreign').toString()).toBe('');

      // The row's own epoch still merges.
      const current = await readCollabDocEpoch(pageId);
      if (current === null) throw new Error('the replacement row is missing');
      await withPageWriteTransaction(
        [pageId],
        (client) => mergePersistedCollabDoc(client, pageId, doc, current),
        { admission, ownCollabCommit: 'proceed' },
      );
      expect(doc.getText('foreign').toString()).toBe('FOREIGN_LINEAGE');
    } finally {
      await releasePageRuntime(admission);
      doc.destroy();
      foreign.destroy();
    }
  });

  it('a post-Save mark that carries another epoch is skipped; the row of its own epoch is marked', async () => {
    const owner = await insertUser('epoch_marks');
    const pageId = await insertPage({ ownerId: owner, html: '<p>SEED</p>' });
    const { doc, admission, docEpoch } = await seed(pageId, owner);
    doc.destroy();
    await releasePageRuntime(admission);
    const request = await admitPageRuntime(pageId, owner, 'collab_request');
    try {
      const seeded = await storedRow(pageId);
      // The Save's snapshot belonged to a lineage that has since been replaced.
      await markPersistedTaskIds(pageId, request, [], '7b0f4c1e-52a8-4d3f-9c6b-1a2b3c4d5e6f');
      expect((await storedRow(pageId)).rows).toEqual(seeded.rows);

      // An empty marker list still records that the tasks carry ids (#1751).
      await markPersistedTaskIds(pageId, request, [], docEpoch);
      const marked = await storedRow(pageId);
      expect(marked.rows[0]).toMatchObject({ doc_epoch: docEpoch, version: seeded.rows[0]!.version + 1 });
      expect(marked.rows[0]!.doc_state.equals(seeded.rows[0]!.doc_state)).toBe(false);
    } finally {
      await releasePageRuntime(request);
    }
  });
});

describe.skipIf(!canRun)('seed of a page synced before v0.10.0 (#1953, Z5, Z6)', () => {
  const LOG = 'Confluence carriers reconciled (#1953)';
  const ALL_KINDS = ['emoticon', 'link', 'macro.code', 'macro.status', 'macro.toc'];

  async function insertLegacyPage(owner: string, fixture: { storage: string; legacyHtml: string } = LEGACY.ac1, localModified = false): Promise<number> {
    const r = await query<{ id: number }>(
      `INSERT INTO pages (
          confluence_id, space_key, title, body_storage, body_html, body_text, version, source, visibility,
          created_by_user_id, page_type, embedding_dirty, local_modified_at
       ) VALUES ('legacy-seed', 'OPS', 'Legacy', $1, $2, 'x', 1, 'confluence', 'shared', $3, 'page', FALSE,
                 CASE WHEN $4 THEN NOW() ELSE NULL END)
       RETURNING id`,
      [fixture.storage, fixture.legacyHtml, owner, localModified],
    );
    return r.rows[0]!.id;
  }

  /** The document an `applyHtmlToYDoc` of `html` alone gives, as HTML: one copy, nothing merged twice. */
  function documentOf(html: string, carrierKinds?: string[]): { html: string; kinds: ReadonlySet<string> } {
    const doc = new Y.Doc();
    try {
      applyHtmlToYDoc(doc, html, carrierKinds ? { carrierKinds } : {});
      return { html: yDocToHtml(doc), kinds: collabSeededCarrierKinds(doc) };
    } finally {
      doc.destroy();
    }
  }

  async function writableLoad(pageId: number, owner: string, doc: Y.Doc) {
    const admission = await admitPageRuntime(pageId, owner, 'collab_room');
    try {
      return await loadOrInitCollabDoc(pageId, doc, admission);
    } finally {
      await releasePageRuntime(admission);
    }
  }

  const carrierLines = (spy: { mock: { calls: unknown[][] } }): unknown[] =>
    spy.mock.calls.filter((call) => call[1] === LOG).map((call) => call[0]);

  it('seeds a legacy Confluence page with its carriers and the confluenceCarriers key in one update, and logs after the insert', async () => {
    const owner = await insertUser('carrier_seed');
    const pageId = await insertLegacyPage(owner);
    const doc = new Y.Doc();
    const info = vi.spyOn(logger, 'info');
    try {
      expect(await writableLoad(pageId, owner, doc)).toMatchObject({ hasPersistedDoc: true });
      const expected = documentOf(confluenceToHtml(LEGACY.ac1.storage, 'legacy-seed', 'OPS'), ALL_KINDS);
      expect(yDocToHtml(doc)).toBe(expected.html);
      expect([...collabSeededCarrierKinds(doc)]).toEqual(ALL_KINDS);
      expect(fragmentText(doc).match(/Jump/g)).toHaveLength(1);
      expect(carrierLines(info)).toEqual([{
        pageId, writer: 'collab_seed', outcome: 'recovered',
        recovered: { emoticon: 2, 'macro.code': 1, 'macro.toc': 1, 'macro.status': 1, link: 3 }, skipped: {},
      }]);
      // The persisted bytes are that one update.
      const persisted = new Y.Doc();
      Y.applyUpdate(persisted, new Uint8Array((await collabRow(pageId)).rows[0]!.doc_state));
      expect(yDocToHtml(persisted)).toBe(expected.html);
      expect(yDocToHtml(persisted)).not.toContain('data-cq-');
      persisted.destroy();
    } finally {
      info.mockRestore();
      doc.destroy();
    }
  });

  it('Z6: a seed whose every record of a kind is skipped leaves that kind out of the key and logs evaluated', async () => {
    const owner = await insertUser('carrier_seed_skips');
    const pageId = await insertLegacyPage(owner, LEGACY.twoLookalikeLinks);
    const doc = new Y.Doc();
    const info = vi.spyOn(logger, 'info');
    try {
      await writableLoad(pageId, owner, doc);
      expect([...collabSeededCarrierKinds(doc)]).toEqual(ALL_KINDS.filter((kind) => kind !== 'link'));
      expect(yDocToHtml(doc)).toBe(documentOf(LEGACY.twoLookalikeLinks.legacyHtml).html);
      expect(carrierLines(info)).toEqual([{
        pageId, writer: 'collab_seed', outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 2 } },
      }]);
    } finally {
      info.mockRestore();
      doc.destroy();
    }
  });

  it('a seed whose reconcile ends on a bound writes no key and logs that outcome', async () => {
    const owner = await insertUser('carrier_seed_bound');
    const pageId = await insertLegacyPage(owner, LEGACY.taskInTask);
    const doc = new Y.Doc();
    const info = vi.spyOn(logger, 'info');
    try {
      await writableLoad(pageId, owner, doc);
      expect(collabSeededCarrierKinds(doc).size).toBe(0);
      expect(doc.getMap('compendiq.meta').has('confluenceCarriers')).toBe(false);
      expect(yDocToHtml(doc)).toBe(documentOf(LEGACY.taskInTask.legacyHtml).html);
      expect(carrierLines(info)).toEqual([{ pageId, writer: 'collab_seed', outcome: 'bound' }]);
    } finally {
      info.mockRestore();
      doc.destroy();
    }
  });

  it('a writable load of a locally modified page seeds the ordinary HTML once, without recovery and without the key', async () => {
    const owner = await insertUser('carrier_seed_local');
    const pageId = await insertLegacyPage(owner, LEGACY.ac1, true);
    const doc = new Y.Doc();
    try {
      await writableLoad(pageId, owner, doc);
      expect(yDocToHtml(doc)).toBe(documentOf(LEGACY.ac1.legacyHtml).html);
      expect(doc.getMap('compendiq.meta').has('confluenceCarriers')).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('a read-only load of a missing document applies the ordinary HTML, inserts no row and writes no key', async () => {
    const owner = await insertUser('carrier_seed_readonly');
    const pageId = await insertLegacyPage(owner);
    const doc = new Y.Doc();
    try {
      expect(await loadOrInitCollabDoc(pageId, doc)).toMatchObject({ hasPersistedDoc: false });
      expect(yDocToHtml(doc)).toBe(documentOf(LEGACY.ac1.legacyHtml).html);
      expect(doc.getMap('compendiq.meta').has('confluenceCarriers')).toBe(false);
      expect((await collabRow(pageId)).rows).toHaveLength(0);
    } finally {
      doc.destroy();
    }
  });

  it('a persisted document is loaded with its bytes only, writable and read-only: no reconcile, no second line', async () => {
    const owner = await insertUser('carrier_seed_persisted');
    const pageId = await insertLegacyPage(owner);
    const first = new Y.Doc();
    await writableLoad(pageId, owner, first);
    const stored = (await collabRow(pageId)).rows[0]!.doc_state;
    const info = vi.spyOn(logger, 'info');
    const writable = new Y.Doc();
    const readOnly = new Y.Doc();
    try {
      await writableLoad(pageId, owner, writable);
      await loadOrInitCollabDoc(pageId, readOnly);
      expect(yDocToHtml(writable)).toBe(yDocToHtml(first));
      expect(yDocToHtml(readOnly)).toBe(yDocToHtml(first));
      expect((await collabRow(pageId)).rows[0]!.doc_state.equals(stored)).toBe(true);
      expect(carrierLines(info)).toEqual([]);
    } finally {
      info.mockRestore();
      first.destroy();
      writable.destroy();
      readOnly.destroy();
    }
  });

  it('reserve → seed: a seed under the page\'s own pending collaborative Save runs unrecovered and writes no key', async () => {
    const owner = await insertUser('carrier_seed_pending');
    const pageId = await insertLegacyPage(owner);
    const admission = await admitPageRuntime(pageId, owner, 'collab_room');
    const doc = new Y.Doc();
    try {
      await query(
        `INSERT INTO page_write_intents (runtime_id, kind, page_ids, revisions, recovery_mode, effect)
         VALUES ($2, 'collab.commit.confluence', ARRAY[$1]::integer[], '{}', 'remote_conditional',
                 jsonb_build_object('effectClass', 'remote', 'pageId', $1::integer, 'confluenceId', 'legacy-seed',
                                    'expectedRemoteVersion', '1', 'intendedStateDigest', repeat('a', 64)))`,
        [pageId, admission.runtimeId],
      );
      await loadOrInitCollabDoc(pageId, doc, admission);
      expect(yDocToHtml(doc)).toBe(documentOf(LEGACY.ac1.legacyHtml).html);
      expect(doc.getMap('compendiq.meta').has('confluenceCarriers')).toBe(false);
    } finally {
      await query('DELETE FROM page_write_intents WHERE page_ids = ARRAY[$1]::integer[]', [pageId]);
      await releasePageRuntime(admission);
      doc.destroy();
    }
  });

  it('seeds a standalone room exactly as before', async () => {
    const owner = await insertUser('carrier_seed_standalone');
    const pageId = await insertPage({ ownerId: owner, html: `<p>${UNIQUE}</p>` });
    const doc = new Y.Doc();
    try {
      await writableLoad(pageId, owner, doc);
      expect(yDocToHtml(doc)).toBe(documentOf(`<p>${UNIQUE}</p>`).html);
      expect(doc.getMap('compendiq.meta').has('confluenceCarriers')).toBe(false);
    } finally {
      doc.destroy();
    }
  });
});
