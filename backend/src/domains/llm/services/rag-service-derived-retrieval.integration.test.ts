/**
 * ADR-027 D10–D12 (#1617) against a REAL Postgres, because every rule under
 * test is a rule about SQL: the lexical candidate union, the `GREATEST` page
 * rank, the `LATERAL` chunk resolution, the `chunk_tsv` trigger from migration
 * 116 and the visibility predicate on the new derived arm. A mocked pool would
 * measure the mock (`CLAUDE.md` rule 1).
 *
 * Only the LLM boundary is stubbed: the embedding provider and the use-case
 * resolver. **No vision model is involved anywhere here** — a derived chunk is
 * a SEEDED `page_embeddings` row with D9.4 `metadata`, which is exactly what
 * makes the retrieval half independent of `page_image_analyses` (#1616 owns
 * the composition that writes it in production).
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

vi.mock('./openai-compatible-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openai-compatible-client.js')>()),
  generateEmbedding: vi.fn(async () => [fakeVec(7)]),
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
}));

const {
  hybridSearch, keywordSearch, vectorSearch, flushSearchAnalytics, buildRagContext, rrfWorstCase,
} = await import('./rag-service.js');
const {
  invalidateRagFetchWidthCache,
  invalidateRagContextCharsCache,
  invalidateRagPinIdentifiersCache,
} = await import('../../../core/services/admin-settings-service.js');

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER_USER = '22222222-2222-2222-2222-222222222222';
const SPACE = 'OPS';
const PRIVATE_SPACE = 'SEC';

/** The D9.4 metadata a derived chunk carries (`image-analysis-compose.ts`). */
function derivedMetadata(opts: {
  pageTitle: string;
  spaceKey: string;
  confluenceId: string;
  key: string;
  kind?: string;
  contentHash?: string;
  analysisId?: number;
  part?: number;
  parts?: number;
}) {
  return {
    page_title: opts.pageTitle,
    section_title: `[Image: ${opts.key} — ${opts.kind ?? 'screenshot'}]`,
    space_key: opts.spaceKey,
    confluence_id: opts.confluenceId,
    source: 'image_analysis',
    attachment_source: 'confluence',
    attachment_key: opts.key,
    content_hash: opts.contentHash ?? `sha256:${opts.key}`,
    analysis_id: opts.analysisId ?? 1,
    analysis_version: 1,
    part: opts.part ?? 1,
    parts: opts.parts ?? 1,
  };
}

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('ADR-027 D10–D12 — derived chunks in retrieval', () => {
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
    await truncateAllTables();
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
         ('viewer', 'Viewer', TRUE, ARRAY['read'])
       ON CONFLICT (name) DO NOTHING`,
    );
    await query(
      `INSERT INTO users (id, username, email, role, password_hash) VALUES
         ($1::uuid, 'u1', 'u1@test', 'user', 'x'),
         ($2::uuid, 'u2', 'u2@test', 'user', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [USER, OTHER_USER],
    );
    for (const space of [SPACE, PRIVATE_SPACE]) {
      await query(
        `INSERT INTO spaces (space_key, space_name) VALUES ($1, $1) ON CONFLICT DO NOTHING`,
        [space],
      );
    }
    const role = await query<{ id: number }>(`SELECT id FROM roles WHERE name = 'viewer'`);
    // USER reads OPS only; OTHER_USER reads SEC only.
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $4), ($3, 'user', $5, $4)
       ON CONFLICT DO NOTHING`,
      [SPACE, USER, PRIVATE_SPACE, role.rows[0]!.id, OTHER_USER],
    );
  });

  async function seedPage(opts: {
    title: string;
    bodyText: string;
    spaceKey?: string;
  }): Promise<{ pageId: number; confluenceId: string }> {
    const confluenceId = `cid-${opts.title.replace(/\W+/g, '-')}`;
    const r = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html)
       VALUES ($1, 'confluence', $2, $3, $4, '', '')
       RETURNING id`,
      [confluenceId, opts.spaceKey ?? SPACE, opts.title, opts.bodyText],
    );
    return { pageId: r.rows[0]!.id, confluenceId };
  }

  /** One `page_embeddings` row. `metadata` decides authored vs derived. */
  async function seedChunk(
    pageId: number,
    chunkIndex: number,
    chunkText: string,
    metadata: Record<string, unknown>,
    vecSeed = 3,
  ): Promise<void> {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [pageId, chunkIndex, chunkText, pgvector.toSql(fakeVec(vecSeed)), JSON.stringify(metadata)],
    );
  }

  /**
   * Pages the VECTOR leg prefers to everything else, so a target page is
   * reached by the LEXICAL leg alone.
   *
   * Needed because the vector leg has no similarity floor: with a stub
   * embedder every chunk in a small corpus comes back, the page is found by
   * both legs, and `reciprocalRankFusion` deliberately keeps the VECTOR
   * chunk ("do not replace a vector chunk with a keyword body excerpt" —
   * unchanged by #1617, ADR `:4275`). These decoys sit at distance 0 from the
   * stubbed question vector and fill the stage limit, which is the state the
   * lexical-only cases below are about: the page a keyword or pin hit is the
   * ONLY route to.
   */
  async function seedVectorDecoys(n = 12): Promise<void> {
    for (let i = 0; i < n; i++) {
      const { pageId, confluenceId } = await seedPage({
        title: `Decoy ${i}`,
        bodyText: `Decoy ${i} prose about nothing relevant.`,
      });
      await seedChunk(pageId, 0, `Decoy ${i} prose about nothing relevant.`,
        authoredMetadata(`Decoy ${i}`, `Decoy ${i}`, confluenceId), 7);
    }
  }

  function authoredMetadata(pageTitle: string, sectionTitle: string, confluenceId: string) {
    return {
      page_title: pageTitle,
      section_title: sectionTitle,
      space_key: SPACE,
      confluence_id: confluenceId,
    };
  }

  // ── D10: the lexical union and chunk resolution ────────────────────────

  it('finds a fact that exists ONLY in a derived chunk, and returns that chunk as the evidence', async () => {
    // The headline: nothing in the page's own prose mentions ERR-4711. The
    // screenshot's transcription does, and `pages.tsv` cannot see it — so
    // before D10 this page was lexically invisible, and after it the page
    // comes back carrying the passage that matched rather than its lede.
    const { pageId, confluenceId } = await seedPage({
      title: 'Checkout outage',
      bodyText: 'The team met to review the outage and attached the console capture.',
    });
    await seedChunk(pageId, 0, 'The team met to review the outage and attached the console capture.',
      authoredMetadata('Checkout outage', 'Checkout outage', confluenceId));
    await seedChunk(pageId, 1, 'Console capture text: payment gateway returned ERR-4711 twice.',
      derivedMetadata({ pageTitle: 'Checkout outage', spaceKey: SPACE, confluenceId, key: 'console.png', analysisId: 9 }));

    const hits = await keywordSearch(USER, 'ERR-4711', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.pageId).toBe(pageId);
    expect(hits[0]!.chunkText).toBe('Console capture text: payment gateway returned ERR-4711 twice.');
    expect(hits[0]!.chunkIndex).toBe(1);
    expect(hits[0]!.sectionTitle).toBe('[Image: console.png — screenshot]');
    expect(hits[0]!.derived).toEqual({
      attachmentSource: 'confluence',
      attachmentKey: 'console.png',
      contentHash: 'sha256:console.png',
      analysisId: 9,
      analysisVersion: 1,
      part: 1,
      parts: 1,
    });
  });

  it('resolves an AUTHORED keyword hit to the matching chunk, not the page lede', async () => {
    // The measured change the issue's scope note names, and the reason #1617
    // lands it as its own PR: this is not about images at all. A term in
    // chunk 7 of a long page used to come back as the first 500 characters of
    // `body_text`, so the reranker scored — and `/api/search` displayed — a
    // passage that did not contain the query.
    const lede = 'Introduction to the billing subsystem. '.repeat(20);
    const { pageId, confluenceId } = await seedPage({
      title: 'Billing internals',
      bodyText: `${lede} Deep inside, the reconciliation ledger uses a compensating entry.`,
    });
    for (let i = 0; i < 7; i++) {
      await seedChunk(pageId, i, `Section ${i}: introduction to the billing subsystem.`,
        authoredMetadata('Billing internals', `Section ${i}`, confluenceId));
    }
    await seedChunk(pageId, 7, 'The reconciliation ledger uses a compensating entry.',
      authoredMetadata('Billing internals', 'Reconciliation', confluenceId));

    const hits = await keywordSearch(USER, 'compensating entry', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunkText).toBe('The reconciliation ledger uses a compensating entry.');
    expect(hits[0]!.chunkIndex).toBe(7);
    expect(hits[0]!.sectionTitle).toBe('Reconciliation');
    // An authored chunk carries no provenance — the D12 citation and the
    // answer-time byte pick both key on this being absent.
    expect(hits[0]!.derived).toBeUndefined();
  });

  it('leaves an authored-only page ranking EXACTLY as ts_rank(pages.tsv, q) — pages.tsv is untouched', async () => {
    // ADR `:4265-4267`: authored page ranking must stay bit-identical so arm
    // C's lexical numbers stand beside the historical ones. The derived arm
    // may only ADD pages and may only RAISE a rank through GREATEST.
    const { pageId, confluenceId } = await seedPage({
      title: 'Queue runbook',
      bodyText: 'Restart the queue worker when the backlog grows.',
    });
    await seedChunk(pageId, 0, 'Restart the queue worker when the backlog grows.',
      authoredMetadata('Queue runbook', 'Queue runbook', confluenceId));

    const hits = await keywordSearch(USER, 'restart queue worker', 10);
    const expected = await query<{ rank: number }>(
      `SELECT ts_rank(tsv, websearch_to_tsquery('simple', $2)) AS rank FROM pages WHERE id = $1`,
      [pageId, 'restart queue worker'],
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]!.keywordRank).toBeCloseTo(expected.rows[0]!.rank, 10);
    expect(hits[0]!.score).toBeCloseTo(expected.rows[0]!.rank, 10);
  });

  it('resolves a TITLE-only match to chunk 0', async () => {
    // ADR `:4276`. No chunk matches the query, so the `chunk_index ASC`
    // tiebreak decides — and it decides deterministically, which is what
    // makes two identical requests return the same evidence.
    const { pageId, confluenceId } = await seedPage({
      title: 'Zephyr deployment guide',
      bodyText: 'Step one. Step two. Step three.',
    });
    await seedChunk(pageId, 0, 'Step one. Step two.', authoredMetadata('Zephyr deployment guide', 'Steps', confluenceId));
    await seedChunk(pageId, 1, 'Step three.', authoredMetadata('Zephyr deployment guide', 'Steps', confluenceId));

    const hits = await keywordSearch(USER, 'Zephyr', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunkIndex).toBe(0);
    expect(hits[0]!.chunkText).toBe('Step one. Step two.');
  });

  it('falls back to substring(body_text, 1, 500) for a page with NO chunk rows', async () => {
    // The only surviving use of the page prefix (ADR `:4277`): a page that is
    // matched lexically but has not been embedded yet has no chunk to resolve
    // to, and a lede is better than nothing. `chunkIndex` stays absent
    // because nothing measured a position.
    const body = `Nginx tuning notes. ${'x'.repeat(900)}`;
    await seedPage({ title: 'Nginx tuning', bodyText: body });

    const hits = await keywordSearch(USER, 'Nginx tuning notes', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunkText).toBe(body.slice(0, 500));
    expect(hits[0]!.chunkIndex).toBeUndefined();
  });

  it('gives a page with five matching derived chunks ONE candidate at ONE rank', async () => {
    // ADR `:4280-4282` — no third RRF leg, and a page with five matching
    // images is still one vote. The derived arm is
    // `MAX(ts_rank(...)) GROUP BY page_id`, so image COUNT cannot buy page
    // rank; with a `UNION ALL` and no collapse this page would appear five
    // times and out-vote a better page.
    const { pageId, confluenceId } = await seedPage({
      title: 'Screenshot gallery',
      bodyText: 'A page of screenshots.',
    });
    await seedChunk(pageId, 0, 'A page of screenshots.',
      authoredMetadata('Screenshot gallery', 'Screenshot gallery', confluenceId));
    for (let i = 1; i <= 5; i++) {
      await seedChunk(pageId, i, `Capture ${i} shows the ERR-4711 banner.`,
        derivedMetadata({ pageTitle: 'Screenshot gallery', spaceKey: SPACE, confluenceId, key: `shot${i}.png`, analysisId: i }));
    }
    const rival = await seedPage({ title: 'ERR-4711 index', bodyText: 'ERR-4711 is documented here.' });
    await seedChunk(rival.pageId, 0, 'ERR-4711 is documented here.',
      authoredMetadata('ERR-4711 index', 'ERR-4711 index', rival.confluenceId));

    const hits = await keywordSearch(USER, 'ERR-4711', 10);

    expect(hits.filter((h) => h.pageId === pageId)).toHaveLength(1);
    expect(new Set(hits.map((h) => h.pageId)).size).toBe(hits.length);

    // …and the same holds through fusion: one row for the page, not five.
    const fused = await hybridSearch(USER, 'ERR-4711', 10);
    expect(fused.filter((h) => h.pageId === pageId)).toHaveLength(1);
  });

  it('keeps a derived chunk on an invisible page out of the candidate set entirely', async () => {
    // ADR-027 D14, and the one NEW place the rule can be broken: the derived
    // arm reads `page_embeddings` — derived TEXT — so it has to join `pages`
    // and carry `visiblePagesPredicate` itself. Dropping that clause makes
    // this page a candidate, and its description then reaches the reranker
    // and the answer.
    const secret = await seedPage({
      title: 'Incident SEC-9',
      bodyText: 'Restricted incident notes.',
      spaceKey: PRIVATE_SPACE,
    });
    await seedChunk(secret.pageId, 0, 'Restricted incident notes.', {
      page_title: 'Incident SEC-9', section_title: 'Incident SEC-9',
      space_key: PRIVATE_SPACE, confluence_id: secret.confluenceId,
    });
    await seedChunk(secret.pageId, 1, 'Whiteboard photo transcription: ERR-4711 root cause is the retry loop.',
      derivedMetadata({ pageTitle: 'Incident SEC-9', spaceKey: PRIVATE_SPACE, confluenceId: secret.confluenceId, key: 'board.jpg' }));

    expect(await keywordSearch(USER, 'ERR-4711', 10)).toHaveLength(0);
    // The owner of that space still finds it — the predicate is a filter, not
    // a blanket exclusion.
    const owner = await keywordSearch(OTHER_USER, 'ERR-4711', 10);
    expect(owner.map((h) => h.pageId)).toEqual([secret.pageId]);
  });

  it('carries derived provenance out of the VECTOR leg too', async () => {
    const { pageId, confluenceId } = await seedPage({
      title: 'Latency graph',
      bodyText: 'We measured the latency.',
    });
    await seedChunk(pageId, 0, 'Chart transcription: p99 latency peaked at 4.2 seconds.',
      derivedMetadata({ pageTitle: 'Latency graph', spaceKey: SPACE, confluenceId, key: 'p99.png', kind: 'chart' }), 7);

    const hits = await vectorSearch(USER, fakeVec(7), 5);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.derived?.attachmentKey).toBe('p99.png');
    expect(hits[0]!.chunkIndex).toBe(0);
    // An ordinary result: a real measured similarity, not a stand-in (D11).
    expect(hits[0]!.vectorScore).toBeGreaterThan(0.99);
  });

  // ── D10 erratum Q1: the exact-identifier pin ───────────────────────────

  it('pins an identifier that lives only in a derived chunk, and carries that chunk', async () => {
    // #1617's acceptance case: the OCR-only issue key. The page is NAMED by
    // the key, so the #1107 pin verifies it by title; the key itself appears
    // nowhere but the screenshot's transcription, so before D10 the pin came
    // back with a body lede that did not contain it.
    await seedVectorDecoys();
    const { pageId, confluenceId } = await seedPage({
      title: 'INC-2203 postmortem',
      bodyText: 'Timeline and follow-ups are attached as images.',
    });
    await seedChunk(pageId, 0, 'Timeline and follow-ups are attached as images.',
      authoredMetadata('INC-2203 postmortem', 'INC-2203 postmortem', confluenceId));
    await seedChunk(pageId, 1, 'Screenshot text: ticket INC-2203 was closed after the rollback.',
      derivedMetadata({ pageTitle: 'INC-2203 postmortem', spaceKey: SPACE, confluenceId, key: 'ticket.png', analysisId: 4 }));

    const hits = await hybridSearch(USER, 'what happened in INC-2203', 5, undefined, {
      pinIdentifiers: true,
    });

    const pinned = hits.find((h) => h.pinned);
    expect(pinned?.pageId).toBe(pageId);
    expect(pinned!.chunkText).toBe('Screenshot text: ticket INC-2203 was closed after the rollback.');
    expect(pinned!.chunkIndex).toBe(1);
    expect(pinned!.derived?.attachmentKey).toBe('ticket.png');
  });

  it('keeps the #1273 F9 budget lede when NO chunk matches the identifier (erratum Q1)', async () => {
    // The other half of the owner decision. A pin is the one row sibling
    // assembly cannot reach — the stage runs after it — so #1273 F9 sized its
    // excerpt to `rag_context_chars_per_page`. Read literally, ADR `:4276`
    // would swap that for one ~1-2k chunk on every "find the page called X"
    // pin; the gate is a real `chunk_tsv @@ q` hit, and a bare identifier is
    // not one.
    await seedVectorDecoys();
    const body = `Release notes for the rollout. ${'y'.repeat(2000)}`;
    const { pageId, confluenceId } = await seedPage({ title: 'INC-9999 rollout', bodyText: body });
    // Neither chunk mentions the key: the page is NAMED by it, which is what
    // the pin verifies, and nothing inside it matches.
    await seedChunk(pageId, 0, 'Chunk zero text about nothing in particular.',
      authoredMetadata('INC-9999 rollout', 'Intro', confluenceId));
    await seedChunk(pageId, 1, 'Chunk one text about nothing in particular.',
      authoredMetadata('INC-9999 rollout', 'Body', confluenceId));

    const hits = await hybridSearch(USER, 'what changed in INC-9999', 5, undefined, {
      pinIdentifiers: true,
    });

    const pinned = hits.find((h) => h.pinned);
    expect(pinned?.pageId).toBe(pageId);
    // The budget-sized lede (default 6000 chars, so the whole body), NOT
    // chunk 0 — and no anchor, because retrieval picked no position.
    expect(pinned!.chunkText).toBe(body);
    expect(pinned!.chunkIndex).toBeUndefined();
    expect(pinned!.derived).toBeUndefined();
  });

  // ── D2 / D11: assembly, context and confidence ─────────────────────────

  it('never expands a derived anchor, and never crosses into one from an authored anchor', async () => {
    // ADR-027 D2's last row, now reachable from a KEYWORD hit for the first
    // time: before #1617 a keyword row had no `chunkIndex`, so the sibling
    // stage skipped it entirely and the boundary was untestable from this
    // direction. A derived anchor keeps only itself; an authored anchor's
    // window stops at the boundary.
    await seedVectorDecoys();
    const { pageId, confluenceId } = await seedPage({
      title: 'Mixed page',
      // `body_text` carries the authored prose, as it does in production:
      // `pages.tsv` is the only authored rank contributor (ADR `:4272`), so a
      // term that exists in a chunk but not in the page document is not a
      // lexical candidate at all — and derived text is deliberately never in
      // `body_text` (D14).
      bodyText: 'Authored zero paragraph. Authored one paragraph mentioning widgets. Authored two paragraph.',
    });
    await seedChunk(pageId, 0, 'Authored zero paragraph.', authoredMetadata('Mixed page', 'A0', confluenceId));
    await seedChunk(pageId, 1, 'Authored one paragraph mentioning widgets.', authoredMetadata('Mixed page', 'A1', confluenceId));
    await seedChunk(pageId, 2, 'Authored two paragraph.', authoredMetadata('Mixed page', 'A2', confluenceId));
    await seedChunk(pageId, 3, 'Diagram transcription: the ERR-4711 path retries three times.',
      derivedMetadata({ pageTitle: 'Mixed page', spaceKey: SPACE, confluenceId, key: 'diagram.png' }));

    const derivedAnchor = await hybridSearch(USER, 'ERR-4711', 10, undefined, { assembleContext: true });
    const derivedRow = derivedAnchor.find((r) => r.pageId === pageId)!;
    expect(derivedRow.derived?.attachmentKey).toBe('diagram.png');
    // Its own row and nothing else: no `contextText` was assembled, so
    // `buildRagContext` sends the derived chunk verbatim.
    expect(derivedRow.contextText).toBeUndefined();
    expect(buildRagContext([derivedRow])).toContain('the ERR-4711 path retries three times');

    const authoredAnchor = await hybridSearch(USER, 'widgets', 10, undefined, { assembleContext: true });
    const authoredRow = authoredAnchor.find((r) => r.pageId === pageId)!;
    const context = authoredRow.contextText ?? authoredRow.chunkText;
    expect(context).toContain('Authored one paragraph mentioning widgets.');
    expect(context).not.toContain('Diagram transcription');
  });

  it('keeps a tail-of-page derived anchor under the bounded page context', async () => {
    // D11: "the anchor is never dropped for budget". The image sits at the
    // end of a 40-chunk page, which is the case a window centred on the
    // anchor could lose if the budget were spent from the top of the page.
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('rag_context_chars_per_page', '600', NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = '600'`,
    );
    invalidateRagContextCharsCache();
    await seedVectorDecoys();
    const { pageId, confluenceId } = await seedPage({
      title: 'Long page',
      bodyText: 'A very long page.',
    });
    for (let i = 0; i < 40; i++) {
      await seedChunk(pageId, i, `Paragraph ${i}: ${'filler words '.repeat(20)}`,
        authoredMetadata('Long page', `P${i}`, confluenceId));
    }
    await seedChunk(pageId, 40, 'Footer diagram transcription: the ERR-4711 banner appears after two retries.',
      derivedMetadata({ pageTitle: 'Long page', spaceKey: SPACE, confluenceId, key: 'footer.png' }));

    const hits = await hybridSearch(USER, 'ERR-4711', 10, undefined, { assembleContext: true });
    const row = hits.find((r) => r.pageId === pageId)!;

    expect(row.chunkIndex).toBe(40);
    expect(buildRagContext([row])).toContain('the ERR-4711 banner appears after two retries');
  });

  it('scores a derived page with the TWO text legs only — no third RRF leg', async () => {
    // ADR-027 D1/D10 (`:4282`): derived text enters the EXISTING legs. If a
    // future change fed derived rows to fusion as their own leg, a page found
    // by vector + keyword + derived would exceed the two-leg ceiling — which
    // is width-invariant, so this bound holds at every fetch width and is not
    // a restatement of the fixture.
    const { pageId, confluenceId } = await seedPage({
      title: 'Both legs',
      bodyText: 'The console capture shows ERR-4711 on the checkout path.',
    });
    await seedChunk(pageId, 0, 'The console capture shows ERR-4711 on the checkout path.',
      authoredMetadata('Both legs', 'Both legs', confluenceId), 7);
    await seedChunk(pageId, 1, 'Capture text: ERR-4711 on the checkout path.',
      derivedMetadata({ pageTitle: 'Both legs', spaceKey: SPACE, confluenceId, key: 'cap.png' }), 7);

    const hits = await hybridSearch(USER, 'ERR-4711', 5);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBeLessThanOrEqual(rrfWorstCase(true) + 1e-12);
    // Both legs really did contribute — otherwise the bound above is vacuous.
    expect(hits[0]!.vectorScore).not.toBeNull();
    expect(hits[0]!.keywordRank).not.toBeNull();
  });

  it('does not duplicate a page across two pages of results when derived chunks match', async () => {
    // `/api/search`'s hybrid mode paginates over this set. A page whose
    // derived and authored chunks both match must not occupy a slot twice —
    // the union's collapse is what guarantees it, and a duplicate would also
    // move `total`.
    for (let p = 0; p < 6; p++) {
      const { pageId, confluenceId } = await seedPage({
        title: `Widget page ${p}`,
        bodyText: `Widget page ${p} discusses widgets and the ERR-4711 banner.`,
      });
      await seedChunk(pageId, 0, `Widget page ${p} discusses widgets.`,
        authoredMetadata(`Widget page ${p}`, `Widget page ${p}`, confluenceId));
      await seedChunk(pageId, 1, `Screenshot ${p}: ERR-4711 banner visible.`,
        derivedMetadata({ pageTitle: `Widget page ${p}`, spaceKey: SPACE, confluenceId, key: `s${p}.png`, analysisId: p + 1 }));
    }

    const hits = await hybridSearch(USER, 'ERR-4711 widgets', 12);
    const ids = hits.map((h) => h.pageId);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
