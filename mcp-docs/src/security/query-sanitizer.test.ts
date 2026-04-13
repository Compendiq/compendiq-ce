import { describe, it, expect } from 'vitest';
import { sanitizeSearchQuery, QuerySanitizationError } from './query-sanitizer.js';

describe('query-sanitizer', () => {
  it('passes through simple keyword queries', () => {
    expect(sanitizeSearchQuery('kubernetes HPA autoscaling')).toBe('kubernetes HPA autoscaling');
  });

  it('strips code blocks', () => {
    const query = 'how to use ```const x = 1``` in JavaScript';
    expect(sanitizeSearchQuery(query)).toBe('how to use in JavaScript');
  });

  it('strips URLs', () => {
    const query = 'docs at https://example.com/api about auth';
    expect(sanitizeSearchQuery(query)).toBe('docs at about auth');
  });

  it('strips JSON blobs', () => {
    const query = 'config looks like {"key": "value"} how to fix';
    expect(sanitizeSearchQuery(query)).toBe('config looks like how to fix');
  });

  it('strips base64 patterns', () => {
    const base64 = 'A'.repeat(50);
    const query = `decode ${base64} please`;
    expect(sanitizeSearchQuery(query)).toBe('decode please');
  });

  it('truncates to 200 characters', () => {
    // Use long words to avoid exceeding word limit after truncation
    const longQuery = 'abcdefghijklmnop '.repeat(20);
    const result = sanitizeSearchQuery(longQuery);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('rejects empty queries after sanitization', () => {
    expect(() => sanitizeSearchQuery('```const x = 1```')).toThrow(QuerySanitizationError);
  });

  it('rejects queries with too many words', () => {
    // 31 short words under 200 chars total
    const query = Array.from({ length: 31 }, (_, i) => `w${i}`).join(' ');
    expect(() => sanitizeSearchQuery(query)).toThrow(QuerySanitizationError);
  });

  it('accepts queries with exactly 30 words', () => {
    const query = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    expect(() => sanitizeSearchQuery(query)).not.toThrow();
  });
});
