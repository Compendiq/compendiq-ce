import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { createProvider, setDefaultProvider } from './llm-provider-service.js';
import {
  resolveUsecase,
  resolveConfidenceBasisPair,
  resolveImageEmbeddingUsecase,
  resolveInlineCompletionUsecase,
} from './llm-provider-resolver.js';
import { bumpProviderCacheVersion } from './cache-bus.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('resolveUsecase — truth table', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    await bumpProviderCacheVersion();
  });

  async function seed() {
    const a = await createProvider({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'mA' });
    const b = await createProvider({ name: 'B', baseUrl: 'http://b/v1', authType: 'none', verifySsl: true, defaultModel: 'mB' });
    await setDefaultProvider(a.id);
    return { aId: a.id, bId: b.id };
  }

  it('inherit (null,null) -> default provider + default_model', async () => {
    const { aId } = await seed();
    const r = await resolveUsecase('chat');
    expect(r.config.id).toBe(aId);
    expect(r.model).toBe('mA');
  });

  it('provider-only (B, null) -> B + B.default_model', async () => {
    const { bId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('summary',$1,NULL)`, [bId]);
    const r = await resolveUsecase('summary');
    expect(r.config.id).toBe(bId);
    expect(r.model).toBe('mB');
  });

  it('full override (B, "gpt-4o") -> B + "gpt-4o"', async () => {
    const { bId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('quality',$1,$2)`, [bId, 'gpt-4o']);
    const r = await resolveUsecase('quality');
    expect(r.config.id).toBe(bId);
    expect(r.model).toBe('gpt-4o');
  });

  it('model-only (null, "gpt-4o") -> default provider + "gpt-4o"', async () => {
    const { aId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('auto_tag',NULL,$1)`, ['gpt-4o']);
    const r = await resolveUsecase('auto_tag');
    expect(r.config.id).toBe(aId);
    expect(r.model).toBe('gpt-4o');
  });

  it('throws when no default provider exists', async () => {
    await expect(resolveUsecase('chat')).rejects.toThrow(/no default/i);
  });

  it('changes take effect without restart (no caching on assignment)', async () => {
    const { aId, bId } = await seed();
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('chat',$1,NULL)`, [aId]);
    expect((await resolveUsecase('chat')).config.id).toBe(aId);
    await query(`UPDATE llm_usecase_assignments SET provider_id=$1 WHERE usecase='chat'`, [bId]);
    expect((await resolveUsecase('chat')).config.id).toBe(bId);
  });

  /**
   * #1114, review r2 — the calibration seam answers TWO things at once, and
   * collapsing them is what let a resolver failure be written down as the
   * claim "this threshold was tuned against no model at all". `resolved` is
   * about whether we know; `pair` is about what is assigned.
   */
  describe('resolveConfidenceBasisPair', () => {
    it('answers the resolved pair for an assigned embedder', async () => {
      const { aId } = await seed();
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('embedding',$1,$2)`,
        [aId, 'bge-m3'],
      );
      expect(await resolveConfidenceBasisPair('similarity')).toEqual({
        resolved: true,
        pair: { providerId: aId, model: 'bge-m3' },
      });
    });

    it('reports an instance with NO provider as resolved-with-nothing, not unknown', async () => {
      // A fresh install really does have no model behind the basis, and the
      // day an admin assigns the first embedder that IS a scale change worth
      // a log line. Abstaining here would swallow it.
      expect(await resolveConfidenceBasisPair('similarity')).toEqual({ resolved: true, pair: null });
    });

    it('reports an unassigned rerank stage as resolved-with-nothing (ADR-021)', async () => {
      await seed();
      expect(await resolveConfidenceBasisPair('rerank')).toEqual({ resolved: true, pair: null });
    });
  });

  /**
   * #1115 — `image_embedding` is the `rerank` rule one rung stronger.
   *
   * Rerank's argument was that a default chat provider handed `/v1/rerank`
   * traffic ERRORS, which is loud. Here the default text embedder would answer
   * the plain `{model, input}` shape with a perfectly well-formed vector that
   * is simply wrong — off-distribution, pooled at a different position — and
   * wrong vectors are indistinguishable from bad retrieval.
   */
  describe('resolveImageEmbeddingUsecase (#1115)', () => {
    it('answers null when nothing is assigned, even with a default provider', async () => {
      await seed();
      expect(await resolveImageEmbeddingUsecase()).toBeNull();
    });

    it('answers the assigned pair', async () => {
      const { bId } = await seed();
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_embedding',$1,$2)`,
        [bId, 'Qwen/Qwen3-VL-Embedding-2B'],
      );
      const r = await resolveImageEmbeddingUsecase();
      expect(r?.config.id).toBe(bId);
      expect(r?.model).toBe('Qwen/Qwen3-VL-Embedding-2B');
    });

    it("falls back to the provider's default_model when the assignment pins no model", async () => {
      const { bId } = await seed();
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_embedding',$1,NULL)`,
        [bId],
      );
      expect((await resolveImageEmbeddingUsecase())?.model).toBe('mB');
    });

    // Assigned-but-unresolvable is the leg OFF, not the leg pointed at an
    // empty model name: a request with `model: ''` is a wasted round-trip and
    // a confusing provider error.
    it('answers null when a provider is assigned but no model resolves anywhere', async () => {
      const c = await createProvider({
        name: 'C', baseUrl: 'http://c/v1', authType: 'none', verifySsl: true, defaultModel: null,
      });
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_embedding',$1,NULL)`,
        [c.id],
      );
      expect(await resolveImageEmbeddingUsecase()).toBeNull();
    });
  });

  describe('resolveInlineCompletionUsecase (#1417)', () => {
    it('answers null when unassigned, even with a default provider', async () => {
      await seed();
      expect(await resolveInlineCompletionUsecase()).toBeNull();
    });

    it('resolves only its explicitly assigned provider and model', async () => {
      const { bId } = await seed();
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
         VALUES ('inline_completion', $1, 'qwen2.5-coder:7b')`,
        [bId],
      );
      const resolved = await resolveInlineCompletionUsecase();
      expect(resolved?.config.id).toBe(bId);
      expect(resolved?.model).toBe('qwen2.5-coder:7b');
    });
  });

  it("resolveUsecase refuses 'image_embedding', exactly as it refuses 'rerank'", async () => {
    await seed();
    await expect(resolveUsecase('image_embedding')).rejects.toThrow(
      /resolveImageEmbeddingUsecase/,
    );
    await expect(resolveUsecase('rerank')).rejects.toThrow(/resolveRerankUsecase/);
    await expect(resolveUsecase('inline_completion')).rejects.toThrow(
      /resolveInlineCompletionUsecase/,
    );
  });
});
