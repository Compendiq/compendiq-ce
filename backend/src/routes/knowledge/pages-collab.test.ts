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
import { generateAccessToken } from '../../core/plugins/auth.js';
import { logger } from '../../core/utils/logger.js';
import { COLLAB_WS_PROTOCOL, type CollabCommit } from '@compendiq/contracts';
import { isCollabEditingEnabled, refreshCollabFlag } from '../../core/services/collab-flag.js';
import { assertNoLiveCollabRoom } from '../../core/services/collab-guard.js';
import { tombstoneCollabRoomAfterCommit } from '../../core/services/collab-tombstone.js';
import {
  _resetCollabRoomsForTest,
  createCollabRuntime,
  getDefaultCollabRuntime,
  COLLAB_ACTIVE_TTL_SEC,
  COLLAB_PING_INTERVAL_MS,
} from '../../core/services/collab-room-service.js';
import { getRedisClient } from '../../core/services/redis-cache.js';
import * as persist from '../../core/services/collab-persistence.js';
import { yDocToHtml } from '../../core/services/collab-schema.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { ConfluenceClient, ConfluenceError } from '../../domains/confluence/services/confluence-client.js';
import { withPageWriteTransaction } from '../../core/services/page-write-admission.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await isRedisAvailable() : false;
const canRun = dbAvailable && redisAvailable;

const MESSAGE_SYNC = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;
const MESSAGE_AWARENESS = 1;

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
    .setProtectedHeader({ alg: 'HS256' })
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

  it('ACL denial after 101 is 4403 (userCanAccessPage false)', async () => {
    const owner = await createUser('collab_acl_owner');
    const stranger = await createUser('collab_acl_stranger');
    const pageId = await insertStandalone({ ownerId: owner.userId, visibility: 'private' });
    await enableCollabFlag();

    const ws = openWhatwg(pageId, stranger.token);
    const closed = await waitClose(ws);
    expect(closed.opened).toBe(true);
    expect(closed.code).toBe(4403);
  });

  it('flag off → 4403 after 101', async () => {
    const { token, userId } = await createUser('collab_flag_off');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });

    const ws = openWhatwg(pageId, token);
    const closed = await waitClose(ws);
    expect(closed.opened).toBe(true);
    expect(closed.code).toBe(4403);
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

  it('pending frames are capped in the WS join handler', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('./pages-collab.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/pending\.length\s*>=\s*2/);
    expect(src).toMatch(/pending\.length = 0/);
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
});


