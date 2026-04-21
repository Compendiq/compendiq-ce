import { describe, it, expect } from 'vitest';
import { UpdateAdminSettingsSchema, AdminSettingsSchema } from './admin.js';

const validReadPayload = {
  embeddingDimensions: 1024,
  ftsLanguage: 'simple',
  embeddingChunkSize: 500,
  embeddingChunkOverlap: 50,
  drawioEmbedUrl: null,
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
