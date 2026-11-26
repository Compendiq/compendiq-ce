/**
 * #2034 — a server-owned document epoch (`page_collaborative_docs.doc_epoch`)
 * tells a document lineage from its replacement. It is validated at every
 * boundary where persisted bytes and a room document meet, and a join that
 * declares another epoch is refused with `doc_reset` instead of merging.
 *
 * Real PostgreSQL and Redis. Isolated runtimes stand in for pods; sockets are
 * recorded stubs (the real y-websocket provider joins in pages-collab.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { COLLAB_INIT_LOCK_KEY, PAGE_LIFECYCLE_LOCK_KEY } from '../db/advisory-locks.js';
import {
  collabDocChannel,
  createCollabRuntime,
  COLLAB_EMPTY_ROOM_GRACE_MS,
  type CollabDocEpochDeclaration,
  type CollabRoom,
  type CollabRuntime,
  type CollabSocket,
} from './collab-room-service.js';
import { assertNoLiveCollabRoom } from './collab-guard.js';
import { setRedisClient } from './redis-cache.js';
import * as persist from './collab-persistence.js';
import { yDocToHtml } from './collab-schema.js';
import { admitPageRuntime, releasePageRuntime, withPageWriteTransaction } from './page-write-admission.js';

const canRun = (await isRedisAvailable()) && (await isDbAvailable());
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const OTHER_EPOCH = '7b0f4c1e-52a8-4d3f-9c6b-1a2b3c4d5e6f';

let main: RedisClientType | null = null;
let runtimeA: CollabRuntime | null = null;
let runtimeB: CollabRuntime | null = null;
let pageIds: number[] = [];
const usedPageIds: number[] = [];

function nextPageId(): number {
  const id = pageIds.shift();
  if (!id) throw new Error('test page pool exhausted');
  usedPageIds.push(id);
  return id;
}

interface RecordedSocket {
  ws: WebSocket;
  frames: Uint8Array[];
  closes: Array<{ code: number; reason: string }>;
}

function recordedSocket(): RecordedSocket {
  const frames: Uint8Array[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const socket = {
    readyState: 1,
    send(frame: Uint8Array) { frames.push(frame); },
    close(code?: number, reason?: string) {
      closes.push({ code: code ?? 1005, reason: String(reason ?? '') });
      socket.readyState = 3;
    },
  };
  return { ws: socket as unknown as WebSocket, frames, closes };
}

/** The control frames a socket was sent, in order. */
function controls(socket: RecordedSocket): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  for (const frame of socket.frames) {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== 4) continue;
    sent.push(JSON.parse(decoding.readVarString(decoder)) as Record<string, unknown>);
  }
  return sent;
}

function controlTypes(socket: RecordedSocket): unknown[] {
  return controls(socket).map((control) => control.type);
}

function syncUpdateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** An update that a room either holds afterwards (`probeOf`) or does not. */
function probeUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('probe').insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function probeOf(doc: Y.Doc): string {
  return doc.getText('probe').toString();
}

function appendParagraph(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    const content = new Y.XmlText();
    content.insert(0, text);
    paragraph.insert(0, [content]);
    doc.getXmlFragment('default').push([paragraph]);
  });
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function join(
  runtime: CollabRuntime,
  pageId: number,
  id: string,
  options: {
    writable?: boolean;
    userId?: string;
    expectedDocEpoch?: CollabDocEpochDeclaration;
    expectedLifecycleRevision?: string | null;
  } = {},
): Promise<{ socket: RecordedSocket; attached: CollabSocket }> {
  const socket = recordedSocket();
  const attached = await runtime.attachSocket(pageId, {
    id,
    ws: socket.ws,
    userId: options.userId ?? USER_A,
    writable: options.writable ?? true,
    ...(options.expectedDocEpoch ? { expectedDocEpoch: options.expectedDocEpoch } : {}),
    ...(options.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: options.expectedLifecycleRevision }
      : {}),
  });
  return { socket, attached };
}

async function storedDoc(pageId: number) {
  const stored = await query<{ doc_epoch: string; version: number; doc_state: Buffer }>(
    'SELECT doc_epoch::text, version, doc_state FROM page_collaborative_docs WHERE page_id = $1', [pageId],
  );
  return stored.rows;
}

/** Read from the table, not through the code under test. */
async function rowEpoch(pageId: number): Promise<string> {
  const stored = await query<{ doc_epoch: string }>(
    'SELECT doc_epoch::text FROM page_collaborative_docs WHERE page_id = $1', [pageId],
  );
  if (!stored.rows[0]) throw new Error('the page has no persisted collaborative document');
  return stored.rows[0].doc_epoch;
}

async function bodyHtml(pageId: number): Promise<string> {
  const page = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId]);
  return page.rows[0]!.body_html;
}

async function admissionCounts(pageId: number): Promise<{ total: number; unreleased: number }> {
  const counted = await query<{ total: string; unreleased: string }>(
    `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE released_at IS NULL)::text AS unreleased
       FROM page_runtime_admissions WHERE page_id = $1`,
    [pageId],
  );
  return { total: Number(counted.rows[0]!.total), unreleased: Number(counted.rows[0]!.unreleased) };
}

/**
 * What a committed non-collab body write or inbound publication leaves behind:
 * the body replaced and the page's collaborative row gone. `reseed` also puts a
 * row of a new lineage in its place, as another pod's next writable join does.
 */
async function endLineage(pageId: number, html: string, reseed = false): Promise<void> {
  await query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
  await query('UPDATE pages SET body_html = $2, body_text = $2 WHERE id = $1', [pageId, html]);
  if (!reseed) return;
  const doc = new Y.Doc();
  try {
    doc.getText('probe').insert(0, 'NEW_LINEAGE_BYTES');
    await query(
      'INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, $2)',
      [pageId, Buffer.from(Y.encodeStateAsUpdate(doc))],
    );
  } finally {
    doc.destroy();
  }
}

/** Real timer: the empty-room grace drop is the eviction under test. */
async function waitPastGrace(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, COLLAB_EMPTY_ROOM_GRACE_MS + 250);
  await promise;
}

async function observeChannel(pageId: number) {
  const subscriber = main!.duplicate() as RedisClientType;
  const messages: Array<Record<string, unknown>> = [];
  const listeners: Array<(message: Record<string, unknown>) => void> = [];
  subscriber.on('error', () => { /* assertions surface transport failures */ });
  await subscriber.connect();
  await subscriber.subscribe(collabDocChannel(pageId), (raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    messages.push(message);
    for (const listener of listeners) listener(message);
  });
  return {
    messages,
    onMessage: (listener: (message: Record<string, unknown>) => void) => { listeners.push(listener); },
    close: () => subscriber.quit(),
  };
}

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  main = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType;
  main.on('error', () => { /* assertions surface failures */ });
  await main.connect();
  setRedisClient(main);
}, 15_000);

afterAll(async () => {
  if (!canRun) return;
  await runtimeA?.close();
  await runtimeB?.close();
  await main?.quit();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun || !main) return;
  await runtimeA?.close();
  await runtimeB?.close();
  if (usedPageIds.length > 0) {
    await main.del(usedPageIds.map((id) => `collab:active:${id}`));
    usedPageIds.length = 0;
  }
  await truncateAllTables();
  await withPageWriteTransaction([], async () => undefined);
  await query(
    `INSERT INTO users (id, username, email, password_hash, role)
     VALUES ($1, 'epoch-a', 'epoch-a@test', 'x', 'user'), ($2, 'epoch-b', 'epoch-b@test', 'x', 'user')`,
    [USER_A, USER_B],
  );
  const pages = await query<{ id: number }>(
    `INSERT INTO pages (title, body_html, body_text, source, visibility, created_by_user_id)
     SELECT 'Epoch ' || n, '<p>seed</p>', 'seed', 'standalone', 'shared', $1
       FROM generate_series(1, 8) AS n
     RETURNING id`,
    [USER_A],
  );
  pageIds = pages.rows.map((row) => row.id);
  runtimeA = await createCollabRuntime(main, 'epoch-pod-a');
  runtimeB = await createCollabRuntime(main, 'epoch-pod-b');
});

describe.skipIf(!canRun)('document epoch stability (#2034)', () => {
  it('the seed takes the row epoch, and eviction, reload, another runtime and the room\'s own persists keep it', async () => {
    const pageId = nextPageId();
    const first = await join(runtimeA!, pageId, 'first');
    const epoch = await rowEpoch(pageId);
    const room = runtimeA!.getRoom(pageId)!;
    expect(room.docEpoch).toBe(epoch);
    expect(first.attached.writable).toBe(true);

    // The room's own persist.
    appendParagraph(room.doc, 'OWN_EDIT');
    await persist.flushCollabPersist(room);
    expect(await storedDoc(pageId)).toMatchObject([{ doc_epoch: epoch, version: 2 }]);

    // Eviction after the grace period, then a reload from BYTEA.
    await runtimeA!.detachSocket(pageId, 'first');
    await waitPastGrace();
    await vi.waitFor(() => expect(runtimeA!.getRoom(pageId)).toBeUndefined());
    const rejoined = await join(runtimeA!, pageId, 'rejoined');
    expect(runtimeA!.getRoom(pageId)!.docEpoch).toBe(epoch);
    expect(rejoined.attached.writable).toBe(true);

    // A read-only load and a writable join by other runtimes.
    expect((await runtimeB!.getOrCreateRoom(pageId)).docEpoch).toBe(epoch);
    const runtimeC = await createCollabRuntime(main!, 'epoch-pod-c');
    try {
      const third = await join(runtimeC, pageId, 'third', { userId: USER_B });
      expect(third.attached.writable).toBe(true);
      expect(runtimeC.getRoom(pageId)!.docEpoch).toBe(epoch);
    } finally {
      await runtimeC.close();
    }
    expect(await storedDoc(pageId)).toMatchObject([{ doc_epoch: epoch }]);
  });

  it('a room first loaded read-only keeps its epoch when a writable join upgrades it', async () => {
    const pageId = nextPageId();
    // With a persisted document: the reader's room is loaded from the row.
    await join(runtimeB!, pageId, 'seeder');
    const epoch = await rowEpoch(pageId);
    const reader = await join(runtimeA!, pageId, 'reader', { writable: false });
    const room = runtimeA!.getRoom(pageId)!;
    expect(room.admission).toBeNull();
    expect(room.docEpoch).toBe(epoch);
    expect(controlTypes(reader.socket)).toContain('doc_epoch');

    const writer = await join(runtimeA!, pageId, 'writer');
    expect(writer.attached.writable).toBe(true);
    expect(runtimeA!.getRoom(pageId)).toBe(room);
    expect(room.docEpoch).toBe(epoch);
    expect(await rowEpoch(pageId)).toBe(epoch);
    expect(reader.socket.closes).toEqual([]);
  });

  it('a provisional room has no epoch and names none; the writable join that seeds it takes the new row\'s', async () => {
    const pageId = nextPageId();
    const reader = await join(runtimeA!, pageId, 'reader', { writable: false });
    const room = runtimeA!.getRoom(pageId)!;
    expect(room.hasPersistedDoc).toBe(false);
    expect(room.docEpoch).toBeNull();
    expect(controlTypes(reader.socket)).not.toContain('doc_epoch');
    expect(await storedDoc(pageId)).toEqual([]);

    const writer = await join(runtimeA!, pageId, 'writer');
    const epoch = await rowEpoch(pageId);
    expect(room.docEpoch).toBe(epoch);
    expect(controls(writer.socket)).toContainEqual({ type: 'doc_epoch', epoch });
    // The reader held the provisional HTML document, which is not this lineage.
    expect(reader.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
  });

  it('a seed after the row was deleted is a new lineage with a new epoch', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'first');
    const firstEpoch = await rowEpoch(pageId);
    await runtimeA!.detachSocket(pageId, 'first');
    await waitPastGrace();

    await endLineage(pageId, '<p>replaced body</p>');
    const second = await join(runtimeA!, pageId, 'second');
    const secondEpoch = await rowEpoch(pageId);
    expect(second.attached.writable).toBe(true);
    expect(secondEpoch).not.toBe(firstEpoch);
    expect(runtimeA!.getRoom(pageId)!.docEpoch).toBe(secondEpoch);
    expect(yDocToHtml(runtimeA!.getRoom(pageId)!.doc)).toBe('<p>replaced body</p>');
  });
});

describe.skipIf(!canRun)('document epoch on join (#2034)', () => {
  it('a fresh first join is admitted as before, unverified, and is told the epoch before the lifecycle and admission controls', async () => {
    const pageId = nextPageId();
    const { socket, attached } = await join(runtimeA!, pageId, 'first', { expectedLifecycleRevision: '0' });
    const epoch = await rowEpoch(pageId);
    expect(attached).toMatchObject({ writable: true, lineageVerified: false });
    expect(attached.joinRefused).toBeUndefined();
    expect(controls(socket)).toEqual([
      { type: 'doc_epoch', epoch },
      expect.objectContaining({ type: 'page_lifecycle', lifecycleRevision: '0' }),
      { type: 'writable_admission', lifecycleRevision: '0' },
    ]);
    expect(socket.closes).toEqual([]);
  });

  it('an undeclared rejoin of a synced document is admitted as before and stays unverified', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'first');
    // A bundle that predates the epoch declares nothing, also on its rejoin.
    const rejoin = await join(runtimeA!, pageId, 'rejoin');
    expect(rejoin.attached).toMatchObject({ writable: true, lineageVerified: false });
    expect(controlTypes(rejoin.socket)).not.toContain('doc_reset');
    expect(rejoin.socket.closes).toEqual([]);
  });

  it('a rejoin that declares the unchanged epoch is admitted and verified, live and after eviction and reload', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'first');
    const epoch = await rowEpoch(pageId);
    const room = runtimeA!.getRoom(pageId)!;
    appendParagraph(room.doc, 'PERSISTED_BETWEEN');
    await persist.flushCollabPersist(room);

    const live = await join(runtimeA!, pageId, 'live', { expectedDocEpoch: { kind: 'declared', epoch } });
    expect(live.attached).toMatchObject({ writable: true, lineageVerified: true });
    expect(controlTypes(live.socket)).not.toContain('doc_reset');

    await runtimeA!.detachSocket(pageId, 'first');
    await runtimeA!.detachSocket(pageId, 'live');
    await waitPastGrace();
    await vi.waitFor(() => expect(runtimeA!.getRoom(pageId)).toBeUndefined());
    const reloaded = await join(runtimeA!, pageId, 'reloaded', { expectedDocEpoch: { kind: 'declared', epoch } });
    expect(reloaded.attached).toMatchObject({ writable: true, lineageVerified: true });
    expect(controlTypes(reloaded.socket)).toEqual(['doc_epoch', 'page_lifecycle', 'writable_admission']);
    expect(reloaded.socket.closes).toEqual([]);
  });

  it.each(['deleted', 'replaced'] as const)(
    'a join that declares the epoch of a %s row gets doc_reset and 1001 doc_reset, is not attached and takes no admission',
    async (fate) => {
      const pageId = nextPageId();
      await join(runtimeA!, pageId, 'first');
      const staleEpoch = await rowEpoch(pageId);
      await runtimeA!.detachSocket(pageId, 'first');
      await waitPastGrace();
      await endLineage(pageId, '<p>replaced body</p>', fate === 'replaced');
      const before = { admissions: await admissionCounts(pageId), stored: await storedDoc(pageId) };

      const stale = await join(runtimeA!, pageId, 'stale', {
        expectedDocEpoch: { kind: 'declared', epoch: staleEpoch },
      });

      expect(stale.attached).toMatchObject({ writable: false, lineageVerified: false, joinRefused: 'doc_reset' });
      expect(controls(stale.socket)).toEqual([{ type: 'doc_reset' }]);
      expect(stale.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
      expect(runtimeA!.getRoom(pageId)?.sockets.has('stale') ?? false).toBe(false);
      // No admission and no row were created for that join; nothing was written.
      expect(await admissionCounts(pageId)).toEqual(before.admissions);
      expect(await storedDoc(pageId)).toEqual(before.stored);
      expect(await bodyHtml(pageId)).toBe('<p>replaced body</p>');
    },
  );

  it('a malformed declaration is a mismatch, never absent: refused with no admission and no write', async () => {
    const pageId = nextPageId();
    // Without a row: an absent declaration would seed the document here.
    const fresh = await join(runtimeA!, pageId, 'malformed-fresh', { expectedDocEpoch: { kind: 'malformed' } });
    expect(fresh.attached).toMatchObject({ writable: false, joinRefused: 'doc_reset' });
    expect(controls(fresh.socket)).toEqual([{ type: 'doc_reset' }]);
    expect(fresh.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    expect(await storedDoc(pageId)).toEqual([]);
    expect(await admissionCounts(pageId)).toEqual({ total: 0, unreleased: 0 });

    // Against an existing row, with a writer already in the room.
    const writer = await join(runtimeA!, pageId, 'writer');
    const before = { admissions: await admissionCounts(pageId), stored: await storedDoc(pageId) };
    const malformed = await join(runtimeA!, pageId, 'malformed', { expectedDocEpoch: { kind: 'malformed' } });
    expect(malformed.attached).toMatchObject({ writable: false, joinRefused: 'doc_reset' });
    expect(malformed.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    expect(await admissionCounts(pageId)).toEqual(before.admissions);
    expect(await storedDoc(pageId)).toEqual(before.stored);
    expect(writer.socket.closes).toEqual([]);
  });

  it('a join that would not be writable keeps its outcome and gets no epoch decision', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'writer', { expectedLifecycleRevision: '0' });

    const viewer = await join(runtimeA!, pageId, 'viewer', {
      writable: false, expectedDocEpoch: { kind: 'malformed' },
    });
    expect(viewer.attached).toMatchObject({ writable: false, lineageVerified: false });
    expect(viewer.attached.joinRefused).toBeUndefined();
    expect(controlTypes(viewer.socket)).toEqual(['doc_epoch', 'page_lifecycle', 'permission_loss']);
    expect(viewer.socket.closes).toEqual([]);

    const staleLifecycle = await join(runtimeA!, pageId, 'stale-lifecycle', {
      expectedLifecycleRevision: '41', expectedDocEpoch: { kind: 'declared', epoch: OTHER_EPOCH },
    });
    expect(staleLifecycle.attached.joinRefused).toBeUndefined();
    expect(staleLifecycle.attached.writableRefusalReason).toBe('lifecycle_revision_stale');
    expect(controlTypes(staleLifecycle.socket)).toEqual(['doc_epoch', 'page_lifecycle', 'writable_refused']);
    expect(staleLifecycle.socket.closes).toEqual([]);
    expect(runtimeA!.getRoom(pageId)!.sockets.has('stale-lifecycle')).toBe(true);
  });

  it('repeated refused joins reset no valid peer and take nothing from the room', async () => {
    const pageId = nextPageId();
    const writer = await join(runtimeA!, pageId, 'writer');
    const reader = await join(runtimeA!, pageId, 'reader', { writable: false });
    const room = runtimeA!.getRoom(pageId)!;
    const admission = room.admission;
    const frames = { writer: writer.socket.frames.length, reader: reader.socket.frames.length };

    for (const attempt of [1, 2, 3]) {
      const refused = await join(runtimeA!, pageId, `refused-${attempt}`, {
        expectedDocEpoch: { kind: 'declared', epoch: OTHER_EPOCH },
      });
      expect(refused.attached.joinRefused).toBe('doc_reset');
    }

    expect(runtimeA!.getRoom(pageId)).toBe(room);
    expect(room.admission).toBe(admission);
    expect([...room.sockets.keys()]).toEqual(['writer', 'reader']);
    expect(room.sockets.get('writer')!.writable).toBe(true);
    expect(writer.socket.closes).toEqual([]);
    expect(reader.socket.closes).toEqual([]);
    expect(writer.socket.frames).toHaveLength(frames.writer);
    expect(reader.socket.frames).toHaveLength(frames.reader);
    expect(await admissionCounts(pageId)).toEqual({ total: 1, unreleased: 1 });
  });

  it('repeated refused joins do not keep an empty room from being evicted', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'writer');
    await runtimeA!.detachSocket(pageId, 'writer');
    // The room is empty, its admission released, its grace timer running.
    expect(runtimeA!.getRoom(pageId)!.emptyGrace).not.toBeNull();
    await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();

    for (const attempt of [1, 2, 3]) {
      const refused = await join(runtimeA!, pageId, `refused-${attempt}`, {
        expectedDocEpoch: { kind: 'declared', epoch: OTHER_EPOCH },
      });
      expect(refused.attached.joinRefused).toBe('doc_reset');
      // No refused join leaves a heap without a socket and without a timer.
      const left = runtimeA!.getRoom(pageId);
      expect(left === undefined || left.emptyGrace !== null).toBe(true);
    }
    await waitPastGrace();
    await vi.waitFor(() => expect(runtimeA!.getRoom(pageId)).toBeUndefined());
    expect(await admissionCounts(pageId)).toEqual({ total: 1, unreleased: 0 });
  });
});

describe.skipIf(!canRun)('document epoch at the room boundaries (#2034)', () => {
  it('a room whose row is gone cannot persist, leaves body_html untouched and is retired', async () => {
    const pageId = nextPageId();
    const writer = await join(runtimeA!, pageId, 'writer');
    const reader = await join(runtimeA!, pageId, 'reader', { writable: false });
    const room = runtimeA!.getRoom(pageId)!;
    appendParagraph(room.doc, 'SUPERSEDED_ROOM_EDIT');
    await endLineage(pageId, '<p>published body</p>');

    await expect(persist.flushCollabPersist(room)).rejects.toMatchObject({ reason: 'collab_lineage_changed' });

    expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
    expect(await storedDoc(pageId)).toEqual([]);
    await vi.waitFor(() => expect(runtimeA!.getRoom(pageId)).toBeUndefined());
    // Every socket of the retired room keeps its document as a draft.
    for (const socket of [writer.socket, reader.socket]) {
      expect(controls(socket).at(-1)).toEqual({ type: 'doc_reset' });
      expect(socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    }
    // The admission is released without a flush.
    await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    expect(await admissionCounts(pageId)).toEqual({ total: 1, unreleased: 0 });
    expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
  });

  it('the last writer leaving a superseded room retires it instead of flushing over the published body', async () => {
    const pageId = nextPageId();
    const writer = await join(runtimeA!, pageId, 'writer');
    appendParagraph(runtimeA!.getRoom(pageId)!.doc, 'SUPERSEDED_ROOM_EDIT');
    await endLineage(pageId, '<p>published body</p>', true);
    const replacement = await storedDoc(pageId);

    await runtimeA!.detachSocket(pageId, 'writer');

    expect(runtimeA!.getRoom(pageId)).toBeUndefined();
    expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
    expect(await storedDoc(pageId)).toEqual(replacement);
    expect(await admissionCounts(pageId)).toEqual({ total: 1, unreleased: 0 });
    expect(writer.socket.closes).toEqual([]);
  });

  it.each(['undeclared', 'current epoch', 'superseded epoch'] as const)(
    'a join (%s) into a superseded room that still holds its admission retires that room and is decided on a fresh one',
    async (declares) => {
      const pageId = nextPageId();
      const idle = await join(runtimeA!, pageId, 'idle-writer');
      const superseded = runtimeA!.getRoom(pageId)!;
      const supersededEpoch = await rowEpoch(pageId);
      appendParagraph(superseded.doc, 'OLD_GENERATION_EDIT');
      await endLineage(pageId, '<p>published body</p>', true);
      const currentEpoch = await rowEpoch(pageId);

      const joined = await join(runtimeA!, pageId, 'joiner', declares === 'undeclared' ? {} : {
        expectedDocEpoch: {
          kind: 'declared', epoch: declares === 'current epoch' ? currentEpoch : supersededEpoch,
        },
      });

      // The row, re-read under the lifecycle lock inside the join, retired the room.
      expect(runtimeA!.getRoom(pageId)).not.toBe(superseded);
      expect(idle.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
      if (declares === 'superseded epoch') {
        // The fresh room answers the tab of the old generation.
        expect(joined.attached.joinRefused).toBe('doc_reset');
        expect(joined.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
        expect(runtimeA!.getRoom(pageId)).toBeUndefined();
        expect(await admissionCounts(pageId)).toEqual({ total: 1, unreleased: 0 });
        return;
      }
      // A tab of the current generation is not told its document changed.
      expect(joined.attached.joinRefused).toBeUndefined();
      expect(joined.attached).toMatchObject({ writable: true, lineageVerified: declares === 'current epoch' });
      expect(joined.socket.closes).toEqual([]);
      const fresh = runtimeA!.getRoom(pageId)!;
      expect(fresh.docEpoch).toBe(currentEpoch);
      expect(probeOf(fresh.doc)).toBe('NEW_LINEAGE_BYTES');
      expect(yDocToHtml(fresh.doc)).not.toContain('OLD_GENERATION_EDIT');
      expect(await admissionCounts(pageId)).toEqual({ total: 2, unreleased: 1 });
    },
  );

  it('a refused stale tab also retires the stale heap its join found, so its readers do not keep the old document', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'earlier-writer');
    const supersededEpoch = await rowEpoch(pageId);
    const reader = await join(runtimeA!, pageId, 'reader', { writable: false });
    await runtimeA!.detachSocket(pageId, 'earlier-writer');
    expect(runtimeA!.getRoom(pageId)!.admission).toBeNull();
    await endLineage(pageId, '<p>published body</p>');

    const stale = await join(runtimeA!, pageId, 'stale-tab', {
      expectedDocEpoch: { kind: 'declared', epoch: supersededEpoch },
    });

    expect(stale.attached.joinRefused).toBe('doc_reset');
    expect(reader.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    expect(runtimeA!.getRoom(pageId)).toBeUndefined();
    expect(await storedDoc(pageId)).toEqual([]);
    expect(await admissionCounts(pageId)).toEqual({ total: 1, unreleased: 0 });
  });

  it('a superseded room cannot merge: a commit snapshot is refused and the room is retired', async () => {
    const pageId = nextPageId();
    const writer = await join(runtimeA!, pageId, 'writer');
    const room = runtimeA!.getRoom(pageId)!;
    appendParagraph(room.doc, 'SUPERSEDED_ROOM_EDIT');
    await endLineage(pageId, '<p>published body</p>', true);

    await expect(runtimeA!.prepareCommitSnapshot(pageId, USER_A, '0'))
      .rejects.toMatchObject({ reason: 'collab_lineage_changed', statusCode: 409 });

    // No byte of the replacement was merged into the old document.
    expect(runtimeA!.getRoom(pageId)).toBeUndefined();
    expect(writer.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    expect(await admissionCounts(pageId)).toEqual({ total: 2, unreleased: 0 });
    expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
  });

  it('a superseded room applies no client frame and is retired with doc_reset', async () => {
    const pageId = nextPageId();
    const writer = await join(runtimeA!, pageId, 'writer');
    const room = runtimeA!.getRoom(pageId)!;
    expect(await runtimeA!.handleInboundFrame(pageId, 'writer', syncUpdateFrame(probeUpdate('ACCEPTED')))).toBe('ok');
    expect(probeOf(room.doc)).toBe('ACCEPTED');
    await endLineage(pageId, '<p>published body</p>', true);

    const before = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    expect(await runtimeA!.handleInboundFrame(pageId, 'writer', syncUpdateFrame(probeUpdate('REFUSED')))).toBe('dropped');
    expect(Buffer.from(Y.encodeStateAsUpdate(room.doc)).equals(before)).toBe(true);
    // Later frames are dropped without a read-only violation while the retirement is queued.
    expect(await runtimeA!.handleInboundFrame(pageId, 'writer', syncUpdateFrame(probeUpdate('ALSO_REFUSED')))).toBe('dropped');

    await vi.waitFor(() => expect(runtimeA!.getRoom(pageId)).toBeUndefined());
    expect(controls(writer.socket).at(-1)).toEqual({ type: 'doc_reset' });
    expect(writer.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
  });

  it('two runtimes that hold the same superseded epoch exchange nothing: no peer update is applied and no dump is answered', async () => {
    const pageId = nextPageId();
    const a = await join(runtimeA!, pageId, 'a');
    const b = await join(runtimeB!, pageId, 'b', { userId: USER_B });
    const roomA = runtimeA!.getRoom(pageId)!;
    const roomB = runtimeB!.getRoom(pageId)!;
    const sharedEpoch = roomA.docEpoch;
    expect(roomB.docEpoch).toBe(sharedEpoch);
    const admissionA = roomA.admission!;
    const lifecycleRevision = roomA.lifecycleRevision;
    await endLineage(pageId, '<p>published body</p>', true);
    const observed = await observeChannel(pageId);
    try {
      // A peer update that both rooms would take for their own generation.
      await main!.publish(collabDocChannel(pageId), JSON.stringify({
        origin: runtimeA!.podId, kind: 'sync', lifecycleRevision, admission: admissionA, docEpoch: sharedEpoch,
        update: Buffer.from(probeUpdate('PEER_BYTES')).toString('base64'),
      }));
      await vi.waitFor(() => expect(runtimeB!.getRoom(pageId)).toBeUndefined());
      expect(probeOf(roomB.doc)).toBe('');
      expect(b.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);

      // A dump request that names A's admission and A's own (superseded) epoch.
      await main!.publish(collabDocChannel(pageId), JSON.stringify({
        origin: 'epoch-pod-x', kind: 'state_dump_request', requestId: 'superseded-round',
        requestedAdmissions: [admissionA.id], lifecycleRevision, docEpoch: sharedEpoch,
      }));
      await vi.waitFor(() => expect(runtimeA!.getRoom(pageId)).toBeUndefined());
      expect(a.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
      expect(observed.messages.filter((message) => message.kind === 'state_dump')).toEqual([]);
    } finally {
      await observed.close();
    }
    expect(await admissionCounts(pageId)).toEqual({ total: 2, unreleased: 0 });
    expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
  });

  it('a peer message of another generation is only a prompt: a current room takes no byte of it and is not retired', async () => {
    const pageId = nextPageId();
    const writer = await join(runtimeB!, pageId, 'writer');
    const room = runtimeB!.getRoom(pageId)!;
    const foreignOwner = await admitPageRuntime(pageId, USER_B, 'collab_room');
    try {
      const publishSync = (docEpoch: string, text: string) => main!.publish(collabDocChannel(pageId), JSON.stringify({
        origin: 'epoch-pod-x', kind: 'sync', lifecycleRevision: room.lifecycleRevision,
        admission: foreignOwner, docEpoch,
        update: Buffer.from(probeUpdate(text)).toString('base64'),
      }));
      await publishSync(OTHER_EPOCH, 'FOREIGN_GENERATION');
      // Ordered behind it on the same queue: a message of this room's generation is applied.
      await publishSync(room.docEpoch!, 'CURRENT_GENERATION');
      await vi.waitFor(() => expect(probeOf(room.doc)).toContain('CURRENT_GENERATION'));
      expect(probeOf(room.doc)).not.toContain('FOREIGN_GENERATION');
      expect(runtimeB!.getRoom(pageId)).toBe(room);
      expect(writer.socket.closes).toEqual([]);

      // The same prompt retires the room once its own row is really gone.
      await endLineage(pageId, '<p>published body</p>');
      await publishSync(OTHER_EPOCH, 'FOREIGN_AGAIN');
      await vi.waitFor(() => expect(runtimeB!.getRoom(pageId)).toBeUndefined());
      expect(probeOf(room.doc)).not.toContain('FOREIGN_AGAIN');
      expect(writer.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    } finally {
      await releasePageRuntime(foreignOwner);
    }
  });

  it('a provisional room adopts the persisted generation instead of merging peer bytes into its HTML seed', async () => {
    const pageId = nextPageId();
    const reader = await join(runtimeB!, pageId, 'reader', { writable: false });
    const provisional = runtimeB!.getRoom(pageId)!;
    expect(provisional.docEpoch).toBeNull();
    const provisionalDoc = provisional.doc;

    await join(runtimeA!, pageId, 'writer');
    const epoch = await rowEpoch(pageId);
    appendParagraph(runtimeA!.getRoom(pageId)!.doc, 'PEER_EDIT');

    await vi.waitFor(() => expect(yDocToHtml(provisional.doc)).toContain('PEER_EDIT'), { timeout: 4_000 });
    expect(provisional.docEpoch).toBe(epoch);
    expect(provisional.doc).not.toBe(provisionalDoc);
    // Merging the persisted seed into the provisional HTML document would show the body twice.
    expect(occurrences(yDocToHtml(provisional.doc), 'seed')).toBe(1);
    expect(reader.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
  });

  it('a post-Save mark that carries another epoch marks neither the room nor the row', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'writer');
    const room = runtimeA!.getRoom(pageId)!;
    const epoch = await rowEpoch(pageId);
    const carriesIds = (doc: Y.Doc): boolean => doc.getMap('compendiq.meta').get('confluenceTaskIds') === true;
    const request = await admitPageRuntime(pageId, USER_A, 'collab_request');
    try {
      const stored = await storedDoc(pageId);
      await runtimeA!.markWrittenTaskIds(pageId, request, [], OTHER_EPOCH);
      expect(carriesIds(room.doc)).toBe(false);
      expect(await storedDoc(pageId)).toEqual(stored);
      expect(runtimeA!.getRoom(pageId)).toBe(room);

      await runtimeA!.markWrittenTaskIds(pageId, request, [], epoch);
      expect(carriesIds(room.doc)).toBe(true);
    } finally {
      await releasePageRuntime(request);
    }
  });

  it('a peer\'s mark request of another epoch is not applied to an owning room', async () => {
    const pageId = nextPageId();
    await join(runtimeB!, pageId, 'writer');
    const room = runtimeB!.getRoom(pageId)!;
    const carriesIds = (): boolean => room.doc.getMap('compendiq.meta').get('confluenceTaskIds') === true;
    const publishMark = (docEpoch: string) => main!.publish(collabDocChannel(pageId), JSON.stringify({
      origin: 'epoch-pod-x', kind: 'task_ids', lifecycleRevision: room.lifecycleRevision, taskIds: [], docEpoch,
    }));
    await publishMark(OTHER_EPOCH);
    await busHandled(room);
    expect(carriesIds()).toBe(false);
    expect(runtimeB!.getRoom(pageId)).toBe(room);

    await publishMark(room.docEpoch!);
    await busHandled(room);
    expect(carriesIds()).toBe(true);
  });
});

/** Resolves once `room` has handled every bus message published before this call. */
async function busHandled(room: CollabRoom): Promise<void> {
  const version = room.pagesVersion + 1;
  await main!.publish(collabDocChannel(room.pageId), JSON.stringify({
    origin: 'epoch-pod-x', kind: 'control',
    update: Buffer.from(JSON.stringify({ type: 'pages_version', version }), 'utf8').toString('base64'),
  }));
  await vi.waitFor(() => expect(room.pagesVersion).toBe(version), { timeout: 4_000 });
}

describe.skipIf(!canRun)('document epoch join races (#2034)', () => {
  /** Hold the page lifecycle lock, as a publication transaction does, with the row deleted but not committed. */
  async function holdLifecycleWithRowDeleted(pageId: number) {
    const holder = await getPool().connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [PAGE_LIFECYCLE_LOCK_KEY, pageId]);
    await holder.query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
    await holder.query(`UPDATE pages SET body_html = '<p>published body</p>', body_text = 'published body' WHERE id = $1`, [pageId]);
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return {
      /** Resolves once another backend of this database waits for the holder. */
      blocked: () => vi.waitFor(async () => {
        const waiting = await query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
           ) AS blocked`, [pid],
        );
        expect(waiting.rows[0]!.blocked).toBe(true);
      }, { timeout: 10_000 }),
      commit: () => holder.query('COMMIT'),
      release: async () => {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      },
    };
  }

  it('a lineage that changes between the pre-check and the admission leaves no admission behind', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'first');
    const epoch = await rowEpoch(pageId);
    await runtimeA!.detachSocket(pageId, 'first');
    await waitPastGrace();
    await vi.waitFor(() => expect(runtimeA!.getRoom(pageId)).toBeUndefined());
    const before = await admissionCounts(pageId);

    const barrier = await holdLifecycleWithRowDeleted(pageId);
    let joining: Promise<{ socket: RecordedSocket; attached: CollabSocket }> | undefined;
    try {
      // The delete is not committed: the unlocked pre-check still reads the declared epoch.
      joining = join(runtimeA!, pageId, 'racing', { expectedDocEpoch: { kind: 'declared', epoch } });
      await barrier.blocked();
      await barrier.commit();
      const racing = await joining;

      expect(racing.attached).toMatchObject({ writable: false, joinRefused: 'doc_reset' });
      expect(controls(racing.socket)).toEqual([{ type: 'doc_reset' }]);
      expect(racing.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
      // The admission transaction rolled back: no row of it exists, released or not.
      expect(await admissionCounts(pageId)).toEqual(before);
      expect(await storedDoc(pageId)).toEqual([]);
      expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
    } finally {
      await barrier.release();
      await joining?.catch(() => undefined);
    }
  });

  it('an undeclared join that loses the same race retires its stale heap and is admitted into a fresh document', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'first');
    const firstEpoch = await rowEpoch(pageId);
    const reader = await join(runtimeA!, pageId, 'reader', { writable: false });
    await runtimeA!.detachSocket(pageId, 'first');
    const staleRoom = runtimeA!.getRoom(pageId)!;
    expect(staleRoom.admission).toBeNull();

    const barrier = await holdLifecycleWithRowDeleted(pageId);
    let joining: Promise<{ socket: RecordedSocket; attached: CollabSocket }> | undefined;
    try {
      joining = join(runtimeA!, pageId, 'racing');
      await barrier.blocked();
      await barrier.commit();
      const racing = await joining;

      expect(racing.attached).toMatchObject({ writable: true, lineageVerified: false });
      const freshRoom = runtimeA!.getRoom(pageId)!;
      expect(freshRoom).not.toBe(staleRoom);
      expect(freshRoom.docEpoch).toBe(await rowEpoch(pageId));
      expect(freshRoom.docEpoch).not.toBe(firstEpoch);
      // Nothing of the old document was merged into the new one.
      expect(yDocToHtml(freshRoom.doc)).toBe('<p>published body</p>');
      expect(reader.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
      expect(await admissionCounts(pageId)).toMatchObject({ unreleased: 1 });
    } finally {
      await barrier.release();
      await joining?.catch(() => undefined);
    }
  });

  it('a read-only room retained across a delete and a reseed is retired by the next writable join; nothing foreign is merged', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'first');
    const firstEpoch = await rowEpoch(pageId);
    const reader = await join(runtimeA!, pageId, 'reader', { writable: false });
    await runtimeA!.detachSocket(pageId, 'first');
    const staleRoom = runtimeA!.getRoom(pageId)!;
    expect(staleRoom.docEpoch).toBe(firstEpoch);
    // No admission is live: a non-collab body write deletes the row, and
    // another pod's writable join seeds the next generation.
    await endLineage(pageId, '<p>next generation</p>');
    await join(runtimeB!, pageId, 'reseeder', { userId: USER_B });
    const secondEpoch = await rowEpoch(pageId);
    expect(secondEpoch).not.toBe(firstEpoch);

    const writer = await join(runtimeA!, pageId, 'writer');

    expect(writer.attached.writable).toBe(true);
    const freshRoom = runtimeA!.getRoom(pageId)!;
    expect(freshRoom).not.toBe(staleRoom);
    expect(freshRoom.docEpoch).toBe(secondEpoch);
    expect(yDocToHtml(freshRoom.doc)).toBe('<p>next generation</p>');
    expect(yDocToHtml(runtimeB!.getRoom(pageId)!.doc)).toBe('<p>next generation</p>');
    expect(controls(reader.socket).at(-1)).toEqual({ type: 'doc_reset' });
    expect(reader.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    await persist.flushCollabPersist(freshRoom);
    expect(await bodyHtml(pageId)).toBe('<p>next generation</p>');
  });

  it.each(['deleted', 'reseeded'] as const)(
    'a declared join whose provisional room loads a %s row after its admission committed is refused and keeps no admission',
    async (fate) => {
      const pageId = nextPageId();
      // Pod A holds a provisional heap for a reader; the document is seeded on pod B.
      const reader = await join(runtimeA!, pageId, 'reader', { writable: false });
      const provisional = runtimeA!.getRoom(pageId)!;
      await join(runtimeB!, pageId, 'seeder', { userId: USER_B });
      const declared = await rowEpoch(pageId);
      await runtimeB!.detachSocket(pageId, 'seeder');
      await runtimeB!.dropRoom(pageId);
      expect(provisional.docEpoch).toBeNull();
      expect(await admissionCounts(pageId)).toEqual({ total: 1, unreleased: 0 });

      // The provisional room loads its document in a transaction after the
      // admission's. Hold that load on the collab-init lock.
      const holder = await getPool().connect();
      let joining: Promise<{ socket: RecordedSocket; attached: CollabSocket }> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);
        joining = join(runtimeA!, pageId, 'declared-tab', { expectedDocEpoch: { kind: 'declared', epoch: declared } });
        await vi.waitFor(async () => {
          const waiting = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM pg_locks
              WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 2 AND NOT granted
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
            [COLLAB_INIT_LOCK_KEY, pageId],
          );
          expect(waiting.rows[0]!.count).toBe('1');
        }, { timeout: 10_000 });
        // The declaration matched the row inside the admission transaction, which committed.
        expect(await admissionCounts(pageId)).toEqual({ total: 2, unreleased: 1 });

        // A publication, or another pod's seed after it, commits in that gap.
        await endLineage(pageId, '<p>published body</p>', fate === 'reseeded');
        const replacement = await storedDoc(pageId);
        await holder.query('ROLLBACK');
        const refused = await joining;

        expect(refused.attached).toMatchObject({ writable: false, lineageVerified: false, joinRefused: 'doc_reset' });
        expect(controls(refused.socket)).toEqual([{ type: 'doc_reset' }]);
        expect(refused.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
        expect(runtimeA!.getRoom(pageId)?.sockets.has('declared-tab') ?? false).toBe(false);
        // The admission this join acquired is released, not left behind.
        expect(await admissionCounts(pageId)).toEqual({ total: 2, unreleased: 0 });
        await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
        // The document the room ended up with is not the declared one.
        const stored = await storedDoc(pageId);
        expect(stored).toHaveLength(1);
        expect(stored[0]!.doc_epoch).not.toBe(declared);
        if (fate === 'reseeded') expect(stored).toEqual(replacement);
        expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
        // The reader held the provisional HTML document.
        expect(reader.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        await joining?.catch(() => undefined);
      }
    },
  );
});

describe.skipIf(!canRun)('owner convergence without the retire hint (#2034)', () => {
  it('an idle superseded owner retires on the new generation\'s dump request, and that join becomes writable', async () => {
    const pageId = nextPageId();
    const idle = await join(runtimeA!, pageId, 'idle-writer');
    const superseded = runtimeA!.getRoom(pageId)!;
    appendParagraph(superseded.doc, 'OLD_GENERATION_EDIT');
    const firstEpoch = superseded.docEpoch;
    // The publication committed; its hint never reached pod A, whose writer stays idle.
    await endLineage(pageId, '<p>published body</p>');
    const observed = await observeChannel(pageId);
    try {
      const fresh = await join(runtimeB!, pageId, 'fresh', { userId: USER_B });

      expect(fresh.attached.writable).toBe(true);
      const current = runtimeB!.getRoom(pageId)!;
      expect(current.docEpoch).toBe(await rowEpoch(pageId));
      expect(current.docEpoch).not.toBe(firstEpoch);
      // No byte of the old generation reached the new document.
      expect(yDocToHtml(current.doc)).toBe('<p>published body</p>');
      // Pod A needed neither an edit nor a disconnect: the request retired it.
      expect(runtimeA!.getRoom(pageId)).toBeUndefined();
      expect(controls(idle.socket).at(-1)).toEqual({ type: 'doc_reset' });
      expect(idle.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
      expect(observed.messages.filter((message) => message.kind === 'state_dump')).toEqual([]);
      // The round that named the superseded owner expired; the retry had no peer to ask.
      const requests = observed.messages.filter((message) => message.kind === 'state_dump_request');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ docEpoch: current.docEpoch });
      expect(await admissionCounts(pageId)).toEqual({ total: 2, unreleased: 1 });

      await persist.flushCollabPersist(current);
      expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
    } finally {
      await observed.close();
    }
  }, 20_000);

  it('a current owner that stays silent still fails the join closed: the changed owner set permits a retry, not success', async () => {
    const pageId = nextPageId();
    const idle = await join(runtimeA!, pageId, 'idle-writer');
    await endLineage(pageId, '<p>published body</p>');
    // An owner that cannot be resolved: a durable admission nobody answers for.
    const silentOwner = await admitPageRuntime(pageId, USER_B, 'collab_room');
    const observed = await observeChannel(pageId);
    try {
      observed.onMessage((message) => {
        const requests = observed.messages.filter((entry) => entry.kind === 'state_dump_request');
        if (message.kind !== 'state_dump_request' || requests.length !== 2) return;
        // A late answer to the expired first round, otherwise valid, arrives during the second.
        void main!.publish(collabDocChannel(pageId), JSON.stringify({
          origin: 'epoch-pod-x', kind: 'state_dump', requestId: requests[0]!.requestId,
          lifecycleRevision: silentOwner.lifecycleRevision, admission: silentOwner,
          docEpoch: message.docEpoch,
          update: Buffer.from(probeUpdate('LATE_ANSWER')).toString('base64'),
        }));
      });

      await expect(join(runtimeB!, pageId, 'fresh', { userId: USER_B }))
        .rejects.toMatchObject({ reason: 'collab_state_unavailable' });

      const requests = observed.messages.filter((message) => message.kind === 'state_dump_request');
      expect(requests).toHaveLength(2);
      expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
      // The first round asked both owners; the second, completely new one only the silent owner.
      expect(requests[0]!.requestedAdmissions).toContain(silentOwner.id);
      expect(requests[0]!.requestedAdmissions).toHaveLength(2);
      expect(requests[1]!.requestedAdmissions).toEqual([silentOwner.id]);
      expect(observed.messages.filter((message) => message.kind === 'state_dump')).toHaveLength(1);
      expect(runtimeA!.getRoom(pageId)).toBeUndefined();
      expect(idle.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
      // The failed join kept no admission; the silent owner is still the only one.
      expect(await admissionCounts(pageId)).toMatchObject({ unreleased: 1 });
      const left = runtimeB!.getRoom(pageId);
      expect(left === undefined || !left.sockets.has('fresh')).toBe(true);
    } finally {
      await observed.close();
      await releasePageRuntime(silentOwner);
    }
  }, 30_000);

  it('a delayed message of another generation right ahead of a valid dump neither blocks nor fails the join', async () => {
    const pageId = nextPageId();
    await join(runtimeA!, pageId, 'owner');
    const owner = runtimeA!.getRoom(pageId)!;
    appendParagraph(owner.doc, 'UNFLUSHED_OWNER_EDIT');
    const observed = await observeChannel(pageId);
    try {
      observed.onMessage((message) => {
        if (message.kind !== 'state_dump_request') return;
        // Reaches pod B's queue before pod A's answer, which needs a transaction first.
        void main!.publish(collabDocChannel(pageId), JSON.stringify({
          origin: 'epoch-pod-x', kind: 'sync', lifecycleRevision: owner.lifecycleRevision,
          admission: owner.admission, docEpoch: OTHER_EPOCH,
          update: Buffer.from(probeUpdate('FOREIGN_GENERATION')).toString('base64'),
        }));
      });

      const joined = await join(runtimeB!, pageId, 'joiner', { userId: USER_B });

      expect(joined.attached.writable).toBe(true);
      const room = runtimeB!.getRoom(pageId)!;
      expect(yDocToHtml(room.doc)).toContain('UNFLUSHED_OWNER_EDIT');
      expect(probeOf(room.doc)).toBe('');
      expect(room.docEpoch).toBe(owner.docEpoch);
      expect(observed.messages.filter((message) => message.kind === 'state_dump_request')).toHaveLength(1);
      // The prompt found the row unchanged: both rooms stay. Pod B's own hint
      // joins the revalidation that message started and waits for it.
      await busHandled(room);
      await runtimeB!.hintDocRetired(pageId);
      expect(runtimeB!.getRoom(pageId)).toBe(room);
      expect(runtimeA!.getRoom(pageId)).toBe(owner);
      expect(joined.socket.closes).toEqual([]);
    } finally {
      await observed.close();
    }
  });
});

describe.skipIf(!canRun)('retire hint (#2034)', () => {
  it('a hint alone retires a superseded room on another pod', async () => {
    const pageId = nextPageId();
    const writer = await join(runtimeB!, pageId, 'writer');
    appendParagraph(runtimeB!.getRoom(pageId)!.doc, 'SUPERSEDED_ROOM_EDIT');
    await endLineage(pageId, '<p>published body</p>');

    // Pod A has no room for the page; its hint reaches pod B over Redis only.
    await runtimeA!.hintDocRetired(pageId);

    await vi.waitFor(() => expect(runtimeB!.getRoom(pageId)).toBeUndefined());
    expect(controls(writer.socket).at(-1)).toEqual({ type: 'doc_reset' });
    expect(writer.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    expect(await bodyHtml(pageId)).toBe('<p>published body</p>');
    await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
  });

  it('a hint retires the local superseded room before it returns', async () => {
    const pageId = nextPageId();
    const writer = await join(runtimeA!, pageId, 'writer');
    await endLineage(pageId, '<p>published body</p>');

    await runtimeA!.hintDocRetired(pageId);

    expect(runtimeA!.getRoom(pageId)).toBeUndefined();
    expect(writer.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
  });

  it('a hint that reaches a room whose row is unchanged does nothing and keeps its liveness', async () => {
    const pageId = nextPageId();
    const local = await join(runtimeA!, pageId, 'local');
    const remote = await join(runtimeB!, pageId, 'remote', { userId: USER_B });
    const roomA = runtimeA!.getRoom(pageId)!;
    const roomB = runtimeB!.getRoom(pageId)!;
    appendParagraph(roomB.doc, 'UNFLUSHED_CURRENT_EDIT');
    const live = Number(await main!.sCard(`collab:active:${pageId}`));
    expect(live).toBeGreaterThan(0);

    await runtimeA!.hintDocRetired(pageId);
    // Once pod B has taken both prompts off its queue, its own hint joins the
    // revalidation they started and waits for it.
    await runtimeA!.hintDocRetired(pageId);
    await busHandled(roomB);
    await runtimeB!.hintDocRetired(pageId);

    expect(runtimeA!.getRoom(pageId)).toBe(roomA);
    expect(runtimeB!.getRoom(pageId)).toBe(roomB);
    expect(local.socket.closes).toEqual([]);
    expect(remote.socket.closes).toEqual([]);
    expect(Number(await main!.sCard(`collab:active:${pageId}`))).toBe(live);
    await persist.flushCollabPersist(roomB);
    expect(await bodyHtml(pageId)).toContain('UNFLUSHED_CURRENT_EDIT');
  });

  describe('a hard-deleted page is not a document reset', () => {
    /**
     * A room with a writer, a reader and an unflushed edit on pod B; the page
     * is hard-deleted under the lifecycle fence, as a committed delete does.
     * The `pages` row takes the collaborative row with it. The retire hint of
     * an earlier publication and the delete's own tombstone reach pod B in
     * the given order.
     */
    async function closeDeletedPage(order: 'hint before tombstone' | 'tombstone only') {
      const pageId = nextPageId();
      const writer = await join(runtimeB!, pageId, 'writer', { userId: USER_B });
      const reader = await join(runtimeB!, pageId, 'reader', { writable: false });
      appendParagraph(runtimeB!.getRoom(pageId)!.doc, 'UNFLUSHED_EDIT');
      const observed = await observeChannel(pageId);
      const deleter = await getPool().connect();
      try {
        await deleter.query('BEGIN');
        await deleter.query('SELECT pg_advisory_xact_lock($1, $2)', [PAGE_LIFECYCLE_LOCK_KEY, pageId]);
        await deleter.query('DELETE FROM pages WHERE id = $1', [pageId]);
        if (order === 'hint before tombstone') {
          // The hint is in flight when the delete commits: pod B's
          // revalidation already waits for the fence.
          await runtimeA!.hintDocRetired(pageId);
          await vi.waitFor(async () => {
            const waiting = await query<{ count: string }>(
              `SELECT COUNT(*)::text AS count FROM pg_locks
                WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 2 AND NOT granted
                  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
              [PAGE_LIFECYCLE_LOCK_KEY, pageId],
            );
            expect(waiting.rows[0]!.count).toBe('1');
          }, { timeout: 10_000 });
        }
        await deleter.query('COMMIT');
        if (order === 'hint before tombstone') {
          // The revalidation proves the page absent before any tombstone exists.
          await vi.waitFor(() => expect(runtimeB!.getRoom(pageId)).toBeUndefined());
        }
        const closedBeforeTombstone = [...writer.socket.closes, ...reader.socket.closes];

        // The delete's after-commit tombstone (tombstoneCollabRoomAfterCommit).
        await runtimeA!.tombstone(pageId, 4404, 'committed_delete');
        await vi.waitFor(() => {
          expect(observed.messages).toContainEqual(expect.objectContaining({ kind: 'tombstone', code: 4404 }));
          expect(runtimeB!.getRoom(pageId)).toBeUndefined();
        });
        const admissions = await query<{ released: boolean; release_kind: string | null }>(
          `SELECT released_at IS NOT NULL AS released, release_kind
             FROM page_runtime_admissions WHERE page_id = $1`,
          [pageId],
        );
        return {
          closedBeforeTombstone,
          writer: { closes: writer.socket.closes, controls: controlTypes(writer.socket) },
          reader: { closes: reader.socket.closes, controls: controlTypes(reader.socket) },
          admissions: admissions.rows,
          liveMembers: Number(await main!.sCard(`collab:active:${pageId}`)),
        };
      } finally {
        await deleter.query('ROLLBACK').catch(() => undefined);
        deleter.release();
        await observed.close();
      }
    }

    it('a hint revalidated after the committed delete and before its tombstone closes 4404 committed_delete once; the tombstone is then a no-op', async () => {
      const hinted = await closeDeletedPage('hint before tombstone');

      const committedDelete = [{ code: 4404, reason: 'committed_delete' }];
      // Both sockets were closed by the revalidation, with the permanent reason.
      expect(hinted.closedBeforeTombstone).toEqual([...committedDelete, ...committedDelete]);
      // The tombstone found no room: exactly one close per socket, never `doc_reset`.
      expect(hinted.writer.closes).toEqual(committedDelete);
      expect(hinted.reader.closes).toEqual(committedDelete);
      expect(hinted.writer.controls).not.toContain('doc_reset');
      expect(hinted.reader.controls).not.toContain('doc_reset');
      expect(hinted.liveMembers).toBe(0);

      // One teardown for both orders: the admission ends exactly as the
      // committed-delete tombstone alone leaves it.
      const tombstoned = await closeDeletedPage('tombstone only');
      expect(tombstoned.closedBeforeTombstone).toEqual([]);
      expect(tombstoned.writer.closes).toEqual(committedDelete);
      expect(hinted.admissions).toHaveLength(1);
      expect(hinted.admissions).toEqual(tombstoned.admissions);
    });

    it('a join that finds the room of a hard-deleted page gives that room the committed-delete close, not doc_reset', async () => {
      const pageId = nextPageId();
      const idle = await join(runtimeA!, pageId, 'idle-writer');
      const reader = await join(runtimeA!, pageId, 'reader', { writable: false });
      await query('DELETE FROM pages WHERE id = $1', [pageId]);

      // The page is gone: the join fails as any join to a missing page does.
      await expect(join(runtimeA!, pageId, 'late-join')).rejects.toThrow('Collaborative page is missing');

      for (const socket of [idle.socket, reader.socket]) {
        expect(socket.closes).toEqual([{ code: 4404, reason: 'committed_delete' }]);
        expect(controlTypes(socket)).not.toContain('doc_reset');
      }
      expect(runtimeA!.getRoom(pageId)).toBeUndefined();
    });
  });
});
