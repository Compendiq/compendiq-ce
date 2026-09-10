import { describe, expect, it } from 'vitest';
import {
  filterListedModels,
  listModelsCandidateUrls,
  listedModelMatchesKind,
  providerResourceUrl,
} from './provider-url.js';

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

  it('tries nested embeddings/models then the embeddings modality catalog', () => {
    expect(listModelsCandidateUrls('https://openrouter.ai/api/v1/embeddings')).toEqual([
      'https://openrouter.ai/api/v1/embeddings/models',
      'https://openrouter.ai/api/v1/models?output_modalities=embeddings',
      'https://openrouter.ai/api/v1/models',
    ]);
  });

  it('tries nested rerank/models then the rerank modality catalog before chat /models', () => {
    expect(listModelsCandidateUrls('https://openrouter.ai/api/v1/rerank')).toEqual([
      'https://openrouter.ai/api/v1/rerank/models',
      'https://openrouter.ai/api/v1/models?output_modalities=rerank',
      'https://openrouter.ai/api/v1/models',
    ]);
  });
});

describe('filterListedModels', () => {
  const mixed = [
    { id: 'openai/gpt-4o-mini' },
    { id: 'cohere/rerank-v3.5' },
    { id: 'openai/text-embedding-3-small' },
    { id: 'qwen/qwen3-reranker-8b' },
  ];

  it('does not filter a root /v1 catalog', () => {
    expect(filterListedModels('https://openrouter.ai/api/v1', mixed).map((m) => m.name)).toEqual(
      mixed.map((m) => m.id),
    );
  });

  it('keeps only rerank ids for a stored /rerank URL', () => {
    expect(
      filterListedModels('https://openrouter.ai/api/v1/rerank', mixed).map((m) => m.name),
    ).toEqual(['cohere/rerank-v3.5', 'qwen/qwen3-reranker-8b']);
  });

  it('keeps only embedding ids for a stored /embeddings URL', () => {
    expect(
      filterListedModels('https://openrouter.ai/api/v1/embeddings', mixed).map((m) => m.name),
    ).toEqual(['openai/text-embedding-3-small']);
  });

  it('prefers output_modalities over the name regex', () => {
    expect(
      filterListedModels('https://openrouter.ai/api/v1/rerank', [
        { id: 'vendor/ranker-pro', architecture: { output_modalities: ['rerank'] } },
        { id: 'openai/gpt-4o-mini', architecture: { output_modalities: ['text'] } },
      ]).map((m) => m.name),
    ).toEqual(['vendor/ranker-pro']);
  });
});

describe('listedModelMatchesKind', () => {
  it('matches OpenRouter rerank ids', () => {
    expect(listedModelMatchesKind('rerank', 'cohere/rerank-v3.5')).toBe(true);
    expect(listedModelMatchesKind('rerank', 'openai/gpt-4o-mini')).toBe(false);
  });
});
