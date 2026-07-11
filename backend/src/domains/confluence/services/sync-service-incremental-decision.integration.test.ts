/**
 * Integration tests for the incremental-vs-full sync decision (#860).
 *
 * `syncSpace` decides between a heavy full sync (`getAllPagesInSpace`) and a
 * light incremental sync (`getModifiedPages`) by reading `spaces.last_synced`:
 * NULL or ≥24h stale → full; <24h → incremental. The ≥24h full-sync backstop
 * is what heals any page the day-granular incremental CQL window misses (e.g. a
 * page edited during a multi-day outage, or a trash-restore that created no new
 * version) — see sync-service.ts comments and docs/architecture/08-flow-sync.md.
 *
 * The bug: the shared space-metadata upsert at the top of `syncSpace` stamped
 * `last_synced = NOW()` in its `ON CONFLICT DO UPDATE` clause, which runs BEFORE
 * the decision reads `last_synced`. So the SELECT always saw "a moment ago" and
 * every already-synced space took the incremental branch forever — the full-sync
 * backstop was dead code. The intended stamp is the end-of-sync UPDATE, which
 * only advances the watermark after a successful run.
 *
 * These tests hit real PostgreSQL via `test-db-helper.ts` (a write-then-read SQL
 * ordering bug cannot be caught by mocking `query`) and drive `__internal.syncSpace`
 * directly with a stub ConfluenceClient that records which listing method was
 * called, rather than spinning up an entire `syncUser` walk. They
 * `describe.skipIf(!dbAvailable)` so contributors without a running test Postgres
 * can still run the rest of the suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

const { __internal } = await import('./sync-service.js');
const { syncSpace } = __internal;

const dbAvailable = await isDbAvailable();

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Minimal ConfluenceClient stub that records which listing branch `syncSpace`
 * took. Both listing methods return an empty page set so the sync body does no
 * per-page work — the test only cares about the incremental-vs-full decision.
 * `getAllPageIds` feeds `detectDeletedPages` (empty → no candidates).
 */
function makeDecisionClient() {
  const calls: string[] = [];
  return {
    calls,
    async getModifiedPages(_since: Date, _spaceKey: string): Promise<unknown[]> {
      calls.push('incremental');
      return [];
    },
    async getAllPagesInSpace(_spaceKey: string): Promise<unknown[]> {
      calls.push('full');
      return [];
    },
    async getAllPageIds(_spaceKey: string): Promise<Set<string>> {
      return new Set();
    },
  };
}

const SPACE_KEY = 'DEV';

const space = {
  key: SPACE_KEY,
  name: 'Development',
  type: 'global',
  status: 'current',
} as const;

/** Seed a spaces row with last_synced backdated by `seconds` (NULL if omitted). */
async function seedSpace(lastSyncedSecondsAgo: number | null): Promise<void> {
  if (lastSyncedSecondsAgo === null) {
    await query(
      `INSERT INTO spaces (space_key, space_name) VALUES ($1, $2)`,
      [SPACE_KEY, 'Development'],
    );
    return;
  }
  await query(
    `INSERT INTO spaces (space_key, space_name, last_synced)
     VALUES ($1, $2, NOW() - make_interval(secs => $3))`,
    [SPACE_KEY, 'Development', lastSyncedSecondsAgo],
  );
}

async function runSyncSpace(client: unknown): Promise<void> {
  await syncSpace(
    client as never,
    'sync-user',
    SPACE_KEY,
    space as never,
    new Date(),
    new Map(),
    'run-1',
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!dbAvailable)('syncSpace incremental-vs-full decision (#860)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  it('runs a FULL sync for a ≥24h-stale space (metadata upsert must not overwrite last_synced)', async () => {
    // A space last completed sync 3 days ago (e.g. a backend/scheduler outage).
    // The metadata upsert at the top of syncSpace must NOT re-stamp last_synced,
    // otherwise the decision reads "a moment ago" and wrongly picks incremental,
    // leaving the outage gap unhealed. This is the regression the #860 fix targets.
    await seedSpace(3 * 24 * 60 * 60);

    const client = makeDecisionClient();
    await runSyncSpace(client);

    expect(client.calls).toEqual(['full']);
  });

  it('runs an INCREMENTAL sync for a <24h-fresh space', async () => {
    await seedSpace(60 * 60); // last synced an hour ago

    const client = makeDecisionClient();
    await runSyncSpace(client);

    expect(client.calls).toEqual(['incremental']);
  });

  it('runs a FULL sync on the first-ever sync (last_synced NULL via the INSERT path)', async () => {
    // No pre-existing row: the upsert INSERTs it with last_synced NULL, so the
    // decision correctly picks full. Pins that the INSERT path never stamps it.
    const client = makeDecisionClient();
    await runSyncSpace(client);

    expect(client.calls).toEqual(['full']);
  });

  it('advances last_synced only via the end-of-sync UPDATE after a completed run', async () => {
    // After a completed sync of a stale space, last_synced must have moved to ~now
    // (the end-of-sync UPDATE), so the NEXT run within 24h picks incremental.
    await seedSpace(3 * 24 * 60 * 60);

    await runSyncSpace(makeDecisionClient());

    const secondClient = makeDecisionClient();
    await runSyncSpace(secondClient);
    expect(secondClient.calls).toEqual(['incremental']);
  });
});
