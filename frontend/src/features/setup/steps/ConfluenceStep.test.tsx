import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LazyMotion, domMax } from 'framer-motion';
import { UpdateSettingsSchema } from '@compendiq/contracts';
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

  it('persists the URL under the confluenceUrl key the backend expects (#875)', async () => {
    const fetchSpy = mockOkFetch();
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

    // Find the PUT /settings call and inspect its payload.
    const putCall = fetchSpy.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);

    // The URL must go under `confluenceUrl` (a non-strict UpdateSettingsSchema
    // silently strips the old `confluenceBaseUrl` key, leaving confluence_url NULL).
    expect(body.confluenceBaseUrl).toBeUndefined();
    expect(body.confluenceUrl).toBe('https://confluence.example.com');

    // The whole payload must validate against the contract the backend parses with.
    const parsed = UpdateSettingsSchema.parse(body);
    expect(parsed.confluenceUrl).toBe('https://confluence.example.com');
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
