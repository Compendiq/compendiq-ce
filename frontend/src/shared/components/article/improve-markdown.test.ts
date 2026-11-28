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

// #1955: the Markdown an Improve returns names a Confluence link by its carrier. The preview keeps
// it a fragment of this page whatever the label holds, and never a script address.
describe('Confluence link carriers in an improved text (#1955)', () => {
  const anchors = (html: string): Array<[string | null, string | null]> =>
    [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent]);

  it('keeps each carrier one anchor with its own destination', () => {
    const html = improveMarkdownToHtml(
      '[the space](#confluence-space:ENG?body=plain) '
      + '[read **this** & "that"](#confluence-blog-post:Q3%20%22Update%22?ri:posting-day=2024%2F05%2F01&body=rich) '
      + '[a <b>bold</b> label](#confluence-shortcut:jira?ri:parameter=ABC-1) '
      + '[web](#confluence-url:https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2?body=plain) '
      + '[script](#confluence-url:javascript%3Aalert%281%29?body=plain) '
      + '[(empty link)](#confluence-url:)',
    );

    expect(anchors(html)).toEqual([
      ['#confluence-space:ENG?body=plain', 'the space'],
      ['#confluence-blog-post:Q3%20%22Update%22?ri:posting-day=2024%2F05%2F01&body=rich', 'read this & "that"'],
      ['#confluence-shortcut:jira?ri:parameter=ABC-1', 'a bold label'],
      ['#confluence-url:https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2?body=plain', 'web'],
      ['#confluence-url:javascript%3Aalert%281%29?body=plain', 'script'],
      ['#confluence-url:', '(empty link)'],
    ]);
  });

  it('drops a script destination the model writes out, keeping its text', () => {
    const html = improveMarkdownToHtml('[script](javascript:alert(1)) and [data](data:text/html,x) and [vb](vbscript:x)');

    expect(anchors(html).map(([href]) => href).filter((href) => href !== null)).toEqual([]);
    expect(html).toContain('script');
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
