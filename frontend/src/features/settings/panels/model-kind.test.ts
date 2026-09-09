import { describe, expect, it } from 'vitest';
import { filterModelsForKind, isEmbeddingModel, isRerankModel } from './model-kind';

const MIXED = [
  'qwen3:4b',
  'bge-m3',
  'gpt-4o-mini',
  'bge-reranker-v2-m3',
  'nomic-embed-text',
] as const;

describe('isRerankModel', () => {
  it('matches rerank, cross-encoder, and colbert anywhere in the id', () => {
    expect(isRerankModel('BAAI/bge-reranker-v2-m3')).toBe(true);
    expect(isRerankModel('cross-encoder/ms-marco-MiniLM-L-6-v2')).toBe(true);
    expect(isRerankModel('colbertv2.0')).toBe(true);
  });

  it('is case-insensitive and rejects chat and embedding ids', () => {
    expect(isRerankModel('BGE-RERANKER-v2-m3')).toBe(true);
    expect(isRerankModel('bge-m3')).toBe(false);
    expect(isRerankModel('qwen3:4b')).toBe(false);
  });
});

describe('isEmbeddingModel', () => {
  it('matches embedding ids and treats rerankers as not embeddings', () => {
    expect(isEmbeddingModel('bge-m3')).toBe(true);
    expect(isEmbeddingModel('nomic-embed-text')).toBe(true);
    expect(isEmbeddingModel('text-embedding-3-small')).toBe(true);
    expect(isEmbeddingModel('bge-reranker-v2-m3')).toBe(false);
    expect(isEmbeddingModel('qwen3:4b')).toBe(false);
  });
});

describe('filterModelsForKind', () => {
  it('returns every name when kind is undefined', () => {
    expect(filterModelsForKind(MIXED, undefined, 'bge-m3')).toEqual([...MIXED]);
  });

  it('appends a selected id not in the list when kind is undefined', () => {
    expect(filterModelsForKind(MIXED, undefined, 'custom-chat-model')).toEqual([
      ...MIXED,
      'custom-chat-model',
    ]);
  });

  it('keeps original order for embedding matches', () => {
    expect(filterModelsForKind(MIXED, 'embedding', null)).toEqual(['bge-m3', 'nomic-embed-text']);
  });

  it('keeps original order for rerank matches', () => {
    expect(filterModelsForKind(MIXED, 'rerank', null)).toEqual(['bge-reranker-v2-m3']);
  });

  it('keeps a selected non-matching id visible in its original position', () => {
    expect(filterModelsForKind(MIXED, 'embedding', 'qwen3:4b')).toEqual([
      'qwen3:4b',
      'bge-m3',
      'nomic-embed-text',
    ]);
  });

  it('appends a selected id that is not in the list', () => {
    expect(filterModelsForKind(MIXED, 'rerank', 'custom-rerank')).toEqual([
      'bge-reranker-v2-m3',
      'custom-rerank',
    ]);
  });

  it('does not duplicate a selected id that already matches', () => {
    expect(filterModelsForKind(MIXED, 'embedding', 'bge-m3')).toEqual(['bge-m3', 'nomic-embed-text']);
  });

  it('ignores empty selected', () => {
    expect(filterModelsForKind(MIXED, 'embedding', '')).toEqual(['bge-m3', 'nomic-embed-text']);
  });
});
