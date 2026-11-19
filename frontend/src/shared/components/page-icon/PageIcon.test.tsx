import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PageIcon } from './PageIcon';
import { LucideIconGrid } from './LucideIconGrid';

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

  it('renders a lucide glyph for a catalogue id', async () => {
    const { container } = render(<PageIcon icon={{ kind: 'lucide', value: 'rocket' }} pageId="1" />);
    await waitFor(() => expect(container.querySelector('svg')).toBeTruthy());
  });

  it('applies a text-palette colour to a lucide glyph', async () => {
    const { container } = render(
      <PageIcon icon={{ kind: 'lucide', value: 'rocket', color: '#6366f1' }} pageId="1" />,
    );
    await waitFor(() => expect(container.firstElementChild).toHaveStyle({ color: '#6366f1' }));
  });

  it('renders a filled lucide glyph with fill="currentColor" and page-icon-filled class', async () => {
    const { container } = render(
      <PageIcon icon={{ kind: 'lucide', value: 'camera', filled: true }} pageId="1" />,
    );
    await waitFor(() => {
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg).toHaveAttribute('fill', 'currentColor');
      expect(svg).toHaveClass('page-icon-filled');
    });
  });

  it('renders an outline lucide glyph with fill="none" by default', async () => {
    const { container } = render(
      <PageIcon icon={{ kind: 'lucide', value: 'camera' }} pageId="1" />,
    );
    await waitFor(() => {
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg).toHaveAttribute('fill', 'none');
      expect(svg).not.toHaveClass('page-icon-filled');
    });
  });

  it('renders a brand logo for a catalogue slug', () => {
    for (const slug of ['docker', 'microsoft', 'ibm', 'apple', 'google', 'amazon']) {
      const { container } = render(<PageIcon icon={{ kind: 'brand', value: slug }} pageId="1" />);
      expect(container.querySelector('svg')).toBeTruthy();
    }
  });

  it('renders nothing for an unknown brand slug', () => {
    const { container } = render(<PageIcon icon={{ kind: 'brand', value: 'not-a-logo' }} pageId="1" />);
    expect(container).toBeEmptyDOMElement();
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

  it('paginates LucideIconGrid initially and expands on demand or search', async () => {
    const onPick = vi.fn();
    render(<LucideIconGrid onPick={onPick} />);

    const showAllBtn = await screen.findByTestId('page-icon-show-all');
    const grid = screen.getByTestId('page-icon-lucide-grid');
    expect(grid.querySelectorAll('button')).toHaveLength(96);

    fireEvent.click(showAllBtn);
    expect(grid.querySelectorAll('button').length).toBeGreaterThan(96);
    expect(screen.queryByTestId('page-icon-show-all')).not.toBeInTheDocument();
  });
});
