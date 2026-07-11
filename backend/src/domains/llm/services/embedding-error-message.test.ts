import { describe, it, expect } from 'vitest';
import { toUserFacingEmbeddingError } from './embedding-error-message.js';

describe('toUserFacingEmbeddingError', () => {
  it('maps an LM Studio "no models loaded" leak to the model-unavailable message and hides the raw text', () => {
    const result = toUserFacingEmbeddingError(
      new Error(
        'generateEmbedding HTTP 400: {"error":"No models loaded. Load one with the lms load command"}',
      ),
    );
    expect(result).toBe(
      'The embedding model is not available. Check the model configuration and try again.',
    );
    expect(result).not.toMatch(/lms load|No models loaded/i);
  });

  it('maps a connection-refused error to the connectivity message', () => {
    const result = toUserFacingEmbeddingError(new Error('connect ECONNREFUSED 127.0.0.1:1234'));
    expect(result).toBe(
      'Could not reach the embedding service. Check the provider connection and try again.',
    );
    expect(result).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it('maps a rate-limit error to the rate-limit message', () => {
    const result = toUserFacingEmbeddingError(
      new Error('generateEmbedding HTTP 429: rate limit exceeded'),
    );
    expect(result).toBe('The embedding service is busy (rate limited). Try again shortly.');
  });

  it('maps an auth error to the auth message', () => {
    const result = toUserFacingEmbeddingError(new Error('generateEmbedding HTTP 401 Unauthorized'));
    expect(result).toBe(
      'The embedding service rejected the request. Check the provider credentials.',
    );
  });

  it('maps an opaque error to the generic fallback and does not leak the raw text', () => {
    const raw = 'kaboom-internal-stacktrace-42';
    const result = toUserFacingEmbeddingError(new Error(raw));
    expect(result).toBe('Embedding failed due to a provider error. See server logs for details.');
    expect(result).not.toContain(raw);
  });

  it('handles non-Error (string) input without throwing', () => {
    const result = toUserFacingEmbeddingError('some raw string failure');
    expect(result).toBe('Embedding failed due to a provider error. See server logs for details.');
    expect(result).not.toContain('some raw string failure');
  });
});
