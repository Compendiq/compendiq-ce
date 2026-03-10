import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState } from './EmptyState';
import { FolderOpen } from 'lucide-react';

describe('EmptyState', () => {
  it('renders title and icon', () => {
    render(<EmptyState icon={FolderOpen} title="No items found" />);
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('No items found');
  });

  it('renders description when provided', () => {
    render(
      <EmptyState
        icon={FolderOpen}
        title="No items"
        description="Try adding some items"
      />,
    );
    expect(screen.getByText('Try adding some items')).toBeInTheDocument();
  });

  it('does not render description when not provided', () => {
    render(<EmptyState icon={FolderOpen} title="No items" />);
    expect(screen.queryByText('Try adding some items')).not.toBeInTheDocument();
  });

  it('renders action button when provided', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={FolderOpen}
        title="No items"
        action={{ label: 'Add Item', onClick }}
      />,
    );
    const btn = screen.getByText('Add Item');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not render action button when not provided', () => {
    render(<EmptyState icon={FolderOpen} title="No items" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <EmptyState icon={FolderOpen} title="No items" className="my-custom" />,
    );
    expect(container.firstChild).toHaveClass('my-custom');
  });
});
