/**
 * Issue #282 — the article AI policy at retrieval time, against REAL Postgres.
 *
 * Every rule here is a rule about SQL — the predicate inside each leg, the
 * derived-arm exclusion, the pin's WHERE, the sibling window's join — or
 * about migration 135's triggers (the page revision bump, the provider
 * locality reset on an endpoint edit). A mocked pool would measure the mock.
 *
 * Only the model boundaries are stubbed: the embedding call, the rerank
 * HTTP client, and the use-case resolvers (the rerank one points at a REAL
 * `llm_providers` row so the locality decoder reads real columns).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import pgvector from 'pgvector';

function fakeVec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
}

const RERANK_PROVIDER = '33333333-3333-3333-3333-333333333333';
const rerankState = { assigned: false, calls: 0 };

vi.mock('./openai-compatible-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openai-compatible-client.js')>()),
  generateEmbedding: vi.fn(async () => [fakeVec(7)]),
}));
vi.mock('./rerank-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rerank-client.js')>()),
  rerank: vi.fn(async (_cfg: unknown, _model: unknown, _q: unknown, docs: string[]) => {
    rerankState.calls++;
    return docs.map((_, i) => ({ index: i, relevanceScore: 1 - i * 0.01 }));
  }),
}));
vi.mock('./llm-provider-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llm-provider-resolver.js')>()),
  resolveUsecase: vi.fn(async () => ({
    config: {
      providerId: 'stub', id: 'stub', name: 'stub', baseUrl: '', apiKey: null,
      authType: 'none', verifySsl: true, defaultModel: 'stub',
    },
    model: 'stub',
  })),
  resolveRerankUsecase: vi.fn(async () => (rerankState.assigned
    ? {
        config: {
          providerId: RERANK_PROVIDER, id: RERANK_PROVIDER, name: 'rr', baseUrl: '', apiKey: null,
          authType: 'none', verifySsl: true, defaultModel: 'rr',
        },
        model: 'rr',
      }
    : null)),
}));

const { hybridSearch, keywordSearch, vectorSearch, flushSearchAnalytics } = await import('./rag-service.js');
const {
  aiPolicyPredicate, derivedArmPredicate, pageAdmittedFor, rowAdmittedFor,
  readPagePolicies, provenancePagesStillAdmitted,
} = await import('./ai-policy-retrieval.js');
const { loadProviderMetadata } = await import('./ai-policy-admission.js');
const { policyRevisionsCacheComponent, buildRagCacheKey } = await import('./llm-cache.js');
const {
  invalidateRagFetchWidthCache,
  invalidateRagContextCharsCache,
  invalidateRagPinIdentifiersCache,
} = await import('../../../core/services/admin-settings-service.js');

const USER = '11111111-1111-1111-1111-111111111111';
const SPACE = 'OPS';
type Policy = 'all' | 'local_only' | 'none';

const EXTERNAL = { purpose: 'ai', destinationLocality: 'external' } as const;
const LOCAL = { purpose: 'ai', destinationLocality: 'local' } as const;
const HUMAN = { purpose: 'human' } as const;

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('#282 — article AI policy in retrieval (real Postgres)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 60_000);
  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await flushSearchAnalytics();
    invalidateRagFetchWidthCache();
    invalidateRagContextCharsCache();
    invalidateRagPinIdentifiersCache();
    rerankState.assigned = false;
    rerankState.calls = 0;
    await truncateAllTables();
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions)
       VALUES ('viewer', 'Viewer', TRUE, ARRAY['read']) ON CONFLICT (name) DO NOTHING`,
    );
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, 'u1', 'u1@test', 'user', 'x') ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [SPACE]);
    const role = await query<{ id: number }>(`SELECT id FROM roles WHERE name = 'viewer'`);
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3) ON CONFLICT DO NOTHING`,
      [SPACE, USER, role.rows[0]!.id],
    );
  });

  async function seedPage(title: string, bodyText: string, policy: Policy): Promise<number> {
    const r = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, ai_policy)
       VALUES ($1, 'confluence', $2, $3, $4, '', '', $5) RETURNING id`,
      [`cid-${title.replace(/\W+/g, '-')}`, SPACE, title, bodyText, policy],
    );
    return r.rows[0]!.id;
  }

  async function seedChunk(pageId: number, chunkIndex: number, chunkText: string, opts: { derived?: boolean; seed?: number } = {}) {
    const metadata = opts.derived
      ? {
          source: 'image_analysis', section_title: '[Image: x.png — screenshot]',
          attachment_source: 'confluence', attachment_key: 'x.png', content_hash: 'sha256:x',
          analysis_id: 1, analysis_version: 1, part: 1, parts: 1,
        }
      : { section_title: 'Body' };
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [pageId, chunkIndex, chunkText, pgvector.toSql(fakeVec(opts.seed ?? 7)), JSON.stringify(metadata)],
    );
  }

  /** One page per policy, the same searchable token in prose and in an embedded chunk. */
  async function seedMatrix(): Promise<Record<Policy, number>> {
    const out = {} as Record<Policy, number>;
    for (const policy of ['all', 'local_only', 'none'] as const) {
      const text = `Rotate the gateway token every quarter (${policy}).`;
      out[policy] = await seedPage(`Runbook ${policy}`, text, policy);
      await seedChunk(out[policy], 0, text);
    }
    return out;
  }

  async function seedProvider(id: string, locality: 'local' | 'external'): Promise<void> {
    await query(
      `INSERT INTO llm_providers (id, name, base_url, auth_type, verify_ssl)
       VALUES ($1::uuid, 'p', 'http://localhost:1', 'none', TRUE)`,
      [id],
    );
    if (locality === 'local') {
      await query(
        `UPDATE llm_providers
            SET locality = 'local', locality_declared_at = NOW(), locality_declared_by = $2::uuid,
                locality_config_revision = config_revision
          WHERE id = $1::uuid`,
        [id, USER],
      );
    }
  }

  const ids = (rows: ReadonlyArray<{ pageId: number }>) => [...new Set(rows.map((r) => r.pageId))].sort((a, b) => a - b);

  // ── Predicate fragments: a closed set, no parameters, positive membership ─

  it('renders the purposes as parameter-free POSITIVE membership tests, failing closed by default', () => {
    expect(aiPolicyPredicate(HUMAN)).toBe('');
    expect(aiPolicyPredicate(LOCAL)).toBe(" AND cp.ai_policy IN ('all', 'local_only')");
    expect(aiPolicyPredicate(EXTERNAL)).toBe(" AND cp.ai_policy IN ('all')");
    expect(aiPolicyPredicate()).toBe(aiPolicyPredicate(EXTERNAL));
    // Never `<> 'none'`: an unknown value is not admitted by accident.
    expect(aiPolicyPredicate(LOCAL)).not.toContain('<>');
    expect(derivedArmPredicate(HUMAN, 'x')).toBe(" AND x.ai_policy IN ('all', 'local_only')");
    expect(pageAdmittedFor('local_only', 'external')).toBe(false);
    expect(pageAdmittedFor('local_only', 'local')).toBe(true);
    expect(pageAdmittedFor('none', 'local')).toBe(false);
    expect(rowAdmittedFor({}, 'local')).toBe(false);
  });

  // ── Keyword leg ───────────────────────────────────────────────────────────

  it('keyword leg: external sees `all`; local sees `all`+`local_only`; a human sees everything; omitted = external', async () => {
    const pages = await seedMatrix();

    expect(ids(await keywordSearch(USER, 'gateway token', 10, { aiPolicy: EXTERNAL }))).toEqual([pages.all]);
    const local = await keywordSearch(USER, 'gateway token', 10, { aiPolicy: LOCAL });
    expect(ids(local)).toEqual([pages.all, pages.local_only].sort((a, b) => a - b));
    expect(ids(await keywordSearch(USER, 'gateway token', 10, { aiPolicy: HUMAN })))
      .toEqual([pages.all, pages.local_only, pages.none].sort((a, b) => a - b));
    expect(ids(await keywordSearch(USER, 'gateway token', 10))).toEqual([pages.all]);

    // Every row carries the policy + content-revision columns its own query selected.
    for (const r of local) {
      expect(['all', 'local_only']).toContain(r.aiPolicy);
      expect(r.aiPolicyRevision).toBe(0);
      expect(Number.isInteger(r.contentRevision)).toBe(true);
      expect(r.contentRevision!).toBeGreaterThanOrEqual(0);
    }
  });

  it('keyword leg: a `none` page\'s DERIVED chunk never surfaces, even to a human reader', async () => {
    const pageId = await seedPage('Capture', 'Prose that does not mention the code.', 'none');
    await seedChunk(pageId, 1, 'Console capture text: payment gateway returned ERR-4711.', { derived: true });

    expect(await keywordSearch(USER, 'ERR-4711', 10, { aiPolicy: HUMAN })).toHaveLength(0);

    await query(`UPDATE pages SET ai_policy = 'local_only' WHERE id = $1`, [pageId]);
    expect(ids(await keywordSearch(USER, 'ERR-4711', 10, { aiPolicy: HUMAN }))).toEqual([pageId]);
    // …but still not to an external model.
    expect(await keywordSearch(USER, 'ERR-4711', 10, { aiPolicy: EXTERNAL })).toHaveLength(0);
  });

  it('keyword leg: a `none` page admitted by its AUTHORED text never resolves to its derived chunk', async () => {
    // The page is a human hit on prose; the LATERAL must not pick the
    // derived chunk as the representative text just because it ranks higher.
    const pageId = await seedPage('Mixed', 'Authored prose about the gateway token.', 'none');
    await seedChunk(pageId, 0, 'Authored prose about the gateway token.');
    await seedChunk(pageId, 1, 'gateway token gateway token gateway token (image)', { derived: true });

    const rows = await keywordSearch(USER, 'gateway token', 10, { aiPolicy: HUMAN });
    expect(ids(rows)).toEqual([pageId]);
    expect(rows[0]!.derived).toBeUndefined();
    expect(rows[0]!.chunkText).toContain('Authored prose');
  });

  // ── Vector leg ────────────────────────────────────────────────────────────

  it('vector leg: applies the same matrix inside the query and selects the policy columns', async () => {
    const pages = await seedMatrix();
    expect(ids(await vectorSearch(USER, fakeVec(7), 10, { aiPolicy: EXTERNAL }))).toEqual([pages.all]);
    expect(ids(await vectorSearch(USER, fakeVec(7), 10, { aiPolicy: LOCAL })))
      .toEqual([pages.all, pages.local_only].sort((a, b) => a - b));
    expect(ids(await vectorSearch(USER, fakeVec(7), 10, { aiPolicy: HUMAN })))
      .toEqual([pages.all, pages.local_only, pages.none].sort((a, b) => a - b));
    expect(ids(await vectorSearch(USER, fakeVec(7), 10))).toEqual([pages.all]);
    const rows = await vectorSearch(USER, fakeVec(7), 10, { aiPolicy: HUMAN });
    expect(rows.find((r) => r.pageId === pages.none)!.aiPolicy).toBe('none');
  });

  it('vector leg: a `none` page\'s derived chunk is excluded even for a human', async () => {
    const pageId = await seedPage('Screens', 'nothing here', 'none');
    await seedChunk(pageId, 0, 'derived description', { derived: true, seed: 7 });
    expect(await vectorSearch(USER, fakeVec(7), 10, { aiPolicy: HUMAN })).toHaveLength(0);
    await query(`UPDATE pages SET ai_policy = 'all' WHERE id = $1`, [pageId]);
    expect(ids(await vectorSearch(USER, fakeVec(7), 10, { aiPolicy: HUMAN }))).toEqual([pageId]);
  });

  // ── Hybrid: pin, sibling window, rerank ───────────────────────────────────

  it('hybrid: the whole pipeline honours the destination, and an identifier pin cannot resurrect a refused page', async () => {
    const pages = await seedMatrix();

    const external = await hybridSearch(USER, 'gateway token', 5, null, { aiPolicy: EXTERNAL });
    expect(ids(external)).toEqual([pages.all]);

    // The quoted-title pin runs the real pg_trgm lookup; the policy
    // predicate sits inside that WHERE too.
    const pinned = await hybridSearch(USER, 'find "Runbook none"', 5, null, {
      pinIdentifiers: true, aiPolicy: EXTERNAL,
    });
    expect(pinned.find((r) => r.pageId === pages.none)).toBeUndefined();
    const pinnedExternalLocalOnly = await hybridSearch(USER, 'find "Runbook local_only"', 5, null, {
      pinIdentifiers: true, aiPolicy: EXTERNAL,
    });
    expect(pinnedExternalLocalOnly.find((r) => r.pageId === pages.local_only)).toBeUndefined();
    const pinnedLocal = await hybridSearch(USER, 'find "Runbook local_only"', 5, null, {
      pinIdentifiers: true, aiPolicy: LOCAL,
    });
    expect(pinnedLocal.find((r) => r.pageId === pages.local_only)?.pinned).toBe(true);
  });

  it('hybrid: the sibling window re-reads policy, so a page that went `none` assembles nothing', async () => {
    const pageId = await seedPage('Long runbook', 'Alpha beta gamma delta.', 'all');
    await seedChunk(pageId, 0, 'Alpha paragraph about the gateway token.', { seed: 7 });
    await seedChunk(pageId, 1, 'Beta paragraph continues the gateway token story.', { seed: 9 });
    await seedChunk(pageId, 2, 'Gamma paragraph.', { seed: 9 });

    const admitted = await hybridSearch(USER, 'gateway token', 5, null, { assembleContext: true, aiPolicy: EXTERNAL });
    const row = admitted.find((r) => r.pageId === pageId);
    expect(row).toBeDefined();
    expect(row!.aiPolicy).toBe('all');

    await query(`UPDATE pages SET ai_policy = 'none' WHERE id = $1`, [pageId]);
    const after = await hybridSearch(USER, 'gateway token', 5, null, { assembleContext: true, aiPolicy: EXTERNAL });
    expect(after.find((r) => r.pageId === pageId)).toBeUndefined();
  });

  it('rerank: bypassed when the pool holds `local_only` text and the rerank provider is not verified local', async () => {
    rerankState.assigned = true;
    await seedProvider(RERANK_PROVIDER, 'external');
    const pages = await seedMatrix();
    await seedChunk(pages.all, 1, 'Second all paragraph about the gateway token.', { seed: 8 });

    const results = await hybridSearch(USER, 'gateway token', 5, null, { rerank: true, aiPolicy: LOCAL });
    expect(ids(results)).toEqual([pages.all, pages.local_only].sort((a, b) => a - b));
    expect(rerankState.calls).toBe(0);
    expect(results.every((r) => r.rerankScore === undefined)).toBe(true);
  });

  it('rerank: runs when the rerank provider is verified local at its current config revision', async () => {
    rerankState.assigned = true;
    await seedProvider(RERANK_PROVIDER, 'local');
    const pages = await seedMatrix();
    await seedChunk(pages.all, 1, 'Second all paragraph about the gateway token.', { seed: 8 });

    const results = await hybridSearch(USER, 'gateway token', 5, null, { rerank: true, aiPolicy: LOCAL });
    expect(rerankState.calls).toBe(1);
    expect(results.some((r) => r.rerankScore !== undefined)).toBe(true);
  });

  it('rerank: an external chat destination over `all`-only text still reranks through an external reranker', async () => {
    rerankState.assigned = true;
    await seedProvider(RERANK_PROVIDER, 'external');
    const pages = await seedMatrix();
    // The stage needs more than one PAGE in the pool to have anything to order.
    const second = await seedPage('Runbook all 2', 'Another gateway token rotation note.', 'all');
    await seedChunk(second, 0, 'Another gateway token rotation note.', { seed: 8 });

    const results = await hybridSearch(USER, 'gateway token', 5, null, { rerank: true, aiPolicy: EXTERNAL });
    expect(ids(results)).toEqual([pages.all, second].sort((a, b) => a - b));
    expect(rerankState.calls).toBe(1);
  });

  it('provider locality: an endpoint edit resets the declaration through the shared decoder', async () => {
    await seedProvider(RERANK_PROVIDER, 'local');
    expect((await loadProviderMetadata({ query }, RERANK_PROVIDER))!.effectiveLocality).toBe('local');
    await query(`UPDATE llm_providers SET base_url = 'http://elsewhere:1' WHERE id = $1::uuid`, [RERANK_PROVIDER]);
    const after = await loadProviderMetadata({ query }, RERANK_PROVIDER);
    expect(after).toEqual(expect.objectContaining({ effectiveLocality: 'external', configRevision: 2 }));
    // Unknown provider: unprovable, never local.
    expect(await loadProviderMetadata({ query }, '44444444-4444-4444-4444-444444444444')).toBeNull();
  });

  // ── Revision, re-admission and the cache key ──────────────────────────────

  it('a policy change bumps the revision; the revision moves the cache key and fails re-admission', async () => {
    const pageId = await seedPage('Keyed', 'text', 'all');
    const before = (await readPagePolicies([pageId])).get(pageId)!;
    expect(before).toEqual({ pageId, policy: 'all', policyRevision: 0, contentRevision: expect.any(Number) });
    expect(await provenancePagesStillAdmitted([before], 'external')).toBe(true);

    await query(`UPDATE pages SET ai_policy = 'local_only' WHERE id = $1`, [pageId]);
    const after = (await readPagePolicies([pageId])).get(pageId)!;
    expect(after).toEqual({ pageId, policy: 'local_only', policyRevision: 1, contentRevision: before.contentRevision });
    // Recorded at revision 0 → stale under any destination.
    expect(await provenancePagesStillAdmitted([before], 'local')).toBe(false);
    // Recorded at revision 1 → admitted locally, refused externally.
    expect(await provenancePagesStillAdmitted([after], 'local')).toBe(true);
    expect(await provenancePagesStillAdmitted([after], 'external')).toBe(false);

    const base = { prompt: { system: 's', user: 'u' }, provider: 'p', providerConfigRevision: 1, providerLocality: 'external' };
    const k1 = buildRagCacheKey('m', 'q', [String(pageId)], { ...base, policyRevisions: policyRevisionsCacheComponent([before]) });
    const k2 = buildRagCacheKey('m', 'q', [String(pageId)], { ...base, policyRevisions: policyRevisionsCacheComponent([after]) });
    const k3 = buildRagCacheKey('m', 'q', [String(pageId)], { ...base, policyRevisions: policyRevisionsCacheComponent([after]), providerLocality: 'local' });
    const k4 = buildRagCacheKey('m', 'q', [String(pageId)], { ...base, policyRevisions: policyRevisionsCacheComponent([after]), providerConfigRevision: 2 });
    expect(new Set([k1, k2, k3, k4]).size).toBe(4);

    // Deleted pages are absent, never defaulted — and absence refuses.
    await query(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [pageId]);
    expect((await readPagePolicies([pageId])).size).toBe(0);
    expect(await provenancePagesStillAdmitted([after], 'local')).toBe(false);
  });

  it('a body edit moves the content revision; that moves the cache key and fails re-admission at the old reading', async () => {
    const pageId = await seedPage('Edited', 'first body', 'all');
    const before = (await readPagePolicies([pageId])).get(pageId)!;
    expect(await provenancePagesStillAdmitted([before], 'external')).toBe(true);

    // The body write path bumps `content_revision`; a direct column bump
    // stands in for the route here because the subject is what retrieval
    // and revalidation do with the column, not who increments it.
    await query(
      `UPDATE pages SET body_text = 'Second body about the gateway token.', body_html = '<p>Second body about the gateway token.</p>',
              content_revision = content_revision + 1 WHERE id = $1`,
      [pageId],
    );
    const after = (await readPagePolicies([pageId])).get(pageId)!;
    expect(after.policyRevision).toBe(before.policyRevision);
    expect(after.contentRevision).toBe(before.contentRevision + 1);
    // Same policy, same policy revision — the content revision alone refuses.
    expect(await provenancePagesStillAdmitted([before], 'external')).toBe(false);
    expect(await provenancePagesStillAdmitted([after], 'external')).toBe(true);
    // A record without a content revision cannot be proved and is refused.
    expect(await provenancePagesStillAdmitted([{ pageId, policyRevision: after.policyRevision }], 'external')).toBe(false);

    const base = { prompt: { system: 's', user: 'u' }, provider: 'p', providerConfigRevision: 1, providerLocality: 'external' };
    const k1 = buildRagCacheKey('m', 'q', [String(pageId)], { ...base, policyRevisions: policyRevisionsCacheComponent([before]) });
    const k2 = buildRagCacheKey('m', 'q', [String(pageId)], { ...base, policyRevisions: policyRevisionsCacheComponent([after]) });
    expect(k1).not.toBe(k2);

    // The retrieval legs carry the moved value.
    await seedChunk(pageId, 0, 'Second body about the gateway token.');
    const rows = await keywordSearch(USER, 'gateway token', 10, { aiPolicy: EXTERNAL });
    expect(ids(rows)).toEqual([pageId]);
    expect(rows[0]!.contentRevision).toBe(after.contentRevision);
  });
});
