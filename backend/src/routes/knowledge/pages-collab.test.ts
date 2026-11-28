/**
 * Integration tests for GET /api/collab/:pageId (#1444).
 *
 * Real Postgres (:5433) + real Redis. Mock only outbound HTTP/DNS.
 * A WHATWG-shaped client (globalThis.WebSocket, protocols array, no
 * `unexpected-response`) MUST recover from an expired JWT: 101 then 4401,
 * refresh, second connection syncs. This file fails if the server 401s the
 * handshake (`onRequest authenticate` throw → close 1006).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, onTestFinished } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Socket, type AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import * as jose from 'jose';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebSocket as NodeWs } from 'ws';
import pg from 'pg';
import { WebsocketProvider } from 'y-websocket';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
// Cross-workspace import, on purpose (#2036): the Rejoin attempt is frontend
// code (`useCollabProvider` runs it), and these live-room tests must run that
// very code against the real gateway, not a copy. Running this file therefore
// needs the full monorepo checkout (`frontend/src` next to `backend/`) and the
// root `npm ci`; the backend build and image never compile tests.
import { createRejoinController } from '../../../../frontend/src/features/pages/collab-rejoin-attempt.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { PAGE_LIFECYCLE_LOCK_KEY } from '../../core/db/advisory-locks.js';
import { buildApp } from '../../app.js';
import { generateAccessToken, generateRefreshToken, revokeAllUserTokens } from '../../core/plugins/auth.js';
import { logger } from '../../core/utils/logger.js';
import {
  COLLAB_DOC_EMPTY_MARKER,
  COLLAB_DOC_REPLAY_SAFE,
  COLLAB_UPGRADE_WINDOW_SEC,
  COLLAB_WS_PROTOCOL,
  CollabDocEpochControlSchema,
  type CollabCommit,
} from '@compendiq/contracts';
import { isCollabEditingEnabled, refreshCollabFlag } from '../../core/services/collab-flag.js';
import { assertNoLiveCollabRoom } from '../../core/services/collab-guard.js';
import { tombstoneCollabRoomAfterCommit } from '../../core/services/collab-tombstone.js';
import {
  _resetCollabRoomsForTest,
  createCollabRuntime,
  getDefaultCollabRuntime,
  COLLAB_ACTIVE_TTL_SEC,
  COLLAB_IMAGE_MARKER_ORIGIN,
  COLLAB_PING_INTERVAL_MS,
  COLLAB_EMPTY_ROOM_GRACE_MS,
  type CollabRuntime,
} from '../../core/services/collab-room-service.js';
import { getRedisClient } from '../../core/services/redis-cache.js';
import * as persist from '../../core/services/collab-persistence.js';
import { yDocToHtml } from '../../core/services/collab-schema.js';
import { MAX_TASK_LIST_NESTING, assignTaskIds, confluenceToHtml, htmlToConfluence } from '../../core/services/content-converter.js';
import { oracleElements, oracleUrlLinks } from '../../core/services/__fixtures__/storage-oracle.js';
import { NO_STORAGE_DERIVATION_FEATURES } from '../../core/services/storage-derivation.js';
import { STORAGE_DERIVATION_BASE_CORPUS } from '../../core/services/__fixtures__/storage-derivation-base-corpus.js';
import {
  NESTED_TASK_LIST_EDITOR_HTML,
  NESTED_TASK_LIST_HTML,
  NESTED_TASK_LIST_PAGE,
} from '../../core/services/__fixtures__/confluence-xhtml.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { ConfluenceClient, ConfluenceError } from '../../domains/confluence/services/confluence-client.js';
import { __internal as sync } from '../../domains/confluence/services/sync-service.js';
import {
  declareCollabCommitUnknown,
  isCollabCommitPending,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
  withPageWriteTransaction,
} from '../../core/services/page-write-admission.js';
import { invalidateCollabDocAfterBodyWrite } from '../../core/services/collab-guard.js';
import { describeCollabCommit } from '../../domains/confluence/services/collab-commit-intent-reconciler.js';
import { seedRestrictionFixture } from './page-restriction.test-helpers.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await isRedisAvailable() : false;
const canRun = dbAvailable && redisAvailable;

const MESSAGE_SYNC = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

let app: FastifyInstance;
const writableSessionRevisions = new WeakMap<object, string>();
const EMPTY_DOCUMENT_STATE = Buffer.from(Y.encodeSnapshot(Y.emptySnapshot)).toString('base64');
let baseWs: string;

async function createUser(
  username: string,
  opts: { admin?: boolean } = {},
): Promise<{ token: string; userId: string }> {
  const role = opts.admin ? 'admin' : 'user';
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', $2) RETURNING id`,
    [username, role],
  );
  const userId = r.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: role as 'user' | 'admin' });
  return { token, userId };
}

async function insertStandalone(opts: {
  ownerId: string;
  visibility?: 'private' | 'shared';
  pageType?: string;
  deleted?: boolean;
  title?: string;
  bodyHtml?: string;
}): Promise<number> {
  const html = opts.bodyHtml ?? '<p></p>';
  const r = await query<{ id: number }>(
    `INSERT INTO pages (
        space_key, title, body_storage, body_html, body_text, version, source, visibility,
        created_by_user_id, page_type, deleted_at, summary_status, quality_status
     ) VALUES ('_standalone', $1, $2, $2, 'x', 1, 'standalone', $3, $4, $5, $6, 'summarized', 'analyzed')
     RETURNING id`,
    [
      opts.title ?? 'Collab page',
      html,
      opts.visibility ?? 'shared',
      opts.ownerId,
      opts.pageType ?? 'page',
      opts.deleted ? new Date() : null,
    ],
  );

  return r.rows[0]!.id;
}
async function pageLifecycleRevision(pageId: number): Promise<string> {
  const state = await query<{ lifecycle_revision: string }>(
    'SELECT lifecycle_revision::text FROM pages WHERE id = $1',
    [pageId],
  );
  const revision = state.rows[0]?.lifecycle_revision;
  if (!revision) throw new Error('collaboration test page is missing');
  return revision;
}

async function insertConfluencePage(opts: {
  spaceKey: string;
  confluenceId: string;
  inheritPerms?: boolean;
  version?: number;
  bodyHtml?: string;
}): Promise<number> {
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ($1, $1)
     ON CONFLICT (space_key) DO NOTHING`,
    [opts.spaceKey],
  );
  const html = opts.bodyHtml ?? '<p></p>';
  const r = await query<{ id: number }>(
    `INSERT INTO pages (
        confluence_id, space_key, title, body_storage, body_html, body_text,
        version, source, visibility, last_synced, inherit_perms
     ) VALUES ($1, $2, 'Conf page', $3, $3, $4, $5, 'confluence', 'shared', NOW(), $6)
     RETURNING id`,
    [opts.confluenceId, opts.spaceKey, html, 'x', opts.version ?? 1, opts.inheritPerms ?? true],
  );
  return r.rows[0]!.id;
}

async function seedConfluenceCredentials(userId: string): Promise<void> {
  await query(
    `UPDATE user_settings SET confluence_url = $2, confluence_pat = $3 WHERE user_id = $1`,
    [userId, 'https://confluence.example.com', encryptPat('test-pat-1448')],
  );
}

async function grantSpaceRead(userId: string, spaceKey: string): Promise<void> {
  await query(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('collab_test_reader', 'Collab Test Reader', FALSE, ARRAY['read'])
     ON CONFLICT (name) DO NOTHING`,
  );
  const roleRes = await query<{ id: number }>(
    "SELECT id FROM roles WHERE name = 'collab_test_reader' LIMIT 1",
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT DO NOTHING`,
    [spaceKey, userId, roleRes.rows[0]!.id],
  );
}
async function openAndSync(pageId: number, token: string): Promise<WebSocket> {
  const ws = await openWritableWhatwg(pageId, token);
  await waitOpen(ws);
  const doc = new Y.Doc();
  await exchangeSyncStep1(ws, doc);
  return ws;
}

async function enableCollabFlag(): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('collab_editing_enabled', '1', NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = '1', updated_at = NOW()`,
  );
  await refreshCollabFlag();
  expect(isCollabEditingEnabled()).toBe(true);
}

async function disableCollabFlag(): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('collab_editing_enabled', '0', NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = '0', updated_at = NOW()`,
  );
  await refreshCollabFlag();
}

async function signExpiredToken(userId: string, username: string, role: 'user' | 'admin'): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  return new jose.SignJWT({ username, role })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setSubject(userId)
    .setIssuer('compendiq')
    .setExpirationTime(Math.floor(Date.now() / 1000) - 30)
    .sign(secret);
}

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, SYNC_UPDATE);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function waitClose(ws: WebSocket, timeoutMs = 8_000): Promise<{ code: number; reason: string; opened: boolean }> {
  return new Promise((resolve, reject) => {
    let opened = false;
    const timer = setTimeout(() => reject(new Error('timeout waiting for websocket close')), timeoutMs);
    ws.addEventListener('open', () => { opened = true; });
    ws.addEventListener('error', () => { /* WHATWG fires this on HTTP 401 handshake */ });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      resolve({ code: ev.code, reason: String(ev.reason ?? ''), opened });
    });
  });
}

function waitOpen(ws: WebSocket, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('timeout waiting for websocket open')), timeoutMs);
    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error('websocket error'));
    });
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
function waitMessage(
  ws: WebSocket,
  accept: (frame: Uint8Array) => boolean = () => true,
  timeoutMs = 8_000,
): Promise<Uint8Array> {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
  const timer = setTimeout(() => reject(new Error('timeout waiting for websocket message')), timeoutMs);
  const finish = (frame: Uint8Array): void => {
    if (!accept(frame)) return;
    clearTimeout(timer);
    ws.removeEventListener('message', onMsg);
    resolve(frame);
  };
  const onMsg = (ev: MessageEvent) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) {
      finish(new Uint8Array(data));
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.arrayBuffer().then((buf) => finish(new Uint8Array(buf)), reject);
      return;
    }
    if (typeof data === 'string') finish(new TextEncoder().encode(data));
  };
  ws.addEventListener('message', onMsg);
  return promise;
}

function waitSyncStep2(ws: WebSocket, timeoutMs = 8_000): Promise<Uint8Array> {
  return waitMessage(
    ws,
    (frame) => frame[0] === MESSAGE_SYNC && frame[1] === SYNC_STEP2,
    timeoutMs,
  );
}

function exchangeSyncStep1(ws: WebSocket, doc: Y.Doc): Promise<Uint8Array> {
  const reply = waitSyncStep2(ws);
  ws.send(encodeSyncStep1(doc));
  return reply;
}

function openWhatwg(pageId: number, token: string, extraQuery = ''): WebSocket {
  const url = `${baseWs}/api/collab/${pageId}${extraQuery}`;
  const ws = new WebSocket(url, [COLLAB_WS_PROTOCOL, token]);
  ws.binaryType = 'arraybuffer';
  return ws;
}

async function openWritableWhatwg(pageId: number, token: string): Promise<WebSocket> {
  const revision = await pageLifecycleRevision(pageId);
  const ws = openWhatwg(
    pageId,
    token,
    `?expectedLifecycleRevision=${encodeURIComponent(revision)}`,
  );
  const admitted = await waitControl(
    ws,
    (control) => control.type === 'writable_admission',
  );
  if (admitted.lifecycleRevision !== revision) {
    throw new Error('writable acknowledgement lifecycle revision changed during join');
  }
  writableSessionRevisions.set(ws, revision);
  return ws;
}

function commitPayload(ws: WebSocket, title: string, documentState = Y.emptySnapshot): CollabCommit {
  const expectedLifecycleRevision = writableSessionRevisions.get(ws);
  if (!expectedLifecycleRevision) throw new Error('writable test session revision is missing');
  return {
    title,
    expectedLifecycleRevision,
    expectedDocumentState: Buffer.from(Y.encodeSnapshot(documentState)).toString('base64'),
  };
}

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  baseWs = `ws://127.0.0.1:${addr.port}`;
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
  await disableCollabFlag();
});

describe.skipIf(!canRun)('GET /api/collab/config', () => {
  it('returns 401 without auth and { enabled } when authenticated', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/api/collab/config' });
    expect(unauth.statusCode).toBe(401);

    const { token } = await createUser('collab_cfg');
    const off = await app.inject({
      method: 'GET',
      url: '/api/collab/config',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ enabled: false });

    await enableCollabFlag();
    const on = await app.inject({
      method: 'GET',
      url: '/api/collab/config',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(on.json()).toEqual({ enabled: true });
  });
});

describe.skipIf(!canRun)('GET /api/collab/:pageId handshake (#1444)', () => {
  it('WHATWG client recovers from an expired JWT: 101 then 4401, refresh, second connection syncs', async () => {
    const { token, userId } = await createUser('collab_expired');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const expired = await signExpiredToken(userId, 'collab_expired', 'user');
    const first = openWhatwg(pageId, expired);
    const closed = await waitClose(first);
    expect(closed.opened, 'server must complete 101; HTTP 401 handshake is 1006').toBe(true);
    expect(closed.code).toBe(4401);
    expect(first.protocol).toBe(COLLAB_WS_PROTOCOL);

    const second = openWhatwg(pageId, token);
    await waitOpen(second);
    expect(second.protocol).toBe(COLLAB_WS_PROTOCOL);
    expect(second.protocol).not.toBe(token);

    const doc = new Y.Doc();
    await exchangeSyncStep1(second, doc);
    second.close();
  });

  it('ACL denial after 101 closes like a missing page (4404 not_found)', async () => {
    const owner = await createUser('collab_acl_owner');
    const stranger = await createUser('collab_acl_stranger');
    const pageId = await insertStandalone({ ownerId: owner.userId, visibility: 'private' });
    await enableCollabFlag();

    const ws = openWhatwg(pageId, stranger.token);
    const closed = await waitClose(ws);
    expect(closed.opened).toBe(true);
    expect(closed.code).toBe(4404);
    expect(closed.reason).toBe('not_found');
  });

  it('a restricted page closes for a reader exactly like a missing one; G and admin join until G loses the ACE', async () => {
    const fx = await seedRestrictionFixture();
    await enableCollabFlag();
    const tokens = new Map<string, string>();
    for (const userId of [fx.readerId, fx.groupReaderId, fx.adminId]) {
      const user = await query<{ username: string; role: 'user' | 'admin' }>(
        'SELECT username, role FROM users WHERE id = $1',
        [userId],
      );
      tokens.set(userId, await generateAccessToken({ sub: userId, ...user.rows[0]! }));
    }
    const closeOf = async (pageId: number, userId: string) => {
      const { code, reason, opened } = await waitClose(openWhatwg(pageId, tokens.get(userId)!));
      return { code, reason, opened };
    };
    const joins = async (pageId: number, userId: string): Promise<void> => {
      const ws = openWhatwg(pageId, tokens.get(userId)!);
      await waitOpen(ws);
      await exchangeSyncStep1(ws, new Y.Doc());
      ws.close();
      await waitClose(ws);
    };

    const missing = await closeOf(9_999_999, fx.readerId);
    expect(missing).toEqual({ code: 4404, reason: 'not_found', opened: true });
    expect(await closeOf(fx.pages.hushedLeaf, fx.readerId)).toEqual(missing);

    // A trashed restricted page must not reveal "trashed" to a reader, while
    // an authorized user keeps the specific reason.
    await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [fx.pages.hushedParent]);
    expect(await closeOf(fx.pages.hushedParent, fx.readerId)).toEqual(missing);
    expect(await closeOf(fx.pages.hushedParent, fx.groupReaderId))
      .toEqual({ code: 4404, reason: 'trashed', opened: true });

    await joins(fx.pages.hushedLeaf, fx.groupReaderId);
    await joins(fx.pages.hushedLeaf, fx.adminId);

    await query('DELETE FROM access_control_entries WHERE id = ANY($1::int[])', [fx.groupAceIds]);
    expect(await closeOf(fx.pages.hushedLeaf, fx.groupReaderId)).toEqual(missing);
  });

  it('flag off → 4403 after 101', async () => {
    const { token, userId } = await createUser('collab_flag_off');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });

    const ws = openWhatwg(pageId, token);
    const closed = await waitClose(ws);
    expect(closed.opened).toBe(true);
    expect(closed.code).toBe(4403);
    // The client parses this reason before the first sync (#1895).
    expect(closed.reason).toBe('flag_off');
  });

  it('missing / folder / trashed page → 4404 at join', async () => {
    const { token, userId } = await createUser('collab_gone');
    await enableCollabFlag();

    const missing = openWhatwg(9_999_999, token);
    const missingClose = await waitClose(missing);
    expect(missingClose.opened).toBe(true);
    expect(missingClose.code).toBe(4404);

    const folderId = await insertStandalone({ ownerId: userId, pageType: 'folder' });
    const folder = openWhatwg(folderId, token);
    const folderClose = await waitClose(folder);
    expect(folderClose.opened).toBe(true);
    expect(folderClose.code).toBe(4404);

    const trashedId = await insertStandalone({ ownerId: userId, deleted: true });
    const trashed = openWhatwg(trashedId, token);
    const trashedClose = await waitClose(trashed);
    expect(trashedClose.opened).toBe(true);
    expect(trashedClose.code).toBe(4404);
  });

  it('never authenticates a query-string JWT (4401)', async () => {
    const { token, userId } = await createUser('collab_query');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const url = `${baseWs}/api/collab/${pageId}?access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url, [COLLAB_WS_PROTOCOL]);
    ws.binaryType = 'arraybuffer';
    const closed = await waitClose(ws);
    expect(closed.opened).toBe(true);
    expect(closed.code).toBe(4401);
  });

  it('never authenticates a refresh JWT, live or revoked (4401)', async () => {
    const { userId } = await createUser('collab_refresh');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();
    const refresh = await generateRefreshToken({ sub: userId, username: 'collab_refresh', role: 'user' });

    const live = await waitClose(openWhatwg(pageId, refresh.token));
    expect(live.opened).toBe(true);
    expect(live.code).toBe(4401);

    await revokeAllUserTokens(userId);
    const revoked = await waitClose(openWhatwg(pageId, refresh.token));
    expect(revoked.opened).toBe(true);
    expect(revoked.code).toBe(4401);
  });

  it('accepts Authorization: Bearer (Node ws) and selects only the named subprotocol', async () => {
    const { token, userId } = await createUser('collab_bearer');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const ws = new NodeWs(`${baseWs}/api/collab/${pageId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('auth header ws open timeout')), 8_000);
      ws.once('error', (err) => { clearTimeout(t); reject(err); });
      ws.once('open', () => { clearTimeout(t); resolve(); });
    });
    expect(ws.protocol).not.toBe(token);
    const doc = new Y.Doc();
    const { promise: replyPromise, resolve: resolveReply, reject: rejectReply } =
      Promise.withResolvers<Uint8Array>();
    const t = setTimeout(() => rejectReply(new Error('auth header ws message timeout')), 8_000);
    const onMessage = (data: unknown): void => {
      const frame = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      if (frame[0] !== MESSAGE_SYNC || frame[1] !== SYNC_STEP2) return;
      clearTimeout(t);
      ws.off('message', onMessage);
      resolveReply(frame);
    };
    ws.on('message', onMessage);
    ws.send(encodeSyncStep1(doc));
    const reply = await replyPromise;
    expect(reply[0]).toBe(MESSAGE_SYNC);
    ws.close();
  });

  it('does not log the fixture JWT from authorization or sec-websocket-protocol', async () => {
    const { token, userId } = await createUser('collab_redact');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const info = vi.spyOn(logger, 'info');
    const warn = vi.spyOn(logger, 'warn');
    const error = vi.spyOn(logger, 'error');
    const debug = vi.spyOn(logger, 'debug');
    try {
      const ws = openWhatwg(pageId, token);
      await waitOpen(ws);
      ws.close();
      await waitClose(ws);
      const dumped = JSON.stringify([info.mock.calls, warn.mock.calls, error.mock.calls, debug.mock.calls]);
      expect(dumped).not.toContain(token);
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      debug.mockRestore();
    }
  });
});

describe.skipIf(!canRun)('read-only PROTOCOL.md §6 (#1444)', () => {
  it('ACE-only user: SyncStep1 + awareness accepted; SyncStep2/Update dropped; 8 drops → 4403', async () => {
    const editor = await createUser('collab_ro_editor');
    const viewer = await createUser('collab_ro_ace');
    const spaceKey = `RO${Date.now()}`;
    const pageId = await insertConfluencePage({
      spaceKey,
      confluenceId: `cf-ro-${pageIdEntropy()}`,
      inheritPerms: false,
    });
    await grantSpaceRead(editor.userId, spaceKey);
    await query(
      `INSERT INTO access_control_entries
         (resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ('page', $1, 'user', $2, 'read')`,
      [pageId, viewer.userId],
    );
    await enableCollabFlag();

    const controls: TestControl[] = [];
    const ws = openWhatwg(pageId, viewer.token);
    ws.addEventListener('message', (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const control = decodeControl(new Uint8Array(event.data));
      if (control) controls.push(control);
    });
    await waitOpen(ws);
    await vi.waitFor(() => {
      expect(controls).toContainEqual({
        type: 'permission_loss',
        reason: 'edit_permission_revoked',
      });
      expect(controls.some((control) => control.type === 'writable_admission')).toBe(false);
    });
    const doc = new Y.Doc();
    await exchangeSyncStep1(ws, doc);

    const update = encodeSyncUpdate(new Uint8Array([1, 2, 3, 4]));
    const step2Frame = new Uint8Array([MESSAGE_SYNC, SYNC_STEP2, 0]);
    for (let i = 0; i < 7; i++) {
      ws.send(i % 2 === 0 ? update : step2Frame);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.send(new Uint8Array([MESSAGE_AWARENESS, 0]));
    await new Promise((r) => setTimeout(r, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.send(update);
    const closed = await waitClose(ws);
    expect(closed.code).toBe(4403);
    expect(closed.reason).toBe('readonly');
  });
});

describe.skipIf(!canRun)('committed trash tombstone (#1444)', () => {
  /** Every admission of the page, oldest first; at least one is expected. */
  async function pageAdmissions(pageId: number): Promise<Array<{ released: boolean; kind: string | null }>> {
    const result = await query<{ released: boolean; kind: string | null }>(
      `SELECT released_at IS NOT NULL AS released, release_kind AS kind
         FROM page_runtime_admissions WHERE page_id = $1 ORDER BY admitted_at`,
      [pageId],
    );
    expect(result.rows.length).toBeGreaterThan(0);
    return result.rows;
  }

  async function expectRoomReleased(pageId: number): Promise<void> {
    for (const admission of await pageAdmissions(pageId)) {
      expect(admission).toEqual({ released: true, kind: 'clean_disconnect' });
    }
    await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    expect(getDefaultCollabRuntime()!.getRoom(pageId)).toBeUndefined();
    expect(await getRedisClient()!.sMembers(`collab:active:${pageId}`)).toEqual([]);
  }

  it('standalone DELETE after committed SQL closes 4404, flushing an unsaved edit before the release', async () => {
    const { token, userId } = await createUser('collab_trash');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const ws = await openWritableWhatwg(pageId, token);
    await waitOpen(ws);
    const doc = new Y.Doc();
    try {
      applySyncFrame(doc, await exchangeSyncStep1(ws, doc));
      const paragraph = new Y.XmlElement('paragraph');
      const typed = new Y.XmlText();
      typed.insert(0, 'TYPED_BEFORE_TRASH');
      paragraph.insert(0, [typed]);
      doc.getXmlFragment('default').push([paragraph]);
      // The test's own waits keep their real-clock timeouts: arm them first.
      const replyAfterEdit = waitSyncStep2(ws);
      const closedP = waitClose(ws);
      // Hold the room's real 2 s persist debounce: `setTimeout` is faked and
      // never advanced until the room has closed, so only the close's own
      // flush can make the edit durable. Sockets, PostgreSQL and Redis keep
      // their real I/O; native timers armed earlier are still cleared natively.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(doc)));
        // The reply is ordered after the update on the same socket.
        ws.send(encodeSyncStep1(doc));
        await replyAfterEdit;
        expect(yDocToHtml(getDefaultCollabRuntime()!.getRoom(pageId)!.doc)).toContain('TYPED_BEFORE_TRASH');
        expect(await persist.htmlFromPersistedDoc(pageId) ?? '').not.toContain('TYPED_BEFORE_TRASH');

        const del = await app.inject({
          method: 'DELETE',
          url: `/api/pages/${pageId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(del.statusCode).toBe(200);
        const closed = await closedP;
        expect(closed.code).toBe(4404);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      doc.destroy();
    }
    // Trash keeps the row: the close flushed the edit, then released (#1922 control).
    expect(await persist.htmlFromPersistedDoc(pageId)).toContain('TYPED_BEFORE_TRASH');
    await expectRoomReleased(pageId);
    expect((await query('SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NOT NULL', [pageId])).rowCount).toBe(1);
  });

  it('standalone permanent DELETE closes a writable room 4404 committed_delete and releases its admission (#1922)', async () => {
    const { token, userId } = await createUser('collab_permanent');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const ws = await openAndSync(pageId, token);
    const closedP = waitClose(ws);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/pages/${pageId}?permanent=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode, del.body).toBe(200);
    const closed = await closedP;
    expect(closed).toMatchObject({ code: 4404, reason: 'committed_delete' });
    expect((await query('SELECT 1 FROM pages WHERE id = $1', [pageId])).rowCount).toBe(0);
    // Read straight after the response: the tombstone ran before it.
    await expectRoomReleased(pageId);
  });

  it('bulk trash after committed SQL closes 4404', async () => {
    const { token, userId } = await createUser('collab_bulk');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const ws = await openAndSync(pageId, token);
    const closedP = waitClose(ws);

    const bulk = await app.inject({
      method: 'POST',
      url: '/api/pages/bulk/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [String(pageId)] },
    });
    expect(bulk.statusCode).toBe(200);
    const closed = await closedP;
    expect(closed.code).toBe(4404);
  });

  it('detectDeletedPages after committed soft-delete closes 4404', async () => {
    const { token, userId } = await createUser('collab_detect');
    const spaceKey = `DET${Date.now()}`;
    const confluenceId = `gone-${Date.now()}`;
    const pageId = await insertConfluencePage({ spaceKey, confluenceId });
    await grantSpaceRead(userId, spaceKey);
    await enableCollabFlag();

    const ws = await openAndSync(pageId, token);
    const closedP = waitClose(ws);

    const { __internal } = await import('../../domains/confluence/services/sync-service.js');
    const upstream = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://confluence.test');
      response.setHeader('content-type', 'application/json');
      if (url.pathname === '/rest/api/content' && url.searchParams.get('spaceKey') === spaceKey) {
        response.end(JSON.stringify({ results: [], _links: {} }));
      } else if (url.pathname === `/rest/api/content/${confluenceId}`) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: 'Page removed' }));
      } else {
        response.statusCode = 400;
        response.end(JSON.stringify({ message: 'Unexpected Confluence request' }));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('Confluence HTTP fixture did not bind TCP');
      const client = new ConfluenceClient(`http://127.0.0.1:${address.port}`, 'disposable-pat');
      await __internal.detectDeletedPages(client, spaceKey, {
        pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0,
      });
      const closed = await closedP;
      expect(closed.code).toBe(4404);
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('Confluence-intent rollback does not 4404 permanently', async () => {
    const { token, userId } = await createUser('collab_intent');
    const spaceKey = `INT${Date.now()}`;
    const pageId = await insertConfluencePage({ spaceKey, confluenceId: `cf-int-${Date.now()}` });
    await grantSpaceRead(userId, spaceKey);
    await enableCollabFlag();

    const ws = await openAndSync(pageId, token);

    await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [pageId]);
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    await query('UPDATE pages SET deleted_at = NULL WHERE id = $1', [pageId]);
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const doc = new Y.Doc();
    await exchangeSyncStep1(ws, doc);

    const closedP = waitClose(ws);
    await tombstoneCollabRoomAfterCommit(pageId);
    const closed = await closedP;
    expect(closed.code).toBe(4404);
  });

  it('admin reconcile of a crashed Confluence delete closes the open writable WebSocket 4404 committed_delete (#1780)', async () => {
    const editor = await createUser('collab_recovered_delete');
    const admin = await createUser('collab_recovery_admin', { admin: true });
    const spaceKey = `RCV${Date.now()}`;
    const confluenceId = `cf-recovered-${pageIdEntropy()}`;
    const pageId = await insertConfluencePage({ spaceKey, confluenceId });
    await grantSpaceRead(editor.userId, spaceKey);
    await enableCollabFlag();

    const upstream = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://confluence.test');
      response.setHeader('content-type', 'application/json');
      if (url.pathname === `/rest/api/content/${confluenceId}`) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: 'Page removed' }));
      } else {
        response.statusCode = 400;
        response.end(JSON.stringify({ message: 'Unexpected Confluence request' }));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('Confluence HTTP fixture did not bind TCP');
      await query(
        'UPDATE user_settings SET confluence_url = $2, confluence_pat = $3 WHERE user_id = $1',
        [editor.userId, `http://127.0.0.1:${address.port}`, encryptPat('disposable-pat')],
      );
      // The editor joined before the delete began.
      const ws = await openWritableWhatwg(pageId, editor.token);
      await waitOpen(ws);

      // What the crashed writer left behind: the page hidden, the provider
      // delete acknowledged, the local hard delete never committed.
      const hidden = await query<{ content_revision: string; lifecycle_revision: string }>(
        `UPDATE pages SET deleted_at = NOW() WHERE id = $1
         RETURNING content_revision::text, lifecycle_revision::text`,
        [pageId],
      );
      const runtimeId = `crashed-delete-writer-${pageIdEntropy()}`;
      await query(
        `INSERT INTO page_writer_runtimes
           (runtime_id, deployment_identity, fenced_at, fenced_by, fence_reason, fence_proof)
         VALUES ($1, '{}'::jsonb, NOW(), $2, 'Known terminated original writer',
                 '{"kind":"verified_local_termination"}')`,
        [runtimeId, admin.userId],
      );
      const intentId = crypto.randomUUID();
      await query(
        `INSERT INTO page_write_intents
           (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
            effect_started_at, effect_finished_at, remote_effect_started_at,
            remote_effects_completed_at, remote_terminal_result)
         VALUES ($1, $2, 'pages.delete.confluence', $3, ARRAY[$4]::int[], $5::jsonb,
                 'remote_terminal_only', $6::jsonb, NOW(), NOW(), NOW(), NOW(), $7::jsonb)`,
        [
          intentId,
          runtimeId,
          editor.userId,
          pageId,
          JSON.stringify({
            [pageId]: {
              contentRevision: hidden.rows[0]!.content_revision,
              lifecycleRevision: hidden.rows[0]!.lifecycle_revision,
            },
          }),
          JSON.stringify({
            effectClass: 'remote',
            confluenceId,
            spaceKey,
            upstreamDelete: true,
            attachmentStore: 'confluence',
            iconStore: 'page-icons',
          }),
          JSON.stringify({ confluenceId, outcome: 'deleted' }),
        ],
      );

      const closedP = waitClose(ws);
      const reconciled = await app.inject({
        method: 'POST',
        url: `/api/admin/page-write-recovery/intents/${intentId}/reconcile`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { reason: 'Finish the crashed Confluence delete and close its open editors' },
      });
      expect(reconciled.statusCode, reconciled.body).toBe(200);
      expect(reconciled.json()).toEqual({ intentId, status: 'reconciled_applied' });
      const closed = await closedP;
      expect(closed.code).toBe(4404);
      expect(closed.reason).toBe('committed_delete');
      expect((await query('SELECT 1 FROM pages WHERE id = $1', [pageId])).rowCount).toBe(0);
      await expectRoomReleased(pageId);
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe.skipIf(!canRun)('collab:active TTL / idle 409 (#1444)', () => {
  it('idle connection still 409s because pings renew collab:active TTL', async () => {
    const { token, userId } = await createUser('collab_idle');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const ws = await openWritableWhatwg(pageId, token);
    await waitOpen(ws);

    // Wait longer than half the TTL. Without ping renewal remaining TTL
    // would drop to ≤ half; with pings it stays near the full TTL.
    const waitMs = Math.max(COLLAB_PING_INTERVAL_MS * 3, COLLAB_ACTIVE_TTL_SEC * 500);
    await new Promise((r) => setTimeout(r, waitMs));

    await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'collab_session_active',
    });
    const ttl = await getRedisClient()!.ttl(`collab:active:${pageId}`);
    expect(ttl).toBeGreaterThan(Math.floor(COLLAB_ACTIVE_TTL_SEC / 2));
    ws.close();
  }, Math.max(15_000, COLLAB_ACTIVE_TTL_SEC * 1000 + 5_000));
});

describe('GET /api/collab/:pageId route options (#1444)', () => {
  it('does not enable Fastify rateLimit on the WS upgrade (101 then 4403)', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('./pages-collab.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/rateLimit:\s*false/);
    expect(src).not.toMatch(/rateLimit:\s*\{\s*max:\s*UPGRADE_LIMIT_PER_MIN/);
  });
});

describe.skipIf(!canRun)('collab upgrade Redis limiter (#1444)', () => {
  it('rate-limits upgrades after 101 with 4403, not HTTP 429', async () => {
    const { token, userId } = await createUser('collab_rl');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();
    await getRedisClient()!.set(`collab:upgrade:${userId}`, '20', { EX: 60 });

    const ws = openWhatwg(pageId, token);
    const closed = await waitClose(ws);
    expect(closed.opened, 'must complete 101 before refusing').toBe(true);
    expect(closed.code).toBe(4403);
    expect(closed.reason).toBe('rate_limited');
  });

  it('counts upgrades in a COLLAB_UPGRADE_WINDOW_SEC window, the wait the client Retry honours (#1895)', async () => {
    const { token, userId } = await createUser('collab_rl_window');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const ws = await openAndSync(pageId, token);
    const ttl = await getRedisClient()!.ttl(`collab:upgrade:${userId}`);
    expect(ttl).toBeGreaterThan(COLLAB_UPGRADE_WINDOW_SEC - 5);
    expect(ttl).toBeLessThanOrEqual(COLLAB_UPGRADE_WINDOW_SEC);
    ws.close();
    await waitClose(ws);
  });
});

/** Own-clientID awareness update carrying a marker the server must keep. */
function encodeAwarenessProbe(): { frame: Uint8Array; clientId: number } {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState({ probe: 'pre-live' });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
  const probe = { frame: encoding.toUint8Array(encoder), clientId: doc.clientID };
  awareness.destroy();
  doc.destroy();
  return probe;
}

function awarenessFrameHasProbe(frame: Uint8Array, clientId: number): boolean {
  if (frame[0] !== MESSAGE_AWARENESS) return false;
  const decoder = decoding.createDecoder(frame);
  decoding.readVarUint(decoder);
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), 'test');
  const found = awareness.getStates().get(clientId)?.probe === 'pre-live';
  awareness.destroy();
  doc.destroy();
  return found;
}

describe.skipIf(!canRun)('pre-live frame buffer (#1895)', () => {
  /**
   * Holds the join inside `attachSocket` until the server has read
   * `releaseAfter` frames, so every frame the test sends arrives before the
   * socket goes live.
   */
  function holdJoinUntilFrames(releaseAfter: number) {
    const runtime = getDefaultCollabRuntime();
    if (!runtime) throw new Error('collab runtime is not initialised');
    const attach = runtime.attachSocket;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const spy = vi.spyOn(runtime, 'attachSocket').mockImplementationOnce(async (pageId, socket) => {
      let received = 0;
      // Registered after the route's own listener, so the route has already
      // buffered (or refused) each frame this counts.
      socket.ws.on('message', () => {
        received += 1;
        if (received === releaseAfter) release.resolve();
      });
      entered.resolve();
      await release.promise;
      return attach(pageId, socket);
    });
    return {
      entered: entered.promise,
      release: () => release.resolve(),
      restore: () => spy.mockRestore(),
    };
  }

  it('keeps 3 frames sent before the join completes and applies them in order after live', async () => {
    const { token, userId } = await createUser('collab_prelive_order');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();
    const join = holdJoinUntilFrames(3);
    try {
      const revision = await pageLifecycleRevision(pageId);
      const ws = openWhatwg(pageId, token, `?expectedLifecycleRevision=${encodeURIComponent(revision)}`);
      const frames: Uint8Array[] = [];
      const observed: { close: { code: number; reason: string } | null } = { close: null };
      ws.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data));
      });
      ws.addEventListener('close', (event) => {
        observed.close = { code: event.code, reason: event.reason };
      });
      await waitOpen(ws);
      await join.entered;

      // y-websocket's own pre-live traffic plus one more frame. The replies
      // prove the order: F2's snapshot holds F1's state, and comes before
      // F3's SyncStep2.
      const probe = encodeAwarenessProbe();
      ws.send(probe.frame);
      ws.send(new Uint8Array([MESSAGE_QUERY_AWARENESS]));
      ws.send(encodeSyncStep1(new Y.Doc()));

      const snapshotIndex = () => frames.findIndex((frame) => awarenessFrameHasProbe(frame, probe.clientId));
      const syncStep2Index = () => frames.findIndex((frame) => frame[0] === MESSAGE_SYNC && frame[1] === SYNC_STEP2);
      await vi.waitFor(() => {
        if (observed.close) return;
        if (snapshotIndex() < 0 || syncStep2Index() < 0) {
          throw new Error('replies to the buffered frames are pending');
        }
      }, { timeout: 8_000 });

      expect(observed.close).toBeNull();
      expect(snapshotIndex()).toBeGreaterThanOrEqual(0);
      expect(snapshotIndex()).toBeLessThan(syncStep2Index());
      expect(frames.some((frame) => decodeControl(frame)?.type === 'writable_admission')).toBe(true);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await waitClose(ws);
    } finally {
      join.release();
      join.restore();
    }
  });

  // The gateway buffers at most 64 frames and 1 MiB before live
  // (docs/architecture/12-realtime-collaboration.md).
  const largeFrame = new Uint8Array(600 * 1024);
  largeFrame[0] = MESSAGE_AWARENESS;
  const halfMiBFrame = new Uint8Array(512 * 1024);
  halfMiBFrame[0] = MESSAGE_AWARENESS;

  it.each([
    { budget: 'frame count', frames: Array.from({ length: 65 }, () => new Uint8Array([MESSAGE_QUERY_AWARENESS])) },
    { budget: 'byte budget', frames: [largeFrame, largeFrame] },
    // 1 MiB + 1 byte: refused by the byte bound alone, three frames in.
    { budget: 'one byte over 1 MiB', frames: [halfMiBFrame, halfMiBFrame, new Uint8Array([MESSAGE_QUERY_AWARENESS])] },
  ])('closes an over-full pre-live buffer ($budget) with 1013 join_backlog, never 4403', async ({ frames }) => {
    const { token, userId } = await createUser('collab_prelive_backlog');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();
    const join = holdJoinUntilFrames(frames.length);
    try {
      const ws = openWhatwg(pageId, token);
      await waitOpen(ws);
      await join.entered;
      for (const frame of frames) ws.send(frame);
      const closed = await waitClose(ws, 2_000);
      expect({ code: closed.code, reason: closed.reason }).toEqual({ code: 1013, reason: 'join_backlog' });
    } finally {
      join.release();
      join.restore();
    }
  });

  // Accept-at-the-bound pins: with the overflow rows above they fix the bound
  // at exactly 64 frames and exactly 1 MiB.
  it('keeps exactly 64 frames before live and applies every one of them', async () => {
    const { token, userId } = await createUser('collab_prelive_frame_bound');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();
    const join = holdJoinUntilFrames(64);
    try {
      const ws = openWhatwg(pageId, token);
      const frames: Uint8Array[] = [];
      const observed: { close: { code: number; reason: string } | null } = { close: null };
      ws.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data));
      });
      ws.addEventListener('close', (event) => {
        observed.close = { code: event.code, reason: event.reason };
      });
      await waitOpen(ws);
      await join.entered;

      // One awareness state, then 63 queries: each query answers with a
      // snapshot holding that state, so 63 replies prove all 64 frames applied.
      const probe = encodeAwarenessProbe();
      ws.send(probe.frame);
      for (let i = 0; i < 63; i++) ws.send(new Uint8Array([MESSAGE_QUERY_AWARENESS]));
      const snapshots = () => frames.filter((frame) => awarenessFrameHasProbe(frame, probe.clientId)).length;
      await vi.waitFor(() => {
        if (observed.close) return;
        if (snapshots() < 63) throw new Error('replies to the buffered frames are pending');
      }, { timeout: 8_000 });

      expect(observed.close).toBeNull();
      expect(snapshots()).toBe(63);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await waitClose(ws);
    } finally {
      join.release();
      join.restore();
    }
  });

  it('keeps exactly 1 MiB before live and stays open after replaying it', async () => {
    const { token, userId } = await createUser('collab_prelive_byte_bound');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();
    const join = holdJoinUntilFrames(2);
    try {
      const ws = openWhatwg(pageId, token);
      const observed: { close: { code: number; reason: string } | null } = { close: null };
      ws.addEventListener('close', (event) => {
        observed.close = { code: event.code, reason: event.reason };
      });
      const lifecycleControl = waitControl(ws, (control) => control.type === 'page_lifecycle');
      await waitOpen(ws);
      await join.entered;

      ws.send(halfMiBFrame);
      ws.send(halfMiBFrame);
      // The attach completed, then a live round trip proves the socket
      // survived both buffered frames.
      await lifecycleControl;
      await exchangeSyncStep1(ws, new Y.Doc());

      expect(observed.close).toBeNull();
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await waitClose(ws);
    } finally {
      join.release();
      join.restore();
    }
  });
});

function pageIdEntropy(): string {
  return Math.random().toString(36).slice(2, 10);
}

const MESSAGE_CONTROL = 4;

function applySyncFrame(doc: Y.Doc, buf: Uint8Array): void {
  const decoder = decoding.createDecoder(buf);
  const encoder = encoding.createEncoder();
  const type = decoding.readVarUint(decoder);
  if (type !== MESSAGE_SYNC) return;
  syncProtocol.readSyncMessage(decoder, encoder, doc, 'client');
}

type TestControl = { type: string; version?: number; [key: string]: unknown };

function decodeControl(buf: Uint8Array): TestControl | null {
  const decoder = decoding.createDecoder(buf);
  const type = decoding.readVarUint(decoder);
  if (type !== MESSAGE_CONTROL) return null;
  return JSON.parse(decoding.readVarString(decoder)) as TestControl;
}

function waitControl(
  ws: WebSocket,
  accept: (control: TestControl) => boolean = () => true,
  timeoutMs = 8_000,
): Promise<TestControl> {
  const { promise, resolve, reject } = Promise.withResolvers<TestControl>();
  const timer = setTimeout(() => reject(new Error('timeout waiting for type-4 control')), timeoutMs);
  const onMsg = (ev: MessageEvent) => {
    const data = ev.data;
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!buf) return;
    const control = decodeControl(buf);
    if (!control || !accept(control)) return;
    clearTimeout(timer);
    ws.removeEventListener('message', onMsg);
    resolve(control);
  };
  ws.addEventListener('message', onMsg);
  return promise;
}

describe.skipIf(!canRun)('POST /api/pages/:id/collab/commit standalone (#1445)', () => {
  it.each(['insert', 'delete'] as const)(
    'does not acknowledge a client %s until the snapshot includes it',
    async (change) => {
      const { token, userId } = await createUser(`collab_unreceived_${change}`);
      const pageId = await insertStandalone({
        ownerId: userId,
        bodyHtml: '<p>not-yet-deleted</p>',
      });
      await enableCollabFlag();
      const ws = await openWritableWhatwg(pageId, token);
      const doc = new Y.Doc();
      try {
        applySyncFrame(doc, await exchangeSyncStep1(ws, doc));
        const fragment = doc.getXmlFragment('default');
        if (change === 'insert') {
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, 'inserted locally');
          paragraph.insert(0, [text]);
          fragment.insert(fragment.length, [paragraph]);
        } else {
          const clocksBefore = Y.encodeStateVector(doc);
          const paragraph = fragment.get(0);
          if (!(paragraph instanceof Y.XmlElement)) throw new Error('Expected a paragraph');
          const text = paragraph.get(0);
          if (!(text instanceof Y.XmlText)) throw new Error('Expected paragraph text');
          text.delete(0, text.length);
          // A vector-only guard would miss this real local mutation.
          expect(Y.encodeStateVector(doc)).toEqual(clocksBefore);
        }
        const payload = commitPayload(ws, 'Captured draft', Y.snapshot(doc));
        const missing = await app.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/collab/commit`,
          headers: { authorization: `Bearer ${token}` },
          payload,
        });
        expect(missing.statusCode).toBe(409);
        expect(missing.json().reason).toBe('collab_snapshot_not_received');
        const unchanged = await query<{ body_html: string; version: number }>(
          'SELECT body_html, version FROM pages WHERE id = $1',
          [pageId],
        );
        expect(unchanged.rows[0]).toEqual({ body_html: '<p>not-yet-deleted</p>', version: 1 });

        ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(doc)));
        // The reply is ordered after the update on the same socket/frame chain.
        applySyncFrame(doc, await exchangeSyncStep1(ws, doc));
        const committed = await app.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/collab/commit`,
          headers: { authorization: `Bearer ${token}` },
          payload,
        });
        expect(committed.statusCode).toBe(200);
        const saved = await query<{ body_text: string; version: number }>(
          'SELECT body_text, version FROM pages WHERE id = $1',
          [pageId],
        );
        expect(saved.rows[0]!.version).toBe(2);
        if (change === 'insert') expect(saved.rows[0]!.body_text).toContain('inserted locally');
        else expect(saved.rows[0]!.body_text.trim()).toBe('');
      } finally {
        ws.close();
        doc.destroy();
      }
    },
  );

  it('two concurrent commits do not 409 each other (retry once) and broadcast pages_version', async () => {
    const { token, userId } = await createUser('collab_commit');
    const pageId = await insertStandalone({
      ownerId: userId,
      visibility: 'shared',
      bodyHtml: '<p>commit-seed</p>',
    });
    await enableCollabFlag();

    const ws = await openWritableWhatwg(pageId, token);
    await waitOpen(ws);
    const ydoc = new Y.Doc();
    const reply = await exchangeSyncStep1(ws, ydoc);
    applySyncFrame(ydoc, reply);

    const controlP = waitControl(ws);
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: commitPayload(ws, 'Committed A'),
      }),
      app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: commitPayload(ws, 'Committed B'),
      }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 200]);
    const versions = [a.json().version, b.json().version].sort((x: number, y: number) => x - y);
    expect(versions).toEqual([2, 3]);
    expect(a.json().code).toBeUndefined();
    expect(b.json().code).toBeUndefined();

    const control = await controlP;
    expect(control.type).toBe('pages_version');
    expect([2, 3]).toContain(control.version);

    const page = await query<{ version: number; title: string; summary_status: string; quality_status: string }>(
      'SELECT version, title, summary_status, quality_status FROM pages WHERE id = $1',
      [pageId],
    );
    expect(page.rows[0]!.version).toBe(3);
    expect(page.rows[0]!.summary_status).toBe('pending');
    expect(page.rows[0]!.quality_status).toBe('pending');
    const activeAdmissions = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM page_runtime_admissions
        WHERE page_id = $1 AND released_at IS NULL`,
      [pageId],
    );
    expect(activeAdmissions.rows[0]?.count).toBe('1');
    ws.close();
  });
});

describe.skipIf(!canRun)('competing writers 409 while room live (#1445)', () => {
  it('PUT / restore / Apply / draft-publish 409 with collab_session_active', async () => {
    const { token, userId } = await createUser('collab_409');
    const pageId = await insertStandalone({
      ownerId: userId,
      visibility: 'shared',
      bodyHtml: '<p>live-room</p>',
    });
    await query(
      `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, 'local', 1, 'Collab page', '<p>old</p>', 'old', NOW())
       ON CONFLICT (page_id, source, version_number) DO NOTHING`,
      [pageId],
    );
    await query(
      `UPDATE pages SET version = 2, body_html = '<p>live-room</p>' WHERE id = $1`,
      [pageId],
    );
    await query(
      `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, 'local', 2, 'Collab page', '<p>live-room</p>', 'live-room', NOW())
       ON CONFLICT (page_id, source, version_number) DO NOTHING`,
      [pageId],
    );
    await enableCollabFlag();

    const ws = await openAndSync(pageId, token);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'nope', bodyHtml: '<p>put</p>', version: 2 },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().code).toBe('collab_session_active');

    const restore = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/1/restore`,
      headers: { authorization: `Bearer ${token}` },
      payload: { version: 2 },
    });
    expect(restore.statusCode).toBe(409);
    expect(restore.json().code).toBe('collab_session_active');

    const apply = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      headers: { authorization: `Bearer ${token}` },
      payload: { pageId: String(pageId), improvedMarkdown: '## Improved' },
    });
    expect(apply.statusCode).toBe(409);
    expect(apply.json().code).toBe('collab_session_active');

    await query(
      `UPDATE pages SET draft_body_html = '<p>draft</p>', draft_body_text = 'draft', draft_updated_by = $2 WHERE id = $1`,
      [pageId, userId],
    );
    const publish = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/draft/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(publish.statusCode).toBe(409);
    expect(publish.json().code).toBe('collab_session_active');

    ws.close();
  });

  it('empty-room PUT deletes BYTEA so the next join re-inits from HTML', async () => {
    const { token, userId } = await createUser('collab_del');
    const pageId = await insertStandalone({
      ownerId: userId,
      visibility: 'shared',
      bodyHtml: '<p>BEFORE_CRDT</p>',
    });
    await enableCollabFlag();

    const first = await openAndSync(pageId, token);
    first.close();
    await vi.waitFor(async () => {
      const n = await getRedisClient()!.sCard(`collab:active:${pageId}`);
      expect(Number(n)).toBe(0);
    }, { timeout: 15_000 });

    const before = await query('SELECT page_id FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
    expect(before.rows.length).toBeGreaterThan(0);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'rewritten', bodyHtml: '<p>AFTER_HTML_WRITE</p>', version: 1 },
    });
    expect(put.statusCode).toBe(200);

    const gone = await query('SELECT page_id FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
    expect(gone.rows).toHaveLength(0);

    const second = openWhatwg(pageId, token);
    await waitOpen(second);
    const doc = new Y.Doc();
    const reply = await exchangeSyncStep1(second, doc);
    applySyncFrame(doc, reply);
    const xml = doc.getXmlFragment('default').toString();
    expect(xml).toContain('AFTER_HTML_WRITE');
    expect(xml).not.toContain('BEFORE_CRDT');
    second.close();
  }, 25_000);

  it('empty-room restore / Apply / draft-publish delete BYTEA', async () => {
    const { token, userId } = await createUser('collab_del_writers');
    await enableCollabFlag();

    async function seedBytea(pageId: number): Promise<void> {
      const doc = new Y.Doc();
      doc.getXmlFragment('default');
      await query(
        `INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector, version)
         VALUES ($1, $2, $3, 1)`,
        [pageId, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))],
      );
    }

    const restoreId = await insertStandalone({
      ownerId: userId, visibility: 'shared', bodyHtml: '<p>live</p>',
    });
    await query(`UPDATE pages SET version = 2 WHERE id = $1`, [restoreId]);
    await query(
      `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, 'local', 1, 'Collab page', '<p>old</p>', 'old', NOW())`,
      [restoreId],
    );
    await seedBytea(restoreId);
    expect(Number(await getRedisClient()!.sCard(`collab:active:${restoreId}`))).toBe(0);
    const restore = await app.inject({
      method: 'POST',
      url: `/api/pages/${restoreId}/versions/1/restore`,
      headers: { authorization: `Bearer ${token}` },
      payload: { version: 2 },
    });
    expect(restore.statusCode).toBe(200);
    expect((await query('SELECT page_id FROM page_collaborative_docs WHERE page_id = $1', [restoreId])).rows).toHaveLength(0);

    const applyId = await insertStandalone({
      ownerId: userId, visibility: 'shared', bodyHtml: '<p>apply-me</p>',
    });
    await seedBytea(applyId);
    const apply = await app.inject({
      method: 'POST',
      url: '/api/llm/improvements/apply',
      headers: { authorization: `Bearer ${token}` },
      payload: { pageId: String(applyId), improvedMarkdown: 'Applied body' },
    });
    expect(apply.statusCode).toBe(200);
    expect((await query('SELECT page_id FROM page_collaborative_docs WHERE page_id = $1', [applyId])).rows).toHaveLength(0);

    const pubId = await insertStandalone({
      ownerId: userId, visibility: 'shared', bodyHtml: '<p>pub-live</p>',
    });
    await query(
      `UPDATE pages SET draft_body_html = '<p>draft</p>', draft_body_text = 'draft', draft_updated_by = $2 WHERE id = $1`,
      [pubId, userId],
    );
    await seedBytea(pubId);
    const publish = await app.inject({
      method: 'POST',
      url: `/api/pages/${pubId}/draft/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(publish.statusCode).toBe(200);
    expect((await query('SELECT page_id FROM page_collaborative_docs WHERE page_id = $1', [pubId])).rows).toHaveLength(0);
  });
});

describe.skipIf(!canRun)('collab init failure (#1445 review)', () => {
  it('loadOrInit throw: socket 1001, no collab:active member, PUT does not 409', async () => {
    const { token, userId } = await createUser('collab_init_fail');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const spy = vi.spyOn(persist, 'loadOrInitCollabDoc').mockRejectedValue(new Error('forced load failure'));
    try {
      const ws = openWhatwg(pageId, token);
      const closed = await waitClose(ws);
      expect(closed.opened).toBe(true);
      expect(closed.code).toBe(1001);

      const n = await getRedisClient()!.sCard(`collab:active:${pageId}`);
      expect(Number(n)).toBe(0);
      await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();

      const put = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'ok', bodyHtml: '<p>ok</p>', version: 1 },
      });
      expect(put.statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe.skipIf(!canRun)('collab commit multi-pod dump (#1445 review)', () => {
  it('commit on a pod with no local heap waits for state_dump and snapshots peer HTML', async () => {
    const { token, userId } = await createUser('collab_dump_commit');
    const pageId = await insertStandalone({
      ownerId: userId,
      visibility: 'shared',
      bodyHtml: '<p>ORIGINAL_HTML</p>',
    });
    await enableCollabFlag();
    const editingRevision = await pageLifecycleRevision(pageId);

    const redis = getRedisClient()!;
    const podA = await createCollabRuntime(redis, 'commit-pod-a');
    try {
      await podA.attachSocket(pageId, {
        id: 'pod-a-writer',
        ws: { readyState: 1, send() {}, close() {} } as unknown as NodeWs,
        userId,
        writable: true,
        expectedLifecycleRevision: editingRevision,
      });
      const roomA = podA.getRoom(pageId)!;
      const frag = roomA.doc.getXmlFragment('default');
      const walk = (n: Y.XmlFragment | Y.XmlElement): boolean => {
        for (let i = 0; i < n.length; i++) {
          const child = n.get(i);
          if (child instanceof Y.XmlText) {
            child.insert(child.length, ' FROM_POD_A');
            return true;
          }
          if (child instanceof Y.XmlElement && walk(child)) return true;
        }
        return false;
      };
      walk(frag);

      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          title: 'From B',
          expectedLifecycleRevision: editingRevision,
          expectedDocumentState: Buffer.from(Y.encodeSnapshot(Y.snapshot(roomA.doc))).toString('base64'),
        },
      });
      expect(res.statusCode).toBe(200);
      const page = await query<{ body_html: string }>(
        'SELECT body_html FROM pages WHERE id = $1',
        [pageId],
      );
      expect(page.rows[0]!.body_html).toContain('FROM_POD_A');
      const activeAdmissions = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM page_runtime_admissions
          WHERE page_id = $1 AND released_at IS NULL`,
        [pageId],
      );
      expect(activeAdmissions.rows[0]?.count).toBe('1');
      expect(getDefaultCollabRuntime()?.getRoom(pageId)).toBeUndefined();
      expect(yDocToHtml(roomA.doc)).toContain('FROM_POD_A');
    } finally {
      await podA.close();
    }
  });

  it('stale cross-pod commit is refused before requesting a state dump', async () => {
    const { token, userId } = await createUser('collab_dump_stale');
    const pageId = await insertStandalone({
      ownerId: userId,
      visibility: 'shared',
      bodyHtml: '<p>SESSION_BODY</p>',
    });
    await enableCollabFlag();
    const editingRevision = await pageLifecycleRevision(pageId);
    const redis = getRedisClient()!;
    const podA = await createCollabRuntime(redis, 'stale-commit-pod-a');
    const publish = vi.spyOn(redis, 'publish');
    try {
      await podA.attachSocket(pageId, {
        id: 'stale-pod-a-writer',
        ws: { readyState: 1, send() {}, close() {} } as unknown as NodeWs,
        userId,
        writable: true,
        expectedLifecycleRevision: editingRevision,
      });
      await query(
        'UPDATE pages SET lifecycle_revision = lifecycle_revision + 1 WHERE id = $1',
        [pageId],
      );
      publish.mockClear();

      const response = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          title: 'Must not request state',
          expectedLifecycleRevision: editingRevision,
          expectedDocumentState: EMPTY_DOCUMENT_STATE,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().reason).toBe('stale_lifecycle');
      expect(publish.mock.calls.some(([, value]) => {
        try {
          const parsed: unknown = JSON.parse(String(value));
          return parsed !== null
            && typeof parsed === 'object'
            && 'kind' in parsed
            && parsed.kind === 'state_dump_request';
        } catch {
          return false;
        }
      })).toBe(false);
      expect(getDefaultCollabRuntime()?.getRoom(pageId)).toBeUndefined();
    } finally {
      await query(
        'UPDATE pages SET lifecycle_revision = $2::bigint WHERE id = $1',
        [pageId, editingRevision],
      );
      publish.mockRestore();
      await podA.close();
    }
  });

  it('ignores Redis liveness when fresh snapshot ownership cannot be proven', async () => {
    const { token, userId } = await createUser('collab_dump_503');
    const pageId = await insertStandalone({
      ownerId: userId,
      visibility: 'shared',
      bodyHtml: '<p>STALE_BYTEA_BODY</p>',
    });
    await enableCollabFlag();
    const editingRevision = await pageLifecycleRevision(pageId);
    const doc = new Y.Doc();
    doc.getXmlFragment('default');
    await query(
      `INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector, version)
       VALUES ($1, $2, $3, 1)`,
      [pageId, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))],
    );
    await getRedisClient()!.sAdd(`collab:active:${pageId}`, 'ghost-pod:conn');
    await getRedisClient()!.expire(`collab:active:${pageId}`, 45);

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Must not trust Redis liveness',
        expectedLifecycleRevision: editingRevision,
        expectedDocumentState: EMPTY_DOCUMENT_STATE,
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toBe('collab_state_unavailable');
    const page = await query<{ title: string; body_html: string }>(
      'SELECT title, body_html FROM pages WHERE id = $1',
      [pageId],
    );
    expect(page.rows[0]!.title).not.toBe('Must not trust Redis liveness');
    expect(page.rows[0]!.body_html).toContain('STALE_BYTEA_BODY');

    // No request-local room/admission may turn the Redis member into proof of
    // a writable collaborator or make stale BYTEA publishable.
    const runtime = getDefaultCollabRuntime();
    expect(runtime?.getRoom(pageId)).toBeUndefined();
    const members = await getRedisClient()!.sMembers(`collab:active:${pageId}`);
    expect(members.some((m) => m.startsWith(`${runtime!.podId}:`))).toBe(false);
    expect(members).toContain('ghost-pod:conn');

    const again = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'Must still not trust Redis liveness',
        expectedLifecycleRevision: editingRevision,
        expectedDocumentState: EMPTY_DOCUMENT_STATE,
      },
    });
    expect(again.statusCode).toBe(503);
    expect(again.json().reason).toBe('collab_state_unavailable');

    await getRedisClient()!.sRem(`collab:active:${pageId}`, 'ghost-pod:conn');
    const afterGhost = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: 'BYTEA fallback remains forbidden',
        expectedLifecycleRevision: editingRevision,
        expectedDocumentState: EMPTY_DOCUMENT_STATE,
      },
    });
    expect(afterGhost.statusCode).toBe(503);
    expect(afterGhost.json().reason).toBe('collab_state_unavailable');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'ok', bodyHtml: '<p>ok</p>', version: 2 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().code).not.toBe('collab_session_active');
  }, 20_000);
});

describe.skipIf(!canRun)('POST /api/pages/:id/collab/commit Confluence (#1448)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedConfluencePage(opts?: { version?: number; bodyHtml?: string }) {
    const { token, userId } = await createUser(`collab_cf_${pageIdEntropy()}`);
    const spaceKey = `CF${pageIdEntropy().slice(0, 6).toUpperCase()}`;
    const confluenceId = `cf-${pageIdEntropy()}`;
    const pageId = await insertConfluencePage({
      spaceKey,
      confluenceId,
      version: opts?.version ?? 4,
      bodyHtml: opts?.bodyHtml ?? '<p>commit-seed</p>',
    });
    await grantSpaceRead(userId, spaceKey);
    await seedConfluenceCredentials(userId);
    await enableCollabFlag();
    return { token, userId, pageId, confluenceId, spaceKey };
  }

  async function seedLiveConfluencePage(opts?: { version?: number; bodyHtml?: string }) {
    const page = await seedConfluencePage(opts);
    const ws = await openAndSync(page.pageId, page.token);
    return { ...page, ws };
  }

  async function createPastedImageRoot(filename = 'pasted.png'): Promise<{
    root: string;
    priorRoot: string | undefined;
  }> {
    const root = await fs.promises.mkdtemp(path.join(tmpdir(), 'collab-media-'));
    await fs.promises.mkdir(path.join(root, 'local-src'), { recursive: true });
    await fs.promises.writeFile(
      path.join(root, 'local-src', filename),
      Buffer.from('planned pasted image bytes'),
    );
    const priorRoot = process.env.ATTACHMENTS_DIR;
    process.env.ATTACHMENTS_DIR = root;
    return { root, priorRoot };
  }

  async function removePastedImageRoot(
    root: string,
    priorRoot: string | undefined,
  ): Promise<void> {
    if (priorRoot === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = priorRoot;
    await fs.promises.rm(root, { recursive: true, force: true });
  }


  it('stale session lifecycle is refused before Confluence effects and retains the room', async () => {
    const { token, pageId, ws } = await seedLiveConfluencePage({ version: 4 });
    const sessionRevision = writableSessionRevisions.get(ws);
    if (!sessionRevision) throw new Error('writable test session revision is missing');
    await query(
      'UPDATE pages SET lifecycle_revision = lifecycle_revision + 1 WHERE id = $1',
      [pageId],
    );
    const getPage = vi.spyOn(ConfluenceClient.prototype, 'getPage');
    const updateAttachment = vi.spyOn(ConfluenceClient.prototype, 'updateAttachment');
    const updatePage = vi.spyOn(ConfluenceClient.prototype, 'updatePage');

    try {
      const commit = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          title: 'Stale session must not publish',
          expectedLifecycleRevision: sessionRevision,
          expectedDocumentState: EMPTY_DOCUMENT_STATE,
        },
      });

      expect(commit.statusCode).toBe(409);
      expect(commit.json().reason).toBe('stale_lifecycle');
      expect(getPage).not.toHaveBeenCalled();
      expect(updateAttachment).not.toHaveBeenCalled();
      expect(updatePage).not.toHaveBeenCalled();
      expect(getDefaultCollabRuntime()?.getRoom(pageId)?.doc).toBeDefined();
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      await query(
        'UPDATE pages SET lifecycle_revision = $2::bigint WHERE id = $1',
        [pageId, sessionRevision],
      );
      ws.close();
    }
  });

  it('remote version moved → 409 confluence_modified, no updatePage, local version unchanged, room live', async () => {
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({ version: 7 });
    await query('UPDATE pages SET remote_version = 4 WHERE id = $1', [pageId]);
    const getPage = vi.spyOn(ConfluenceClient.prototype, 'getPage').mockResolvedValue({
      id: confluenceId,
      title: 'Conf page',
      status: 'current',
      type: 'page',
      version: { number: 7, when: '2026-08-24T00:00:00Z' },
    } as never);
    const updatePage = vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockRejectedValue(
      new Error('updatePage must not run'),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: commitPayload(ws, 'Should not land'),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'confluence_modified',
      remoteVersion: 7,
      localVersion: 4,
    });
    expect(getPage).toHaveBeenCalledWith(confluenceId);
    expect(updatePage).not.toHaveBeenCalled();
    const page = await query<{ version: number }>('SELECT version FROM pages WHERE id = $1', [pageId]);
    expect(page.rows[0]!.version).toBe(7);
    expect(Number(await getRedisClient()!.sCard(`collab:active:${pageId}`))).toBeGreaterThan(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('blocks a collaborative provider read and PUT while a manual-review sync conflict is pending', async () => {
    const { token, pageId, ws } = await seedLiveConfluencePage({ version: 6 });
    await query('UPDATE pages SET conflict_pending = TRUE, remote_version = 5 WHERE id = $1', [pageId]);
    const getPage = vi.spyOn(ConfluenceClient.prototype, 'getPage');
    const updatePage = vi.spyOn(ConfluenceClient.prototype, 'updatePage');
    try {
      const response = await app.inject({
        method: 'POST', url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: commitPayload(ws, 'Keep local until reviewed'),
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: 'sync_conflict_pending', reason: 'sync_conflict_pending',
        message: expect.stringContaining('Resolve the pending Confluence sync conflict') });
      expect(getPage).not.toHaveBeenCalled();
      expect(updatePage).not.toHaveBeenCalled();
      expect((await query(
        'SELECT id FROM page_write_intents WHERE page_ids = ARRAY[$1]::int[] AND status = $2', [pageId, 'pending'],
      )).rows).toEqual([]);
    } finally {
      ws.close();
    }
  });

  it('publishes a collaborative commit after an upstream overwrite leaves diverged revisions', async () => {
    const { token, userId, pageId, confluenceId, spaceKey } = await seedConfluencePage({
      version: 6, bodyHtml: '<p>Unpublished edit</p>',
    });
    await query(`UPDATE pages SET remote_version = 4, local_modified_at = last_synced + INTERVAL '1 second',
                                  local_modified_by = $2 WHERE id = $1`, [pageId, userId]);
    const requests: string[] = [];
    let localVersionAtDispatch = 0;
    const upstream = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
      if (request.method === 'GET' && path.endsWith('/child/attachment')) {
        response.end(JSON.stringify({ results: [], size: 0, _links: {} }));
        return;
      }
      if (path !== `/rest/api/content/${confluenceId}`) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      requests.push(request.method ?? '');
      if (request.method === 'GET') {
        response.end(JSON.stringify({
          id: confluenceId, title: 'Conf page', type: 'page', status: 'current', version: { number: 5 },
          body: { storage: { value: '<p>commit-seed</p>' } },
        }));
        return;
      }
      if (request.method !== 'PUT') {
        response.writeHead(405).end();
        return;
      }
      let bytes = '';
      for await (const chunk of request) bytes += String(chunk);
      const sent = JSON.parse(bytes);
      if (sent.version.number !== 6) {
        response.writeHead(409).end(JSON.stringify({ message: 'Confluence requires its next version' }));
        return;
      }
      localVersionAtDispatch = (await query<{ version: number }>(
        'SELECT version FROM pages WHERE id = $1', [pageId],
      )).rows[0]!.version;
      response.end(JSON.stringify({ ...sent, id: confluenceId, status: 'current' }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const res = await (async () => {
      try {
        const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
        await query('UPDATE user_settings SET confluence_url = $2 WHERE user_id = $1', [userId, baseUrl]);
        const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };
        await sync.syncPage(new ConfluenceClient(baseUrl, 'test-pat'), userId, spaceKey, { id: confluenceId },
          new Date(), new Map(), counts, crypto.randomUUID());
        expect(counts.pagesUpdated).toBe(1);
        expect((await query('SELECT version, remote_version FROM pages WHERE id = $1', [pageId])).rows)
          .toEqual([{ version: 7, remote_version: 5 }]);
        const ws = await openAndSync(pageId, token);
        const response = await app.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/collab/commit`,
          headers: { authorization: `Bearer ${token}` },
          payload: commitPayload(ws, 'Pushed'),
        });
        expect(Number(await getRedisClient()!.sCard(`collab:active:${pageId}`))).toBeGreaterThan(0);
        ws.close();
        return response;
      } finally {
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) => upstream.close((err) => err ? reject(err) : resolve()));
      }
    })();

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: pageId,
      title: 'Pushed',
      version: 8,
      source: 'confluence',
      pushedToConfluence: true,
    });
    expect(requests).toEqual(['GET', 'GET', 'PUT']);
    expect(localVersionAtDispatch).toBe(7);

    const page = await query<{
      version: number;
      remote_version: number;
      title: string;
      body_storage: string | null;
      last_synced: Date | null;
      local_modified_at: Date | null;
      summary_status: string;
      quality_status: string;
    }>(
      `SELECT version, remote_version, title, body_storage, last_synced, local_modified_at, summary_status, quality_status
         FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(page.rows[0]).toMatchObject({ version: 8, remote_version: 6 });
    expect((await query('SELECT status FROM page_write_intents WHERE page_ids = ARRAY[$1]::int[]', [pageId])).rows)
      .toEqual([{ status: 'completed' }]);
    expect(page.rows[0]!.title).toBe('Pushed');
    expect(page.rows[0]!.body_storage).toBe('<p>commit-seed</p>');
    expect(page.rows[0]!.last_synced).not.toBeNull();
    expect(page.rows[0]!.local_modified_at).toBeNull();
    expect(page.rows[0]!.summary_status).toBe('pending');
    expect(page.rows[0]!.quality_status).toBe('pending');
  });

  // #1762 — the room's own debounced autosave lands while the provider read
  // is in flight, i.e. after the route's first read and before the reservation.
  async function typeIntoLiveRoom(ws: WebSocket, text: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    applySyncFrame(doc, await exchangeSyncStep1(ws, doc));
    const paragraph = new Y.XmlElement('paragraph');
    const typed = new Y.XmlText();
    typed.insert(0, text);
    paragraph.insert(0, [typed]);
    const fragment = doc.getXmlFragment('default');
    fragment.insert(fragment.length, [paragraph]);
    ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(doc)));
    // The reply is ordered after the update on the same socket/frame chain.
    applySyncFrame(doc, await exchangeSyncStep1(ws, doc));
    return doc;
  }

  async function contentRevisionOf(pageId: number): Promise<bigint> {
    const row = await query<{ content_revision: string }>(
      'SELECT content_revision::text FROM pages WHERE id = $1',
      [pageId],
    );
    return BigInt(row.rows[0]!.content_revision);
  }

  async function commitIntents(pageId: number): Promise<Array<{ kind: string; status: string }>> {
    const rows = await query<{ kind: string; status: string }>(
      `SELECT kind, status FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::integer[] ORDER BY created_at`,
      [pageId],
    );
    return rows.rows;
  }

  function confluenceUpdateEcho(confluenceId: string) {
    return vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(
      async (_id, title, storage) => ({
        id: confluenceId,
        title,
        status: 'current',
        type: 'page',
        version: { number: 5, when: '2026-11-10T00:00:01Z' },
        body: { storage: { value: storage } },
      }) as never,
    );
  }

  /**
   * Save right after typing while getPage outlasts the 2 s debounce. getPage
   * lands the pending autosave through flushCollabPersist (the same
   * enqueuePersist → persistAndSnapshot path the debounce timer runs) instead
   * of sleeping past the timer.
   */
  async function saveWhileAutosaveLands(change: 'none' | 'lifecycle' | 'local' | 'remote') {
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({ version: change === 'local' ? 5 : 4 });
    await query('UPDATE pages SET remote_version = 4 WHERE id = $1', [pageId]);
    const doc = await typeIntoLiveRoom(ws, 'typed right before Save');
    const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
    expect(room.persistTimer, 'the debounced autosave is still pending at Save').not.toBeNull();
    const before = await contentRevisionOf(pageId);
    let during: bigint | undefined;
    vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
      await persist.flushCollabPersist(room);
      during = await contentRevisionOf(pageId);
      if (change === 'lifecycle') {
        await query(
          'UPDATE pages SET lifecycle_revision = lifecycle_revision + 1 WHERE id = $1',
          [pageId],
        );
      }
      if (change === 'local') {
        await query('UPDATE pages SET version = version + 1 WHERE id = $1', [pageId]);
      }
      return {
        id: confluenceId,
        title: 'Conf page',
        status: 'current',
        type: 'page',
        version: { number: change === 'remote' ? 7 : 4, when: '2026-11-10T00:00:00Z' },
      } as never;
    });
    const updatePage = confluenceUpdateEcho(confluenceId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: commitPayload(ws, 'Saved during autosave', Y.snapshot(doc)),
    });
    return { res, pageId, ws, doc, updatePage, before, during };
  }

  it('room autosave landing during a slow getPage does not refuse the Save (#1762)', async () => {
    const { res, pageId, ws, doc, updatePage, before, during } = await saveWhileAutosaveLands('none');
    try {
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        id: pageId,
        version: 5,
        source: 'confluence',
        pushedToConfluence: true,
      });
      expect(during).toBeGreaterThan(before);
      expect(updatePage).toHaveBeenCalledTimes(1);
      expect(updatePage.mock.calls[0]![3]).toBe(4);
      expect(String(updatePage.mock.calls[0]![2])).toContain('typed right before Save');
      expect(await commitIntents(pageId)).toEqual([
        { kind: 'collab.commit.confluence', status: 'completed' },
      ]);
    } finally {
      ws.close();
      doc.destroy();
    }
  });

  it.each(['lifecycle', 'local', 'remote'] as const)(
    'a %s change in the same autosave window still refuses before any intent (#1762)',
    async (change) => {
      const { res, pageId, ws, doc, updatePage, before, during } = await saveWhileAutosaveLands(change);
      try {
        expect(res.statusCode).toBe(409);
        const expectedError = {
          lifecycle: { reason: 'stale_lifecycle' },
          local: { reason: 'collab_commit_identity_changed' },
          remote: { code: 'confluence_modified', remoteVersion: 7, localVersion: 4 },
        };
        expect(res.json()).toMatchObject(expectedError[change]);
        expect(during).toBeGreaterThan(before);
        expect(updatePage).not.toHaveBeenCalled();
        expect(await commitIntents(pageId)).toEqual([]);
        const page = await query<{ version: number }>('SELECT version FROM pages WHERE id = $1', [pageId]);
        expect(page.rows[0]!.version).toBe(change === 'local' ? 6 : 4);
      } finally {
        ws.close();
        doc.destroy();
      }
    },
  );

  it('peer-pod autosave landing during the commit pod getPage does not refuse the Save (#1762)', async () => {
    const { token, userId } = await createUser(`collab_cf_peer_${pageIdEntropy()}`);
    const spaceKey = `PP${pageIdEntropy().slice(0, 6).toUpperCase()}`;
    const confluenceId = `cf-peer-${pageIdEntropy()}`;
    const pageId = await insertConfluencePage({
      spaceKey,
      confluenceId,
      version: 4,
      bodyHtml: '<p>peer-seed</p>',
    });
    await grantSpaceRead(userId, spaceKey);
    await seedConfluenceCredentials(userId);
    await enableCollabFlag();
    const editingRevision = await pageLifecycleRevision(pageId);
    const podA = await createCollabRuntime(getRedisClient()!, 'autosave-peer-pod-a');
    try {
      await podA.attachSocket(pageId, {
        id: 'pod-a-writer',
        ws: { readyState: 1, send() {}, close() {} } as unknown as NodeWs,
        userId,
        writable: true,
        expectedLifecycleRevision: editingRevision,
      });
      const roomA = podA.getRoom(pageId)!;
      const paragraph = new Y.XmlElement('paragraph');
      const typed = new Y.XmlText();
      typed.insert(0, 'typed on pod A');
      paragraph.insert(0, [typed]);
      const fragment = roomA.doc.getXmlFragment('default');
      fragment.insert(fragment.length, [paragraph]);
      expect(roomA.persistTimer, 'pod A autosave is still pending at Save').not.toBeNull();
      const before = await contentRevisionOf(pageId);
      let during: bigint | undefined;
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
        await persist.flushCollabPersist(roomA);
        during = await contentRevisionOf(pageId);
        return {
          id: confluenceId,
          title: 'Conf page',
          status: 'current',
          type: 'page',
          version: { number: 4, when: '2026-11-10T00:00:00Z' },
        } as never;
      });
      const updatePage = confluenceUpdateEcho(confluenceId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          title: 'Saved from pod B',
          expectedLifecycleRevision: editingRevision,
          expectedDocumentState: Buffer.from(Y.encodeSnapshot(Y.snapshot(roomA.doc))).toString('base64'),
        },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ id: pageId, version: 5, pushedToConfluence: true });
      expect(getDefaultCollabRuntime()?.getRoom(pageId)).toBeUndefined();
      expect(during).toBeGreaterThan(before);
      expect(String(updatePage.mock.calls[0]?.[2])).toContain('typed on pod A');
      expect(await commitIntents(pageId)).toEqual([
        { kind: 'collab.commit.confluence', status: 'completed' },
      ]);
    } finally {
      await podA.close();
    }
  });

  it('reserves terminal-only durable ownership before the first pasted-image mutation', async () => {
    const fixture = await createPastedImageRoot();
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({
      version: 4,
      bodyHtml: '<p>image</p><img src="/api/attachments/local-src/pasted.png">',
    });
    try {
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockResolvedValue({
        id: confluenceId,
        title: 'Conf page',
        status: 'current',
        type: 'page',
        version: { number: 4, when: '2026-09-20T00:00:00Z' },
      } as never);
      const updateAttachment = vi.spyOn(
        ConfluenceClient.prototype,
        'updateAttachment',
      ).mockImplementation(async (_id, filename) => {
        const pending = await query<{
          kind: string;
          recovery_mode: string;
          effect: {
            expectedRemoteVersion?: string;
            intendedStateDigest?: string;
            images?: Array<{ filename: string; contentSha256: string }>;
          };
          remote_effect_started_at: Date | null;
        }>(
          `SELECT kind, recovery_mode, effect, remote_effect_started_at
             FROM page_write_intents
            WHERE page_ids = ARRAY[$1]::integer[] AND status = 'pending'`,
          [pageId],
        );
        expect(pending.rows).toHaveLength(1);
        expect(pending.rows[0]).toMatchObject({
          kind: 'collab.commit.confluence.media',
          recovery_mode: 'remote_terminal_only',
          effect: {
            expectedRemoteVersion: '4',
            intendedStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        });
        expect(pending.rows[0]!.effect.images?.[0]).toMatchObject({
          filename: 'pasted.png',
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(pending.rows[0]!.remote_effect_started_at).not.toBeNull();
        return {
          id: 'attachment-1',
          title: filename,
          mediaType: 'image/png',
          version: { number: 1, when: '2026-09-20T00:00:01Z' },
        } as never;
      });
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(
        async (_id, title, storage) => ({
          id: confluenceId,
          title,
          status: 'current',
          type: 'page',
          version: { number: 5, when: '2026-09-20T00:00:02Z' },
          body: { storage: { value: storage } },
        }) as never,
      );

      const response = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: commitPayload(ws, 'Pasted image committed'),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(updateAttachment).toHaveBeenCalledTimes(1);
      const settled = await query<{
        status: string;
        remote_terminal_result: { attachments?: unknown[] };
      }>(
        `SELECT status, remote_terminal_result
           FROM page_write_intents
          WHERE page_ids = ARRAY[$1]::integer[]
          ORDER BY created_at DESC LIMIT 1`,
        [pageId],
      );
      expect(settled.rows[0]?.status).toBe('completed');
      expect(settled.rows[0]?.remote_terminal_result.attachments).toHaveLength(1);
    } finally {
      ws.close();
      await removePastedImageRoot(fixture.root, fixture.priorRoot);
    }
  });

  describe('draw.io previews on a collaborative Save (#1935)', () => {
    const DRAWIO = '<div class="confluence-drawio" data-diagram-name="Arch">'
      + '<img src="/api/attachments/local-src/Arch.png" alt="Arch"></div>';

    async function commitWith(bodyHtml: string) {
      const fixture = await createPastedImageRoot();
      let upstream: ReturnType<typeof createServer> | null = null;
      let ws: WebSocket | null = null;
      try {
        await fs.promises.writeFile(
          path.join(fixture.root, 'local-src', 'Arch.png'),
          Buffer.from('cached drawio preview bytes'),
        );
        const { token, userId, pageId, confluenceId } = await seedConfluencePage({ version: 4, bodyHtml });
        const attachmentPosts: Array<{ filename: string | null; contentType: string }> = [];
        const pagePuts: Array<{ storage: string }> = [];
        upstream = createServer(async (request, response) => {
          const urlPath = new URL(request.url ?? '/', 'http://fixture.test').pathname;
          response.setHeader('content-type', 'application/json');
          if (request.method === 'POST' && urlPath === `/rest/api/content/${confluenceId}/child/attachment`) {
            let raw = '';
            for await (const chunk of request) raw += String(chunk);
            attachmentPosts.push({
              filename: /filename="([^"]*)"/.exec(raw)?.[1] ?? null,
              contentType: String(request.headers['content-type'] ?? ''),
            });
            response.end(JSON.stringify({ results: [{
              id: 'attachment-1',
              title: attachmentPosts.at(-1)!.filename,
              mediaType: 'image/png',
              version: { number: 1, when: '2026-09-20T00:00:01Z' },
            }] }));
            return;
          }
          if (urlPath !== `/rest/api/content/${confluenceId}`) {
            response.writeHead(404).end();
            return;
          }
          if (request.method === 'GET') {
            response.end(JSON.stringify({
              id: confluenceId, title: 'Conf page', type: 'page', status: 'current',
              version: { number: 4, when: '2026-09-20T00:00:00Z' },
              body: { storage: { value: '<p>commit-seed</p>' } },
            }));
            return;
          }
          if (request.method !== 'PUT') {
            response.writeHead(405).end();
            return;
          }
          let bytes = '';
          for await (const chunk of request) bytes += String(chunk);
          const sent = JSON.parse(bytes);
          pagePuts.push({ storage: sent.body.storage.value });
          response.end(JSON.stringify({
            ...sent, id: confluenceId, status: 'current', version: { number: 5, when: '2026-09-20T00:00:02Z' },
          }));
        });
        await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
        await query('UPDATE user_settings SET confluence_url = $2 WHERE user_id = $1', [userId, baseUrl]);

        ws = await openAndSync(pageId, token);
        const response = await app.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/collab/commit`,
          headers: { authorization: `Bearer ${token}` },
          payload: commitPayload(ws, 'Drawio commit'),
        });
        expect(response.statusCode, response.body).toBe(200);
        const intents = await query<{ kind: string; status: string }>(
          `SELECT kind, status FROM page_write_intents
            WHERE page_ids = ARRAY[$1]::integer[] ORDER BY created_at`,
          [pageId],
        );
        return { attachmentPosts, pagePuts, intents: intents.rows };
      } finally {
        ws?.close();
        if (upstream) {
          upstream.closeAllConnections();
          await new Promise<void>((resolve) => upstream!.close(() => resolve()));
        }
        await removePastedImageRoot(fixture.root, fixture.priorRoot);
      }
    }

    it('reserves the non-media kind and uploads nothing for a page with only draw.io previews', async () => {
      const { attachmentPosts, pagePuts, intents } = await commitWith(`<p>text</p>${DRAWIO}`);

      expect(attachmentPosts).toEqual([]);
      expect(pagePuts).toHaveLength(1);
      expect(pagePuts[0]!.storage).toContain('ac:name="drawio"');
      expect(pagePuts[0]!.storage).toContain('<ac:parameter ac:name="diagramName">Arch</ac:parameter>');
      expect(intents).toEqual([{ kind: 'collab.commit.confluence', status: 'completed' }]);
    });

    it('reserves the media kind and uploads exactly the pasted image next to a draw.io preview', async () => {
      const { attachmentPosts, pagePuts, intents } = await commitWith(
        `<p>text</p>${DRAWIO}<img src="/api/attachments/local-src/pasted.png">`,
      );

      expect(attachmentPosts).toHaveLength(1);
      expect(attachmentPosts[0]).toMatchObject({ filename: 'pasted.png' });
      expect(attachmentPosts[0]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(pagePuts).toHaveLength(1);
      expect(pagePuts[0]!.storage).toContain('ac:name="drawio"');
      expect(pagePuts[0]!.storage).toContain('<ac:parameter ac:name="diagramName">Arch</ac:parameter>');
      expect(pagePuts[0]!.storage).toContain('ri:filename="pasted.png"');
      expect(intents).toEqual([{ kind: 'collab.commit.confluence.media', status: 'completed' }]);
    });
  });


  it('cancels before remote dispatch when planned pasted-image bytes change', async () => {
    const fixture = await createPastedImageRoot();
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({
      version: 4,
      bodyHtml: '<p>image</p><img src="/api/attachments/local-src/pasted.png">',
    });
    try {
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
        await fs.promises.writeFile(
          path.join(fixture.root, 'local-src', 'pasted.png'),
          Buffer.from('bytes changed after planning'),
        );
        return {
          id: confluenceId,
          title: 'Conf page',
          status: 'current',
          type: 'page',
          version: { number: 4, when: '2026-09-20T00:00:00Z' },
        } as never;
      });
      const updateAttachment = vi.spyOn(ConfluenceClient.prototype, 'updateAttachment');
      const updatePage = vi.spyOn(ConfluenceClient.prototype, 'updatePage');

      const response = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: commitPayload(ws, 'Changed pasted image'),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().reason).toBe('pasted_image_unavailable');
      expect(updateAttachment).not.toHaveBeenCalled();
      expect(updatePage).not.toHaveBeenCalled();
      const cancelled = await query<{
        status: string;
        remote_effect_started_at: Date | null;
      }>(
        `SELECT status, remote_effect_started_at
           FROM page_write_intents
          WHERE page_ids = ARRAY[$1]::integer[]
          ORDER BY created_at DESC LIMIT 1`,
        [pageId],
      );
      expect(cancelled.rows[0]).toEqual({
        status: 'cancelled',
        remote_effect_started_at: null,
      });
    } finally {
      ws.close();
      await removePastedImageRoot(fixture.root, fixture.priorRoot);
    }
  });

  it('keeps an unknown pasted-image acknowledgment pending and never issues the page PUT', async () => {
    const fixture = await createPastedImageRoot();
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({
      version: 4,
      bodyHtml: '<p>image</p><img src="/api/attachments/local-src/pasted.png">',
    });
    try {
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockResolvedValue({
        id: confluenceId,
        title: 'Conf page',
        status: 'current',
        type: 'page',
        version: { number: 4, when: '2026-09-20T00:00:00Z' },
      } as never);
      vi.spyOn(ConfluenceClient.prototype, 'updateAttachment').mockRejectedValue(
        new Error('connection reset after attachment bytes were sent'),
      );
      const updatePage = vi.spyOn(ConfluenceClient.prototype, 'updatePage');

      const response = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: commitPayload(ws, 'Unknown image outcome'),
      });

      expect(response.statusCode).toBe(500);
      expect(updatePage).not.toHaveBeenCalled();
      const pending = await query<{
        kind: string;
        status: string;
        recovery_mode: string;
        remote_effect_started_at: Date | null;
        remote_effects_completed_at: Date | null;
      }>(
        `SELECT kind, status, recovery_mode, remote_effect_started_at,
                remote_effects_completed_at
           FROM page_write_intents
          WHERE page_ids = ARRAY[$1]::integer[]
          ORDER BY created_at DESC LIMIT 1`,
        [pageId],
      );
      expect(pending.rows[0]).toMatchObject({
        kind: 'collab.commit.confluence.media',
        status: 'pending',
        recovery_mode: 'remote_terminal_only',
        remote_effects_completed_at: null,
      });
      expect(pending.rows[0]!.remote_effect_started_at).not.toBeNull();
    } finally {
      ws.close();
      await removePastedImageRoot(fixture.root, fixture.priorRoot);
    }
  });

  it.each(['actor', 'acl', 'lifecycle'] as const)(
    'rechecks %s after the remote read and before any remote mutation',
    async (revocation) => {
      const fixture = await createPastedImageRoot();
      const {
        token, userId, pageId, confluenceId, spaceKey, ws,
      } = await seedLiveConfluencePage({
        version: 4,
        bodyHtml: '<p>image</p><img src="/api/attachments/local-src/pasted.png">',
      });
      try {
        vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
          if (revocation === 'actor') {
            await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);
          } else if (revocation === 'acl') {
            await query(
              `DELETE FROM space_role_assignments
                WHERE space_key = $1 AND principal_type = 'user' AND principal_id = $2`,
              [spaceKey, userId],
            );
          } else {
            await query(
              'UPDATE pages SET lifecycle_revision = lifecycle_revision + 1 WHERE id = $1',
              [pageId],
            );
          }
          return {
            id: confluenceId,
            title: 'Conf page',
            status: 'current',
            type: 'page',
            version: { number: 4, when: '2026-09-20T00:00:00Z' },
          } as never;
        });
        const updateAttachment = vi.spyOn(ConfluenceClient.prototype, 'updateAttachment');
        const updatePage = vi.spyOn(ConfluenceClient.prototype, 'updatePage');

        const response = await app.inject({
          method: 'POST',
          url: `/api/pages/${pageId}/collab/commit`,
          headers: { authorization: `Bearer ${token}` },
          payload: commitPayload(ws, 'Revoked after read'),
        });

        expect(response.statusCode).toBe(revocation === 'lifecycle' ? 409 : 403);
        expect(response.json().reason).toBe(
          revocation === 'lifecycle' ? 'stale_lifecycle' : 'collab_commit_authority_changed',
        );
        expect(updateAttachment).not.toHaveBeenCalled();
        expect(updatePage).not.toHaveBeenCalled();
      } finally {
        ws.close();
        await removePastedImageRoot(fixture.root, fixture.priorRoot);
      }
    },
  );

  describe('pasted images after a collaborative Save (#1764)', () => {
    const IMAGE_SRC = '/api/attachments/local-src/x.png';
    const MARK_FILE = 'data-confluence-filename="x.png"';
    const MARK_SOURCE = 'data-confluence-image-source="attachment"';
    const MEDIA_THEN_TEXT = [
      { kind: 'collab.commit.confluence.media', status: 'completed' },
      { kind: 'collab.commit.confluence', status: 'completed' },
    ];

    type ImageEditor = {
      ws: WebSocket;
      doc: Y.Doc;
      /** Every control frame with the editor's HTML at the moment it arrived. */
      controls: Array<{ type: string; html: string }>;
      closeInfo: { code: number; reason: string } | null;
    };

    async function seedImagePage(): Promise<{
      token: string;
      userId: string;
      pageId: number;
      confluenceId: string;
    }> {
      const { token, userId } = await createUser(`collab_img_${pageIdEntropy()}`);
      const spaceKey = `IM${pageIdEntropy().slice(0, 6).toUpperCase()}`;
      const confluenceId = `cf-${pageIdEntropy()}`;
      const pageId = await insertConfluencePage({
        spaceKey,
        confluenceId,
        version: 4,
        bodyHtml: `<p>image</p><img src="${IMAGE_SRC}">`,
      });
      await grantSpaceRead(userId, spaceKey);
      await seedConfluenceCredentials(userId);
      await enableCollabFlag();
      return { token, userId, pageId, confluenceId };
    }

    /** A writable editor whose document follows the room. */
    async function joinImageEditor(pageId: number, token: string): Promise<ImageEditor> {
      const ws = await openWritableWhatwg(pageId, token);
      const editor: ImageEditor = { ws, doc: new Y.Doc(), controls: [], closeInfo: null };
      ws.addEventListener('close', (ev) => {
        editor.closeInfo = { code: ev.code, reason: String(ev.reason ?? '') };
      });
      ws.addEventListener('message', (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const frame = new Uint8Array(ev.data);
        const control = decodeControl(frame);
        if (control) editor.controls.push({ type: control.type, html: yDocToHtml(editor.doc) });
        else applySyncFrame(editor.doc, frame);
      });
      await exchangeSyncStep1(ws, editor.doc);
      return editor;
    }

    /** Edit the editor's document and send its state, as a typing client would. */
    function sendEditorEdit(editor: ImageEditor, edit: (fragment: Y.XmlFragment) => void): void {
      editor.doc.transact(() => edit(editor.doc.getXmlFragment('default')));
      editor.ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(editor.doc)));
    }

    function appendParagraph(fragment: Y.XmlFragment, text: string): void {
      const paragraph = new Y.XmlElement('paragraph');
      const content = new Y.XmlText();
      content.insert(0, text);
      paragraph.insert(0, [content]);
      fragment.push([paragraph]);
    }

    /** Confluence for consecutive Saves: the remote version follows each accepted PUT. */
    function mockImageProvider(confluenceId: string, onFirstRead?: () => Promise<void>) {
      let remoteVersion = 4;
      let reads = 0;
      const uploads: string[] = [];
      const storages: string[] = [];
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
        reads += 1;
        if (reads === 1) await onFirstRead?.();
        return {
          id: confluenceId,
          title: 'Conf page',
          status: 'current',
          type: 'page',
          version: { number: remoteVersion, when: '2026-11-10T00:00:00Z' },
        } as never;
      });
      vi.spyOn(ConfluenceClient.prototype, 'updateAttachment').mockImplementation(async (_id, filename) => {
        uploads.push(filename);
        return {
          id: `attachment-${uploads.length}`,
          title: filename,
          mediaType: 'image/png',
          version: {
            number: uploads.filter((uploaded) => uploaded === filename).length,
            when: '2026-11-10T00:00:01Z',
          },
        } as never;
      });
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(
        async (_id, title, storage, version) => {
          storages.push(storage);
          remoteVersion = version + 1;
          return {
            id: confluenceId,
            title,
            status: 'current',
            type: 'page',
            version: { number: remoteVersion, when: '2026-11-10T00:00:02Z' },
            body: { storage: { value: storage } },
          } as never;
        },
      );
      return { uploads, storages };
    }

    function save(pageId: number, token: string, payload: CollabCommit) {
      return app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    }

    async function savedIntents(pageId: number): Promise<Array<{ kind: string; status: string }>> {
      const rows = await query<{ kind: string; status: string }>(
        `SELECT kind, status FROM page_write_intents
          WHERE page_ids = ARRAY[$1]::integer[] ORDER BY created_at`,
        [pageId],
      );
      return rows.rows;
    }

    async function bodyHtmlOf(pageId: number): Promise<string> {
      const row = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId]);
      return row.rows[0]!.body_html;
    }

    async function activePurposes(pageId: number): Promise<string[]> {
      const rows = await query<{ purpose: string }>(
        `SELECT purpose FROM page_runtime_admissions
          WHERE page_id = $1 AND released_at IS NULL ORDER BY purpose`,
        [pageId],
      );
      return rows.rows.map((row) => row.purpose);
    }

    it('Save 2 after a pasted-image Save uploads nothing, is a text-only collab.commit.confluence intent, and the markers survive the next persist (#1764)', async () => {
      const fixture = await createPastedImageRoot('x.png');
      try {
        const { token, pageId, confluenceId } = await seedImagePage();
        const editor = await joinImageEditor(pageId, token);
        const provider = mockImageProvider(confluenceId);

        const first = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
        expect(first.statusCode, first.body).toBe(200);
        expect(provider.uploads).toEqual(['x.png']);

        // A text-only edit, then the room's next persist.
        const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
        sendEditorEdit(editor, (fragment) => appendParagraph(fragment, 'TEXT_AFTER_SAVE_1'));
        await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('TEXT_AFTER_SAVE_1'));
        await persist.flushCollabPersist(room);
        const afterPersist = await bodyHtmlOf(pageId);

        const second = await save(pageId, token, commitPayload(editor.ws, 'Save 2', Y.snapshot(editor.doc)));
        expect(second.statusCode, second.body).toBe(200);
        expect.soft(provider.uploads).toEqual(['x.png']);
        expect.soft(await savedIntents(pageId)).toEqual(MEDIA_THEN_TEXT);
        expect.soft(afterPersist).toContain(MARK_FILE);
        expect.soft(afterPersist).toContain(MARK_SOURCE);
        // Save 2's storage still references the attachment Save 1 uploaded.
        expect(provider.storages[1]).toContain('<ri:attachment ri:filename="x.png">');
        editor.ws.close();
      } finally {
        await removePastedImageRoot(fixture.root, fixture.priorRoot);
      }
    });

    it('marks the images in the saving editor\'s document after the intent settles and before pages_version, without doc_reset (#1764)', async () => {
      const fixture = await createPastedImageRoot('x.png');
      try {
        const { token, pageId, confluenceId } = await seedImagePage();
        const editor = await joinImageEditor(pageId, token);
        mockImageProvider(confluenceId);
        const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
        const intentStatusAtMark: Array<Promise<string | undefined>> = [];
        room.doc.on('update', (_update: Uint8Array, origin: unknown) => {
          if (origin !== COLLAB_IMAGE_MARKER_ORIGIN) return;
          intentStatusAtMark.push(query<{ status: string }>(
            `SELECT status FROM page_write_intents
              WHERE page_ids = ARRAY[$1]::integer[] ORDER BY created_at DESC LIMIT 1`,
            [pageId],
          ).then((result) => result.rows[0]?.status));
        });

        const res = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
        expect(res.statusCode, res.body).toBe(200);
        await vi.waitFor(() => {
          expect(editor.controls.map((control) => control.type)).toContain('pages_version');
        });

        expect.soft(await Promise.all(intentStatusAtMark)).toEqual(['completed']);
        const pagesVersion = editor.controls.find((control) => control.type === 'pages_version')!;
        expect.soft(pagesVersion.html).toContain(MARK_FILE);
        expect.soft(pagesVersion.html).toContain(MARK_SOURCE);
        // The editor stays open and writable: no reset, no close.
        expect(editor.controls.map((control) => control.type)).not.toContain('doc_reset');
        expect(editor.closeInfo).toBeNull();
        sendEditorEdit(editor, (fragment) => appendParagraph(fragment, 'TYPED_AFTER_SAVE'));
        await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('TYPED_AFTER_SAVE'));
        editor.ws.close();
      } finally {
        await removePastedImageRoot(fixture.root, fixture.priorRoot);
      }
    });

    it('marks the room on the peer pod that owns it when the Save runs on a pod without the room (#1764)', async () => {
      const fixture = await createPastedImageRoot('x.png');
      const { token, userId, pageId, confluenceId } = await seedImagePage();
      const revision = await pageLifecycleRevision(pageId);
      const podA = await createCollabRuntime(getRedisClient()!, 'image-markers-pod-a');
      try {
        await podA.attachSocket(pageId, {
          id: 'pod-a-writer',
          ws: { readyState: 1, send() {}, close() {} } as unknown as NodeWs,
          userId,
          writable: true,
          expectedLifecycleRevision: revision,
        });
        const roomA = podA.getRoom(pageId)!;
        const provider = mockImageProvider(confluenceId);
        const payload = (title: string): CollabCommit => ({
          title,
          expectedLifecycleRevision: revision,
          expectedDocumentState: EMPTY_DOCUMENT_STATE,
        });

        const first = await save(pageId, token, payload('Save 1'));
        expect(first.statusCode, first.body).toBe(200);
        expect(getDefaultCollabRuntime()!.getRoom(pageId)).toBeUndefined();
        // In pod A's memory: the Redis request, not a merge of the persisted document.
        await vi.waitFor(() => expect(yDocToHtml(roomA.doc)).toContain(MARK_FILE), { timeout: 5_000 });
        await persist.flushCollabPersist(roomA);
        expect(await bodyHtmlOf(pageId)).toContain(MARK_FILE);

        const second = await save(pageId, token, payload('Save 2'));
        expect(second.statusCode, second.body).toBe(200);
        expect(provider.uploads).toEqual(['x.png']);
        expect(await savedIntents(pageId)).toEqual(MEDIA_THEN_TEXT);
      } finally {
        await podA.close();
        await removePastedImageRoot(fixture.root, fixture.priorRoot);
      }
    });

    it('the markers survive when the only writer left before the Save settled and no room owns the page (#1764)', async () => {
      const fixture = await createPastedImageRoot('x.png');
      try {
        const { token, pageId, confluenceId } = await seedImagePage();
        const leaving = await joinImageEditor(pageId, token);
        // Persist the room's own rendering first, so the leave flush inside the
        // provider read changes no protected column (on a base without #1762 it
        // would otherwise refuse this Save as stale_content_revision).
        await persist.flushCollabPersist(getDefaultCollabRuntime()!.getRoom(pageId)!);
        const provider = mockImageProvider(confluenceId, async () => {
          leaving.ws.close();
          await vi.waitFor(async () => {
            expect(await activePurposes(pageId)).not.toContain('collab_room');
          }, { timeout: 5_000 });
        });

        const first = await save(pageId, token, commitPayload(leaving.ws, 'Save 1', Y.snapshot(leaving.doc)));
        expect(first.statusCode, first.body).toBe(200);
        expect(await activePurposes(pageId)).toEqual([]);
        expect.soft(await persist.htmlFromPersistedDoc(pageId)).toContain(MARK_FILE);

        const rejoined = await joinImageEditor(pageId, token);
        const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
        expect.soft(yDocToHtml(room.doc)).toContain(MARK_FILE);
        sendEditorEdit(rejoined, (fragment) => appendParagraph(fragment, 'TEXT_AFTER_REJOIN'));
        await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('TEXT_AFTER_REJOIN'));
        await persist.flushCollabPersist(room);
        expect.soft(await bodyHtmlOf(pageId)).toContain(MARK_FILE);

        const second = await save(pageId, token, commitPayload(rejoined.ws, 'Save 2', Y.snapshot(rejoined.doc)));
        expect(second.statusCode, second.body).toBe(200);
        expect.soft(provider.uploads).toEqual(['x.png']);
        expect.soft(await savedIntents(pageId)).toEqual(MEDIA_THEN_TEXT);
        rejoined.ws.close();
      } finally {
        await removePastedImageRoot(fixture.root, fixture.priorRoot);
      }
    });

    it('Save 2 uploads only an image pasted after Save 1 (#1764)', async () => {
      const fixture = await createPastedImageRoot('x.png');
      try {
        await fs.promises.writeFile(
          path.join(fixture.root, 'local-src', 'y.png'),
          Buffer.from('image pasted after Save 1'),
        );
        const { token, pageId, confluenceId } = await seedImagePage();
        const editor = await joinImageEditor(pageId, token);
        const provider = mockImageProvider(confluenceId);

        const first = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
        expect(first.statusCode, first.body).toBe(200);
        const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
        sendEditorEdit(editor, (fragment) => {
          const image = new Y.XmlElement('image');
          image.setAttribute('src', '/api/attachments/local-src/y.png');
          fragment.push([image]);
        });
        await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('/api/attachments/local-src/y.png'));

        const second = await save(pageId, token, commitPayload(editor.ws, 'Save 2', Y.snapshot(editor.doc)));
        expect(second.statusCode, second.body).toBe(200);
        expect(provider.uploads).toEqual(['x.png', 'y.png']);
        // Save 2 did upload the new image, so it stays a media commit.
        expect(await savedIntents(pageId)).toEqual([
          { kind: 'collab.commit.confluence.media', status: 'completed' },
          { kind: 'collab.commit.confluence.media', status: 'completed' },
        ]);
        editor.ws.close();
      } finally {
        await removePastedImageRoot(fixture.root, fixture.priorRoot);
      }
    });
  });

  describe('ri:url links on a collaborative Save (#1955)', () => {
    const STORED_LINK = '<ac:link><ri:url ri:value="/docs/guide" />'
      + '<ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body></ac:link>';
    const WEB_LINK = '<ac:link><ri:url ri:value="https://example.com/" />'
      + '<ac:plain-text-link-body><![CDATA[example]]></ac:plain-text-link-body></ac:link>';
    const STORAGE = `<p>See ${STORED_LINK} first.</p><p>${'Unrelated prose that keeps the paragraphs apart. '.repeat(3)}</p><p>Web ${WEB_LINK}.</p>`;

    async function seedLinkPage(bodyHtml: string, storage = STORAGE): Promise<{ token: string; pageId: number; confluenceId: string }> {
      const { token, userId } = await createUser(`collab_link_${pageIdEntropy()}`);
      const spaceKey = `LK${pageIdEntropy().slice(0, 6).toUpperCase()}`;
      const confluenceId = `cf-${pageIdEntropy()}`;
      const pageId = await insertConfluencePage({ spaceKey, confluenceId, version: 4, bodyHtml });
      await query('UPDATE pages SET body_storage = $2 WHERE id = $1', [pageId, storage]);
      await grantSpaceRead(userId, spaceKey);
      await seedConfluenceCredentials(userId);
      await enableCollabFlag();
      return { token, pageId, confluenceId };
    }

    async function joinEditor(pageId: number, token: string): Promise<{ ws: WebSocket; doc: Y.Doc }> {
      const ws = await openWritableWhatwg(pageId, token);
      const doc = new Y.Doc();
      ws.addEventListener('message', (ev) => {
        if (ev.data instanceof ArrayBuffer && !decodeControl(new Uint8Array(ev.data))) applySyncFrame(doc, new Uint8Array(ev.data));
      });
      await exchangeSyncStep1(ws, doc);
      return { ws, doc };
    }

    /** Confluence for consecutive Saves: it stores what it is sent and its version follows. */
    function mockProvider(confluenceId: string): { storages: string[]; reads: number } {
      const provider = { storages: [] as string[], reads: 0 };
      let remoteVersion = 4;
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
        provider.reads += 1;
        return {
          id: confluenceId, title: 'Conf page', status: 'current', type: 'page',
          version: { number: remoteVersion, when: '2026-11-12T00:00:00Z' },
        } as never;
      });
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async (_id, title, storage, version) => {
        provider.storages.push(storage);
        remoteVersion = version + 1;
        return {
          id: confluenceId, title, status: 'current', type: 'page',
          version: { number: remoteVersion, when: '2026-11-12T00:00:01Z' },
          body: { storage: { value: storage } },
        } as never;
      });
      return provider;
    }

    const save = (pageId: number, token: string, payload: CollabCommit) => app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

    it('sends the stored link with the page\'s storage as its origin, and a link the page never stored as text', async () => {
      const invented = '<p>New <a href="#confluence-url:javascript%3Aalert%281%29?body=plain">click me</a>.</p>';
      const { token, pageId, confluenceId } = await seedLinkPage(`${confluenceToHtml(STORAGE)}${invented}`);
      const editor = await joinEditor(pageId, token);
      const provider = mockProvider(confluenceId);
      const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
      // The room holds every link as the schema keeps it: fragments and the one real URL.
      expect(yDocToHtml(room.doc)).toContain('href="#confluence-url:javascript%3Aalert%281%29?body=plain"');

      const first = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
      expect(first.statusCode, first.body).toBe(200);
      // The dispatched string, read by the independent oracle.
      expect(oracleUrlLinks(provider.storages[0]!)).toEqual([
        { value: '/docs/guide', link: {}, resource: {}, body: 'plain:the guide', text: 'the guide' },
        { value: 'https://example.com/', link: {}, resource: {}, body: 'plain:example', text: 'example' },
      ]);
      expect(provider.storages[0]).toContain('<p>New click me.</p>');
      // The room keeps its anchors; the next Save is judged against what this one stored, and writes the same bytes.
      expect(yDocToHtml(room.doc)).toContain('href="#confluence-url:javascript%3Aalert%281%29?body=plain"');
      const second = await save(pageId, token, commitPayload(editor.ws, 'Save 2', Y.snapshot(editor.doc)));
      expect(second.statusCode, second.body).toBe(200);
      expect(provider.storages[1]).toBe(provider.storages[0]);
      editor.ws.close();
    });

    it('refuses a Save whose storage cannot be read and holds a url element, before the intent and the PUT (W3)', async () => {
      // A navigable ri:url link beside an external image whose alt holds `<`: write-back leaves that
      // attribute raw, so the storage is not well-formed and what it holds cannot be told.
      const { token, pageId, confluenceId } = await seedLinkPage(
        `${confluenceToHtml(STORAGE)}<p><img src="https://example.com/a.png" alt="a&lt;b"></p>`,
      );
      const editor = await joinEditor(pageId, token);
      const provider = mockProvider(confluenceId);
      const before = await query('SELECT version, body_html, body_storage FROM pages WHERE id = $1', [pageId]);

      const response = await save(pageId, token, commitPayload(editor.ws, 'Save', Y.snapshot(editor.doc)));

      expect(response.statusCode, response.body).toBe(422);
      expect(JSON.parse(response.body)).toMatchObject({ reason: 'not-well-formed' });
      expect(provider.storages).toEqual([]);
      expect((await query('SELECT 1 FROM page_write_intents WHERE page_ids = ARRAY[$1]::int[]', [pageId])).rowCount).toBe(0);
      expect((await query('SELECT version, body_html, body_storage FROM pages WHERE id = $1', [pageId])).rows).toEqual(before.rows);
      // The room is still there, with its content.
      expect(getDefaultCollabRuntime()!.getRoom(pageId)).toBeDefined();
      editor.ws.close();
    });

    // Review r6, R25 and coordinator decision D20: an info panel re-parses its body before its links are read, so
    // the carrier the room holds has LF where the stored blog title has CR. That Save is refused before any effect;
    // the same link in a paragraph is dispatched with the CR XML reads, on both Saves. Review r7, R28 (owner decision
    // D21): a paragraph before the panel whose CDATA would not be XML once turned into text changes nothing.
    const releaseLink = '<ac:link><ri:blog-post ri:content-title="Release&#13;notes" ri:space-key="OPS" /></ac:link>';
    const releasePanel = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>see ${releaseLink} now</p></ac:rich-text-body></ac:structured-macro>`;
    it.each([
      ['an info panel', releasePanel, 422],
      ['an info panel after escaped `]]>` prose (R28)', `<p>]]&gt;</p>${releasePanel}`, 422],
      ['an info panel after CDATA `]]` and a literal `>` (R28)', `<p><![CDATA[]]]]>></p>${releasePanel}`, 422],
      ['a paragraph', `<p>see ${releaseLink} now</p>`, 200],
    ])('dispatches a stored blog title with a CR in %s as XML reads it, or refuses the Save, twice (R25)', async (_where, storage, status) => {
      const { token, pageId, confluenceId } = await seedLinkPage(confluenceToHtml(storage), storage);
      const editor = await joinEditor(pageId, token);
      const provider = mockProvider(confluenceId);
      const before = await query('SELECT version, body_html, body_storage FROM pages WHERE id = $1', [pageId]);

      for (const label of ['Save 1', 'Save 2']) {
        const response = await save(pageId, token, commitPayload(editor.ws, label, Y.snapshot(editor.doc)));
        expect(response.statusCode, response.body).toBe(status);
        if (status === 422) expect(JSON.parse(response.body)).toMatchObject({ reason: 'changed-link-target' });
      }

      if (status === 422) {
        expect(provider.storages).toEqual([]);
        expect((await query('SELECT 1 FROM page_write_intents WHERE page_ids = ARRAY[$1]::int[]', [pageId])).rowCount).toBe(0);
        expect((await query('SELECT version, body_html, body_storage FROM pages WHERE id = $1', [pageId])).rows).toEqual(before.rows);
        expect(getDefaultCollabRuntime()!.getRoom(pageId)).toBeDefined();
      } else {
        // Each provider payload, read by the independent oracle, holds the title XML reads from the stored page.
        expect(provider.storages).toHaveLength(2);
        for (const dispatched of provider.storages) {
          expect(oracleElements(dispatched, 'ri', 'blog-post').map((el) => el.getAttribute('ri:content-title'))).toEqual(['Release\rnotes']);
        }
      }
      editor.ws.close();
    });

    // Review r8 (R31, R32) and the D21 fallback: a relative link the room holds that no visible stored occurrence
    // proves is dispatched as its text, on both Saves: beside a deleted ordinary anchor spelled `A` or `HREF`, which
    // the editor showed as an anchor with the same text, and from a link only a status macro's parameter held.
    const guideLink = '<ac:link><ri:url ri:value="/guide" /><ac:plain-text-link-body><![CDATA[Guide]]></ac:plain-text-link-body></ac:link>';
    const movedGuide = '<p>Moved here: <a href="#confluence-url:%2Fguide?body=plain">Guide</a></p>';
    const prose = `<p>${'Unrelated prose that keeps the paragraphs apart. '.repeat(3)}</p>`;
    it.each([
      ['an ordinary anchor spelled `A` (R31)', `<p>${guideLink}</p>${prose}<p>Web <A href="https://example.com/">Guide</A>.</p>`, `${movedGuide}${prose}`],
      ['an ordinary anchor spelled `HREF` (R31)', `<p>${guideLink}</p>${prose}<p>Web <a HREF="https://example.com/">Guide</a>.</p>`, `${movedGuide}${prose}`],
      ['a status macro parameter (R32)', `<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">${guideLink}</ac:parameter></ac:structured-macro>`, null],
    ])('dispatches an unproven relative link as its text beside %s, twice', async (_case, storage, edited) => {
      const bodyHtml = edited ?? `${confluenceToHtml(storage)}${movedGuide}`;
      const { token, pageId, confluenceId } = await seedLinkPage(bodyHtml, storage);
      const editor = await joinEditor(pageId, token);
      const provider = mockProvider(confluenceId);

      for (const label of ['Save 1', 'Save 2']) {
        const response = await save(pageId, token, commitPayload(editor.ws, label, Y.snapshot(editor.doc)));
        expect(response.statusCode, response.body).toBe(200);
      }
      expect(provider.storages).toHaveLength(2);
      for (const dispatched of provider.storages) {
        expect(oracleUrlLinks(dispatched)).toEqual([]);
        expect(dispatched).toContain('Moved here: Guide');
      }
      editor.ws.close();
    });
  });

  describe('link bodies on a collaborative Save (#1954)', () => {
    const image = (filename: string): string => `<ac:image><ri:attachment ri:filename="${filename}" /></ac:image>`;
    const imageOut = (filename: string): string => `<ac:image><ri:attachment ri:filename="${filename}"></ri:attachment></ac:image>`;
    const FILLER = `<p>${'Unrelated prose that keeps the paragraphs apart. '.repeat(3)}</p>`;
    const FILLER_OUT = FILLER.replace(' </p>', '</p>');

    interface LinkBodyRoom {
      ws: WebSocket;
      storages: string[];
      save: (label: string) => Promise<{ statusCode: number; body: string }>;
      room: () => string;
    }

    /** A Confluence page with `storage`, a writable collaborative editor in its room, and Confluence for consecutive Saves. */
    async function openRoom(storage: string): Promise<LinkBodyRoom> {
      const { token, userId } = await createUser(`collab_linkbody_${pageIdEntropy()}`);
      const spaceKey = `LB${pageIdEntropy().slice(0, 6).toUpperCase()}`;
      const confluenceId = `cf-${pageIdEntropy()}`;
      const pageId = await insertConfluencePage({ spaceKey, confluenceId, version: 4, bodyHtml: confluenceToHtml(storage, '55') });
      await query('UPDATE pages SET body_storage = $2 WHERE id = $1', [pageId, storage]);
      await grantSpaceRead(userId, spaceKey);
      await seedConfluenceCredentials(userId);
      await enableCollabFlag();

      const ws = await openWritableWhatwg(pageId, token);
      const doc = new Y.Doc();
      ws.addEventListener('message', (ev) => {
        if (ev.data instanceof ArrayBuffer && !decodeControl(new Uint8Array(ev.data))) applySyncFrame(doc, new Uint8Array(ev.data));
      });
      await exchangeSyncStep1(ws, doc);

      const storages: string[] = [];
      let remoteVersion = 4;
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => ({
        id: confluenceId, title: 'Conf page', status: 'current', type: 'page',
        version: { number: remoteVersion, when: '2026-11-12T00:00:00Z' },
      }) as never);
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async (_id, title, written, version) => {
        storages.push(written);
        remoteVersion = version + 1;
        return {
          id: confluenceId, title, status: 'current', type: 'page',
          version: { number: remoteVersion, when: '2026-11-12T00:00:01Z' },
          body: { storage: { value: written } },
        } as never;
      });
      const save = (label: string) => app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: commitPayload(ws, label, Y.snapshot(doc)),
      });
      const room = () => yDocToHtml(getDefaultCollabRuntime()!.getRoom(pageId)!.doc);
      return { ws, storages, save, room };
    }

    /** Two Saves of the unchanged room: the first sends `expected`, the second the same bytes. */
    async function expectTwoSaves(editor: LinkBodyRoom, expected: string): Promise<void> {
      const first = await editor.save('Save 1');
      expect(first.statusCode, first.body).toBe(200);
      expect(editor.storages[0]).toBe(expected);
      const second = await editor.save('Save 2');
      expect(second.statusCode, second.body).toBe(200);
      expect(editor.storages[1]).toBe(editor.storages[0]);
      editor.ws.close();
    }

    it('writes every image-bodied link as one ac:link around its image, and the same bytes on a second Save', async () => {
      const storage = '<p>Intro</p>'
        + `<p><ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" /><ac:link-body>${image('page.png')}</ac:link-body></ac:link></p>`
        + FILLER
        + `<p><ac:link><ri:url ri:value="/docs/guide" /><ac:link-body>${image('relative.png')}</ac:link-body></ac:link></p>`
        + `<p>${'More unrelated prose between the two links. '.repeat(3)}</p>`
        + `<p><ac:link><ri:url ri:value="https://example.com/doc" /><ac:link-body>${image('web.png')}</ac:link-body></ac:link></p>`;
      const editor = await openRoom(storage);
      // The room holds each image on its node with its link: one wrapper per image, the carrier of the web link in `class`.
      expect(editor.room()).toContain('href="#confluence-page:Runbook?ri:space-key=OPS"><img src="/api/attachments/55/page.png"');
      expect(editor.room()).toContain('class="#confluence-url:https%3A%2F%2Fexample.com%2Fdoc?body=rich" href="https://example.com/doc"><img');

      await expectTwoSaves(editor,
        '<p>Intro</p><p></p>'
        + `<ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page><ac:link-body>${imageOut('page.png')}</ac:link-body></ac:link>`
        + `${FILLER_OUT}<p></p>`
        + `<ac:link><ri:url ri:value="/docs/guide"></ri:url><ac:link-body>${imageOut('relative.png')}</ac:link-body></ac:link>`
        + `<p>${'More unrelated prose between the two links. '.repeat(3).trimEnd()}</p><p></p>`
        + `<ac:link><ri:url ri:value="https://example.com/doc"></ri:url><ac:link-body>${imageOut('web.png')}</ac:link-body></ac:link>`);
    });

    it('writes a code-bodied and a mixed code-and-text link as one ac:link each, and the same bytes on a second Save', async () => {
      const code = '<ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" /><ac:link-body><code>deploy()</code></ac:link-body></ac:link>';
      const mixed = '<ac:link><ri:url ri:value="/docs/guide" /><ac:link-body>run <code>deploy()</code> now</ac:link-body></ac:link>';
      const editor = await openRoom(`<p>Call ${code} first.</p>${FILLER}<p>Then ${mixed}.</p>`);
      expect(editor.room()).toContain('<code>deploy()</code></a> first.</p>');

      await expectTwoSaves(editor,
        '<p>Call <ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page><ac:link-body><code>deploy()</code></ac:link-body></ac:link> first.</p>'
        + FILLER_OUT
        + '<p>Then <ac:link><ri:url ri:value="/docs/guide"></ri:url><ac:link-body>run <code>deploy()</code> now</ac:link-body></ac:link>.</p>');
    });

    it('writes a link around a line break as one ac:link, and the same bytes on a second Save', async () => {
      const link = '<ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" /><ac:link-body>line one<br />line two</ac:link-body></ac:link>';
      const editor = await openRoom(`<p>Go ${link} there.</p>`);
      // Yjs keeps the link on the two halves only; the room's HTML (yDocToHtml) is one link across the break again.
      expect(editor.room()).toContain('line one<br>line two</a> there.</p>');

      await expectTwoSaves(editor,
        '<p>Go <ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS"></ri:page>'
        + '<ac:link-body>line one<br />line two</ac:link-body></ac:link> there.</p>');
    });
  });

  describe('task ids after a collaborative Save (#1751)', () => {
    type TaskEditor = { ws: WebSocket; doc: Y.Doc; controls: string[] };

    /** Task 42 ("A") as Confluence stores it. */
    const STORAGE_42 = '<p>Tasks</p><ac:task-list><ac:task><ac:task-id>42</ac:task-id>'
      + '<ac:task-status>incomplete</ac:task-status><ac:task-body>A</ac:task-body></ac:task></ac:task-list>';
    const BODY_42 = '<p>Tasks</p><ul data-type="taskList">'
      + '<li data-type="taskItem" data-checked="false" data-task-id="42">A</li></ul>';
    /** Task 42 and a task "B" that is new: it has no id yet. */
    const BODY_42_AND_NEW = '<p>Tasks</p><ul data-type="taskList">'
      + '<li data-type="taskItem" data-checked="false" data-task-id="42">A</li>'
      + '<li data-type="taskItem" data-checked="false">B</li></ul>';

    async function seedTaskPage(bodyHtml: string, bodyStorage: string): Promise<{
      token: string;
      userId: string;
      pageId: number;
      confluenceId: string;
    }> {
      const { token, userId } = await createUser(`collab_task_${pageIdEntropy()}`);
      const spaceKey = `TK${pageIdEntropy().slice(0, 6).toUpperCase()}`;
      const confluenceId = `cf-${pageIdEntropy()}`;
      const pageId = await insertConfluencePage({ spaceKey, confluenceId, version: 4, bodyHtml });
      await query('UPDATE pages SET body_storage = $2 WHERE id = $1', [pageId, bodyStorage]);
      await grantSpaceRead(userId, spaceKey);
      await seedConfluenceCredentials(userId);
      await enableCollabFlag();
      return { token, userId, pageId, confluenceId };
    }

    /** A writable editor whose document follows the room. */
    async function joinTaskEditor(pageId: number, token: string): Promise<TaskEditor> {
      const ws = await openWritableWhatwg(pageId, token);
      const editor: TaskEditor = { ws, doc: new Y.Doc(), controls: [] };
      ws.addEventListener('message', (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const frame = new Uint8Array(ev.data);
        const control = decodeControl(frame);
        if (control) editor.controls.push(control.type);
        else applySyncFrame(editor.doc, frame);
      });
      await exchangeSyncStep1(ws, editor.doc);
      return editor;
    }

    function taskListOf(doc: Y.Doc): Y.XmlElement {
      return doc.getXmlFragment('default').toArray()
        .find((node): node is Y.XmlElement => node instanceof Y.XmlElement && node.nodeName === 'taskList')!;
    }

    /** Edit the editor's task list and send its state, as a typing client would. */
    function editTasks(editor: TaskEditor, change: (list: Y.XmlElement) => void): void {
      editor.doc.transact(() => change(taskListOf(editor.doc)));
      editor.ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(editor.doc)));
    }

    function newTask(text: string): Y.XmlElement {
      const item = new Y.XmlElement('taskItem');
      const paragraph = new Y.XmlElement('paragraph');
      const content = new Y.XmlText();
      content.insert(0, text);
      paragraph.insert(0, [content]);
      item.insert(0, [paragraph]);
      return item;
    }

    /** The text of the task at `index`, to type into. */
    function taskParagraphText(list: Y.XmlElement, index: number): Y.XmlText {
      return ((list.get(index) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    }

    function taskIdsOf(doc: Y.Doc): Array<string | null> {
      return [...doc.getXmlFragment('default').createTreeWalker(
        (type) => type instanceof Y.XmlElement && type.nodeName === 'taskItem',
      )].map((item) => {
        const id: unknown = (item as Y.XmlElement).getAttribute('taskId');
        return typeof id === 'string' ? id : null;
      });
    }

    function storageTaskIds(storage: string): string[] {
      return [...storage.matchAll(/<ac:task-id>([^<]*)<\/ac:task-id>/g)].map((match) => match[1]!);
    }

    /** Confluence for consecutive Saves: the remote version follows each accepted PUT. */
    function mockTaskProvider(confluenceId: string, onFirstRead?: () => Promise<void>) {
      let remoteVersion = 4;
      let reads = 0;
      const storages: string[] = [];
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
        reads += 1;
        if (reads === 1) await onFirstRead?.();
        return {
          id: confluenceId,
          title: 'Conf page',
          status: 'current',
          type: 'page',
          version: { number: remoteVersion, when: '2026-11-12T00:00:00Z' },
        } as never;
      });
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(
        async (_id, title, storage, version) => {
          storages.push(storage);
          remoteVersion = version + 1;
          return {
            id: confluenceId,
            title,
            status: 'current',
            type: 'page',
            version: { number: remoteVersion, when: '2026-11-12T00:00:01Z' },
            body: { storage: { value: storage } },
          } as never;
        },
      );
      return { storages };
    }

    function save(pageId: number, token: string, payload: CollabCommit) {
      return app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    }

    async function activePurposes(pageId: number): Promise<string[]> {
      const rows = await query<{ purpose: string }>(
        `SELECT purpose FROM page_runtime_admissions
          WHERE page_id = $1 AND released_at IS NULL ORDER BY purpose`,
        [pageId],
      );
      return rows.rows.map((row) => row.purpose);
    }

    it('keeps the id a Save gave a new task when the next Save adds a task above it and its text changed (#1751)', async () => {
      const { token, pageId, confluenceId } = await seedTaskPage(BODY_42, STORAGE_42);
      const editor = await joinTaskEditor(pageId, token);
      const provider = mockTaskProvider(confluenceId);
      const room = getDefaultCollabRuntime()!.getRoom(pageId)!;

      editTasks(editor, (list) => list.push([newTask('B')]));
      await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('<p>B</p>'));
      const first = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
      expect(first.statusCode, first.body).toBe(200);
      expect(storageTaskIds(provider.storages[0]!)).toEqual(['42', '43']);
      // The ids reach the editor before the Save's pages_version control.
      await vi.waitFor(() => expect(editor.controls).toContain('pages_version'));
      expect.soft(taskIdsOf(editor.doc)).toEqual(['42', '43']);

      editTasks(editor, (list) => {
        list.insert(0, [newTask('X')]);
        const b = taskParagraphText(list, 2);
        b.insert(b.length, ' (renamed)');
      });
      await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('B (renamed)'));
      const second = await save(pageId, token, commitPayload(editor.ws, 'Save 2', Y.snapshot(editor.doc)));
      expect(second.statusCode, second.body).toBe(200);
      expect(storageTaskIds(provider.storages[1]!)).toEqual(['44', '42', '43']);
      editor.ws.close();
    });

    /** Type into the page's opening paragraph, as a co-editor would; no task is touched. */
    function editIntro(editor: TaskEditor, suffix: string): void {
      editor.doc.transact(() => {
        const intro = editor.doc.getXmlFragment('default').get(0) as Y.XmlElement;
        const text = intro.get(0) as Y.XmlText;
        text.insert(text.length, suffix);
      });
      editor.ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(editor.doc)));
    }

    it('writes nested tasks with a subtask macro back once at their depth on a collaborative Save, and mints nothing on the next (#1957)', async () => {
      const { token, pageId, confluenceId } = await seedTaskPage(NESTED_TASK_LIST_HTML, NESTED_TASK_LIST_PAGE);
      const editor = await joinTaskEditor(pageId, token);
      const provider = mockTaskProvider(confluenceId);
      const room = getDefaultCollabRuntime()!.getRoom(pageId)!;

      editIntro(editor, ' (edited)');
      await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('Release checklist (edited)'));
      const first = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
      expect(first.statusCode, first.body).toBe(200);
      // The editor's copy of the page, written back: every id, status, body
      // and macro once, the toc and status macros inside task 12 at depth 2.
      const expected = htmlToConfluence(
        NESTED_TASK_LIST_EDITOR_HTML.replace('Release checklist', 'Release checklist (edited)'),
      );
      expect(provider.storages[0]).toBe(expected);
      expect(expected).toContain(
        '<ac:task><ac:task-id>12</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><p>Write notes '
        + '<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter>'
        + '<ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro></p>'
        + '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro></ac:task-body></ac:task>',
      );
      expect(storageTaskIds(provider.storages[0]!)).toEqual(['11', '12', '13', '14', '15']);
      await vi.waitFor(() => expect(editor.controls).toContain('pages_version'));

      editIntro(editor, '!');
      await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('(edited)!'));
      const second = await save(pageId, token, commitPayload(editor.ws, 'Save 2', Y.snapshot(editor.doc)));
      expect(second.statusCode, second.body).toBe(200);
      expect(storageTaskIds(provider.storages[1]!)).toEqual(['11', '12', '13', '14', '15']);
      editor.ws.close();
    });

    it(`writes tasks nested ${MAX_TASK_LIST_NESTING} levels deep back with every id at its depth on a collaborative Save (#1957)`, async () => {
      let storage = '';
      for (let level = MAX_TASK_LIST_NESTING; level >= 1; level -= 1) {
        storage = `<ac:task-list><ac:task><ac:task-id>${level}</ac:task-id><ac:task-status>incomplete</ac:task-status>`
          + `<ac:task-body>t${level}${storage}</ac:task-body></ac:task></ac:task-list>`;
      }
      storage = `<p>Tasks</p>${storage}`;
      const { token, pageId, confluenceId } = await seedTaskPage(confluenceToHtml(storage), storage);
      const editor = await joinTaskEditor(pageId, token);
      const provider = mockTaskProvider(confluenceId);
      const room = getDefaultCollabRuntime()!.getRoom(pageId)!;

      editIntro(editor, ' (edited)');
      await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('Tasks (edited)'));
      const saved = await save(pageId, token, commitPayload(editor.ws, 'Save', Y.snapshot(editor.doc)));
      expect(saved.statusCode, saved.body).toBe(200);
      const written = provider.storages[0]!;
      expect(storageTaskIds(written)).toEqual(Array.from({ length: MAX_TASK_LIST_NESTING }, (_, index) => String(index + 1)));
      // Each task's list closes after the deeper ones: exactly one list per level, all nested.
      expect(written).toContain(`${'</ac:task-body></ac:task></ac:task-list>'.repeat(MAX_TASK_LIST_NESTING)}`);
      expect(written.match(/<ac:task-list>/g)).toHaveLength(MAX_TASK_LIST_NESTING);
      editor.ws.close();
    });

    // Review r2 B2: a collaborative Save assigns ids before it serializes; both
    // must take the pre-#1957 profile for a 33-level page. The oracle is the
    // empty feature set (the base-bytes contract of storage-derivation.corpus).
    it('saves the restore corpus page with a 33-level chain with the task ids of before #1957 (#1957)', async () => {
      const entry = STORAGE_DERIVATION_BASE_CORPUS.find((candidate) => candidate.name === 'tasks-list-before-own-body')!;
      let chain = '';
      for (let level = MAX_TASK_LIST_NESTING + 1; level >= 1; level -= 1) {
        chain = `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="${100 + level}">`
          + `<p>t${level}</p>${chain}</li></ul>`;
      }
      const { token, pageId, confluenceId } = await seedTaskPage(`<p>Tasks</p>${entry.targetHtml}${chain}`, entry.previousStorage!);
      const editor = await joinTaskEditor(pageId, token);
      const provider = mockTaskProvider(confluenceId);
      const room = getDefaultCollabRuntime()!.getRoom(pageId)!;

      editIntro(editor, ' (edited)');
      await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('Tasks (edited)'));
      const roomHtml = yDocToHtml(room.doc);
      const saved = await save(pageId, token, commitPayload(editor.ws, 'Save', Y.snapshot(editor.doc)));
      expect(saved.statusCode, saved.body).toBe(200);
      const written = provider.storages[0]!;
      expect(storageTaskIds(written))
        .toEqual(['1', '134', ...Array.from({ length: MAX_TASK_LIST_NESTING + 1 }, (_, index) => String(101 + index))]);
      const base = assignTaskIds(roomHtml, {
        previousStorage: entry.previousStorage,
        legacyTasks: false,
        derivationFeatures: NO_STORAGE_DERIVATION_FEATURES,
      });
      expect(written).toBe(htmlToConfluence(base.html, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }));
      await vi.waitFor(() => expect(editor.controls).toContain('pages_version'));
      expect.soft(taskIdsOf(editor.doc).slice(0, 2)).toEqual(['1', '134']);
      editor.ws.close();
    });

    it(`saves a collaboration that nests tasks one level deeper than ${MAX_TASK_LIST_NESTING} as before #1957 (#1957)`, async () => {
      let storage = '';
      for (let level = MAX_TASK_LIST_NESTING; level >= 1; level -= 1) {
        storage = `<ac:task-list><ac:task><ac:task-id>${level}</ac:task-id><ac:task-status>incomplete</ac:task-status>`
          + `<ac:task-body>t${level}${storage}</ac:task-body></ac:task></ac:task-list>`;
      }
      storage = `<p>Tasks</p>${storage}`;
      const { token, pageId, confluenceId } = await seedTaskPage(confluenceToHtml(storage), storage);
      const editor = await joinTaskEditor(pageId, token);
      const provider = mockTaskProvider(confluenceId);
      const room = getDefaultCollabRuntime()!.getRoom(pageId)!;

      // Tab once more on the deepest task: a subtask list in its content.
      editor.doc.transact(() => {
        const deepest = [...editor.doc.getXmlFragment('default').createTreeWalker(
          (type) => type instanceof Y.XmlElement && type.nodeName === 'taskItem',
        )].at(-1) as Y.XmlElement;
        const list = new Y.XmlElement('taskList');
        list.insert(0, [newTask('deeper')]);
        deepest.push([list]);
      });
      editor.ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(editor.doc)));
      await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('<p>deeper</p>'));
      const saved = await save(pageId, token, commitPayload(editor.ws, 'Save', Y.snapshot(editor.doc)));
      expect(saved.statusCode, saved.body).toBe(200);
      const written = provider.storages[0]!;
      expect(storageTaskIds(written)).toEqual(Array.from({ length: MAX_TASK_LIST_NESTING + 1 }, (_, index) => String(index + 1)));
      expect(written.match(/<ac:task-list>/g)).toHaveLength(MAX_TASK_LIST_NESTING + 1);
      expect(written).toContain('<ac:task-body><p>deeper</p></ac:task-body>');
      await vi.waitFor(() => expect(editor.controls).toContain('pages_version'));
      expect(await activePurposes(pageId)).not.toContain('collab.commit.confluence');
      editor.ws.close();
    });

    it('stores the ids in the room of the peer pod that owns it when the Save runs on a pod without the room (#1751)', async () => {
      const { token, userId, pageId, confluenceId } = await seedTaskPage(BODY_42_AND_NEW, STORAGE_42);
      const revision = await pageLifecycleRevision(pageId);
      const podA = await createCollabRuntime(getRedisClient()!, 'task-ids-pod-a');
      try {
        await podA.attachSocket(pageId, {
          id: 'pod-a-writer',
          ws: { readyState: 1, send() {}, close() {} } as unknown as NodeWs,
          userId,
          writable: true,
          expectedLifecycleRevision: revision,
        });
        const roomA = podA.getRoom(pageId)!;
        const provider = mockTaskProvider(confluenceId);
        const payload = (title: string): CollabCommit => ({
          title,
          expectedLifecycleRevision: revision,
          expectedDocumentState: EMPTY_DOCUMENT_STATE,
        });

        const first = await save(pageId, token, payload('Save 1'));
        expect(first.statusCode, first.body).toBe(200);
        expect(getDefaultCollabRuntime()!.getRoom(pageId)).toBeUndefined();
        expect(storageTaskIds(provider.storages[0]!)).toEqual(['42', '43']);
        // In pod A's memory: the Redis request, not a merge of the persisted document.
        await vi.waitFor(() => expect(taskIdsOf(roomA.doc)).toEqual(['42', '43']), { timeout: 5_000 });

        roomA.doc.transact(() => taskListOf(roomA.doc).insert(0, [newTask('X')]));
        const second = await save(pageId, token, payload('Save 2'));
        expect(second.statusCode, second.body).toBe(200);
        expect(storageTaskIds(provider.storages[1]!)).toEqual(['44', '42', '43']);
      } finally {
        await podA.close();
      }
    });

    it('stores the ids in the persisted document when the only writer left before the Save settled (#1751)', async () => {
      const { token, pageId, confluenceId } = await seedTaskPage(BODY_42_AND_NEW, STORAGE_42);
      const leaving = await joinTaskEditor(pageId, token);
      await persist.flushCollabPersist(getDefaultCollabRuntime()!.getRoom(pageId)!);
      const provider = mockTaskProvider(confluenceId, async () => {
        leaving.ws.close();
        await vi.waitFor(async () => {
          expect(await activePurposes(pageId)).not.toContain('collab_room');
        }, { timeout: 5_000 });
      });

      const first = await save(pageId, token, commitPayload(leaving.ws, 'Save 1', Y.snapshot(leaving.doc)));
      expect(first.statusCode, first.body).toBe(200);
      expect(storageTaskIds(provider.storages[0]!)).toEqual(['42', '43']);
      expect.soft(await persist.htmlFromPersistedDoc(pageId)).toContain('data-task-id="43"');

      const rejoined = await joinTaskEditor(pageId, token);
      const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
      expect.soft(taskIdsOf(room.doc)).toEqual(['42', '43']);
      editTasks(rejoined, (list) => list.insert(0, [newTask('X')]));
      await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('<p>X</p>'));
      const second = await save(pageId, token, commitPayload(rejoined.ws, 'Save 2', Y.snapshot(rejoined.doc)));
      expect(second.statusCode, second.body).toBe(200);
      expect(storageTaskIds(provider.storages[1]!)).toEqual(['44', '42', '43']);
      rejoined.ws.close();
    });

    it('gives a page synced before ids were carried its Confluence ids on the first Save, and the room keeps them (#1751)', async () => {
      const storage = '<p>Tasks</p><ac:task-list>'
        + '<ac:task><ac:task-id>794464</ac:task-id><ac:task-status>complete</ac:task-status>'
        + '<ac:task-body>Ship it</ac:task-body></ac:task>'
        + '<ac:task><ac:task-id>12</ac:task-id><ac:task-status>incomplete</ac:task-status>'
        + '<ac:task-body>Write docs</ac:task-body></ac:task></ac:task-list>';
      const { token, pageId, confluenceId } = await seedTaskPage(
        '<p>Tasks</p><ul data-type="taskList">'
        + '<li data-type="taskItem" data-checked="true">Ship it</li>'
        + '<li data-type="taskItem" data-checked="false">Write docs</li></ul>',
        storage,
      );
      const editor = await joinTaskEditor(pageId, token);
      const provider = mockTaskProvider(confluenceId);
      const room = getDefaultCollabRuntime()!.getRoom(pageId)!;

      const first = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
      expect(first.statusCode, first.body).toBe(200);
      expect(storageTaskIds(provider.storages[0]!)).toEqual(['794464', '12']);
      await vi.waitFor(() => expect(editor.controls).toContain('pages_version'));
      expect.soft(taskIdsOf(editor.doc)).toEqual(['794464', '12']);

      editTasks(editor, (list) => {
        list.insert(0, [newTask('New first')]);
        const ship = taskParagraphText(list, 1);
        ship.insert(ship.length, ' today');
      });
      await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('Ship it today'));
      const second = await save(pageId, token, commitPayload(editor.ws, 'Save 2', Y.snapshot(editor.doc)));
      expect(second.statusCode, second.body).toBe(200);
      expect(storageTaskIds(provider.storages[1]!)).toEqual(['794465', '794464', '12']);
      editor.ws.close();
    });

    describe('the order pairing of a page synced before ids were carried', () => {
      /** Whether the room's document records that its tasks carry Confluence task ids. */
      function carriesTaskIds(doc: Y.Doc): boolean {
        return doc.getMap('compendiq.meta').get('confluenceTaskIds') === true;
      }

      /** Delete every task of the list and type `text` as its only task. */
      function replaceAllTasks(list: Y.XmlElement, text: string): void {
        list.delete(0, list.length);
        list.insert(0, [newTask(text)]);
      }

      const LEGACY_STORAGE = '<p>Tasks</p><ac:task-list>'
        + '<ac:task><ac:task-id>794464</ac:task-id><ac:task-status>complete</ac:task-status>'
        + '<ac:task-body>Ship it</ac:task-body></ac:task>'
        + '<ac:task><ac:task-id>12</ac:task-id><ac:task-status>incomplete</ac:task-status>'
        + '<ac:task-body>Write docs</ac:task-body></ac:task></ac:task-list>';
      const LEGACY_BODY = '<p>Tasks</p><ul data-type="taskList">'
        + '<li data-type="taskItem" data-checked="true">Ship it</li>'
        + '<li data-type="taskItem" data-checked="false">Write docs</li></ul>';

      it('gives the tasks a session put in place of every task of a page that carries ids new ids (#1751)', async () => {
        const { token, pageId, confluenceId } = await seedTaskPage(BODY_42, STORAGE_42);
        const editor = await joinTaskEditor(pageId, token);
        const provider = mockTaskProvider(confluenceId);
        const room = getDefaultCollabRuntime()!.getRoom(pageId)!;

        editTasks(editor, (list) => replaceAllTasks(list, 'C'));
        await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('<p>C</p>'));
        // The room's persist leaves no task id in body_html: that column cannot tell this page from a legacy one.
        await persist.flushCollabPersist(room);
        const stored = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId]);
        expect(stored.rows[0]!.body_html).not.toContain('data-task-id');
        const first = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
        expect(first.statusCode, first.body).toBe(200);
        expect(storageTaskIds(provider.storages[0]!)).toEqual(['43']);
        expect(carriesTaskIds(room.doc)).toBe(true);
        editor.ws.close();
      });

      it('records carried ids after a Save in which every task already carried its id, so a task typed in place of a deleted one gets a new id (#1751)', async () => {
        // A page with no task yet; tasks pasted from another page keep that page's ids (TipTap parses data-task-id).
        const { token, pageId, confluenceId } = await seedTaskPage('<p>Tasks</p>', '<p>Tasks</p>');
        const editor = await joinTaskEditor(pageId, token);
        const provider = mockTaskProvider(confluenceId);
        const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
        editor.doc.transact(() => {
          const list = new Y.XmlElement('taskList');
          const x = newTask('X');
          x.setAttribute('taskId', '5');
          const y = newTask('Y');
          y.setAttribute('taskId', '6');
          list.insert(0, [x, y]);
          editor.doc.getXmlFragment('default').push([list]);
        });
        editor.ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(editor.doc)));
        await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('<p>Y</p>'));
        const first = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
        expect(first.statusCode, first.body).toBe(200);
        expect(storageTaskIds(provider.storages[0]!)).toEqual(['5', '6']);
        await vi.waitFor(() => expect(editor.controls).toContain('pages_version'));
        expect(carriesTaskIds(room.doc)).toBe(true);

        // Delete Y and type a new task Z: Z is new and must not take Y's id.
        editTasks(editor, (list) => {
          list.delete(1, 1);
          list.push([newTask('Z')]);
        });
        await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('<p>Z</p>'));
        const second = await save(pageId, token, commitPayload(editor.ws, 'Save 2', Y.snapshot(editor.doc)));
        expect(second.statusCode, second.body).toBe(200);
        expect(storageTaskIds(provider.storages[1]!)).toEqual(['5', '7']);
        editor.ws.close();
      });

      it('pairs the edited tasks of a page synced before ids were carried in order on its first collaborative Save (#1751)', async () => {
        const { token, pageId, confluenceId } = await seedTaskPage(LEGACY_BODY, LEGACY_STORAGE);
        const editor = await joinTaskEditor(pageId, token);
        const provider = mockTaskProvider(confluenceId);
        const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
        expect(carriesTaskIds(room.doc)).toBe(false);

        editTasks(editor, (list) => {
          const ship = taskParagraphText(list, 0);
          ship.insert(ship.length, ' today');
        });
        await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('Ship it today'));
        const first = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
        expect(first.statusCode, first.body).toBe(200);
        expect(storageTaskIds(provider.storages[0]!)).toEqual(['794464', '12']);
        await vi.waitFor(() => expect(editor.controls).toContain('pages_version'));
        expect(taskIdsOf(room.doc)).toEqual(['794464', '12']);
        // The marks recorded it: the page is no longer legacy.
        expect(carriesTaskIds(room.doc)).toBe(true);
        editor.ws.close();
      });

      it('keeps the room\'s carried-ids record through a persistence reload (#1751)', async () => {
        const { token, pageId, confluenceId } = await seedTaskPage(BODY_42, STORAGE_42);
        const runtime = getDefaultCollabRuntime()!;
        const first = await joinTaskEditor(pageId, token);
        const firstRoom = runtime.getRoom(pageId)!;
        await persist.flushCollabPersist(firstRoom);
        first.ws.close();
        await vi.waitFor(() => expect(firstRoom.sockets.size).toBe(0), { timeout: 5_000 });
        await runtime.dropRoom(pageId);
        expect(runtime.getRoom(pageId)).toBeUndefined();
        const persisted = await query<{ doc_state: Buffer }>(
          'SELECT doc_state FROM page_collaborative_docs WHERE page_id = $1',
          [pageId],
        );
        const reloaded = new Y.Doc();
        Y.applyUpdate(reloaded, new Uint8Array(persisted.rows[0]!.doc_state));
        expect(carriesTaskIds(reloaded)).toBe(true);

        // A new room loads the persisted document, not body_html.
        const editor = await joinTaskEditor(pageId, token);
        const room = runtime.getRoom(pageId)!;
        expect(room).not.toBe(firstRoom);
        const provider = mockTaskProvider(confluenceId);
        editTasks(editor, (list) => replaceAllTasks(list, 'C'));
        await vi.waitFor(() => expect(yDocToHtml(room.doc)).toContain('<p>C</p>'));
        const save1 = await save(pageId, token, commitPayload(editor.ws, 'Save 1', Y.snapshot(editor.doc)));
        expect(save1.statusCode, save1.body).toBe(200);
        expect(storageTaskIds(provider.storages[0]!)).toEqual(['43']);
        editor.ws.close();
      });

      it('records carried ids in the room of the peer pod that owns it, so a replace-all there gets new ids (#1751)', async () => {
        const { token, userId, pageId, confluenceId } = await seedTaskPage(
          '<p>Tasks</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false">A</li></ul>',
          STORAGE_42,
        );
        const revision = await pageLifecycleRevision(pageId);
        const podA = await createCollabRuntime(getRedisClient()!, 'task-flag-pod-a');
        try {
          await podA.attachSocket(pageId, {
            id: 'pod-a-writer',
            ws: { readyState: 1, send() {}, close() {} } as unknown as NodeWs,
            userId,
            writable: true,
            expectedLifecycleRevision: revision,
          });
          const roomA = podA.getRoom(pageId)!;
          expect(carriesTaskIds(roomA.doc)).toBe(false);
          const provider = mockTaskProvider(confluenceId);
          const payload = (title: string): CollabCommit => ({
            title,
            expectedLifecycleRevision: revision,
            expectedDocumentState: EMPTY_DOCUMENT_STATE,
          });

          const first = await save(pageId, token, payload('Save 1'));
          expect(first.statusCode, first.body).toBe(200);
          expect(getDefaultCollabRuntime()!.getRoom(pageId)).toBeUndefined();
          expect(storageTaskIds(provider.storages[0]!)).toEqual(['42']);
          // In pod A's memory, through the task_ids request over Redis.
          await vi.waitFor(() => expect(carriesTaskIds(roomA.doc)).toBe(true), { timeout: 5_000 });

          roomA.doc.transact(() => replaceAllTasks(taskListOf(roomA.doc), 'C'));
          const second = await save(pageId, token, payload('Save 2'));
          expect(second.statusCode, second.body).toBe(200);
          expect(storageTaskIds(provider.storages[1]!)).toEqual(['43']);
        } finally {
          await podA.close();
        }
      });
    });
  });

  it('refuses final local publication when authority is revoked after the page PUT', async () => {
    const {
      token, userId, pageId, confluenceId, spaceKey, ws,
    } = await seedLiveConfluencePage({ version: 4 });
    vi.spyOn(ConfluenceClient.prototype, 'getPage').mockResolvedValue({
      id: confluenceId,
      title: 'Conf page',
      status: 'current',
      type: 'page',
      version: { number: 4, when: '2026-09-20T00:00:00Z' },
    } as never);
    const updatePage = vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(
      async (_id, title, storage) => {
        await query(
          `DELETE FROM space_role_assignments
            WHERE space_key = $1 AND principal_type = 'user' AND principal_id = $2`,
          [spaceKey, userId],
        );
        return {
          id: confluenceId,
          title,
          status: 'current',
          type: 'page',
          version: { number: 5, when: '2026-09-20T00:00:01Z' },
          body: { storage: { value: storage } },
        } as never;
      },
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: commitPayload(ws, 'Remote accepted before revocation'),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().reason).toBe('intent_actor_authority_unavailable');
      expect(updatePage).toHaveBeenCalledTimes(1);
      const local = await query<{ version: number; title: string }>(
        'SELECT version, title FROM pages WHERE id = $1',
        [pageId],
      );
      expect(local.rows[0]).toMatchObject({ version: 4, title: 'Conf page' });
    } finally {
      ws.close();
    }
  });

  it('updatePage 409 re-GETs the real remote version', async () => {
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({ version: 4 });
    let gets = 0;
    vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
      gets += 1;
      return {
        id: confluenceId,
        title: 'Conf page',
        status: 'current',
        type: 'page',
        version: { number: gets === 1 ? 4 : 9, when: '2026-08-24T00:00:00Z' },
      } as never;
    });
    vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockRejectedValue(
      new ConfluenceError('Version conflict', 409),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: commitPayload(ws, 'Should not land'),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'confluence_modified',
      remoteVersion: 9,
      localVersion: 4,
    });
    expect(gets).toBe(2);
    ws.close();
  });

  it('Confluence 5xx after dispatch → local version unchanged, the room fails closed (#2035)', async () => {
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({ version: 4 });
    const closed = waitClose(ws);
    vi.spyOn(ConfluenceClient.prototype, 'getPage').mockResolvedValue({
      id: confluenceId,
      title: 'Conf page',
      status: 'current',
      type: 'page',
      version: { number: 4, when: '2026-08-24T00:00:00Z' },
    } as never);
    vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockRejectedValue(
      new ConfluenceError('Confluence unavailable', 503),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: commitPayload(ws, 'No write'),
    });

    expect(res.statusCode).toBe(503);
    const page = await query<{ version: number; title: string }>(
      'SELECT version, title FROM pages WHERE id = $1',
      [pageId],
    );
    expect(page.rows[0]!.version).toBe(4);
    expect(page.rows[0]!.title).toBe('Conf page');
    // The Save's outcome is unknown: its writer is closed, the room keeps its admission.
    expect(await closed).toMatchObject({ code: 1001, reason: 'commit_unknown' });
    expect(await getRedisClient()!.sMembers(`collab:active:${pageId}`))
      .toEqual([expect.stringMatching(/:room$/)]);
  });

  // #1623 — exercises the REAL `isConfluenceEnabled` against Postgres: the
  // user keeps working, credentials stay on file, and nothing is pushed.
  it('integration off → commit writes the local row, no Confluence call, credentials kept', async () => {
    const { token, userId, pageId, ws } = await seedLiveConfluencePage({ version: 4 });
    await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [userId]);
    const getPage = vi.spyOn(ConfluenceClient.prototype, 'getPage').mockRejectedValue(
      new Error('getPage must not run while the integration is off'),
    );
    const updatePage = vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockRejectedValue(
      new Error('updatePage must not run while the integration is off'),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: commitPayload(ws, 'Saved offline'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: pageId,
      title: 'Saved offline',
      version: 5,
      source: 'confluence',
      pushedToConfluence: false,
    });
    expect(getPage).not.toHaveBeenCalled();
    expect(updatePage).not.toHaveBeenCalled();

    const page = await query<{
      version: number;
      title: string;
      local_modified_at: Date | null;
      local_modified_by: string | null;
    }>(
      'SELECT version, title, local_modified_at, local_modified_by FROM pages WHERE id = $1',
      [pageId],
    );
    expect(page.rows[0]!.version).toBe(5);
    expect(page.rows[0]!.title).toBe('Saved offline');
    // The local-edit marker (#305) is what the next sync's existing conflict
    // handling reads once the integration comes back on.
    expect(page.rows[0]!.local_modified_at).not.toBeNull();
    expect(page.rows[0]!.local_modified_by).toBe(userId);

    // A toggle never clears credentials — re-enabling must not ask for the PAT.
    const creds = await query<{ confluence_url: string | null; confluence_pat: string | null }>(
      'SELECT confluence_url, confluence_pat FROM user_settings WHERE user_id = $1',
      [userId],
    );
    expect(creds.rows[0]!.confluence_url).toBe('https://confluence.example.com');
    expect(creds.rows[0]!.confluence_pat).toBeTruthy();
    ws.close();
  });

  it('integration on but credentials cleared → still the credential error', async () => {
    // The regression guard: `Confluence not configured` is a credential prompt
    // and stays reachable ONLY for an enabled user.
    const { token, userId, pageId, ws } = await seedLiveConfluencePage({ version: 4 });
    await query(
      'UPDATE user_settings SET confluence_url = NULL, confluence_pat = NULL WHERE user_id = $1',
      [userId],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: commitPayload(ws, 'No credentials'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Confluence not configured');
    const page = await query<{ version: number }>('SELECT version FROM pages WHERE id = $1', [pageId]);
    expect(page.rows[0]!.version).toBe(4);
    ws.close();
  });

  describe('collaborative Save window (#1763)', () => {
    type SaveWindowClient = {
      ws: WebSocket;
      doc: Y.Doc;
      closeInfo: { code: number; reason: string } | null;
      closed: Promise<{ code: number; reason: string }>;
      /** True once the client's document shows the text, false after 8 s; never rejects. */
      sees: (text: string) => Promise<boolean>;
    };

    async function seedSaveWindowPage(): Promise<{
      saver: { token: string; userId: string };
      coEditor: { token: string; userId: string };
      pageId: number;
      confluenceId: string;
    }> {
      const saver = await createUser(`collab_sw_saver_${pageIdEntropy()}`);
      const coEditor = await createUser(`collab_sw_peer_${pageIdEntropy()}`);
      const spaceKey = `SW${pageIdEntropy().slice(0, 6).toUpperCase()}`;
      const confluenceId = `cf-sw-${pageIdEntropy()}`;
      const pageId = await insertConfluencePage({
        spaceKey,
        confluenceId,
        version: 4,
        bodyHtml: '<p>save-window-seed</p>',
      });
      await grantSpaceRead(saver.userId, spaceKey);
      await grantSpaceRead(coEditor.userId, spaceKey);
      await seedConfluenceCredentials(saver.userId);
      await enableCollabFlag();
      return { saver, coEditor, pageId, confluenceId };
    }

    async function joinSaveWindowClient(pageId: number, token: string): Promise<SaveWindowClient> {
      const ws = await openWritableWhatwg(pageId, token);
      const doc = new Y.Doc();
      const waiters = new Set<() => void>();
      const closed = Promise.withResolvers<{ code: number; reason: string }>();
      const client: SaveWindowClient = {
        ws,
        doc,
        closeInfo: null,
        closed: closed.promise,
        sees: (text) => {
          const { promise, resolve } = Promise.withResolvers<boolean>();
          const timer = setTimeout(() => {
            waiters.delete(check);
            resolve(false);
          }, 8_000);
          function check(): void {
            if (!yDocToHtml(doc).includes(text)) return;
            waiters.delete(check);
            clearTimeout(timer);
            resolve(true);
          }
          waiters.add(check);
          check();
          return promise;
        },
      };
      ws.addEventListener('message', (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const frame = new Uint8Array(event.data);
        if (frame[0] !== MESSAGE_SYNC) return;
        applySyncFrame(doc, frame);
        for (const waiter of [...waiters]) waiter();
      });
      ws.addEventListener('close', (event) => {
        client.closeInfo = { code: event.code, reason: String(event.reason ?? '') };
        closed.resolve(client.closeInfo);
      });
      // The message listener above applies the SyncStep2 reply to `doc`.
      await exchangeSyncStep1(ws, doc);
      return client;
    }

    function typeInSaveWindow(client: SaveWindowClient, text: string): void {
      const before = Y.encodeStateVector(client.doc);
      client.doc.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        const content = new Y.XmlText();
        content.insert(0, text);
        paragraph.insert(0, [content]);
        client.doc.getXmlFragment('default').push([paragraph]);
      });
      client.ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(client.doc, before)));
    }

    /** The provider PUT waits for `release`; `started` resolves once the intent's remote phase began. */
    function gateConfluencePut(confluenceId: string, localVersion: number): {
      started: Promise<void>;
      release: () => void;
    } {
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      vi.spyOn(ConfluenceClient.prototype, 'getPage').mockResolvedValue({
        id: confluenceId,
        title: 'Conf page',
        status: 'current',
        type: 'page',
        version: { number: localVersion, when: '2026-11-10T00:00:00Z' },
      } as never);
      vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async (_id, title, storage) => {
        started.resolve();
        await gate.promise;
        return {
          id: confluenceId,
          title,
          status: 'current',
          type: 'page',
          version: { number: localVersion + 1, when: '2026-11-10T00:01:00Z' },
          body: { storage: { value: storage } },
        } as never;
      });
      return { started: started.promise, release: () => gate.resolve() };
    }

    function startSave(pageId: number, token: string, payload: CollabCommit) {
      return app.inject({
        method: 'POST',
        url: `/api/pages/${pageId}/collab/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    }

    async function activePurposes(pageId: number): Promise<string[]> {
      const admissions = await query<{ purpose: string }>(
        `SELECT purpose FROM page_runtime_admissions
          WHERE page_id = $1 AND released_at IS NULL
          ORDER BY purpose`,
        [pageId],
      );
      return admissions.rows.map((row) => row.purpose);
    }

    async function storedBodyHtml(pageId: number): Promise<string> {
      const page = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId]);
      return page.rows[0]!.body_html;
    }

    /**
     * Real timer on purpose: the empty-room grace must also run out while the
     * Save is pending, as a 12 s provider PUT outlasts the 10 s production
     * grace; a grace drop that runs after settlement releases by itself and
     * would hide the defect. The second step waits for that grace drop on the
     * room's ownership chain; while the Save is pending it changes nothing.
     */
    async function waitForGraceDrop(runtime: CollabRuntime, pageId: number): Promise<void> {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, COLLAB_EMPTY_ROOM_GRACE_MS + 250);
      await promise;
      await runtime.dropRoom(pageId).catch(() => undefined);
    }

    it('typing during a pending Save keeps every writer connected and live (#1763)', async () => {
      const { saver, coEditor, pageId, confluenceId } = await seedSaveWindowPage();
      const a = await joinSaveWindowClient(pageId, saver.token);
      const b = await joinSaveWindowClient(pageId, coEditor.token);
      const put = gateConfluencePut(confluenceId, 4);
      const save = startSave(pageId, saver.token, commitPayload(a.ws, 'Saved', Y.snapshot(a.doc)));
      try {
        await put.started;
        typeInSaveWindow(b, 'CO_EDITOR_DURING_SAVE');
        const coEditorSeen = await Promise.race([b.closed.then(() => false), a.sees('CO_EDITOR_DURING_SAVE')]);
        expect(b.closeInfo).toBeNull();
        expect(coEditorSeen).toBe(true);
        typeInSaveWindow(a, 'SAVER_DURING_OWN_SAVE');
        const saverSeen = await Promise.race([a.closed.then(() => false), b.sees('SAVER_DURING_OWN_SAVE')]);
        expect(a.closeInfo).toBeNull();
        expect(saverSeen).toBe(true);

        put.release();
        const saved = await save;
        expect(saved.statusCode, saved.body).toBe(200);
        expect(a.closeInfo).toBeNull();
        expect(b.closeInfo).toBeNull();
        await vi.waitFor(async () => {
          const body = await storedBodyHtml(pageId);
          expect(body).toContain('CO_EDITOR_DURING_SAVE');
          expect(body).toContain('SAVER_DURING_OWN_SAVE');
        }, { timeout: 5_000 });
      } finally {
        put.release();
        await save;
        a.ws.close();
        b.ws.close();
      }
    });

    it('the room persist waits for its own pending Save, and the commit\'s cue then writes it (#1763)', async () => {
      const { saver, pageId, confluenceId } = await seedSaveWindowPage();
      const a = await joinSaveWindowClient(pageId, saver.token);
      const contentRevision = async (): Promise<string> => (await query<{ revision: string }>(
        'SELECT content_revision::text AS revision FROM pages WHERE id = $1',
        [pageId],
      )).rows[0]!.revision;
      const put = gateConfluencePut(confluenceId, 4);
      const save = startSave(pageId, saver.token, commitPayload(a.ws, 'Saved', Y.snapshot(a.doc)));
      try {
        await put.started;
        const before = await contentRevision();
        const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
        await expect(persist.flushCollabPersist(room)).rejects.toMatchObject({
          statusCode: 409,
          reason: 'collab_commit_pending',
        });
        expect(await contentRevision()).toBe(before);
        typeInSaveWindow(a, 'TYPED_DURING_SAVE');
        await vi.waitFor(() => {
          expect(yDocToHtml(getDefaultCollabRuntime()!.getRoom(pageId)!.doc)).toContain('TYPED_DURING_SAVE');
        });
        expect(await contentRevision()).toBe(before);
        // Let this edit's own debounced persist run inside the window too. It
        // waits and nothing re-arms it, so once the Save settles only the
        // commit's `pages_version` cue can write it: no later edit, no leave.
        const forced = room.persistError;
        await vi.waitFor(() => {
          expect(room.persistTimer).toBeNull();
          expect(room.persistError).not.toBe(forced);
          expect(isCollabCommitPending(room.persistError)).toBe(true);
        }, { timeout: persist.COLLAB_PERSIST_DEBOUNCE_MS + 3_000 });
        expect(await contentRevision()).toBe(before);

        put.release();
        const saved = await save;
        expect(saved.statusCode, saved.body).toBe(200);
        const intents = await query<{ kind: string; status: string }>(
          'SELECT kind, status FROM page_write_intents WHERE page_ids = ARRAY[$1]::integer[]',
          [pageId],
        );
        expect(intents.rows).toEqual([{ kind: 'collab.commit.confluence', status: 'completed' }]);
        await vi.waitFor(async () => {
          expect(await storedBodyHtml(pageId)).toContain('TYPED_DURING_SAVE');
        }, { timeout: 5_000 });
      } finally {
        put.release();
        await save;
        a.ws.close();
      }
    });

    it('a writable rejoin during a pending Save is admitted (#1763)', async () => {
      const { saver, coEditor, pageId, confluenceId } = await seedSaveWindowPage();
      const a = await joinSaveWindowClient(pageId, saver.token);
      const b = await joinSaveWindowClient(pageId, coEditor.token);
      const put = gateConfluencePut(confluenceId, 4);
      const save = startSave(pageId, saver.token, commitPayload(a.ws, 'Saved', Y.snapshot(a.doc)));
      let rejoin: WebSocket | undefined;
      try {
        await put.started;
        b.ws.close();
        await b.closed;
        const revision = await pageLifecycleRevision(pageId);
        rejoin = openWhatwg(pageId, coEditor.token, `?expectedLifecycleRevision=${encodeURIComponent(revision)}`);
        const outcome = await Promise.race([
          waitControl(rejoin, (control) => control.type === 'writable_admission').catch(() => null),
          waitClose(rejoin).catch(() => null),
        ]);
        expect(outcome).toMatchObject({ type: 'writable_admission', lifecycleRevision: revision });
        await exchangeSyncStep1(rejoin, new Y.Doc());

        put.release();
        const saved = await save;
        expect(saved.statusCode, saved.body).toBe(200);
      } finally {
        put.release();
        await save;
        rejoin?.close();
        a.ws.close();
      }
    });

    it('the last writer leaving during a pending Save is released once the Save settles (#1763)', async () => {
      const { saver, pageId, confluenceId } = await seedSaveWindowPage();
      const a = await joinSaveWindowClient(pageId, saver.token);
      const put = gateConfluencePut(confluenceId, 4);
      const save = startSave(pageId, saver.token, commitPayload(a.ws, 'Saved', Y.snapshot(a.doc)));
      try {
        await put.started;
        a.ws.close();
        await a.closed;
        await waitForGraceDrop(getDefaultCollabRuntime()!, pageId);
        // Fail closed while the Save is pending: the room's flush could not run.
        expect(await activePurposes(pageId)).toContain('collab_room');

        put.release();
        const saved = await save;
        expect(saved.statusCode, saved.body).toBe(200);
        await vi.waitFor(async () => {
          expect(await activePurposes(pageId)).toEqual([]);
        }, { timeout: 5_000 });
        await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
        // The heap drop follows the admission release on the room's ownership
        // chain, after more awaited I/O: wait for it rather than racing it (#2044).
        await vi.waitFor(() => {
          expect(getDefaultCollabRuntime()?.getRoom(pageId)).toBeUndefined();
        }, { timeout: 5_000 });
      } finally {
        put.release();
        await save;
      }
    });

    it('a peer pod\'s last writer leaving during a Save is released by the commit\'s cue (#1763)', async () => {
      const previousRetry = process.env.COLLAB_DEFERRED_RELEASE_RETRY_MS;
      // A 60 s backoff leaves only the commit's `pages_version` cue, delivered
      // over Redis, to release pod A inside the wait below.
      process.env.COLLAB_DEFERRED_RELEASE_RETRY_MS = '60000';
      const { saver, pageId, confluenceId } = await seedSaveWindowPage();
      const podA = await createCollabRuntime(getRedisClient()!, 'save-window-pod-a');
      try {
        const revision = await pageLifecycleRevision(pageId);
        await podA.attachSocket(pageId, {
          id: 'pod-a-writer',
          ws: { readyState: 1, send() {}, close() {} } as unknown as NodeWs,
          userId: saver.userId,
          writable: true,
          expectedLifecycleRevision: revision,
        });
        const put = gateConfluencePut(confluenceId, 4);
        const save = startSave(pageId, saver.token, {
          title: 'Saved on the app pod',
          expectedLifecycleRevision: revision,
          expectedDocumentState: EMPTY_DOCUMENT_STATE,
        });
        try {
          await put.started;
          await podA.detachSocket(pageId, 'pod-a-writer');
          await waitForGraceDrop(podA, pageId);
          expect(await activePurposes(pageId)).toContain('collab_room');

          put.release();
          const saved = await save;
          expect(saved.statusCode, saved.body).toBe(200);
          await vi.waitFor(async () => {
            expect(await activePurposes(pageId)).toEqual([]);
          }, { timeout: 5_000 });
          // The room is dropped after the admission's release commits, behind a
          // Redis SREM on the same ownership chain: wait for it (#2044).
          await vi.waitFor(() => {
            expect(podA.getRoom(pageId)).toBeUndefined();
          }, { timeout: 5_000 });
        } finally {
          put.release();
          await save;
        }
      } finally {
        if (previousRetry === undefined) delete process.env.COLLAB_DEFERRED_RELEASE_RETRY_MS;
        else process.env.COLLAB_DEFERRED_RELEASE_RETRY_MS = previousRetry;
        await podA.close();
      }
    });

    it('five Saves in a row never disconnect a co-editor typing inside each (#1763)', async () => {
      const { saver, coEditor, pageId, confluenceId } = await seedSaveWindowPage();
      const a = await joinSaveWindowClient(pageId, saver.token);
      const b = await joinSaveWindowClient(pageId, coEditor.token);
      try {
        for (let round = 1; round <= 5; round += 1) {
          const put = gateConfluencePut(confluenceId, 3 + round);
          const save = startSave(pageId, saver.token, commitPayload(a.ws, `Save ${round}`));
          try {
            await put.started;
            typeInSaveWindow(b, `CO_EDITOR_${round}`);
            const seen = await Promise.race([b.closed.then(() => false), a.sees(`CO_EDITOR_${round}`)]);
            expect(b.closeInfo).toBeNull();
            expect(seen).toBe(true);
          } finally {
            put.release();
            await save;
          }
          const saved = await save;
          expect(saved.statusCode, saved.body).toBe(200);
        }
        expect(b.closeInfo).toBeNull();
        const page = await query<{ version: number }>('SELECT version FROM pages WHERE id = $1', [pageId]);
        expect(page.rows[0]!.version).toBe(9);
        await vi.waitFor(async () => {
          const body = await storedBodyHtml(pageId);
          for (let round = 1; round <= 5; round += 1) expect(body).toContain(`CO_EDITOR_${round}`);
        }, { timeout: 5_000 });
      } finally {
        a.ws.close();
        b.ws.close();
      }
    });

    it('a second Save while one is pending is still refused 409 page_write_busy (#1763)', async () => {
      const { saver, coEditor, pageId, confluenceId } = await seedSaveWindowPage();
      const a = await joinSaveWindowClient(pageId, saver.token);
      const b = await joinSaveWindowClient(pageId, coEditor.token);
      const put = gateConfluencePut(confluenceId, 4);
      const save = startSave(pageId, saver.token, commitPayload(a.ws, 'First'));
      try {
        await put.started;
        const second = await startSave(pageId, coEditor.token, commitPayload(b.ws, 'Second'));
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({ reason: 'page_write_busy' });

        put.release();
        const saved = await save;
        expect(saved.statusCode, saved.body).toBe(200);
      } finally {
        put.release();
        await save;
        a.ws.close();
        b.ws.close();
      }
    });
  });
});



describe('#1739 collaborative PK-only identifier boundary', () => {
  beforeAll(() => {
    expect(canRun, 'Identifier regressions require real PostgreSQL and Redis').toBe(true);
  });

  async function storedBoundaryState() {
    const rows: Record<string, unknown> = {};
    for (const table of ['pages', 'page_versions', 'page_collaborative_docs', 'page_write_intents']) {
      const state = await query<{ rows: unknown }>(
        `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM ${table} t`,
      );
      rows[table] = state.rows[0]!.rows;
    }
    return rows;
  }

  for (const raw of ['2147483648', '3000000000', '9007199254740993']) {
    for (const transport of ['HTTP', 'WS'] as const) {
      it(`#1739 RED R-X ${transport} ${raw} cannot widen to a matching Confluence ID`, async () => {
        const actor = await createUser(`id-boundary-${transport}-${raw}`);
        const decoyId = await insertConfluencePage({ spaceKey: 'IDCOLLAB', confluenceId: raw });
        await grantSpaceRead(actor.userId, 'IDCOLLAB');
        await enableCollabFlag();
        const before = await storedBoundaryState();
        if (transport === 'HTTP') {
          const response = await app.inject({
            method: 'POST', url: `/api/pages/${raw}/collab/commit`,
            headers: { authorization: `Bearer ${actor.token}` },
            payload: {
              title: 'Identifier save', expectedLifecycleRevision: '1',
              expectedDocumentState: EMPTY_DOCUMENT_STATE,
            },
          });
          expect.soft(response.statusCode, response.body).toBe(404);
          expect.soft(response.body).not.toMatch(/22003|22P02|out of range for type integer|NaN/);
        } else {
          const ws = new WebSocket(`${baseWs}/api/collab/${raw}`, [COLLAB_WS_PROTOCOL, actor.token]);
          ws.binaryType = 'arraybuffer';
          try {
            const closed = await waitClose(ws);
            expect.soft(closed.opened).toBe(true);
            expect.soft(closed.code).toBe(4404);
            expect.soft(closed.reason).toBe('not_found');
          } finally {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
          }
        }
        expect(await storedBoundaryState()).toEqual(before);
        for (const key of new Set([raw, String(Number(raw)), String(decoyId)])) {
          expect(await getRedisClient()!.sCard(`collab:active:${key}`)).toBe(0);
        }
        expect(getDefaultCollabRuntime()?.getRoom(decoyId)).toBeUndefined();
        expect(getDefaultCollabRuntime()?.getRoom(Number(raw))).toBeUndefined();
      });
    }
  }

  for (const scenario of ['opaque', 'missing', 'private', 'restricted'] as const) {
    for (const transport of ['HTTP', 'WS'] as const) {
      it(`#1739 CONTROL R-X ${transport} preserves ${scenario} refusal`, async () => {
        const actor = await createUser(`id-control-${transport}-${scenario}`);
        const owner = await createUser(`id-control-owner-${transport}-${scenario}`, {
          admin: scenario === 'restricted' && transport === 'HTTP',
        });
        let raw = scenario === 'opaque' ? 'abc' : '1999999999';
        if (scenario === 'private') {
          raw = String(await insertStandalone({ ownerId: owner.userId, visibility: 'private' }));
        } else if (scenario === 'restricted') {
          raw = String(await insertConfluencePage({
            spaceKey: 'IDCOLLAB', confluenceId: 'restricted-id-control', inheritPerms: false,
          }));
          await grantSpaceRead(actor.userId, 'IDCOLLAB');
        }
        await enableCollabFlag();
        const ownerSocket = scenario === 'restricted' && transport === 'HTTP'
          ? await openAndSync(Number(raw), owner.token)
          : undefined;
        try {
          const ownerMembers = ownerSocket ? (await getRedisClient()!.sMembers(`collab:active:${raw}`)).sort() : undefined;
          if (ownerSocket) {
            expect(ownerSocket.protocol).toBe(COLLAB_WS_PROTOCOL);
            expect(ownerSocket.readyState).toBe(WebSocket.OPEN);
            expect(ownerMembers).not.toHaveLength(0);
          }
          const before = await storedBoundaryState();
          if (transport === 'HTTP') {
            const response = await app.inject({
              method: 'POST', url: `/api/pages/${raw}/collab/commit`,
              headers: { authorization: `Bearer ${actor.token}` },
              payload: {
                title: 'Identifier control',
                expectedLifecycleRevision: scenario === 'restricted' ? await pageLifecycleRevision(Number(raw)) : '1',
                expectedDocumentState: EMPTY_DOCUMENT_STATE,
              },
            });
            expect(response.statusCode, response.body).toBe(scenario === 'opaque' ? 404 : 403);
          } else {
            const ws = new WebSocket(`${baseWs}/api/collab/${raw}`, [COLLAB_WS_PROTOCOL, actor.token]);
            const closed = await waitClose(ws);
            expect(closed).toEqual({ opened: true, code: 4404, reason: 'not_found' });
          }
          expect(await storedBoundaryState()).toEqual(before);
          if (ownerSocket) {
            expect((await getRedisClient()!.sMembers(`collab:active:${raw}`)).sort()).toEqual(ownerMembers);
            expect(ownerSocket.readyState).toBe(WebSocket.OPEN);
            expect(getDefaultCollabRuntime()?.getRoom(Number(raw))).toBeDefined();
          }
        } finally {
          if (ownerSocket) {
            const closed = waitClose(ownerSocket);
            ownerSocket.close();
            await closed;
            await vi.waitFor(async () => {
              expect(await getRedisClient()!.sCard(`collab:active:${raw}`)).toBe(0);
            });
          }
        }
        expect(await getRedisClient()!.sCard(`collab:active:${raw}`)).toBe(0);
      });
    }
  }

  it('#1739 CONTROL R-X valid PK still upgrades, syncs and releases its owner', async () => {
    const actor = await createUser('id-collab-valid');
    const pageId = await insertStandalone({ ownerId: actor.userId, visibility: 'shared' });
    await enableCollabFlag();
    const ws = await openAndSync(pageId, actor.token);
    try {
      expect(ws.protocol).toBe(COLLAB_WS_PROTOCOL);
      expect(getDefaultCollabRuntime()?.getRoom(pageId)).toBeDefined();
    } finally {
      const closed = waitClose(ws);
      ws.close();
      await closed;
    }
    await vi.waitFor(async () => {
      expect(await getRedisClient()!.sCard(`collab:active:${pageId}`)).toBe(0);
    });
  });

  it('#1739 CONTROL R-X expired token retains upgrade-first4401', async () => {
    const actor = await createUser('id-collab-expired');
    const pageId = await insertStandalone({ ownerId: actor.userId, visibility: 'shared' });
    await enableCollabFlag();
    const expired = await signExpiredToken(actor.userId, 'id-collab-expired', 'user');
    const ws = new WebSocket(`${baseWs}/api/collab/${pageId}`, [COLLAB_WS_PROTOCOL, expired]);
    const closed = await waitClose(ws);
    expect(closed.opened).toBe(true);
    expect(closed.code).toBe(4401);
  });

  it('#1739 CONTROL R-X flag-off retains upgrade-first4403', async () => {
    const actor = await createUser('id-collab-flag');
    const pageId = await insertStandalone({ ownerId: actor.userId, visibility: 'shared' });
    const ws = new WebSocket(`${baseWs}/api/collab/${pageId}`, [COLLAB_WS_PROTOCOL, actor.token]);
    const closed = await waitClose(ws);
    expect(closed.opened).toBe(true);
    expect(closed.code).toBe(4403);
  });
});

/**
 * #1928 — the gateway's SyncStep1 after a lineage-verified writable join.
 * The tab is a real y-websocket 3.1 `WebsocketProvider`; the lines around it
 * repeat what `use-collab-provider.ts` does with the `doc_epoch` control and
 * the join declaration: pin the epoch at the first sync, declare it on every
 * later join, send the empty-document marker while the unpinned document holds
 * nothing, never reconnect a reset document, and connect a document that
 * holds bytes before its first sync only as a clean one (`connect`). `marker:
 * false` is a bundle that predates the marker: its first join declares nothing.
 */
const SYNC_STEP1 = 0;

interface HookTab {
  /** The current session's provider and document; `connect` can replace both. */
  readonly provider: WebsocketProvider;
  readonly doc: Y.Doc;
  controls: TestControl[];
  closes: Array<{ code: number; reason: string }>;
  /** Server SyncStep1 frames this tab received, over all its connections. */
  serverSyncStep1s: () => number;
  /** Called with every control this tab receives. */
  controlListeners: Array<(control: TestControl) => void>;
  /** The tab's replies to those SyncStep1 frames, in order. */
  replies: Uint8Array[];
  /**
   * The hook's explicit connect: a document that holds bytes before its first
   * sync is replaced by a clean session first (#1928).
   */
  connect: () => void;
  /** Fault injection: the server's SyncStep2 frames are lost, so the tab never completes a sync. */
  loseSyncStep2: boolean;
}

function holdsNothing(doc: Y.Doc): boolean {
  return doc.store.pendingStructs === null
    && doc.store.pendingDs === null
    && Y.equalSnapshots(Y.snapshot(doc), Y.emptySnapshot);
}

/** The hook's per-connect declaration: the pinned epoch from `params`, else the marker while the document holds nothing. */
class MarkerProvider extends WebsocketProvider {
  override get url(): string {
    const url = super.url;
    if (this.params.expectedDocEpoch !== undefined || !holdsNothing(this.doc)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}expectedDocEmpty=${COLLAB_DOC_EMPTY_MARKER}`;
  }
}

/**
 * `marker: false` is a bundle from before the empty-document marker;
 * `replaySafe: false` is a bundle from before #1928 (#2034/#2035): it sends
 * no `docReplaySafe` and keeps a document that holds bytes from before its
 * first sync. The current bundle has both.
 */
function openHookTab(
  pageId: number, token: string, revision: string, { marker = true, replaySafe = marker } = {},
): HookTab {
  const controls: TestControl[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const replies: Uint8Array[] = [];
  let serverSyncStep1s = 0;
  const controlListeners: Array<(control: TestControl) => void> = [];
  let session!: { provider: WebsocketProvider; doc: Y.Doc; hasSynced: () => boolean };
  const tab: HookTab = {
    get provider() { return session.provider; },
    get doc() { return session.doc; },
    controls,
    closes,
    serverSyncStep1s: () => serverSyncStep1s,
    controlListeners,
    replies,
    connect: () => {
      if (replaySafe && !session.hasSynced() && !holdsNothing(session.doc)) {
        session.provider.destroy();
        session.doc.destroy();
        session = openSession();
        return;
      }
      session.provider.connect();
    },
    loseSyncStep2: false,
  };

  function openSession(): typeof session {
    const doc = new Y.Doc();
    let candidate: string | null = null;
    let hasSynced = false;
    const Provider = marker ? MarkerProvider : WebsocketProvider;
    const provider = new Provider(`${baseWs}/api/collab`, String(pageId), doc, {
      protocols: [COLLAB_WS_PROTOCOL, token],
      params: {
        expectedLifecycleRevision: revision,
        ...(replaySafe ? { docReplaySafe: COLLAB_DOC_REPLAY_SAFE } : {}),
      },
      disableBc: true,
    });
    const answerSync = provider.messageHandlers[MESSAGE_SYNC]!;
    provider.messageHandlers[MESSAGE_SYNC] = (encoder, decoder, origin, emitSynced, messageType) => {
      const subtype = decoding.peekVarUint(decoder);
      if (subtype === SYNC_STEP2 && tab.loseSyncStep2) return;
      if (subtype === SYNC_STEP1) serverSyncStep1s += 1;
      answerSync(encoder, decoder, origin, emitSynced, messageType);
      if (subtype === SYNC_STEP1) replies.push(encoding.toUint8Array(encoder));
    };
    provider.messageHandlers[MESSAGE_CONTROL] = (_encoder, decoder) => {
      const control = JSON.parse(decoding.readVarString(decoder)) as TestControl;
      controls.push(control);
      for (const listener of tab.controlListeners) listener(control);
      const epoch = CollabDocEpochControlSchema.safeParse(control);
      if (epoch.success && !hasSynced) candidate = epoch.data.epoch;
    };
    provider.on('sync', (isSynced: boolean) => {
      if (!isSynced || hasSynced) return;
      hasSynced = true;
      if (candidate !== null) provider.params = { ...provider.params, expectedDocEpoch: candidate };
    });
    provider.on('connection-close', (event: CloseEvent | null) => {
      if (!hasSynced) candidate = null;
      if (!event) return;
      closes.push({ code: event.code, reason: event.reason });
      if (event.code === 1001 && event.reason === 'doc_reset') provider.shouldConnect = false;
    });
    onTestFinished(() => {
      provider.destroy();
      doc.destroy();
    });
    return { provider, doc, hasSynced: () => hasSynced };
  }

  session = openSession();
  return tab;
}

/** Synced and writable on the current connection, whose controls start after `since`. */
async function hookTabWritable(tab: HookTab, since = 0): Promise<void> {
  await vi.waitFor(() => {
    expect(tab.provider.synced).toBe(true);
    expect(tab.controls.slice(since).map((control) => control.type)).toContain('writable_admission');
  }, { timeout: 10_000 });
}

function typeInto(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    const content = new Y.XmlText();
    content.insert(0, text);
    paragraph.insert(0, [content]);
    doc.getXmlFragment('default').push([paragraph]);
  });
}

function liveRoomHtml(pageId: number): string {
  const room = getDefaultCollabRuntime()!.getRoom(pageId);
  return room ? yDocToHtml(room.doc) : '';
}

/** A collaborative Save of everything the tab's document holds now. */
function saveTabSnapshot(pageId: number, token: string, revision: string, doc: Y.Doc) {
  return app.inject({
    method: 'POST',
    url: `/api/pages/${pageId}/collab/commit`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: 'Collab page',
      expectedLifecycleRevision: revision,
      expectedDocumentState: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString('base64'),
    },
  });
}

function frameKind(frame: Uint8Array): string {
  if (frame[0] === MESSAGE_SYNC) return ['sync_step1', 'sync_step2', 'sync_update'][frame[1]!] ?? 'sync_other';
  if (frame[0] === MESSAGE_AWARENESS) return 'awareness';
  return 'other';
}

describe.skipIf(!canRun)('server SyncStep1 recovers what only the tab holds (#1928)', () => {
  async function pinnedTab(name: string): Promise<{
    tab: HookTab; pageId: number; token: string; userId: string; revision: string;
  }> {
    const { token, userId } = await createUser(name);
    const pageId = await insertStandalone({ ownerId: userId, bodyHtml: '<p>recovery-seed</p>' });
    await enableCollabFlag();
    const revision = await pageLifecycleRevision(pageId);
    const tab = openHookTab(pageId, token, revision);
    await hookTabWritable(tab);
    // The first join declared an empty document and was asked once; the epoch is pinned from here on.
    expect(tab.serverSyncStep1s()).toBe(1);
    expect(new URL(tab.provider.url).searchParams.get('expectedDocEpoch')).toMatch(/^[0-9a-f-]{36}$/);
    return { tab, pageId, token, userId, revision };
  }

  /** The update a SyncStep2 reply carries. */
  function replyUpdate(reply: Uint8Array): Uint8Array {
    const decoder = decoding.createDecoder(reply);
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
    expect(decoding.readVarUint(decoder)).toBe(1);
    return decoding.readVarUint8Array(decoder);
  }

  it('a first join of a fresh page declares an empty document, is asked once right after writable_admission, and its empty reply changes nothing', async () => {
    const { token, userId } = await createUser('collab_syncstep1_first_join');
    const pageId = await insertStandalone({ ownerId: userId, bodyHtml: '<p>first-join-seed</p>' });
    await enableCollabFlag();
    const revision = await pageLifecycleRevision(pageId);
    const runtime = getDefaultCollabRuntime()!;
    const handleFrame = runtime.handleInboundFrame;
    const handledReplies: string[] = [];
    const frameSpy = vi.spyOn(runtime, 'handleInboundFrame').mockImplementation(async (framePageId, id, buf) => {
      const result = await handleFrame(framePageId, id, buf);
      if (framePageId === pageId && frameKind(buf) === 'sync_step2') handledReplies.push(result);
      return result;
    });
    onTestFinished(() => frameSpy.mockRestore());
    const tab = openHookTab(pageId, token, revision);
    expect(new URL(tab.provider.url).searchParams.get('expectedDocEmpty')).toBe('1');

    await hookTabWritable(tab);

    const room = runtime.getRoom(pageId)!;
    expect([...room.sockets.values()]).toMatchObject([{ writable: true, lineageVerified: true }]);
    expect(tab.serverSyncStep1s()).toBe(1);
    expect(tab.controls.map((control) => control.type)).toEqual(['doc_epoch', 'page_lifecycle', 'writable_admission']);
    // The tab held nothing when it was asked: its reply is an empty update,
    // handled through the fenced write path.
    expect(tab.replies).toHaveLength(1);
    const update = Y.decodeUpdate(replyUpdate(tab.replies[0]!));
    expect(update.structs).toEqual([]);
    expect(update.ds.clients.size).toBe(0);
    await vi.waitFor(() => expect(handledReplies).toEqual(['ok']), { timeout: 10_000 });
    // The room still holds the seed once, written by the seed alone.
    expect([...Y.decodeStateVector(Y.encodeStateVector(room.doc)).keys()]).not.toContain(tab.doc.clientID);
    await persist.flushCollabPersist(room);
    const stored = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId]);
    for (const html of [yDocToHtml(room.doc), yDocToHtml(tab.doc), stored.rows[0]!.body_html]) {
      expect(html.split('first-join-seed')).toHaveLength(2);
    }
    expect(tab.serverSyncStep1s()).toBe(1);
  }, 30_000);

  it.each([
    ['a client with the replay-safe capability is asked once on its marked first join and once on its pinned rejoin', true],
    ['a client without it (#2034/#2035 bundle) is verified on both joins and never asked', false],
  ] as const)('%s', async (_case, replaySafe) => {
    const { token, userId } = await createUser(`collab_syncstep1_capability_${replaySafe ? 'yes' : 'no'}`);
    const pageId = await insertStandalone({ ownerId: userId, bodyHtml: '<p>capability-seed</p>' });
    await enableCollabFlag();
    const revision = await pageLifecycleRevision(pageId);
    const runtime = getDefaultCollabRuntime()!;
    const tab = openHookTab(pageId, token, revision, { replaySafe });
    const joinUrl = new URL(tab.provider.url);
    expect(joinUrl.searchParams.get('expectedDocEmpty')).toBe('1');
    expect(joinUrl.searchParams.get('docReplaySafe')).toBe(replaySafe ? '1' : null);

    await hookTabWritable(tab);
    expect([...runtime.getRoom(pageId)!.sockets.values()]).toMatchObject([{ writable: true, lineageVerified: true }]);
    expect(tab.serverSyncStep1s()).toBe(replaySafe ? 1 : 0);

    const epoch = runtime.getRoom(pageId)!.docEpoch;
    expect(new URL(tab.provider.url).searchParams.get('expectedDocEpoch')).toBe(epoch);
    const since = tab.controls.length;
    tab.provider.disconnect();
    tab.provider.connect();
    await hookTabWritable(tab, since);
    expect([...runtime.getRoom(pageId)!.sockets.values()]).toMatchObject([{ writable: true, lineageVerified: true }]);
    expect(tab.serverSyncStep1s()).toBe(replaySafe ? 2 : 0);
    expect(tab.controls.slice(since).map((control) => control.type)).not.toContain('doc_reset');
  }, 30_000);

  it('in one live room, a marked empty tab is asked and a join that declares nothing is not; a pre-marker bundle\'s pinned rejoin is verified but, without the capability, not asked', async () => {
    const { token, userId } = await createUser('collab_syncstep1_undeclared');
    const pageId = await insertStandalone({ ownerId: userId, bodyHtml: '<p>undeclared-seed</p>' });
    await enableCollabFlag();
    const revision = await pageLifecycleRevision(pageId);
    // A bundle without the marker joins first and seeds the room.
    const undeclared = openHookTab(pageId, token, revision, { marker: false });
    expect(new URL(undeclared.provider.url).searchParams.has('expectedDocEmpty')).toBe(false);
    await hookTabWritable(undeclared);
    // An empty tab of the current bundle joins the same room with the marker.
    const marked = openHookTab(pageId, token, revision);
    expect(new URL(marked.provider.url).searchParams.get('expectedDocEmpty')).toBe('1');
    await hookTabWritable(marked);

    const room = getDefaultCollabRuntime()!.getRoom(pageId)!;
    expect([...room.sockets.values()]).toMatchObject([
      { writable: true, lineageVerified: false },
      { writable: true, lineageVerified: true },
    ]);
    expect(undeclared.serverSyncStep1s()).toBe(0);
    expect(marked.serverSyncStep1s()).toBe(1);

    // Pinned at the first sync, the undeclared tab's rejoin declares the epoch
    // and is verified; a bundle from before #1928 sends no capability and is not asked.
    expect(new URL(undeclared.provider.url).searchParams.get('expectedDocEpoch')).toBe(room.docEpoch);
    expect(new URL(undeclared.provider.url).searchParams.has('docReplaySafe')).toBe(false);
    const since = undeclared.controls.length;
    undeclared.provider.disconnect();
    undeclared.provider.connect();
    await hookTabWritable(undeclared, since);
    const rejoined = [...getDefaultCollabRuntime()!.getRoom(pageId)!.sockets.values()];
    expect(rejoined.filter((socket) => socket.lineageVerified)).toHaveLength(2);
    expect(undeclared.serverSyncStep1s()).toBe(0);
    expect(marked.serverSyncStep1s()).toBe(1);
  }, 30_000);

  it.each([
    ['the current bundle joins lineage B from a clean document; its pinned rejoin is asked', true],
    ['a bundle without #1928 keeps the bytes and pins B; its verified rejoin is never asked', false],
  ] as const)('a tab that received an edit of lineage A before its first sync and dropped: %s, and nothing of A reaches B or the database', async (_case, replaySafe) => {
    const { token, userId } = await createUser(`collab_syncstep1_partial_sync_${replaySafe ? 'current' : 'older'}`);
    const pageId = await insertStandalone({ ownerId: userId, bodyHtml: '<p>lineage-a-seed</p>' });
    await enableCollabFlag();
    const revision = await pageLifecycleRevision(pageId);
    const runtime = getDefaultCollabRuntime()!;
    const handleFrame = runtime.handleInboundFrame;
    const handledReplies: string[] = [];
    const frameSpy = vi.spyOn(runtime, 'handleInboundFrame').mockImplementation(async (framePageId, id, buf) => {
      const result = await handleFrame(framePageId, id, buf);
      if (framePageId === pageId && frameKind(buf) === 'sync_step2') handledReplies.push(result);
      return result;
    });
    onTestFinished(() => frameSpy.mockRestore());

    // Lineage A: a writer, and a tab whose first sync never completes (its SyncStep2 is lost).
    const writer = openHookTab(pageId, token, revision);
    await hookTabWritable(writer);
    const epochA = runtime.getRoom(pageId)!.docEpoch;
    const tab = openHookTab(pageId, token, revision, { replaySafe });
    tab.loseSyncStep2 = true;
    await vi.waitFor(() => {
      expect(tab.controls.map((control) => control.type)).toContain('writable_admission');
    }, { timeout: 10_000 });
    expect(tab.provider.synced).toBe(false);
    // The writer's edit of A is fanned out to the tab before its first sync.
    typeInto(writer.doc, 'LINEAGE_A_EDIT');
    await vi.waitFor(() => expect(holdsNothing(tab.doc)).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() => expect(liveRoomHtml(pageId)).toContain('LINEAGE_A_EDIT'), { timeout: 10_000 });
    const lineageA = new Set([
      ...Y.decodeStateVector(Y.encodeStateVector(runtime.getRoom(pageId)!.doc)).keys(),
      writer.doc.clientID,
    ]);
    const stale = tab.doc;

    // Both leave; lineage A ends with a non-collab body write.
    tab.provider.disconnect();
    writer.provider.disconnect();
    await vi.waitFor(() => expect(runtime.getRoom(pageId)?.sockets.size ?? 0).toBe(0));
    await runtime.dropRoom(pageId);
    const current = await query<{ version: number }>('SELECT version FROM pages WHERE id = $1', [pageId]);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Collab page', bodyHtml: '<p>LINEAGE_B_BODY</p>', version: current.rows[0]!.version },
    });
    expect(put.statusCode, put.body).toBe(200);

    // The tab reconnects. The current bundle starts from a clean document: its
    // marker join seeds lineage B and is verified. A bundle without #1928
    // reconnects the document it kept; it declares nothing and pins B.
    tab.loseSyncStep2 = false;
    let since = tab.controls.length;
    tab.connect();
    if (replaySafe) expect(tab.doc).not.toBe(stale);
    else expect(tab.doc).toBe(stale);
    await hookTabWritable(tab, since);
    const roomB = runtime.getRoom(pageId)!;
    expect(roomB.docEpoch).not.toBe(epochA);
    expect([...roomB.sockets.values()]).toMatchObject([{ writable: true, lineageVerified: replaySafe }]);
    expect(new URL(tab.provider.url).searchParams.get('expectedDocEpoch')).toBe(roomB.docEpoch);

    // A later rejoin declares B and is verified. Only a replay-safe client is
    // asked; its reply is handled on the fenced path.
    const asked = tab.serverSyncStep1s();
    const handledBefore = handledReplies.length;
    since = tab.controls.length;
    tab.provider.disconnect();
    tab.provider.connect();
    await hookTabWritable(tab, since);
    expect([...runtime.getRoom(pageId)!.sockets.values()]).toMatchObject([{ writable: true, lineageVerified: true }]);
    const fromA = (update: Uint8Array) => Y.decodeUpdate(update).structs
      .map((struct) => struct.id.client)
      .filter((client) => lineageA.has(client));
    if (replaySafe) {
      expect(tab.serverSyncStep1s()).toBe(asked + 1);
      await vi.waitFor(() => expect(handledReplies.slice(handledBefore)).toContain('ok'), { timeout: 10_000 });
      expect(fromA(replyUpdate(tab.replies.at(-1)!))).toEqual([]);
    } else {
      // The stale document still holds A's edit, parked; it is never asked for it.
      expect(tab.doc.store.pendingStructs).not.toBeNull();
      expect(tab.serverSyncStep1s()).toBe(0);
    }

    const room = runtime.getRoom(pageId)!;
    expect(room.docEpoch).toBe(roomB.docEpoch);
    expect(room.doc.store.pendingStructs).toBeNull();
    expect(fromA(Y.encodeStateAsUpdate(room.doc))).toEqual([]);
    await persist.flushCollabPersist(room);
    const stored = await query<{ doc_state: Buffer; body_html: string }>(
      `SELECT d.doc_state, p.body_html FROM page_collaborative_docs d JOIN pages p ON p.id = d.page_id
        WHERE d.page_id = $1`,
      [pageId],
    );
    expect(fromA(new Uint8Array(stored.rows[0]!.doc_state))).toEqual([]);
    for (const html of [yDocToHtml(room.doc), yDocToHtml(tab.doc), stored.rows[0]!.body_html]) {
      expect(html.split('LINEAGE_B_BODY')).toHaveLength(2);
      expect(html).not.toContain('LINEAGE_A_EDIT');
      expect(html).not.toContain('lineage-a-seed');
    }
  }, 40_000);

  it('a frame refused with 1001 collab_validation_unavailable reaches the room after the reconnect, and the Save returns 200', async () => {
    const { tab, pageId, token, revision } = await pinnedTab('collab_syncstep1_refused');
    // A real fault at the database boundary of that one frame: its write
    // transaction queues behind a held page lifecycle lock and its backend is
    // terminated there. The lock is released before the tab reconnects.
    const holder = await getPool().connect();
    let holding = true;
    const releaseHolder = async (): Promise<void> => {
      if (!holding) return;
      holding = false;
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    };
    onTestFinished(releaseHolder);
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [PAGE_LIFECYCLE_LOCK_KEY, pageId]);
    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

    typeInto(tab.doc, 'REFUSED_FRAME');
    let framePids: number[] = [];
    await vi.waitFor(async () => {
      const blocked = await query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
        [holderPid],
      );
      framePids = blocked.rows.map((row) => row.pid);
      expect(framePids).toHaveLength(1);
    }, { timeout: 8_000 });
    const terminated = await query<{ terminated: boolean }>(
      'SELECT pg_terminate_backend($1) AS terminated', [framePids[0]],
    );
    expect(terminated.rows[0]!.terminated).toBe(true);
    await releaseHolder();

    await vi.waitFor(() => {
      expect(tab.closes).toContainEqual({ code: 1001, reason: 'collab_validation_unavailable' });
    }, { timeout: 8_000 });
    expect(liveRoomHtml(pageId)).not.toContain('REFUSED_FRAME');

    // y-websocket reconnects by itself, declaring the pinned epoch.
    await vi.waitFor(() => expect(liveRoomHtml(pageId)).toContain('REFUSED_FRAME'), { timeout: 10_000 });
    // One SyncStep1 on the first join, one on the rejoin.
    expect(tab.serverSyncStep1s()).toBe(2);
    const saved = await saveTabSnapshot(pageId, token, revision, tab.doc);
    expect(saved.statusCode, saved.body).toBe(200);
  }, 30_000);

  it('an edit made while disconnected after the first sync reaches the room after the reconnect, and the Save returns 200', async () => {
    const { tab, pageId, token, revision } = await pinnedTab('collab_syncstep1_offline');
    tab.provider.disconnect();
    await vi.waitFor(() => expect(tab.provider.wsconnected).toBe(false));
    typeInto(tab.doc, 'TYPED_OFFLINE');
    const since = tab.controls.length;

    tab.provider.connect();

    await hookTabWritable(tab, since);
    await vi.waitFor(() => expect(liveRoomHtml(pageId)).toContain('TYPED_OFFLINE'), { timeout: 10_000 });
    expect(tab.serverSyncStep1s()).toBe(2);
    const saved = await saveTabSnapshot(pageId, token, revision, tab.doc);
    expect(saved.statusCode, saved.body).toBe(200);
  }, 30_000);

  it('a stale tab with an offline edit still ends in doc_reset after a non-collab body write; the body appears once', async () => {
    const { tab, pageId, token, revision } = await pinnedTab('collab_syncstep1_stale');
    tab.provider.disconnect();
    await vi.waitFor(() => expect(tab.provider.wsconnected).toBe(false));
    typeInto(tab.doc, 'STALE_OFFLINE_EDIT');
    // The tab stayed away: its room is gone, then a PUT replaces the body and ends the lineage.
    const runtime = getDefaultCollabRuntime()!;
    await vi.waitFor(() => expect(runtime.getRoom(pageId)?.sockets.size ?? 0).toBe(0));
    await runtime.dropRoom(pageId);
    const put = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Collab page', bodyHtml: '<p>REPLACED_BODY</p>', version: 1 },
    });
    expect(put.statusCode, put.body).toBe(200);
    const since = tab.controls.length;

    tab.provider.connect();

    await vi.waitFor(() => {
      expect(tab.closes.at(-1)).toEqual({ code: 1001, reason: 'doc_reset' });
    }, { timeout: 10_000 });
    expect(tab.controls.slice(since)).toEqual([{ type: 'doc_reset' }]);
    // Only the first join was asked; the reset rejoin is not.
    expect(tab.serverSyncStep1s()).toBe(1);
    const fresh = openHookTab(pageId, token, revision);
    await hookTabWritable(fresh);
    await persist.flushCollabPersist(runtime.getRoom(pageId)!);
    const stored = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId]);
    for (const html of [liveRoomHtml(pageId), yDocToHtml(fresh.doc), stored.rows[0]!.body_html]) {
      expect(html.split('REPLACED_BODY')).toHaveLength(2);
      expect(html).not.toContain('recovery-seed');
      expect(html).not.toContain('STALE_OFFLINE_EDIT');
    }
  }, 30_000);

  const OFFLINE = 'TYPED_WHILE_RATE_LIMITED';
  const PROBE = [0, 0, 1, 0];

  /** A tab whose post-sync 4403 left its provider disconnected, typing on. */
  async function offlineTab(name: string, text: string | null = OFFLINE) {
    const session = await pinnedTab(name);
    session.tab.provider.disconnect();
    await vi.waitFor(() => expect(session.tab.provider.wsconnected).toBe(false));
    if (text !== null) typeInto(session.tab.doc, text);
    return session;
  }

  /**
   * The production attempt on this tab's provider and document. Only the
   * hook's routing of controls and closes into it is written out here: the
   * attempt, its SyncStep1 observation, the probe and the proof are the shared
   * code, and `succeeded` is the one thing that makes the editor writable.
   */
  function rejoinRun(tab: HookTab, pageId: number, revision: string) {
    const run = { succeeded: false, unconfirmed: false, refusal: null as string | null, roomAtSuccess: '' };
    const controller = createRejoinController(tab.provider, {
      onSucceeded: () => {
        run.succeeded = true;
        run.roomAtSuccess = liveRoomHtml(pageId);
      },
      onUnconfirmed: () => { run.unconfirmed = true; },
    });
    const refuse = (type: string) => {
      run.refusal = type;
      controller.cancel();
    };
    tab.controlListeners.push((control) => {
      if (!controller.running) return;
      if (control.type === 'writable_admission' && control.lifecycleRevision === revision) controller.admit();
      else if (['writable_refused', 'permission_loss', 'doc_reset', 'tombstone', 'commit_unknown'].includes(control.type)) {
        refuse(control.type);
      }
    });
    tab.provider.on('connection-close', (event: CloseEvent | null) => {
      if (!controller.running) return;
      tab.provider.shouldConnect = false;
      if (event?.code === 1001 && (event.reason === 'doc_reset' || event.reason === 'commit_unknown')) refuse(event.reason);
      else if (event === null || event.code < 4400 || event.code >= 4500) controller.fail();
    });
    // The tab's own transport is the barrier: the attempt's real probe frame can
    // be held on the client side, outside any server transaction, and released later.
    let probes = 0;
    let holding = false;
    let held: (() => void) | null = null;
    return {
      run,
      controller,
      press: () => {
        controller.start(tab.doc);
        const ws = tab.provider.ws!;
        const deliver = ws.send.bind(ws);
        Object.assign(ws, {
          send: (frame: Uint8Array) => {
            if (frame.length === PROBE.length && PROBE.every((byte, i) => frame[i] === byte)) {
              probes += 1;
              if (holding) {
                held = () => deliver(frame);
                return;
              }
            }
            deliver(frame);
          },
        });
      },
      probesSent: () => probes,
      holdProbe: () => { holding = true; },
      probeHeld: () => held !== null,
      releaseProbe: () => {
        holding = false;
        held?.();
        held = null;
      },
    };
  }

  // Real sockets and a real room: "nothing arrives afterwards" can only be
  // observed by letting wall time pass, so fake timers cannot stand in here.
  const pause = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  };

  it('pressing Rejoin restores editing only with the room\'s own answer, and a following Save returns 200 (#2036)', async () => {
    const { tab, pageId, token, revision } = await offlineTab('collab_rejoin_save');
    const attempt = rejoinRun(tab, pageId, revision);
    // The first join was verified through the marker and has had its own SyncStep1.
    const before = tab.serverSyncStep1s();

    attempt.press();

    // Same provider and document, the joined revision and the pinned epoch.
    expect(new URL(tab.provider.url).searchParams.get('expectedDocEpoch')).toMatch(/^[0-9a-f-]{36}$/);
    expect(new URL(tab.provider.url).searchParams.has('expectedDocEmpty')).toBe(false);
    expect(new URL(tab.provider.url).searchParams.get('docReplaySafe')).toBe('1');
    await vi.waitFor(() => expect(attempt.run.succeeded).toBe(true), { timeout: 12_000 });
    // Writable only after the room held the draft; the Rejoin's connection was asked for it once.
    expect(attempt.run.roomAtSuccess).toContain(OFFLINE);
    expect(attempt.probesSent()).toBe(1);
    expect(tab.serverSyncStep1s() - before).toBe(1);
    const saved = await saveTabSnapshot(pageId, token, revision, tab.doc);
    expect(saved.statusCode, saved.body).toBe(200);
  }, 30_000);

  it.each([
    ['an epoch invalidation', 'doc_reset', async (pageId: number) => {
      // What the three inbound publication writers do in their own transaction:
      // under the page lifecycle lock, delete the collaborative row.
      await invalidateCollabDocAfterBodyWrite(pageId);
    }],
    ['an unknown-outcome marker (its cue is delayed)', 'commit_unknown', async (pageId: number, userId: string, revision: string) => {
      // The Save route's own sequence for a Save that fails after dispatch: a
      // reserved collaborative-commit intent, a started remote effect that
      // throws, and the marker through the production declaration. The cue
      // callback does nothing, so only the probe's own fence can notice.
      const publication = describeCollabCommit({
        actorId: userId, pageId, confluenceId: 'cf-2036', title: 'Collab page', bodyStorage: '<p>x</p>',
        expectedRemoteVersion: 4, expectedLocalVersion: 1, expectedLifecycleRevision: revision,
      });
      const intent = await reservePageWriteIntent({
        pageIds: [pageId], kind: 'collab.commit.confluence', actorId: userId, effect: publication.effect,
      });
      await expect(runPageWriteIntentEffect(
        intent,
        { kind: 'remote', completesRemoteWork: true },
        async () => { throw new Error('socket hang up after the request was written'); },
      )).rejects.toThrow('socket hang up');
      await declareCollabCommitUnknown(intent, () => undefined).record();
      // `record()` never throws and can fall back to latches: the refusal must come
      // from the committed marker, so pin it in PostgreSQL before the probe is released.
      const marked = await query<{ marked: boolean }>(
        'SELECT remote_effect_failed_at IS NOT NULL AS marked FROM page_write_intents WHERE id = $1',
        [intent.id],
      );
      expect(marked.rows).toEqual([{ marked: true }]);
    }],
  ])('never restores editing when %s commits after the replay and before the probe answer', async (_name, refusal, fence) => {
    const { tab, pageId, userId, revision } = await offlineTab(`collab_rejoin_${refusal}`);
    const attempt = rejoinRun(tab, pageId, revision);
    attempt.holdProbe();

    attempt.press();

    // The replay has reached the room; the probe frame waits on the tab's transport.
    await vi.waitFor(() => {
      expect(attempt.probeHeld()).toBe(true);
      expect(liveRoomHtml(pageId)).toContain(OFFLINE);
    }, { timeout: 12_000 });
    await fence(pageId, userId, revision);
    attempt.releaseProbe();

    await vi.waitFor(() => expect(attempt.run.refusal).toBe(refusal), { timeout: 12_000 });
    expect(attempt.probesSent()).toBe(1);
    // Nothing arrives afterwards that could count as proof; the draft is still the tab's.
    await pause(1_500);
    expect(attempt.run.succeeded).toBe(false);
    expect(attempt.run.unconfirmed).toBe(false);
    expect(yDocToHtml(tab.doc)).toContain(OFFLINE);
  }, 30_000);

  it('sends no probe when no server SyncStep1 arrived, although the room already holds the draft', async () => {
    const { tab, pageId, revision } = await offlineTab('collab_rejoin_nostep1', null);
    // An undeclared join is admitted but never lineage-verified, so it is not asked for a replay.
    tab.provider.params = { expectedLifecycleRevision: revision };
    const since = tab.controls.length;
    const requested = tab.serverSyncStep1s();
    const attempt = rejoinRun(tab, pageId, revision);

    attempt.press();

    await hookTabWritable(tab, since);
    await pause(1_500);
    expect(tab.serverSyncStep1s()).toBe(requested);
    expect(attempt.probesSent()).toBe(0);
    expect(attempt.run.succeeded).toBe(false);
    attempt.controller.cancel();
  }, 30_000);
});

describe.skipIf(!canRun)('gateway handoff to the live path (#1928)', () => {
  interface JoinInterceptor {
    entered: Promise<void>;
    proceed: () => void;
    commitReached: Promise<void>;
    releaseCommit: () => void;
    serverClosed: Promise<void>;
    /** The server side of the intercepted join's socket, once the join began. */
    serverSocket: () => NodeWs | null;
    /** Settles when the intercepted `attachSocket` has returned or thrown. */
    joined: Promise<unknown>;
    /** What the server read on the socket since the join began. */
    received: Array<{ kind: string; bytes: number }>;
    /** The frames of this socket the room handled, in order. */
    handled: string[];
  }

  /**
   * Wraps the next join: it waits inside `attachSocket` until `proceed`, and
   * the COMMIT of its fenced final step is paused until `releaseCommit`, or
   * fails. That COMMIT is bound to the join's own checkout: the pooled client
   * that holds the page's lifecycle lock when `goLive` runs, which only the
   * final step's transaction can hold at that moment. No other transaction's
   * COMMIT is touched.
   */
  function interceptJoin(commit: 'pause' | 'fail'): JoinInterceptor {
    const runtime = getDefaultCollabRuntime()!;
    const attach = runtime.attachSocket;
    const handleFrame = runtime.handleInboundFrame;
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const commitReached = Promise.withResolvers<void>();
    const commitRelease = Promise.withResolvers<void>();
    const serverClosed = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<unknown>();
    const received: JoinInterceptor['received'] = [];
    const handled: string[] = [];
    let connId: string | null = null;
    let joinPageId: number | null = null;
    let serverSocket: NodeWs | null = null;
    // At most one client at a time: the page's lifecycle lock is exclusive.
    const lifecycleHolder = new Set<pg.Client>();
    const finalStepClient = new Set<pg.Client>();
    const sendQuery = pg.Client.prototype.query as (...args: unknown[]) => unknown;
    const querySpy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const [text, values] = args;
      if (finalStepClient.has(this) && text === 'COMMIT') {
        finalStepClient.clear();
        lifecycleHolder.clear();
        commitReached.resolve();
        if (commit === 'fail') return Promise.reject(new Error('final step COMMIT lost'));
        return commitRelease.promise.then(() => sendQuery.apply(this, args));
      }
      const sent = sendQuery.apply(this, args);
      if (
        text === 'SELECT pg_advisory_xact_lock($1, $2)' && Array.isArray(values)
        && values[0] === PAGE_LIFECYCLE_LOCK_KEY && joinPageId !== null && values[1] === joinPageId
      ) {
        void (sent as Promise<unknown>).then(() => {
          lifecycleHolder.clear();
          lifecycleHolder.add(this);
        }, () => undefined);
      } else if (lifecycleHolder.has(this) && (text === 'COMMIT' || text === 'ROLLBACK')) {
        lifecycleHolder.clear();
      }
      return sent;
    } as never);
    const attachSpy = vi.spyOn(runtime, 'attachSocket').mockImplementationOnce(async (pageId, socket) => {
      connId = socket.id;
      joinPageId = pageId;
      serverSocket = socket.ws;
      socket.ws.on('message', (data) => {
        const frame = Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data);
        received.push({ kind: frameKind(frame), bytes: frame.byteLength });
      });
      socket.ws.on('close', () => serverClosed.resolve());
      entered.resolve();
      await proceed.promise;
      const goLive = socket.goLive;
      const attaching = attach(pageId, {
        ...socket,
        ...(goLive ? {
          goLive: () => {
            for (const client of lifecycleHolder) finalStepClient.add(client);
            goLive();
          },
        } : {}),
      });
      attaching.then(joined.resolve, joined.resolve);
      return attaching;
    });
    const frameSpy = vi.spyOn(runtime, 'handleInboundFrame').mockImplementation(async (pageId, id, buf) => {
      if (id === connId) handled.push(frameKind(buf));
      return handleFrame(pageId, id, buf);
    });
    onTestFinished(() => {
      proceed.resolve();
      commitRelease.resolve();
      querySpy.mockRestore();
      attachSpy.mockRestore();
      frameSpy.mockRestore();
    });
    return {
      entered: entered.promise,
      proceed: () => proceed.resolve(),
      commitReached: commitReached.promise,
      releaseCommit: () => commitRelease.resolve(),
      serverClosed: serverClosed.promise,
      serverSocket: () => serverSocket,
      joined: joined.promise,
      received,
      handled,
    };
  }

  /** A pinned tab that is offline; `edit` runs on its document while it is away. */
  async function offlinePinnedTab(name: string, edit: (doc: Y.Doc) => void): Promise<{ tab: HookTab; pageId: number }> {
    const { token, userId } = await createUser(name);
    const pageId = await insertStandalone({ ownerId: userId, bodyHtml: '<p>handoff-seed</p>' });
    await enableCollabFlag();
    const tab = openHookTab(pageId, token, await pageLifecycleRevision(pageId));
    await hookTabWritable(tab);
    tab.provider.disconnect();
    await vi.waitFor(() => expect(tab.provider.wsconnected).toBe(false));
    edit(tab.doc);
    return { tab, pageId };
  }

  /** Reconnect and let the join run once a typed edit sits in the pre-live buffer. */
  async function rejoinWithBufferedEdit(tab: HookTab, join: JoinInterceptor, text: string): Promise<void> {
    tab.provider.connect();
    await join.entered;
    await vi.waitFor(() => expect(tab.provider.wsconnected).toBe(true));
    typeInto(tab.doc, text);
    await vi.waitFor(() => expect(join.received.map((frame) => frame.kind)).toContain('sync_update'));
    join.proceed();
    await join.commitReached;
  }

  it('takes a reply between 1 MiB and 10 MiB while the final COMMIT is paused, after the earlier buffered frame, without 1013', async () => {
    const offline = `OFFLINE_BULK_${'x'.repeat(1_200_000)}`;
    const { tab, pageId } = await offlinePinnedTab('collab_handoff_large', (doc) => typeInto(doc, offline));
    const join = interceptJoin('pause');

    await rejoinWithBufferedEdit(tab, join, 'PRELIVE_EDIT');

    // The tab got the SyncStep1 and replied while the join's transaction is still open.
    await vi.waitFor(() => {
      expect(join.received.some((frame) => frame.kind === 'sync_step2' && frame.bytes > 1024 * 1024)).toBe(true);
    }, { timeout: 10_000 });
    // One SyncStep1 on the first join, one on this rejoin.
    expect(tab.serverSyncStep1s()).toBe(2);
    // Nothing is handled under the join's lock, and the reply did not overflow the pre-live buffer.
    expect(join.handled).toEqual([]);
    expect(tab.closes).toEqual([]);

    join.releaseCommit();

    await vi.waitFor(() => {
      const html = liveRoomHtml(pageId);
      expect(html).toContain('PRELIVE_EDIT');
      expect(html).toContain(offline);
    }, { timeout: 10_000 });
    // The buffered frames first, in arrival order, then the reply.
    expect(join.handled.slice(0, 4)).toEqual(['sync_step1', 'awareness', 'sync_update', 'sync_step2']);
    expect(tab.closes).toEqual([]);
    expect(tab.provider.wsconnected).toBe(true);
  }, 30_000);

  it.each([
    ['the socket closes while the final COMMIT is paused', 'pause'],
    ['the final transaction rolls back', 'fail'],
  ] as const)('drops the buffered mutation when %s', async (_case, commit) => {
    const { tab, pageId } = await offlinePinnedTab(`collab_handoff_drop_${commit}`, () => undefined);
    // Whatever happens to this connection, the tab must not reconnect and replay its edit.
    tab.provider.on('connection-close', () => { tab.provider.shouldConnect = false; });
    const join = interceptJoin(commit);

    await rejoinWithBufferedEdit(tab, join, 'GATED_EDIT');
    if (commit === 'pause') {
      tab.provider.disconnect();
      await join.serverClosed;
      join.releaseCommit();
    } else {
      await join.serverClosed;
      expect(tab.closes).toContainEqual({ code: 1001, reason: 'collab_validation_unavailable' });
    }
    await join.joined;
    // Every continuation of the join and of the gated chain runs before the next macrotask.
    const drained = Promise.withResolvers<void>();
    setImmediate(drained.resolve);
    await drained.promise;

    expect(join.handled).toEqual([]);
    expect(liveRoomHtml(pageId)).not.toContain('GATED_EDIT');
    const stored = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId]);
    expect(stored.rows[0]!.body_html).not.toContain('GATED_EDIT');
  }, 30_000);

  it('drops the buffered mutation when the socket is CLOSING, before its close event, as the final COMMIT completes', async () => {
    const { tab, pageId } = await offlinePinnedTab('collab_handoff_closing', () => undefined);
    tab.provider.on('connection-close', () => { tab.provider.shouldConnect = false; });
    const join = interceptJoin('pause');

    await rejoinWithBufferedEdit(tab, join, 'CLOSING_EDIT');
    // The server starts closing the transport (as a room path does with
    // `ws.close`) while the COMMIT is paused. Its completion is held: the
    // underlying TCP socket (a private member of ws) is not read, so the
    // tab's close reply and the `close` event wait.
    const transport = join.serverSocket()!;
    const tcp = '_socket' in transport ? transport._socket : null;
    if (!(tcp instanceof Socket)) throw new Error('ws no longer exposes its TCP socket');
    tcp.pause();
    // Resumed on failure as well, so a failed assertion cannot leave the transport stalled.
    onTestFinished(() => { tcp.resume(); });
    let closeEmitted = false;
    transport.on('close', () => { closeEmitted = true; });
    transport.close(1001, 'closing_during_join');
    expect(transport.readyState).toBe(NodeWs.CLOSING);

    join.releaseCommit();
    await join.joined;
    const drained = Promise.withResolvers<void>();
    setImmediate(drained.resolve);
    await drained.promise;

    // Still CLOSING, no close event yet: nothing queued was dispatched or applied.
    expect(transport.readyState).toBe(NodeWs.CLOSING);
    expect(closeEmitted).toBe(false);
    expect(join.handled).toEqual([]);
    expect(liveRoomHtml(pageId)).not.toContain('CLOSING_EDIT');

    tcp.resume();
    await join.serverClosed;
    expect(join.handled).toEqual([]);
    expect(liveRoomHtml(pageId)).not.toContain('CLOSING_EDIT');
    const stored = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId]);
    expect(stored.rows[0]!.body_html).not.toContain('CLOSING_EDIT');
  }, 30_000);

  it('bounds the reply by the 10 MiB WebSocket maxPayload', async () => {
    const { tab, pageId } = await offlinePinnedTab('collab_handoff_max_payload', () => undefined);
    const runtime = getDefaultCollabRuntime()!;
    const attach = runtime.attachSocket;
    const handleFrame = runtime.handleInboundFrame;
    const serverErrors: Array<{ code: unknown; message: string }> = [];
    const serverClosed = Promise.withResolvers<void>();
    const handledBytes: number[] = [];
    let connId: string | null = null;
    const attachSpy = vi.spyOn(runtime, 'attachSocket').mockImplementationOnce(async (joinPageId, socket) => {
      connId = socket.id;
      socket.ws.on('error', (err: Error & { code?: unknown }) => {
        serverErrors.push({ code: err.code, message: err.message });
      });
      socket.ws.on('close', () => serverClosed.resolve());
      return attach(joinPageId, socket);
    });
    const frameSpy = vi.spyOn(runtime, 'handleInboundFrame').mockImplementation(async (framePageId, id, buf) => {
      if (id === connId) handledBytes.push(buf.byteLength);
      return handleFrame(framePageId, id, buf);
    });
    onTestFinished(() => {
      attachSpy.mockRestore();
      frameSpy.mockRestore();
    });
    const since = tab.controls.length;
    tab.provider.connect();
    await hookTabWritable(tab, since);
    tab.provider.on('connection-close', () => { tab.provider.shouldConnect = false; });
    const before = liveRoomHtml(pageId);
    const closesBefore = tab.closes.length;

    tab.provider.ws!.send(new Uint8Array(10 * 1024 * 1024 + 1));

    // The server's receiver refuses the frame for its length and closes the
    // socket. The client may see the server's 1009, or an abnormal 1006 when
    // the server tears the connection down while the client is still writing.
    await serverClosed.promise;
    expect(serverErrors).toContainEqual(expect.objectContaining({ code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' }));
    await vi.waitFor(() => expect(tab.closes.length).toBeGreaterThan(closesBefore), { timeout: 10_000 });
    expect([1009, 1006]).toContain(tab.closes.at(-1)!.code);
    // The frame never reached the room, and the document is unchanged.
    expect(handledBytes.every((bytes) => bytes <= 10 * 1024 * 1024)).toBe(true);
    expect(liveRoomHtml(pageId)).toBe(before);
  }, 30_000);
});
