/**
 * #2035 — the collaboration room fails closed after its own Confluence Save
 * failed after dispatch.
 *
 * Real PostgreSQL, Redis, gateway and commit route; only the Confluence HTTP
 * client is replaced. A second `createCollabRuntime` stands for another
 * backend process: it gets its own unknown-commit latches, so it does not see
 * the process-local set of the runtime that ran the Save.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import type { PoolClient } from 'pg';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebSocket as NodeWs } from 'ws';
import { WebsocketProvider } from 'y-websocket';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

import {
  insertTestRuntime,
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { logger } from '../../core/utils/logger.js';
import { COLLAB_WS_PROTOCOL } from '@compendiq/contracts';
import { refreshCollabFlag } from '../../core/services/collab-flag.js';
import {
  _resetCollabRoomsForTest,
  createCollabRuntime,
  getDefaultCollabRuntime,
  type CollabRuntime,
  type CollabSocket,
} from '../../core/services/collab-room-service.js';
import { getRedisClient } from '../../core/services/redis-cache.js';
import * as persist from '../../core/services/collab-persistence.js';
import { yDocToHtml } from '../../core/services/collab-schema.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { ConfluenceClient, ConfluenceError } from '../../domains/confluence/services/confluence-client.js';
import {
  _resetCollabCommitUnknownForTest,
  collabCommitUnknownKey,
  declareCollabCommitUnknown,
  lockPageLifecycle,
  pageWriteIntentHoldsDrain,
  processCollabCommitLatches,
  readCollabCommitState,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
  withPageLifecycleRead,
  withPageWriteTransaction,
  type CollabCommitLatches,
} from '../../core/services/page-write-admission.js';

const canRun = await isDbAvailable() && await isRedisAvailable();

const MESSAGE_SYNC = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;
const MESSAGE_CONTROL = 4;
const EMPTY_DOCUMENT_STATE = Buffer.from(Y.encodeSnapshot(Y.emptySnapshot)).toString('base64');
const MEDIA_BODY = '<p>image</p><img src="/api/attachments/local-src/pasted.png">';
const UNKNOWN_CLOSE = { code: 1001, reason: 'commit_unknown' };

type Control = { type: string; [key: string]: unknown };
type CloseInfo = { code: number; reason: string };
type Account = { token: string; userId: string };

let app: FastifyInstance;
let baseWs: string;

function entropy(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function createUser(username: string, role: 'user' | 'admin' = 'user'): Promise<Account> {
  const created = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'fakehash', $2) RETURNING id`,
    [username, role],
  );
  const userId = created.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  return { userId, token: await generateAccessToken({ sub: userId, username, role }) };
}

async function grantSpaceRead(userId: string, spaceKey: string): Promise<void> {
  await query(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('collab_test_reader', 'Collab Test Reader', FALSE, ARRAY['read'])
     ON CONFLICT (name) DO NOTHING`,
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     SELECT $1, 'user', $2, id FROM roles WHERE name = 'collab_test_reader'
     ON CONFLICT DO NOTHING`,
    [spaceKey, userId],
  );
}

async function lifecycleRevision(pageId: number): Promise<string> {
  const state = await query<{ lifecycle_revision: string }>(
    'SELECT lifecycle_revision::text FROM pages WHERE id = $1', [pageId],
  );
  return state.rows[0]!.lifecycle_revision;
}

/** The pasted image a media Save uploads; `ATTACHMENTS_DIR` is restored after the test. */
async function pastedImageRoot(): Promise<void> {
  const root = await fs.promises.mkdtemp(path.join(tmpdir(), 'collab-unknown-media-'));
  await fs.promises.mkdir(path.join(root, 'local-src'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'local-src', 'pasted.png'), Buffer.from('planned pasted image bytes'));
  vi.stubEnv('ATTACHMENTS_DIR', root);
  onTestFinished(() => fs.promises.rm(root, { recursive: true, force: true }));
}

interface Seed {
  saver: Account;
  coEditor: Account;
  pageId: number;
  confluenceId: string;
  spaceKey: string;
  revision: string;
}

async function seedPage(options: { media?: boolean } = {}): Promise<Seed> {
  if (options.media) await pastedImageRoot();
  const saver = await createUser(`cu_saver_${entropy()}`);
  const coEditor = await createUser(`cu_peer_${entropy()}`);
  const spaceKey = `CU${entropy().slice(0, 6).toUpperCase()}`;
  const confluenceId = `cf-cu-${entropy()}`;
  await query('INSERT INTO spaces (space_key, space_name) VALUES ($1, $1)', [spaceKey]);
  const body = options.media ? MEDIA_BODY : '<p>commit-unknown-seed</p>';
  const page = await query<{ id: number }>(
    `INSERT INTO pages (
        confluence_id, space_key, title, body_storage, body_html, body_text,
        version, source, visibility, last_synced, inherit_perms
     ) VALUES ($1, $2, 'Conf page', $3, $3, 'x', 4, 'confluence', 'shared', NOW(), TRUE)
     RETURNING id`,
    [confluenceId, spaceKey, body],
  );
  const pageId = page.rows[0]!.id;
  await grantSpaceRead(saver.userId, spaceKey);
  await grantSpaceRead(coEditor.userId, spaceKey);
  await query(
    'UPDATE user_settings SET confluence_url = $2, confluence_pat = $3 WHERE user_id = $1',
    [saver.userId, 'https://confluence.example.com', encryptPat('test-pat-2035')],
  );
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('collab_editing_enabled', '1', NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = '1', updated_at = NOW()`,
  );
  await refreshCollabFlag();
  return { saver, coEditor, pageId, confluenceId, spaceKey, revision: await lifecycleRevision(pageId) };
}

function decodeControl(frame: Uint8Array): Control | null {
  try {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== MESSAGE_CONTROL) return null;
    return JSON.parse(decoding.readVarString(decoder)) as Control;
  } catch {
    return null;
  }
}

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** A paragraph typed into `doc`, as the update frame its client sends. */
function typedFrame(doc: Y.Doc, text: string): Uint8Array {
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    const content = new Y.XmlText();
    content.insert(0, text);
    paragraph.insert(0, [content]);
    doc.getXmlFragment('default').push([paragraph]);
  });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, SYNC_UPDATE);
  encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc, before));
  return encoding.toUint8Array(encoder);
}

/** A browser tab on a real WebSocket through the gateway. */
interface Tab {
  ws: WebSocket;
  doc: Y.Doc;
  controls: Control[];
  closeInfo: CloseInfo | null;
  closed: Promise<CloseInfo>;
  /** The first of `writable_admission`, `commit_unknown` or a close. */
  outcome: Promise<'writable' | 'commit_unknown' | 'closed'>;
  synced: Promise<void>;
}

type TabOptions = {
  onControl?: (control: Control, tab: Tab) => void;
  /** Frames sent as soon as the socket opens, before the join completes. */
  preLive?: (tab: Tab) => Uint8Array[];
};

function openTab(pageId: number, token: string, revision: string, options: TabOptions = {}): Tab {
  const ws = new WebSocket(
    `${baseWs}/api/collab/${pageId}?expectedLifecycleRevision=${encodeURIComponent(revision)}`,
    [COLLAB_WS_PROTOCOL, token],
  );
  ws.binaryType = 'arraybuffer';
  const closed = Promise.withResolvers<CloseInfo>();
  const outcome = Promise.withResolvers<'writable' | 'commit_unknown' | 'closed'>();
  const synced = Promise.withResolvers<void>();
  const tab: Tab = {
    ws,
    doc: new Y.Doc(),
    controls: [],
    closeInfo: null,
    closed: closed.promise,
    outcome: outcome.promise,
    synced: synced.promise,
  };
  ws.addEventListener('open', () => {
    for (const frame of options.preLive?.(tab) ?? []) ws.send(frame);
  });
  ws.addEventListener('message', (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const frame = new Uint8Array(event.data);
    const control = decodeControl(frame);
    if (control) {
      tab.controls.push(control);
      if (control.type === 'writable_admission') outcome.resolve('writable');
      if (control.type === 'commit_unknown') outcome.resolve('commit_unknown');
      options.onControl?.(control, tab);
      return;
    }
    if (frame[0] !== MESSAGE_SYNC) return;
    const decoder = decoding.createDecoder(frame);
    decoding.readVarUint(decoder);
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), tab.doc, 'server');
    if (frame[1] === SYNC_STEP2) synced.resolve();
  });
  ws.addEventListener('close', (event) => {
    tab.closeInfo = { code: event.code, reason: String(event.reason ?? '') };
    closed.resolve(tab.closeInfo);
    outcome.resolve('closed');
    synced.resolve();
  });
  onTestFinished(() => {
    ws.close();
    tab.doc.destroy();
  });
  return tab;
}

async function joinTab(
  pageId: number,
  token: string,
  options: TabOptions = {},
): Promise<{ tab: Tab; outcome: 'writable' | 'commit_unknown' | 'closed' }> {
  const tab = openTab(pageId, token, await lifecycleRevision(pageId), options);
  const outcome = await tab.outcome;
  if (outcome !== 'closed') {
    tab.ws.send(encodeSyncStep1(tab.doc));
    await tab.synced;
  }
  return { tab, outcome };
}

async function joinWritable(pageId: number, token: string, options: TabOptions = {}): Promise<Tab> {
  const { tab, outcome } = await joinTab(pageId, token, options);
  expect(outcome).toBe('writable');
  return tab;
}

function controlTypes(tab: Tab): string[] {
  return tab.controls.map((control) => control.type);
}

async function tabSees(tab: Tab, text: string): Promise<boolean> {
  try {
    await vi.waitFor(() => {
      if (!yDocToHtml(tab.doc).includes(text)) throw new Error('the edit has not arrived');
    }, { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

/** A socket attached straight to a runtime. Its `close` keeps it attached, as a slow close handshake does. */
interface FakeSocket {
  id: string;
  ws: NodeWs;
  controls: () => string[];
  closed: () => CloseInfo | null;
}

function fakeSocket(id: string): FakeSocket {
  const frames: Uint8Array[] = [];
  let closed: CloseInfo | null = null;
  const ws = {
    readyState: 1,
    send(data: Uint8Array) { frames.push(new Uint8Array(data)); },
    close(code?: number, reason?: string) { closed ??= { code: code ?? 1005, reason: String(reason ?? '') }; },
  };
  return {
    id,
    ws: ws as unknown as NodeWs,
    controls: () => frames.flatMap((frame) => {
      const control = decodeControl(frame);
      return control ? [control.type] : [];
    }),
    closed: () => closed,
  };
}

async function attachFake(
  runtime: CollabRuntime,
  seed: Seed,
  id: string,
  options: { userId?: string; writable?: boolean } = {},
): Promise<{ socket: FakeSocket; attached: CollabSocket }> {
  const socket = fakeSocket(id);
  const attached = await runtime.attachSocket(seed.pageId, {
    id,
    ws: socket.ws,
    userId: options.userId ?? seed.coEditor.userId,
    writable: options.writable ?? true,
    expectedLifecycleRevision: await lifecycleRevision(seed.pageId),
  });
  return { socket, attached };
}

/** Another backend process: it never sees the process-local set of the runtime that ran the Save. */
function anotherProcess(
  sharedLatch: CollabCommitLatches['readSharedLatch'] = processCollabCommitLatches.readSharedLatch,
): CollabCommitLatches {
  return { locallyUnknown: () => false, readSharedLatch: sharedLatch };
}

async function otherRuntime(podId: string, latches: CollabCommitLatches = anotherProcess()): Promise<CollabRuntime> {
  const runtime = await createCollabRuntime(getRedisClient()!, podId, { commitLatches: latches });
  onTestFinished(() => runtime.close());
  return runtime;
}

function defaultRuntime(): CollabRuntime {
  const runtime = getDefaultCollabRuntime();
  if (!runtime) throw new Error('collab runtime is not initialised');
  return runtime;
}

function roomHtml(runtime: CollabRuntime, pageId: number): string {
  const room = runtime.getRoom(pageId);
  return room ? yDocToHtml(room.doc) : '';
}

function remotePage(confluenceId: string, version: number, title = 'Conf page', storage?: string) {
  return {
    id: confluenceId,
    title,
    status: 'current',
    type: 'page',
    version: { number: version, when: '2026-11-24T00:00:00Z' },
    ...(storage === undefined ? {} : { body: { storage: { value: storage } } }),
  };
}

/** The provider read; a list answers call by call and repeats its last version. */
function mockRemoteRead(confluenceId: string, versions: number[] = [4]) {
  let calls = 0;
  return vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
    const version = versions[Math.min(calls, versions.length - 1)]!;
    calls += 1;
    return remotePage(confluenceId, version) as never;
  });
}

function acceptUpload() {
  return vi.spyOn(ConfluenceClient.prototype, 'updateAttachment').mockImplementation(
    async (_id, filename) => ({
      id: 'attachment-1',
      title: filename,
      mediaType: 'image/png',
      version: { number: 1, when: '2026-11-24T00:00:01Z' },
    }) as never,
  );
}

function acceptPut(confluenceId: string) {
  return vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(
    async (_id, title, storage) => remotePage(confluenceId, 5, title, storage) as never,
  );
}

function failPut(error: Error = new Error('socket hang up after the request was written')) {
  return vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockRejectedValue(error);
}

/** The provider PUT waits; `started` resolves once the intent's publishing phase runs. */
function gatePut(confluenceId: string) {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  gate.promise.catch(() => undefined);
  const spy = vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async (_id, title, storage) => {
    started.resolve();
    await gate.promise;
    return remotePage(confluenceId, 5, title, storage) as never;
  });
  return {
    spy,
    started: started.promise,
    succeed: () => gate.resolve(),
    fail: () => gate.reject(new Error('socket hang up after the request was written')),
  };
}

function save(seed: Seed, token = seed.saver.token) {
  return app.inject({
    method: 'POST',
    url: `/api/pages/${seed.pageId}/collab/commit`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: 'Saved title',
      expectedLifecycleRevision: seed.revision,
      expectedDocumentState: EMPTY_DOCUMENT_STATE,
    },
  });
}

async function commitIntents(pageId: number) {
  const result = await query<{
    id: string;
    kind: string;
    status: string;
    started: boolean;
    marked: boolean;
    terminal: unknown;
  }>(
    `SELECT id, kind, status,
            remote_effect_started_at IS NOT NULL AS started,
            remote_effect_failed_at IS NOT NULL AS marked,
            remote_terminal_result AS terminal
       FROM page_write_intents
      WHERE page_ids = ARRAY[$1]::integer[]
      ORDER BY created_at, id`,
    [pageId],
  );
  return result.rows;
}

async function pendingIntentId(pageId: number): Promise<string> {
  const pending = (await commitIntents(pageId)).filter((intent) => intent.status === 'pending');
  expect(pending).toHaveLength(1);
  return pending[0]!.id;
}

function durableState(pageId: number) {
  return withPageLifecycleRead(pageId, (client) => readCollabCommitState(client, pageId));
}

async function admissionRows(pageId: number) {
  const result = await query<{ id: string; purpose: string; released: boolean }>(
    `SELECT id::text, purpose, released_at IS NOT NULL AS released
       FROM page_runtime_admissions WHERE page_id = $1 ORDER BY id`,
    [pageId],
  );
  return result.rows;
}

function activeMembers(pageId: number): Promise<string[]> {
  return getRedisClient()!.sMembers(`collab:active:${pageId}`);
}

function readonlyDrops(info: { mock: { calls: unknown[][] } }): number {
  return info.mock.calls.filter((call) => call[1] === 'collab.readonly_drop').length;
}

function expectUnknownThenCompatibilityCue(types: string[]): void {
  const unknown = types.indexOf('commit_unknown');
  expect(unknown, types.join(',')).toBeGreaterThanOrEqual(0);
  // `permission_loss` follows for a client that predates the new control.
  expect(types.indexOf('permission_loss', unknown), types.join(',')).toBe(unknown + 1);
}

/** The bus loses every `commit_unknown` cue; all other messages are delivered. */
function dropCommitUnknownCues(): { dropped: () => number } {
  const redis = getRedisClient()!;
  const publish = redis.publish.bind(redis);
  let dropped = 0;
  vi.spyOn(redis, 'publish').mockImplementation(((channel: string, message: string) => {
    if (typeof message === 'string' && message.includes('"kind":"commit_unknown"')) {
      dropped += 1;
      return Promise.resolve(0);
    }
    return publish(channel, message);
  }) as typeof redis.publish);
  return { dropped: () => dropped };
}

/** Hold the page lifecycle lock until released. `waiters` counts the backends queued behind it. */
async function holdLifecycleLock(pageId: number): Promise<{
  release: () => Promise<void>;
  waiters: (count: number) => Promise<boolean>;
}> {
  const holder: PoolClient = await getPool().connect();
  await holder.query('BEGIN');
  await lockPageLifecycle(holder, [pageId]);
  const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  };
  onTestFinished(release);
  return {
    release,
    waiters: (count) => waitForDatabaseCondition(async () => {
      const blocked = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pg_stat_activity
          WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
        [pid],
      );
      return Number(blocked.rows[0]!.count) >= count;
    }),
  };
}

/**
 * Deliver a cue and return once its lifecycle-locked check has run: the check
 * queues behind a lock this helper holds, so a later locked read follows it.
 */
async function deliverCue(runtime: CollabRuntime, pageId: number, intentId: string): Promise<void> {
  const lock = await holdLifecycleLock(pageId);
  runtime.announceCommitUnknown(pageId, intentId);
  expect(await lock.waiters(1)).toBe(true);
  await lock.release();
  await withPageLifecycleRead(pageId, async () => undefined);
}

/** Hold the intent row so the marker cannot be recorded; fences only read that row. */
async function blockMarker(intentId: string): Promise<() => Promise<void>> {
  const holder = await getPool().connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM page_write_intents WHERE id = $1 FOR UPDATE', [intentId]);
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  };
  onTestFinished(release);
  return release;
}

async function settleBySql(intentId: string, status: string): Promise<void> {
  await query(
    `UPDATE page_write_intents
        SET status = $2, settled_at = NOW(), settlement_reason = 'test settlement', settlement_proof = '{}'::jsonb
      WHERE id = $1`,
    [intentId, status],
  );
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
  _resetCollabCommitUnknownForTest();
  await truncateAllTables();
  await withPageWriteTransaction([], async () => undefined);
});

afterEach(async () => {
  if (!canRun) return;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetCollabCommitUnknownForTest();
  const redis = getRedisClient()!;
  const leftover = await redis.keys('collab:commit-unknown:*');
  if (leftover.length > 0) await redis.del(leftover);
});

describe.skipIf(!canRun)('collaborative Save that fails after dispatch (#2035)', () => {
  type Trigger = {
    name: string;
    media: boolean;
    status: number;
    arrange: (seed: Seed) => { putNotIssued?: boolean };
    verify?: (body: Record<string, unknown>) => void;
  };

  const expectPostDispatchConflict = (body: Record<string, unknown>): void => {
    // Status, code and versions are kept; the open-session promise is not.
    expect(body).toMatchObject({ code: 'confluence_modified', remoteVersion: 9, localVersion: 4 });
    expect(String(body.message)).not.toMatch(/session is still open/i);
    expect(String(body.message)).toMatch(/result of this save is unknown/i);
  };

  const TRIGGERS: Trigger[] = [
    {
      name: 'the provider fails after dispatch',
      media: false,
      status: 500,
      arrange: (seed) => {
        mockRemoteRead(seed.confluenceId);
        failPut();
        return {};
      },
    },
    {
      name: 'the provider fails after a completed upload (.media)',
      media: true,
      status: 500,
      arrange: (seed) => {
        mockRemoteRead(seed.confluenceId);
        acceptUpload();
        failPut();
        return {};
      },
    },
    {
      name: 'the provider answers 409 after dispatch',
      media: false,
      status: 409,
      arrange: (seed) => {
        mockRemoteRead(seed.confluenceId, [4, 9]);
        failPut(new ConfluenceError('Version conflict', 409));
        return {};
      },
      verify: expectPostDispatchConflict,
    },
    {
      name: 'the provider answers 409 after a completed upload (.media)',
      media: true,
      status: 409,
      arrange: (seed) => {
        mockRemoteRead(seed.confluenceId, [4, 9]);
        acceptUpload();
        failPut(new ConfluenceError('Version conflict', 409));
        return {};
      },
      verify: expectPostDispatchConflict,
    },
    {
      name: 'the first upload fails (.media)',
      media: true,
      status: 500,
      arrange: (seed) => {
        mockRemoteRead(seed.confluenceId);
        vi.spyOn(ConfluenceClient.prototype, 'updateAttachment').mockRejectedValue(
          new Error('connection reset after attachment bytes were sent'),
        );
        acceptPut(seed.confluenceId);
        return { putNotIssued: true };
      },
    },
    {
      name: 'the Save is refused between its upload and its page update (.media)',
      media: true,
      status: 403,
      arrange: (seed) => {
        mockRemoteRead(seed.confluenceId);
        vi.spyOn(ConfluenceClient.prototype, 'updateAttachment').mockImplementation(async (_id, filename) => {
          // The upload completes; the saver loses access before the next phase.
          await query(
            `DELETE FROM space_role_assignments
              WHERE space_key = $1 AND principal_type = 'user' AND principal_id = $2`,
            [seed.spaceKey, seed.saver.userId],
          );
          return {
            id: 'attachment-1',
            title: filename,
            mediaType: 'image/png',
            version: { number: 1, when: '2026-11-24T00:00:01Z' },
          } as never;
        });
        acceptPut(seed.confluenceId);
        return { putNotIssued: true };
      },
    },
  ];

  it.each(TRIGGERS)(
    'fails the room closed on every pod when $name',
    async ({ media, status, arrange, verify }) => {
      const seed = await seedPage({ media });
      const { pageId } = seed;
      // The saver's tab answers the control with one more edit: a frame that
      // was already on its way when the server demoted the socket.
      const a = await joinWritable(pageId, seed.saver.token, {
        onControl: (control, tab) => {
          if (control.type !== 'commit_unknown') return;
          try { tab.ws.send(typedFrame(tab.doc, 'LATE_FROM_TAB')); } catch { /* the close won the race */ }
        },
      });
      const b = await joinWritable(pageId, seed.coEditor.token);
      const podB = await otherRuntime('unknown-pod-b');
      const c = (await attachFake(podB, seed, 'pod-b-writer')).socket;
      expect(c.controls()).toContain('writable_admission');
      const viewer = (await attachFake(podB, seed, 'pod-b-viewer', { writable: false })).socket;
      const expected = arrange(seed);
      const info = vi.spyOn(logger, 'info');

      const response = await save(seed);

      expect(response.statusCode, response.body).toBe(status);
      verify?.(response.json());
      if (expected.putNotIssued) expect(ConfluenceClient.prototype.updatePage).not.toHaveBeenCalled();
      // The durable marker on the intent the route left pending; nothing is settled.
      const intents = await commitIntents(pageId);
      expect(intents).toEqual([{
        id: expect.any(String),
        kind: media ? 'collab.commit.confluence.media' : 'collab.commit.confluence',
        status: 'pending',
        started: true,
        marked: true,
        terminal: null,
      }]);
      const intentId = intents[0]!.id;
      expect(await durableState(pageId)).toEqual({ state: 'unknown', intentId });

      // Every writable socket of the page: the control, the compatibility cue, the close.
      for (const tab of [a, b]) {
        expect(await tab.closed).toEqual(UNKNOWN_CLOSE);
        expectUnknownThenCompatibilityCue(controlTypes(tab));
      }
      // The other pod learns of it through the bus.
      await vi.waitFor(() => expect(c.closed()).toEqual(UNKNOWN_CLOSE), { timeout: 8_000 });
      expectUnknownThenCompatibilityCue(c.controls());
      // A read-only socket is told and stays connected.
      await vi.waitFor(() => expect(viewer.controls()).toContain('commit_unknown'), { timeout: 8_000 });
      expect(viewer.closed()).toBeNull();

      // Frames sent afterwards never reach a room document and are not read-only violations.
      const beforeLateFrames = roomHtml(podB, pageId);
      for (let index = 0; index < 12; index += 1) {
        expect(await podB.handleInboundFrame(pageId, c.id, typedFrame(new Y.Doc(), `LATE_FRAME_${index}`)))
          .toBe('dropped');
      }
      expect(roomHtml(podB, pageId)).toBe(beforeLateFrames);
      expect(roomHtml(podB, pageId)).not.toContain('LATE_');
      expect(roomHtml(defaultRuntime(), pageId)).not.toContain('LATE_');
      expect(readonlyDrops(info)).toBe(0);

      // Per-socket liveness is gone for every demoted writer; each room keeps its own.
      await vi.waitFor(async () => {
        const members = await activeMembers(pageId);
        expect(members.length).toBeGreaterThan(0);
        expect(members.filter((member) => !member.endsWith(':room'))).toEqual([]);
      }, { timeout: 8_000 });

      // A join is attached read-only, told `commit_unknown`, never admitted, and takes no admission.
      const admissionsBefore = await admissionRows(pageId);
      const late = await joinTab(pageId, seed.coEditor.token);
      expect(late.outcome).toBe('commit_unknown');
      expectUnknownThenCompatibilityCue(controlTypes(late.tab));
      expect(controlTypes(late.tab)).not.toContain('writable_admission');
      expect(late.tab.closeInfo).toBeNull();
      const podC = await otherRuntime('unknown-pod-c');
      const fresh = await attachFake(podC, seed, 'pod-c-join');
      expect(fresh.attached.writable).toBe(false);
      expectUnknownThenCompatibilityCue(fresh.socket.controls());
      expect(fresh.socket.controls()).not.toContain('writable_admission');
      expect(fresh.socket.closed()).toBeNull();
      expect(podC.getRoom(pageId)?.admission ?? null).toBeNull();
      expect(await admissionRows(pageId)).toEqual(admissionsBefore);
      expect(readonlyDrops(info)).toBe(0);
    },
    30_000,
  );

  describe('after the intent is settled', () => {
    async function failedPlainSave(): Promise<{ seed: Seed; intentId: string; published: { title: string; storage: string } }> {
      const seed = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      mockRemoteRead(seed.confluenceId);
      const published = { title: '', storage: '' };
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async (_id, title, storage) => {
        published.title = title;
        published.storage = storage;
        throw new Error('socket hang up after the request was written');
      });
      expect((await save(seed)).statusCode).toBe(500);
      expect(await a.closed).toEqual(UNKNOWN_CLOSE);
      const intentId = await pendingIntentId(seed.pageId);
      const gated = await joinTab(seed.pageId, seed.coEditor.token);
      expect(gated.outcome).toBe('commit_unknown');
      return { seed, intentId, published };
    }

    /** A tab reconnects on a 1001 close, as y-websocket does; the join after settlement must end writable. */
    async function joinAfterSettlement(seed: Seed): Promise<Tab> {
      for (let attempt = 0; ; attempt += 1) {
        const { tab, outcome } = await joinTab(seed.pageId, seed.coEditor.token);
        if (outcome !== 'closed' || attempt >= 3) {
          expect(outcome).toBe('writable');
          expect(controlTypes(tab)).not.toContain('commit_unknown');
          return tab;
        }
        expect(tab.closeInfo?.code).toBe(1001);
      }
    }

    it.each([
      ['reconciled_applied', true],
      ['reconciled_not_applied', false],
    ] as const)('admits a new join writable once reconciliation settles it %s', async (status, applied) => {
      const { seed, intentId, published } = await failedPlainSave();
      const admin = await createUser(`cu_admin_${entropy()}`, 'admin');
      // The pod that ran the Save was terminated and fenced; another pod reconciles.
      const terminated = await insertTestRuntime({ fenced: true });
      await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1', [intentId, terminated]);
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockResolvedValue(remotePage(
        seed.confluenceId,
        5,
        applied ? published.title : 'Somebody else',
        applied ? published.storage : '<p>another writer took version 5</p>',
      ) as never);

      const reconciled = await app.inject({
        method: 'POST',
        url: `/api/admin/page-write-recovery/intents/${intentId}/reconcile`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { reason: 'Settle the collaborative Save whose outcome was unknown' },
      });

      expect(reconciled.statusCode, reconciled.body).toBe(200);
      expect(reconciled.json()).toEqual({ intentId, status });
      expect(await durableState(seed.pageId)).toEqual({ state: 'none' });
      const tab = await joinAfterSettlement(seed);
      // Writable in fact: an edit of the new tab reaches its room.
      tab.ws.send(typedFrame(tab.doc, 'AFTER_SETTLEMENT'));
      await vi.waitFor(() => {
        expect(roomHtml(defaultRuntime(), seed.pageId)).toContain('AFTER_SETTLEMENT');
      }, { timeout: 8_000 });
    }, 30_000);

    it('admits a new join writable once the intent is cancelled', async () => {
      const { seed, intentId } = await failedPlainSave();
      // No code path cancels a dispatched intent today; the state only reads its status.
      await settleBySql(intentId, 'cancelled');

      expect(await durableState(seed.pageId)).toEqual({ state: 'none' });
      const tab = await joinAfterSettlement(seed);
      tab.ws.send(typedFrame(tab.doc, 'AFTER_CANCEL'));
      await vi.waitFor(() => {
        expect(roomHtml(defaultRuntime(), seed.pageId)).toContain('AFTER_CANCEL');
      }, { timeout: 8_000 });
    });

    it('ignores a delayed or repeated cue after settlement and during a later healthy Save', async () => {
      const { seed, intentId } = await failedPlainSave();
      await settleBySql(intentId, 'reconciled_not_applied');
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const b = await joinAfterSettlement(seed);
      const podB = await otherRuntime('unknown-late-cue');

      // The settled Save's cue arrives late, locally and over the bus.
      await deliverCue(defaultRuntime(), seed.pageId, intentId);
      await deliverCue(podB, seed.pageId, intentId);

      expect(defaultRuntime().getRoom(seed.pageId)?.unknownCommitIntentId).toBeNull();
      b.ws.send(typedFrame(b.doc, 'AFTER_LATE_CUE'));
      expect(await tabSees(a, 'AFTER_LATE_CUE')).toBe(true);

      // A later Save is in flight when the old cue is repeated: it names another intent.
      const put = gatePut(seed.confluenceId);
      const saving = save(seed);
      await put.started;
      await deliverCue(defaultRuntime(), seed.pageId, intentId);
      a.ws.send(typedFrame(a.doc, 'DURING_LATER_SAVE'));
      expect(await tabSees(b, 'DURING_LATER_SAVE')).toBe(true);
      put.succeed();
      expect((await saving).statusCode).toBe(200);

      for (const tab of [a, b]) {
        expect(tab.closeInfo).toBeNull();
        expect(controlTypes(tab)).not.toContain('commit_unknown');
      }
    }, 30_000);
  });

  describe('does not trigger', () => {
    /** Both tabs are still writable: no control, no close, edits flow, and a new join is admitted. */
    async function expectRoomStillWritable(seed: Seed, a: Tab, b: Tab, marker: string): Promise<void> {
      expect(await durableState(seed.pageId)).toEqual({ state: 'none' });
      expect((await commitIntents(seed.pageId)).filter((intent) => intent.marked)).toEqual([]);
      b.ws.send(typedFrame(b.doc, marker));
      expect(await tabSees(a, marker)).toBe(true);
      const joined = await joinWritable(seed.pageId, seed.coEditor.token);
      for (const tab of [a, b, joined]) {
        expect(tab.closeInfo).toBeNull();
        expect(controlTypes(tab)).not.toContain('commit_unknown');
      }
      expect(await getRedisClient()!.get(collabCommitUnknownKey(seed.pageId))).toBeNull();
    }

    it('for a failure before dispatch', async () => {
      const seed = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const b = await joinWritable(seed.pageId, seed.coEditor.token);
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockRejectedValue(
        new ConfluenceError('Confluence unavailable', 503),
      );
      const put = acceptPut(seed.confluenceId);

      const response = await save(seed);

      expect(response.statusCode).toBe(503);
      expect(put).not.toHaveBeenCalled();
      expect(await commitIntents(seed.pageId)).toEqual([]);
      await expectRoomStillWritable(seed, a, b, 'AFTER_PRE_DISPATCH_FAILURE');
    });

    it('for a reservation cancelled before any remote effect', async () => {
      const seed = await seedPage({ media: true });
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const b = await joinWritable(seed.pageId, seed.coEditor.token);
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
        // The planned bytes change before the reservation prepares them.
        await fs.promises.writeFile(
          path.join(process.env.ATTACHMENTS_DIR!, 'local-src', 'pasted.png'),
          Buffer.from('bytes changed after planning'),
        );
        return remotePage(seed.confluenceId, 4) as never;
      });
      const upload = acceptUpload();
      const put = acceptPut(seed.confluenceId);

      const response = await save(seed);

      expect(response.statusCode).toBe(409);
      expect(response.json().reason).toBe('pasted_image_unavailable');
      expect(upload).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(await commitIntents(seed.pageId)).toMatchObject([{ status: 'cancelled', started: false, marked: false }]);
      await expectRoomStillWritable(seed, a, b, 'AFTER_CANCELLED_RESERVATION');
    });

    it('for the version check before dispatch (409 confluence_modified)', async () => {
      const seed = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const b = await joinWritable(seed.pageId, seed.coEditor.token);
      mockRemoteRead(seed.confluenceId, [7]);
      const put = acceptPut(seed.confluenceId);

      const response = await save(seed);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'confluence_modified', remoteVersion: 7, localVersion: 4 });
      // Before dispatch the session really is still open.
      expect(response.json().message).toMatch(/session is still open/i);
      expect(put).not.toHaveBeenCalled();
      expect(await commitIntents(seed.pageId)).toEqual([]);
      await expectRoomStillWritable(seed, a, b, 'AFTER_VERSION_CHECK');
    });

    it('for a failure after the terminal result was recorded', async () => {
      const seed = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const b = await joinWritable(seed.pageId, seed.coEditor.token);
      mockRemoteRead(seed.confluenceId);
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async (_id, title, storage) => {
        // Confluence accepts the page; the saver loses access before the local publication.
        await query(
          `DELETE FROM space_role_assignments
            WHERE space_key = $1 AND principal_type = 'user' AND principal_id = $2`,
          [seed.spaceKey, seed.saver.userId],
        );
        return remotePage(seed.confluenceId, 5, title, storage) as never;
      });

      const response = await save(seed);

      expect(response.statusCode).toBe(409);
      expect(response.json().reason).toBe('intent_actor_authority_unavailable');
      const intents = await commitIntents(seed.pageId);
      expect(intents).toMatchObject([{ status: 'pending', started: true, marked: false }]);
      expect(intents[0]!.terminal).not.toBeNull();
      await expectRoomStillWritable(seed, a, b, 'AFTER_TERMINAL_RESULT');
    });

    it('for another page\'s failed commit, nor for a foreign pending intent of this page', async () => {
      const seed = await seedPage();
      const other = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const b = await joinWritable(seed.pageId, seed.coEditor.token);
      // Another page's Save failed after dispatch and was declared unknown.
      mockRemoteRead(other.confluenceId);
      failPut();
      const otherTab = await joinWritable(other.pageId, other.saver.token);
      expect((await save(other)).statusCode).toBe(500);
      expect(await otherTab.closed).toEqual(UNKNOWN_CLOSE);
      expect(await durableState(other.pageId)).toMatchObject({ state: 'unknown' });

      await expectRoomStillWritable(seed, a, b, 'BESIDE_ANOTHER_PAGES_FAILURE');

      // A dispatched ordinary save of this page is not this page's own collaborative commit.
      const foreign = await reservePageWriteIntent({
        pageIds: [seed.pageId],
        kind: 'pages.update.confluence',
        actorId: seed.saver.userId,
        effect: { effectClass: 'remote' },
      });
      await expect(runPageWriteIntentEffect(
        foreign,
        { kind: 'remote', completesRemoteWork: true },
        async () => { throw new Error('ordinary save lost its response'); },
      )).rejects.toThrow('ordinary save lost its response');
      expect(await durableState(seed.pageId)).toEqual({ state: 'none' });
      // The existing foreign-intent fence closes the writer; it is not told `commit_unknown`.
      b.ws.send(typedFrame(b.doc, 'BEHIND_FOREIGN_INTENT'));
      expect(await b.closed).toEqual({ code: 1001, reason: 'collab_validation_unavailable' });
      expect(controlTypes(b)).not.toContain('commit_unknown');
      expect(controlTypes(a)).not.toContain('commit_unknown');
    }, 30_000);

    it('for an ordinary flush failure of the room', async () => {
      const seed = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const b = await joinWritable(seed.pageId, seed.coEditor.token);
      const room = defaultRuntime().getRoom(seed.pageId)!;
      await query(`ALTER TABLE page_collaborative_docs
        ADD CONSTRAINT collab_test_reject_flush CHECK (FALSE) NOT VALID`);
      try {
        b.ws.send(typedFrame(b.doc, 'BEFORE_FAILED_FLUSH'));
        expect(await tabSees(a, 'BEFORE_FAILED_FLUSH')).toBe(true);
        await expect(persist.flushCollabPersist(room)).rejects.toMatchObject({ code: '23514' });
      } finally {
        await query('ALTER TABLE page_collaborative_docs DROP CONSTRAINT collab_test_reject_flush');
      }

      await expectRoomStillWritable(seed, a, b, 'AFTER_FAILED_FLUSH');
    });

    it.each([
      ['the page update', false],
      ['an upload (.media)', true],
    ] as const)('while a healthy Save is in flight in %s: joins and frames stay writable', async (_phase, media) => {
      const seed = await seedPage({ media });
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const b = await joinWritable(seed.pageId, seed.coEditor.token);
      mockRemoteRead(seed.confluenceId);
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      if (media) {
        vi.spyOn(ConfluenceClient.prototype, 'updateAttachment').mockImplementation(async (_id, filename) => {
          started.resolve();
          await gate.promise;
          return {
            id: 'attachment-1', title: filename, mediaType: 'image/png',
            version: { number: 1, when: '2026-11-24T00:00:01Z' },
          } as never;
        });
        acceptPut(seed.confluenceId);
      } else {
        vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async (_id, title, storage) => {
          started.resolve();
          await gate.promise;
          return remotePage(seed.confluenceId, 5, title, storage) as never;
        });
      }
      const saving = save(seed);
      try {
        await started.promise;
        expect(await durableState(seed.pageId)).toMatchObject({ state: 'in_flight' });

        b.ws.send(typedFrame(b.doc, 'DURING_HEALTHY_SAVE'));
        expect(await tabSees(a, 'DURING_HEALTHY_SAVE')).toBe(true);
        const joined = await joinWritable(seed.pageId, seed.coEditor.token);
        joined.ws.send(typedFrame(joined.doc, 'JOINED_DURING_HEALTHY_SAVE'));
        expect(await tabSees(a, 'JOINED_DURING_HEALTHY_SAVE')).toBe(true);

        gate.resolve();
        expect((await saving).statusCode).toBe(200);
        for (const tab of [a, b, joined]) {
          expect(tab.closeInfo).toBeNull();
          expect(controlTypes(tab)).not.toContain('commit_unknown');
        }
        expect((await commitIntents(seed.pageId)).filter((intent) => intent.marked)).toEqual([]);
      } finally {
        gate.resolve();
        await saving;
      }
    }, 30_000);
  });

  describe('while the marker is not recorded', () => {
    /**
     * A Save on the default runtime fails after dispatch while its marker
     * cannot be recorded and every cue is lost on the bus.
     */
    async function failSaveWithUnrecordedMarker(seed: Seed): Promise<{
      intentId: string;
      releaseMarker: () => Promise<void>;
      cues: { dropped: () => number };
    }> {
      vi.stubEnv('COLLAB_COMMIT_MARKER_DEADLINE_MS', '150');
      vi.stubEnv('COLLAB_COMMIT_MARKER_RETRY_MS', '100');
      const cues = dropCommitUnknownCues();
      mockRemoteRead(seed.confluenceId);
      let releaseMarker: (() => Promise<void>) | undefined;
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async () => {
        releaseMarker = await blockMarker(await pendingIntentId(seed.pageId));
        throw new Error('socket hang up after the request was written');
      });
      expect((await save(seed)).statusCode).toBe(500);
      const intents = await commitIntents(seed.pageId);
      expect(intents).toMatchObject([{ status: 'pending', started: true, marked: false }]);
      return { intentId: intents[0]!.id, releaseMarker: releaseMarker!, cues };
    }

    it('fences the owner from its own memory at once, for frames and for joins', async () => {
      const seed = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const owner = (await attachFake(defaultRuntime(), seed, 'owner-idle-writer')).socket;

      const { intentId } = await failSaveWithUnrecordedMarker(seed);

      // The durable row still reads like a Save in flight.
      expect(await durableState(seed.pageId)).toEqual({ state: 'in_flight', intentId });
      expect(await a.closed).toEqual(UNKNOWN_CLOSE);
      await vi.waitFor(() => expect(owner.closed()).toEqual(UNKNOWN_CLOSE), { timeout: 8_000 });
      const late = await joinTab(seed.pageId, seed.coEditor.token);
      expect(late.outcome).toBe('commit_unknown');
      expect(controlTypes(late.tab)).not.toContain('writable_admission');
    });

    it('fences a pod that missed the cue through the Redis key: its writable socket on the next frame, and new joins', async () => {
      const seed = await seedPage();
      await joinWritable(seed.pageId, seed.saver.token);
      const pod = await otherRuntime('unknown-reads-redis');
      const writer = (await attachFake(pod, seed, 'redis-pod-writer')).socket;
      const info = vi.spyOn(logger, 'info');

      const { intentId, cues } = await failSaveWithUnrecordedMarker(seed);

      expect(cues.dropped()).toBeGreaterThan(0);
      expect(await getRedisClient()!.get(collabCommitUnknownKey(seed.pageId))).toBe(intentId);
      // PostgreSQL still answers `in_flight`; the key names the same intent.
      expect(await durableState(seed.pageId)).toEqual({ state: 'in_flight', intentId });
      expect(writer.closed()).toBeNull();

      expect(await pod.handleInboundFrame(seed.pageId, writer.id, typedFrame(new Y.Doc(), 'AFTER_MISSED_CUE')))
        .toBe('dropped');
      expect(writer.closed()).toEqual(UNKNOWN_CLOSE);
      expectUnknownThenCompatibilityCue(writer.controls());
      expect(roomHtml(pod, seed.pageId)).not.toContain('AFTER_MISSED_CUE');
      expect(pod.getRoom(seed.pageId)?.unknownCommitIntentId).toBe(intentId);
      const joined = await attachFake(pod, seed, 'redis-pod-join');
      expect(joined.attached.writable).toBe(false);
      expectUnknownThenCompatibilityCue(joined.socket.controls());
      expect(joined.socket.controls()).not.toContain('writable_admission');
      expect(readonlyDrops(info)).toBe(0);
    });

    it('lets a pod with neither latch read and write until the marker commits, while the retry keeps failing', async () => {
      const seed = await seedPage();
      await joinWritable(seed.pageId, seed.saver.token);
      // Cue missed and key unreadable: this pod has no way to know yet.
      const pod = await otherRuntime('unknown-no-latch', anotherProcess(async () => null));
      const writer = (await attachFake(pod, seed, 'blind-pod-writer')).socket;

      const { intentId, releaseMarker, cues } = await failSaveWithUnrecordedMarker(seed);

      expect(await pod.handleInboundFrame(seed.pageId, writer.id, typedFrame(new Y.Doc(), 'BEFORE_MARKER')))
        .toBe('ok');
      expect(roomHtml(pod, seed.pageId)).toContain('BEFORE_MARKER');
      const early = await attachFake(pod, seed, 'blind-pod-join');
      expect(early.attached.writable).toBe(true);
      expect(early.socket.controls()).toContain('writable_admission');
      // The background retry repeats the cue and keeps failing; nothing is settled.
      const cuesAfterSave = cues.dropped();
      await vi.waitFor(() => expect(cues.dropped()).toBeGreaterThanOrEqual(cuesAfterSave + 3), { timeout: 10_000 });
      expect(await commitIntents(seed.pageId)).toMatchObject([{ id: intentId, status: 'pending', marked: false }]);
      expect(writer.closed()).toBeNull();

      await releaseMarker();
      await vi.waitFor(async () => {
        expect(await durableState(seed.pageId)).toEqual({ state: 'unknown', intentId });
      }, { timeout: 10_000 });

      // From the committed marker on, the same pod is fenced without any latch.
      expect(await pod.handleInboundFrame(seed.pageId, writer.id, typedFrame(new Y.Doc(), 'AFTER_MARKER')))
        .toBe('dropped');
      expect(roomHtml(pod, seed.pageId)).not.toContain('AFTER_MARKER');
      expect(writer.closed()).toEqual(UNKNOWN_CLOSE);
      const joined = await attachFake(pod, seed, 'blind-pod-late-join');
      expect(joined.attached.writable).toBe(false);
      expectUnknownThenCompatibilityCue(joined.socket.controls());
    }, 30_000);

    it('publishes the cue although the release of the Save\'s request admission was deferred', async () => {
      const seed = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const b = await joinWritable(seed.pageId, seed.coEditor.token);
      mockRemoteRead(seed.confluenceId);
      const holder = await getPool().connect();
      onTestFinished(async () => {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      });
      let holderPid = 0;
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async () => {
        // The request admission's row is held, so its release cannot commit.
        await holder.query('BEGIN');
        const request = await holder.query<{ pid: number }>(
          `SELECT pg_backend_pid() AS pid FROM page_runtime_admissions
            WHERE page_id = $1 AND purpose = 'collab_request' AND released_at IS NULL
            FOR UPDATE`,
          [seed.pageId],
        );
        expect(request.rows).toHaveLength(1);
        holderPid = request.rows[0]!.pid;
        throw new Error('socket hang up after the request was written');
      });
      const warn = vi.spyOn(logger, 'warn');

      const saving = save(seed);
      let releasePid: number | undefined;
      expect(await waitForDatabaseCondition(async () => {
        if (holderPid === 0) return false;
        const blocked = await query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        );
        releasePid = blocked.rows[0]?.pid;
        return releasePid !== undefined;
      })).toBe(true);
      // The marker is already proven; only the release is stuck. Its connection dies.
      expect(await commitIntents(seed.pageId)).toMatchObject([{ status: 'pending', marked: true }]);
      await query('SELECT pg_terminate_backend($1)', [releasePid]);
      expect((await saving).statusCode).toBe(500);

      expect(warn.mock.calls.some((call) => String(call[1]).includes('request cleanup deferred'))).toBe(true);
      for (const tab of [a, b]) {
        expect(await tab.closed).toEqual(UNKNOWN_CLOSE);
        expectUnknownThenCompatibilityCue(controlTypes(tab));
      }
      // The deferred cleanup still releases the request admission later.
      await holder.query('ROLLBACK');
      await vi.waitFor(async () => {
        const request = (await admissionRows(seed.pageId)).filter((row) => row.purpose === 'collab_request');
        expect(request).toMatchObject([{ released: true }]);
      }, { timeout: 10_000 });
    }, 30_000);
  });

  describe('barrier', () => {
    /** Pause the next join of `socketId` on `podId` at its Redis bookkeeping, the last step before the final one. */
    function pauseJoinAtBookkeeping(podId: string, socketId: string) {
      const redis = getRedisClient()!;
      const sAdd = redis.sAdd.bind(redis);
      const reached = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      vi.spyOn(redis, 'sAdd').mockImplementation((async (key: string, member: string) => {
        if (member === `${podId}:${socketId}`) {
          reached.resolve();
          await resume.promise;
        }
        return sAdd(key, member);
      }) as typeof redis.sAdd);
      return { reached: reached.promise, resume: () => resume.resolve() };
    }

    it('gates a join whose final step runs after the marker committed, although it was admitted before', async () => {
      const seed = await seedPage();
      await joinWritable(seed.pageId, seed.saver.token);
      const pod = await otherRuntime('unknown-final-step');
      // A first writer gives this pod its room and admission.
      await attachFake(pod, seed, 'final-step-first');
      mockRemoteRead(seed.confluenceId);
      const put = gatePut(seed.confluenceId);
      const saving = save(seed);
      await put.started;
      const paused = pauseJoinAtBookkeeping('unknown-final-step', 'final-step-join');
      const joining = attachFake(pod, seed, 'final-step-join');
      await paused.reached;

      // The Save fails and its marker commits while the join waits before its final step.
      put.fail();
      expect((await saving).statusCode).toBe(500);
      expect(await durableState(seed.pageId)).toMatchObject({ state: 'unknown' });
      paused.resume();
      const { socket, attached } = await joining;

      expect(attached.writable).toBe(false);
      expect(socket.controls()).not.toContain('writable_admission');
      expectUnknownThenCompatibilityCue(socket.controls());
      // Attached read-only, and it holds no liveness member.
      expect(socket.closed()).toBeNull();
      expect(pod.getRoom(seed.pageId)!.sockets.has('final-step-join')).toBe(true);
      await vi.waitFor(async () => {
        expect(await activeMembers(seed.pageId)).not.toContain('unknown-final-step:final-step-join');
      });
      expect(await pod.handleInboundFrame(seed.pageId, 'final-step-join', typedFrame(new Y.Doc(), 'GATED_JOIN')))
        .toBe('dropped');
      expect(roomHtml(pod, seed.pageId)).not.toContain('GATED_JOIN');
    }, 30_000);

    it('writes no positive cue for a socket that left while the final step waited for the lifecycle lock', async () => {
      const seed = await seedPage();
      const pod = await otherRuntime('unknown-final-check');
      await attachFake(pod, seed, 'final-check-first');
      const paused = pauseJoinAtBookkeeping('unknown-final-check', 'final-check-join');
      const joining = attachFake(pod, seed, 'final-check-join');
      await paused.reached;
      const lock = await holdLifecycleLock(seed.pageId);
      paused.resume();
      // The final transaction is queued behind the lock; the socket leaves meanwhile.
      expect(await lock.waiters(1)).toBe(true);
      void pod.detachSocket(seed.pageId, 'final-check-join');
      await lock.release();
      const { socket, attached } = await joining;

      expect(attached.writable).toBe(false);
      expect(socket.controls()).not.toContain('writable_admission');
      expect(pod.getRoom(seed.pageId)?.sockets.has('final-check-join') ?? false).toBe(false);
      await vi.waitFor(async () => {
        expect(await activeMembers(seed.pageId)).not.toContain('unknown-final-check:final-check-join');
      });
    }, 30_000);

    it('fences a socket on its next frame when the cue was dropped', async () => {
      const seed = await seedPage();
      await joinWritable(seed.pageId, seed.saver.token);
      const pod = await otherRuntime('unknown-dropped-cue');
      const writer = (await attachFake(pod, seed, 'dropped-cue-writer')).socket;
      const idle = (await attachFake(pod, seed, 'dropped-cue-idle')).socket;
      const cues = dropCommitUnknownCues();
      mockRemoteRead(seed.confluenceId);
      failPut();
      const info = vi.spyOn(logger, 'info');

      expect((await save(seed)).statusCode).toBe(500);

      expect(cues.dropped()).toBeGreaterThan(0);
      expect(await durableState(seed.pageId)).toMatchObject({ state: 'unknown' });
      expect(writer.closed()).toBeNull();
      expect(await pod.handleInboundFrame(seed.pageId, writer.id, typedFrame(new Y.Doc(), 'AFTER_DROPPED_CUE')))
        .toBe('dropped');
      expect(writer.closed()).toEqual(UNKNOWN_CLOSE);
      expectUnknownThenCompatibilityCue(writer.controls());
      expect(roomHtml(pod, seed.pageId)).not.toContain('AFTER_DROPPED_CUE');
      // The refused frame prompts the room to demote its other writers too.
      await vi.waitFor(() => expect(idle.closed()).toEqual(UNKNOWN_CLOSE), { timeout: 8_000 });
      expect(readonlyDrops(info)).toBe(0);
    });

    it('refuses frames that were already queued locally when the Save failed, before the marker commits', async () => {
      const seed = await seedPage();
      const runtime = defaultRuntime();
      const writer = (await attachFake(runtime, seed, 'queued-writer')).socket;
      mockRemoteRead(seed.confluenceId);
      const put = gatePut(seed.confluenceId);
      const saving = save(seed);
      await put.started;
      const lock = await holdLifecycleLock(seed.pageId);
      const first = runtime.handleInboundFrame(seed.pageId, writer.id, typedFrame(new Y.Doc(), 'QUEUED_FIRST'));
      const second = runtime.handleInboundFrame(seed.pageId, writer.id, typedFrame(new Y.Doc(), 'QUEUED_SECOND'));
      expect(await lock.waiters(2)).toBe(true);

      // The Save fails: its marker transaction queues behind both frames.
      put.fail();
      expect(await lock.waiters(3)).toBe(true);
      await lock.release();

      // The frames ran first, read a commit still in flight, and were refused by the owner's own latch.
      expect(await first).toBe('dropped');
      expect(await second).toBe('dropped');
      expect((await saving).statusCode).toBe(500);
      expect(roomHtml(runtime, seed.pageId)).not.toContain('QUEUED_');
      expect(writer.closed()).toEqual(UNKNOWN_CLOSE);
      expect(await commitIntents(seed.pageId)).toMatchObject([{ status: 'pending', marked: true }]);
    }, 30_000);

    it('still converges on an edit a peer pod accepted before the marker', async () => {
      const seed = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      const pod = await otherRuntime('unknown-peer-edit');
      await attachFake(pod, seed, 'peer-writer');
      mockRemoteRead(seed.confluenceId);
      failPut();
      expect((await save(seed)).statusCode).toBe(500);
      expect(await a.closed).toEqual(UNKNOWN_CLOSE);

      // The peer's room publishes an update it had accepted under its fence.
      const accepted = new Y.Doc();
      typedFrame(accepted, 'ACCEPTED_ON_PEER');
      Y.applyUpdate(pod.getRoom(seed.pageId)!.doc, Y.encodeStateAsUpdate(accepted), 'accepted-before-marker');

      await vi.waitFor(() => {
        expect(roomHtml(defaultRuntime(), seed.pageId)).toContain('ACCEPTED_ON_PEER');
      }, { timeout: 8_000 });
    });

    it('keeps the pre-live buffer order for a gated join and counts none of its frames as a violation', async () => {
      const seed = await seedPage();
      const a = await joinWritable(seed.pageId, seed.saver.token);
      mockRemoteRead(seed.confluenceId);
      failPut();
      expect((await save(seed)).statusCode).toBe(500);
      expect(await a.closed).toEqual(UNKNOWN_CLOSE);
      const info = vi.spyOn(logger, 'info');

      // y-websocket's SyncStep1 and an edit typed offline arrive before the join completes.
      const tab = openTab(seed.pageId, seed.coEditor.token, seed.revision, {
        preLive: (opened) => [encodeSyncStep1(opened.doc), typedFrame(new Y.Doc(), 'PRELIVE_EDIT')],
      });

      expect(await tab.outcome).toBe('commit_unknown');
      // The buffered SyncStep1 is answered; the buffered edit is dropped.
      await tab.synced;
      expect(tab.closeInfo).toBeNull();
      expect(yDocToHtml(tab.doc)).toContain('commit-unknown-seed');
      expect(roomHtml(defaultRuntime(), seed.pageId)).not.toContain('PRELIVE_EDIT');
      expect(readonlyDrops(info)).toBe(0);
    });
  });

  describe('orphaned upload continuation', () => {
    /** The upload completes, then the Save is refused before its page update. */
    function refuseAfterUpload(seed: Seed): void {
      mockRemoteRead(seed.confluenceId);
      vi.spyOn(ConfluenceClient.prototype, 'updateAttachment').mockImplementation(async (_id, filename) => {
        await query(
          `DELETE FROM space_role_assignments
            WHERE space_key = $1 AND principal_type = 'user' AND principal_id = $2`,
          [seed.spaceKey, seed.saver.userId],
        );
        return {
          id: 'attachment-1', title: filename, mediaType: 'image/png',
          version: { number: 1, when: '2026-11-24T00:00:01Z' },
        } as never;
      });
    }

    it.each([
      ['a pod that hosts the room', true],
      ['a pod without the room', false],
    ] as const)('no longer holds the drain of %s once the marker is proven', async (_owner, hostsRoom) => {
      const seed = await seedPage({ media: true });
      if (hostsRoom) {
        await joinWritable(seed.pageId, seed.saver.token);
      } else {
        const pod = await otherRuntime('unknown-orphan-room');
        await attachFake(pod, seed, 'orphan-room-writer', { userId: seed.saver.userId });
      }
      refuseAfterUpload(seed);
      const put = acceptPut(seed.confluenceId);

      const response = await save(seed);

      expect(response.statusCode, response.body).toBe(403);
      expect(put).not.toHaveBeenCalled();
      expect(Boolean(defaultRuntime().getRoom(seed.pageId)?.admission)).toBe(hostsRoom);
      const intents = await commitIntents(seed.pageId);
      expect(intents).toMatchObject([{
        kind: 'collab.commit.confluence.media', status: 'pending', started: true, marked: true, terminal: null,
      }]);
      // The finished upload's continuation was retired: this runtime's drain no longer waits for the intent.
      expect(pageWriteIntentHoldsDrain(intents[0]!.id)).toBe(false);
    });

    it('still holds the drain for a healthy upload whose page update is running', async () => {
      const seed = await seedPage({ media: true });
      await joinWritable(seed.pageId, seed.saver.token);
      mockRemoteRead(seed.confluenceId);
      acceptUpload();
      let holdsDuringUpdate: boolean | undefined;
      let intentId = '';
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async (_id, title, storage) => {
        intentId = await pendingIntentId(seed.pageId);
        holdsDuringUpdate = pageWriteIntentHoldsDrain(intentId);
        return remotePage(seed.confluenceId, 5, title, storage) as never;
      });

      expect((await save(seed)).statusCode).toBe(200);

      expect(holdsDuringUpdate).toBe(true);
      expect(await commitIntents(seed.pageId)).toMatchObject([{ status: 'completed', marked: false }]);
      expect(pageWriteIntentHoldsDrain(intentId)).toBe(false);
    });
  });

  it('brings a client that ignores commit_unknown to its read-only draft through permission_loss, without a reconnect', async () => {
    const seed = await seedPage();
    // What a bundle that predates #2035 does with controls: `permission_loss`
    // preserves the document and disconnects; an unknown control does nothing.
    const doc = new Y.Doc();
    const controls: string[] = [];
    const statuses: string[] = [];
    let readOnlyReason: string | null = null;
    const provider = new WebsocketProvider(`${baseWs}/api/collab`, String(seed.pageId), doc, {
      protocols: [COLLAB_WS_PROTOCOL, seed.coEditor.token],
      params: { expectedLifecycleRevision: seed.revision },
      disableBc: true,
    });
    onTestFinished(() => {
      provider.destroy();
      doc.destroy();
    });
    provider.messageHandlers[MESSAGE_CONTROL] = (_encoder, decoder) => {
      const control = JSON.parse(decoding.readVarString(decoder)) as Control;
      controls.push(control.type);
      if (control.type === 'permission_loss' && readOnlyReason === null) {
        readOnlyReason = 'permission_loss';
        provider.disconnect();
      }
    };
    provider.on('status', ({ status }: { status: string }) => { statuses.push(status); });
    await vi.waitFor(() => {
      expect(provider.synced).toBe(true);
      expect(controls).toContain('writable_admission');
    }, { timeout: 10_000 });
    typedFrame(doc, 'OLD_BUNDLE_DRAFT');
    await vi.waitFor(() => {
      expect(roomHtml(defaultRuntime(), seed.pageId)).toContain('OLD_BUNDLE_DRAFT');
    }, { timeout: 8_000 });
    mockRemoteRead(seed.confluenceId);
    failPut();

    expect((await save(seed)).statusCode).toBe(500);

    await vi.waitFor(() => expect(readOnlyReason).toBe('permission_loss'), { timeout: 8_000 });
    expectUnknownThenCompatibilityCue(controls);
    await vi.waitFor(() => expect(provider.wsconnected).toBe(false), { timeout: 8_000 });
    // Disconnected for good, with its document intact: the draft it can download.
    expect(provider.shouldConnect).toBe(false);
    // The listener was attached after the first connection began: none followed it.
    expect(statuses).not.toContain('connecting');
    expect(yDocToHtml(doc)).toContain('OLD_BUNDLE_DRAFT');
    // Nothing reconnected behind the close: the room has no writer left.
    await vi.waitFor(() => {
      expect([...defaultRuntime().getRoom(seed.pageId)!.sockets.values()].filter((socket) => socket.writable))
        .toEqual([]);
    }, { timeout: 8_000 });
  });

  it('declares nothing for another kind of intent through the same procedure', async () => {
    // The marker statement names the collaborative commit kinds: an ordinary
    // save that lost its response is never marked, whoever asks.
    const seed = await seedPage();
    const foreign = await reservePageWriteIntent({
      pageIds: [seed.pageId],
      kind: 'pages.update.confluence',
      actorId: seed.saver.userId,
      effect: { effectClass: 'remote' },
    });
    await expect(runPageWriteIntentEffect(
      foreign,
      { kind: 'remote', completesRemoteWork: true },
      async () => { throw new Error('ordinary save lost its response'); },
    )).rejects.toThrow('ordinary save lost its response');

    await declareCollabCommitUnknown(foreign, () => undefined).record();

    expect(await commitIntents(seed.pageId)).toMatchObject([{ kind: 'pages.update.confluence', marked: false }]);
    expect(await durableState(seed.pageId)).toEqual({ state: 'none' });
    // Nothing is left to retry, and this process fences nothing for it.
    expect(processCollabCommitLatches.locallyUnknown(foreign.id)).toBe(false);
  });
});
