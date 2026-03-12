import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FeatureErrorBoundary } from './FeatureErrorBoundary';

// A component that throws on render, used to trigger the error boundary.
function ThrowingChild({ shouldThrow = true }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error('Test render error');
  }
  return <div data-testid="child-content">Working content</div>;
}

describe('FeatureErrorBoundary', () => {
  // Suppress React's noisy error boundary console.error in test output
  const originalConsoleError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it('renders children when no error occurs', () => {
    render(
      <FeatureErrorBoundary featureName="Test Feature">
        <div data-testid="happy-child">Hello</div>
      </FeatureErrorBoundary>,
    );

    expect(screen.getByTestId('happy-child')).toBeInTheDocument();
    expect(screen.queryByTestId('feature-error-fallback')).not.toBeInTheDocument();
  });

  it('renders fallback UI when a child throws during render', () => {
    render(
      <FeatureErrorBoundary featureName="Editor">
        <ThrowingChild />
      </FeatureErrorBoundary>,
    );

    expect(screen.getByTestId('feature-error-fallback')).toBeInTheDocument();
    expect(screen.getByText('Editor failed to load')).toBeInTheDocument();
    expect(screen.getByText('Test render error')).toBeInTheDocument();
    expect(screen.queryByTestId('child-content')).not.toBeInTheDocument();
  });

  it('displays the feature name in the fallback heading', () => {
    render(
      <FeatureErrorBoundary featureName="Article Viewer">
        <ThrowingChild />
      </FeatureErrorBoundary>,
    );

    expect(screen.getByText('Article Viewer failed to load')).toBeInTheDocument();
  });

  it('displays an informative message that the rest of the page is usable', () => {
    render(
      <FeatureErrorBoundary featureName="Mermaid Diagram">
        <ThrowingChild />
      </FeatureErrorBoundary>,
    );

    expect(
      screen.getByText(/the rest of the page is still usable/i),
    ).toBeInTheDocument();
  });

  it('shows a "Try Again" button in the fallback', () => {
    render(
      <FeatureErrorBoundary featureName="Editor">
        <ThrowingChild />
      </FeatureErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('resets error state and re-renders children when "Try Again" is clicked', () => {
    // We need a component that can toggle between throwing and not throwing.
    // Use a wrapper that controls the throw state.
    let shouldThrow = true;

    function ConditionalThrower() {
      if (shouldThrow) {
        throw new Error('Temporary error');
      }
      return <div data-testid="recovered-child">Recovered</div>;
    }

    render(
      <FeatureErrorBoundary featureName="Editor">
        <ConditionalThrower />
      </FeatureErrorBoundary>,
    );

    // Should be in error state
    expect(screen.getByTestId('feature-error-fallback')).toBeInTheDocument();

    // Fix the error condition, then click Try Again
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    // Should recover and show children
    expect(screen.getByTestId('recovered-child')).toBeInTheDocument();
    expect(screen.queryByTestId('feature-error-fallback')).not.toBeInTheDocument();
  });

  it('calls onReset callback when "Try Again" is clicked', () => {
    const onReset = vi.fn();

    render(
      <FeatureErrorBoundary featureName="Editor" onReset={onReset}>
        <ThrowingChild />
      </FeatureErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('logs the error and component stack via componentDidCatch', () => {
    const consoleSpy = vi.fn();
    console.error = consoleSpy;

    render(
      <FeatureErrorBoundary featureName="Article Viewer">
        <ThrowingChild />
      </FeatureErrorBoundary>,
    );

    // React itself calls console.error, and our componentDidCatch also logs.
    // Verify our specific log message was included.
    const ourLog = consoleSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('[FeatureErrorBoundary] Article Viewer crashed:'),
    );
    expect(ourLog).toBeDefined();
  });

  it('renders glassmorphic styling on the fallback card', () => {
    render(
      <FeatureErrorBoundary featureName="Editor">
        <ThrowingChild />
      </FeatureErrorBoundary>,
    );

    const fallback = screen.getByTestId('feature-error-fallback');
    expect(fallback.className).toContain('backdrop-blur-md');
    expect(fallback.className).toContain('bg-card/80');
    expect(fallback.className).toContain('border-white/10');
  });

  it('does not affect siblings when one feature boundary catches an error', () => {
    render(
      <div>
        <FeatureErrorBoundary featureName="Broken Feature">
          <ThrowingChild />
        </FeatureErrorBoundary>
        <div data-testid="sibling">I am still here</div>
      </div>,
    );

    expect(screen.getByTestId('feature-error-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('sibling')).toBeInTheDocument();
    expect(screen.getByText('I am still here')).toBeInTheDocument();
  });
});
