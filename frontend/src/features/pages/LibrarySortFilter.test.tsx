import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LibrarySortFilter, SORT_OPTIONS } from './LibrarySortFilter';

describe('LibrarySortFilter', () => {
  it('renders with current selected sort label', () => {
    render(<LibrarySortFilter value="modified" onChange={vi.fn()} />);

    const trigger = screen.getByTestId('sort-filter-control');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('Last Modified');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens menu and displays all sort options with active checkmark', () => {
    render(<LibrarySortFilter value="title" onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('sort-filter-control'));

    const menu = screen.getByTestId('sort-filter-menu');
    expect(menu).toBeInTheDocument();

    for (const opt of SORT_OPTIONS) {
      const optionEl = screen.getByRole('option', { name: opt.label });
      expect(optionEl).toBeInTheDocument();
      if (opt.value === 'title') {
        expect(optionEl).toHaveAttribute('aria-selected', 'true');
      } else {
        expect(optionEl).toHaveAttribute('aria-selected', 'false');
      }
    }
  });

  it('calls onChange and closes popover when an option is selected', () => {
    const onChange = vi.fn();
    render(<LibrarySortFilter value="modified" onChange={onChange} />);

    fireEvent.click(screen.getByTestId('sort-filter-control'));
    fireEvent.click(screen.getByRole('option', { name: 'Quality Score' }));

    expect(onChange).toHaveBeenCalledWith('quality');
  });

  it('moves keyboard focus without selecting and restores the trigger on Escape', async () => {
    const onChange = vi.fn();
    render(<LibrarySortFilter value="modified" onChange={onChange} />);

    const trigger = screen.getByTestId('sort-filter-control');
    fireEvent.click(trigger);
    const firstOption = screen.getByRole('option', { name: 'Last Modified' });
    expect(firstOption).toHaveFocus();
    fireEvent.keyDown(firstOption, { key: 'ArrowDown' });
    const secondOption = screen.getByRole('option', { name: 'Title' });
    expect(secondOption).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(secondOption, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('Last Modified');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('omits Relevance option when hasSearchQuery is false', () => {
    render(<LibrarySortFilter value="modified" onChange={vi.fn()} hasSearchQuery={false} />);

    fireEvent.click(screen.getByTestId('sort-filter-control'));

    expect(screen.queryByRole('option', { name: 'Relevance' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Last Modified' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Author' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Quality Score' })).toBeInTheDocument();
  });
});
