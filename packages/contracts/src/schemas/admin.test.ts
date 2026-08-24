import { describe, it, expect } from 'vitest';
import {
  UpdateAdminSettingsSchema,
  AdminSettingsSchema,
  ConfidenceCalibrationSchema,
  ConfidenceCalibrationWriteSchema,
  RagConfidenceCalibrationWriteSchema,
  UpdateAdminSettingsResultSchema,
  EmbeddingLockSnapshotSchema,
  AdminEmbeddingLocksResponseSchema,
  ForceReleaseLockResponseSchema,
  FTS_LANGUAGES,
  FtsLanguageEnum,
  AttachmentSweepRunSchema,
  AttachmentSweepTriggerSchema,
  AttachmentStorageStatsSchema,
} from './admin.js';

const validReadPayload = {
  embeddingDimensions: 1024,
  ftsLanguage: 'simple',
  embeddingChunkSize: 500,
  embeddingChunkOverlap: 50,
  drawioEmbedUrl: null,
  // #1115 — required on read, null on every instance that has not asked the
  // image leg for MRL truncation.
  imageEmbeddingTargetDimensions: null,
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
  // #1115 P2 — the image-index intake knobs, required on read like the nine
  // above and for the same reason: the panel must never have to restate a
  // default the reader owns.
  ragImagesPerPageMax: 20,
  ragImageIndexExternal: true,
  // #1115 P3 — the retrieval half, required on read for the same reason.
  ragImageLegEnabled: true,
  // #1115 P4 — how many retrieved images the answer path may show the model.
  ragAnswerMaxImages: 2,
  // #1285 — the HNSW ef_search floor, required on read like every knob above.
  ragEfSearch: 100,
  // #1285 review r1 — and where it came from, so the panel can tell an
  // instance still running on RAG_EF_SEARCH from one holding a saved row.
  ragEfSearchFromEnv: false,
  // #1114 — required on read; both bases null on an instance that has never
  // set a threshold (the 0/0 default).
  ragConfidenceCalibration: { similarity: null, rerank: null },
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
      // #1115 P2 — the two image-intake knobs join the same contract.
      'ragImagesPerPageMax',
      'ragImageIndexExternal',
      // #1115 P3 — and the retrieval half.
      'ragImageLegEnabled',
      // #1115 P4 — and the answer-path cap.
      'ragAnswerMaxImages',
      // #1285 — and the ef_search floor.
      'ragEfSearch',
      // #1285 review r1 — and its provenance. Required for the same reason
      // the value is: the panel's remedy for an env-sourced floor is
      // unreachable without it, so a payload that omits it is not one this
      // panel can render honestly.
      'ragEfSearchFromEnv',
    ] as const) {
      const { [key]: _dropped, ...without } = validReadPayload;
      expect(() => AdminSettingsSchema.parse(without), `${key} must be required`).toThrow();
    }
  });

  describe('#1115 P2 — image-index intake knobs mirror their readers', () => {
    it('rag_images_per_page_max accepts [1, 200] integers', () => {
      expect(UpdateAdminSettingsSchema.parse({ ragImagesPerPageMax: 1 }).ragImagesPerPageMax).toBe(1);
      expect(UpdateAdminSettingsSchema.parse({ ragImagesPerPageMax: 200 }).ragImagesPerPageMax).toBe(
        200,
      );
    });

    it('rag_images_per_page_max rejects 0, 201 and a fractional cap', () => {
      // 0 is not "unlimited" and not "off" — the leg is switched off by
      // unassigning the use case, which is ADR-021's rule for it.
      expect(() => UpdateAdminSettingsSchema.parse({ ragImagesPerPageMax: 0 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragImagesPerPageMax: 201 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragImagesPerPageMax: 20.5 })).toThrow();
    });

    it('rag_image_index_external is a boolean on both schemas', () => {
      expect(
        UpdateAdminSettingsSchema.parse({ ragImageIndexExternal: false }).ragImageIndexExternal,
      ).toBe(false);
      expect(() => UpdateAdminSettingsSchema.parse({ ragImageIndexExternal: 'off' })).toThrow();
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, ragImageIndexExternal: 'off' }),
      ).toThrow();
    });
  });

  describe('#1115 P3 — the image retrieval leg', () => {
    it('rag_image_leg_enabled is a boolean on both schemas', () => {
      expect(
        UpdateAdminSettingsSchema.parse({ ragImageLegEnabled: false }).ragImageLegEnabled,
      ).toBe(false);
      // Not a string, and not 0/1: the backend reader's OFF-list parses
      // `'true'`/`'false'`, and anything it does not recognise leaves the
      // default standing — so a value that reaches SQL in another shape would
      // silently fail to turn the leg off.
      expect(() => UpdateAdminSettingsSchema.parse({ ragImageLegEnabled: 'off' })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragImageLegEnabled: 0 })).toThrow();
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, ragImageLegEnabled: 'off' }),
      ).toThrow();
    });
  });

  describe('#1115 P4 — the answer-path image cap', () => {
    it('rag_answer_max_images accepts [0, 8] integers', () => {
      expect(UpdateAdminSettingsSchema.parse({ ragAnswerMaxImages: 0 }).ragAnswerMaxImages).toBe(0);
      expect(UpdateAdminSettingsSchema.parse({ ragAnswerMaxImages: 8 }).ragAnswerMaxImages).toBe(8);
    });

    it('accepts 0 — unlike the INTAKE cap, zero is a real value here', () => {
      // `ragImagesPerPageMax` refuses 0 because a zero INTAKE cap reconciles
      // every row away on the next scan, which reads as an indexing bug. A
      // zero ANSWER cap destroys nothing: the index keeps filling, the leg
      // keeps ranking, the sources keep their thumbnails — the model simply
      // stops being shown the pictures. That is the honest off switch for the
      // one cost this knob bounds (bytes sent to a vision model), so it must
      // be reachable.
      expect(() => UpdateAdminSettingsSchema.parse({ ragAnswerMaxImages: 0 })).not.toThrow();
    });

    it('rejects 9, a negative cap and a fractional one', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ ragAnswerMaxImages: 9 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragAnswerMaxImages: -1 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragAnswerMaxImages: 2.5 })).toThrow();
      expect(() =>
        AdminSettingsSchema.parse({ ...validReadPayload, ragAnswerMaxImages: '2' }),
      ).toThrow();
    });
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

  /**
   * #1115 — the MRL truncation width the image leg sends. Three states, and
   * the middle one is the reason this is `nullish` rather than `optional`:
   * omitted leaves the stored width alone, `null` clears it back to the
   * model's native width, and a number pins it.
   */
  describe('image_embedding_target_dimensions — [64, 16000] integer or null', () => {
    it('accepts the bounds and an explicit null', () => {
      expect(
        UpdateAdminSettingsSchema.parse({ imageEmbeddingTargetDimensions: 64 })
          .imageEmbeddingTargetDimensions,
      ).toBe(64);
      expect(
        UpdateAdminSettingsSchema.parse({ imageEmbeddingTargetDimensions: 16_000 })
          .imageEmbeddingTargetDimensions,
      ).toBe(16_000);
      expect(
        UpdateAdminSettingsSchema.parse({ imageEmbeddingTargetDimensions: null })
          .imageEmbeddingTargetDimensions,
      ).toBeNull();
    });

    it('rejects below 64, above pgvector’s ceiling, and non-integers', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ imageEmbeddingTargetDimensions: 63 })).toThrow();
      expect(() =>
        UpdateAdminSettingsSchema.parse({ imageEmbeddingTargetDimensions: 16_001 }),
      ).toThrow();
      expect(() =>
        UpdateAdminSettingsSchema.parse({ imageEmbeddingTargetDimensions: 2048.5 }),
      ).toThrow();
    });

    /**
     * 4000 is the largest INDEXABLE width, not the largest legal one. The
     * settings row reports the unindexed tier; refusing the number here would
     * leave an operator who deliberately wants a sequential scan unable to say
     * so, and would contradict `columnTypeFor`, which accepts it.
     */
    it('accepts an unindexable-but-storable width', () => {
      expect(
        UpdateAdminSettingsSchema.parse({ imageEmbeddingTargetDimensions: 4096 })
          .imageEmbeddingTargetDimensions,
      ).toBe(4096);
    });

    it('leaves the stored width alone when the field is omitted', () => {
      expect(UpdateAdminSettingsSchema.parse({})).not.toHaveProperty(
        'imageEmbeddingTargetDimensions',
      );
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

  // #1285 — the ef_search floor. Its range mirrors pgvector's own bound rather
  // than a reader-invented one, and the reader mirrors it back: [1, 1000].
  describe('rag_ef_search — [1, 1000] integer', () => {
    it('accepts the bounds', () => {
      expect(UpdateAdminSettingsSchema.parse({ ragEfSearch: 1 }).ragEfSearch).toBe(1);
      expect(UpdateAdminSettingsSchema.parse({ ragEfSearch: 1000 }).ragEfSearch).toBe(1000);
    });
    // 0 is not "off" for this knob — pgvector's floor is 1 and the reader
    // treats a zero row as unset, so the schema must not let one be saved.
    it('rejects 0, above 1000, and non-integers', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ ragEfSearch: 0 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragEfSearch: 1001 })).toThrow();
      expect(() => UpdateAdminSettingsSchema.parse({ ragEfSearch: 100.5 })).toThrow();
      expect(() => AdminSettingsSchema.parse({ ...validReadPayload, ragEfSearch: '100' })).toThrow();
    });

    it('carries the provenance flag on read only — it is a fact, not a setting', () => {
      expect(
        AdminSettingsSchema.parse({ ...validReadPayload, ragEfSearchFromEnv: true })
          .ragEfSearchFromEnv,
      ).toBe(true);
      // No write counterpart: the operator cannot ask the server to pretend
      // the value came from somewhere else.
      expect(
        'ragEfSearchFromEnv' in UpdateAdminSettingsSchema.parse({ ragEfSearchFromEnv: true } as never),
      ).toBe(false);
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

// ─── #1114 — a threshold remembers the model it was tuned on ─────────────
//
// The scales the two confidence thresholds sit on are set by the models
// behind them (cosine by the embedder, relevance by the reranker), so a model
// swap silently reinterprets a number nobody touched. The server records the
// pair each threshold was saved against and reports whether it still matches
// the live one. Read-only: the calibration is the SERVER's record of what it
// resolved at write time, never something a client asserts.
describe('rag confidence calibration (#1114)', () => {
  const record = {
    providerId: '11111111-2222-3333-4444-555555555555',
    model: 'bge-m3',
    setAt: '2026-08-16T10:00:00.000Z',
    liveProviderId: '11111111-2222-3333-4444-555555555555',
    liveModel: 'bge-m3',
    liveResolved: true,
    stale: false,
  };

  it('is required on read, with both bases nullable', () => {
    const { ragConfidenceCalibration: _dropped, ...without } = validReadPayload;
    expect(() => AdminSettingsSchema.parse(without)).toThrow();
    expect(
      AdminSettingsSchema.parse({
        ...validReadPayload,
        ragConfidenceCalibration: { similarity: null, rerank: null },
      }).ragConfidenceCalibration,
    ).toEqual({ similarity: null, rerank: null });
  });

  it('carries the recorded pair, the live pair and the verdict', () => {
    expect(ConfidenceCalibrationSchema.parse(record)).toEqual(record);
  });

  it('accepts a null live pair — "unassigned now" is a real state, and a stale one', () => {
    const parsed = ConfidenceCalibrationSchema.parse({
      ...record,
      liveProviderId: null,
      liveModel: null,
      stale: true,
    });
    expect(parsed.liveModel).toBeNull();
    expect(parsed.stale).toBe(true);
  });

  it('puts nothing provider-secret on the wire — id and model name only', () => {
    const parsed = ConfidenceCalibrationSchema.parse({
      ...record,
      apiKey: 'sk-live-do-not-ship-me',
      baseUrl: 'https://internal.embeddings.example/v1',
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('apiKey');
    expect(parsed).not.toHaveProperty('baseUrl');
    expect(Object.keys(parsed).sort()).toEqual(
      ['liveModel', 'liveProviderId', 'liveResolved', 'model', 'providerId', 'setAt', 'stale'].sort(),
    );
  });

  it('accepts a null RECORDED pair — "saved while nothing was assigned" is a record, not an absence', () => {
    // Review r1. A rerank threshold set while the stage is unassigned
    // (ADR-021's normal disabled state) used to be stored as a literal null,
    // which read back as "never recorded" — so the panel told the operator the
    // number predated the feature and offered a remedy that re-wrote the same
    // absence forever. It is a record with a null pair, and it goes stale the
    // moment a model appears behind that basis.
    const parsed = ConfidenceCalibrationSchema.parse({
      ...record,
      providerId: null,
      model: null,
      liveProviderId: '99999999-9999-4999-8999-999999999999',
      liveModel: 'jina-reranker-v2',
      stale: true,
    });
    expect(parsed.providerId).toBeNull();
    expect(parsed.model).toBeNull();
    expect(parsed.stale).toBe(true);
  });

  it('rejects an EMPTY recorded model — absent is null, never the empty string', () => {
    expect(() => ConfidenceCalibrationSchema.parse({ ...record, model: '' })).toThrow();
    expect(() => ConfidenceCalibrationSchema.parse({ ...record, providerId: '' })).toThrow();
  });

  it('rejects a setAt that is not an instant', () => {
    expect(() => ConfidenceCalibrationSchema.parse({ ...record, setAt: 'yesterday' })).toThrow();
  });

  it('separates "nothing is assigned" from "the resolver could not answer"', () => {
    // Review r3. Both arrive on the wire with a null live pair, and only the
    // first is a fact about `llm_usecase_assignments` — the second is an
    // undecryptable provider row or an EE policy naming a deleted provider,
    // both of which persist across every GET. The panel words them
    // differently, so the field must exist to word them from.
    expect(() => ConfidenceCalibrationSchema.parse({ ...record, liveResolved: undefined })).toThrow();
    const unassigned = ConfidenceCalibrationSchema.parse({
      ...record,
      liveProviderId: null,
      liveModel: null,
      liveResolved: true,
      stale: true,
    });
    const unreadable = ConfidenceCalibrationSchema.parse({
      ...record,
      liveProviderId: null,
      liveModel: null,
      liveResolved: false,
      stale: true,
    });
    expect(unassigned.liveResolved).toBe(true);
    expect(unreadable.liveResolved).toBe(false);
    // Both stay stale: erring toward "this still needs attention" is the safe
    // direction, and the verdict is recomputed on every GET either way.
    expect(unassigned.stale).toBe(true);
    expect(unreadable.stale).toBe(true);
  });

  it('is not settable through the update schema', () => {
    // A client that could assert the calibration could also assert "still
    // calibrated" for a threshold tuned against a model that is long gone.
    expect(
      UpdateAdminSettingsSchema.parse({
        ragConfidenceThreshold: 0.35,
        ragConfidenceCalibration: { similarity: record, rerank: null },
      } as Record<string, unknown>),
    ).toEqual({ ragConfidenceThreshold: 0.35 });
  });
});

// ─── #1114 review r3 — the PUT reports what it did with the record ────────
//
// The route answers 200 whether or not the calibration was written: the
// threshold row itself always lands, and the bookkeeping beside it is
// best-effort and can be declined outright when the live model cannot be
// resolved. A client that reads the status code as the outcome tells the
// operator "recorded" and then re-renders the same notice.
describe('rag confidence calibration write outcome (#1114)', () => {
  it('names the model when it recorded one', () => {
    expect(ConfidenceCalibrationWriteSchema.parse({ outcome: 'recorded', model: 'bge-m3' })).toEqual({
      outcome: 'recorded',
      model: 'bge-m3',
    });
  });

  it('accepts a recorded write with no model — the disabled rerank stage is a record', () => {
    expect(
      ConfidenceCalibrationWriteSchema.parse({ outcome: 'recorded', model: null }).model,
    ).toBeNull();
  });

  it('carries the three non-recording outcomes apart', () => {
    for (const outcome of ['cleared', 'unresolved', 'failed'] as const) {
      expect(ConfidenceCalibrationWriteSchema.parse({ outcome, model: null }).outcome).toBe(outcome);
    }
    expect(() => ConfidenceCalibrationWriteSchema.parse({ outcome: 'ok', model: null })).toThrow();
  });

  it('is per basis, and null where the request carried no threshold for it', () => {
    expect(
      RagConfidenceCalibrationWriteSchema.parse({
        similarity: { outcome: 'recorded', model: 'bge-m3' },
        rerank: null,
      }),
    ).toEqual({ similarity: { outcome: 'recorded', model: 'bge-m3' }, rerank: null });
  });

  it('is optional on the PUT result — an older server simply says nothing', () => {
    expect(UpdateAdminSettingsResultSchema.parse({ message: 'Admin settings updated' })).toEqual({
      message: 'Admin settings updated',
    });
    expect(
      UpdateAdminSettingsResultSchema.parse({
        message: 'Admin settings updated',
        ragConfidenceCalibrationWrite: { similarity: { outcome: 'unresolved', model: null }, rerank: null },
      }).ragConfidenceCalibrationWrite?.similarity?.outcome,
    ).toBe('unresolved');
  });
});

// ─── #1349 — attachment storage + orphan sweep ──────────────────────────────

describe('attachment sweep contracts (#1349)', () => {
  const storeStats = {
    bytes: 10,
    files: 2,
    directories: 1,
    orphanDirectories: 0,
    orphanDirectoryBytes: 0,
    orphanFiles: 1,
    orphanFileBytes: 5,
    graceSkipped: 0,
    unreadableDirectories: 0,
  };

  it('a completed dry run parses with candidates and no deleted block', () => {
    const run = AttachmentSweepRunSchema.parse({
      at: '2026-08-22T10:00:00.000Z',
      dryRun: true,
      status: 'completed',
      note: null,
      durationMs: 12,
      stores: { confluence: storeStats, local: storeStats },
      missingLocalFiles: 0,
      candidateSample: [
        { store: 'confluence', key: '55555', filename: null, bytes: 5, reason: 'orphan_directory' },
      ],
      candidatesTotal: 1,
      deleted: null,
    });
    expect(run.candidateSample[0]!.reason).toBe('orphan_directory');
  });

  it('a refused run carries its note and null stores', () => {
    const run = AttachmentSweepRunSchema.parse({
      at: '2026-08-22T10:00:00.000Z',
      dryRun: false,
      status: 'refused',
      note: 'attachments root missing or unreadable',
      durationMs: 1,
      stores: null,
      missingLocalFiles: 0,
      candidateSample: [],
      candidatesTotal: 0,
      deleted: null,
    });
    expect(run.status).toBe('refused');
  });

  it('the trigger requires an explicit dryRun boolean', () => {
    expect(AttachmentSweepTriggerSchema.parse({ dryRun: false })).toEqual({ dryRun: false });
    expect(() => AttachmentSweepTriggerSchema.parse({})).toThrow();
    expect(() => AttachmentSweepTriggerSchema.parse({ dryRun: 'yes' })).toThrow();
  });

  it('the stats shape has an explicit no-run-yet state', () => {
    const empty = AttachmentStorageStatsSchema.parse({
      computedAt: null,
      running: false,
      stores: null,
      missingLocalFiles: null,
    });
    expect(empty.stores).toBeNull();
  });
});
