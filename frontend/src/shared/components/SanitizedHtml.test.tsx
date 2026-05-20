import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SanitizedHtml } from './SanitizedHtml';

describe('SanitizedHtml', () => {
  it('strips <script> tags', () => {
    const { container } = render(
      <SanitizedHtml html='<p>hi</p><script>window.x = 1</script>' />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('hi');
  });

  it('strips inline event handler attributes', () => {
    const { container } = render(
      <SanitizedHtml html='<img src="x" onerror="alert(1)" />' />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('onerror')).toBeNull();
  });

  it('strips <iframe>, <object>, <embed>, <form>, and <style>', () => {
    const { container } = render(
      <SanitizedHtml html='<iframe></iframe><object></object><embed><form></form><style></style>' />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('object')).toBeNull();
    expect(container.querySelector('embed')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('style')).toBeNull();
  });

  it('preserves anchor tags with href', () => {
    const { container } = render(
      <SanitizedHtml html='<a href="https://example.com">link</a>' />,
    );
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.textContent).toBe('link');
  });

  it('renders plain text inside a div', () => {
    const { container } = render(<SanitizedHtml html='hello world' />);
    expect(container.firstChild?.textContent).toBe('hello world');
    expect((container.firstChild as HTMLElement).tagName).toBe('DIV');
  });

  it('applies className and data-testid to the wrapper', () => {
    const { container } = render(
      <SanitizedHtml html='x' className='wrap-class' data-testid='wrap-test' />,
    );
    const wrap = container.firstChild as HTMLElement;
    expect(wrap.className).toBe('wrap-class');
    expect(wrap.getAttribute('data-testid')).toBe('wrap-test');
  });

  it('restricts output when allowedTags is provided', () => {
    const { container } = render(
      <SanitizedHtml
        html='<p>before <mark class="hi">match</mark> after</p>'
        allowedTags={['mark']}
        allowedAttrs={['class']}
      />,
    );
    expect(container.querySelector('p')).toBeNull();
    const mark = container.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute('class')).toBe('hi');
  });

  it('lets additionalAllowedAttrs pass through (e.g. data-* hooks)', () => {
    const { container } = render(
      <SanitizedHtml
        html='<div data-diagram-name="dx">x</div>'
        additionalAllowedAttrs={['data-diagram-name']}
      />,
    );
    expect(
      container.querySelector('[data-diagram-name="dx"]'),
    ).not.toBeNull();
  });
});
