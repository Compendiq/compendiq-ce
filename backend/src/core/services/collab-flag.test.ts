/**
 * #1758 — `collab-flag.ts` reloads are serialized and coalesced like
 * `makeCachedSetting`'s, and `refreshCollabFlag()` keeps its contract: it
 * resolves with a read that started at or after the call (a failed read
 * yields the previous value), and when that value is `false` it tombstones
 * every room exactly once per call, before it resolves. Cold-load never
 * tombstones.
 *
 * The database `query` and the cache bus are mocked, and
 * `collab-room-service.tombstoneAllCollabRooms` is a spy on the real module's
 * export (a `vi.mock` factory is not used for it: Vitest hands the real module
 * to all but the first of several concurrent `import()`s of a factory-mocked
 * module, and `refreshCollabFlag()` imports it lazily). Every read is a
 * deferred promise the test settles explicitly.
 */
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type * as CollabFlagModule from './collab-flag.js';
import type * as CollabRoomServiceModule from './collab-room-service.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  subscribe: vi.fn(),
  onReconnect: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mocks.query(sql, params),
}));
vi.mock('./redis-cache-bus.js', () => ({
  subscribe: (channel: string, handler: () => void) => mocks.subscribe(channel, handler),
  onReconnect: (handler: () => void) => mocks.onReconnect(handler),
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: mocks.warn, debug: vi.fn() },
}));

type QueryResult = { rows: Array<{ setting_value: string }> };

const flagRow = (value: '1' | '0'): QueryResult => ({ rows: [{ setting_value: value }] });

/** Lets queued microtasks (and the follow-up they start) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

let flag: typeof CollabFlagModule;
let tombstone: MockInstance<typeof CollabRoomServiceModule.tombstoneAllCollabRooms>;

beforeEach(async () => {
  vi.restoreAllMocks();
  mocks.query.mockReset();
  mocks.subscribe.mockReset().mockReturnValue(() => {});
  mocks.onReconnect.mockReset().mockReturnValue(() => {});
  mocks.warn.mockReset();
  // The cached flag and its reloader are module state: load fresh copies per
  // test (the room service first, so the flag's lazy import gets this copy).
  vi.resetModules();
  const rooms = await import('./collab-room-service.js');
  tombstone = vi.spyOn(rooms, 'tombstoneAllCollabRooms').mockResolvedValue(undefined);
  flag = await import('./collab-flag.js');
});

async function coldLoad(value: '1' | '0'): Promise<void> {
  mocks.query.mockResolvedValueOnce(flagRow(value));
  await flag.initCollabFlag();
}

describe('collab-flag (#1758)', () => {
  it('cold-load reads the row and never tombstones', async () => {
    await coldLoad('0');
    expect(flag.isCollabEditingEnabled()).toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(tombstone).not.toHaveBeenCalled();
  });

  it('a failed cold-load leaves the default false, logs warn, and does not tombstone', async () => {
    mocks.query.mockRejectedValueOnce(new Error('pool exhausted'));
    await flag.initCollabFlag();
    expect(flag.isCollabEditingEnabled()).toBe(false);
    expect(tombstone).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'cold-load', key: 'collab_editing_enabled' }),
      expect.stringContaining('cold-load failed'),
    );
  });

  it('a delayed first read cannot overwrite the latest write: the flag ends on it and stays there', async () => {
    await coldLoad('1');
    // Enable → refresh 1: its read answers late, with the row as it was then.
    const delayed = Promise.withResolvers<QueryResult>();
    mocks.query.mockReturnValueOnce(delayed.promise);
    const first = flag.refreshCollabFlag();
    // Disable → refresh 2: any read issued from now on sees the latest row.
    mocks.query.mockResolvedValueOnce(flagRow('0'));
    const second = flag.refreshCollabFlag();
    await flush();

    delayed.resolve(flagRow('1'));
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(flag.isCollabEditingEnabled()).toBe(false);

    await flush();
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(flag.isCollabEditingEnabled()).toBe(false);
    expect(tombstone).toHaveBeenCalledTimes(1); // refresh 2 read false
    expect(tombstone).toHaveBeenCalledWith(4403, 'flag_off');
  });

  it('any number of refreshes, bus events and reconnects during an in-flight read cause exactly one follow-up read', async () => {
    await coldLoad('1');
    const busHandler = mocks.subscribe.mock.calls[0]![1] as () => void;
    const reconnectHandler = mocks.onReconnect.mock.calls[0]![0] as () => void;
    const inFlight = Promise.withResolvers<QueryResult>();
    mocks.query.mockReturnValueOnce(inFlight.promise);
    const followUp = Promise.withResolvers<QueryResult>();
    mocks.query.mockReturnValueOnce(followUp.promise);

    const first = flag.refreshCollabFlag();
    await flush();
    busHandler();
    reconnectHandler();
    const joined = [flag.refreshCollabFlag(), flag.refreshCollabFlag()];
    await flush();
    expect(mocks.query).toHaveBeenCalledTimes(2); // cold-load + the one in-flight read

    inFlight.resolve(flagRow('0'));
    expect(await first).toBe(false);
    await flush();
    expect(mocks.query).toHaveBeenCalledTimes(3); // exactly one follow-up
    followUp.resolve(flagRow('0'));
    expect(await Promise.all(joined)).toEqual([false, false]);

    // Once per refreshCollabFlag() call that read false: the direct call, the
    // bus- and reconnect-triggered refreshes, and the two joined calls. The
    // two triggered refreshes are not awaited by anyone, so wait for them.
    await vi.waitFor(() => expect(tombstone).toHaveBeenCalledTimes(5));
    await flush();
    expect(tombstone).toHaveBeenCalledTimes(5);
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it('an awaited refresh resolves only after a read that started after the call, and tombstones before it resolves', async () => {
    await coldLoad('1');
    const older = Promise.withResolvers<QueryResult>();
    const newer = Promise.withResolvers<QueryResult>();
    mocks.query.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const tombstoned = Promise.withResolvers<void>();
    tombstone.mockReturnValueOnce(tombstoned.promise);

    const first = flag.refreshCollabFlag();
    await flush();
    let resolved = false;
    const awaited = flag.refreshCollabFlag().then((enabled) => { resolved = true; return enabled; });

    older.resolve(flagRow('1'));
    expect(await first).toBe(true);
    await flush();
    expect(resolved).toBe(false); // the read that completed started before the call

    newer.resolve(flagRow('0')); // the admin's own write
    await vi.waitFor(() => expect(tombstone).toHaveBeenCalledTimes(1));
    expect(resolved).toBe(false); // still waiting for the tombstone
    tombstoned.resolve();
    expect(await awaited).toBe(false);
    expect(flag.isCollabEditingEnabled()).toBe(false);
  });

  it('a failed in-flight read keeps the previous value (no tombstone for it) and logs warn; the pending follow-up still runs', async () => {
    await coldLoad('1');
    const failing = Promise.withResolvers<QueryResult>();
    const followUp = Promise.withResolvers<QueryResult>();
    mocks.query.mockReturnValueOnce(failing.promise).mockReturnValueOnce(followUp.promise);

    const first = flag.refreshCollabFlag();
    await flush();
    const second = flag.refreshCollabFlag();

    failing.reject(new Error('connection reset'));
    expect(await first).toBe(true);
    expect(flag.isCollabEditingEnabled()).toBe(true);
    expect(tombstone).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 're-read', key: 'collab_editing_enabled' }),
      expect.stringContaining('re-read failed'),
    );

    await flush();
    expect(mocks.query).toHaveBeenCalledTimes(3);
    followUp.resolve(flagRow('0'));
    expect(await second).toBe(false);
    expect(flag.isCollabEditingEnabled()).toBe(false);
    expect(tombstone).toHaveBeenCalledTimes(1);
  });
});
