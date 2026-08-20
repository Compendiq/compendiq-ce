import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LibrarySpaceFilter } from './LibrarySpaceFilter';

const spaces = Array.from({ length: 10 }, (_, index) => ({
  key: `SP${index + 1}`,
  name: index === 8 ? 'Operations' : `Space ${index + 1}`,
}));

describe('LibrarySpaceFilter', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('adds typeahead for large space sets and matches names or keys', async () => {
    const onSelect = vi.fn();
    render(<LibrarySpaceFilter spaces={spaces} selectedKey="" onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId('space-filter-control'));
    const search = await screen.findByRole('combobox', { name: 'Search spaces' });
    fireEvent.change(search, { target: { value: 'operations' } });

    const match = await screen.findByRole('option', { name: 'Operations (SP9)' });
    expect(screen.queryByRole('option', { name: 'Space 1 (SP1)' })).not.toBeInTheDocument();
    fireEvent.click(match);

    expect(onSelect).toHaveBeenCalledWith('SP9');
    expect(localStorage.getItem('compendiq:library-recent-spaces')).toBe('["SP9"]');
  });

  it('supports arrow-key selection and resets the query after closing', async () => {
    const onSelect = vi.fn();
    render(<LibrarySpaceFilter spaces={spaces} selectedKey="" onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId('space-filter-control'));
    const search = await screen.findByRole('combobox', { name: 'Search spaces' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('SP1');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search spaces' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('space-filter-control'));
    expect(await screen.findByRole('combobox', { name: 'Search spaces' })).toHaveValue('');
  });

  it('promotes accessible recent scopes ahead of the full space list', async () => {
    localStorage.setItem('compendiq:library-recent-spaces', '["SP9"]');
    render(<LibrarySpaceFilter spaces={spaces} selectedKey="SP9" selectedName="Operations" onSelect={vi.fn()} />);

    fireEvent.click(screen.getByTestId('space-filter-control'));
    expect(await screen.findByText('Recent')).toBeInTheDocument();
    const recent = document.getElementById('library-space-option-SP9')!;
    const firstRegular = document.getElementById('library-space-option-SP1')!;
    expect(recent.compareDocumentPosition(firstRegular) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
