import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { ConfluenceStep } from './ConfluenceStep';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderStep(onNext = vi.fn(), onBack = vi.fn()) {
  render(
    <LazyMotion features={domMax}>
      <ConfluenceStep onNext={onNext} onBack={onBack} />
    </LazyMotion>,
  );
  return { onNext, onBack };
}

function mockOkFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('ConfluenceStep', () => {
  beforeEach(() => {
    mockOkFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gates Continue behind a passing connection test', () => {
    renderStep();
    // Continue is disabled until a successful test.
    expect(screen.getByTestId('confluence-next-btn')).toBeDisabled();
  });

  it('re-requires a test after the URL is edited following a passing test', async () => {
    renderStep();

    fireEvent.change(screen.getByTestId('confluence-url'), {
      target: { value: 'https://confluence.example.com' },
    });
    fireEvent.change(screen.getByTestId('confluence-pat'), {
      target: { value: 'secret-pat' },
    });

    fireEvent.click(screen.getByTestId('test-confluence-btn'));

    // Successful test enables Continue and shows the success banner.
    await waitFor(() => {
      expect(screen.getByTestId('confluence-test-result')).toHaveTextContent(
        'Connection successful',
      );
    });
    expect(screen.getByTestId('confluence-next-btn')).not.toBeDisabled();

    // Editing the URL must invalidate the prior test result so the wizard
    // cannot proceed with untested values.
    fireEvent.change(screen.getByTestId('confluence-url'), {
      target: { value: 'https://other.example.com' },
    });

    expect(screen.getByTestId('confluence-next-btn')).toBeDisabled();
    expect(screen.queryByTestId('confluence-test-result')).not.toBeInTheDocument();
  });

  it('re-requires a test after the PAT is edited following a passing test', async () => {
    renderStep();

    fireEvent.change(screen.getByTestId('confluence-url'), {
      target: { value: 'https://confluence.example.com' },
    });
    fireEvent.change(screen.getByTestId('confluence-pat'), {
      target: { value: 'secret-pat' },
    });

    fireEvent.click(screen.getByTestId('test-confluence-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('confluence-next-btn')).not.toBeDisabled();
    });

    fireEvent.change(screen.getByTestId('confluence-pat'), {
      target: { value: 'different-pat' },
    });

    expect(screen.getByTestId('confluence-next-btn')).toBeDisabled();
  });
});
