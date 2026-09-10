import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LibraryFilterDropdown } from './LibraryFilterDropdown';

const sampleOptions = [
  { value: '', label: 'All sources' },
  { value: 'confluence', label: 'Confluence' },
  { value: 'standalone', label: 'Local' },
];

describe('LibraryFilterDropdown', () => {
  it('renders with placeholder / selected label', () => {
    const onChange = vi.fn();
    render(
      <LibraryFilterDropdown
        label="Source"
        value=""
        options={sampleOptions}
        onChange={onChange}
        placeholder="All sources"
        testId="filter-source"
      />,
    );

    expect(screen.getByTestId('filter-source-control')).toHaveTextContent('All sources');
    expect(screen.getByTestId('filter-source')).toHaveValue('');
  });

  it('renders selected value label', () => {
    const onChange = vi.fn();
    render(
      <LibraryFilterDropdown
        label="Source"
        value="confluence"
        options={sampleOptions}
        onChange={onChange}
        placeholder="All sources"
        testId="filter-source"
      />,
    );

    expect(screen.getByTestId('filter-source-control')).toHaveTextContent('Confluence');
    expect(screen.getByTestId('filter-source')).toHaveValue('confluence');
  });

  it('opens popup menu on click and selects option', () => {
    const onChange = vi.fn();
    render(
      <LibraryFilterDropdown
        label="Source"
        value=""
        options={sampleOptions}
        onChange={onChange}
        placeholder="All sources"
        testId="filter-source"
      />,
    );

    const trigger = screen.getByTestId('filter-source-control');
    fireEvent.click(trigger);

    expect(screen.getByTestId('filter-source-menu')).toBeInTheDocument();
    const confluenceOption = screen.getByTestId('filter-source-option-confluence');
    expect(confluenceOption).toBeInTheDocument();

    fireEvent.click(confluenceOption);
    expect(onChange).toHaveBeenCalledWith('confluence');
  });

  it('syncs with backing select on change event', () => {
    const onChange = vi.fn();
    render(
      <LibraryFilterDropdown
        label="Source"
        value=""
        options={sampleOptions}
        onChange={onChange}
        placeholder="All sources"
        testId="filter-source"
      />,
    );

    const backingSelect = screen.getByTestId('filter-source');
    fireEvent.change(backingSelect, { target: { value: 'standalone' } });
    expect(onChange).toHaveBeenCalledWith('standalone');
  });
});
