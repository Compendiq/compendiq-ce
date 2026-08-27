import { describe, it, expect } from 'vitest';
import {
  AI_HOME_PATH,
  isAiRoute,
  conversationIdFromPath,
  conversationPath,
} from './ai-routes';

describe('AI route predicates (#1361)', () => {
  it('names the bare assistant route', () => {
    expect(AI_HOME_PATH).toBe('/ai');
  });

  describe('isAiRoute', () => {
    it('is true for the bare route and for one conversation', () => {
      expect(isAiRoute('/ai')).toBe(true);
      expect(isAiRoute('/ai/c/conv-1')).toBe(true);
      expect(isAiRoute('/ai/c/018f2d3c-9a1b-7c4e-8f00-2b6a1f0e5d33')).toBe(true);
    });

    it('is false for a trailing slash', () => {
      // react-router normalises `/ai/` to `/ai` before anything reads
      // location.pathname, so accepting it would only invent a second spelling
      // of the same route for hand-built strings.
      expect(isAiRoute('/ai/')).toBe(false);
    });

    it('is false for an empty conversation id', () => {
      // There is no conversation to open; App.tsx's `*` route and its real 404
      // are the honest answer.
      expect(isAiRoute('/ai/c/')).toBe(false);
      expect(isAiRoute('/ai/c')).toBe(false);
    });

    it('is false for anything deeper, adjacent, or differently cased', () => {
      expect(isAiRoute('/ai/c/conv-1/edit')).toBe(false);
      expect(isAiRoute('/ai-reviews')).toBe(false);
      expect(isAiRoute('/AI')).toBe(false);
      expect(isAiRoute('/pages/abc')).toBe(false);
      expect(isAiRoute('/')).toBe(false);
      expect(isAiRoute('')).toBe(false);
    });
  });

  describe('conversationIdFromPath', () => {
    it('reads the id off /ai/c/:id', () => {
      expect(conversationIdFromPath('/ai/c/conv-1')).toBe('conv-1');
    });

    it('is null on the bare route and off the family', () => {
      expect(conversationIdFromPath('/ai')).toBeNull();
      expect(conversationIdFromPath('/ai/c/')).toBeNull();
      expect(conversationIdFromPath('/pages/abc')).toBeNull();
    });

    it('decodes the segment, so it round-trips with conversationPath', () => {
      const id = 'a/b c#1';
      expect(conversationIdFromPath(conversationPath(id))).toBe(id);
    });

    it('returns the raw segment when the escape is malformed', () => {
      // decodeURIComponent throws on '%zz'. The provider reads this on every
      // render, so a hand-typed URL must yield a lookup that 404s rather than
      // an exception out of AiProvider.
      expect(conversationIdFromPath('/ai/c/%zz')).toBe('%zz');
    });
  });

  describe('conversationPath', () => {
    it('builds the per-conversation URL', () => {
      expect(conversationPath('conv-1')).toBe('/ai/c/conv-1');
    });

    it('percent-encodes the id', () => {
      expect(conversationPath('a/b')).toBe('/ai/c/a%2Fb');
      expect(conversationPath('a b')).toBe('/ai/c/a%20b');
    });
  });
});
