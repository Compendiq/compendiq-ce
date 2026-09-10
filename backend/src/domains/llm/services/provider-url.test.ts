import { describe, expect, it } from 'vitest';
import { providerResourceUrl } from './provider-url.js';

describe('providerResourceUrl', () => {
  it('appends the resource onto an OpenAI-compatible root', () => {
    expect(providerResourceUrl('https://openrouter.ai/api/v1', 'embeddings')).toBe(
      'https://openrouter.ai/api/v1/embeddings',
    );
    expect(providerResourceUrl('https://openrouter.ai/api/v1/', 'rerank')).toBe(
      'https://openrouter.ai/api/v1/rerank',
    );
  });

  it('does not append /embeddings onto a stored embeddings endpoint', () => {
    expect(
      providerResourceUrl('https://openrouter.ai/api/v1/embeddings', 'embeddings'),
    ).toBe('https://openrouter.ai/api/v1/embeddings');
  });

  it('does not append /rerank onto a stored rerank endpoint', () => {
    expect(providerResourceUrl('https://openrouter.ai/api/v1/rerank', 'rerank')).toBe(
      'https://openrouter.ai/api/v1/rerank',
    );
  });

  it('swaps a stored embeddings path to /models for listModels', () => {
    expect(providerResourceUrl('https://openrouter.ai/api/v1/embeddings', 'models')).toBe(
      'https://openrouter.ai/api/v1/models',
    );
  });

  it('strips /chat/completions before /completions when swapping', () => {
    expect(
      providerResourceUrl('https://api.openai.com/v1/chat/completions', 'embeddings'),
    ).toBe('https://api.openai.com/v1/embeddings');
  });
});
