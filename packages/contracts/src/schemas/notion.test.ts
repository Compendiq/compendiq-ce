import { describe, expect, it } from 'vitest';
import { ConnectNotionSchema, NotionConnectionResponseSchema } from './notion.js';

describe('ConnectNotionSchema', () => {
  it('accepts a non-empty token', () => {
    expect(ConnectNotionSchema.parse({ token: 'secret_test_token' })).toEqual({
      token: 'secret_test_token',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(ConnectNotionSchema.parse({ token: '  ntn_abc  ' })).toEqual({ token: 'ntn_abc' });
  });

  it('rejects an empty or whitespace-only token', () => {
    expect(() => ConnectNotionSchema.parse({ token: '' })).toThrow();
    expect(() => ConnectNotionSchema.parse({ token: '   ' })).toThrow();
  });
});

describe('NotionConnectionResponseSchema', () => {
  it('exposes only hasToken — never a token field', () => {
    expect(NotionConnectionResponseSchema.parse({ hasToken: true })).toEqual({ hasToken: true });
    expect(Object.keys(NotionConnectionResponseSchema.shape)).toEqual(['hasToken']);
  });

  it('strips unknown keys including a leaked token (strict)', () => {
    expect(() =>
      NotionConnectionResponseSchema.parse({ hasToken: true, token: 'secret_should_not_pass' }),
    ).toThrow();
  });
});
