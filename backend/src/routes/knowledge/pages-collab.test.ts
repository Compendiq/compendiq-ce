/**
 * Integration tests for GET /api/collab/:pageId (#1444).
 *
 * Real Postgres (:5433) + real Redis. Mock only outbound HTTP/DNS.
 * A WHATWG-shaped client (globalThis.WebSocket, protocols array, no
 * `unexpected-response`) MUST recover from an expired JWT: 101 then 4401,
 * refresh, second connection syncs. This file fails if the server 401s the
 * handshake (`onRequest authenticate` throw → close 1006).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import * as jose from 'jose';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebSocket as NodeWs } from 'ws';

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
import { generateAccessToken, generateRefreshToken, revokeAllUserTokens } from '../../core/plugins/auth.js';
import { logger } from '../../core/utils/logger.js';
import { COLLAB_UPGRADE_WINDOW_SEC, COLLAB_WS_PROTOCOL, type CollabCommit } from '@compendiq/contracts';
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
import { encryptPat } from '../../core/utils/crypto.js';
import { ConfluenceClient, ConfluenceError } from '../../domains/confluence/services/confluence-client.js';
import { isCollabCommitPending, withPageWriteTransaction } from '../../core/services/page-write-admission.js';
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
  it('standalone DELETE after committed SQL closes 4404', async () => {
    const { token, userId } = await createUser('collab_trash');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const ws = await openAndSync(pageId, token);
    const closedP = waitClose(ws);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/pages/${pageId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
    const closed = await closedP;
    expect(closed.code).toBe(4404);
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
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, 1, 'Collab page', '<p>old</p>', 'old', NOW())
       ON CONFLICT (page_id, version_number) DO NOTHING`,
      [pageId],
    );
    await query(
      `UPDATE pages SET version = 2, body_html = '<p>live-room</p>' WHERE id = $1`,
      [pageId],
    );
    await query(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, 2, 'Collab page', '<p>live-room</p>', 'live-room', NOW())
       ON CONFLICT (page_id, version_number) DO NOTHING`,
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
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, 1, 'Collab page', '<p>old</p>', 'old', NOW())`,
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

  async function seedLiveConfluencePage(opts?: { version?: number; bodyHtml?: string }): Promise<{
    token: string;
    userId: string;
    pageId: number;
    confluenceId: string;
    spaceKey: string;
    ws: WebSocket;
  }> {
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
    const ws = await openAndSync(pageId, token);
    return { token, userId, pageId, confluenceId, spaceKey, ws };
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
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({ version: 4 });
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
    expect(page.rows[0]!.version).toBe(4);
    expect(Number(await getRedisClient()!.sCard(`collab:active:${pageId}`))).toBeGreaterThan(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('remote unchanged → updatePage first with current local version, then local row from confPage.version.number', async () => {
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({ version: 4 });
    const order: string[] = [];
    vi.spyOn(ConfluenceClient.prototype, 'getPage').mockImplementation(async () => {
      order.push('getPage');
      return {
        id: confluenceId,
        title: 'Conf page',
        status: 'current',
        type: 'page',
        version: { number: 4, when: '2026-08-24T00:00:00Z' },
      } as never;
    });
    const updatePage = vi.spyOn(ConfluenceClient.prototype, 'updatePage').mockImplementation(async (_id, title, storage) => {
      order.push('updatePage');
      const still = await query<{ version: number; last_synced: Date | null }>(
        'SELECT version, last_synced FROM pages WHERE id = $1',
        [pageId],
      );
      expect(still.rows[0]!.version).toBe(4);
      return {
        id: confluenceId,
        title,
        status: 'current',
        type: 'page',
        version: { number: 5, when: '2026-08-24T00:01:00Z' },
        body: { storage: { value: storage } },
      } as never;
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/collab/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: commitPayload(ws, 'Pushed'),
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: pageId,
      title: 'Pushed',
      version: 5,
      source: 'confluence',
      pushedToConfluence: true,
    });
    expect(updatePage).toHaveBeenCalledTimes(1);
    expect(updatePage.mock.calls[0]![0]).toBe(confluenceId);
    expect(updatePage.mock.calls[0]![1]).toBe('Pushed');
    expect(updatePage.mock.calls[0]![3]).toBe(4);
    expect(order.indexOf('updatePage')).toBeGreaterThanOrEqual(0);

    const page = await query<{
      version: number;
      title: string;
      body_storage: string | null;
      last_synced: Date | null;
      local_modified_at: Date | null;
      summary_status: string;
      quality_status: string;
    }>(
      `SELECT version, title, body_storage, last_synced, local_modified_at, summary_status, quality_status
         FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(page.rows[0]!.version).toBe(5);
    expect(page.rows[0]!.title).toBe('Pushed');
    expect(page.rows[0]!.body_storage).toBe('<p>commit-seed</p>');
    expect(page.rows[0]!.last_synced).not.toBeNull();
    expect(page.rows[0]!.local_modified_at).toBeNull();
    expect(page.rows[0]!.summary_status).toBe('pending');
    expect(page.rows[0]!.quality_status).toBe('pending');
    expect(Number(await getRedisClient()!.sCard(`collab:active:${pageId}`))).toBeGreaterThan(0);
    ws.close();
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
  async function saveWhileAutosaveLands(change: 'none' | 'lifecycle' | 'remote') {
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({ version: 4 });
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

  it.each(['lifecycle', 'remote'] as const)(
    'a %s change in the same autosave window still refuses before any intent (#1762)',
    async (change) => {
      const { res, pageId, ws, doc, updatePage, before, during } = await saveWhileAutosaveLands(change);
      try {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject(change === 'lifecycle'
          ? { reason: 'stale_lifecycle' }
          : { code: 'confluence_modified', remoteVersion: 7, localVersion: 4 });
        expect(during).toBeGreaterThan(before);
        expect(updatePage).not.toHaveBeenCalled();
        expect(await commitIntents(pageId)).toEqual([]);
        const page = await query<{ version: number }>('SELECT version FROM pages WHERE id = $1', [pageId]);
        expect(page.rows[0]!.version).toBe(4);
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

  it('Confluence 5xx → local version unchanged, room live', async () => {
    const { token, pageId, confluenceId, ws } = await seedLiveConfluencePage({ version: 4 });
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
    expect(Number(await getRedisClient()!.sCard(`collab:active:${pageId}`))).toBeGreaterThan(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
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
        expect(getDefaultCollabRuntime()?.getRoom(pageId)).toBeUndefined();
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
          expect(podA.getRoom(pageId)).toBeUndefined();
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
