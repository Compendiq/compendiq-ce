/**
 * Setup → Create Admin Account at the network boundary (#1881).
 *
 * `POST /api/setup/admin` issues the first session, so it is one of the
 * routes the backend inspects for the legacy-client marker and refuses with
 * 409 `client_reload_required` once enforcement is on. The step must send the
 * marker and, on that refusal, offer a reload rather than a creation failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { AdminStep } from './AdminStep';
import { useAuthStore } from '../../../stores/auth-store';
import { reloadPage } from '../../../shared/lib/client-protocol';
import type * as ClientProtocol from '../../../shared/lib/client-protocol';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// jsdom's `location.reload` is unforgeable; the step reloads through this seam.
vi.mock('../../../shared/lib/client-protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientProtocol>()),
  reloadPage: vi.fn(),
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fillAndSubmit() {
  fireEvent.change(screen.getByTestId('setup-username'), { target: { value: 'admin' } });
  fireEvent.change(screen.getByTestId('setup-password'), { target: { value: 'securepass123' } });
  fireEvent.change(screen.getByTestId('setup-confirm-password'), { target: { value: 'securepass123' } });
  fireEvent.click(screen.getByTestId('create-admin-btn'));
}

describe('AdminStep', () => {
  const onNext = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    useAuthStore.getState().clearAuth();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('sends the legacy-client marker with the setup-admin request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ accessToken: 'setup-token', user: { id: '1', username: 'admin', role: 'admin' } }, 201),
    );
    render(<AdminStep onNext={onNext} onBack={onBack} />);

    fillAndSubmit();

    await waitFor(() => expect(onNext).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/setup/admin');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Headers;
    expect(headers.get('X-Compendiq-Client-Protocol')).toBe('1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(useAuthStore.getState().accessToken).toBe('setup-token');
  });

  it('offers a reload on client_reload_required instead of reporting a failed account creation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'client_reload_required' }, 409));
    render(<AdminStep onNext={onNext} onBack={onBack} />);

    fillAndSubmit();

    const notice = await screen.findByTestId('setup-reload-required');
    expect(screen.getByRole('alert')).toHaveTextContent('This page is out of date. Reload to continue.');
    expect(notice).toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    // The form is usable again: the request settled.
    expect(screen.getByTestId('create-admin-btn')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('setup-reload'));
    expect(vi.mocked(reloadPage)).toHaveBeenCalledTimes(1);
  });

  it('still toasts every other failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ message: 'Username already taken' }, 409));
    render(<AdminStep onNext={onNext} onBack={onBack} />);

    fillAndSubmit();

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Username already taken'));
    expect(screen.queryByTestId('setup-reload-required')).not.toBeInTheDocument();
  });
});
