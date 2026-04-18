import { describe, it, expect } from 'vitest';
import { UpdateAdminSettingsSchema, AdminSettingsSchema } from './admin.js';

describe('AdminSettingsSchema (read)', () => {
  it('accepts explicit null for drawioEmbedUrl (backend returns null when unset)', () => {
    const parsed = AdminSettingsSchema.parse({
      llmProvider: 'ollama',
      ollamaModel: 'qwen3.5',
      openaiBaseUrl: null,
      hasOpenaiApiKey: false,
      openaiModel: null,
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
      ftsLanguage: 'simple',
      embeddingChunkSize: 500,
      embeddingChunkOverlap: 50,
      drawioEmbedUrl: null,
      usecaseAssignments: {
        chat: { provider: null, model: null },
        summary: { provider: null, model: null },
        quality: { provider: null, model: null },
        auto_tag: { provider: null, model: null },
      },
    });
    expect(parsed.drawioEmbedUrl).toBeNull();
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

  describe('openaiBaseUrl', () => {
    it('accepts a valid URL', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ openaiBaseUrl: 'https://api.example.com/v1' });
      expect(parsed.openaiBaseUrl).toBe('https://api.example.com/v1');
    });

    it('accepts explicit null (clear signal)', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ openaiBaseUrl: null });
      expect(parsed.openaiBaseUrl).toBeNull();
    });

    it('treats omitted field as undefined', () => {
      const parsed = UpdateAdminSettingsSchema.parse({});
      expect(parsed.openaiBaseUrl).toBeUndefined();
    });

    it('rejects empty string', () => {
      expect(() => UpdateAdminSettingsSchema.parse({ openaiBaseUrl: '' })).toThrow();
    });
  });

  describe('openaiModel', () => {
    it('accepts a string value', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ openaiModel: 'gpt-4' });
      expect(parsed.openaiModel).toBe('gpt-4');
    });

    it('accepts explicit null (clear signal)', () => {
      const parsed = UpdateAdminSettingsSchema.parse({ openaiModel: null });
      expect(parsed.openaiModel).toBeNull();
    });

    it('treats omitted field as undefined', () => {
      const parsed = UpdateAdminSettingsSchema.parse({});
      expect(parsed.openaiModel).toBeUndefined();
    });
  });
});
