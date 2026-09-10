import { describe, expect, it } from 'vitest';
import { listModelsCandidateUrls, providerResourceUrl } from './provider-url.js';

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

  it('lists models under a stored embeddings endpoint, not the chat catalog', () => {
    expect(providerResourceUrl('https://openrouter.ai/api/v1/embeddings', 'models')).toBe(
      'https://openrouter.ai/api/v1/embeddings/models',
    );
  });
});

describe('listModelsCandidateUrls', () => {
  it('is just /models on an OpenAI-compatible root', () => {
    expect(listModelsCandidateUrls('https://openrouter.ai/api/v1')).toEqual([
      'https://openrouter.ai/api/v1/models',
    ]);
  });

  it('tries nested embeddings/models then the sibling /models', () => {
    expect(listModelsCandidateUrls('https://openrouter.ai/api/v1/embeddings')).toEqual([
      'https://openrouter.ai/api/v1/embeddings/models',
      'https://openrouter.ai/api/v1/models',
    ]);
  });

  it('tries nested rerank/models then the sibling /models', () => {
    expect(listModelsCandidateUrls('https://openrouter.ai/api/v1/rerank')).toEqual([
      'https://openrouter.ai/api/v1/rerank/models',
      'https://openrouter.ai/api/v1/models',
    ]);
  });
});
