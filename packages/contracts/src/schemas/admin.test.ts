import { describe, it, expect } from 'vitest';
import {
  UpdateAdminSettingsSchema,
  AdminSettingsSchema,
  EmbeddingLockSnapshotSchema,
  AdminEmbeddingLocksResponseSchema,
  ForceReleaseLockResponseSchema,
  FTS_LANGUAGES,
  FtsLanguageEnum,
} from './admin.js';

const validReadPayload = {
  embeddingDimensions: 1024,
  ftsLanguage: 'simple',
  embeddingChunkSize: 500,
  embeddingChunkOverlap: 50,
  drawioEmbedUrl: null,
  reembedHistoryRetention: 150,
  adminAccessDeniedRetentionDays: 90,
  // Compendiq/compendiq-ee#113 Phase B-3 — required on read so a GET response
  // can never silently drop the cluster-wide LLM queue settings.
  llmConcurrency: 4,
  llmMaxQueueDepth: 50,
  // Issue #1051 — self-registration policy (required on read).
  registrationMode: 'closed',
  // #1118 — retrieval knobs, required on read. Values are the reader defaults.
  ragFetchWidth: 10,
  ragRerankCandidates: 30,
  ragConfidenceThreshold: 0,
  ragConfidenceThresholdRerank: 0,
  ragContextCharsPerPage: 6000,
  ragPinIdentifiers: true,
  ragMmrEnabled: false,
  ragMmrLambda: 0.7,
  ragRankingPriorWeight: 0,
} as const;

describe('AdminSettingsSchema (read)', () => {
  it('accepts explicit null for drawioEmbedUrl (backend returns null when unset)', () => {
    const parsed = AdminSettingsSchema.parse(validReadPayload);
    expect(parsed.drawioEmbedUrl).toBeNull();
  });

  it('rejects empty ftsLanguage', () => {
    expect(() =>
      AdminSettingsSchema.parse({ ...validReadPayload, ftsLanguage: '' }),
    ).toThrow();
  });

  it('rejects aiGuardrailNoFabrication > 5000 chars — symmetric with update schema', () => {
    expect(() =>
      AdminSettingsSchema.parse({
        ...validReadPayload,
        aiGuardrailNoFabrication: 'x'.repeat(5001),
      }),
    ).toThrow();
  });

  it('accepts aiGuardrailNoFabrication at 5000 chars', () => {
    const parsed = AdminSettingsSchema.parse({
      ...validReadPayload,
      aiGuardrailNoFabrication: 'x'.repeat(5000),
    });
    expect(parsed.aiGuardrailNoFabrication).toHaveLength(5000);
  });
});

// ─── #1114 — the keyword-index language is a closed allow-list ────────────
//
// `fts_language` is the ONE admin setting whose value reaches SQL as an
// identifier rather than a bind parameter: PostgreSQL has no parameterized
// `regconfig`, so `rag-service.ts` interpolates it into
// `websearch_to_tsquery('<lang>', $2)`. The allow-list is therefore a
// security boundary, and it lives here so the panel, the route and the
// reader cannot each carry their own copy of it.
describe('ftsLanguage — closed enum shared by panel, route and reader (#1114)', () => {
  it('exports the configurations as a list and an enum built from that same list', () => {
    expect(FTS_LANGUAGES.length).toBeGreaterThan(1);
    expect(FTS_LANGUAGES).toContain('simple');
    // German is the production content language this consolidation exists for.
    expect(FTS_LANGUAGES).toContain('german');
    expect([...FtsLanguageEnum.options]).toEqual([...FTS_LANGUAGES]);
  });

  it('accepts every listed configuration on read AND on update', () => {
    for (const lang of FTS_LANGUAGES) {
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, ftsLanguage: lang }).ftsLanguage,
      ).toBe(lang);
      expect(UpdateAdminSettingsSchema.parse({ ftsLanguage: lang }).ftsLanguage).toBe(lang);
    }
  });

  it('rejects anything outside the list on both schemas', () => {
    // `SIMPLE` is included deliberately: regconfig names are lower-case, and a
    // case-insensitive allow-list would be a wider surface than the SQL needs.
    for (const bad of ['', 'klingon', 'SIMPLE', "simple'); DROP TABLE pages; --"]) {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, ftsLanguage: bad }),
        `read schema accepted "${bad}"`,
      ).toThrow();
      expect(
        () => UpdateAdminSettingsSchema.parse({ ftsLanguage: bad }),
        `update schema accepted "${bad}"`,
      ).toThrow();
    }
  });

  it('treats an omitted ftsLanguage as leave-unchanged on update', () => {
    expect(UpdateAdminSettingsSchema.parse({}).ftsLanguage).toBeUndefined();
  });
});

describe('UpdateAdminSettingsSchema tri-state semantics', () => {
  describe('drawioEmbedUrl', () => {
    it('accepts a valid URL', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ drawioEmbedUrl: 'https://drawio.example.com' });
      expect(parsed.drawioEmbedUrl).toBe('https://drawio.example.com');
    });

    it('accepts explicit null (clear signal)', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ drawioEmbedUrl: null });
      expect(parsed.drawioEmbedUrl).toBeNull();
    });

    it('treats omitted field as undefined (leave unchanged)', () => {
      const parsed = UpdateAdminSettingsSchema.parse({});
      expect(parsed.drawioEmbedUrl).toBeUndefined();
    });

    it('rejects empty string (callers must send null to clear)', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ drawioEmbedUrl: '' })).toThrow();
    });

    it('rejects non-URL strings', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ drawioEmbedUrl: 'not-a-url' })).toThrow();
    });
  });

  // LLM-specific settings (openaiBaseUrl, openaiModel, ollamaModel, etc.)
  // moved to the `llm_providers` table + `/api/admin/llm-providers` route;
  // they are no longer part of AdminSettings.
});

// ─── Plan §2.6 / §4.8 RED #12 — reembedHistoryRetention validation ─────────
describe('reembedHistoryRetention (issue #257)', () => {
  describe('read schema', () => {
    it('accepts a valid integer within [10, 10000]', () => {
      const parsed = AdminSettingsSchema.parse({
        ...validReadPayload,
        reembedHistoryRetention: 500,
      });
      expect(parsed.reembedHistoryRetention).toBe(500);
    });

    it('rejects values below 10', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, reembedHistoryRetention: 9 }),
      ).toThrow();
    });

    it('rejects values above 10000', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, reembedHistoryRetention: 10_001 }),
      ).toThrow();
    });

    it('rejects non-integer values', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, reembedHistoryRetention: 100.5 }),
      ).toThrow();
    });

    it('requires the field to be present (not optional on read)', () => {
      const { reembedHistoryRetention: _r, ...withoutField } = validReadPayload;
      expect(() => AdminSettingsSchema.parse(withoutField)).toThrow();
    });
  });

  describe('update schema', () => {
    it('accepts a valid integer within [10, 10000]', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ reembedHistoryRetention: 250 });
      expect(parsed.reembedHistoryRetention).toBe(250);
    });

    it('treats omitted field as undefined (leave unchanged)', () => {
      const parsed = UpdateAdminSettingsSchema.parse({});
      expect(parsed.reembedHistoryRetention).toBeUndefined();
    });

    it('rejects values below 10', () => {
      expect(() =>
        UpdateAdminSettingsSchema.parse({ reembedHistoryRetention: 5 }),
      ).toThrow();
    });

    it('rejects values above 10000', () => {
      expect(() =>
        UpdateAdminSettingsSchema.parse({ reembedHistoryRetention: 20_000 }),
      ).toThrow();
    });
  });
});

// ─── #264 — adminAccessDeniedRetentionDays validation ────────────────────
describe('adminAccessDeniedRetentionDays (issue #264)', () => {
  describe('read schema', () => {
    it('accepts a valid integer within [7, 3650]', () => {
      const parsed = AdminSettingsSchema.parse({
        ...validReadPayload,
        adminAccessDeniedRetentionDays: 30,
      });
      expect(parsed.adminAccessDeniedRetentionDays).toBe(30);
    });

    it('accepts boundary values — 7 and 3650', () => {
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, adminAccessDeniedRetentionDays: 7 })
          .adminAccessDeniedRetentionDays,
      ).toBe(7);
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, adminAccessDeniedRetentionDays: 3650 })
          .adminAccessDeniedRetentionDays,
      ).toBe(3650);
    });

    it('rejects values below 7', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, adminAccessDeniedRetentionDays: 6 }),
      ).toThrow();
    });

    it('rejects values above 3650', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, adminAccessDeniedRetentionDays: 3651 }),
      ).toThrow();
    });

    it('rejects non-integer values', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, adminAccessDeniedRetentionDays: 30.5 }),
      ).toThrow();
    });

    it('requires the field to be present (not optional on read)', () => {
      const { adminAccessDeniedRetentionDays: _d, ...withoutField } = validReadPayload;
      expect(() => AdminSettingsSchema.parse(withoutField)).toThrow();
    });
  });

  describe('update schema', () => {
    it('accepts a valid integer within [7, 3650]', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ adminAccessDeniedRetentionDays: 45 });
      expect(parsed.adminAccessDeniedRetentionDays).toBe(45);
    });

    it('treats omitted field as undefined (leave unchanged)', () => {
      const parsed = UpdateAdminSettingsSchema.parse({});
      expect(parsed.adminAccessDeniedRetentionDays).toBeUndefined();
    });

    it('rejects values below 7', () => {
      expect(() =>
        UpdateAdminSettingsSchema.parse({ adminAccessDeniedRetentionDays: 6 }),
      ).toThrow();
    });

    it('rejects values above 3650', () => {
      expect(() =>
        UpdateAdminSettingsSchema.parse({ adminAccessDeniedRetentionDays: 3651 }),
      ).toThrow();
    });

    it('rejects non-integer values', () => {
      expect(() =>
        UpdateAdminSettingsSchema.parse({ adminAccessDeniedRetentionDays: 30.5 }),
      ).toThrow();
    });
  });
});

// ─── #113 Phase B-3 — llmConcurrency / llmMaxQueueDepth validation ─────────
describe('llmConcurrency (Compendiq/compendiq-ee#113 Phase B-3)', () => {
  describe('read schema', () => {
    it('accepts a valid integer within [1, 100]', () => {
      const parsed = AdminSettingsSchema.parse({
        ...validReadPayload,
        llmConcurrency: 7,
      });
      expect(parsed.llmConcurrency).toBe(7);
    });

    it('accepts boundary values — 1 and 100', () => {
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, llmConcurrency: 1 }).llmConcurrency,
      ).toBe(1);
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, llmConcurrency: 100 }).llmConcurrency,
      ).toBe(100);
    });

    it('rejects 0 (would deadlock pLimit)', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, llmConcurrency: 0 }),
      ).toThrow();
    });

    it('rejects values above 100', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, llmConcurrency: 101 }),
      ).toThrow();
    });

    it('rejects non-integer values', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, llmConcurrency: 4.5 }),
      ).toThrow();
    });

    it('requires the field on read', () => {
      const { llmConcurrency: _c, ...without } = validReadPayload;
      expect(() => AdminSettingsSchema.parse(without)).toThrow();
    });
  });

  describe('update schema', () => {
    it('accepts a valid integer within [1, 100]', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ llmConcurrency: 10 });
      expect(parsed.llmConcurrency).toBe(10);
    });

    it('treats omitted field as undefined (leave unchanged)', () => {
      const parsed = UpdateAdminSettingsSchema.parse({});
      expect(parsed.llmConcurrency).toBeUndefined();
    });

    it('rejects 0', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ llmConcurrency: 0 })).toThrow();
    });

    it('rejects values above 100', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ llmConcurrency: 101 })).toThrow();
    });
  });
});

describe('llmMaxQueueDepth (Compendiq/compendiq-ee#113 Phase B-3)', () => {
  describe('read schema', () => {
    it('accepts a valid integer within [1, 1000]', () => {
      const parsed = AdminSettingsSchema.parse({
        ...validReadPayload,
        llmMaxQueueDepth: 200,
      });
      expect(parsed.llmMaxQueueDepth).toBe(200);
    });

    it('accepts boundary values — 1 and 1000', () => {
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, llmMaxQueueDepth: 1 }).llmMaxQueueDepth,
      ).toBe(1);
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, llmMaxQueueDepth: 1000 }).llmMaxQueueDepth,
      ).toBe(1000);
    });

    it('rejects 0', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, llmMaxQueueDepth: 0 }),
      ).toThrow();
    });

    it('rejects values above 1000', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, llmMaxQueueDepth: 1001 }),
      ).toThrow();
    });

    it('requires the field on read', () => {
      const { llmMaxQueueDepth: _d, ...without } = validReadPayload;
      expect(() => AdminSettingsSchema.parse(without)).toThrow();
    });
  });

  describe('update schema', () => {
    it('accepts a valid integer within [1, 1000]', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ llmMaxQueueDepth: 75 });
      expect(parsed.llmMaxQueueDepth).toBe(75);
    });

    it('treats omitted field as undefined (leave unchanged)', () => {
      const parsed = UpdateAdminSettingsSchema.parse({});
      expect(parsed.llmMaxQueueDepth).toBeUndefined();
    });

    it('rejects 0', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ llmMaxQueueDepth: 0 })).toThrow();
    });

    it('rejects values above 1000', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ llmMaxQueueDepth: 1001 })).toThrow();
    });
  });
});

// ─── #1051 — registrationMode validation ─────────────────────────────────
describe('registrationMode (issue #1051)', () => {
  describe('read schema', () => {
    it("accepts 'open' and 'closed'", () => {
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, registrationMode: 'open' }).registrationMode,
      ).toBe('open');
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, registrationMode: 'closed' }).registrationMode,
      ).toBe('closed');
    });

    it('rejects an unknown mode (e.g. invite — out of scope)', () => {
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, registrationMode: 'invite' }),
      ).toThrow();
    });

    it('requires the field to be present (not optional on read)', () => {
      const { registrationMode: _m, ...without } = validReadPayload;
      expect(() => AdminSettingsSchema.parse(without)).toThrow();
    });
  });

  describe('update schema', () => {
    it("accepts 'open' and 'closed'", () => {
      expect(UpdateAdminSettingsSchema.parse({ registrationMode: 'open' }).registrationMode).toBe('open');
      expect(UpdateAdminSettingsSchema.parse({ registrationMode: 'closed' }).registrationMode).toBe('closed');
    });

    it('treats omitted field as undefined (leave unchanged)', () => {
      expect(UpdateAdminSettingsSchema.parse({}).registrationMode).toBeUndefined();
    });

    it('rejects an unknown mode', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ registrationMode: 'invite' })).toThrow();
    });
  });
});

// ─── #1118 — retrieval knobs mirror their readers exactly ────────────────
//
// Every bound here was read off `admin-settings-service.ts`. The schema is
// the panel's only defence against reporting "saved" for a value the reader
// throws away, so each boundary is pinned on BOTH sides.
describe('retrieval knobs (#1118)', () => {
  it('requires every knob on read', () => {
    for (const key of [
      'ragFetchWidth',
      'ragRerankCandidates',
      'ragConfidenceThreshold',
      'ragConfidenceThresholdRerank',
      'ragContextCharsPerPage',
      'ragPinIdentifiers',
      'ragMmrEnabled',
      'ragMmrLambda',
      'ragRankingPriorWeight',
    ] as const) {
      const { [key]: _dropped, ...without } = validReadPayload;
      expect(() => AdminSettingsSchema.parse(without), `${key} must be required`).toThrow();
    }
  });

  it('treats every knob as omit-to-leave-unchanged on update', () => {
    expect(UpdateAdminSettingsSchema.parse({})).toEqual({});
  });

  describe('rag_fetch_width — [10, 200] integer', () => {
    it('accepts the bounds', () => {
      expect(UpdateAdminSettingsSchema.parse({ ragFetchWidth: 10 }).ragFetchWidth).toBe(10);
      expect(UpdateAdminSettingsSchema.parse({ ragFetchWidth: 200 }).ragFetchWidth).toBe(200);
    });
    // The reader's MIN is a validity floor, not a clamp: `safeIntOr` falls back
    // to the DEFAULT below it, so accepting 9 here would save a value that
    // silently reads back as 10.
    it('rejects below 10, above 200, and non-integers', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ ragFetchWidth: 9 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragFetchWidth: 201 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragFetchWidth: 10.5 })).toThrow();
    });
  });

  describe('rag_rerank_candidates — [10, 100] integer', () => {
    it('accepts the bounds', () => {
      expect(UpdateAdminSettingsSchema.parse({ ragRerankCandidates: 10 }).ragRerankCandidates).toBe(10);
      expect(UpdateAdminSettingsSchema.parse({ ragRerankCandidates: 100 }).ragRerankCandidates).toBe(100);
    });
    it('rejects below 10, above 100, and non-integers', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ ragRerankCandidates: 9 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragRerankCandidates: 101 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragRerankCandidates: 30.5 })).toThrow();
    });
  });

  describe('confidence thresholds — half-open [0, 1)', () => {
    it.each(['ragConfidenceThreshold', 'ragConfidenceThresholdRerank'] as const)(
      '%s accepts 0 and 0.999 but REJECTS 1',
      (key) => {
        expect(UpdateAdminSettingsSchema.parse({ [key]: 0 })[key]).toBe(0);
        expect(UpdateAdminSettingsSchema.parse({ [key]: 0.999 })[key]).toBe(0.999);
        // `readConfidenceThreshold` requires `n < 1` and logs a rejection for
        // 1, leaving the gate OFF — the opposite of what an operator setting
        // maximal strictness intends. The schema must refuse it at the edge.
        expect(() => UpdateAdminSettingsSchema.parse({ [key]: 1 })).toThrow();
        expect(() => UpdateAdminSettingsSchema.parse({ [key]: -0.1 })).toThrow();
      },
    );
  });

  describe('rag_context_chars_per_page — [0, 24000] integer', () => {
    it('accepts 0 (assembly off) and the 24000 ceiling', () => {
      expect(UpdateAdminSettingsSchema.parse({ ragContextCharsPerPage: 0 }).ragContextCharsPerPage).toBe(0);
      expect(
        UpdateAdminSettingsSchema.parse({ ragContextCharsPerPage: 24_000 }).ragContextCharsPerPage,
      ).toBe(24_000);
    });
    it('rejects negatives, above 24000, and non-integers', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ ragContextCharsPerPage: -1 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragContextCharsPerPage: 24_001 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragContextCharsPerPage: 6000.5 })).toThrow();
    });
  });

  describe('rag_mmr_lambda — [0, 1]', () => {
    it('accepts both bounds', () => {
      expect(UpdateAdminSettingsSchema.parse({ ragMmrLambda: 0 }).ragMmrLambda).toBe(0);
      expect(UpdateAdminSettingsSchema.parse({ ragMmrLambda: 1 }).ragMmrLambda).toBe(1);
    });
    it('rejects outside [0, 1]', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ ragMmrLambda: -0.01 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragMmrLambda: 1.01 })).toThrow();
    });
  });

  describe('rag_ranking_prior_weight — [0, 0.05]', () => {
    it('accepts 0 (off), the measured 0.003 and the 0.05 ceiling', () => {
      expect(UpdateAdminSettingsSchema.parse({ ragRankingPriorWeight: 0 }).ragRankingPriorWeight).toBe(0);
      expect(
        UpdateAdminSettingsSchema.parse({ ragRankingPriorWeight: 0.003 }).ragRankingPriorWeight,
      ).toBe(0.003);
      expect(
        UpdateAdminSettingsSchema.parse({ ragRankingPriorWeight: 0.05 }).ragRankingPriorWeight,
      ).toBe(0.05);
    });
    // 0.05 is where the prior exceeds the leg-agreement gap and starts
    // outranking retrieval itself.
    it('rejects above 0.05 and below 0', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ ragRankingPriorWeight: 0.051 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragRankingPriorWeight: -0.001 })).toThrow();
    });
  });

  describe('the two boolean knobs', () => {
    it.each(['ragPinIdentifiers', 'ragMmrEnabled'] as const)('%s accepts both states', (key) => {
      expect(UpdateAdminSettingsSchema.parse({ [key]: true })[key]).toBe(true);
      expect(UpdateAdminSettingsSchema.parse({ [key]: false })[key]).toBe(false);
    });
    it.each(['ragPinIdentifiers', 'ragMmrEnabled'] as const)('%s rejects a string', (key) => {
      expect(() => UpdateAdminSettingsSchema.parse({ [key]: 'true' })).toThrow();
    });
  });
});

// ─── Plan §3.3 / §4.8 RED #12a — Embedding lock admin schemas ────────────
describe('EmbeddingLockSnapshotSchema (issue #257)', () => {
  it('parses a valid snapshot round-trip', () => {
    const parsed = EmbeddingLockSnapshotSchema.parse({
      userId: 'alice',
      holderEpoch: '11111111-2222-3333-4444-555555555555',
      ttlRemainingMs: 3_400_000,
    });
    expect(parsed.userId).toBe('alice');
    expect(parsed.ttlRemainingMs).toBe(3_400_000);
  });

  it('accepts -1 and -2 as special TTL values (never-expires / key-not-found)', () => {
    expect(
      EmbeddingLockSnapshotSchema.parse({ userId: 'a', holderEpoch: '', ttlRemainingMs: -1 }).ttlRemainingMs,
    ).toBe(-1);
    expect(
      EmbeddingLockSnapshotSchema.parse({ userId: 'a', holderEpoch: '', ttlRemainingMs: -2 }).ttlRemainingMs,
    ).toBe(-2);
  });

  it('accepts an empty holderEpoch (lock race: GET returned null but SCAN saw the key)', () => {
    const parsed = EmbeddingLockSnapshotSchema.parse({ userId: 'alice', holderEpoch: '', ttlRemainingMs: 100 });
    expect(parsed.holderEpoch).toBe('');
  });

  it('rejects missing userId', () => {
    expect(() =>
      EmbeddingLockSnapshotSchema.parse({ holderEpoch: 'x', ttlRemainingMs: 100 }),
    ).toThrow();
  });

  it('rejects non-integer ttlRemainingMs', () => {
    expect(() =>
      EmbeddingLockSnapshotSchema.parse({ userId: 'a', holderEpoch: 'x', ttlRemainingMs: 100.5 }),
    ).toThrow();
  });
});

describe('AdminEmbeddingLocksResponseSchema (issue #257)', () => {
  it('accepts empty array', () => {
    const parsed = AdminEmbeddingLocksResponseSchema.parse({ locks: [] });
    expect(parsed.locks).toEqual([]);
  });

  it('accepts multiple snapshots', () => {
    const parsed = AdminEmbeddingLocksResponseSchema.parse({
      locks: [
        { userId: 'alice', holderEpoch: 'u1', ttlRemainingMs: 1000 },
        { userId: 'bob', holderEpoch: 'u2', ttlRemainingMs: 2000 },
      ],
    });
    expect(parsed.locks).toHaveLength(2);
  });

  it('rejects missing locks array', () => {
    expect(() => AdminEmbeddingLocksResponseSchema.parse({})).toThrow();
  });
});

describe('ForceReleaseLockResponseSchema (issue #257)', () => {
  it('accepts { released: true, userId }', () => {
    const parsed = ForceReleaseLockResponseSchema.parse({ released: true, userId: 'alice' });
    expect(parsed).toEqual({ released: true, userId: 'alice' });
  });

  it('accepts { released: false, userId } (idempotent no-op)', () => {
    const parsed = ForceReleaseLockResponseSchema.parse({ released: false, userId: 'alice' });
    expect(parsed.released).toBe(false);
  });

  it('rejects missing userId', () => {
    expect(() => ForceReleaseLockResponseSchema.parse({ released: true })).toThrow();
  });

  it('rejects non-boolean released', () => {
    expect(() => ForceReleaseLockResponseSchema.parse({ released: 'yes', userId: 'alice' })).toThrow();
  });
});
