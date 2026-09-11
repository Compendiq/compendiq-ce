import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PageTitleIcon } from './PageTitleIcon';

vi.mock('../../hooks/use-can-hover', () => ({
  useCanHover: () => false,
}));

vi.mock('../../hooks/use-authenticated-src', () => ({
  useAuthenticatedSrc: () => ({ blobSrc: null, loading: false, error: true }),
}));

describe('PageTitleIcon', () => {
  it('renders nothing when unread-only and unset', () => {
    const { container } = render(
      <PageTitleIcon
        icon={null}
        pageId="1"
        editable={false}
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows Add icon when editable and unset', () => {
    render(
      <PageTitleIcon
        icon={null}
        pageId="1"
        editable
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add icon' })).toBeInTheDocument();
  });

  it('opens the picker from Add icon', () => {
    render(
      <PageTitleIcon
        icon={null}
        pageId="1"
        editable
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add icon' }));
    const iconsTab = screen.getByRole('tab', { name: /Icons/i });
    expect(iconsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('page-icon-lucide-grid')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Emoji/i })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /Upload/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Logos/i })).toBeInTheDocument();
    expect(screen.getByTestId('page-icon-lucide-grid').querySelectorAll('button').length).toBeGreaterThan(600);
    fireEvent.click(screen.getByRole('tab', { name: /Logos/i }));
    expect(screen.getByTestId('page-icon-brand-grid')).toBeInTheDocument();
    expect(screen.getByLabelText('Docker')).toBeInTheDocument();
    expect(screen.getByLabelText('Microsoft')).toBeInTheDocument();
    expect(screen.getByLabelText('IBM')).toBeInTheDocument();
    expect(screen.getByLabelText('Apple')).toBeInTheDocument();
    expect(screen.getByLabelText('Google')).toBeInTheDocument();
    expect(screen.getByLabelText('Strava')).toBeInTheDocument();
    expect(screen.getByLabelText('Garmin')).toBeInTheDocument();
    expect(screen.getByLabelText('Nike')).toBeInTheDocument();
  });

  it('shows the existing mark as Change page icon', () => {
    render(
      <PageTitleIcon
        icon={{ kind: 'emoji', value: '🚀' }}
        pageId="1"
        editable
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Change page icon' })).toBeInTheDocument();
    expect(screen.getByText('🚀')).toBeInTheDocument();
  });

  it('shows a text-palette colour row for a lucide mark and keeps the picker open', () => {
    const onSelect = vi.fn();
    render(
      <PageTitleIcon
        icon={{ kind: 'lucide', value: 'rocket' }}
        pageId="1"
        editable
        onSelect={onSelect}
        onUpload={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change page icon' }));
    expect(screen.getByTestId('page-icon-color-row')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Blue icon' }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'lucide', value: 'rocket', color: '#3b82f6' });
    expect(screen.getByTestId('page-icon-color-row')).toBeInTheDocument();
  });

  it('lists diving and hiking glyphs in the icon grid', () => {
    render(
      <PageTitleIcon
        icon={null}
        pageId="1"
        editable
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add icon' }));
    expect(screen.getByLabelText('Diving')).toBeInTheDocument();
    expect(screen.getByLabelText('Hiking')).toBeInTheDocument();
    expect(screen.getByLabelText('Sailing')).toBeInTheDocument();
  });
});
