import { describe, it, expect } from 'vitest';
import { isArticlePath, isExistingArticlePath } from './article-route';

describe('isArticlePath', () => {
  it('accepts an existing article', () => {
    expect(isArticlePath('/pages/123')).toBe(true);
    expect(isArticlePath('/pages/abc-def')).toBe(true);
  });

  it('accepts the new page create form', () => {
    expect(isArticlePath('/pages/new')).toBe(true);
  });

  it('refuses neighbouring routes', () => {
    expect(isArticlePath('/')).toBe(false);
    expect(isArticlePath('/pages')).toBe(false);
    expect(isArticlePath('/pages/new/extra')).toBe(false);
    expect(isArticlePath('/ai')).toBe(false);
    expect(isArticlePath('/pages/123/edit')).toBe(false);
  });
});

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

