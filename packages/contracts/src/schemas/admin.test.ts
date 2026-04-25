import { describe, it, expect } from 'vitest';
import {
  UpdateAdminSettingsSchema,
  AdminSettingsSchema,
  EmbeddingLockSnapshotSchema,
  AdminEmbeddingLocksResponseSchema,
  ForceReleaseLockResponseSchema,
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
