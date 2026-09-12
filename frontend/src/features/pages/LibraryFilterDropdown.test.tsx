import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LibraryFilterDropdown } from './LibraryFilterDropdown';

const sampleOptions = [
  { value: '', label: 'All sources' },
  { value: 'confluence', label: 'Confluence' },
  { value: 'standalone', label: 'Local' },
];

function SourceFilter({ searchable = false }: { searchable?: boolean }) {
  const [value, setValue] = useState('');
  return (
    <>
      <label htmlFor="source-filter">Source</label>
      <LibraryFilterDropdown
        id="source-filter"
        label="Source"
        ariaLabel="Filter by source"
        value={value}
        options={sampleOptions}
        onChange={setValue}
        searchable={searchable}
      />
    </>
  );
}

describe('LibraryFilterDropdown', () => {
  it('labels the only closed-state keyboard entry with its field and current selection', () => {
    const { container } = render(<SourceFilter />);
    const trigger = screen.getByRole('button', { name: 'Filter by source, current: All sources' });
    expect(screen.getByLabelText('Source')).toBe(trigger);
    const tabEntries = Array.from(container.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]',
    )).filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'));
    expect(tabEntries).toEqual([trigger]);
    expect(trigger).toBeVisible();
  });

  it('selects through the visible list and restores focus to the updated trigger', async () => {
    render(<SourceFilter />);
    const trigger = screen.getByRole('button', { name: /Filter by source/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Local' }));

    expect(trigger).toHaveAccessibleName('Filter by source, current: Local');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Local' })).toHaveAttribute('aria-selected', 'true');
  });

  it('moves keyboard focus between options and cancels without changing the selection', async () => {
    render(<SourceFilter searchable />);
    const trigger = screen.getByRole('button', { name: /Filter by source/ });
    fireEvent.click(trigger);
    const all = screen.getByRole('option', { name: 'All sources' });
    expect(all).toHaveFocus();

    fireEvent.keyDown(all, { key: 'ArrowDown' });
    const confluence = screen.getByRole('option', { name: 'Confluence' });
    expect(confluence).toHaveFocus();
    fireEvent.keyDown(confluence, { key: 'End' });
    const local = screen.getByRole('option', { name: 'Local' });
    expect(local).toHaveFocus();
    fireEvent.keyDown(local, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveAccessibleName('Filter by source, current: All sources');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('selects a filtered option from the keyboard and returns focus to the trigger', async () => {
    const onChange = vi.fn();
    render(
      <LibraryFilterDropdown
        label="Author"
        value=""
        options={['All authors', 'Alice', 'Bob', 'Carol', 'Dan', 'Eve', 'Frank'].map((label, index) => ({
          value: index === 0 ? '' : label,
          label,
        }))}
        onChange={onChange}
        searchable
      />,
    );
    const trigger = screen.getByRole('button', { name: /Filter by Author/ });
    fireEvent.click(trigger);
    const search = screen.getByRole('searchbox', { name: 'Search Author' });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: 'Frank' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('Frank');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
