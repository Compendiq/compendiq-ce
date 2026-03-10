import { describe, it, expect } from 'vitest';
import { shouldRetry, createQueryClient } from './query-client';
import { ApiError } from './api';

describe('shouldRetry', () => {
  it('returns false for 401 ApiError (unauthorized)', () => {
    const error = new ApiError(401, 'Session expired');
    expect(shouldRetry(0, error)).toBe(false);
  });

  it('returns false for 403 ApiError (forbidden)', () => {
    const error = new ApiError(403, 'Forbidden');
    expect(shouldRetry(0, error)).toBe(false);
  });

  it('returns false for 404 ApiError (not found)', () => {
    const error = new ApiError(404, 'Not found');
    expect(shouldRetry(0, error)).toBe(false);
  });

  it('returns true for 500 ApiError when under max retries', () => {
    const error = new ApiError(500, 'Internal server error');
    expect(shouldRetry(0, error)).toBe(true);
    expect(shouldRetry(1, error)).toBe(true);
  });

  it('returns false for 500 ApiError when at max retries', () => {
    const error = new ApiError(500, 'Internal server error');
    expect(shouldRetry(2, error)).toBe(false);
  });

  it('returns true for 502 ApiError when under max retries', () => {
    const error = new ApiError(502, 'Bad gateway');
    expect(shouldRetry(0, error)).toBe(true);
  });

  it('returns true for 503 ApiError when under max retries', () => {
    const error = new ApiError(503, 'Service unavailable');
    expect(shouldRetry(1, error)).toBe(true);
  });

  it('returns true for network errors (non-ApiError) when under max retries', () => {
    const error = new TypeError('Failed to fetch');
    expect(shouldRetry(0, error)).toBe(true);
    expect(shouldRetry(1, error)).toBe(true);
  });

  it('returns false for network errors when at max retries', () => {
    const error = new TypeError('Failed to fetch');
    expect(shouldRetry(2, error)).toBe(false);
  });

  it('returns true for generic Error when under max retries', () => {
    const error = new Error('Something went wrong');
    expect(shouldRetry(0, error)).toBe(true);
  });

  it('respects custom maxRetries parameter', () => {
    const error = new ApiError(500, 'Internal server error');
    expect(shouldRetry(0, error, 1)).toBe(true);
    expect(shouldRetry(1, error, 1)).toBe(false);
  });

  it('never retries 401 regardless of failureCount or maxRetries', () => {
    const error = new ApiError(401, 'Unauthorized');
    expect(shouldRetry(0, error, 10)).toBe(false);
  });

  it('never retries 403 regardless of failureCount or maxRetries', () => {
    const error = new ApiError(403, 'Forbidden');
    expect(shouldRetry(0, error, 10)).toBe(false);
  });

  it('never retries 404 regardless of failureCount or maxRetries', () => {
    const error = new ApiError(404, 'Not found');
    expect(shouldRetry(0, error, 10)).toBe(false);
  });
});

describe('createQueryClient', () => {
  it('creates a QueryClient with staleTime of 30 seconds', () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(30_000);
  });

  it('creates a QueryClient with a retry function', () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions();
    expect(typeof defaults.queries?.retry).toBe('function');
  });

  it('retry function skips 401 errors', () => {
    const client = createQueryClient();
    const retryFn = client.getDefaultOptions().queries?.retry as (
      failureCount: number,
      error: Error,
    ) => boolean;
    const error = new ApiError(401, 'Unauthorized');
    expect(retryFn(0, error)).toBe(false);
  });

  it('retry function allows 500 errors to retry', () => {
    const client = createQueryClient();
    const retryFn = client.getDefaultOptions().queries?.retry as (
      failureCount: number,
      error: Error,
    ) => boolean;
    const error = new ApiError(500, 'Server error');
    expect(retryFn(0, error)).toBe(true);
  });
});
