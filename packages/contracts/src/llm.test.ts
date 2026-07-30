import { describe, it, expect } from 'vitest';
import {
  LlmUsecaseSchema,
  LlmProviderInputSchema,
  UsecaseAssignmentsSchema,
  UsecaseDefaultSchema,
} from './llm.js';
import {
  AskRequestSchema,
  ImproveRequestSchema,
  GenerateRequestSchema,
  SummarizeRequestSchema,
  GenerateDiagramRequestSchema,
  AnalyzeQualityRequestSchema,
} from './schemas/llm.js';

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
});
