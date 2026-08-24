/**
 * Integration tests for GET /api/collab/:pageId (#1444).
 *
 * Real Postgres (:5433) + real Redis. Mock only outbound HTTP/DNS.
 * A WHATWG-shaped client (globalThis.WebSocket, protocols array, no
 * `unexpected-response`) MUST recover from an expired JWT: 101 then 4401,
 * refresh, second connection syncs. This file fails if the server 401s the
 * handshake (`onRequest authenticate` throw → close 1006).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import * as jose from 'jose';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
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
import { COLLAB_WS_PROTOCOL } from '@compendiq/contracts';
import { isCollabEditingEnabled, refreshCollabFlag } from '../../core/services/collab-flag.js';
import { assertNoLiveCollabRoom } from '../../core/services/collab-guard.js';
import { tombstoneCollabRoomAfterCommit } from '../../core/services/collab-tombstone.js';
import { _resetCollabRoomsForTest } from '../../core/services/collab-room-service.js';
import { getRedisClient } from '../../core/services/redis-cache.js';
import { ConfluenceError } from '../../domains/confluence/services/confluence-client.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await isRedisAvailable() : false;
const canRun = dbAvailable && redisAvailable;

const MESSAGE_SYNC = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;
const MESSAGE_AWARENESS = 1;

let app: FastifyInstance;
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
}): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (
        space_key, title, body_storage, body_html, body_text, version, source, visibility,
        created_by_user_id, page_type, deleted_at
     ) VALUES ('_standalone', $1, '<p></p>', '<p></p>', '', 1, 'standalone', $2, $3, $4, $5)
     RETURNING id`,
    [
      opts.title ?? 'Collab page',
      opts.visibility ?? 'shared',
      opts.ownerId,
      opts.pageType ?? 'page',
      opts.deleted ? new Date() : null,
    ],
  );
  return r.rows[0]!.id;
}

async function insertConfluencePage(opts: {
  spaceKey: string;
  confluenceId: string;
  inheritPerms?: boolean;
}): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (
        confluence_id, space_key, title, body_storage, body_html, body_text,
        version, source, visibility, last_synced, inherit_perms
     ) VALUES ($1, $2, 'Conf page', '<p></p>', '<p></p>', '', 1, 'confluence', 'shared', NOW(), $3)
     RETURNING id`,
    [opts.confluenceId, opts.spaceKey, opts.inheritPerms ?? true],
  );
  return r.rows[0]!.id;
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
  const ws = openWhatwg(pageId, token);
  await waitOpen(ws);
  const doc = new Y.Doc();
  ws.send(encodeSyncStep1(doc));
  const reply = await waitMessage(ws);
  expect(reply[0]).toBe(MESSAGE_SYNC);
  expect(reply[1]).toBe(SYNC_STEP2);
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

function waitMessage(ws: WebSocket, timeoutMs = 8_000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for websocket message')), timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        resolve(new Uint8Array(data));
        return;
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        void data.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
        return;
      }
      if (typeof data === 'string') {
        resolve(new TextEncoder().encode(data));
        return;
      }
      reject(new Error(`unexpected message type ${typeof data}`));
    };
    ws.addEventListener('message', onMsg);
  });
}

function openWhatwg(pageId: number, token: string, extraQuery = ''): WebSocket {
  const url = `${baseWs}/api/collab/${pageId}${extraQuery}`;
  const ws = new WebSocket(url, [COLLAB_WS_PROTOCOL, token]);
  ws.binaryType = 'arraybuffer';
  return ws;
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
    second.send(encodeSyncStep1(doc));
    const reply = await waitMessage(second);
    expect(reply[0]).toBe(MESSAGE_SYNC);
    expect(reply[1]).toBe(SYNC_STEP2);
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
    ws.send(encodeSyncStep1(doc));
    const reply = await new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('auth header ws message timeout')), 8_000);
      ws.once('message', (data) => {
        clearTimeout(t);
        resolve(data instanceof Uint8Array ? data : new Uint8Array(data as Buffer));
      });
    });
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

    const ws = openWhatwg(pageId, viewer.token);
    await waitOpen(ws);

    const doc = new Y.Doc();
    ws.send(encodeSyncStep1(doc));
    const step2 = await waitMessage(ws);
    expect(step2[0]).toBe(MESSAGE_SYNC);
    expect(step2[1]).toBe(SYNC_STEP2);

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
    const client = {
      async getAllPageIds() { return new Set<string>(); },
      async getPage() { throw new ConfluenceError('Resource not found', 404); },
    };
    await __internal.detectDeletedPages(client as never, spaceKey, {
      pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0,
    });

    const closed = await closedP;
    expect(closed.code).toBe(4404);
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
    ws.send(encodeSyncStep1(doc));
    const reply = await waitMessage(ws);
    expect(reply[0]).toBe(MESSAGE_SYNC);

    const closedP = waitClose(ws);
    await tombstoneCollabRoomAfterCommit(pageId);
    const closed = await closedP;
    expect(closed.code).toBe(4404);
  });
});

describe.skipIf(!canRun)('collab:active TTL / idle 409 (#1444)', () => {
  it('31 s idle still 409s assertNoLiveCollabRoom (ping 15s / TTL 45s)', async () => {
    const { token, userId } = await createUser('collab_idle');
    const pageId = await insertStandalone({ ownerId: userId, visibility: 'shared' });
    await enableCollabFlag();

    const ws = openWhatwg(pageId, token);
    await waitOpen(ws);

    await new Promise((r) => setTimeout(r, 31_000));

    await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'collab_session_active',
    });
    const ttl = await getRedisClient()!.ttl(`collab:active:${pageId}`);
    expect(ttl).toBeGreaterThan(20);
    ws.close();
  }, 45_000);
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
  });
});

function pageIdEntropy(): string {
  return Math.random().toString(36).slice(2, 10);
}
