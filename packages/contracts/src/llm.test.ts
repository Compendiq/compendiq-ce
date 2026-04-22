import { describe, it, expect } from 'vitest';
import {
  LlmUsecaseSchema,
  LlmProviderInputSchema,
  UsecaseAssignmentsSchema,
} from './llm.js';

describe('LlmUsecaseSchema', () => {
  it('accepts embedding as a valid use case', () => {
    expect(() => LlmUsecaseSchema.parse('embedding')).not.toThrow();
  });
  it('rejects unknown use cases', () => {
    expect(() => LlmUsecaseSchema.parse('bogus')).toThrow();
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
    });
    expect(parsed.embedding).toBeDefined();
  });
});
