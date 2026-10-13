/**
 * #281 review — GLOBAL first-publication fence for the Confluence sync walker.
 *
 * A creator's restrictive create is dispatched to Confluence BEFORE its local
 * row exists; until the durable acknowledgment binds an exact `confluenceId`,
 * the admitted policy lives only in the pending `pages.create.confluence`
 * intent and NO heuristic (space, title, creator) can tell which fresh page
 * the walker sees is that creation. The walker therefore:
 *
 *   * DEFERS every weaker fresh import, in every space, while an unbound
 *     dispatched create (or outbound relocation) is pending — counted apart
 *     from failures, with the shared `spaces.last_synced` cursor held and no
 *     `sync.completed` emitted;
 *   * seeds a row bound by an exact acknowledged id no looser than the
 *     creator's durable statement, with its canonical label;
 *   * leaves unrelated bound ids and `all` statements inert.
 *
 * Real PostgreSQL; only the Confluence HTTP client is stubbed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { PAGE_WRITER_ENFORCEMENT_VERSION } from '../../../core/services/page-baseline-governance.js';
import {
  boundConfluenceId,
  FRESH_PUBLICATION_FENCE_ACTIVE_SQL,
  FreshPublicationDeferredError,
  resolveIngestionAiPolicy,
} from '../../../core/services/ai-policy-ingestion.js';
import type { ConfluenceClient, ConfluencePage } from './confluence-client.js';
import { __internal } from './sync-service.js';

const dbAvailable = await isDbAvailable();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function user(): Promise<string> {
  const n = randomUUID().slice(0, 8);
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id`,
    [`fp-${n}`, `fp-${n}@test.invalid`],
  );
  return r.rows[0]!.id;
}

/** A pending root create on a live runtime: dispatched; acknowledged only when `acknowledgedId` is given. */
async function pendingRootCreate(input: {
  actor: string; spaceKey: string; title: string; storage: string;
  initialPolicy: string; initialLabels: string[]; acknowledgedId?: string;
}): Promise<string> {
  const runtimeId = `creator-${randomUUID()}`;
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version)
     VALUES ($1, $2::jsonb, $3)`,
    [runtimeId, JSON.stringify({ host: 'creator', pid: 1, startedAt: new Date().toISOString() }), PAGE_WRITER_ENFORCEMENT_VERSION],
  );
  const id = randomUUID();
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
        effect_started_at, remote_effect_started_at, remote_effects_completed_at, remote_terminal_result)
     VALUES ($1, $2, 'pages.create.confluence', $3, ARRAY[]::integer[], '{}'::jsonb, 'remote_terminal_only', $4::jsonb,
             NOW(), NOW(), CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() END,
             CASE WHEN $5::text IS NULL THEN NULL ELSE jsonb_build_object('confluenceId', $5::text, 'accepted', TRUE, 'expectedVersion', 1) END)`,
    [
      id, runtimeId, input.actor,
      JSON.stringify({
        effectClass: 'remote', parentPageId: null, parentConfluenceId: null, spaceKey: input.spaceKey,
        titleSha256: sha(input.title), storageSha256: sha(input.storage),
        initialPolicy: input.initialPolicy, initialLabels: input.initialLabels,
      }),
      input.acknowledgedId ?? null,
    ],
  );
  return id;
}

async function bindAcknowledgment(intentId: string, confluenceId: string): Promise<void> {
  await query(
    `UPDATE page_write_intents
        SET remote_effects_completed_at = NOW(),
            remote_terminal_result = jsonb_build_object('confluenceId', $2::text, 'accepted', TRUE, 'expectedVersion', 1)
      WHERE id = $1`,
    [intentId, confluenceId],
  );
}

/** Malformed-journal fault injection: schema-valid but INVALID terminal metadata. */
async function injectInvalidReceipt(intentId: string, terminal: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE page_write_intents
        SET remote_effects_completed_at = NOW(), remote_terminal_result = $2::jsonb
      WHERE id = $1`,
    [intentId, JSON.stringify(terminal)],
  );
}

async function setEffectPolicy(intentId: string, initialPolicy: string, initialLabels: string[]): Promise<void> {
  await query(
    `UPDATE page_write_intents
        SET effect = effect || jsonb_build_object('initialPolicy', $2::text, 'initialLabels', $3::jsonb)
      WHERE id = $1`,
    [intentId, initialPolicy, JSON.stringify(initialLabels)],
  );
}

async function fenceActive(): Promise<boolean> {
  const r = await query<{ active: boolean }>(`SELECT ${FRESH_PUBLICATION_FENCE_ACTIVE_SQL} AS active`);
  return r.rows[0]!.active;
}

function remotePage(input: { id: string; title: string; storage: string; labels?: string[] }): ConfluencePage {
  return {
    id: input.id,
    title: input.title,
    status: 'current',
    version: { number: 1, when: '2026-10-13T00:00:00Z', by: { displayName: 'Creator' } },
    body: { storage: { value: input.storage } },
    metadata: { labels: { results: (input.labels ?? []).map((name) => ({ name })) } },
    ancestors: [],
  } as unknown as ConfluencePage;
}

function stubClient(pages: ConfluencePage[]): ConfluenceClient {
  return {
    getPage: async (id: string) => {
      const page = pages.find((p) => p.id === id);
      if (!page) throw new Error(`unexpected page ${id}`);
      return page;
    },
    getPageAttachments: async () => ({ results: [] }),
    getAllPagesInSpace: async () => pages,
    getModifiedPages: async () => pages,
    getAllPageIds: async () => new Set(pages.map((p) => p.id)),
  } as unknown as ConfluenceClient;
}

async function row(confluenceId: string) {
  const r = await query<{ ai_policy: string; labels: string[]; embedding_status: string }>(
    `SELECT ai_policy, labels, embedding_status FROM pages WHERE confluence_id = $1`,
    [confluenceId],
  );
  return r.rows[0];
}

async function lastSynced(spaceKey: string): Promise<Date | null> {
  const r = await query<{ last_synced: Date | null }>('SELECT last_synced FROM spaces WHERE space_key = $1', [spaceKey]);
  return r.rows[0]?.last_synced ?? null;
}

async function walkOne(userId: string, spaceKey: string, page: ConfluencePage) {
  const counts = { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 };
  await __internal.syncPage(stubClient([page]), userId, spaceKey, page, new Date(), new Map(), counts, randomUUID());
  return counts;
}

describe.skipIf(!dbAvailable)('sync walker first-publication fence (#281)', () => {
  beforeAll(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('FP', 'FP'), ('OTHER', 'OTHER')`);
  });

  it('defers a weaker fresh import in ANY space while a dispatched restrictive create is unbound', async () => {
    const creator = await user();
    const walker = await user();
    await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Secret plan', storage: '<p>restricted</p>',
      initialPolicy: 'none', initialLabels: ['no-ai'],
      // no acknowledgedId: the reply was lost
    });
    // A different space, a different title, a different principal: still fenced,
    // because the acknowledged page could have been moved before the reply.
    await expect(
      walkOne(walker, 'OTHER', remotePage({ id: 'cf-moved', title: 'Something else', storage: '<p>x</p>' })),
    ).rejects.toBeInstanceOf(FreshPublicationDeferredError);
    expect(await row('cf-moved')).toBeUndefined();
  });

  it('does not fence an import that is already as strict as the unbound statement', async () => {
    const creator = await user();
    await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Local plan', storage: '<p>l</p>',
      initialPolicy: 'local_only', initialLabels: ['ai-local-only'],
    });
    const counts = await walkOne(creator, 'FP', remotePage({ id: 'cf-strict', title: 'Strict', storage: '<p>s</p>', labels: ['no-ai'] }));
    expect(counts.pagesCreated).toBe(1);
    expect(await row('cf-strict')).toMatchObject({ ai_policy: 'none' });
  });

  it('seeds a row bound by the exact acknowledged id no looser than the durable statement, with its canonical label', async () => {
    const creator = await user();
    const storage = '<p>restricted body</p>';
    await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Secret plan', storage,
      initialPolicy: 'none', initialLabels: ['no-ai', 'ops'], acknowledgedId: 'cf-1',
    });
    // Same title, acknowledged as a DIFFERENT page: inert for cf-1.
    await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Secret plan', storage,
      initialPolicy: 'local_only', initialLabels: ['ai-local-only'], acknowledgedId: 'cf-other',
    });
    const counts = await walkOne(creator, 'FP', remotePage({ id: 'cf-1', title: 'Secret plan', storage, labels: ['team'] }));
    expect(counts.pagesCreated).toBe(1);
    const seeded = await row('cf-1');
    expect(seeded).toMatchObject({ ai_policy: 'none', embedding_status: 'policy_blocked' });
    expect([...seeded!.labels].sort()).toEqual(['no-ai', 'ops', 'team']);
  });

  it('boundConfluenceId accepts only a validated receipt (positive control + invalid shapes)', () => {
    const now = new Date();
    expect(boundConfluenceId({ confluenceId: 'cf-ok', accepted: true, expectedVersion: 1 }, now)).toBe('cf-ok');
    expect(boundConfluenceId(
      { confluenceId: 'cf-ok', accepted: true, expectedVersion: 1, observedConfluenceId: 'cf-ok', version: 1 }, now,
    )).toBe('cf-ok');
    // No completion timestamp: never bound regardless of the receipt body.
    expect(boundConfluenceId({ confluenceId: 'cf-ok', accepted: true, expectedVersion: 1 }, null)).toBeNull();
    expect(boundConfluenceId(null, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: '' , accepted: true, expectedVersion: 1 }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf-x', accepted: false, expectedVersion: 0 }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf-x', expectedVersion: 1 }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf-x', accepted: true, expectedVersion: 0 }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf-x', accepted: true, expectedVersion: 1.5 }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf-x', accepted: true, expectedVersion: 1, observedConfluenceId: 'cf-y' }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf-x', accepted: true, expectedVersion: 1, version: 2 }, now)).toBeNull();
  });

  it('invalid terminal metadata naming another existing page does NOT bind: the global fence and the cursor hold', async () => {
    const creator = await user();
    const other = await user();
    // An unrelated page that genuinely exists and is already imported.
    await walkOne(other, 'OTHER', remotePage({ id: 'cf-existing', title: 'Existing', storage: '<p>e</p>' }));
    expect(await row('cf-existing')).toBeDefined();

    const intentId = await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Secret plan', storage: '<p>r</p>',
      initialPolicy: 'none', initialLabels: ['no-ai'],
    });
    // Malformed-journal fault injection: schema-valid, invalid acknowledgment
    // (not accepted, version 0) pointing at the other page, with a completion
    // timestamp so migration-120 CHECK 5 admits it.
    await injectInvalidReceipt(intentId, { confluenceId: 'cf-existing', accepted: false, expectedVersion: 0 });
    expect(await fenceActive()).toBe(true);

    // Fresh-row admission: a weaker import is still deferred everywhere.
    const page = remotePage({ id: 'cf-new', title: 'Secret plan', storage: '<p>r</p>' });
    await expect(walkOne(creator, 'FP', page)).rejects.toBeInstanceOf(FreshPublicationDeferredError);
    expect(await row('cf-new')).toBeUndefined();

    // Cursor admission: another principal's EMPTY listing cannot advance.
    await __internal.syncSpace(stubClient([]), other, 'FP', undefined, new Date(), new Map(), randomUUID());
    expect(await lastSynced('FP')).toBeNull();

    // The unrelated page keeps its own policy: the invalid receipt is inert for it.
    const ingestionDefault = await resolveIngestionAiPolicy({ userId: other, spaceKey: 'OTHER', labels: [] });
    expect(await row('cf-existing')).toMatchObject({ ai_policy: ingestionDefault });

    // Positive control: a VALID receipt binds the exact id and releases the fence.
    await bindAcknowledgment(intentId, 'cf-new');
    expect(await fenceActive()).toBe(false);
    await __internal.syncSpace(stubClient([page]), creator, 'FP', undefined, new Date(), new Map(), randomUUID());
    expect(await row('cf-new')).toMatchObject({ ai_policy: 'none', labels: ['no-ai'] });
    expect(await lastSynced('FP')).not.toBeNull();
  });

  it('initialPolicy=all with a restrictive label is a restrictive statement for BOTH cursor and fresh-row admission', async () => {
    const creator = await user();
    const other = await user();
    const intentId = await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Plan', storage: '<p>r</p>',
      initialPolicy: 'all', initialLabels: ['no-ai'],
    });
    expect(await fenceActive()).toBe(true);
    const page = remotePage({ id: 'cf-all-noai', title: 'Plan', storage: '<p>r</p>' });
    await expect(walkOne(creator, 'FP', page)).rejects.toBeInstanceOf(FreshPublicationDeferredError);
    await __internal.syncSpace(stubClient([]), other, 'FP', undefined, new Date(), new Map(), randomUUID());
    expect(await lastSynced('FP')).toBeNull();

    // Non-string labels cannot exist durably: migration 137's
    // `page_write_intents_effect_policy_check` refuses them at the write.
    await expect(query(
      `UPDATE page_write_intents SET effect = effect || '{"initialPolicy":"all","initialLabels":[1]}'::jsonb WHERE id = $1`,
      [intentId],
    )).rejects.toMatchObject({ constraint: 'page_write_intents_effect_policy_check' });
    expect(await fenceActive()).toBe(true);

    // The frozen TS spelling `local-ai-only` (not in ai_policy_from_labels'
    // regex set) is restrictive for the cursor too.
    await setEffectPolicy(intentId, 'all', ['Local-AI-Only ']);
    expect(await fenceActive()).toBe(true);

    // A genuine `all` statement with no restrictive label is inert.
    await setEffectPolicy(intentId, 'all', ['ops']);
    expect(await fenceActive()).toBe(false);
    await __internal.syncSpace(stubClient([]), other, 'FP', undefined, new Date(), new Map(), randomUUID());
    expect(await lastSynced('FP')).not.toBeNull();
  });

  it('a page with no pending create is seeded by the ingestion rule alone', async () => {
    const creator = await user();
    await walkOne(creator, 'FP', remotePage({ id: 'cf-3', title: 'Ordinary', storage: '<p>x</p>' }));
    const ingestionDefault = await resolveIngestionAiPolicy({ userId: creator, spaceKey: 'FP', labels: [] });
    expect(await row('cf-3')).toMatchObject({ ai_policy: ingestionDefault, labels: [] });
  });

  it('a space walk counts the deferral apart from failures, holds the cursor, and resumes once the id is bound', async () => {
    const creator = await user();
    const intentId = await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Secret plan', storage: '<p>r</p>',
      initialPolicy: 'none', initialLabels: ['no-ai'],
    });
    const page = remotePage({ id: 'cf-late', title: 'Secret plan', storage: '<p>r</p>' });
    await __internal.syncSpace(stubClient([page]), creator, 'FP', undefined, new Date(), new Map(), randomUUID());
    expect(await row('cf-late')).toBeUndefined();
    expect(await lastSynced('FP')).toBeNull();

    // An EMPTY listing by another principal still cannot advance the shared cursor.
    const other = await user();
    await __internal.syncSpace(stubClient([]), other, 'FP', undefined, new Date(), new Map(), randomUUID());
    expect(await lastSynced('FP')).toBeNull();

    await bindAcknowledgment(intentId, 'cf-late');
    await __internal.syncSpace(stubClient([page]), creator, 'FP', undefined, new Date(), new Map(), randomUUID());
    expect(await row('cf-late')).toMatchObject({ ai_policy: 'none', labels: ['no-ai'] });
    expect(await lastSynced('FP')).not.toBeNull();
  });
});
