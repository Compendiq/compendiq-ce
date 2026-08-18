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
    expect(screen.getByRole('tab', { name: /Emoji/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Icons/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Upload/i })).toBeInTheDocument();
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
});
