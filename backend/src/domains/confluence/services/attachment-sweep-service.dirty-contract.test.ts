/**
 * #1349 fixer r1 — the sweep's side of `markPageImagesDirty`'s boolean
 * contract.
 *
 * That function swallows its own query error by design (a whole sync must not
 * die on the way to raising a flag) and reports whether the statement RAN.
 * This PR changed its signature for exactly one consumer — the delete loop's
 * `pagesMarkedDirty` counter — and `image-embedding-dirty.integration.test.ts`
 * pins the producer side while nothing pinned the consumer: forcing the
 * counter to increment regardless left the whole sweep suite green.
 *
 * The flag IS the queue (ADR-025), so a counter that over-reports it hides
 * exactly the backlog an operator would go looking for — which is why the
 * `false` branch has to be a cell rather than a comment.
 *
 * Mocked end to end and NOT a DB test: the only way `markPageImagesDirty`
 * answers `false` is by throwing inside itself, which a real Postgres will not
 * do for a page id the sweep actually derived. The boundary under test here is
 * the sweep's reading of that function's answer, so that function is the
 * boundary that gets stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../core/db/postgres.js', () => ({
  query: vi.fn(async (sql: string) => {
    // The owner lookup for a Confluence attachment key.
    if (sql.includes('SELECT id FROM pages WHERE confluence_id')) return { rows: [{ id: 7 }] };
    return { rows: [], rowCount: 0 };
  }),
}));

vi.mock('../../../core/services/redis-cache.js', () => ({
  acquireWorkerLock: vi.fn(async () => 'token'),
  refreshWorkerLock: vi.fn(async () => 'token'),
  releaseWorkerLock: vi.fn(),
  isWorkerLocked: vi.fn(async () => false),
}));

vi.mock('../../../core/services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));

vi.mock('../../../core/services/attachment-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/services/attachment-store.js')>(
    '../../../core/services/attachment-store.js',
  );
  return {
    ATTACHMENT_ROOT_RESERVED_DIRNAMES: actual.ATTACHMENT_ROOT_RESERVED_DIRNAMES,
    attachmentsRootNow: vi.fn(() => '/nonexistent'),
    removeCachedAttachmentDirectory: vi.fn(),
    removeCachedAttachmentFile: vi.fn(),
  };
});

vi.mock('../../../core/services/local-attachment-service.js', () => ({
  LOCAL_STORE_DIRNAME: 'local',
  localAttachmentsRoot: vi.fn(() => '/nonexistent/local'),
  removeLocalAttachmentDirectory: vi.fn(),
  removeLocalAttachmentFileForSweep: vi.fn(async () => true),
}));

vi.mock('../../../core/services/image-embedding-dirty.js', () => ({
  markPageImagesDirty: vi.fn(async () => true),
}));

vi.mock('./attachment-handler.js', () => ({ getExpectedAttachmentFilenames: vi.fn(() => []) }));

import { attachmentsRootNow } from '../../../core/services/attachment-store.js';
import { markPageImagesDirty } from '../../../core/services/image-embedding-dirty.js';
import {
  ATTACHMENT_SWEEP_GRACE_MS,
  deleteCandidates,
  emptyDeletedTotals,
} from './attachment-sweep-service.js';

const AGED = new Date(Date.now() - ATTACHMENT_SWEEP_GRACE_MS - 24 * 60 * 60 * 1000);
let root = '';

async function seedAgedFile(key: string, filename: string): Promise<void> {
  await fs.mkdir(path.join(root, key), { recursive: true });
  const p = path.join(root, key, filename);
  await fs.writeFile(p, 'bytes');
  await fs.utimes(p, AGED, AGED);
}

describe('#1349 deleteCandidates — pagesMarkedDirty reports the flag it really raised', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-dirty-contract-'));
    vi.mocked(attachmentsRootNow).mockReturnValue(root);
    vi.mocked(markPageImagesDirty).mockClear();
    vi.mocked(markPageImagesDirty).mockResolvedValue(true);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('counts an owner whose flag went through', async () => {
    await seedAgedFile('90001', 'orphan.png');
    const totals = emptyDeletedTotals();

    await deleteCandidates(
      [{ store: 'confluence', key: '90001', filename: 'orphan.png', bytes: 5, reason: 'orphan_file' }],
      { confluence: new Set(), local: new Set() },
      () => undefined,
      totals,
    );

    expect(totals.files).toBe(1);
    expect(markPageImagesDirty).toHaveBeenCalledWith(7);
    expect(totals.pagesMarkedDirty).toBe(1);
  });

  it('does NOT count an owner whose flag never went through', async () => {
    await seedAgedFile('90001', 'orphan.png');
    vi.mocked(markPageImagesDirty).mockResolvedValue(false);
    const totals = emptyDeletedTotals();

    await deleteCandidates(
      [{ store: 'confluence', key: '90001', filename: 'orphan.png', bytes: 5, reason: 'orphan_file' }],
      { confluence: new Set(), local: new Set() },
      () => undefined,
      totals,
    );

    // The deletion itself still happened and is still counted — only the
    // re-queue claim stands down. Over-reporting `pagesMarkedDirty` would
    // hide a page whose index rows are now stale and whose flag is down.
    expect(totals.files).toBe(1);
    expect(markPageImagesDirty).toHaveBeenCalledWith(7);
    expect(totals.pagesMarkedDirty).toBe(0);
  });
});
