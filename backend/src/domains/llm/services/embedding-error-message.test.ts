import { describe, it, expect } from 'vitest';
import { toUserFacingEmbeddingError } from './embedding-error-message.js';
import { LlmHttpError } from './llm-http-error.js';

describe('toUserFacingEmbeddingError', () => {
  // #1185 folded the provider body into a plain Error's `.message`
  // (`generateEmbedding HTTP 400: <body>`), so these plain-Error cases used to
  // be what production actually threw. generateEmbedding now throws
  // LlmHttpError with a body-free `.message` — a plain Error reaching this
  // function is still real (e.g. undici throws a plain Error for a connection
  // failure before generateEmbedding ever gets to inspect a response status),
  // so this fallback branch stays covered below, but the *body-derived*
  // categories can no longer be reached this way. Those move to the
  // LlmHttpError section.
  it('maps a connection-refused error to the connectivity message (plain-Error fallback branch)', () => {
    const result = toUserFacingEmbeddingError(new Error('connect ECONNREFUSED 127.0.0.1:1234'));
    expect(result).toBe(
      'Could not reach the embedding service. Check the provider connection and try again.',
    );
    expect(result).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it('maps an opaque plain-Error message to the generic fallback and does not leak the raw text', () => {
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

  // #1185 PR review (PR #1214): generateEmbedding throws LlmHttpError, whose
  // `.message` is a bare `generateEmbedding HTTP <status>` — the provider
  // body lives on `.detail` (llm-http-error.ts). This function must read both
  // fields, not just `.message`, or every body-derived category below
  // silently collapses to the generic fallback for the production error type.
  describe('LlmHttpError — status and detail both feed the categorizer (production path)', () => {
    it('maps an LM Studio "no models loaded" body to the model-unavailable message and hides the raw text', () => {
      const result = toUserFacingEmbeddingError(
        new LlmHttpError('generateEmbedding', 400, 'No models loaded. Load one with the lms load command'),
      );
      expect(result).toBe(
        'The embedding model is not available. Check the model configuration and try again.',
      );
      expect(result).not.toMatch(/lms load|No models loaded/i);
    });

    // The concrete regression from the PR #1214 review: a 400 whose body says
    // the input is too long, worded in a way isContextLengthError does not
    // recognize (so the error reaches embedPage's rethrow → here), must still
    // land on the content-too-long message instead of the generic fallback.
    it('maps a 400 body saying the input is too long to the content-too-long message', () => {
      const result = toUserFacingEmbeddingError(
        new LlmHttpError('generateEmbedding', 400, 'input is too long for this model'),
      );
      expect(result).toBe('Content was too long to index. It will be retried automatically.');
    });

    it('maps a rate-limit body to the rate-limit message even off the 429 status needle', () => {
      const result = toUserFacingEmbeddingError(
        new LlmHttpError('generateEmbedding', 400, 'rate limit exceeded, slow down'),
      );
      expect(result).toBe('The embedding service is busy (rate limited). Try again shortly.');
    });

    it('maps status 429 (via .message) to the rate-limit message', () => {
      const result = toUserFacingEmbeddingError(
        new LlmHttpError('generateEmbedding', 429, ''),
      );
      expect(result).toBe('The embedding service is busy (rate limited). Try again shortly.');
    });

    it('maps status 401 (via .message) to the auth message', () => {
      const result = toUserFacingEmbeddingError(
        new LlmHttpError('generateEmbedding', 401, 'Unauthorized'),
      );
      expect(result).toBe(
        'The embedding service rejected the request. Check the provider credentials.',
      );
    });

    it('never leaks the provider detail into the returned message', () => {
      const secretish = 'internal registry trace: host=10.0.4.12 secretpath=/var/models';
      const result = toUserFacingEmbeddingError(
        new LlmHttpError('generateEmbedding', 500, secretish),
      );
      expect(result).toBe('Embedding failed due to a provider error. See server logs for details.');
      expect(result).not.toContain(secretish);
    });
  });
});
