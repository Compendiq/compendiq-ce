import { describe, it, expect } from 'vitest';
import { improveMarkdownToHtml, unwrapSingleParagraph, buildImproveHtml } from './improve-markdown';

describe('improveMarkdownToHtml', () => {
  it('converts inline markdown to HTML', () => {
    const html = improveMarkdownToHtml('This is **bold** and *italic*.');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('converts block markdown (lists) to HTML', () => {
    const html = improveMarkdownToHtml('- one\n- two');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
  });

  it('strips dangerous tags via DOMPurify', () => {
    const html = improveMarkdownToHtml('ok <script>alert(1)</script> done');
    expect(html).not.toContain('<script>');
    expect(html).toContain('ok');
  });

  it('strips inline event-handler attributes', () => {
    const html = improveMarkdownToHtml('<img src="x" onerror="alert(1)">');
    expect(html.toLowerCase()).not.toContain('onerror');
  });
});

describe('unwrapSingleParagraph', () => {
  it('unwraps a single paragraph so inline replacement stays in-block', () => {
    expect(unwrapSingleParagraph('<p>hello world</p>')).toBe('hello world');
  });

  it('keeps inline marks when unwrapping', () => {
    expect(unwrapSingleParagraph('<p>a <strong>b</strong> c</p>')).toBe('a <strong>b</strong> c');
  });

  it('does not unwrap when there are multiple blocks', () => {
    const multi = '<p>one</p>\n<p>two</p>';
    expect(unwrapSingleParagraph(multi)).toBe(multi);
  });

  it('does not unwrap non-paragraph blocks', () => {
    expect(unwrapSingleParagraph('<ul><li>x</li></ul>')).toBe('<ul><li>x</li></ul>');
  });
});

describe('buildImproveHtml', () => {
  it('returns block html and an inline (unwrapped) variant for a single paragraph', () => {
    const { html, inline } = buildImproveHtml('Fixed sentence.');
    expect(html).toContain('<p>Fixed sentence.</p>');
    expect(inline).toBe('Fixed sentence.');
  });

  it('inline falls back to block html for multi-block output', () => {
    const { html, inline } = buildImproveHtml('- a\n- b');
    expect(html).toContain('<ul>');
    expect(inline).toBe(html.trim());
  });
});
