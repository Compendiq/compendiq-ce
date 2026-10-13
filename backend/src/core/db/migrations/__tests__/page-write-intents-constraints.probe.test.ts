import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();
const SHA = 'b'.repeat(64);
const RUNTIME = 'test-runtime-chain';

/**
 * Behavioural pin on the write-intent ledger AFTER THE FULL MIGRATION CHAIN
 * as `setupTestDb` installs it (120 → 125 → 137), with no migration applied
 * by hand: what an intent row may look like is asserted by inserting rows,
 * not by reading constraint names (a rename is harmless; a widening is not).
 */
async function tryInsert(input: {
  kind: string; pageIds: number[]; recoveryMode?: string; effect: unknown;
}): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    await query(
      `INSERT INTO page_write_intents (runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
       VALUES ($1, $2, NULL, $3::integer[], '{}'::jsonb, $4, $5::jsonb)`,
      [RUNTIME, input.kind, input.pageIds, input.recoveryMode ?? 'remote_terminal_only', JSON.stringify(input.effect)],
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code ?? '' };
  }
}

const rootEffect = (overrides: Record<string, unknown> = {}) => ({
  effectClass: 'remote', parentPageId: null, parentConfluenceId: null, spaceKey: 'DOCS',
  titleSha256: SHA, storageSha256: SHA, initialPolicy: 'none', initialLabels: ['no-ai'], ...overrides,
});

describe.skipIf(!dbAvailable)('page_write_intents ledger after the full migration chain', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    await query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version)
       VALUES ($1, '{"test": true}'::jsonb, 1) ON CONFLICT (runtime_id) DO NOTHING`,
      [RUNTIME],
    );
  });

  it('admits the root Confluence create with trusted initial policy and labels', async () => {
    expect(await tryInsert({ kind: 'pages.create.confluence', pageIds: [], effect: rootEffect() })).toEqual({ ok: true });
  });

  it('refuses an empty target set for every other kind and any malformed root row', async () => {
    expect(await tryInsert({ kind: 'pages.update.confluence', pageIds: [], effect: rootEffect() }))
      .toMatchObject({ ok: false, code: '23514' });
    expect(await tryInsert({ kind: 'page.labels', pageIds: [], effect: rootEffect() }))
      .toMatchObject({ ok: false, code: '23514' });
    expect(await tryInsert({ kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialPolicy: 'no_ai' }) }))
      .toMatchObject({ ok: false, code: '23514' });
    expect(await tryInsert({ kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialLabels: ['', 'x'] }) }))
      .toMatchObject({ ok: false, code: '23514' });
    expect(await tryInsert({ kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialLabels: [1] }) }))
      .toMatchObject({ ok: false, code: '23514' });
    expect(await tryInsert({ kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialLabels: ['y'.repeat(101)] }) }))
      .toMatchObject({ ok: false, code: '23514' });
  });

  it('refuses an effect class / recovery mode that contradicts the kind', async () => {
    expect(await tryInsert({ kind: 'pages.create.confluence', pageIds: [], recoveryMode: 'local_verified', effect: rootEffect({ effectClass: 'local' }) }))
      .toMatchObject({ ok: false, code: '23514' });
    expect(await tryInsert({ kind: 'pages.create.confluence', pageIds: [], recoveryMode: 'remote_conditional', effect: rootEffect() }))
      .toMatchObject({ ok: false, code: '23514' });
  });
});
