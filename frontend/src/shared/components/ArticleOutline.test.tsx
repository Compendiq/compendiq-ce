import { createRef } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { ArticleOutline } from './ArticleOutline';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domMax}>{children}</LazyMotion>;
}

describe('ArticleOutline', () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
  });

  it('scrolls the app scroll container instead of calling scrollIntoView directly', () => {
    const contentRef = createRef<HTMLDivElement>();

    function Harness() {
      return (
        <div>
          <div ref={contentRef}>
            <h1 id="intro">Introduction</h1>
            <h2 id="usage">Usage</h2>
          </div>
          <ArticleOutline
            headings={[
              { id: 'intro', text: 'Introduction', level: 1 },
              { id: 'usage', text: 'Usage', level: 2 },
            ]}
            contentRef={contentRef}
            pageId="page-1"
            isOpen
            onToggle={vi.fn()}
          />
        </div>
      );
    }

    const scrollRoot = document.createElement('div');
    scrollRoot.setAttribute('data-scroll-container', '');
    scrollRoot.scrollTop = 200;
    scrollRoot.getBoundingClientRect = vi.fn(() => ({
      bottom: 650,
      height: 600,
      left: 0,
      right: 800,
      top: 50,
      width: 800,
      x: 0,
      y: 50,
      toJSON: () => ({}),
    }));
    document.body.appendChild(scrollRoot);

    render(<Harness />, { wrapper: Wrapper });

    const usageHeading = document.getElementById('usage');
    if (!usageHeading) {
      throw new Error('Expected heading element to exist.');
    }

    usageHeading.getBoundingClientRect = vi.fn(() => ({
      bottom: 360,
      height: 40,
      left: 0,
      right: 800,
      top: 260,
      width: 800,
      x: 0,
      y: 260,
      toJSON: () => ({}),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Usage' }));

    expect(scrollRoot.scrollTo).toHaveBeenCalledWith({
      top: 386,
      behavior: 'smooth',
    });
  });
});
