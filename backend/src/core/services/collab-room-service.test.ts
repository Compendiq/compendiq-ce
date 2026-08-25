/**
 * Redis fan-out + live-room guard for the collab gateway (#1444).
 *
 * Real Redis via test-redis-helper.ts. Two isolated runtimes stand in for
 * two pods: a delayed second subscriber must still converge, and applying
 * with origin `'redis'` must not republish.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import { isRedisAvailable } from '../../test-redis-helper.js';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
  createCollabRuntime,
  COLLAB_ACTIVE_TTL_SEC,
  COLLAB_EMPTY_ROOM_GRACE_MS,
  type CollabRuntime,
} from './collab-room-service.js';
import { assertNoLiveCollabRoom } from './collab-guard.js';
import { COLLAB_INIT_LOCK_KEY } from '../db/advisory-locks.js';
import { setRedisClient } from './redis-cache.js';
import * as persist from './collab-persistence.js';
import { yDocToHtml } from './collab-schema.js';

const redisAvailable = await isRedisAvailable();

let main: RedisClientType | null = null;
let runtimeA: CollabRuntime | null = null;
let runtimeB: CollabRuntime | null = null;
const usedPageIds: number[] = [];

function nextPageId(): number {
  const id = 1_411_000 + Math.floor(Math.random() * 1_000_000);
  usedPageIds.push(id);
  return id;
}

function stubWs(onClose?: (code: number, reason: string) => void): WebSocket {
  return {
    readyState: 1,
    send() {},
    close(code?: number, reason?: string) {
      onClose?.(code ?? 1005, String(reason ?? ''));
    },
  } as unknown as WebSocket;
}

function encodeAwarenessFrame(state: Record<string, unknown>): { frame: Uint8Array; clientID: number } {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(state);
  const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint8Array(encoder, update);
  const frame = encoding.toUint8Array(encoder);
  const clientID = doc.clientID;
  awareness.destroy();
  doc.destroy();
  return { frame, clientID };
}

async function cleanupKeys(): Promise<void> {
  if (!main) return;
  if (usedPageIds.length === 0) return;
  await main.del(usedPageIds.flatMap((id) => [`collab:active:${id}`, `collab:doc:${id}`]));
}

beforeAll(async () => {
  if (!redisAvailable) return;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  main = createClient({ url }) as RedisClientType;
  main.on('error', () => { /* assertions surface failures */ });
  await main.connect();
  setRedisClient(main);
}, 15_000);

afterAll(async () => {
  if (!redisAvailable) return;
  if (runtimeA) await runtimeA.close();
  if (runtimeB) await runtimeB.close();
  if (main) {
    await cleanupKeys();
    await main.quit();
  }
});

beforeEach(async () => {
  if (!redisAvailable || !main) return;
  if (runtimeA) await runtimeA.close();
  if (runtimeB) await runtimeB.close();
  await cleanupKeys();
  runtimeA = await createCollabRuntime(main, 'pod-a');
  runtimeB = await createCollabRuntime(main, 'pod-b');
});

describe.skipIf(!redisAvailable)('collab-room-service Redis fan-out (#1444)', () => {
  it('uses the two-key advisory lock constant 1_411_001', () => {
    expect(COLLAB_INIT_LOCK_KEY).toBe(1_411_001);
    expect(COLLAB_INIT_LOCK_KEY).not.toBe(891_001);
    expect(COLLAB_INIT_LOCK_KEY).not.toBe(745_001);
  });

  it('fans an incremental update to a delayed second subscriber via state_dump', async () => {
    const pageId = nextPageId();
    const roomA = await runtimeA!.getOrCreateRoom(pageId);
    roomA.doc.getText('t').insert(0, 'typed-before-b-joined');

    await new Promise((r) => setTimeout(r, 1_000));

    const roomB = await runtimeB!.getOrCreateRoom(pageId);
    await vi.waitFor(() => {
      expect(roomB.doc.getText('t').toString()).toContain('typed-before-b-joined');
    }, { timeout: 4_000 });
  });

  it('does not republish when origin === redis (no loop)', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    const publishSpy = vi.spyOn(main, 'publish');

    const roomA = await runtimeA!.getOrCreateRoom(pageId);
    await runtimeB!.getOrCreateRoom(pageId);

    publishSpy.mockClear();
    roomA.doc.getText('t').insert(0, 'loop-probe');

    await vi.waitFor(() => {
      expect(runtimeB!.getRoom(pageId)?.doc.getText('t').toString()).toContain('loop-probe');
    }, { timeout: 4_000 });

    const syncFromB = publishSpy.mock.calls.filter(([channel, payload]) => {
      if (channel !== `collab:doc:${pageId}`) return false;
      try {
        const msg = JSON.parse(String(payload)) as { origin?: string; kind?: string };
        return msg.origin === runtimeB!.podId && msg.kind === 'sync';
      } catch {
        return false;
      }
    });
    expect(syncFromB).toHaveLength(0);
  });

  it('assertNoLiveCollabRoom 409s while a member is in collab:active', async () => {
    const pageId = nextPageId();
    await runtimeA!.getOrCreateRoom(pageId);

    await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'collab_session_active',
    });

    const ttl = await main!.ttl(`collab:active:${pageId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(COLLAB_ACTIVE_TTL_SEC);
  });

  it('holds collab:active through empty-room grace so PUT still 409s', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    const connId = 'last-editor';
    await runtimeA!.attachSocket(pageId, {
      id: connId,
      ws: stubWs(),
      userId: 'user-a',
      writable: true,
    });

    await runtimeA!.detachSocket(pageId, connId);

    await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'collab_session_active',
    });
    const membersDuringGrace = await main.sMembers(`collab:active:${pageId}`);
    expect(
      membersDuringGrace.some(
        (m) => m === `${runtimeA!.podId}:${connId}` || m === `${runtimeA!.podId}:grace`,
      ),
      'last member (or a grace sentinel) must stay in the SET until the Y.Doc is dropped',
    ).toBe(true);
    expect(runtimeA!.getRoom(pageId)?.doc).toBeDefined();

    await new Promise((r) => setTimeout(r, COLLAB_EMPTY_ROOM_GRACE_MS + 250));

    await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    expect(runtimeA!.getRoom(pageId)).toBeUndefined();
  }, 15_000);

  it('reconnect during empty-room grace keeps collab:active (still 409)', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'first',
      ws: stubWs(),
      userId: 'user-a',
      writable: true,
    });
    await runtimeA!.detachSocket(pageId, 'first');

    await runtimeA!.attachSocket(pageId, {
      id: 'reconnect',
      ws: stubWs(),
      userId: 'user-a',
      writable: true,
    });

    await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'collab_session_active',
    });
    const members = await main.sMembers(`collab:active:${pageId}`);
    expect(members).toContain(`${runtimeA!.podId}:reconnect`);
    expect(runtimeA!.getRoom(pageId)?.emptyGrace).toBeNull();
  });

  it('dropRoom SREMs only this pod — peer members stay and PUT still 409s', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'a1', ws: stubWs(), userId: 'user-a', writable: true,
    });
    await runtimeB!.attachSocket(pageId, {
      id: 'b1', ws: stubWs(), userId: 'user-b', writable: true,
    });

    await runtimeA!.detachSocket(pageId, 'a1');
    await new Promise((r) => setTimeout(r, COLLAB_EMPTY_ROOM_GRACE_MS + 250));

    const members = await main.sMembers(`collab:active:${pageId}`);
    expect(members.some((m) => m.startsWith(`${runtimeB!.podId}:`))).toBe(true);
    expect(members.some((m) => m.startsWith(`${runtimeA!.podId}:`))).toBe(false);
    await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'collab_session_active',
    });
    expect(runtimeB!.getRoom(pageId)?.doc).toBeDefined();
  }, 15_000);

  it('double-detach plus reconnect during grace does not destroy the live Y.Doc', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'last', ws: stubWs(), userId: 'user-a', writable: true,
    });
    await runtimeA!.detachSocket(pageId, 'last');
    await runtimeA!.detachSocket(pageId, 'last');

    await runtimeA!.attachSocket(pageId, {
      id: 'reconnect', ws: stubWs(), userId: 'user-a', writable: true,
    });
    const doc = runtimeA!.getRoom(pageId)?.doc;
    expect(doc).toBeDefined();
    doc!.getText('t').insert(0, 'still-here');

    await new Promise((r) => setTimeout(r, COLLAB_EMPTY_ROOM_GRACE_MS + 250));

    const live = runtimeA!.getRoom(pageId);
    expect(live?.doc).toBe(doc);
    expect(live?.doc.getText('t').toString()).toBe('still-here');
    expect(live?.sockets.has('reconnect')).toBe(true);
    await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'collab_session_active',
    });
  }, 15_000);

  it('bus tombstone carries 4403 on flag-off so peer sockets do not close 4404', async () => {
    const pageId = nextPageId();
    const codes: number[] = [];
    await runtimeB!.attachSocket(pageId, {
      id: 'b1',
      ws: stubWs((code) => { codes.push(code); }),
      userId: 'user-b',
      writable: true,
    });

    await runtimeA!.tombstone(pageId, 4403, 'flag_off');

    await vi.waitFor(() => {
      expect(codes).toContain(4403);
    }, { timeout: 2_000 });
    expect(codes).not.toContain(4404);
  });

  it('stamps awareness identity so a client-claimed name is not what peers see', async () => {
    const pageId = nextPageId();
    const identity = { id: 'user-a', name: 'Alice', color: 'hsl(10 50% 40%)' };
    await runtimeA!.attachSocket(pageId, {
      id: 'editor',
      ws: stubWs(),
      userId: 'user-a',
      writable: true,
      identity,
    });

    const { frame: spoofed, clientID: senderId } = encodeAwarenessFrame({
      user: { id: 'user-a', name: 'Definitely Not Alice', color: '#fff' },
    });
    expect(runtimeA!.handleInboundFrame(pageId, 'editor', spoofed)).toBe('ok');

    const room = runtimeA!.getRoom(pageId);
    expect(room).toBeDefined();
    const ids = [...room!.awareness.getStates().keys()];
    expect(ids, 'stamping must not inject a throwaway Awareness clientID').toEqual([senderId]);

    const names = [...room!.awareness.getStates().values()]
      .map((s) => (s as { user?: { name?: string } }).user?.name)
      .filter((n): n is string => typeof n === 'string');
    expect(names).toContain('Alice');
    expect(names).not.toContain('Definitely Not Alice');
  });

  it('does not swallow loadOrInit failure: no collab:active member, attach throws', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    const spy = vi.spyOn(persist, 'loadOrInitCollabDoc').mockRejectedValue(new Error('forced load failure'));
    try {
      await expect(runtimeA!.attachSocket(pageId, {
        id: 'boom',
        ws: stubWs(),
        userId: 'user-a',
        writable: true,
      })).rejects.toThrow(/forced load failure/);
      expect(runtimeA!.getRoom(pageId)).toBeUndefined();
      const members = await main.sMembers(`collab:active:${pageId}`);
      expect(members).toEqual([]);
      await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('flushCollabPersist runs before doc.destroy on close', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'ed', ws: stubWs(), userId: 'user-a', writable: true,
    });
    const flush = vi.spyOn(persist, 'flushCollabPersist');
    const room = runtimeA!.getRoom(pageId)!;
    const destroy = vi.spyOn(room.doc, 'destroy');
    await runtimeA!.close();
    expect(flush).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    expect(flush.mock.invocationCallOrder[0]!).toBeLessThan(destroy.mock.invocationCallOrder[0]!);
    flush.mockRestore();
    destroy.mockRestore();
    runtimeA = await createCollabRuntime(main!, 'pod-a');
  });

  it('resetFromHtml on A: BYTEA is inbound HTML; B does not flush the typed paragraph over it (#1448)', async () => {
    const pageId = nextPageId();
    const byteaHtml: string[] = [];
    const replaceSpy = vi.spyOn(persist, 'replaceCollabDocFromHtml').mockImplementation(async (_id, html) => {
      byteaHtml.push(html);
    });
    const flushSpy = vi.spyOn(persist, 'flushCollabPersist').mockImplementation(async (room) => {
      if (room.persistable === false) return;
      byteaHtml.push(yDocToHtml(room.doc));
    });

    try {
      await runtimeA!.attachSocket(pageId, {
        id: 'a1', ws: stubWs(), userId: 'user-a', writable: true,
      });
      await runtimeB!.attachSocket(pageId, {
        id: 'b1', ws: stubWs(), userId: 'user-b', writable: true,
      });
      const roomA = runtimeA!.getRoom(pageId)!;
      const roomB = runtimeB!.getRoom(pageId)!;
      roomA.persistable = true;
      roomB.persistable = true;

      roomB.doc.transact(() => {
        const fragment = roomB.doc.getXmlFragment('default');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'COLLAB_TYPED_PARAGRAPH');
        p.insert(0, [t]);
        fragment.push([p]);
      });
      expect(yDocToHtml(roomB.doc)).toContain('COLLAB_TYPED_PARAGRAPH');

      await runtimeA!.resetFromHtml(pageId, '<p>REMOTE_WINS</p>');

      await vi.waitFor(() => {
        expect(runtimeB!.getRoom(pageId)).toBeUndefined();
      }, { timeout: 2_000 });

      expect(byteaHtml.some((h) => h.includes('REMOTE_WINS'))).toBe(true);
      const last = byteaHtml[byteaHtml.length - 1] ?? '';
      expect(last).toContain('REMOTE_WINS');
      expect(last).not.toContain('COLLAB_TYPED_PARAGRAPH');
    } finally {
      replaceSpy.mockRestore();
      flushSpy.mockRestore();
    }
  });
});
