/**
 * #2034 (amendment A8) — an accepted inbound Confluence publication ends the
 * page's collaborative lineage in the transaction that publishes the body.
 *
 * The three real writers run here: the scheduled sync's version-jump upsert
 * and its version-unchanged conflict-policy update (both through `syncPage`),
 * and bulk Re-sync (`POST /pages/bulk/sync`). Real PostgreSQL and Redis, real
 * rooms on isolated runtimes; the only fake is Confluence, served over HTTP.
 *
 * No default runtime exists in this file unless a test starts one, so the
 * writers' own retire hint goes nowhere: that is the "delayed or lost hint"
 * every case has to be safe under. A test delivers the hint itself.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { getPool, query } from '../../core/db/postgres.js';
import { COLLAB_INIT_LOCK_KEY, PAGE_LIFECYCLE_LOCK_KEY } from '../../core/db/advisory-locks.js';
import { confluenceToHtml, htmlToText } from '../../core/services/content-converter.js';
import {
  createCollabRuntime,
  initCollabBus,
  type CollabRoom,
  type CollabRuntime,
} from '../../core/services/collab-room-service.js';
import * as persist from '../../core/services/collab-persistence.js';
import { yDocToHtml } from '../../core/services/collab-schema.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  _resetForTests as resetSyncConflictPolicy,
  initSyncConflictPolicyService,
} from '../../core/services/sync-conflict-policy-service.js';
import { withPageWriteTransaction } from '../../core/services/page-write-admission.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { ConfluenceClient } from '../../domains/confluence/services/confluence-client.js';
import { setRateLimit } from '../../domains/confluence/services/confluence-rate-limiter.js';
import { __internal as sync } from '../../domains/confluence/services/sync-service.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { buildKnowledgeTestApp, insertUser } from './pages.test-helpers.js';
import { pagesCrudRoutes } from './pages-crud.js';

const canRun = (await isDbAvailable()) && (await isRedisAvailable());

const SPACE = 'DEV';
const CONFLUENCE_ID = '9001';
const BODY_H = '<p>BODY_H as synced</p>';
const BODY_J = '<p>BODY_J published upstream</p>';

interface UpstreamPage { title: string; version: number; storage: string }
const upstream = new Map<string, UpstreamPage>();
const server = createServer((request, response) => {
  const segments = new URL(request.url ?? '/', 'http://confluence.test').pathname.split('/');
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && segments.at(-1) === 'attachment') {
    response.end(JSON.stringify({ results: [], size: 0, _links: {} }));
    return;
  }
  const page = upstream.get(segments.at(-1) ?? '');
  if (request.method !== 'GET' || !page) {
    response.statusCode = 404;
    response.end('{}');
    return;
  }
  response.end(JSON.stringify({
    id: segments.at(-1), title: page.title, type: 'page', status: 'current',
    version: { number: page.version }, body: { storage: { value: page.storage } },
    ancestors: [], metadata: { labels: { results: [] } },
  }));
});

/** The writers that can publish over a page whose room still holds an admission. */
const LIVE_ROOM_WRITERS = ['scheduled version jump', 'bulk Re-sync'] as const;
type Writer = typeof LIVE_ROOM_WRITERS[number] | 'scheduled conflict-policy update';

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

function controls(socket: RecordedSocket): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  for (const frame of socket.frames) {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== 4) continue;
    sent.push(JSON.parse(decoding.readVarString(decoder)) as Record<string, unknown>);
  }
  return sent;
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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe.skipIf(!canRun)('inbound publication ends the collaborative lineage (#2034, A8)', () => {
  let app: FastifyInstance;
  let client: ConfluenceClient;
  let main: RedisClientType;
  let userId: string;
  let pageId: number;
  const runtimes: CollabRuntime[] = [];

  const html = (storage: string): string => confluenceToHtml(storage, CONFLUENCE_ID, SPACE);

  async function runtime(podId: string): Promise<CollabRuntime> {
    const created = await createCollabRuntime(main, podId);
    runtimes.push(created);
    return created;
  }

  async function join(
    pod: CollabRuntime,
    id: string,
    options: { writable?: boolean; expectedDocEpoch?: string } = {},
  ) {
    const socket = recordedSocket();
    const attached = await pod.attachSocket(pageId, {
      id, ws: socket.ws, userId, writable: options.writable ?? true,
      ...(options.expectedDocEpoch
        ? { expectedDocEpoch: { kind: 'declared' as const, epoch: options.expectedDocEpoch } }
        : {}),
    });
    return { socket, attached };
  }

  /** A room of the current generation with an edit the server has not persisted. */
  async function dirtyRoom(pod: CollabRuntime, text: string): Promise<{
    room: CollabRoom;
    socket: RecordedSocket;
    docEpoch: string;
  }> {
    const { socket } = await join(pod, 'previous-generation-writer');
    const room = pod.getRoom(pageId)!;
    typeParagraph(room.doc, text);
    const docEpoch = await storedEpoch();
    if (docEpoch === null) throw new Error('the writable join did not persist the document');
    return { room, socket, docEpoch };
  }

  async function pageRow() {
    const result = await query<{
      body_html: string; body_storage: string; version: number; remote_version: number; title: string;
    }>('SELECT body_html, body_storage, version, remote_version, title FROM pages WHERE id = $1', [pageId]);
    return result.rows[0]!;
  }

  /** Read from the table, not through the code under test. */
  async function storedEpoch(): Promise<string | null> {
    const stored = await query<{ doc_epoch: string }>(
      'SELECT doc_epoch::text FROM page_collaborative_docs WHERE page_id = $1', [pageId],
    );
    return stored.rows[0]?.doc_epoch ?? null;
  }

  async function unreleasedAdmissions(): Promise<number> {
    const counted = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM page_runtime_admissions WHERE page_id = $1 AND released_at IS NULL',
      [pageId],
    );
    return Number(counted.rows[0]!.count);
  }

  /** Publish what `upstream` holds for the page through one real inbound writer. */
  async function publish(writer: Writer): Promise<void> {
    if (writer === 'bulk Re-sync') {
      const response = await app.inject({
        method: 'POST', url: '/api/pages/bulk/sync', payload: { ids: [CONFLUENCE_ID] },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { succeeded: number; failed: number; errors: string[] };
      if (body.failed > 0) throw new Error(body.errors.join('; '));
      return;
    }
    const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };
    await sync.syncPage(client, userId, SPACE, { id: CONFLUENCE_ID }, new Date(), new Map(), counts, randomUUID());
  }

  /**
   * Move `upstream` so that `writer` publishes `storage`: a version jump for
   * the upsert and bulk Re-sync, the same version with another body for the
   * scheduled conflict-policy update.
   */
  async function upstreamMoves(writer: Writer, storage: string): Promise<number> {
    const current = (await pageRow()).remote_version;
    const version = writer === 'scheduled conflict-policy update' ? current : current + 2;
    upstream.set(CONFLUENCE_ID, { title: 'Inbound page', version, storage });
    return version;
  }

  /** Backends of this database that wait for the advisory lock `(key, pageId)`. */
  async function waitersOn(key: number): Promise<number> {
    const waiting = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 2 AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [key, pageId],
    );
    return Number(waiting.rows[0]!.count);
  }

  /** Hold the page's collab-init lock until `release`; the next statement that needs it waits. */
  async function holdCollabInit() {
    const holder = await getPool().connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);
    let held = true;
    const release = async (): Promise<void> => {
      if (!held) return;
      held = false;
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    };
    onTestFinished(release);
    return { release };
  }

  beforeAll(async () => {
    await setupTestDb();
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    client = new ConfluenceClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'test-pat');
    setRateLimit(600);
    main = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType;
    main.on('error', () => { /* assertions surface failures */ });
    await main.connect();
    setRedisClient(main);
    app = await buildKnowledgeTestApp(() => userId, async (instance) => {
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  }, 30_000);

  afterAll(async () => {
    for (const pod of runtimes.splice(0)) await pod.close();
    await app.close();
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    setRateLimit(60);
    resetSyncConflictPolicy();
    await main.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    for (const pod of runtimes.splice(0)) await pod.close();
    await truncateAllTables();
    await withPageWriteTransaction([], async () => undefined);
    resetSyncConflictPolicy();
    await initSyncConflictPolicyService();
    upstream.clear();
    userId = await insertUser('inbound-bob');
    await query("INSERT INTO spaces (space_key, space_name, source) VALUES ($1, 'Development', 'confluence')", [SPACE]);
    const role = (await query<{ id: number }>(
      "INSERT INTO roles (name, display_name, permissions) VALUES ('inbound-editor', 'Editor', ARRAY['read','edit']) RETURNING id",
    )).rows[0]!;
    await query(
      "INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id) VALUES ($1, 'user', $2, $3)",
      [SPACE, userId, role.id],
    );
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
       VALUES ($1, $2, $3, TRUE)`,
      [userId, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, encryptPat('test-pat')],
    );
    const inserted = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_storage, body_html, body_text,
                          version, remote_version, last_synced, inherit_perms)
       VALUES ($1, 'confluence', $2, 'Inbound page', $3, $4, $5, 5, 5, NOW() - INTERVAL '1 hour', TRUE)
       RETURNING id`,
      [CONFLUENCE_ID, SPACE, BODY_H, html(BODY_H), htmlToText(html(BODY_H))],
    );
    pageId = inserted.rows[0]!.id;
    upstream.set(CONFLUENCE_ID, { title: 'Inbound page', version: 5, storage: BODY_H });
    await main.del(`collab:active:${pageId}`);
  });

  it.each(LIVE_ROOM_WRITERS)(
    '%s: the published body, storage and provider counter survive a dirty previous-generation room whose hint is delayed',
    async (writer) => {
      const podA = await runtime('inbound-pod-a');
      const podB = await runtime('inbound-pod-b');
      const previous = await dirtyRoom(podA, 'UNFLUSHED_PREVIOUS_GENERATION_EDIT');
      const version = await upstreamMoves(writer, BODY_J);

      await publish(writer);

      const published = await pageRow();
      expect(published).toMatchObject({ body_html: html(BODY_J), body_storage: BODY_J, remote_version: version });
      // The lineage ended with that COMMIT, whether or not a room was live.
      expect(await storedEpoch()).toBeNull();
      // The hint has not arrived: the superseded room is still attached and dirty.
      expect(podA.getRoom(pageId)).toBe(previous.room);
      expect(previous.socket.closes).toEqual([]);

      // A repeated sync of the same provider version does not regress the page.
      await publish(writer);
      expect(await pageRow()).toEqual(published);
      expect(podA.getRoom(pageId)).toBe(previous.room);

      // The delayed hint reaches pod A over Redis: only now does the room retire.
      await podB.hintDocRetired(pageId);
      await vi.waitFor(() => expect(podA.getRoom(pageId)).toBeUndefined());
      // Its editors are told `doc_reset` and keep their documents as drafts.
      expect(controls(previous.socket).at(-1)).toEqual({ type: 'doc_reset' });
      expect(previous.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
      expect(await unreleasedAdmissions()).toBe(0);
      expect(await pageRow()).toEqual(published);

      // The document reloaded by the next writable join agrees with the inbound version.
      const stale = await join(podB, 'stale-tab', { expectedDocEpoch: previous.docEpoch });
      expect(stale.attached.joinRefused).toBe('doc_reset');
      const next = await join(podB, 'next-generation');
      expect(next.attached.writable).toBe(true);
      const reloaded = podB.getRoom(pageId)!;
      expect(yDocToHtml(reloaded.doc)).toBe(html(BODY_J));
      expect(reloaded.docEpoch).toBe(await storedEpoch());
      expect(reloaded.docEpoch).not.toBe(previous.docEpoch);
      await persist.flushCollabPersist(reloaded);
      expect(await pageRow()).toEqual(published);
    },
    30_000,
  );

  it('scheduled conflict-policy update: the row of the previous generation is deleted with the publication, and a retained reader room retires on the hint', async () => {
    const podA = await runtime('inbound-pod-a');
    const podB = await runtime('inbound-pod-b');
    // A session persisted the document and left; a reader keeps the heap on pod A.
    await join(podA, 'earlier-writer');
    const previousEpoch = (await storedEpoch())!;
    const reader = await join(podA, 'reader', { writable: false });
    await podA.detachSocket(pageId, 'earlier-writer');
    const retained = podA.getRoom(pageId)!;
    expect(retained.admission).toBeNull();
    // Same provider version, another body: the version-unchanged branch publishes it.
    const version = await upstreamMoves('scheduled conflict-policy update', BODY_J);

    await publish('scheduled conflict-policy update');

    const published = await pageRow();
    expect(published).toMatchObject({ body_html: html(BODY_J), body_storage: BODY_J, remote_version: version });
    expect(await storedEpoch()).toBeNull();
    expect(podA.getRoom(pageId)).toBe(retained);
    expect(reader.socket.closes).toEqual([]);

    await podB.hintDocRetired(pageId);
    await vi.waitFor(() => expect(podA.getRoom(pageId)).toBeUndefined());
    expect(reader.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);

    const stale = await join(podA, 'stale-tab', { expectedDocEpoch: previousEpoch });
    expect(stale.attached.joinRefused).toBe('doc_reset');
    await join(podA, 'next-generation');
    expect(yDocToHtml(podA.getRoom(pageId)!.doc)).toBe(html(BODY_J));
    expect(await storedEpoch()).not.toBe(previousEpoch);
    expect(await pageRow()).toEqual(published);
  });

  it('the writer\'s own hint, sent after its COMMIT, retires the superseded room on another pod', async () => {
    const podA = await runtime('inbound-pod-a');
    const previous = await dirtyRoom(podA, 'UNFLUSHED_PREVIOUS_GENERATION_EDIT');
    // The publishing process has a collab runtime of its own and no room for the page.
    const stopDefaultRuntime = await initCollabBus(main);
    onTestFinished(stopDefaultRuntime);
    await upstreamMoves('bulk Re-sync', BODY_J);

    await publish('bulk Re-sync');

    await vi.waitFor(() => expect(podA.getRoom(pageId)).toBeUndefined());
    expect(previous.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    expect(await pageRow()).toMatchObject({ body_html: html(BODY_J), body_storage: BODY_J });
    expect(await unreleasedAdmissions()).toBe(0);
  });

  // The #1474 expectation, on the real publication path: whichever of a room
  // persist and an inbound publication gets the page's locks first, the page
  // ends on the inbound version and the room's typed paragraph is not in it.
  describe.each(LIVE_ROOM_WRITERS)('%s against a concurrent room persist (#1474)', (writer) => {
    it('a persist that queues behind the publication finds its row gone and writes nothing', async () => {
      const podA = await runtime('inbound-pod-a');
      const previous = await dirtyRoom(podA, 'COLLAB_TYPED_PARAGRAPH');
      const version = await upstreamMoves(writer, BODY_J);
      const collabInit = await holdCollabInit();

      // The publication holds the page lifecycle lock and waits to delete the row.
      const publishing = publish(writer);
      await vi.waitFor(async () => expect(await waitersOn(COLLAB_INIT_LOCK_KEY)).toBe(1), { timeout: 10_000 });
      // The room persist queues on that lifecycle lock.
      const persisting = persist.flushCollabPersist(previous.room).then(() => null, (error: unknown) => error);
      await vi.waitFor(async () => expect(await waitersOn(PAGE_LIFECYCLE_LOCK_KEY)).toBe(1), { timeout: 10_000 });
      await collabInit.release();
      await publishing;

      expect(await persisting).toMatchObject({ reason: 'collab_lineage_changed' });
      const page = await pageRow();
      expect(page).toMatchObject({ body_html: html(BODY_J), body_storage: BODY_J, remote_version: version });
      expect(page.body_html).not.toContain('COLLAB_TYPED_PARAGRAPH');
      expect(await storedEpoch()).toBeNull();
      // That refused persist is the room's boundary: it retires without any hint.
      await vi.waitFor(() => expect(podA.getRoom(pageId)).toBeUndefined());
      expect(previous.socket.closes).toEqual([{ code: 1001, reason: 'doc_reset' }]);
    }, 30_000);

    it('a persist that commits first is replaced by the publication, which then ends its lineage', async () => {
      const podA = await runtime('inbound-pod-a');
      const previous = await dirtyRoom(podA, 'COLLAB_TYPED_PARAGRAPH');
      const version = await upstreamMoves(writer, BODY_J);
      const collabInit = await holdCollabInit();

      // The room persist holds the page lifecycle lock and waits for the init lock.
      const persisting = persist.flushCollabPersist(previous.room);
      await vi.waitFor(async () => expect(await waitersOn(COLLAB_INIT_LOCK_KEY)).toBe(1), { timeout: 10_000 });
      // The publication queues on that lifecycle lock.
      const publishing = publish(writer);
      await vi.waitFor(async () => expect(await waitersOn(PAGE_LIFECYCLE_LOCK_KEY)).toBe(1), { timeout: 10_000 });
      await collabInit.release();
      await persisting;
      await publishing;

      const page = await pageRow();
      expect(page).toMatchObject({ body_html: html(BODY_J), body_storage: BODY_J, remote_version: version });
      expect(page.body_html).not.toContain('COLLAB_TYPED_PARAGRAPH');
      expect(await storedEpoch()).toBeNull();
      // The room's next persist cannot bring its snapshot back.
      typeParagraph(previous.room.doc, 'TYPED_AFTER_PUBLICATION');
      await expect(persist.flushCollabPersist(previous.room)).rejects.toMatchObject({ reason: 'collab_lineage_changed' });
      expect(await pageRow()).toEqual(page);
    }, 30_000);
  });

  describe('a publication that rolls back', () => {
    /** Make the transaction that deletes the collaborative row fail at its COMMIT. */
    async function failPublicationCommit(): Promise<void> {
      await query(`CREATE FUNCTION inbound_test_refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'publication commit refused (test)'; END $$;
        CREATE CONSTRAINT TRIGGER inbound_test_refuse_commit AFTER DELETE ON page_collaborative_docs
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inbound_test_refuse_commit()`);
      onTestFinished(async () => {
        await query(`DROP TRIGGER IF EXISTS inbound_test_refuse_commit ON page_collaborative_docs;
                     DROP FUNCTION IF EXISTS inbound_test_refuse_commit()`);
      });
    }

    it.each(LIVE_ROOM_WRITERS)('%s: the previous generation stays attached, writable and persisting', async (writer) => {
      const podA = await runtime('inbound-pod-a');
      const podB = await runtime('inbound-pod-b');
      const previous = await dirtyRoom(podA, 'EDIT_OF_THE_SURVIVING_GENERATION');
      const before = await pageRow();
      await upstreamMoves(writer, BODY_J);
      await failPublicationCommit();

      await expect(publish(writer)).rejects.toThrow('publication commit refused (test)');

      // Body and lineage roll back together.
      expect(await pageRow()).toEqual(before);
      expect(await storedEpoch()).toBe(previous.docEpoch);
      // Even a hint finds the row unchanged.
      await podB.hintDocRetired(pageId);
      await podA.hintDocRetired(pageId);
      expect(podA.getRoom(pageId)).toBe(previous.room);
      expect(previous.socket.closes).toEqual([]);
      expect(previous.room.sockets.get('previous-generation-writer')!.writable).toBe(true);
      await persist.flushCollabPersist(previous.room);
      expect((await pageRow()).body_html).toContain('EDIT_OF_THE_SURVIVING_GENERATION');
      expect(await storedEpoch()).toBe(previous.docEpoch);
    });

    it('scheduled conflict-policy update: the previous generation keeps its row and a declared rejoin is verified', async () => {
      const podA = await runtime('inbound-pod-a');
      await join(podA, 'earlier-writer');
      const previousEpoch = (await storedEpoch())!;
      await podA.detachSocket(pageId, 'earlier-writer');
      await podA.dropRoom(pageId);
      const before = await pageRow();
      await upstreamMoves('scheduled conflict-policy update', BODY_J);
      await failPublicationCommit();

      await expect(publish('scheduled conflict-policy update')).rejects.toThrow('publication commit refused (test)');

      expect(await pageRow()).toEqual(before);
      expect(await storedEpoch()).toBe(previousEpoch);
      const rejoined = await join(podA, 'rejoin', { expectedDocEpoch: previousEpoch });
      expect(rejoined.attached).toMatchObject({ writable: true, lineageVerified: true });
    });
  });

  it('an unchanged bulk refresh publishes no new body and keeps the lineage', async () => {
    const podA = await runtime('inbound-pod-a');
    const podB = await runtime('inbound-pod-b');
    const previous = await dirtyRoom(podA, 'EDIT_OF_THE_SURVIVING_GENERATION');
    // Upstream moved its counter (a rename); the body is the one already stored.
    upstream.set(CONFLUENCE_ID, { title: 'Inbound page renamed', version: 6, storage: BODY_H });

    await publish('bulk Re-sync');

    expect(await pageRow()).toMatchObject({
      title: 'Inbound page renamed', body_html: html(BODY_H), remote_version: 6,
    });
    expect(await storedEpoch()).toBe(previous.docEpoch);
    await podB.hintDocRetired(pageId);
    await podA.hintDocRetired(pageId);
    expect(podA.getRoom(pageId)).toBe(previous.room);
    expect(previous.socket.closes).toEqual([]);
    await persist.flushCollabPersist(previous.room);
    expect((await pageRow()).body_html).toContain('EDIT_OF_THE_SURVIVING_GENERATION');
    expect(await storedEpoch()).toBe(previous.docEpoch);
  });

  it('body H, then J, then H again: a delayed hint of the older publication leaves the newer generation and its unflushed edit alone', async () => {
    const podA = await runtime('inbound-pod-a');
    const podB = await runtime('inbound-pod-b');
    // Generation 1 on the body H.
    await join(podA, 'first-generation');
    const firstEpoch = (await storedEpoch())!;
    await podA.detachSocket(pageId, 'first-generation');
    await podA.dropRoom(pageId);

    // Publication of J ends generation 1; its hint is delayed.
    upstream.set(CONFLUENCE_ID, { title: 'Inbound page', version: 6, storage: BODY_J });
    await publish('scheduled version jump');
    expect(await pageRow()).toMatchObject({ body_html: html(BODY_J), remote_version: 6 });
    expect(await storedEpoch()).toBeNull();
    // Upstream returns to the very same body H.
    upstream.set(CONFLUENCE_ID, { title: 'Inbound page', version: 7, storage: BODY_H });
    await publish('scheduled version jump');
    const published = await pageRow();
    expect(published).toMatchObject({ body_html: html(BODY_H), remote_version: 7 });

    // Generation 2 is seeded from that H and holds an edit nobody persisted yet.
    const writer = await join(podB, 'second-generation');
    const current = podB.getRoom(pageId)!;
    const secondEpoch = (await storedEpoch())!;
    expect(secondEpoch).not.toBe(firstEpoch);
    typeParagraph(current.doc, 'UNFLUSHED_SECOND_GENERATION_EDIT');
    const live = Number(await main.sCard(`collab:active:${pageId}`));
    expect(live).toBeGreaterThan(0);

    // The hint of the J publication arrives only now, twice, from another pod and locally.
    await podA.hintDocRetired(pageId);
    await podA.hintDocRetired(pageId);
    await podB.hintDocRetired(pageId);

    // Equal HTML is no reason to touch it: the row still carries its epoch.
    expect(podB.getRoom(pageId)).toBe(current);
    expect(current.docEpoch).toBe(secondEpoch);
    expect(writer.socket.closes).toEqual([]);
    expect(controls(writer.socket).map((control) => control.type)).not.toContain('doc_reset');
    expect(current.sockets.get('second-generation')!.writable).toBe(true);
    expect(Number(await main.sCard(`collab:active:${pageId}`))).toBe(live);
    await persist.flushCollabPersist(current);
    const persisted = await pageRow();
    expect(occurrences(persisted.body_html, 'UNFLUSHED_SECOND_GENERATION_EDIT')).toBe(1);
    expect(occurrences(persisted.body_html, 'BODY_H as synced')).toBe(1);
    expect(await storedEpoch()).toBe(secondEpoch);
    // A tab of generation 1 that comes back now is told its document changed.
    const stale = await join(podB, 'first-generation-tab', { expectedDocEpoch: firstEpoch });
    expect(stale.attached.joinRefused).toBe('doc_reset');
    expect(writer.socket.closes).toEqual([]);
  }, 30_000);
});
