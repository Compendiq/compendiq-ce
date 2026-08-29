/**
 * #1349 review (external round) — the run's record is persisted BEFORE the
 * worker lock is released.
 *
 * `running` on both admin GETs is read off the lock, so an observer that sees
 * the lock free must also see this run's record: released first, the card
 * could pair `running: false` with the PREVIOUS run's summary, and a second
 * run started inside that window could have its fresh record overwritten by
 * this run's stale one landing late. `persistSetting` swallows its own errors
 * (the image-index precedent), so holding the lock through it cannot wedge it.
 *
 * Mocked end to end (this cell is about call ORDER, not the walk): the root
 * is pointed at a path that does not exist, so `executeSweep` refuses without
 * touching disk or DB and the epilogue — persist, release, audit — is the
 * only thing under test. The refusal path persists like every other outcome,
 * which is exactly why it is the cheapest one to pin the ordering on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const events: string[] = [];

/**
 * When set, the keep-set's first `pages` read blocks on this promise. It is
 * how the lock-loss cell below suspends a run mid-flight at a known point, so
 * the refresh guard can be driven to its "someone else holds it" verdict
 * before the walk reaches its next `assertNotAborted()`.
 */
let keepSetGate: Promise<void> | null = null;

vi.mock('../../../core/db/postgres.js', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO admin_settings')) {
      events.push(`persist:${String(params?.[0])}`);
    }
    if (keepSetGate && sql.includes('draft_body_html')) await keepSetGate;
    return { rows: [] };
  }),
}));

vi.mock('../../../core/services/redis-cache.js', () => ({
  acquireWorkerLock: vi.fn(async () => 'test-holder-token'),
  refreshWorkerLock: vi.fn(async () => 'test-holder-token'),
  releaseWorkerLock: vi.fn(async () => {
    events.push('release');
  }),
  isWorkerLocked: vi.fn(async () => false),
}));

vi.mock('../../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(async () => {
    events.push('audit');
  }),
}));

vi.mock('../../../core/services/attachment-store.js', async () => {
  // The reserved-name set is taken from the REAL module: the lock-loss cell
  // below drives an actual walk, and a hand-written stand-in here would decide
  // by itself which root entries that walk treats as other stores.
  const actual = await vi.importActual<typeof import('../../../core/services/attachment-store.js')>(
    '../../../core/services/attachment-store.js',
  );
  return {
    ATTACHMENT_ROOT_RESERVED_DIRNAMES: actual.ATTACHMENT_ROOT_RESERVED_DIRNAMES,
    attachmentsRootNow: vi.fn(() => '/nonexistent-attachment-sweep-lock-order-test'),
    removeCachedAttachmentDirectory: vi.fn(),
    removeCachedAttachmentFile: vi.fn(),
  };
});

vi.mock('../../../core/services/local-attachment-service.js', () => ({
  LOCAL_STORE_DIRNAME: 'local',
  localAttachmentsRoot: vi.fn(() => '/nonexistent-attachment-sweep-lock-order-test/local'),
  removeLocalAttachmentDirectory: vi.fn(),
  removeLocalAttachmentFileForSweep: vi.fn(),
}));

vi.mock('../../../core/services/image-embedding-dirty.js', () => ({
  markPageImagesDirty: vi.fn(),
}));

vi.mock('./attachment-handler.js', () => ({
  getExpectedAttachmentFilenames: vi.fn(() => []),
}));

import {
  acquireWorkerLock,
  refreshWorkerLock,
  releaseWorkerLock,
} from '../../../core/services/redis-cache.js';
import { attachmentsRootNow } from '../../../core/services/attachment-store.js';
import {
  acquireAttachmentSweepLock,
  runAttachmentSweep,
  ATTACHMENT_SWEEP_LAST_RUN_KEY,
  ATTACHMENT_SWEEP_WORKER_LOCK,
} from './attachment-sweep-service.js';
// #1514 — the REAL constant from the colliding worker, imported for the
// distinctness assertion at the bottom of this file. Named import only: the
// module's top level defines constants, so nothing runs on load, and the
// mocks above already stand in for the shared graph it touches.
import { IMAGE_INDEX_WORKER_LOCK } from '../../llm/services/image-embedding-service.js';

/** The module's own `LOCK_REFRESH_MS`; restated because it is not exported. */
const LOCK_REFRESH_MS_UNDER_TEST = 60_000;

describe('#1349 runAttachmentSweep epilogue ordering', () => {
  beforeEach(() => {
    events.length = 0;
    keepSetGate = null;
    vi.mocked(acquireWorkerLock).mockClear();
    vi.mocked(acquireWorkerLock).mockResolvedValue('test-holder-token');
    vi.mocked(refreshWorkerLock).mockClear();
    vi.mocked(refreshWorkerLock).mockResolvedValue('test-holder-token');
    vi.mocked(releaseWorkerLock).mockClear();
    vi.mocked(attachmentsRootNow).mockReturnValue('/nonexistent-attachment-sweep-lock-order-test');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists the last-run record BEFORE releasing the worker lock (and still releases and audits)', async () => {
    const run = await runAttachmentSweep({ dryRun: true });

    expect(run).not.toBeNull();
    expect(run!.status).toBe('refused'); // the mocked root does not exist

    const persistAt = events.indexOf(`persist:${ATTACHMENT_SWEEP_LAST_RUN_KEY}`);
    const releaseAt = events.indexOf('release');
    expect(persistAt).toBeGreaterThanOrEqual(0); // the record really was written
    expect(releaseAt).toBeGreaterThanOrEqual(0); // the lock really was released
    expect(persistAt).toBeLessThan(releaseAt);
    // The audit heartbeat still fires after the epilogue.
    expect(events).toContain('audit');
  });

  it('takes ownership of a caller-acquired token: no second acquire, releases THAT token (external round)', async () => {
    // The route's race fix hands the token it acquired into the run — a
    // second acquire here would fail against the caller's own lock and turn
    // every triggered sweep into a false `alreadyRunning`, while releasing a
    // different token would leave the caller's lock standing until TTL.
    const run = await runAttachmentSweep({ dryRun: true, token: 'route-held-token' });

    expect(run).not.toBeNull();
    expect(run!.status).toBe('refused'); // the mocked root does not exist
    expect(acquireWorkerLock).not.toHaveBeenCalled();
    expect(releaseWorkerLock).toHaveBeenCalledWith(ATTACHMENT_SWEEP_WORKER_LOCK, 'route-held-token');
    // The persist-before-release ordering holds on this path too.
    const persistAt = events.indexOf(`persist:${ATTACHMENT_SWEEP_LAST_RUN_KEY}`);
    const releaseAt = events.indexOf('release');
    expect(persistAt).toBeGreaterThanOrEqual(0);
    expect(persistAt).toBeLessThan(releaseAt);
  });

  /**
   * Fixer r1 — the lock is taken `failClosed`, and nothing pinned it: deleting
   * the option left every suite green, so the single-flight guarantee on the
   * DESTRUCTIVE path could be lost silently.
   *
   * `acquireWorkerLock` degrades to local execution on a Redis ERROR and hands
   * every caller a token, which is right for the idempotent workers it was
   * written for and wrong here — this is that degrade's first destructive
   * consumer, and a blip during two concurrent Delete-orphans presses would
   * run two delete loops over the same tree. Asserted BEHAVIOURALLY (the mock
   * answers the way the real function does under each option) as well as by
   * argument, so the cell survives a refactor of how the option is spelled.
   */
  it('takes the lock fail-closed, so a Redis error answers alreadyRunning rather than running unlocked', async () => {
    vi.mocked(acquireWorkerLock).mockImplementation(
      async (_name: string, _ttl: number, opts?: { failClosed?: boolean }) =>
        opts?.failClosed === true ? null : 'degraded-local-token',
    );

    await expect(acquireAttachmentSweepLock()).resolves.toBeNull();
    expect(acquireWorkerLock).toHaveBeenCalledWith(ATTACHMENT_SWEEP_WORKER_LOCK, expect.any(Number), {
      failClosed: true,
    });

    // …and the destructive run refuses to start rather than proceeding
    // unlocked. Nothing is persisted, released or audited on that path.
    await expect(runAttachmentSweep({ dryRun: false })).resolves.toBeNull();
    expect(events).toEqual([]);
    expect(releaseWorkerLock).not.toHaveBeenCalled();
  });

  /**
   * Fixer r1 — the mid-run abort had no cell in either direction: disarming
   * `if (lockLost) throw new SweepAborted()` left the whole sweep suite green,
   * so the only thing stopping a delete loop that has lost its worker lock
   * could be deleted undetected.
   *
   * Driven at the real wiring rather than by calling `assertNotAborted`
   * directly: the keep-set's first read is gated, the refresh guard is fired
   * once against a DIFFERENT holder token while the run is suspended there,
   * and the walk's next `assertNotAborted()` is what has to notice. Only
   * `setInterval`/`clearInterval` are faked — the walk's own `setImmediate`
   * yields and the real `fs` calls must keep working.
   */
  it('aborts mid-run when another holder has taken the worker lock, and records it as failed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-lock-loss-'));
    await fs.mkdir(path.join(root, '999999'), { recursive: true });
    await fs.writeFile(path.join(root, '999999', 'x.png'), 'bytes');
    vi.mocked(attachmentsRootNow).mockReturnValue(root);
    // Someone else holds it now — exactly what the guard exists to notice.
    vi.mocked(refreshWorkerLock).mockResolvedValue('a-different-holder');

    let openGate!: () => void;
    keepSetGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const running = runAttachmentSweep({ dryRun: false });
      // Real timer: let the run reach the gated keep-set read, past the point
      // where the refresh interval has been armed.
      await new Promise((r) => setTimeout(r, 20));
      await vi.advanceTimersByTimeAsync(LOCK_REFRESH_MS_UNDER_TEST);
      openGate();

      const run = await running;
      expect(run).not.toBeNull();
      expect(run!.status).toBe('failed');
      expect(run!.note).toMatch(/worker lock lost mid-run/i);
      // Nothing was destroyed: the abort fires in the walk, before the delete
      // phase, and the file is still there.
      await expect(fs.stat(path.join(root, '999999', 'x.png'))).resolves.toBeTruthy();
    } finally {
      vi.useRealTimers();
      keepSetGate = null;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * #1514 — the lock's NAME, not its ordering.
 *
 * Every consumer reads the exported constant, so renaming it kept the whole
 * sweep suite green: `attachments-sweep.test.ts` asserts
 * `locked).toHaveBeenCalledWith('attachment-sweep')` against a literal it
 * supplies itself in its own module mock, so that expectation is satisfied by
 * the mock rather than by the production value. Swapping line 132 to
 * `'image-embedding-index'` therefore left 18 tests passing — while in
 * production the destructive sweep and the #1115 image-index worker would
 * share one Redis key and each answer `alreadyRunning` for the other: the
 * operator presses Delete orphans, is told a sweep is already running, and
 * the real holder is a worker that has nothing to do with attachments.
 *
 * Both real constants are imported (the whole point — a literal here would
 * rebuild the exact hole), and the collision is asserted as a DISTINCTNESS
 * claim as well as by value, so renaming either side deliberately still has
 * to keep them apart.
 */
describe('#1514 the attachment sweep worker-lock name', () => {
  it('is the pinned literal, and never collides with the image-index worker lock', () => {
    expect(ATTACHMENT_SWEEP_WORKER_LOCK).toBe('attachment-sweep');
    expect(ATTACHMENT_SWEEP_WORKER_LOCK).not.toBe(IMAGE_INDEX_WORKER_LOCK);
  });
});
