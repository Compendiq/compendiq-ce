import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageIcon } from './PageIcon';

vi.mock('../../hooks/use-authenticated-src', () => ({
  useAuthenticatedSrc: () => ({ blobSrc: null, loading: false, error: true }),
}));

describe('PageIcon', () => {
  it('renders nothing when the mark is unset', () => {
    const { container } = render(<PageIcon icon={null} pageId="1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an emoji as text, hidden from the accessibility tree', () => {
    render(<PageIcon icon={{ kind: 'emoji', value: '🚀' }} pageId="1" />);
    const mark = screen.getByText('🚀');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders a lucide glyph for a catalogue id', () => {
    const { container } = render(<PageIcon icon={{ kind: 'lucide', value: 'rocket' }} pageId="1" />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders nothing for an unknown lucide id', () => {
    const { container } = render(<PageIcon icon={{ kind: 'lucide', value: 'not-real' }} pageId="1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to unmarked when an image cannot be loaded', () => {
    const { container } = render(
      <PageIcon icon={{ kind: 'image', value: 'abc' }} pageId="1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
