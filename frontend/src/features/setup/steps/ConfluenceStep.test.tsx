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

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Route by URL/method: the wizard must probe POST /settings/test-confluence
// (which actually authenticates against Confluence), not a local read.
function mockOkFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/settings/test-confluence') && (init as RequestInit | undefined)?.method === 'POST') {
      return jsonResponse({ success: true, message: 'Connection successful' });
    }
    return jsonResponse([]);
  });
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

  it('keeps Continue disabled when the connection probe reports failure (#950)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/settings/test-confluence') && (init as RequestInit | undefined)?.method === 'POST') {
        // The credentials are wrong: the backend probe fails even though the
        // settings save (PUT /settings) succeeds.
        return jsonResponse({ success: false, message: 'Connection failed' });
      }
      return jsonResponse([]);
    });
    renderStep();

    fireEvent.change(screen.getByTestId('confluence-url'), {
      target: { value: 'https://confluence.example.com' },
    });
    fireEvent.change(screen.getByTestId('confluence-pat'), {
      target: { value: 'bad-pat' },
    });

    fireEvent.click(screen.getByTestId('test-confluence-btn'));

    // The failure must surface and the wizard must NOT let the user proceed.
    await waitFor(() => {
      expect(screen.getByTestId('confluence-test-result')).toHaveTextContent(
        'Connection failed',
      );
    });
    expect(screen.getByTestId('confluence-next-btn')).toBeDisabled();

    // Prove the wizard hit the real probe endpoint with the entered credentials.
    const probeCall = fetchSpy.mock.calls.find(
      ([reqUrl, init]) =>
        (typeof reqUrl === 'string' ? reqUrl : (reqUrl as Request).url).includes(
          '/settings/test-confluence',
        ) && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(probeCall).toBeDefined();
    const probeBody = JSON.parse((probeCall![1] as RequestInit).body as string);
    expect(probeBody.url).toBe('https://confluence.example.com');
    expect(probeBody.pat).toBe('bad-pat');
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
