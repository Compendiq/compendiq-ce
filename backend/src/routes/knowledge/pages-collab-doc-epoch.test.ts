/**
 * #2034 — GET /api/collab/:pageId with a document epoch.
 *
 * A tab that was away past the empty-room grace rejoins with the same Y.Doc.
 * If a non-collab body write replaced the page meanwhile, the gateway must
 * answer `doc_reset` / `1001 doc_reset` before any writable admission instead
 * of letting the tab merge the rebuilt document into its old one.
 *
 * Real PostgreSQL, Redis and gateway. The tab is a real y-websocket 3.1
 * `WebsocketProvider`; the few lines around it repeat what
 * `use-collab-provider.ts` does with the `doc_epoch` control (pin at the first
 * sync, declare on later joins, never reconnect a reset document) and with
 * the empty-document marker (sent by an unpinned document that holds nothing).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, onTestFinished, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { WebsocketProvider } from 'y-websocket';
import { COLLAB_DOC_EMPTY_MARKER, COLLAB_WS_PROTOCOL, CollabDocEpochControlSchema } from '@compendiq/contracts';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { refreshCollabFlag } from '../../core/services/collab-flag.js';
import {
  _resetCollabRoomsForTest,
  getDefaultCollabRuntime,
  type CollabRoom,
} from '../../core/services/collab-room-service.js';
import * as persist from '../../core/services/collab-persistence.js';
import { yDocToHtml } from '../../core/services/collab-schema.js';
import { withPageWriteTransaction } from '../../core/services/page-write-admission.js';

const dbAvailable = await isDbAvailable();
const canRun = dbAvailable && await isRedisAvailable();

let app: FastifyInstance;
let baseWs: string;

type Control = Record<string, unknown>;
type CloseRecord = { code: number; reason: string };

async function createUser(username: string): Promise<{ token: string; userId: string }> {
  const created = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'fakehash', 'user') RETURNING id`,
    [username],
  );
  const userId = created.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  return { userId, token: await generateAccessToken({ sub: userId, username, role: 'user' }) };
}

async function insertStandalone(ownerId: string, bodyHtml: string): Promise<number> {
  const inserted = await query<{ id: number }>(
    `INSERT INTO pages (
        space_key, title, body_storage, body_html, body_text, version, source, visibility,
        created_by_user_id, page_type, summary_status, quality_status
     ) VALUES ('_standalone', 'Epoch page', $1, $1, 'x', 1, 'standalone', 'shared', $2, 'page', 'summarized', 'analyzed')
     RETURNING id`,
    [bodyHtml, ownerId],
  );
  return inserted.rows[0]!.id;
}

async function lifecycleRevision(pageId: number): Promise<string> {
  const state = await query<{ lifecycle_revision: string }>(
    'SELECT lifecycle_revision::text FROM pages WHERE id = $1', [pageId],
  );
  return state.rows[0]!.lifecycle_revision;
}

/** Read from the table, not through the code under test. */
async function rowEpoch(pageId: number): Promise<string | null> {
  const stored = await query<{ doc_epoch: string }>(
    'SELECT doc_epoch::text FROM page_collaborative_docs WHERE page_id = $1', [pageId],
  );
  return stored.rows[0]?.doc_epoch ?? null;
}

async function storedDoc(pageId: number) {
  return (await query<{ doc_epoch: string; version: number; updated_at: Date }>(
    'SELECT doc_epoch::text, version, updated_at FROM page_collaborative_docs WHERE page_id = $1', [pageId],
  )).rows;
}

async function admissionCounts(pageId: number): Promise<{ total: number; unreleased: number }> {
  const counted = await query<{ total: string; unreleased: string }>(
    `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE released_at IS NULL)::text AS unreleased
       FROM page_runtime_admissions WHERE page_id = $1`,
    [pageId],
  );
  return { total: Number(counted.rows[0]!.total), unreleased: Number(counted.rows[0]!.unreleased) };
}

async function bodyHtml(pageId: number): Promise<string> {
  return (await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId])).rows[0]!.body_html;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function room(pageId: number): CollabRoom | undefined {
  return getDefaultCollabRuntime()!.getRoom(pageId);
}

/** The room has no socket left and its heap was dropped after the grace period. */
async function roomEvicted(pageId: number): Promise<void> {
  await vi.waitFor(() => expect(room(pageId)).toBeUndefined(), { timeout: 10_000 });
  expect(await admissionCounts(pageId)).toMatchObject({ unreleased: 0 });
}

interface Tab {
  provider: WebsocketProvider;
  doc: Y.Doc;
  controls: Control[];
  closes: CloseRecord[];
  /** The epoch this document is pinned to, once its first sync came with one. */
  pinnedEpoch: () => string | null;
  /** The join parameters of the next connection, as the provider builds them. */
  joinParams: () => URLSearchParams;
}

/**
 * The join declaration of `use-collab-provider.ts`, decided when y-websocket
 * builds the URL of a connection: the pinned epoch from `params`, else the
 * empty-document marker while the document holds nothing, else nothing.
 */
class TabProvider extends WebsocketProvider {
  override get url(): string {
    const url = super.url;
    const holdsNothing = this.doc.store.pendingStructs === null
      && this.doc.store.pendingDs === null
      && Y.equalSnapshots(Y.snapshot(this.doc), Y.emptySnapshot);
    if (this.params.expectedDocEpoch !== undefined || !holdsNothing) return url;
    return `${url}${url.includes('?') ? '&' : '?'}expectedDocEmpty=${COLLAB_DOC_EMPTY_MARKER}`;
  }
}

/**
 * A browser tab: one Y.Doc on a real y-websocket provider that keeps its
 * document across reconnects.
 */
function openTab(pageId: number, token: string, revision: string): Tab {
  const doc = new Y.Doc();
  const controls: Control[] = [];
  const closes: CloseRecord[] = [];
  let candidate: string | null = null;
  let pinned: string | null = null;
  let hasSynced = false;
  const provider = new TabProvider(`${baseWs}/api/collab`, String(pageId), doc, {
    protocols: [COLLAB_WS_PROTOCOL, token],
    params: { expectedLifecycleRevision: revision },
    disableBc: true,
  });
  provider.messageHandlers[4] = (_encoder, decoder) => {
    const control = JSON.parse(decoding.readVarString(decoder)) as Control;
    controls.push(control);
    const epoch = CollabDocEpochControlSchema.safeParse(control);
    if (epoch.success && !hasSynced) candidate = epoch.data.epoch;
  };
  provider.on('sync', (isSynced: boolean) => {
    if (!isSynced || hasSynced) return;
    hasSynced = true;
    if (candidate === null) return;
    pinned = candidate;
    provider.params = { ...provider.params, expectedDocEpoch: candidate };
  });
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (!hasSynced) candidate = null;
    if (!event) return;
    closes.push({ code: event.code, reason: event.reason });
    // A reset document is kept as a draft and never reconnected.
    if (event.code === 1001 && event.reason === 'doc_reset') provider.shouldConnect = false;
  });
  onTestFinished(() => {
    provider.destroy();
    doc.destroy();
  });
  return {
    provider, doc, controls, closes,
    pinnedEpoch: () => pinned,
    joinParams: () => new URL(provider.url).searchParams,
  };
}

async function tabSynced(tab: Tab): Promise<void> {
  await vi.waitFor(() => expect(tab.provider.synced).toBe(true), { timeout: 10_000 });
}

/** The tab received `writable_admission` on its current connection, after `since` controls. */
async function tabWritable(tab: Tab, since = 0): Promise<void> {
  await vi.waitFor(() => {
    expect(tab.controls.slice(since).map((control) => control.type)).toContain('writable_admission');
  }, { timeout: 10_000 });
}

function typeParagraph(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    const content = new Y.XmlText();
    content.insert(0, text);
    paragraph.insert(0, [content]);
    doc.getXmlFragment('default').push([paragraph]);
  });
}

interface RawJoin {
  controls: Control[];
  closed: Promise<CloseRecord>;
  socket: WebSocket;
}

/** A bare WHATWG socket, for join parameters no provider would send. */
function rawJoin(pageId: number, token: string, queryString: string): RawJoin {
  const socket = new WebSocket(`${baseWs}/api/collab/${pageId}${queryString}`, [COLLAB_WS_PROTOCOL, token]);
  socket.binaryType = 'arraybuffer';
  const controls: Control[] = [];
  socket.addEventListener('message', (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const decoder = decoding.createDecoder(new Uint8Array(event.data));
    if (decoding.readVarUint(decoder) !== 4) return;
    controls.push(JSON.parse(decoding.readVarString(decoder)) as Control);
  });
  const { promise, resolve } = Promise.withResolvers<CloseRecord>();
  socket.addEventListener('error', () => { /* the close event carries the outcome */ });
  socket.addEventListener('close', (event) => resolve({ code: event.code, reason: String(event.reason ?? '') }));
  onTestFinished(() => { socket.close(); });
  return { controls, closed: promise, socket };
}

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseWs = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!canRun) return;
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun) return;
  await _resetCollabRoomsForTest();
  await truncateAllTables();
  await withPageWriteTransaction([], async () => undefined);
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('collab_editing_enabled', '1', NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = '1', updated_at = NOW()`,
  );
  await refreshCollabFlag();
});

describe.skipIf(!canRun)('stale tab after a non-collab body write (#2034)', () => {
  it('rejoining on the same Y.Doc after PUT /pages/:id replaced the body gets doc_reset and 1001 doc_reset; the body exists once', async () => {
    const { token, userId } = await createUser('epoch_stale_tab');
    const pageId = await insertStandalone(userId, '<p>ORIGINAL_BODY</p>');
    const revision = await lifecycleRevision(pageId);

    // Tab A joins writable and syncs: it now holds the document and its epoch.
    const tabA = openTab(pageId, token, revision);
    expect(tabA.joinParams().has('expectedDocEpoch')).toBe(false);
    await tabSynced(tabA);
    await tabWritable(tabA);
    const firstEpoch = await rowEpoch(pageId);
    expect(firstEpoch).not.toBeNull();
    expect(tabA.pinnedEpoch()).toBe(firstEpoch);
    expect(occurrences(yDocToHtml(tabA.doc), 'ORIGINAL_BODY')).toBe(1);

    // It leaves for longer than the empty-room grace.
    tabA.provider.disconnect();
    await roomEvicted(pageId);

    // A non-collab body write replaces the page and deletes the BYTEA.
    const put = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Epoch page', bodyHtml: '<p>REPLACED_BODY</p>', version: 1 },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(await storedDoc(pageId)).toEqual([]);
    const admissionsBefore = await admissionCounts(pageId);
    const controlsBefore = tabA.controls.length;

    // Tab A rejoins on the same Y.Doc, declaring the epoch it synced with.
    expect(tabA.joinParams().get('expectedDocEpoch')).toBe(firstEpoch);
    tabA.provider.connect();
    await vi.waitFor(() => expect(tabA.closes).toHaveLength(1), { timeout: 10_000 });

    expect(tabA.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    expect(tabA.controls.slice(controlsBefore)).toEqual([{ type: 'doc_reset' }]);
    // No admission and no row were created for that join.
    expect(await admissionCounts(pageId)).toEqual(admissionsBefore);
    expect(await storedDoc(pageId)).toEqual([]);
    // The tab keeps its own document as a draft; nothing was merged into it.
    expect(tabA.provider.synced).toBe(false);
    expect(occurrences(yDocToHtml(tabA.doc), 'ORIGINAL_BODY')).toBe(1);
    expect(yDocToHtml(tabA.doc)).not.toContain('REPLACED_BODY');
    expect(await bodyHtml(pageId)).toBe('<p>REPLACED_BODY</p>');

    // A fresh tab gets the page body once, in the room, in body_html and after a persist.
    const tabB = openTab(pageId, token, revision);
    await tabSynced(tabB);
    await tabWritable(tabB);
    const secondEpoch = await rowEpoch(pageId);
    expect(secondEpoch).not.toBe(firstEpoch);
    expect(tabB.pinnedEpoch()).toBe(secondEpoch);
    typeParagraph(tabB.doc, 'TYPED_AFTER_REPLACEMENT');
    const current = room(pageId)!;
    await vi.waitFor(() => expect(yDocToHtml(current.doc)).toContain('TYPED_AFTER_REPLACEMENT'), { timeout: 10_000 });
    await persist.flushCollabPersist(current);
    for (const html of [yDocToHtml(current.doc), yDocToHtml(tabB.doc), await bodyHtml(pageId)]) {
      expect(occurrences(html, 'REPLACED_BODY')).toBe(1);
      expect(occurrences(html, 'TYPED_AFTER_REPLACEMENT')).toBe(1);
      expect(html).not.toContain('ORIGINAL_BODY');
    }
  }, 40_000);
});

describe.skipIf(!canRun)('expectedDocEpoch declarations at the gateway (#2034)', () => {
  it('a first join declares an empty document and is verified; a rejoin with the unchanged epoch is verified and never reset', async () => {
    const { token, userId } = await createUser('epoch_rejoin');
    const pageId = await insertStandalone(userId, '<p>BODY</p>');
    const revision = await lifecycleRevision(pageId);

    // A fresh page: no row yet. The tab's empty document sends the marker and names no epoch.
    expect(await storedDoc(pageId)).toEqual([]);
    const tab = openTab(pageId, token, revision);
    expect(tab.joinParams().get('expectedDocEmpty')).toBe('1');
    expect(tab.joinParams().has('expectedDocEpoch')).toBe(false);
    await tabSynced(tab);
    await tabWritable(tab);
    // That join seeded the row and is verified against the epoch it seeded.
    const epoch = await rowEpoch(pageId);
    expect(epoch).not.toBeNull();
    expect(room(pageId)!.docEpoch).toBe(epoch);
    expect([...room(pageId)!.sockets.values()]).toMatchObject([{ writable: true, lineageVerified: true }]);
    // From the first sync on the tab declares its pinned epoch, never the marker.
    expect(tab.joinParams().get('expectedDocEpoch')).toBe(epoch);
    expect(tab.joinParams().has('expectedDocEmpty')).toBe(false);
    // The control precedes the lifecycle and admission controls.
    expect(tab.controls.map((control) => control.type)).toEqual(['doc_epoch', 'page_lifecycle', 'writable_admission']);
    expect(tab.controls[0]).toEqual({ type: 'doc_epoch', epoch });

    // A rejoin while the room is still live, with the room's own persist in between.
    typeParagraph(tab.doc, 'TYPED_BEFORE_REJOIN');
    await vi.waitFor(() => expect(yDocToHtml(room(pageId)!.doc)).toContain('TYPED_BEFORE_REJOIN'), { timeout: 10_000 });
    await persist.flushCollabPersist(room(pageId)!);
    let seen = tab.controls.length;
    tab.provider.disconnect();
    tab.provider.connect();
    await tabSynced(tab);
    await tabWritable(tab, seen);
    expect([...room(pageId)!.sockets.values()].filter((socket) => socket.writable))
      .toMatchObject([{ lineageVerified: true }]);

    // A rejoin after the room was evicted and is reloaded from BYTEA.
    tab.provider.disconnect();
    await roomEvicted(pageId);
    seen = tab.controls.length;
    tab.provider.connect();
    await tabSynced(tab);
    await tabWritable(tab, seen);
    expect([...room(pageId)!.sockets.values()]).toMatchObject([{ writable: true, lineageVerified: true }]);

    expect(await rowEpoch(pageId)).toBe(epoch);
    expect(tab.pinnedEpoch()).toBe(epoch);
    expect(tab.controls.map((control) => control.type)).not.toContain('doc_reset');
    expect(tab.closes.filter((close) => close.reason === 'doc_reset')).toEqual([]);
    expect(occurrences(yDocToHtml(room(pageId)!.doc), 'TYPED_BEFORE_REJOIN')).toBe(1);
  }, 40_000);

  it('an undeclared rejoin of a synced document is admitted as before and stays unverified', async () => {
    const { token, userId } = await createUser('epoch_legacy_bundle');
    const pageId = await insertStandalone(userId, '<p>BODY</p>');
    const revision = await lifecycleRevision(pageId);
    const first = rawJoin(pageId, token, `?expectedLifecycleRevision=${revision}`);
    await vi.waitFor(() => expect(first.controls.map((control) => control.type)).toContain('writable_admission'));

    // A bundle that predates the epoch reconnects without the parameter.
    const legacy = rawJoin(pageId, token, `?expectedLifecycleRevision=${revision}`);
    await vi.waitFor(() => expect(legacy.controls.map((control) => control.type)).toContain('writable_admission'));

    expect([...room(pageId)!.sockets.values()]).toMatchObject([
      { writable: true, lineageVerified: false },
      { writable: true, lineageVerified: false },
    ]);
    expect(legacy.controls.map((control) => control.type)).not.toContain('doc_reset');
    expect(legacy.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('a join that declares an empty document is verified when it turns a provisional room into the persisted one', async () => {
    const { token, userId } = await createUser('epoch_marker_provisional');
    const pageId = await insertStandalone(userId, '<p>BODY</p>');
    const revision = await lifecycleRevision(pageId);

    // A join without a lifecycle revision stays read-only: an HTML-only room without an epoch.
    const viewer = rawJoin(pageId, token, '');
    await vi.waitFor(() => expect(viewer.controls.map((control) => control.type)).toContain('writable_refused'));
    expect(room(pageId)).toMatchObject({ docEpoch: null, hasPersistedDoc: false });
    expect(await storedDoc(pageId)).toEqual([]);

    const marked = rawJoin(pageId, token, `?expectedLifecycleRevision=${revision}&expectedDocEmpty=1`);
    await vi.waitFor(() => expect(marked.controls.map((control) => control.type)).toContain('writable_admission'));

    const epoch = await rowEpoch(pageId);
    expect(epoch).not.toBeNull();
    expect(room(pageId)!.docEpoch).toBe(epoch);
    expect(marked.controls[0]).toEqual({ type: 'doc_epoch', epoch });
    expect([...room(pageId)!.sockets.values()].filter((socket) => socket.writable))
      .toMatchObject([{ lineageVerified: true }]);
    expect(marked.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('a join that declares an empty document is verified in a live room of the current epoch; an undeclared one beside it is not', async () => {
    const { token, userId } = await createUser('epoch_marker_live');
    const pageId = await insertStandalone(userId, '<p>BODY</p>');
    const revision = await lifecycleRevision(pageId);
    const first = rawJoin(pageId, token, `?expectedLifecycleRevision=${revision}&expectedDocEmpty=1`);
    await vi.waitFor(() => expect(first.controls.map((control) => control.type)).toContain('writable_admission'));
    const epoch = await rowEpoch(pageId);
    const admissions = await admissionCounts(pageId);

    // A second tab opens the page while the room is live and holds its admission.
    const second = rawJoin(pageId, token, `?expectedLifecycleRevision=${revision}&expectedDocEmpty=1`);
    await vi.waitFor(() => expect(second.controls.map((control) => control.type)).toContain('writable_admission'));
    // A bundle that predates the marker joins the same room without it.
    const legacy = rawJoin(pageId, token, `?expectedLifecycleRevision=${revision}`);
    await vi.waitFor(() => expect(legacy.controls.map((control) => control.type)).toContain('writable_admission'));

    expect([...room(pageId)!.sockets.values()]).toMatchObject([
      { writable: true, lineageVerified: true },
      { writable: true, lineageVerified: true },
      { writable: true, lineageVerified: false },
    ]);
    expect(second.controls[0]).toEqual({ type: 'doc_epoch', epoch });
    expect(second.controls.map((control) => control.type)).not.toContain('doc_reset');
    // The same document and the room's one admission: the marker joined, it did not seed again.
    expect(await rowEpoch(pageId)).toBe(epoch);
    expect(await admissionCounts(pageId)).toEqual(admissions);
  });

  it.each([
    ['the marker together with the page\'s current epoch', (epoch: string) => `expectedDocEmpty=1&expectedDocEpoch=${epoch}`],
    ['a marker without a value', (_epoch: string) => 'expectedDocEmpty='],
    ['another marker value', (_epoch: string) => 'expectedDocEmpty=true'],
    ['a repeated marker', (_epoch: string) => 'expectedDocEmpty=1&expectedDocEmpty=1'],
  ] as const)(
    '%s is a malformed declaration: 1001 doc_reset, not attached, no admission and no write',
    async (_kind, parameter) => {
      const { token, userId } = await createUser('epoch_marker_malformed');
      const pageId = await insertStandalone(userId, '<p>BODY</p>');
      const revision = await lifecycleRevision(pageId);

      // Against a fresh page: refused before anything is read or seeded.
      const fresh = rawJoin(
        pageId, token, `?expectedLifecycleRevision=${revision}&${parameter('7b0f4c1e-52a8-4d3f-9c6b-1a2b3c4d5e6f')}`,
      );
      expect(await fresh.closed).toEqual({ code: 1001, reason: 'doc_reset' });
      expect(fresh.controls).toEqual([{ type: 'doc_reset' }]);
      expect(await admissionCounts(pageId)).toEqual({ total: 0, unreleased: 0 });
      expect(await storedDoc(pageId)).toEqual([]);
      expect(room(pageId)?.sockets.size ?? 0).toBe(0);

      // Against an existing document, where the epoch alone would have been admitted.
      const seeding = openTab(pageId, token, revision);
      await tabSynced(seeding);
      await tabWritable(seeding);
      const epoch = (await rowEpoch(pageId))!;
      seeding.provider.disconnect();
      await roomEvicted(pageId);
      const before = { admissions: await admissionCounts(pageId), stored: await storedDoc(pageId) };

      const refused = rawJoin(pageId, token, `?expectedLifecycleRevision=${revision}&${parameter(epoch)}`);

      expect(await refused.closed).toEqual({ code: 1001, reason: 'doc_reset' });
      expect(refused.controls).toEqual([{ type: 'doc_reset' }]);
      expect(await admissionCounts(pageId)).toEqual(before.admissions);
      expect(await storedDoc(pageId)).toEqual(before.stored);
      expect(room(pageId)?.sockets.size ?? 0).toBe(0);
      expect(await bodyHtml(pageId)).toBe('<p>BODY</p>');
    },
    30_000,
  );

  it.each([
    ['malformed', (_epoch: string) => 'expectedDocEpoch=not-a-uuid'],
    ['empty', (_epoch: string) => 'expectedDocEpoch='],
    ['repeated', (epoch: string) => `expectedDocEpoch=${epoch}&expectedDocEpoch=${epoch}`],
  ] as const)(
    'a %s expectedDocEpoch against an existing row closes 1001 doc_reset with no admission and no write',
    async (_kind, parameter) => {
      const { token, userId } = await createUser('epoch_malformed');
      const pageId = await insertStandalone(userId, '<p>BODY</p>');
      const revision = await lifecycleRevision(pageId);
      const seeding = openTab(pageId, token, revision);
      await tabSynced(seeding);
      await tabWritable(seeding);
      const epoch = (await rowEpoch(pageId))!;
      seeding.provider.disconnect();
      await roomEvicted(pageId);
      const before = { admissions: await admissionCounts(pageId), stored: await storedDoc(pageId) };

      const refused = rawJoin(pageId, token, `?expectedLifecycleRevision=${revision}&${parameter(epoch)}`);

      expect(await refused.closed).toEqual({ code: 1001, reason: 'doc_reset' });
      expect(refused.controls).toEqual([{ type: 'doc_reset' }]);
      expect(await admissionCounts(pageId)).toEqual(before.admissions);
      expect(await storedDoc(pageId)).toEqual(before.stored);
      expect(room(pageId)?.sockets.size ?? 0).toBe(0);
      expect(await bodyHtml(pageId)).toBe('<p>BODY</p>');
    },
    30_000,
  );

  it('a join that stays read-only for its lifecycle revision keeps that outcome whatever it declares', async () => {
    const { token, userId } = await createUser('epoch_readonly_join');
    const pageId = await insertStandalone(userId, '<p>BODY</p>');

    // No expectedLifecycleRevision: the join is refused writable before any epoch decision.
    const join = rawJoin(pageId, token, '?expectedDocEpoch=not-a-uuid');
    await vi.waitFor(() => expect(join.controls.map((control) => control.type)).toContain('writable_refused'));

    expect(join.controls.map((control) => control.type)).not.toContain('doc_reset');
    expect(join.socket.readyState).toBe(WebSocket.OPEN);
    expect([...room(pageId)!.sockets.values()]).toMatchObject([{ writable: false, lineageVerified: false }]);
    expect(await admissionCounts(pageId)).toEqual({ total: 0, unreleased: 0 });
  });

  it('the marker on a join that stays read-only for its lifecycle revision keeps that outcome, well-formed or not', async () => {
    const { token, userId } = await createUser('epoch_marker_readonly');
    const pageId = await insertStandalone(userId, '<p>BODY</p>');
    const revision = await lifecycleRevision(pageId);

    // No expectedLifecycleRevision: refused writable before any epoch decision.
    const marked = rawJoin(pageId, token, '?expectedDocEmpty=1');
    await vi.waitFor(() => expect(marked.controls.map((control) => control.type)).toContain('writable_refused'));
    const malformed = rawJoin(pageId, token, '?expectedDocEmpty=true');
    await vi.waitFor(() => expect(malformed.controls.map((control) => control.type)).toContain('writable_refused'));

    for (const join of [marked, malformed]) {
      expect(join.controls.map((control) => control.type)).not.toContain('doc_reset');
      expect(join.controls.map((control) => control.type)).not.toContain('writable_admission');
      expect(join.socket.readyState).toBe(WebSocket.OPEN);
    }
    expect([...room(pageId)!.sockets.values()]).toMatchObject([
      { writable: false, lineageVerified: false },
      { writable: false, lineageVerified: false },
    ]);
    expect(await admissionCounts(pageId)).toEqual({ total: 0, unreleased: 0 });
    expect(await storedDoc(pageId)).toEqual([]);

    // The same malformed marker on a join that would be writable is refused.
    const writable = rawJoin(pageId, token, `?expectedLifecycleRevision=${revision}&expectedDocEmpty=true`);
    expect(await writable.closed).toEqual({ code: 1001, reason: 'doc_reset' });
    expect(room(pageId)!.sockets.size).toBe(2);
    expect(await admissionCounts(pageId)).toEqual({ total: 0, unreleased: 0 });
  });
});
