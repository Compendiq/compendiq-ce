import { describe, it, expect } from 'vitest';
import { normalizeBaseUrl } from './llm-provider-service.js';

describe('normalizeBaseUrl', () => {
  it('appends /v1 to a bare host', () => {
    expect(normalizeBaseUrl('http://gpu:11434')).toBe('http://gpu:11434/v1');
  });

  it('leaves an OpenAI-compatible root ending in /v1 alone', () => {
    expect(normalizeBaseUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1');
    expect(normalizeBaseUrl('https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api/v1');
  });

  it('does not append /v1 onto a pasted embeddings endpoint', () => {
    // The previous `/v1$` test rewrote this to …/embeddings/v1, which 404s.
    // The client posts `${baseUrl}/embeddings`, so the stored root must be /api/v1.
    expect(normalizeBaseUrl('https://openrouter.ai/api/v1/embeddings/')).toBe(
      'https://openrouter.ai/api/v1',
    );
    expect(normalizeBaseUrl('https://openrouter.ai/api/v1/embeddings/v1')).toBe(
      'https://openrouter.ai/api/v1',
    );
  });

  it('strips /chat/completions without treating /completions as the suffix first', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('does not append /v1 when a version segment is not at the end', () => {
    expect(normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );
  });
});
