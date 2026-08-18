import { describe, it, expect } from 'vitest';
import { isExistingArticlePath } from './article-route';

describe('isExistingArticlePath', () => {
  it('accepts an existing article', () => {
    expect(isExistingArticlePath('/pages/123')).toBe(true);
    expect(isExistingArticlePath('/pages/abc-def')).toBe(true);
  });

  it('refuses the create form', () => {
    expect(isExistingArticlePath('/pages/new')).toBe(false);
  });

  it('refuses neighbouring routes', () => {
    expect(isExistingArticlePath('/')).toBe(false);
    expect(isExistingArticlePath('/pages')).toBe(false);
    expect(isExistingArticlePath('/pages/new/extra')).toBe(false);
    expect(isExistingArticlePath('/ai')).toBe(false);
    expect(isExistingArticlePath('/pages/123/edit')).toBe(false);
  });
});
