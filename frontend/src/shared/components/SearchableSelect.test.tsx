import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchableSelect } from './SearchableSelect';

const sampleOptions = [
  { value: '', label: 'Select a model' },
  { value: 'qwen3:4b', label: 'qwen3:4b' },
  { value: 'bge-m3', label: 'bge-m3' },
  { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
];

describe('SearchableSelect', () => {
  it('renders the selected option label on the trigger', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        value="bge-m3"
        options={sampleOptions}
        onChange={onChange}
        testId="model"
        ariaLabel="Listed models"
      />,
    );

    expect(screen.getByTestId('model-control')).toHaveTextContent('bge-m3');
    expect(screen.getByTestId('model')).toHaveValue('bge-m3');
    expect(screen.getByRole('combobox', { name: /listed models/i })).toBe(screen.getByTestId('model'));
  });

  it('opens the menu and filters options by label or value', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        value=""
        options={sampleOptions}
        onChange={onChange}
        testId="model"
        ariaLabel="Listed models"
      />,
    );

    fireEvent.click(screen.getByTestId('model-control'));

    expect(screen.getByTestId('model-menu')).toBeInTheDocument();
    const search = screen.getByRole('searchbox');
    expect(search).toBeInTheDocument();
    expect(screen.getByTestId('model-option-qwen3:4b')).toBeInTheDocument();
    expect(screen.getByTestId('model-option-bge-m3')).toBeInTheDocument();
    expect(screen.getByTestId('model-option-empty')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'bge' } });
    expect(screen.getByTestId('model-option-bge-m3')).toBeInTheDocument();
    expect(screen.queryByTestId('model-option-qwen3:4b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-option-gpt-4o-mini')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'gpt-4o' } });
    expect(screen.getByTestId('model-option-gpt-4o-mini')).toBeInTheDocument();
    expect(screen.queryByTestId('model-option-bge-m3')).not.toBeInTheDocument();
  });

  it('selects the active filtered option on Enter in the search field', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        value=""
        options={sampleOptions}
        onChange={onChange}
        testId="model"
        ariaLabel="Listed models"
      />,
    );

    fireEvent.click(screen.getByTestId('model-control'));
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'bge' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('bge-m3');
  });

  it('syncs with backing select on change event and assigns id and aria-describedby to trigger', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        value=""
        options={sampleOptions}
        onChange={onChange}
        testId="model"
        ariaLabel="Listed models"
        id="provider-listed-models"
        describedBy="provider-listed-models-help"
      />,
    );

    const trigger = screen.getByTestId('model-control');
    expect(trigger).toHaveAttribute('id', 'provider-listed-models');
    expect(trigger).toHaveAttribute('aria-describedby', 'provider-listed-models-help');

    const backingSelect = screen.getByTestId('model');
    expect(backingSelect).toHaveAttribute('id', 'provider-listed-models-backing');
    expect(backingSelect).toHaveAttribute('aria-describedby', 'provider-listed-models-help');
    expect(backingSelect).toHaveClass('sr-only');

    fireEvent.change(backingSelect, { target: { value: 'qwen3:4b' } });
    expect(onChange).toHaveBeenCalledWith('qwen3:4b');

    fireEvent.change(backingSelect, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('focuses and opens the select when an associated label is clicked', () => {
    render(
      <div>
        <label htmlFor="model-select">Choose Model</label>
        <SearchableSelect
          id="model-select"
          value=""
          options={sampleOptions}
          onChange={() => {}}
          testId="model"
        />
      </div>,
    );

    fireEvent.click(screen.getByText('Choose Model'));
    expect(screen.getByTestId('model-menu')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });
  it('renders option buttons with tabIndex -1 to preserve clean tab order', () => {
    render(
      <SearchableSelect
        value=""
        options={sampleOptions}
        onChange={() => {}}
        testId="model"
      />,
    );

    fireEvent.click(screen.getByTestId('model-control'));
    expect(screen.getByTestId('model-option-bge-m3')).toHaveAttribute('tabindex', '-1');
  });

  it('shows emptyMessage when the filter matches nothing', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        value=""
        options={sampleOptions}
        onChange={onChange}
        testId="model"
        ariaLabel="Listed models"
        emptyMessage="Nothing here"
      />,
    );

    fireEvent.click(screen.getByTestId('model-control'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz-no-match' } });

    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByTestId('model-option-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-option-bge-m3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-option-qwen3:4b')).not.toBeInTheDocument();
  });

  it('closes on Escape and clears the search query', async () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        value=""
        options={sampleOptions}
        onChange={onChange}
        testId="model"
        ariaLabel="Listed models"
      />,
    );

    fireEvent.click(screen.getByTestId('model-control'));
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'bge' } });
    expect(search).toHaveValue('bge');

    fireEvent.keyDown(search, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('model-menu')).not.toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('model-control'));
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});
