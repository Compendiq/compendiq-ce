import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorState } from './ErrorState';

describe('ErrorState', () => {
  it('renders the title and description', () => {
    render(
      <ErrorState
        title="Failed to load"
        description="boom"
        testId="err"
      />,
    );
    expect(screen.getByTestId('err')).toBeInTheDocument();
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('renders no retry button when onRetry is omitted', () => {
    render(<ErrorState testId="err" retryTestId="retry" />);
    expect(screen.queryByTestId('retry')).not.toBeInTheDocument();
  });

  it('calls onRetry when the retry button is clicked', () => {
    const onRetry = vi.fn();
    render(<ErrorState testId="err" retryTestId="retry" onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
