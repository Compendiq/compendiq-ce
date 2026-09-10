import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeepSearchToggle, DEEP_SEARCH_CAVEAT, DEEP_SEARCH_HINT } from './DeepSearchToggle';

describe('DeepSearchToggle', () => {
  it('renders unchecked by default with info popover trigger in popover variant', () => {
    const onChange = vi.fn();
    render(<DeepSearchToggle checked={false} onChange={onChange} testId="test-deep-search" />);

    const checkbox = screen.getByTestId('test-deep-search');
    expect(checkbox).not.toBeChecked();

    const infoTrigger = screen.getByTestId('test-deep-search-info-trigger');
    expect(infoTrigger).toBeInTheDocument();
    expect(infoTrigger).toHaveAttribute('aria-label', 'Deep search details and caveats');

    const label = checkbox.closest('label');
    expect(label).toHaveAttribute('title', DEEP_SEARCH_HINT);
  });

  it('clicking toggle triggers onChange callback', () => {
    const onChange = vi.fn();
    render(<DeepSearchToggle checked={false} onChange={onChange} testId="test-deep-search" />);

    const label = screen.getByTestId('test-deep-search').closest('label')!;
    fireEvent.click(label);

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('links aria-describedby to the caveat description', () => {
    const onChange = vi.fn();
    render(<DeepSearchToggle checked={false} onChange={onChange} testId="test-deep-search" />);

    const checkbox = screen.getByTestId('test-deep-search');
    const describedBy = checkbox.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    const caveat = screen.getByTestId('test-deep-search-caveat');
    expect(caveat.id).toBe(describedBy);
    expect(caveat).toHaveTextContent(DEEP_SEARCH_CAVEAT);
  });

  it('opens popover when info trigger button is clicked in popover mode', () => {
    const onChange = vi.fn();
    render(<DeepSearchToggle checked={false} onChange={onChange} testId="test-deep-search" />);

    const infoTrigger = screen.getByTestId('test-deep-search-info-trigger');
    fireEvent.click(infoTrigger);

    const popoverContent = screen.getByTestId('test-deep-search-popover-content');
    expect(popoverContent).toBeInTheDocument();
    expect(popoverContent).toHaveTextContent(/Deep search/i);
    expect(popoverContent).toHaveTextContent(DEEP_SEARCH_CAVEAT);
  });

  it('renders inline visible caveat when variant="inline"', () => {
    const onChange = vi.fn();
    render(
      <DeepSearchToggle
        checked={false}
        onChange={onChange}
        variant="inline"
        testId="test-deep-search"
      />,
    );

    const caveat = screen.getByTestId('test-deep-search-caveat');
    expect(caveat).toBeVisible();
    expect(caveat).toHaveTextContent(DEEP_SEARCH_CAVEAT);
    expect(screen.queryByTestId('test-deep-search-info-trigger')).not.toBeInTheDocument();
  });

  it('disables toggle and info trigger when disabled=true', () => {
    const onChange = vi.fn();
    render(
      <DeepSearchToggle
        checked={false}
        onChange={onChange}
        disabled
        testId="test-deep-search"
      />,
    );

    expect(screen.getByTestId('test-deep-search')).toBeDisabled();
    expect(screen.getByTestId('test-deep-search-info-trigger')).toBeDisabled();
  });
});
