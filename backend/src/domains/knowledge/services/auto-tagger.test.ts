import { describe, expect, it } from 'vitest';
import { parseTagResponse } from './auto-tagger.js';

describe('parseTagResponse', () => {
  it('normalizes, filters, and deduplicates provider tags', () => {
    expect(parseTagResponse(
      '[" Architecture ", "api", "API", "not-an-allowed-tag", 42, null, "security"]',
    )).toEqual(['architecture', 'api', 'security']);
  });

  it('extracts an array from provider prose or a Markdown fence', () => {
    expect(parseTagResponse(
      'Based on the article, use ["deployment", "monitoring"].',
    )).toEqual(['deployment', 'monitoring']);
    expect(parseTagResponse(
      '```json\n["database", "troubleshooting"]\n```',
    )).toEqual(['database', 'troubleshooting']);
  });

  it.each([
    { property: 'tags', response: '{"tags":["policy"]}', expected: ['policy'] },
    { property: 'labels', response: '{"labels":["runbook"]}', expected: ['runbook'] },
    { property: 'categories', response: '{"categories":["configuration"]}', expected: ['configuration'] },
    { property: 'result', response: '{"result":["onboarding"]}', expected: ['onboarding'] },
  ])('accepts a JSON object with a $property array', ({ response, expected }) => {
    expect(parseTagResponse(response)).toEqual(expected);
  });

  it('limits a provider response to five valid unique tags', () => {
    expect(parseTagResponse(
      '["architecture","deployment","api","security","database","monitoring","policy"]',
    )).toEqual(['architecture', 'deployment', 'api', 'security', 'database']);
  });

  it.each([
    '',
    'architecture and deployment',
    '{"tags":"architecture"}',
    '["architecture",',
    '42',
  ])('returns no tags for an unusable response: %j', (response) => {
    expect(parseTagResponse(response)).toEqual([]);
  });
});
