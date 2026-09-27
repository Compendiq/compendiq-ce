/**
 * Redis fan-out + live-room guard for the collab gateway (#1444).
 *
 * Real Redis via test-redis-helper.ts. Two isolated runtimes stand in for
 * two pods: a delayed second subscriber must still converge, and applying
 * with origin `'redis'` must not republish.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient, type RedisClientType } from 'redis';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { COLLAB_INIT_LOCK_KEY, PAGE_LIFECYCLE_LOCK_KEY } from '../db/advisory-locks.js';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import {
  createCollabRuntime,
  collabDocChannel,
  COLLAB_ACTIVE_TTL_SEC,
  COLLAB_EMPTY_ROOM_GRACE_MS,
  COLLAB_READONLY_DROP_LIMIT,
  type CollabRuntime,
  type CollabInboundResult,
} from './collab-room-service.js';
import { assertNoLiveCollabRoom } from './collab-guard.js';
import { setRedisClient } from './redis-cache.js';
import * as persist from './collab-persistence.js';
import { admitPageRuntime, releasePageRuntime, withPageWriteTransaction } from './page-write-admission.js';
import { yDocToHtml } from './collab-schema.js';
import type * as PageBaselineServiceModule from './page-baseline-service.js';
import type * as PageBaselineGovernanceModule from './page-baseline-governance.js';

const redisAvailable = await isRedisAvailable();
const dbAvailable = await isDbAvailable();
const canRun = redisAvailable && dbAvailable;
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const SYSTEM_ADMIN = '33333333-3333-4333-8333-333333333333';

let main: RedisClientType | null = null;
let runtimeA: CollabRuntime | null = null;
let runtimeB: CollabRuntime | null = null;
const usedPageIds: number[] = [];
let availablePageIds: number[] = [];
let attachmentsDir: string | null = null;
let freezePage: typeof PageBaselineServiceModule.freezePage;
let unfreezePage: typeof PageBaselineServiceModule.unfreezePage;
let previewPageBaseline: typeof PageBaselineServiceModule.previewPageBaseline;
let setPageBaselineCreationEnabled: typeof PageBaselineServiceModule.setPageBaselineCreationEnabled;
let resetPageBaselineGovernanceForTests:
  typeof PageBaselineGovernanceModule._resetPageBaselineGovernanceForTests;

function nextPageId(): number {
  const id = availablePageIds.shift();
  if (!id) throw new Error('test page pool exhausted');
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

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

function encodeRejectedSyncSubtype(subtype: 1 | 2): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, subtype);
  return encoding.toUint8Array(encoder);
}

function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function decodeControlFrames(frames: Uint8Array[]): Array<Record<string, unknown>> {
  const controls: Array<Record<string, unknown>> = [];
  for (const frame of frames) {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== 4) continue;
    controls.push(JSON.parse(
      decoding.readVarString(decoder),
    ) as Record<string, unknown>);
  }
  return controls;
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

async function observeSnapshotRequests(pageId: number, origin: string) {
  const subscriber = main!.duplicate() as RedisClientType;
  const requests: Array<{ id: string; owners: string[] }> = [];
  subscriber.on('error', () => { /* the waiting assertion reports transport failure */ });
  await subscriber.connect();
  await subscriber.subscribe(collabDocChannel(pageId), (raw) => {
    const message: unknown = JSON.parse(raw);
    if (!message || typeof message !== 'object'
      || !('kind' in message) || message.kind !== 'state_dump_request'
      || !('origin' in message) || message.origin !== origin
      || !('requestId' in message) || typeof message.requestId !== 'string'
      || !('requestedAdmissions' in message) || !Array.isArray(message.requestedAdmissions)) return;
    const owners = message.requestedAdmissions;
    if (!owners.every((id): id is string => typeof id === 'string')) return;
    requests.push({ id: message.requestId, owners });
  });
  return { subscriber, requests };
}

async function namedSubscriberId(name: string): Promise<string | undefined> {
  const clients = await main!.sendCommand(['CLIENT', 'LIST', 'TYPE', 'PUBSUB']);
  if (typeof clients !== 'string') throw new Error('Redis did not return its client inventory');
  const subscriber = clients.split('\n').find((line) =>
    line.includes(`name=${name} `) && line.includes('psub=1 '));
  return subscriber?.match(/(?:^| )id=(\d+)/)?.[1];
}

async function cleanupKeys(): Promise<void> {
  if (!main) return;
  if (usedPageIds.length === 0) return;
  await main.del(usedPageIds.flatMap((id) => [`collab:active:${id}`, collabDocChannel(id)]));
}

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  main = createClient({ url }) as RedisClientType;
  attachmentsDir = await mkdtemp(join(tmpdir(), 'collab-freeze-'));
  vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
  const [baselineService, baselineGovernance] = await Promise.all([
    import('./page-baseline-service.js'),
    import('./page-baseline-governance.js'),
  ]);
  freezePage = baselineService.freezePage;
  unfreezePage = baselineService.unfreezePage;
  previewPageBaseline = baselineService.previewPageBaseline;
  setPageBaselineCreationEnabled = baselineService.setPageBaselineCreationEnabled;
  resetPageBaselineGovernanceForTests =
    baselineGovernance._resetPageBaselineGovernanceForTests;
  baselineGovernance.registerPageBaselineEnforcementReadiness();
  main.on('error', () => { /* assertions surface failures */ });
  await main.connect();
  setRedisClient(main);
}, 15_000);

afterAll(async () => {
  if (!canRun) return;
  if (runtimeA) await runtimeA.close();
  if (runtimeB) await runtimeB.close();
  if (main) {
    await cleanupKeys();
    await main.quit();
  }
  resetPageBaselineGovernanceForTests();
  if (attachmentsDir) await rm(attachmentsDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun || !main) return;
  if (runtimeA) await runtimeA.close();
  if (runtimeB) await runtimeB.close();
  await cleanupKeys();
  usedPageIds.length = 0;
  await truncateAllTables();
  await withPageWriteTransaction([], async () => undefined);
  await query(
    `INSERT INTO users (id, username, email, password_hash, role)
     VALUES ($1, 'collab-a', 'collab-a@test', 'x', 'user'),
            ($2, 'collab-b', 'collab-b@test', 'x', 'user'),
            ($3, 'collab-admin', 'collab-admin@test', 'x', 'admin')`,
    [USER_A, USER_B, SYSTEM_ADMIN],
  );
  await query(
    `INSERT INTO user_settings (user_id, confluence_enabled)
     VALUES ($1, FALSE), ($2, FALSE)`,
    [USER_A, SYSTEM_ADMIN],
  );
  const pages = await query<{ id: number }>(
    `INSERT INTO pages (title, body_html, body_text, source, visibility, created_by_user_id)
     SELECT 'Collab ' || n, '<p>seed</p>', 'seed', 'standalone', 'shared', $1
       FROM generate_series(1, 64) AS n
     RETURNING id`,
    [USER_A],
  );
  availablePageIds = pages.rows.map((row) => row.id);
  runtimeA = await createCollabRuntime(main, 'pod-a');
  runtimeB = await createCollabRuntime(main, 'pod-b');
});

describe.skipIf(!canRun)('collab-room-service Redis fan-out (#1444)', () => {

  it('acknowledges only a durable writable admission at its exact lifecycle revision', async () => {
    const pageId = nextPageId();
    const state = await query<{ lifecycle_revision: string }>(
      'SELECT lifecycle_revision::text FROM pages WHERE id = $1',
      [pageId],
    );
    const sent: Uint8Array[] = [];
    const joined = await runtimeA!.attachSocket(pageId, {
      id: 'admitted-editor',
      ws: {
        readyState: 1,
        send(frame: Uint8Array) { sent.push(frame); },
        close() {},
      } as unknown as WebSocket,
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: state.rows[0]!.lifecycle_revision,
    });

    expect(joined.writable).toBe(true);
    expect(decodeControlFrames(sent)).toContainEqual({
      type: 'writable_admission',
      lifecycleRevision: state.rows[0]!.lifecycle_revision,
    });
  });

  it('sends explicit permission loss instead of admission to an initial read-only viewer', async () => {
    const pageId = nextPageId();
    await query("UPDATE pages SET visibility = 'private' WHERE id = $1", [pageId]);
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [USER_B]);
    const sent: Uint8Array[] = [];
    const joined = await runtimeA!.attachSocket(pageId, {
      id: 'readonly-viewer',
      ws: {
        readyState: 1,
        send(frame: Uint8Array) { sent.push(frame); },
        close() {},
      } as unknown as WebSocket,
      userId: USER_B,
      writable: false,
      expectedLifecycleRevision: null,
    });

    expect(joined.writable).toBe(false);
    expect(decodeControlFrames(sent)).toContainEqual({
      type: 'permission_loss',
      reason: 'edit_permission_revoked',
    });
    expect(decodeControlFrames(sent).some((control) =>
      control.type === 'writable_admission')).toBe(false);
  });

  it('requires a fresh round from every durable owner even after a successful cached snapshot', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'snapshot-a', ws: stubWs(), userId: USER_A, writable: true,
    });
    await runtimeB!.attachSocket(pageId, {
      id: 'snapshot-b', ws: stubWs(), userId: USER_B, writable: true,
    });
    const observed = await observeSnapshotRequests(pageId, runtimeA!.podId);
    const first = await runtimeA!.prepareCommitSnapshot(pageId, USER_A, '0');
    await releasePageRuntime(first.admission);
    const previousRequest = observed.requests.at(-1)!;
    const unavailableOwner = await admitPageRuntime(pageId, USER_B, 'collab_room');
    const staleDoc = new Y.Doc();
    Y.applyUpdate(staleDoc, Y.encodeStateAsUpdate(runtimeB!.getRoom(pageId)!.doc));
    appendParagraph(staleDoc, 'UNRELATED_ROUND_MUST_NOT_APPLY');
    try {
      await main!.del(`collab:active:${pageId}`);
      const requestCount = observed.requests.length;
      const pending = runtimeA!.prepareCommitSnapshot(pageId, USER_A, '0').then(
        async (snapshot) => {
          await releasePageRuntime(snapshot.admission);
          return null;
        },
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(observed.requests.length).toBeGreaterThan(requestCount));
      const currentRequest = observed.requests.at(-1)!;
      expect(currentRequest.id).not.toBe(previousRequest.id);
      expect(currentRequest.owners).toContain(unavailableOwner.id);
      await main!.publish(collabDocChannel(pageId), JSON.stringify({
        origin: 'unavailable-owner', kind: 'state_dump',
        requestId: previousRequest.id,
        lifecycleRevision: unavailableOwner.lifecycleRevision,
        admission: unavailableOwner,
        update: Buffer.from(Y.encodeStateAsUpdate(staleDoc)).toString('base64'),
      }));
      expect(await pending).toMatchObject({ reason: 'collab_state_unavailable' });
    } finally {
      await releasePageRuntime(unavailableOwner);
      staleDoc.destroy();
      await observed.subscriber.quit();
    }
    const recovered = await runtimeA!.prepareCommitSnapshot(pageId, USER_A, '0');
    try {
      expect(recovered.html).not.toContain('UNRELATED_ROUND_MUST_NOT_APPLY');
    } finally {
      await releasePageRuntime(recovered.admission);
    }
  });

  it('refuses a snapshot when the authoritative owner set changes during its peer round', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'membership-a', ws: stubWs(), userId: USER_A, writable: true,
    });
    const respondingOwner = await admitPageRuntime(pageId, USER_B, 'collab_room');
    const observed = await observeSnapshotRequests(pageId, runtimeA!.podId);
    try {
      const pending = runtimeA!.prepareCommitSnapshot(pageId, USER_A, '0').then(
        async (snapshot) => {
          await releasePageRuntime(snapshot.admission);
          return null;
        },
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(observed.requests).toHaveLength(1));
      const joiningOwner = await admitPageRuntime(pageId, USER_B, 'collab_room');
      try {
        await main!.publish(collabDocChannel(pageId), JSON.stringify({
          origin: 'responding-owner', kind: 'state_dump',
          requestId: observed.requests[0]!.id,
          lifecycleRevision: respondingOwner.lifecycleRevision,
          admission: respondingOwner,
          update: Buffer.from(Y.encodeStateAsUpdate(runtimeA!.getRoom(pageId)!.doc)).toString('base64'),
        }));
        expect(await pending).toMatchObject({ reason: 'collab_state_unavailable' });
      } finally {
        await releasePageRuntime(joiningOwner);
      }
    } finally {
      await releasePageRuntime(respondingOwner);
      await observed.subscriber.quit();
    }
  });

  it('does not guess the purpose of a historical active admission', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'legacy-owner', ws: stubWs(), userId: USER_A, writable: true,
    });
    const admission = runtimeA!.getRoom(pageId)!.admission!;
    await query("UPDATE page_runtime_admissions SET purpose = 'legacy' WHERE id = $1", [admission.id]);
    try {
      await expect(runtimeA!.prepareCommitSnapshot(pageId, USER_A, '0').then(async (snapshot) => {
        await releasePageRuntime(snapshot.admission);
        return snapshot;
      })).rejects.toMatchObject({ reason: 'collab_state_unavailable' });
    } finally {
      await query("UPDATE page_runtime_admissions SET purpose = 'collab_room' WHERE id = $1", [admission.id]);
    }
  });

  it('rehydrates a cached room before writable reuse after a real Redis subscriber reconnect', async () => {
    const pageId = nextPageId();
    await runtimeB!.attachSocket(pageId, {
      id: 'connected-peer', ws: stubWs(), userId: USER_B, writable: true,
    });
    const name = `collab-reconnect-${process.pid}-${pageId}-${Date.now()}`;
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    redisUrl.username = name;
    redisUrl.password = `${name}-disposable`;
    const isolatedMain = createClient({
      url: redisUrl.toString(),
      name,
      socket: { reconnectStrategy: () => 2_000 },
    }) as RedisClientType;
    isolatedMain.on('error', () => { /* intentional server-side connection termination */ });
    let ownedRuntime: CollabRuntime | undefined;
    const peerDraft = new Y.Doc();
    const rejoinedDoc = new Y.Doc();
    try {
      await main!.sendCommand([
        'ACL', 'SETUSER', name, 'reset', 'on', `>${redisUrl.password}`, '~*', '&*', '+@all',
      ]);
      await isolatedMain.connect();
      const isolatedRuntime = await createCollabRuntime(isolatedMain, name);
      ownedRuntime = isolatedRuntime;
      const closed: string[] = [];
      await isolatedRuntime.attachSocket(pageId, {
        id: 'before-reconnect',
        ws: stubWs((_code, reason) => { closed.push(reason); }),
        userId: USER_A, writable: true,
      });
      const subscriberId = await namedSubscriberId(name);
      expect(subscriberId).toBeDefined();
      // Deny only this disposable user's new connections. Killing a healthy
      // subscriber alone permits an immediate reconnect before the publication.
      await main!.sendCommand(['ACL', 'SETUSER', name, 'off']);
      expect(await main!.sendCommand(['CLIENT', 'KILL', 'ID', subscriberId!])).toBe(1);
      await vi.waitFor(() => expect(closed).toContain('collab_transport_unavailable'));

      Y.applyUpdate(peerDraft, Y.encodeStateAsUpdate(runtimeB!.getRoom(pageId)!.doc));
      appendParagraph(peerDraft, 'MISSED_WHILE_UNSUBSCRIBED');
      expect(await runtimeB!.handleInboundFrame(
        pageId, 'connected-peer', encodeSyncUpdate(Y.encodeStateAsUpdate(peerDraft)),
      )).toBe('ok');
      // PING is ordered after the peer's publication on this same connection.
      await main!.ping();
      expect(await namedSubscriberId(name)).toBeUndefined();
      await main!.sendCommand(['ACL', 'SETUSER', name, 'on']);
      await vi.waitFor(async () => {
        const replacementId = await namedSubscriberId(name);
        expect(replacementId).toBeDefined();
        expect(replacementId).not.toBe(subscriberId);
      }, { timeout: 5_000 });

      let syncRead: Promise<CollabInboundResult> | undefined;
      const joined = await isolatedRuntime.attachSocket(pageId, {
        id: 'after-reconnect', userId: USER_A, writable: true,
        ws: {
          readyState: 1,
          send(frame: Uint8Array) {
            const decoder = decoding.createDecoder(frame);
            const kind = decoding.readVarUint(decoder);
            if (kind === 4) {
              const control: unknown = JSON.parse(decoding.readVarString(decoder));
              if (control && typeof control === 'object'
                && 'type' in control && control.type === 'writable_admission') {
                syncRead = isolatedRuntime.handleInboundFrame(
                  pageId, 'after-reconnect', encodeSyncStep1(rejoinedDoc),
                );
              }
            } else if (kind === 0) {
              syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), rejoinedDoc, 'server');
            }
          },
          close() {},
        } as unknown as WebSocket,
      });
      expect(joined.writable).toBe(true);
      await syncRead;
      expect(yDocToHtml(rejoinedDoc)).toContain('MISSED_WHILE_UNSUBSCRIBED');
    } finally {
      await main!.sendCommand(['ACL', 'SETUSER', name, 'on']);
      await ownedRuntime?.close();
      if (isolatedMain.isOpen) await isolatedMain.quit();
      await main!.sendCommand(['ACL', 'DELUSER', name]);
      peerDraft.destroy();
      rejoinedDoc.destroy();
    }
  });

  it('frozen join stays read-only, answers SyncStep1, and never creates collaborative bytes', async () => {
    const pageId = nextPageId();
    await setPageBaselineCreationEnabled(SYSTEM_ADMIN, true);
    const prepared = await previewPageBaseline(pageId, USER_A);
    await freezePage({
      pageId,
      actorId: USER_A,
      reason: 'Publish the reviewed page before a collaboration join',
      expectedContentRevision: prepared.contentRevision,
      expectedManifestDigest: prepared.manifestDigest,
    });

    const joined = await runtimeA!.attachSocket(pageId, {
      id: 'frozen-editor',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
    });
    expect(joined.writable).toBe(false);
    await expect(runtimeA!.prepareCommitSnapshot(pageId, USER_A, '0'))
      .rejects.toMatchObject({ reason: 'page_is_frozen' });
    const syncProbe = new Y.Doc();
    expect(await runtimeA!.handleInboundFrame(
      pageId,
      joined.id,
      encodeSyncStep1(syncProbe),
    )).toBe('ok');
    syncProbe.destroy();
    expect(await runtimeA!.handleInboundFrame(
      pageId,
      joined.id,
      encodeRejectedSyncSubtype(1),
    )).toBe('dropped');
    expect(await runtimeA!.handleInboundFrame(
      pageId,
      joined.id,
      encodeRejectedSyncSubtype(2),
    )).toBe('dropped');
    for (let dropped = 2; dropped < COLLAB_READONLY_DROP_LIMIT - 1; dropped += 1) {
      expect(await runtimeA!.handleInboundFrame(
        pageId,
        joined.id,
        encodeRejectedSyncSubtype(2),
      )).toBe('dropped');
    }
    expect(await runtimeA!.handleInboundFrame(
      pageId,
      joined.id,
      encodeRejectedSyncSubtype(2),
    )).toBe('close_4403');
    const persisted = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM page_collaborative_docs WHERE page_id = $1',
      [pageId],
    );
    expect(persisted.rows[0]?.count).toBe('0');
  });

  it('freeze loses to an admitted editor and leaves its in-memory work mounted', async () => {
    const pageId = nextPageId();
    await setPageBaselineCreationEnabled(SYSTEM_ADMIN, true);
    const prepared = await previewPageBaseline(pageId, USER_A);
    await runtimeA!.attachSocket(pageId, {
      id: 'active-editor',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
    });
    const room = runtimeA!.getRoom(pageId)!;
    room.doc.getText('unsaved').insert(0, 'copy this before reload');

    await expect(freezePage({
      pageId,
      actorId: USER_A,
      reason: 'This publication must wait for the active editor',
      expectedContentRevision: prepared.contentRevision,
      expectedManifestDigest: prepared.manifestDigest,
    })).rejects.toMatchObject({ reason: 'freeze_busy' });
    expect(runtimeA!.getRoom(pageId)?.doc.getText('unsaved').toString())
      .toBe('copy this before reload');
    expect(runtimeA!.getRoom(pageId)?.sockets.get('active-editor')?.writable).toBe(true);
  });

  it('missing expected lifecycle revision keeps an otherwise editable join read-only', async () => {
    const pageId = nextPageId();
    const sent: Uint8Array[] = [];
    const joined = await runtimeA!.attachSocket(pageId, {
      id: 'missing-revision',
      ws: {
        readyState: 1,
        send(frame: Uint8Array) { sent.push(frame); },
        close() {},
      } as unknown as WebSocket,
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: null,
    });
    expect(joined.writable).toBe(false);
    expect(joined.writableRefusalReason).toBe('lifecycle_revision_required');
    expect(decodeControlFrames(sent)).toContainEqual({
      type: 'writable_refused',
      reason: 'lifecycle_revision_required',
      expectedLifecycleRevision: null,
      currentLifecycleRevision: runtimeA!.getRoom(pageId)!.lifecycleRevision,
    });
    expect(decodeControlFrames(sent).some((control) =>
      control.type === 'writable_admission')).toBe(false);
    await expect(runtimeA!.prepareCommitSnapshot(pageId, USER_A, '0'))
      .rejects.toMatchObject({ reason: 'collab_state_unavailable' });
    expect((await query(
      `SELECT 1 FROM page_runtime_admissions
        WHERE page_id = $1 AND released_at IS NULL`,
      [pageId],
    )).rows).toHaveLength(0);
  });

  it('does not let a client-supplied future revision demote an admitted editor', async () => {
    const pageId = nextPageId();
    const state = await query<{ lifecycle_revision: string }>(
      'SELECT lifecycle_revision::text FROM pages WHERE id = $1',
      [pageId],
    );
    const currentRevision = state.rows[0]!.lifecycle_revision;
    await runtimeA!.attachSocket(pageId, {
      id: 'current-editor',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: currentRevision,
    });
    const forged = await runtimeA!.attachSocket(pageId, {
      id: 'future-client',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: (BigInt(currentRevision) + 50n).toString(),
    });

    expect(forged.writable).toBe(false);
    expect(forged.writableRefusalReason).toBe('lifecycle_revision_stale');
    expect(runtimeA!.getRoom(pageId)?.demotionReason).toBeNull();
    const update = new Y.Doc();
    update.getText('safe').insert(0, 'still writable');
    expect(await runtimeA!.handleInboundFrame(
      pageId,
      'current-editor',
      encodeSyncUpdate(Y.encodeStateAsUpdate(update)),
    )).toBe('ok');
    expect(runtimeA!.getRoom(pageId)?.doc.getText('safe').toString()).toBe('still writable');
    update.destroy();
  });

  it('admits a fresh document after real thaw while a stale read-only socket is still present', async () => {
    const pageId = nextPageId();
    await setPageBaselineCreationEnabled(SYSTEM_ADMIN, true);
    const prepared = await previewPageBaseline(pageId, USER_A);
    const frozen = await freezePage({
      pageId,
      actorId: USER_A,
      reason: 'Retain a baseline before testing a stale read-only socket',
      expectedContentRevision: prepared.contentRevision,
      expectedManifestDigest: prepared.manifestDigest,
    });
    const staleFrames: Uint8Array[] = [];
    const staleSocket = {
      readyState: 1,
      send(frame: Uint8Array) { staleFrames.push(frame); },
      close() { this.readyState = 3; },
    };
    const stale = await runtimeA!.attachSocket(pageId, {
      id: 'frozen-reader',
      ws: staleSocket as unknown as WebSocket,
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: frozen.lifecycleRevision,
    });
    expect(stale.writable).toBe(false);
    const thawed = await unfreezePage(pageId, SYSTEM_ADMIN, {
      reason: 'Reopen explicitly without replaying the retained browser document',
      expectedBaselineId: frozen.baselineId!,
      expectedLifecycleRevision: frozen.lifecycleRevision,
    });
    // No bus event is delivered here: the fresh join must recover from SQL.
    const freshFrames: Uint8Array[] = [];
    const fresh = await runtimeA!.attachSocket(pageId, {
      id: 'fresh-after-thaw',
      ws: {
        readyState: 1,
        send(frame: Uint8Array) { freshFrames.push(frame); },
        close() {},
      } as unknown as WebSocket,
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: thawed.lifecycleRevision,
    });
    expect(fresh.writable).toBe(true);
    expect(decodeControlFrames(freshFrames)).toContainEqual({
      type: 'writable_admission', lifecycleRevision: thawed.lifecycleRevision,
    });
    expect(decodeControlFrames(staleFrames)).toContainEqual({
      type: 'page_lifecycle', pageId, lifecycleRevision: thawed.lifecycleRevision,
      isFrozen: false, baselineId: null,
    });
    expect(staleSocket.readyState).toBe(3);
    const staleDraft = new Y.Doc();
    try {
      staleDraft.getText('offline-draft').insert(0, 'MUST_NOT_REPLAY');
      expect(await runtimeA!.handleInboundFrame(
        pageId, stale.id, encodeSyncUpdate(Y.encodeStateAsUpdate(staleDraft)),
      )).toBe('dropped');
      expect(runtimeA!.getRoom(pageId)!.doc.getText('offline-draft').toString()).toBe('');
      expect(yDocToHtml(runtimeA!.getRoom(pageId)!.doc)).toBe('<p>seed</p>');
    } finally {
      staleDraft.destroy();
    }
  });

  it('offline freeze-thaw reconnect cannot reacquire or replay against its old lifecycle revision', async () => {
    const pageId = nextPageId();
    const initial = await query<{ lifecycle_revision: string }>(
      'SELECT lifecycle_revision::text FROM pages WHERE id = $1',
      [pageId],
    );
    const oldRevision = initial.rows[0]!.lifecycle_revision;
    await runtimeA!.attachSocket(pageId, {
      id: 'old-editor',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: oldRevision,
    });
    await runtimeA!.detachSocket(pageId, 'old-editor');
    await query(
      'UPDATE pages SET lifecycle_revision = lifecycle_revision + 2 WHERE id = $1',
      [pageId],
    );

    const reconnected = await runtimeA!.attachSocket(pageId, {
      id: 'offline-reconnect',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: oldRevision,
    });
    expect(reconnected.writable).toBe(false);
    expect(reconnected.writableRefusalReason).toBe('lifecycle_revision_stale');
    const staleClient = new Y.Doc();
    staleClient.getText('offline').insert(0, 'MUST_NOT_REPLAY');
    expect(await runtimeA!.handleInboundFrame(
      pageId,
      reconnected.id,
      encodeSyncUpdate(Y.encodeStateAsUpdate(staleClient)),
    )).toBe('dropped');
    staleClient.destroy();
    expect(runtimeA!.getRoom(pageId)?.doc.getText('offline').toString()).toBe('');
    expect((await query(
      `SELECT 1 FROM page_runtime_admissions
        WHERE page_id = $1 AND released_at IS NULL`,
      [pageId],
    )).rows).toHaveLength(0);

    await runtimeA!.detachSocket(pageId, reconnected.id);
    expect(runtimeA!.getRoom(pageId)).toBeUndefined();
    const current = await query<{ lifecycle_revision: string }>(
      'SELECT lifecycle_revision::text FROM pages WHERE id = $1',
      [pageId],
    );
    const fresh = await runtimeA!.attachSocket(pageId, {
      id: 'fresh-document',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: current.rows[0]!.lifecycle_revision,
    });
    expect(fresh.writable).toBe(true);
    expect(runtimeA!.getRoom(pageId)?.doc.getText('offline').toString()).toBe('');
  });

  it('permission loss demotes only that socket and flushes before admission release', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'demoted',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
    });
    const retained = runtimeA!.getRoom(pageId)!;
    appendParagraph(retained.doc, 'FLUSHED_BEFORE_PERMISSION_LOSS');
    await runtimeA!.demoteSocket(pageId, 'demoted');
    expect(retained.sockets.get('demoted')?.writable).toBe(false);
    await expect(runtimeA!.prepareCommitSnapshot(pageId, USER_A, '0'))
      .rejects.toMatchObject({ reason: 'collab_state_unavailable' });

    const admitted = await runtimeA!.attachSocket(pageId, {
      id: 'replacement-editor',
      ws: stubWs(),
      userId: USER_B,
      writable: true,
    });
    expect(admitted.writable).toBe(true);
    expect(retained.sockets.get('demoted')?.writable).toBe(false);

    const stale = new Y.Doc();
    stale.getText('stale').insert(0, 'MUST_NOT_REPLAY');
    expect(await runtimeA!.handleInboundFrame(
      pageId,
      'demoted',
      encodeSyncUpdate(Y.encodeStateAsUpdate(stale)),
    )).toBe('dropped');
    stale.destroy();
    expect(retained.doc.getText('stale').toString()).toBe('');

    const authorized = new Y.Doc();
    authorized.getText('authorized').insert(0, 'OTHER_EDITOR_CONTINUES');
    expect(await runtimeA!.handleInboundFrame(
      pageId,
      'replacement-editor',
      encodeSyncUpdate(Y.encodeStateAsUpdate(authorized)),
    )).toBe('ok');
    authorized.destroy();
    expect(retained.doc.getText('authorized').toString()).toBe('OTHER_EDITOR_CONTINUES');
    expect(yDocToHtml(retained.doc)).toContain('FLUSHED_BEFORE_PERMISSION_LOSS');
  });

  it('re-reads authoritative lifecycle state for reordered events and reconnect recovery', async () => {
    const pageId = nextPageId();
    const sent: Uint8Array[] = [];
    await runtimeA!.attachSocket(pageId, {
      id: 'viewer',
      ws: {
        readyState: 1,
        send(data: Uint8Array) { sent.push(data); },
        close() {},
      } as unknown as WebSocket,
      userId: USER_A,
      writable: false,
    });
    const room = runtimeA!.getRoom(pageId)!;
    const initial = BigInt(room.lifecycleRevision);
    await query(
      'UPDATE pages SET lifecycle_revision = lifecycle_revision + 2 WHERE id = $1',
      [pageId],
    );
    await runtimeA!.handleLifecycleEvent({
      type: 'page_lifecycle',
      pageId,
      lifecycleRevision: (initial + 1n).toString(),
      isFrozen: false,
      baselineId: null,
    });
    expect(decodeControlFrames(sent)).toContainEqual({
      type: 'page_lifecycle', pageId, lifecycleRevision: (initial + 2n).toString(),
      isFrozen: false, baselineId: null,
    });
    const afterAuthoritativeRefresh = sent.length;
    await runtimeA!.handleLifecycleEvent({
      type: 'page_lifecycle',
      pageId,
      lifecycleRevision: (initial + 1n).toString(),
      isFrozen: false,
      baselineId: null,
    });
    await runtimeA!.handleLifecycleEvent({
      type: 'page_lifecycle',
      pageId,
      lifecycleRevision: (initial + 2n).toString(),
      isFrozen: false,
      baselineId: null,
    });
    expect(sent).toHaveLength(afterAuthoritativeRefresh);

    await query(
      'UPDATE pages SET lifecycle_revision = lifecycle_revision + 1 WHERE id = $1',
      [pageId],
    );
    await runtimeA!.refreshLifecycleRooms();
    const reconnectedFrames: Uint8Array[] = [];
    await runtimeA!.attachSocket(pageId, {
      id: 'viewer-reconnected',
      ws: {
        readyState: 1,
        send(frame: Uint8Array) { reconnectedFrames.push(frame); },
        close() {},
      } as unknown as WebSocket,
      userId: USER_A,
      writable: false,
    });
    expect(decodeControlFrames(reconnectedFrames)).toContainEqual({
      type: 'page_lifecycle', pageId, lifecycleRevision: (initial + 3n).toString(),
      isFrozen: false, baselineId: null,
    });
  });

  it('rejects a late peer state dump from the lifecycle revision before reconnect', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'old-writer', ws: stubWs(), userId: USER_A, writable: true,
    });
    const staleAdmission = runtimeA!.getRoom(pageId)!.admission!;
    await runtimeA!.detachSocket(pageId, 'old-writer');
    await runtimeB!.getOrCreateRoom(pageId);
    await query(
      'UPDATE pages SET lifecycle_revision = lifecycle_revision + 1 WHERE id = $1',
      [pageId],
    );
    await runtimeB!.refreshLifecycleRooms();
    const receiver = await runtimeB!.getOrCreateRoom(pageId);

    const stale = new Y.Doc();
    stale.getText('late').insert(0, 'LATE_STALE_DUMP');
    await main!.publish(collabDocChannel(pageId), JSON.stringify({
      origin: runtimeA!.podId,
      kind: 'state_dump',
      update: Buffer.from(Y.encodeStateAsUpdate(stale)).toString('base64'),
      lifecycleRevision: staleAdmission.lifecycleRevision,
      admission: staleAdmission,
    }));
    stale.destroy();

    await main!.publish(collabDocChannel(pageId), JSON.stringify({
      origin: runtimeA!.podId,
      kind: 'control',
      update: Buffer.from(JSON.stringify({
        type: 'pages_version',
        version: 91_337,
      }), 'utf8').toString('base64'),
    }));
    await vi.waitFor(() => {
      expect(receiver.pagesVersion).toBe(91_337);
    });
    expect(receiver.doc.getText('late').toString()).toBe('');
  });

  it('fans an incremental update to a delayed second subscriber via state_dump', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'writer', ws: stubWs(), userId: USER_A, writable: true,
    });
    const roomA = runtimeA!.getRoom(pageId)!;
    roomA.doc.getText('t').insert(0, 'typed-before-b-joined');

    await new Promise((r) => setTimeout(r, 1_000));

    const roomB = await runtimeB!.getOrCreateRoom(pageId);
    await vi.waitFor(() => {
      expect(roomB.doc.getText('t').toString()).toContain('typed-before-b-joined');
    }, { timeout: 4_000 });
  });

  it('forwards an admitted peer update to read-only sockets', async () => {
    const pageId = nextPageId();
    const revision = (await query<{ lifecycle_revision: string }>(
      'SELECT lifecycle_revision::text FROM pages WHERE id = $1',
      [pageId],
    )).rows[0]!.lifecycle_revision;
    await runtimeA!.attachSocket(pageId, {
      id: 'writer',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
      expectedLifecycleRevision: revision,
    });
    const received: Uint8Array[] = [];
    await runtimeB!.attachSocket(pageId, {
      id: 'readonly-peer',
      ws: {
        readyState: 1,
        send(frame: Uint8Array) { received.push(frame); },
        close() {},
      } as unknown as WebSocket,
      userId: USER_B,
      writable: false,
      expectedLifecycleRevision: null,
    });
    received.length = 0;
    const update = new Y.Doc();
    update.getText('peer').insert(0, 'AUTHORIZED_REMOTE_EDIT');

    expect(await runtimeA!.handleInboundFrame(
      pageId,
      'writer',
      encodeSyncUpdate(Y.encodeStateAsUpdate(update)),
    )).toBe('ok');
    await vi.waitFor(() => {
      expect(runtimeB!.getRoom(pageId)?.doc.getText('peer').toString())
        .toBe('AUTHORIZED_REMOTE_EDIT');
      expect(received.some((frame) =>
        frame[0] === 0 && frame[1] === 2)).toBe(true);
    }, { timeout: 4_000 });
    update.destroy();
  });

  it('fans an awareness update to a peer pod (#1449 leftover from #1444)', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'a1',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
      identity: { id: 'user-a', name: 'Alice', color: 'hsl(10 50% 40%)' },
    });
    await runtimeB!.attachSocket(pageId, {
      id: 'b1',
      ws: stubWs(),
      userId: USER_B,
      writable: true,
      identity: { id: 'user-b', name: 'Bob', color: 'hsl(200 50% 40%)' },
    });

    const { frame } = encodeAwarenessFrame({
      user: { id: 'user-a', name: 'Alice', color: 'hsl(10 50% 40%)' },
    });
    expect(await runtimeA!.handleInboundFrame(pageId, 'a1', frame)).toBe('ok');

    await vi.waitFor(() => {
      const names = [...(runtimeB!.getRoom(pageId)?.awareness.getStates().values() ?? [])]
        .map((s) => (s as { user?: { name?: string } }).user?.name)
        .filter((n): n is string => typeof n === 'string');
      expect(names).toContain('Alice');
    }, { timeout: 4_000 });
  });

  it('does not echo a peer update back onto the real Redis channel', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    const messages: Array<{ origin: string; kind: string }> = [];
    const observer = main.duplicate() as RedisClientType;
    await observer.connect();
    try {
      await observer.subscribe(collabDocChannel(pageId), (message) => messages.push(JSON.parse(message)));
      await runtimeA!.attachSocket(pageId, {
        id: 'writer', ws: stubWs(), userId: USER_A, writable: true,
      });
      await runtimeB!.getOrCreateRoom(pageId);
      runtimeA!.getRoom(pageId)!.doc.getText('t').insert(0, 'loop-probe');
      await vi.waitFor(() => {
        expect(runtimeB!.getRoom(pageId)?.doc.getText('t').toString()).toContain('loop-probe');
      }, { timeout: 4_000 });
      // Both runtimes publish through this connection. Receiving its marker
      // drains earlier publications without guessing a propagation delay.
      await main.publish(collabDocChannel(pageId), JSON.stringify({ origin: 'probe', kind: 'barrier' }));
      await vi.waitFor(() => {
        expect(messages.some((message) => message.origin === 'probe' && message.kind === 'barrier')).toBe(true);
      });
      expect(messages.filter((message) => message.origin === runtimeB!.podId && message.kind === 'sync')).toEqual([]);
    } finally {
      await observer.unsubscribe(collabDocChannel(pageId));
      await observer.quit();
    }
  });

  it('assertNoLiveCollabRoom 409s while a durable writable admission is active', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'writer', ws: stubWs(), userId: USER_A, writable: true,
    });

    await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'collab_session_active',
    });

    const ttl = await main!.ttl(`collab:active:${pageId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(COLLAB_ACTIVE_TTL_SEC);
  });

  it('clean last-editor disconnect releases the durable admission before empty-room grace', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    const connId = 'last-editor';
    await runtimeA!.attachSocket(pageId, {
      id: connId,
      ws: stubWs(),
      userId: USER_A,
      writable: true,
    });

    await runtimeA!.detachSocket(pageId, connId);

    await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    expect(await main.sMembers(`collab:active:${pageId}`)).toEqual([]);
    expect(runtimeA!.getRoom(pageId)?.doc).toBeDefined();
    const admissions = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM page_runtime_admissions
        WHERE page_id = $1 AND released_at IS NULL`,
      [pageId],
    );
    expect(admissions.rows[0]?.count).toBe('0');

    await new Promise((r) => setTimeout(r, COLLAB_EMPTY_ROOM_GRACE_MS + 250));

    expect(runtimeA!.getRoom(pageId)).toBeUndefined();
  }, 15_000);

  it('retains the durable admission when PostgreSQL rejects the last-editor flush', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'failed-flush', ws: stubWs(), userId: USER_A, writable: true,
    });
    await query(`ALTER TABLE page_collaborative_docs
      ADD CONSTRAINT collab_test_reject_flush CHECK (FALSE) NOT VALID`);
    try {
      await runtimeA!.detachSocket(pageId, 'failed-flush');
      await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
        code: 'collab_session_active',
      });
    } finally {
      await query('ALTER TABLE page_collaborative_docs DROP CONSTRAINT collab_test_reject_flush');
    }
    await runtimeA!.close();
    await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
  });

  it('a real shutdown flush failure cleans every room while retaining uncertain admissions', async () => {
    if (!main) throw new Error('unreachable');
    const firstPageId = nextPageId();
    const secondPageId = nextPageId();
    await runtimeA!.attachSocket(firstPageId, {
      id: 'failed-close-a', ws: stubWs(), userId: USER_A, writable: true,
    });
    await runtimeA!.attachSocket(secondPageId, {
      id: 'failed-close-b', ws: stubWs(), userId: USER_A, writable: true,
    });
    const admissions = [runtimeA!.getRoom(firstPageId)!.admission!, runtimeA!.getRoom(secondPageId)!.admission!];
    await query(`ALTER TABLE page_collaborative_docs
      ADD CONSTRAINT collab_test_reject_flush CHECK (FALSE) NOT VALID`);
    try {
      await runtimeA!.close();
      expect(runtimeA!.getRoom(firstPageId)).toBeUndefined();
      expect(runtimeA!.getRoom(secondPageId)).toBeUndefined();
      expect(await main.sMembers(`collab:active:${firstPageId}`)).toEqual([]);
      expect(await main.sMembers(`collab:active:${secondPageId}`)).toEqual([]);
      await expect(assertNoLiveCollabRoom(firstPageId)).rejects.toMatchObject({ code: 'collab_session_active' });
      await expect(assertNoLiveCollabRoom(secondPageId)).rejects.toMatchObject({ code: 'collab_session_active' });
    } finally {
      await query('ALTER TABLE page_collaborative_docs DROP CONSTRAINT collab_test_reject_flush');
      // These test documents were never changed; the injected constraint
      // rolled their flush transactions back. Retire only these known tokens.
      for (const admission of admissions) await releasePageRuntime(admission);
    }
  });

  it('reconnect during empty-room grace keeps collab:active (still 409)', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'first',
      ws: stubWs(),
      userId: USER_A,
      writable: true,
    });
    await runtimeA!.detachSocket(pageId, 'first');

    await runtimeA!.attachSocket(pageId, {
      id: 'reconnect',
      ws: stubWs(),
      userId: USER_A,
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
      id: 'a1', ws: stubWs(), userId: USER_A, writable: true,
    });
    await runtimeB!.attachSocket(pageId, {
      id: 'b1', ws: stubWs(), userId: USER_B, writable: true,
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
      id: 'last', ws: stubWs(), userId: USER_A, writable: true,
    });
    await runtimeA!.detachSocket(pageId, 'last');
    await runtimeA!.detachSocket(pageId, 'last');

    await runtimeA!.attachSocket(pageId, {
      id: 'reconnect', ws: stubWs(), userId: USER_A, writable: true,
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
      userId: USER_B,
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
      userId: USER_A,
      writable: true,
      identity,
    });

    const { frame: spoofed, clientID: senderId } = encodeAwarenessFrame({
      user: { id: 'user-a', name: 'Definitely Not Alice', color: '#fff' },
    });
    expect(await runtimeA!.handleInboundFrame(pageId, 'editor', spoofed)).toBe('ok');

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

  it('refuses corrupt persisted Yjs bytes without publishing a live session', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    await query(
      'INSERT INTO page_collaborative_docs (page_id, doc_state, state_vector) VALUES ($1, $2, $3)',
      [pageId, Buffer.from([255]), Buffer.alloc(0)],
    );
    await expect(runtimeA!.attachSocket(pageId, {
      id: 'corrupt-document', ws: stubWs(), userId: USER_A, writable: true,
    })).rejects.toThrow();
    expect(runtimeA!.getRoom(pageId)).toBeUndefined();
    expect(await main.sMembers(`collab:active:${pageId}`)).toEqual([]);
    await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    await query('DELETE FROM page_collaborative_docs WHERE page_id = $1', [pageId]);
    const recovered = await runtimeA!.attachSocket(pageId, {
      id: 'repaired-document', ws: stubWs(), userId: USER_A, writable: true,
    });
    expect(recovered.writable).toBe(true);
    expect(yDocToHtml(runtimeA!.getRoom(pageId)!.doc)).toBe('<p>seed</p>');
  });

  it('a fresh runtime reads the final edit after orderly shutdown', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'ed', ws: stubWs(), userId: USER_A, writable: true,
    });
    const edit = new Y.Doc();
    try {
      Y.applyUpdate(edit, Y.encodeStateAsUpdate(runtimeA!.getRoom(pageId)!.doc));
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'SAVED_ON_SHUTDOWN');
      paragraph.insert(0, [text]);
      edit.getXmlFragment('default').push([paragraph]);
      expect(await runtimeA!.handleInboundFrame(pageId, 'ed', encodeSyncUpdate(Y.encodeStateAsUpdate(edit)))).toBe('ok');
      await runtimeA!.close();
      runtimeA = await createCollabRuntime(main!, 'pod-a');
      await runtimeA.attachSocket(pageId, {
        id: 'reopened', ws: stubWs(), userId: USER_A, writable: true,
      });
      expect(yDocToHtml(runtimeA.getRoom(pageId)!.doc)).toContain('SAVED_ON_SHUTDOWN');
      const saved = await query<{ body_html: string }>('SELECT body_html FROM pages WHERE id = $1', [pageId]);
      expect(saved.rows[0]!.body_html).toContain('SAVED_ON_SHUTDOWN');
    } finally {
      edit.destroy();
    }
  });

  it('a real reset preserves inbound bytes when the peer retires its older document', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'a1', ws: stubWs(), userId: USER_A, writable: true,
    });
    await runtimeB!.attachSocket(pageId, {
      id: 'b1', ws: stubWs(), userId: USER_B, writable: true,
    });
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'COLLAB_TYPED_PARAGRAPH');
    paragraph.insert(0, [text]);
    runtimeB!.getRoom(pageId)!.doc.getXmlFragment('default').push([paragraph]);
    await runtimeA!.resetFromHtml(pageId, '<p>REMOTE_WINS</p>');
    await vi.waitFor(() => expect(runtimeB!.getRoom(pageId)).toBeUndefined(), { timeout: 2_000 });
    const stored = await query<{ doc_state: Buffer }>(
      'SELECT doc_state FROM page_collaborative_docs WHERE page_id = $1', [pageId],
    );
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, new Uint8Array(stored.rows[0]!.doc_state));
      expect(yDocToHtml(restored)).toBe('<p>REMOTE_WINS</p>');
    } finally {
      restored.destroy();
    }
    await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
  });

  it('activates the durable admission before BYTEA initialization so a writer already 409s', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    const holder = await getPool().connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [COLLAB_INIT_LOCK_KEY, pageId]);
    const attachP = runtimeA!.attachSocket(pageId, {
      id: 'init', ws: stubWs(), userId: USER_A, writable: true,
    });
    try {
      await vi.waitFor(async () => {
        const admission = await query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM page_runtime_admissions
              WHERE page_id = $1 AND released_at IS NULL
           ) AS present`,
          [pageId],
        );
        expect(admission.rows[0]?.present).toBe(true);
      });
      await expect(assertNoLiveCollabRoom(pageId)).rejects.toMatchObject({
        statusCode: 409,
        code: 'collab_session_active',
      });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await attachP;
    }
  });

  it('drops queued mutations after disconnect or permission loss before releasing the final admission', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'queued-detach', ws: stubWs(), userId: USER_A, writable: true,
    });
    await runtimeA!.attachSocket(pageId, {
      id: 'queued-demote', ws: stubWs(), userId: USER_A, writable: true,
    });
    const detachedDraft = new Y.Doc();
    detachedDraft.getText('late-detach').insert(0, 'must stay in the disconnected browser');
    const demotedDraft = new Y.Doc();
    demotedDraft.getText('late-demote').insert(0, 'must stay in the read-only browser');
    const holder = await getPool().connect();
    const frames: Array<Promise<CollabInboundResult>> = [];
    let cleanup: Promise<void[]> | undefined;
    let released = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [PAGE_LIFECYCLE_LOCK_KEY, pageId]);
      frames.push(
        runtimeA!.handleInboundFrame(pageId, 'queued-detach', encodeSyncUpdate(Y.encodeStateAsUpdate(detachedDraft))),
        runtimeA!.handleInboundFrame(pageId, 'queued-demote', encodeSyncUpdate(Y.encodeStateAsUpdate(demotedDraft))),
      );
      await vi.waitFor(async () => {
        const waiting = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pg_locks
            WHERE locktype = 'advisory' AND classid = $1 AND objid = $2
              AND objsubid = 2 AND NOT granted`,
          [PAGE_LIFECYCLE_LOCK_KEY, pageId],
        );
        expect(Number(waiting.rows[0]!.count)).toBeGreaterThanOrEqual(2);
      });
      cleanup = Promise.all([
        runtimeA!.demoteSocket(pageId, 'queued-demote'),
        runtimeA!.detachSocket(pageId, 'queued-detach'),
      ]);
      await holder.query('ROLLBACK');
      released = true;
      expect(await Promise.all(frames)).toEqual(['dropped', 'dropped']);
      await cleanup;
      const row = await query<{ doc_state: Buffer }>(
        'SELECT doc_state FROM page_collaborative_docs WHERE page_id = $1',
        [pageId],
      );
      const persisted = new Y.Doc();
      try {
        Y.applyUpdate(persisted, new Uint8Array(row.rows[0]!.doc_state));
        expect(persisted.getText('late-detach').toString()).toBe('');
        expect(persisted.getText('late-demote').toString()).toBe('');
      } finally {
        persisted.destroy();
      }
      expect(runtimeA!.getRoom(pageId)!.doc.getText('late-detach').toString()).toBe('');
      expect(runtimeA!.getRoom(pageId)!.doc.getText('late-demote').toString()).toBe('');
      await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    } finally {
      if (!released) await holder.query('ROLLBACK');
      holder.release();
      await Promise.allSettled(frames);
      await cleanup;
      detachedDraft.destroy();
      demotedDraft.destroy();
    }
  });

  it('a reconnect racing a real disconnect flush retains a usable writable admission', async () => {
    if (!main) throw new Error('unreachable');
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'first', ws: stubWs(), userId: USER_A, writable: true,
    });
    const holder = await getPool().connect();
    let detach: Promise<void> | undefined;
    let reconnect: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE page_collaborative_docs IN ACCESS EXCLUSIVE MODE');
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      detach = runtimeA!.detachSocket(pageId, 'first');
      await vi.waitFor(async () => {
        const blocked = await query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
           ) AS blocked`, [holderPid],
        );
        expect(blocked.rows[0]!.blocked).toBe(true);
      });
      reconnect = runtimeA!.attachSocket(pageId, {
        id: 'reconnect', ws: stubWs(), userId: USER_A, writable: true,
      });
      await holder.query('COMMIT');
      await Promise.all([detach, reconnect]);
      const edit = new Y.Doc();
      try {
        edit.getText('reconnected-edit').insert(0, 'ADMITTED_AFTER_FLUSH');
        expect(await runtimeA!.handleInboundFrame(
          pageId, 'reconnect', encodeSyncUpdate(Y.encodeStateAsUpdate(edit)),
        )).toBe('ok');
        expect(runtimeA!.getRoom(pageId)!.doc.getText('reconnected-edit').toString()).toBe('ADMITTED_AFTER_FLUSH');
      } finally {
        edit.destroy();
      }
      await runtimeA!.detachSocket(pageId, 'reconnect');
      await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await Promise.allSettled([detach, reconnect]);
    }
  });

  it('a queued old-generation reset cannot retire the fresh room that replaced it', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'old-generation', ws: stubWs(), userId: USER_A, writable: true,
    });
    const oldRoom = runtimeA!.getRoom(pageId)!;
    const holder = await getPool().connect();
    let detach: Promise<void> | undefined;
    let freshJoin: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE page_collaborative_docs IN ACCESS EXCLUSIVE MODE');
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      detach = runtimeA!.detachSocket(pageId, 'old-generation');
      await vi.waitFor(async () => {
        const blocked = await query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
           ) AS blocked`, [holderPid],
        );
        expect(blocked.rows[0]!.blocked).toBe(true);
      });
      freshJoin = runtimeA!.attachSocket(pageId, {
        id: 'fresh-generation', ws: stubWs(), userId: USER_A, writable: true,
      });
      await main!.publish(collabDocChannel(pageId), JSON.stringify({
        origin: 'delayed-peer', kind: 'tombstone', code: 1001, reason: 'doc_reset',
      }));
      await vi.waitFor(() => expect(persist.isCollabResetting(pageId)).toBe(true));
      await holder.query('COMMIT');
      await Promise.all([detach, freshJoin]);
      await vi.waitFor(() => expect(oldRoom.flushing).toBe(false));
      const edit = new Y.Doc();
      try {
        edit.getText('current-generation').insert(0, 'STILL_ADMITTED');
        expect(await runtimeA!.handleInboundFrame(
          pageId, 'fresh-generation', encodeSyncUpdate(Y.encodeStateAsUpdate(edit)),
        )).toBe('ok');
        expect(runtimeA!.getRoom(pageId)!.doc.getText('current-generation').toString()).toBe('STILL_ADMITTED');
      } finally {
        edit.destroy();
      }
      await runtimeA!.detachSocket(pageId, 'fresh-generation');
      await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await Promise.allSettled([detach, freshJoin]);
      persist.endCollabReset(pageId);
    }
  });

  it.each(['join', 'frame'] as const)('retains admission ownership when %s validation loses its real PostgreSQL connection', async (entry) => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'existing-writer', ws: stubWs(), userId: USER_A, writable: true,
    });
    const holder = await getPool().connect();
    let joining: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [PAGE_LIFECYCLE_LOCK_KEY, pageId]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      if (entry === 'join') {
        joining = runtimeA!.attachSocket(pageId, {
          id: 'interrupted-join', ws: stubWs(), userId: USER_A, writable: true,
        }).then((result) => result, (error: unknown) => error);
      } else {
        const draft = new Y.Doc();
        appendParagraph(draft, 'NEVER_ADMITTED');
        const frame = encodeSyncUpdate(Y.encodeStateAsUpdate(draft));
        draft.destroy();
        joining = runtimeA!.handleInboundFrame(pageId, 'existing-writer', frame)
          .then((result) => result, (error: unknown) => error);
      }
      let blockedPid: number | undefined;
      await vi.waitFor(async () => {
        const blocked = await query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        );
        blockedPid = blocked.rows[0]?.pid;
        expect(blockedPid).toBeDefined();
      });
      const terminated = await query<{ terminated: boolean }>(
        'SELECT pg_terminate_backend($1) AS terminated', [blockedPid],
      );
      expect(terminated.rows[0]!.terminated).toBe(true);
      await holder.query('ROLLBACK');
      if (entry === 'join') expect(await joining).toBeInstanceOf(Error);
      else expect(await joining).toBe('dropped');
      const retried = await runtimeA!.attachSocket(pageId, {
        id: 'retried-join', ws: stubWs(), userId: USER_A, writable: true,
      });
      expect(retried.writable).toBe(true);
      await runtimeA!.detachSocket(pageId, 'existing-writer');
      await runtimeA!.detachSocket(pageId, 'retried-join');
      // A validation error must not strand the old token behind a replacement.
      await expect(assertNoLiveCollabRoom(pageId)).resolves.toBeUndefined();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await joining;
      await runtimeA!.detachSocket(pageId, 'interrupted-join');
    }
  });

  it('sends an awareness snapshot to a joining socket when states already exist', async () => {
    const pageId = nextPageId();
    const sent: Uint8Array[] = [];
    await runtimeA!.attachSocket(pageId, {
      id: 'a1', ws: stubWs(), userId: USER_A, writable: true,
      identity: { id: 'user-a', name: 'Alice', color: 'hsl(10 50% 40%)' },
    });
    const { frame } = encodeAwarenessFrame({
      user: { id: 'user-a', name: 'Alice', color: 'hsl(10 50% 40%)' },
    });
    expect(await runtimeA!.handleInboundFrame(pageId, 'a1', frame)).toBe('ok');

    await runtimeA!.attachSocket(pageId, {
      id: 'b1',
      ws: {
        readyState: 1,
        send(data: Uint8Array) { sent.push(data); },
        close() {},
      } as unknown as WebSocket,
      userId: USER_B,
      writable: true,
    });
    expect(sent.length).toBeGreaterThan(0);
  });

  it('removeAwarenessStates on detach so remaining peers drop the leaver', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'a1', ws: stubWs(), userId: USER_A, writable: true,
      identity: { id: 'user-a', name: 'Alice', color: 'hsl(10 50% 40%)' },
    });
    await runtimeA!.attachSocket(pageId, {
      id: 'b1', ws: stubWs(), userId: USER_B, writable: true,
    });
    const { frame } = encodeAwarenessFrame({
      user: { id: 'user-a', name: 'Alice', color: 'hsl(10 50% 40%)' },
    });
    expect(await runtimeA!.handleInboundFrame(pageId, 'a1', frame)).toBe('ok');
    const namesBefore = [...(runtimeA!.getRoom(pageId)?.awareness.getStates().values() ?? [])]
      .map((s) => (s as { user?: { name?: string } }).user?.name);
    expect(namesBefore).toContain('Alice');

    await runtimeA!.detachSocket(pageId, 'a1');
    const namesAfter = [...(runtimeA!.getRoom(pageId)?.awareness.getStates().values() ?? [])]
      .map((s) => (s as { user?: { name?: string } }).user?.name)
      .filter((n): n is string => typeof n === 'string');
    expect(namesAfter).not.toContain('Alice');
  });

  it('ignores state_dump while a doc_reset freeze is in flight', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'writer', ws: stubWs(), userId: USER_A, writable: true,
    });
    const roomA = runtimeA!.getRoom(pageId)!;
    const roomB = await runtimeB!.getOrCreateRoom(pageId);
    persist.beginCollabReset(pageId);
    roomB.persistable = false;
    const dumpDoc = new Y.Doc();
    dumpDoc.getText('t').insert(0, 'SHOULD_NOT_APPLY');
    const dump = Y.encodeStateAsUpdate(dumpDoc);
    dumpDoc.destroy();
    await main!.publish(collabDocChannel(pageId), JSON.stringify({
      origin: runtimeA!.podId,
      kind: 'state_dump',
      update: Buffer.from(dump).toString('base64'),
      lifecycleRevision: roomA.lifecycleRevision,
      admission: roomA.admission,
    }));
    await new Promise((r) => setTimeout(r, 200));
    expect(roomB.doc.getText('t').toString()).not.toContain('SHOULD_NOT_APPLY');
    expect(roomB.persistable).toBe(false);
    persist.endCollabReset(pageId);
  });

  it('a throwing bus apply does not skip the rest of the queue', async () => {
    const pageId = nextPageId();
    await runtimeA!.attachSocket(pageId, {
      id: 'writer', ws: stubWs(), userId: USER_A, writable: true,
    });
    const roomA = runtimeA!.getRoom(pageId)!;
    const roomB = await runtimeB!.getOrCreateRoom(pageId);
    await main!.publish(collabDocChannel(pageId), JSON.stringify({
      origin: runtimeA!.podId,
      kind: 'sync',
      update: '!!!not-a-yjs-update!!!',
      lifecycleRevision: roomA.lifecycleRevision,
      admission: roomA.admission,
    }));
    const good = Y.encodeStateAsUpdate((() => {
      const d = new Y.Doc();
      d.getText('t').insert(0, 'after-bad');
      return d;
    })());
    await main!.publish(collabDocChannel(pageId), JSON.stringify({
      origin: runtimeA!.podId,
      kind: 'sync',
      update: Buffer.from(good).toString('base64'),
      lifecycleRevision: roomA.lifecycleRevision,
      admission: roomA.admission,
    }));
    await vi.waitFor(() => {
      expect(roomB.doc.getText('t').toString()).toContain('after-bad');
    }, { timeout: 4_000 });
  });

});
