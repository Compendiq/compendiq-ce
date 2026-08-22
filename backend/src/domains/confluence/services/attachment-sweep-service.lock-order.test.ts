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
import { describe, it, expect, vi, beforeEach } from 'vitest';

const events: string[] = [];

vi.mock('../../../core/db/postgres.js', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO admin_settings')) {
      events.push(`persist:${String(params?.[0])}`);
    }
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

vi.mock('../../../core/services/attachment-store.js', () => ({
  attachmentsRootNow: vi.fn(() => '/nonexistent-attachment-sweep-lock-order-test'),
  removeCachedAttachmentDirectory: vi.fn(),
  removeCachedAttachmentFile: vi.fn(),
}));

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

import { runAttachmentSweep, ATTACHMENT_SWEEP_LAST_RUN_KEY } from './attachment-sweep-service.js';

describe('#1349 runAttachmentSweep epilogue ordering', () => {
  beforeEach(() => {
    events.length = 0;
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
});
