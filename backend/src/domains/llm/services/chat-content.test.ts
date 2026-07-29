import { describe, it, expect } from 'vitest';
import { contentToText, type ChatContentPart } from './prompts.js';

describe('contentToText', () => {
  it('passes a plain string through unchanged', () => {
    expect(contentToText('hello world')).toBe('hello world');
  });

  it('concatenates text parts and omits image parts', () => {
    const parts: ChatContentPart[] = [
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'in detail' },
    ];
    expect(contentToText(parts)).toBe('describe this\nin detail');
  });

  /**
   * The reason this helper exists. `.length` is valid on both a string and an
   * array, so `m.content.length` keeps compiling under the union while
   * silently changing from a character count to a part count. Audit payloads
   * must report characters.
   */
  it('reports a character count, not a part count', () => {
    const parts: ChatContentPart[] = [
      { type: 'text', text: 'abcdefghij' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ];
    expect(parts.length).toBe(2);
    expect(contentToText(parts).length).toBe(10);
  });

  it('returns an empty string for an image-only array', () => {
    expect(contentToText([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])).toBe('');
  });
});
