import { describe, it, expect } from 'vitest';
import {
  LlmUsecaseSchema,
  LlmProviderInputSchema,
  UsecaseAssignmentsSchema,
  UsecaseDefaultSchema,
  VisionCapabilityDetailSchema,
  ImageEmbeddingProbeSchema,
  ImageIndexStatusSchema,
} from './llm.js';
import {
  AskRequestSchema,
  ImproveRequestSchema,
  GenerateRequestSchema,
  SummarizeRequestSchema,
  GenerateDiagramRequestSchema,
  AnalyzeQualityRequestSchema,
  InlineCompletionRequestSchema,
  InlineCompletionResponseSchema,
} from './schemas/llm.js';

describe('LlmUsecaseSchema', () => {
  it('accepts embedding as a valid use case', () => {
    expect(() => LlmUsecaseSchema.parse('embedding')).not.toThrow();
  });
  it('rejects unknown use cases', () => {
    expect(() => LlmUsecaseSchema.parse('bogus')).toThrow();
  });
  // #1115 P1 — the seventh use case. Migration 093 widened the DB CHECK in P0;
  // the enum is what makes the assignment row reachable from the API.
  it('accepts image_embedding (#1115)', () => {
    expect(() => LlmUsecaseSchema.parse('image_embedding')).not.toThrow();
  });
  it('accepts inline_completion (#1417)', () => {
    expect(() => LlmUsecaseSchema.parse('inline_completion')).not.toThrow();
  });
  it('rejects client_inference — the browser model is not an ADR-021 use case (#1418 SPEC-010)', () => {
    expect(LlmUsecaseSchema.options).not.toContain('client_inference');
    expect(() => LlmUsecaseSchema.parse('client_inference')).toThrow();
  });
});

describe('LlmProviderInputSchema', () => {
  it('accepts a minimal valid input', () => {
    const parsed = LlmProviderInputSchema.parse({
      name: 'GPU Box',
      baseUrl: 'http://gpu:11434/v1',
      authType: 'bearer',
      verifySsl: true,
    });
    expect(parsed.name).toBe('GPU Box');
  });
  it('rejects empty names', () => {
    expect(() =>
      LlmProviderInputSchema.parse({ name: '', baseUrl: 'http://x/v1', authType: 'none', verifySsl: true }),
    ).toThrow();
  });
  it('rejects non-http(s) baseUrl', () => {
    expect(() =>
      LlmProviderInputSchema.parse({ name: 'x', baseUrl: 'ftp://x', authType: 'none', verifySsl: true }),
    ).toThrow();
  });
});

// #929: the six streaming LLM routes resolve the model server-side per
// ADR-021 (resolveUsecase) and ignore any `model` in the request body. The
// contract must therefore NOT require it — omitting `model` is valid.
describe('streaming request schemas treat model as optional (#929)', () => {
  it('AskRequestSchema parses without model', () => {
    const parsed = AskRequestSchema.parse({ question: 'hi' });
    expect(parsed.question).toBe('hi');
    expect(parsed.model).toBeUndefined();
  });
  it('ImproveRequestSchema parses without model', () => {
    expect(() =>
      ImproveRequestSchema.parse({ content: 'text', type: 'grammar' }),
    ).not.toThrow();
  });
  it('GenerateRequestSchema parses without model', () => {
    expect(() => GenerateRequestSchema.parse({ prompt: 'draft a runbook' })).not.toThrow();
  });
  it('SummarizeRequestSchema parses without model', () => {
    expect(() => SummarizeRequestSchema.parse({ content: 'text' })).not.toThrow();
  });
  it('GenerateDiagramRequestSchema parses without model', () => {
    expect(() => GenerateDiagramRequestSchema.parse({ content: 'text' })).not.toThrow();
  });
  it('AnalyzeQualityRequestSchema parses without model', () => {
    expect(() => AnalyzeQualityRequestSchema.parse({ content: 'text' })).not.toThrow();
  });
  it('still accepts a model when provided (back-compat)', () => {
    const parsed = AskRequestSchema.parse({ question: 'hi', model: 'llama3' });
    expect(parsed.model).toBe('llama3');
  });
  it('AskRequestSchema accepts imageHandle', () => {
    const parsed = AskRequestSchema.parse({ question: 'hi', imageHandle: 'a'.repeat(64) });
    expect(parsed.imageHandle).toBe('a'.repeat(64));
  });
  it('AskRequestSchema accepts extracted reference text up to 200K characters', () => {
    const referenceText = 'a'.repeat(200_000);
    const parsed = AskRequestSchema.parse({ question: 'hi', referenceText });
    expect(parsed.referenceText).toBe(referenceText);
    expect(() => AskRequestSchema.parse({ question: 'hi', referenceText: `${referenceText}a` })).toThrow();
  });
  it('GenerateDiagramRequestSchema accepts an optional instruction up to 10K characters', () => {
    const instruction = 'a'.repeat(10_000);
    const parsed = GenerateDiagramRequestSchema.parse({ content: 'text', instruction });
    expect(parsed.instruction).toBe(instruction);
    expect(() => GenerateDiagramRequestSchema.parse({ content: 'text', instruction: `${instruction}a` })).toThrow();
  });
});

describe('UsecaseAssignmentsSchema', () => {
  it('allows null providerId + null model (inherit)', () => {
    // NOTE: plan snippet used 'p1' here, but the schema requires
    // resolved.providerId to be a UUID. Substituting a valid UUID.
    const p1 = '00000000-0000-4000-8000-000000000001';
    const parsed = UsecaseAssignmentsSchema.parse({
      chat: { providerId: null, model: null, resolved: { providerId: p1, providerName: 'X', model: 'm' } },
      summary: { providerId: null, model: null, resolved: { providerId: p1, providerName: 'X', model: 'm' } },
      quality: { providerId: null, model: null, resolved: { providerId: p1, providerName: 'X', model: 'm' } },
      auto_tag: { providerId: null, model: null, resolved: { providerId: p1, providerName: 'X', model: 'm' } },
      embedding: { providerId: null, model: null, resolved: { providerId: p1, providerName: 'X', model: 'm' } },
      rerank: { providerId: null, model: null, resolved: { providerId: p1, providerName: 'X', model: 'm' } },
      image_embedding: { providerId: null, model: null, resolved: { providerId: p1, providerName: 'X', model: 'm' } },
      inline_completion: { providerId: null, model: null, resolved: { providerId: p1, providerName: 'X', model: 'm' } },
    });
    expect(parsed.embedding).toBeDefined();
    expect(parsed.image_embedding).toBeDefined();
    expect(parsed.inline_completion).toBeDefined();
  });
});

describe('inline completion contracts (#1417)', () => {
  it('defaults maxTokens to 48 and accepts bounded context metadata', () => {
    expect(InlineCompletionRequestSchema.parse({
      pageId: 42,
      spaceKey: 'ENG',
      title: 'Runbook',
      prefix: 'Rotate the ',
      suffix: ' before expiry.',
      language: 'en',
    })).toEqual({
      pageId: 42,
      spaceKey: 'ENG',
      title: 'Runbook',
      prefix: 'Rotate the ',
      suffix: ' before expiry.',
      language: 'en',
      maxTokens: 48,
    });
  });

  it('enforces context and token ceilings', () => {
    expect(InlineCompletionRequestSchema.safeParse({ prefix: 'x'.repeat(8_001) }).success).toBe(false);
    expect(InlineCompletionRequestSchema.safeParse({ prefix: '', suffix: 'x'.repeat(2_001) }).success).toBe(false);
    expect(InlineCompletionRequestSchema.safeParse({ prefix: '', maxTokens: 65 }).success).toBe(false);
  });

  it('parses the provider response and optional usage', () => {
    const parsed = InlineCompletionResponseSchema.parse({
      completion: 'access token before expiry.',
      model: 'qwen2.5-coder:7b',
      provider: 'Local GPU',
      usage: { promptTokens: 32, completionTokens: 5 },
    });
    expect(parsed.usage?.completionTokens).toBe(5);
  });
});

/**
 * #1115 — the image-embedding probe result, an ADMIN-ONLY shape.
 *
 * `error` is the provider's own error body (see `llm-http-error.ts`), so it
 * lives here rather than on `UsecaseDefaultSchema`, exactly as #1184 kept
 * `probeError` off the non-admin read.
 */
describe('ImageEmbeddingProbeSchema (#1115)', () => {
  const base = {
    providerId: '00000000-0000-4000-8000-000000000001',
    model: 'Qwen/Qwen3-VL-Embedding-2B',
    dimensions: 2048,
    tier: 'halfvec' as const,
    probedAt: '2026-08-17T12:00:00.000Z',
    error: null,
  };

  it.each(['vector', 'halfvec', 'unindexed'])('accepts tier %s', (tier) => {
    expect(() => ImageEmbeddingProbeSchema.parse({ ...base, tier })).not.toThrow();
  });

  it('rejects an unknown tier', () => {
    expect(() => ImageEmbeddingProbeSchema.parse({ ...base, tier: 'ivfflat' })).toThrow();
  });

  // A failed probe has no width. Nullable rather than optional, so a caller
  // cannot read "absent" as "zero-dimensional".
  it('accepts a failed probe (null dimensions, an error string)', () => {
    const parsed = ImageEmbeddingProbeSchema.parse({
      ...base,
      dimensions: null,
      tier: null,
      error: 'generateEmbedding HTTP 400: messages field not recognised',
    });
    expect(parsed.dimensions).toBeNull();
    expect(parsed.error).toContain('400');
  });

  it('rejects error being absent', () => {
    const { error: _omitted, ...withoutError } = base;
    expect(() => ImageEmbeddingProbeSchema.parse(withoutError)).toThrow();
  });

  it('refuses an implausible width', () => {
    expect(() => ImageEmbeddingProbeSchema.parse({ ...base, dimensions: 0 })).toThrow();
    expect(() => ImageEmbeddingProbeSchema.parse({ ...base, dimensions: 16_001 })).toThrow();
  });

  /**
   * Review round 1: a re-probe can EMPTY the index and re-dirty the corpus, and
   * the control that triggers it says only "Re-check". `rebuilt` is what lets
   * the toast name the consequence — optional, not nullable, because the GET
   * performs no DDL and "was never asked" must stay distinguishable from "did
   * not rebuild".
   */
  it('carries the rebuild verdict when the re-probe reports one', () => {
    const parsed = ImageEmbeddingProbeSchema.parse({ ...base, rebuilt: true, dirtiedPages: 42 });
    expect(parsed.rebuilt).toBe(true);
    expect(parsed.dirtiedPages).toBe(42);
  });

  it('leaves rebuilt absent for the read-only GET', () => {
    const parsed = ImageEmbeddingProbeSchema.parse(base);
    expect(parsed.rebuilt).toBeUndefined();
    expect(parsed.dirtiedPages).toBeUndefined();
  });
});

describe('UsecaseDefaultSchema vision tri-state (#1154)', () => {
  const base = {
    usecase: 'chat' as const,
    // NOTE: brief used '...0000000001', but zod v4's z.string().uuid() only
    // special-cases the all-zero nil UUID, not a trailing-1 variant of it, so
    // that literal fails validation for reasons unrelated to `vision`.
    // Substituting a properly-formed v4 UUID, matching the convention already
    // used above in UsecaseAssignmentsSchema's tests.
    providerId: '00000000-0000-4000-8000-000000000001',
    providerName: 'local',
    model: 'qwen2.5vl',
  };

  it.each([true, false, null])('accepts vision: %j', (vision) => {
    expect(() => UsecaseDefaultSchema.parse({ ...base, vision })).not.toThrow();
  });

  // null is a real verdict ("probed, couldn't tell") that the composer renders
  // with different copy from false, so it must not collapse with "absent".
  it('rejects vision being absent', () => {
    expect(() => UsecaseDefaultSchema.parse(base)).toThrow();
  });

  /**
   * #1184: `GET /llm/usecase-default` is `fastify.authenticate`, not
   * `requireAdmin` — every logged-in user can call it. `probe_error` carries
   * the provider's raw error body, which `llm-http-error.ts` keeps off
   * client-visible paths because it can echo request fragments and internal
   * topology.
   *
   * The route hands its object literal to `.parse()` and returns the *parsed*
   * value, so this schema is the actual gate: a future edit that spreads a
   * capability row into that literal still cannot leak the error, because the
   * key is stripped here.
   */
  it('strips probeError rather than passing it through to non-admin callers', () => {
    const parsed = UsecaseDefaultSchema.parse({
      ...base,
      vision: false,
      probeError: 'chat HTTP 401: {"error":"invalid key for tenant-7 at 10.0.0.4"}',
      probedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(parsed).not.toHaveProperty('probeError');
    expect(parsed).not.toHaveProperty('probedAt');
    expect(JSON.stringify(parsed)).not.toContain('10.0.0.4');
  });
});

describe('VisionCapabilityDetailSchema (#1184)', () => {
  const base = {
    providerId: '00000000-0000-4000-8000-000000000001',
    model: 'qwen2.5vl',
    probedAt: '2026-08-01T12:00:00.000Z',
    probeError: null,
  };

  it.each([true, false, null])('accepts vision: %j', (vision) => {
    expect(() => VisionCapabilityDetailSchema.parse({ ...base, vision })).not.toThrow();
  });

  // A model that has never been probed has no row at all — the admin read
  // answers with the resolved pair and nulls rather than 404ing, so the badge
  // can render "Unconfirmed" without special-casing a missing response.
  it('accepts a never-probed pair (probedAt null)', () => {
    const parsed = VisionCapabilityDetailSchema.parse({
      ...base,
      vision: null,
      probedAt: null,
    });
    expect(parsed.probedAt).toBeNull();
  });

  it('rejects vision being absent', () => {
    expect(() => VisionCapabilityDetailSchema.parse(base)).toThrow();
  });

  it('rejects probeError being absent', () => {
    const { probeError: _omitted, ...withoutError } = base;
    expect(() => VisionCapabilityDetailSchema.parse({ ...withoutError, vision: false })).toThrow();
  });
});

/**
 * #1115 P2 — what `GET /api/admin/embedding/image-index` answers.
 *
 * The shape carries three separate facts that read alike and are not: whether
 * the leg is ASSIGNED, what the column's identity IS, and what the last run
 * DID. An instance can be assigned with an empty index (nothing scanned yet),
 * unassigned with a full one (the leg was turned off and the rows survive —
 * unassigning destroys nothing, ADR-025 D7), or assigned with a last run that
 * failed. Each is nullable in its own right so the card cannot infer one from
 * another.
 */
describe('ImageIndexStatusSchema (#1115 P2)', () => {
  const base = {
    assigned: true,
    identity: {
      providerId: '00000000-0000-4000-8000-000000000001',
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      dimensions: 2048,
      tier: 'halfvec' as const,
    },
    identityMatchesAssignment: true,
    rows: 42,
    pagesDirty: 3,
    pagesTotal: 120,
    running: false,
    lastRun: {
      at: '2026-08-17T12:00:00.000Z',
      pages: 12,
      embedded: 20,
      reused: 5,
      removed: 1,
      failed: 0,
      pagesFailed: 0,
      skipped: { missing: 1, unsupported: 2, oversized: 0, tooLarge: 0, capped: 3, external: 0 },
    },
  };

  it('accepts the fully-populated shape', () => {
    expect(() => ImageIndexStatusSchema.parse(base)).not.toThrow();
  });

  it('accepts an unassigned instance whose index still holds rows', () => {
    // Unassigning is not destructive: the leg goes off and the index survives.
    const parsed = ImageIndexStatusSchema.parse({
      ...base,
      assigned: false,
      identity: null,
      lastRun: null,
    });
    expect(parsed.identity).toBeNull();
    expect(parsed.rows).toBe(42);
  });

  it('rejects a missing lastRun key — null and absent must not read alike', () => {
    const { lastRun: _dropped, ...without } = base;
    expect(() => ImageIndexStatusSchema.parse(without)).toThrow();
  });

  it('requires every skip reason on a run, so a dropped counter cannot read as zero', () => {
    for (const reason of ['missing', 'unsupported', 'oversized', 'tooLarge', 'capped', 'external'] as const) {
      const { [reason]: _dropped, ...skipped } = base.lastRun.skipped;
      expect(
        () => ImageIndexStatusSchema.parse({ ...base, lastRun: { ...base.lastRun, skipped } }),
        `${reason} must be required`,
      ).toThrow();
    }
  });

  it('rejects negative counters and an unknown tier', () => {
    expect(() => ImageIndexStatusSchema.parse({ ...base, rows: -1 })).toThrow();
    expect(() =>
      ImageIndexStatusSchema.parse({ ...base, identity: { ...base.identity, tier: 'ivfflat' } }),
    ).toThrow();
  });

  it('carries no provider base URL or key — this is the index document, not the provider one', () => {
    const parsed = ImageIndexStatusSchema.parse({
      ...base,
      identity: { ...base.identity, baseUrl: 'http://vllm:8000/v1', apiKey: 'sk-secret' },
    });
    expect(parsed.identity).not.toHaveProperty('baseUrl');
    expect(parsed.identity).not.toHaveProperty('apiKey');
  });

  /**
   * Review r1 — `identity` deliberately merges the LIVE assignment's pair with
   * the RECORDED index's width, so the payload has to carry whether they
   * agree. The three states are not interchangeable: `false` is a real
   * mismatch (the guarded-DDL branch), `null` is "nothing to compare", and a
   * missing key would read as either.
   */
  it('requires identityMatchesAssignment, and takes all three states', () => {
    const { identityMatchesAssignment: _dropped, ...without } = base;
    expect(() => ImageIndexStatusSchema.parse(without)).toThrow();
    for (const value of [true, false, null]) {
      expect(() =>
        ImageIndexStatusSchema.parse({ ...base, identityMatchesAssignment: value }),
      ).not.toThrow();
    }
  });

  /**
   * `pagesFailed` counts pages whose WRITE threw, which is a different outage
   * from an image the provider refused — and it defaults, so a run recorded
   * before the field existed still parses instead of being dropped whole on
   * upgrade (`readImageIndexLastRun` answers null on a parse failure).
   */
  it('defaults pagesFailed to 0 for a run recorded before the field existed', () => {
    const { pagesFailed: _dropped, ...older } = base.lastRun;
    const parsed = ImageIndexStatusSchema.parse({ ...base, lastRun: older });
    expect(parsed.lastRun?.pagesFailed).toBe(0);
    expect(parsed.lastRun?.embedded).toBe(20);
  });

  it('rejects a negative pagesFailed', () => {
    expect(() =>
      ImageIndexStatusSchema.parse({ ...base, lastRun: { ...base.lastRun, pagesFailed: -1 } }),
    ).toThrow();
  });
});
