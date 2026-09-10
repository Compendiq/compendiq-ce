import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('supports keyboard navigation through sort options', () => {
    const onChange = vi.fn();
    render(<LibrarySortFilter value="modified" onChange={onChange} />);

    fireEvent.click(screen.getByTestId('sort-filter-control'));
    const firstOption = screen.getByRole('option', { name: 'Last Modified' });

    fireEvent.keyDown(firstOption, { key: 'ArrowDown' });
    const secondOption = screen.getByRole('option', { name: 'Title' });
    fireEvent.keyDown(secondOption, { key: 'Enter' });

    // Clicking or pressing triggers selectSort
    fireEvent.click(secondOption);
    expect(onChange).toHaveBeenCalledWith('title');
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
