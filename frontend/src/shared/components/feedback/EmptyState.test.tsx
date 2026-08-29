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

  it('renders secondary action button when provided', () => {
    const onAction = vi.fn();
    const onSecondary = vi.fn();
    render(
      <EmptyState
        icon={FolderOpen}
        title="No items"
        action={{ label: 'Primary', onClick: onAction }}
        secondaryAction={{ label: 'Secondary', onClick: onSecondary }}
      />,
    );
    const secondaryBtn = screen.getByText('Secondary');
    expect(secondaryBtn).toBeInTheDocument();
    fireEvent.click(secondaryBtn);
    expect(onSecondary).toHaveBeenCalledOnce();
  });

  // --- actionTone (#1402 phase 3) ------------------------------------------
  //
  // The default is the filled accent, because an empty state is usually the
  // only thing on its surface. `/pages` is where it stops being: the Getting
  // Started checklist asks for the same Confluence setup one block above and
  // the header owns `New Page`, so the empty state's prompt has to speak
  // second or the route carries three filled Steel buttons for two requests.
  it('gives the action the filled accent by default', () => {
    render(
      <EmptyState icon={FolderOpen} title="No items" action={{ label: 'Primary', onClick: vi.fn() }} />,
    );
    expect(screen.getByRole('button', { name: 'Primary' })).toHaveClass('nm-button-primary');
  });

  it('demotes the action to the secondary recipe when asked', () => {
    render(
      <EmptyState
        icon={FolderOpen}
        title="No items"
        action={{ label: 'Primary', onClick: vi.fn() }}
        actionTone="secondary"
      />,
    );
    const btn = screen.getByRole('button', { name: 'Primary' });
    expect(btn).toHaveClass('nm-button-secondary');
    expect(btn).not.toHaveClass('nm-button-primary');
  });

  it('still fires the same handler when demoted', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={FolderOpen}
        title="No items"
        action={{ label: 'Primary', onClick }}
        actionTone="secondary"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Primary' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies custom className', () => {
    const { container } = render(
      <EmptyState icon={FolderOpen} title="No items" className="my-custom" />,
    );
    expect(container.firstChild).toHaveClass('my-custom');
  });
});
