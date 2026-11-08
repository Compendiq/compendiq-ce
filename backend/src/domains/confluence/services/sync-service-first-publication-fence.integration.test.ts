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
  createIntentHoldsFence,
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
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'admin') RETURNING id`,
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
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version, ai_policy_enforcement_version)
     VALUES ($1, $2::jsonb, $3, 1)`,
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

  it('defers new restrictions while rollout is closed even when they satisfy the unbound fence', async () => {
    const creator = await user();
    await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Local plan', storage: '<p>l</p>',
      initialPolicy: 'local_only', initialLabels: ['ai-local-only'],
    });
    const page = remotePage({ id: 'cf-strict', title: 'Strict', storage: '<p>s</p>', labels: ['no-ai'] });
    const client = stubClient([page]);
    let attachmentCalls = 0;
    client.getPageAttachments = async () => { attachmentCalls++; return { results: [] }; };
    await expect(__internal.syncPage(client, creator, 'FP', page, new Date(), new Map(),
      { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 }, randomUUID()))
      .rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    expect(attachmentCalls).toBe(0);
    expect(await row('cf-strict')).toBeUndefined();
    await __internal.syncSpace(client, creator, 'FP', undefined, new Date(), new Map(), randomUUID());
    expect(await lastSynced('FP')).toBeNull();
  });

  it.each([1, 2])('defers existing snapshots at version %s without changing rows or advancing the cursor', async (version) => {
    const actor = await user();
    const page = remotePage({ id: 'cf-existing', title: 'Original', storage: '<p>original</p>' });
    await walkOne(actor, 'FP', page);
    const before = await query('SELECT * FROM pages WHERE confluence_id = $1', [page.id]);
    const incoming = remotePage({ id: page.id, title: 'Changed', storage: '<p>changed</p>', labels: ['ops', 'no-ai'] });
    incoming.version.number = version;
    await expect(walkOne(actor, 'FP', incoming)).rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    expect((await query('SELECT * FROM pages WHERE confluence_id = $1', [page.id])).rows).toEqual(before.rows);
    await __internal.syncSpace(stubClient([incoming]), actor, 'FP', undefined, new Date(), new Map(), randomUUID());
    expect(await lastSynced('FP')).toBeNull();
  });

  it('does not let a bound all journal authorize a new upstream restriction', async () => {
    const creator = await user();
    const page = remotePage({ id: 'cf-new-restriction', title: 'Original', storage: '<p>original</p>', labels: ['no-ai'] });
    await expect(walkOne(creator, 'FP', page))
      .rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Original', storage: '<p>original</p>',
      initialPolicy: 'all', initialLabels: ['all-ai'], acknowledgedId: page.id,
    });
    await expect(walkOne(creator, 'FP', page))
      .rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    expect(await row(page.id)).toBeUndefined();
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

  it('does not borrow a bound policy for a substituted snapshot or inactive creator before attachment effects', async () => {
    const creator = await user();
    await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Original', storage: '<p>original</p>',
      initialPolicy: 'none', initialLabels: ['no-ai'], acknowledgedId: 'cf-bound',
    });
    const original = remotePage({ id: 'cf-bound', title: 'Original', storage: '<p>original</p>' });
    const variants = [
      { ...original, title: 'Substituted' },
      { ...original, body: { storage: { value: '<p>changed</p>' } } },
      { ...original, version: { ...original.version, number: 2 } },
      { ...original, ancestors: [{ id: 'different-parent' }] },
    ] as ConfluencePage[];
    for (const page of variants) {
      const client = stubClient([page]);
      let attachmentCalls = 0;
      client.getPageAttachments = async () => { attachmentCalls++; return { results: [] }; };
      await expect(__internal.syncPage(client, creator, 'FP', page, new Date(), new Map(),
        { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 }, randomUUID()))
        .rejects.toBeInstanceOf(FreshPublicationDeferredError);
      expect(attachmentCalls).toBe(0);
      expect(await row('cf-bound')).toBeUndefined();
    }
    await expect(walkOne(creator, 'OTHER', original)).rejects.toBeInstanceOf(FreshPublicationDeferredError);
    await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [creator]);
    await expect(walkOne(creator, 'FP', original)).rejects.toBeInstanceOf(FreshPublicationDeferredError);
    expect(await row('cf-bound')).toBeUndefined();
  });

  it('does not turn contradictory bound journal labels into restrictive recovery authority', async () => {
    const creator = await user();
    const intentId = await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Legacy', storage: '<p>legacy</p>',
      initialPolicy: 'all', initialLabels: [], acknowledgedId: 'cf-legacy',
    });
    await setEffectPolicy(intentId, 'all', ['no-ai', 'local-ai-only']);
    const page = remotePage({ id: 'cf-legacy', title: 'Legacy', storage: '<p>legacy</p>' });
    const client = stubClient([page]);
    let attachmentCalls = 0;
    client.getPageAttachments = async () => { attachmentCalls++; return { results: [] }; };
    await expect(__internal.syncPage(client, creator, 'FP', page, new Date(), new Map(),
      { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 }, randomUUID()))
      .rejects.toMatchObject({ reason: 'unbound_create' });
    expect(attachmentCalls).toBe(0);
    expect(await row(page.id)).toBeUndefined();
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

  it('SQL cursor predicate and TS fresh-row decoder agree on every stored receipt/label shape (decoder-parity table)', async () => {
    const creator = await user();
    const other = await user();
    // 880001 is a genuinely existing, already-imported OTHER page.
    await walkOne(other, 'OTHER', remotePage({ id: '880001', title: 'Other', storage: '<p>o</p>' }));
    const intentId = await pendingRootCreate({
      actor: creator, spaceKey: 'FP', title: 'Plan', storage: '<p>r</p>',
      initialPolicy: 'none', initialLabels: ['no-ai'],
    });

    type Case = { name: string; terminal: Record<string, unknown> | null; policy: string; labels: unknown[]; holds: boolean };
    const ok = { confluenceId: '880001', accepted: true, expectedVersion: 1 };
    const table: Case[] = [
      // Receipt identity: valid positive controls bind (fence released) …
      { name: 'valid minimal receipt', terminal: ok, policy: 'none', labels: ['no-ai'], holds: false },
      { name: 'valid full receipt', terminal: { ...ok, observedConfluenceId: '880001', version: 1 }, policy: 'none', labels: ['no-ai'], holds: false },
      { name: 'valid receipt, numeric-looking expectedVersion 2', terminal: { ...ok, expectedVersion: 2, version: 2 }, policy: 'none', labels: ['no-ai'], holds: false },
      // … malformed identities stay unbound.
      { name: 'observedConfluenceId as JSON number', terminal: { ...ok, observedConfluenceId: 880001 }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'observedConfluenceId as JSON null', terminal: { ...ok, observedConfluenceId: null }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'observedConfluenceId other page', terminal: { ...ok, observedConfluenceId: '880002' }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'version as JSON string', terminal: { ...ok, version: '1' }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'version mismatch', terminal: { ...ok, version: 2 }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'expectedVersion as string', terminal: { ...ok, expectedVersion: '1' }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'expectedVersion 0', terminal: { ...ok, expectedVersion: 0 }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'expectedVersion fractional', terminal: { ...ok, expectedVersion: 1.5 }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'expectedVersion unsafe', terminal: { ...ok, expectedVersion: 9007199254740992 }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'accepted false / version 0', terminal: { confluenceId: '880001', accepted: false, expectedVersion: 0 }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'accepted as string', terminal: { ...ok, accepted: 'true' }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'confluenceId as number', terminal: { ...ok, confluenceId: 880001 }, policy: 'none', labels: ['no-ai'], holds: true },
      { name: 'empty confluenceId', terminal: { ...ok, confluenceId: '' }, policy: 'none', labels: ['no-ai'], holds: true },
      // Label decoding on an unbound intent: restrictive spelling with any JS-trimmed whitespace holds.
      { name: 'all + no-ai', terminal: null, policy: 'all', labels: ['no-ai'], holds: true },
      { name: 'all + trailing TAB', terminal: null, policy: 'all', labels: ['no-ai\t'], holds: true },
      { name: 'all + leading NBSP + ideographic space', terminal: null, policy: 'all', labels: ['\u00a0No-AI\u3000'], holds: true },
      { name: 'all + CRLF', terminal: null, policy: 'all', labels: ['ai:none\r\n'], holds: true },
      { name: 'all + BOM', terminal: null, policy: 'all', labels: ['\ufefflocal_only'], holds: true },
      { name: 'all + inner space is an ordinary label', terminal: null, policy: 'all', labels: ['no -ai'], holds: false },
      { name: 'all + ordinary labels', terminal: null, policy: 'all', labels: ['ops', ' all-ai '], holds: false },
      { name: 'all + empty labels', terminal: null, policy: 'all', labels: [], holds: false },
      { name: 'local_only clean', terminal: null, policy: 'local_only', labels: [], holds: true },
    ];

    for (const c of table) {
      await query(
        `UPDATE page_write_intents
            SET effect = effect || jsonb_build_object('initialPolicy', $2::text, 'initialLabels', $3::jsonb),
                remote_terminal_result = $4::jsonb,
                remote_effects_completed_at = CASE WHEN $4::jsonb IS NULL THEN NULL ELSE NOW() END
          WHERE id = $1`,
        [intentId, c.policy, JSON.stringify(c.labels), c.terminal === null ? null : JSON.stringify(c.terminal)],
      );
      const stored = await query<{
        effect: Record<string, unknown>;
        remote_terminal_result: Record<string, unknown> | null;
        remote_effects_completed_at: Date | null;
      }>('SELECT effect, remote_terminal_result, remote_effects_completed_at FROM page_write_intents WHERE id = $1', [intentId]);
      const row0 = stored.rows[0]!;
      expect({ name: c.name, sql: await fenceActive() }).toEqual({ name: c.name, sql: c.holds });
      expect({ name: c.name, ts: createIntentHoldsFence(row0) }).toEqual({ name: c.name, ts: c.holds });
      // Fresh-row admission (walker) agrees with the cursor: an unrelated
      // weaker import is deferred iff the SQL predicate holds.
      const fresh = walkOne(creator, 'FP', remotePage({ id: `cf-${table.indexOf(c)}`, title: 'Fresh', storage: '<p>f</p>' }));
      if (c.holds) {
        await expect(fresh).rejects.toBeInstanceOf(FreshPublicationDeferredError);
        // Another principal's EMPTY listing cannot advance the shared cursor.
        await __internal.syncSpace(stubClient([]), other, 'FP', undefined, new Date(), new Map(), randomUUID());
        expect({ name: c.name, cursor: await lastSynced('FP') }).toEqual({ name: c.name, cursor: null });
      } else {
        await expect(fresh).resolves.toMatchObject({ pagesCreated: 1 });
      }
      // The unrelated existing page is never rewritten by any receipt shape.
      const unrelated = await row('880001');
      expect(unrelated!.ai_policy).toBe(await resolveIngestionAiPolicy({ userId: other, spaceKey: 'OTHER', labels: [] }));
    }
  });

  it('retains a deferred restriction when the upstream label is subsequently removed', async () => {
    const actor = await user();
    const page = remotePage({ id: 'cf-deferred', title: 'Deferred', storage: '<p>x</p>', labels: ['no-ai'] });
    await expect(walkOne(actor, 'FP', page)).rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    page.metadata!.labels!.results = [];
    page.version.number = 2;
    await expect(walkOne(actor, 'FP', page)).rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    const pending = await query(`SELECT policy, observed_revision, applied_at FROM ai_policy_deferred_ingestion
      WHERE source_id=$1 ORDER BY observed_revision`, [page.id]);
    expect(pending.rows).toEqual([
      { policy: 'none', observed_revision: '1', applied_at: null },
      { policy: 'none', observed_revision: '2', applied_at: null },
    ]);
    expect(await row(page.id)).toBeUndefined();
  });

  it('rolls back publication if the in-transaction derived-state purge fails', async () => {
    const actor = await user();
    await pendingRootCreate({ actor, spaceKey: 'FP', title: 'Atomic', storage: '<p>x</p>',
      initialPolicy: 'none', initialLabels: ['no-ai'], acknowledgedId: 'cf-atomic' });
    await query(`CREATE FUNCTION fail_policy_purge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'purge fault'; END $$;
      CREATE TRIGGER fail_policy_purge BEFORE DELETE ON page_embeddings
      FOR EACH STATEMENT EXECUTE FUNCTION fail_policy_purge()`);
    try {
      await expect(walkOne(actor, 'FP', remotePage({ id: 'cf-atomic', title: 'Atomic', storage: '<p>x</p>' })))
        .rejects.toThrow('purge fault');
      expect(await row('cf-atomic')).toBeUndefined();
    } finally {
      await query('DROP TRIGGER fail_policy_purge ON page_embeddings; DROP FUNCTION fail_policy_purge()');
    }
    await walkOne(actor, 'FP', remotePage({ id: 'cf-atomic', title: 'Atomic', storage: '<p>x</p>' }));
    expect(await row('cf-atomic')).toMatchObject({ ai_policy: 'none', embedding_status: 'policy_blocked' });
  });

  it('rolls back a neutral fresh row when a restrictive observation arrives after preflight', async () => {
    const actor = await user();
    const page = remotePage({ id: 'cf-late-observation', title: 'Late', storage: '<p>x</p>' });
    const client = stubClient([page]);
    client.getPageAttachments = async () => {
      await query(`INSERT INTO ai_policy_deferred_ingestion
        (id, source, source_scope, source_id, observed_revision, policy, observed_by)
        VALUES ($1, 'confluence', 'shared', $2, 'earlier', 'none', $3)
        ON CONFLICT DO NOTHING`, [randomUUID(), page.id, actor]);
      return { results: [] };
    };
    await expect(__internal.syncPage(client, actor, 'FP', page, new Date(), new Map(),
      { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 }, randomUUID()))
      .rejects.toMatchObject({ reason: 'ai_policy_enforcement_unavailable' });
    expect(await row(page.id)).toBeUndefined();
    expect((await query(`SELECT applied_at, applied_page_id FROM ai_policy_deferred_ingestion
      WHERE source_id=$1`, [page.id])).rows).toEqual([{ applied_at: null, applied_page_id: null }]);
  });

  it('a page with no pending create is seeded by the ingestion rule alone', async () => {
    const creator = await user();
    await walkOne(creator, 'FP', remotePage({ id: 'cf-3', title: 'Ordinary', storage: '<p>x</p>' }));
    const ingestionDefault = await resolveIngestionAiPolicy({ userId: creator, spaceKey: 'FP', labels: [] });
    expect(await row('cf-3')).toMatchObject({ ai_policy: ingestionDefault, labels: ['all-ai'] });
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
